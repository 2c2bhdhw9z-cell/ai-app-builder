/**
 * project-registry.js — the control-plane ProjectRegistry (spec subtask 13.1,
 * Req 1, 7.3, 7.6).
 *
 * The ProjectRegistry is the authoritative, out-of-tree list of a User_Account's
 * Project records. It backs two things the ProjectManager and Builder Server
 * depend on:
 *
 *   - the QuotaManager `totalProjects` Resource_Quota — countForOwner(ownerId)
 *     is EXACTLY the projectCounter(accountId) seam that
 *     QuotaManager.checkQuota(account, null, 'totalProjects') expects; and
 *   - the Builder Server projectResolver / authorize() check — resolver(projectId)
 *     yields { id, ownerId } (or null) so the server can authorize a project
 *     touch without disclosing existence. Wiring this resolver as the server's
 *     projectResolver is the natural place the still-open "real projectResolver"
 *     review finding is satisfied (kept scoped here; the server change is
 *     strictly additive).
 *
 * WHERE STATE LIVES (the storage split, src/storage/layout.js): the registry is
 * CONTROL-PLANE metadata that must NEVER enter an exported project tree, so it
 * persists OUT-OF-TREE under layout.controlProjectRegistryRoot() — a per-owner
 * `projects.json` at layout.controlProjectRegistryPath(ownerId), plus a small
 * `index.json` mapping projectId -> ownerId at the registry root. Writes are
 * ATOMIC (temp file + rename), mirroring the SnapshotStore's saveRegistry so a
 * crash can never leave a half-written registry. Records ALWAYS round-trip
 * through createProject (src/model/project.js) so malformed data is rejected at
 * the edge with a TypeError.
 *
 * CONCURRENCY (review finding 2): register() is a read-modify-write, so two
 * concurrent registrations for one owner could clobber each other. Each per-owner
 * mutation runs inside a cross-process advisory lock (an atomically-created lock
 * DIRECTORY next to the owner file — `fs.mkdirSync` fails if it already exists,
 * which is the classic stdlib atomic-lock primitive, no new dependency). The
 * index update takes its own lock at the registry root. Concurrent registers
 * therefore serialize per owner and no entry is lost.
 *
 * LOOKUP COST (review finding 3): get()/resolver() consult the projectId->ownerId
 * `index.json` (one small read) and then read exactly ONE owner file, instead of
 * scanning every owner directory and file. Authorization on the Builder Server's
 * hot path therefore stays cheap as owners/projects grow. The index is
 * self-healing: a miss falls back to a one-time scan that repopulates it.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection
 * for the clock; the layout is the only I/O seam.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';
import { createProject } from '../model/project.js';

/** Name of the projectId -> ownerId index file at the registry root. */
const INDEX_FILE = 'index.json';

/** Lock acquisition tuning for the atomic mkdir lock (no real sleeps in tests). */
const LOCK_RETRY_MAX = 200;
const LOCK_STALE_MS = 30_000;

/**
 * Create a ProjectRegistry.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout exposing controlProjectRegistryPath(ownerId)
 *        and controlProjectRegistryRoot()
 * @param {() => string} [args.now]  injectable ISO-timestamp clock (reserved for callers)
 * @returns {object} registry (frozen)
 */
