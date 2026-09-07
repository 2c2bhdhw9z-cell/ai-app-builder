/**
 * THE SHARE_LINK STORE (spec Task 29.1, Req 26; storage split).
 *
 * A ShareLinkStore persists a User_Account's read-only Share_Link records
 * OUT-OF-TREE, mirroring the ConnectorBindingStore's storage discipline
 * (src/connectors/binding-store.js) and the ProjectRegistry's atomic writes:
 *
 *   - Every record is persisted at EXACTLY
 *       layout.controlShareLinkPath(ownerId, token)
 *     which the StorageLayout computes under `controlRoot` and asserts with
 *     assertOutsideExportTrees — so a Share_Link record can NEVER be written
 *     inside an exportable project tree (Req 26: a ShareLink is control-plane
 *     only, never exported).
 *   - One file per token, so add/revoke/remove operate on exactly one file and
 *     a mutation to one link can never touch a sibling link's bytes (Req 26.7).
 *   - Records round-trip through createShareLink (src/model/deployment.js), so
 *     createdAt/expiresAt are validated parseable ISO-8601 and access is
 *     'read-only' before anything is persisted.
 *
 * FAIL-CLOSED READS (deny-disclose-nothing, Req 26.4): get(token) returns null
 * for an absent OR malformed token rather than throwing a distinguishable
 * error. The StorageLayout's requireId already rejects traversal / NUL /
 * prototype-key tokens by throwing; we CATCH that throw and treat it as a clean
 * miss (null), so a malformed token yields a generic deny at the service layer
 * instead of a leaked 500.
 *
 * Conventions mirror the ConnectorBindingStore: a factory createX({...deps})
 * returning Object.freeze({...}); node:fs only; no plumby import; no new
 * dependency; atomic temp-file + rename writes.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';
import { createShareLink } from '../model/deployment.js';

/**
 * Create a ShareLinkStore.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout (src/storage/layout.js) — supplies
 *        controlShareLinkPath(ownerId, token) + assertOutsideExportTrees.
 * @param {string} [args.ownerId='default']  the owning account id (storage-split axis).
 * @returns {object} store (frozen)
 */
export function createShareLinkStore({ layout, ownerId = 'default' } = {}) {
  const model = 'ShareLinkStore';
  if (
    !layout ||
    typeof layout.controlShareLinkPath !== 'function' ||
    typeof layout.assertOutsideExportTrees !== 'function'
  ) {
    fail(model, 'layout with controlShareLinkPath/assertOutsideExportTrees is required');
  }
  requireString(model, 'ownerId', ownerId);

  /**
   * Resolve + assert the out-of-tree JSON path for one token. Returns null when
   * the token is not a safe path segment (requireId throws), so a malformed
   * token becomes a clean miss (fail-closed) rather than a leaked error.
   */
  function pathFor(token) {
    let p;
    try {
      p = layout.controlShareLinkPath(ownerId, token);
    } catch {
      // Malformed token (traversal / NUL / reserved key / non-string) — the
      // layout rejected it. Treat as a clean miss; the service maps null -> deny.
      return null;
    }
    layout.assertOutsideExportTrees(p, 'share-link');
    return p;
  }

  /** The owner's share-link directory (parent of every token file). */
  function ownerDir() {
    // A stable, guaranteed-safe token to derive the owner directory from.
    const probe = pathFor('_');
    return probe ? path.dirname(probe) : null;
  }

  /** Atomically persist one record (temp-file + rename), out-of-tree. */
  function writeRecord(token, record) {
    const p = pathFor(token);
    if (p === null) fail(model, 'token must be a single safe path segment');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  }

  /**
   * put(link): validate a Share_Link through createShareLink (rejecting a
   * malformed record with a TypeError) and persist it at its token's path.
   * Replaces any existing record for the same token (used by revoke's flip).
   * Returns the persisted, normalized record.
   */
  function put(link) {
    const record = createShareLink(link);
    writeRecord(record.token, record);
    return record;
  }

  /**
   * get(token): read exactly ONE record by token. Returns null for an absent
   * file (ENOENT) OR a malformed token — NEVER throws a distinguishable error
   * for a bad token, so a malformed/absent token fails closed to a deny.
   */
  function get(token) {
    if (typeof token !== 'string' || token === '') return null;
    const p = pathFor(token);
    if (p === null) return null;
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt record is not a usable grant — fail closed to a miss.
      return null;
    }
    // Round-trip through the model so a tampered record with an unparseable
    // date or a non-read-only access is rejected as a miss rather than trusted.
    try {
      return createShareLink(parsed);
    } catch {
      return null;
    }
  }

  /**
   * list(): every Share_Link record for this owner. Enumerates the owner
   * directory, skipping .tmp / .lock artifacts, and rehydrates each file
   * through get(). Returns [] when the owner has no links.
   */
  function list() {
    const dir = ownerDir();
    if (dir === null) return [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const links = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.json')) continue; // skip .tmp-* and other artifacts
      const token = e.name.slice(0, -'.json'.length);
      const link = get(token);
      if (link) links.push(link);
    }
    return Object.freeze(links);
  }

  /**
   * remove(token): delete a record entirely. Idempotent — removing an absent or
   * malformed token is success. Returns { token, removed:true }. (Revocation
   * uses put() to flip revoked:true and keep an audit trail on disk; remove is
   * provided for completeness/cleanup.)
   */
  function remove(token) {
    const p = pathFor(token);
    if (p !== null) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* best-effort: an absent file is success */
      }
    }
    return { token, removed: true };
  }

  return Object.freeze({
    ownerId,
    put,
    get,
    list,
    remove,
    pathFor,
  });
}