export function createProjectRegistry({ layout, now = () => new Date().toISOString() } = {}) {
  const model = 'ProjectRegistry';
  if (!layout || typeof layout.controlProjectRegistryPath !== 'function') {
    fail(model, 'layout with controlProjectRegistryPath(ownerId) is required');
  }
  if (typeof now !== 'function') fail(model, 'now must be a function returning an ISO timestamp');

  /**
   * The project-registry ROOT directory. Prefer the layout's explicit accessor
   * (review finding 4 — no `__probe__` sentinel path derivation). Fall back to a
   * documented derivation only for a layout that predates the accessor.
   */
  function registryRoot() {
    if (typeof layout.controlProjectRegistryRoot === 'function') {
      return layout.controlProjectRegistryRoot();
    }
    // Legacy layout: the per-owner file is <root>/<ownerId>/projects.json, so the
    // registry root is two segments up. Kept only as a compatibility shim.
    return path.dirname(path.dirname(layout.controlProjectRegistryPath('_')));
  }

  /** The out-of-tree registry path for an owner. */
  function pathFor(ownerId) {
    requireString(model, 'ownerId', ownerId);
    const p = layout.controlProjectRegistryPath(ownerId);
    // When the layout exposes the storage-split guard, prove the path is
    // out-of-tree (control-plane metadata can never enter an exported tree).
    if (typeof layout.assertOutsideExportTrees === 'function') {
      layout.assertOutsideExportTrees(p, 'project-registry');
    }
    return p;
  }

  /**
   * withLock(lockPath, fn) — run fn while holding an advisory cross-process lock
   * implemented as an atomically-created directory. `fs.mkdirSync` fails with
   * EEXIST if the directory already exists, which gives us a compare-and-swap
   * with no new dependency. A busy lock is retried with a tiny synchronous
   * backoff; a lock older than LOCK_STALE_MS is treated as abandoned and stolen
   * so a crashed writer cannot wedge the registry forever.
   */
  function withLock(lockPath, fn) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let held = false;
    for (let attempt = 0; attempt < LOCK_RETRY_MAX && !held; attempt += 1) {
      try {
        fs.mkdirSync(lockPath);
        held = true;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        // Steal a stale lock (crashed holder) so we never wedge permanently.
        let stat;
        try {
          stat = fs.statSync(lockPath);
        } catch {
          continue; // lock vanished between mkdir and stat — retry immediately.
        }
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // TOCTOU guard (H2): between deciding this lock is stale and removing
          // it, another writer may have stolen+re-created it. Re-stat immediately
          // before rmSync and only steal if the lock still carries the SAME
          // identity we sized up. Identity = (mtimeMs AND inode). mtimeMs alone
          // is insufficient: its resolution is filesystem-dependent (can be ~1s),
          // so a steal+recreate within the same tick could alias to an identical
          // mtime and let a live lock be stolen. Pairing it with the directory's
          // inode (stat.ino) distinguishes a recreated directory even when the
          // mtime coincides. When BOTH stats lack a meaningful inode (ino falsy —
          // filesystems without inode semantics), fall back to the mtime-only
          // comparison rather than making the check stricter than the platform
          // can support. If either component differs, the lock was re-created and
          // is now live: do NOT steal — back off and re-attempt the mkdir.
          let confirm;
          try {
            confirm = fs.statSync(lockPath);
          } catch {
            continue; // vanished between decision and re-stat — just re-attempt.
          }
          const inodesMeaningful = Boolean(stat.ino) || Boolean(confirm.ino);
          const identityChanged =
            confirm.mtimeMs !== stat.mtimeMs ||
            (inodesMeaningful && confirm.ino !== stat.ino);
          if (identityChanged) {
            // A different writer re-created the lock; it is no longer the stale
            // one we sized up. Do NOT steal — back off and re-attempt the mkdir.
            busyWait();
            continue;
          }
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            /* another writer won the steal — retry */
          }
          // Loop back to re-attempt the atomic mkdirSync: only the writer whose
          // mkdir wins actually holds the lock, so two concurrent stealers can
          // never both proceed.
          continue;
        }
        // Brief synchronous spin-wait (no timers; keeps the read-modify-write
        // atomic even under concurrent same-process register calls).
        busyWait();
      }
    }
    if (!held) {
      fail(model, `could not acquire registry lock at ${lockPath} after ${LOCK_RETRY_MAX} attempts`);
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* best-effort release */
      }
    }
  }

  /** A short synchronous pause used only while contending for a lock. */
  function busyWait() {
    const until = Date.now() + 1;
    while (Date.now() < until) {
      /* spin */
    }
  }

  /** Load an owner's registry (array of Project records) or [] when none. */
  function loadForOwner(ownerId) {
    const p = pathFor(ownerId);
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  /** Persist an owner's registry atomically (temp file + rename), out-of-tree. */
  function saveForOwner(ownerId, records) {
    const p = pathFor(ownerId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, p);
  }

  /** The projectId -> ownerId index path at the registry root. */
  function indexPath() {
    return path.join(registryRoot(), INDEX_FILE);
  }

  /** Load the projectId -> ownerId index ({} when none). */
  function loadIndex() {
    let raw;
    try {
      raw = fs.readFileSync(indexPath(), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return {};
      throw err;
    }
    const parsed = JSON.parse(raw);
    // Copy into a NULL-PROTOTYPE map (L7): a projectId of '__proto__' /
    // 'constructor' / 'prototype' would otherwise index through Object.prototype
    // (truthy, non-string), turning a client-supplied id into a thrown TypeError
    // downstream instead of a clean miss, and indexPut('__proto__') would assign
    // through the inherited setter and drop the entry. A null-proto object plus
    // Object.hasOwn lookups make those keys behave as ordinary (absent) ids.
    const index = Object.create(null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(parsed)) index[key] = parsed[key];
    }
    return index;
  }

  /** Persist the index atomically (temp file + rename). */
  function saveIndex(index) {
    const p = indexPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
    fs.renameSync(tmp, p);
  }

  /** Merge one projectId -> ownerId mapping into the index under its own lock. */
  function indexPut(projectId, ownerId) {
    const lock = path.join(registryRoot(), `${INDEX_FILE}.lock`);
    withLock(lock, () => {
      const index = loadIndex();
      if (index[projectId] !== ownerId) {
        index[projectId] = ownerId;
        saveIndex(index);
      }
    });
  }

  /** Remove a projectId from the index under its own lock (rollback path). */
  function indexDelete(projectId) {
    const lock = path.join(registryRoot(), `${INDEX_FILE}.lock`);
    withLock(lock, () => {
      const index = loadIndex();
      if (Object.prototype.hasOwnProperty.call(index, projectId)) {
        delete index[projectId];
        saveIndex(index);
      }
    });
  }

  /**
   * register(project) — validate a Project through createProject (rejecting
   * malformed data with a TypeError) and persist it under its owner. Replaces an
   * existing record with the same id (idempotent re-register / update). Returns
   * the persisted, normalized record.
   *
   * The per-owner read-modify-write runs INSIDE a cross-process lock so
   * concurrent registrations for one owner serialize and none is lost (review
   * finding 2). The projectId -> ownerId index is updated so lookups stay cheap
   * (review finding 3).
   *
   * @param {object} project  a Project-shaped input (must satisfy createProject)
   * @returns {object} the persisted Project record
   */
  function register(project) {
    // Round-trip through the model so malformed data is rejected at the edge.
    const record = createProject(project);
    const lock = `${pathFor(record.ownerId)}.lock`;
    withLock(lock, () => {
      const records = loadForOwner(record.ownerId);
      const idx = records.findIndex((r) => r && r.id === record.id);
      if (idx >= 0) records[idx] = record;
      else records.push(record);
      saveForOwner(record.ownerId, records);
    });
    indexPut(record.id, record.ownerId);
    return record;
  }

  /**
   * unregister(projectId) — remove a Project record (and its index entry). Used
   * as the compensating action when a create fails AFTER registration (review
   * finding 5), so a failed create leaves NO partial Project. Idempotent: a
   * missing record is a no-op. Returns true when a record was removed.
   *
   * @param {string} projectId
   * @param {string} [ownerId]  optional owner hint; resolved via the index when omitted
   * @returns {boolean}
   */
  function unregister(projectId, ownerId) {
    requireString(model, 'projectId', projectId);
    const owner = typeof ownerId === 'string' && ownerId ? ownerId : loadIndex()[projectId];
    let removed = false;
    if (owner) {
      const lock = `${pathFor(owner)}.lock`;
      withLock(lock, () => {
        const records = loadForOwner(owner);
        const next = records.filter((r) => !(r && r.id === projectId));
        if (next.length !== records.length) {
          saveForOwner(owner, next);
          removed = true;
        }
      });
    }
    indexDelete(projectId);
    return removed;
  }

  /**
   * get(projectId) — the Project record with this id, or null. Resolves the
   * owner through the projectId -> ownerId index (one small read) then reads
   * exactly ONE owner file — no full cross-owner scan on the hot path (review
   * finding 3). On an index miss, falls back to a one-time scan that repopulates
   * the index so subsequent lookups are cheap (self-healing).
   */
  function get(projectId) {
    requireString(model, 'projectId', projectId);
    const owner = loadIndex()[projectId];
    if (owner) {
      const rec = loadForOwner(owner).find((r) => r && r.id === projectId);
      if (rec) return rec;
      // Index pointed at the wrong/absent owner — fall through to a rescan.
    }
    return scanAndIndex(projectId);
  }

  /**
   * Fallback: scan every owner file for a projectId, repopulating the index for
   * whatever it finds. Only reached on an index miss (e.g. a registry created by
   * an older build, or an index that was manually removed). Keeps get()
   * correct while the common path stays O(1)-ish.
   */
  function scanAndIndex(projectId) {
    let found = null;
    for (const ownerId of listOwners()) {
      const rec = loadForOwner(ownerId).find((r) => r && r.id === projectId);
      if (rec) {
        found = rec;
        try {
          indexPut(rec.id, ownerId);
        } catch {
          /* best-effort index repair */
        }
        break;
      }
    }
    return found;
  }

  /** listForOwner(ownerId) — every Project record owned by an account. */
  function listForOwner(ownerId) {
    requireString(model, 'ownerId', ownerId);
    return loadForOwner(ownerId);
  }

  /**
   * countForOwner(ownerId) — the number of Projects an account owns. This is
   * EXACTLY the projectCounter(accountId) seam QuotaManager.checkQuota expects
   * for the 'totalProjects' Resource_Quota.
   */
  function countForOwner(ownerId) {
    requireString(model, 'ownerId', ownerId);
    return loadForOwner(ownerId).length;
  }

  /**
   * resolver(projectId) — resolve a projectId to the shape the Builder Server's
   * projectResolver / authorize() consumes: { id, ownerId } or null. Returning
   * null denies WITHOUT disclosure at the server's gate. Backed by the index so
   * the authz hot path does not scan the whole registry (review finding 3).
   */
  function resolver(projectId) {
    const rec = get(projectId);
    return rec ? { id: rec.id, ownerId: rec.ownerId } : null;
  }

  /** Enumerate owner ids that currently have a registry directory on disk. */
  function listOwners() {
    let root;
    try {
      root = registryRoot();
    } catch {
      return [];
    }
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    // Owner subdirectories only — skip the index file and any *.lock artifacts.
    return entries.filter((e) => e.isDirectory() && !e.name.endsWith('.lock')).map((e) => e.name);
  }

  return Object.freeze({
    register,
    unregister,
    get,
    listForOwner,
    countForOwner,
    resolver,
  });
}
