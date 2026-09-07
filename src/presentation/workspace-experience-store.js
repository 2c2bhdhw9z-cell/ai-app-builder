/**
 * THE WORKSPACE_EXPERIENCE STORE (spec Task 31, Req 27, Property 20).
 *
 * Persists a user's pure-presentation Workspace_Experience selection — and, for
 * the `custom` experience, their arranged layout — per User_Account, in the
 * CONTROL-PLANE storage split (out of every exported Project tree), keyed by
 * ownerId. It mirrors the composing-factory conventions of src/memory/store.js:
 * a factory `createWorkspaceExperienceStore({ layout, now })` that validates its
 * layout dependency and returns a FROZEN handle, an INJECTED clock `now`,
 * structured `{ ok:false, code, message }` results, NO state change on failure,
 * and ATOMIC writes (temp file + fsync + rename).
 *
 * NON-MUTATION (Req 27.3, Property 20): this store touches ONLY the
 * UserPresentationSettings document. It never reads or writes Project data,
 * agent state, models, Skills, Connectors, permissions, or Project_Origin, and
 * it carries no Theme/Work_Mode here — a Workspace_Experience selection is pure
 * presentation.
 *
 * THE ON-DISK DOCUMENT is a UserPresentationSettings-shaped JSON object
 * (design.md Data Models):
 *
 *   { userAccountId, workspaceExperience, customLayout? , ...unknown }
 *
 * FORWARD-COMPATIBILITY: `theme` (Req 29) is a LATER task and is intentionally
 * NOT written here. To stay forward-compatible, UNKNOWN fields in an existing
 * document are PRESERVED verbatim across reads and writes — a later Theme store
 * (or a hand-edit) can add fields to the same document without this store
 * dropping them.
 *
 * HANDLE SHAPE: the store exposes both a per-owner handle via `forOwner(ownerId)`
 * — returning bound `{ get(), select(experience), saveCustomLayout(layoutSpec) }`
 * — and flat convenience methods `get(ownerId)`, `select(ownerId, experience)`,
 * and `saveCustomLayout(ownerId, layoutSpec)` that take the ownerId explicitly.
 * `forOwner` reads cleanly when a caller is already scoped to one account (the
 * common Builder Server case); the flat methods suit one-off calls. Per-owner
 * isolation is structural: every path comes from
 * `layout.controlPresentationSettingsPath(ownerId)`, so one owner's settings can
 * never resolve to another's file.
 *
 * PLUMBY BOUNDARY: this module imports Node stdlib + the data model/enums only.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  isValidWorkspaceExperience,
  DEFAULT_WORKSPACE_EXPERIENCE,
} from '../model/enums.js';

const MODEL = 'WorkspaceExperienceStore';

/**
 * Serialize a UserPresentationSettings document to human-readable JSON text
 * (2-space, trailing newline) so it stays user-readable in the control plane.
 */
function serializeSettings(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Create the Workspace_Experience store.
 *
 * @param {object} args
 * @param {object} args.layout  a StorageLayout supplying
 *   controlPresentationSettingsPath(ownerId) (control-plane, out-of-tree).
 * @param {() => Date} [args.now]  injected clock (default () => new Date()).
 * @returns {object} store (frozen)
 */
export function createWorkspaceExperienceStore({ layout, now = () => new Date() } = {}) {
  if (!layout || typeof layout.controlPresentationSettingsPath !== 'function') {
    throw new TypeError(
      `${MODEL}: layout with controlPresentationSettingsPath(ownerId) is required`,
    );
  }

  /** Resolve the on-disk file + dir for an owner's presentation settings. */
  function resolveAddress(ownerId) {
    // requireId lives in the layout; calling through it validates ownerId AND
    // asserts the path is outside every export tree (structural non-leakage).
    const file = layout.controlPresentationSettingsPath(ownerId);
    return { ownerId, dir: path.dirname(file), file };
  }

  /**
   * Read the current UserPresentationSettings document for an owner. A missing
   * file (the user has made no selection) yields defaults WITHOUT writing
   * anything (Req 27.6): { userAccountId, workspaceExperience: DEFAULT }. Any
   * unknown fields already present are returned as-is for forward-compat.
   */
  function readSettings(addr) {
    let raw;
    try {
      raw = fs.readFileSync(addr.file, 'utf8');
    } catch {
      return { userAccountId: addr.ownerId, workspaceExperience: DEFAULT_WORKSPACE_EXPERIENCE };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${MODEL}: corrupt presentation settings at ${addr.file}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { userAccountId: addr.ownerId, workspaceExperience: DEFAULT_WORKSPACE_EXPERIENCE };
    }
    // Preserve unknown fields verbatim (forward-compat, e.g. a future Theme),
    // but normalize the fields this store owns. An out-of-enum persisted value
    // (e.g. a hand-edit) reads as the documented default rather than throwing.
    const experience = isValidWorkspaceExperience(parsed.workspaceExperience)
      ? parsed.workspaceExperience
      : DEFAULT_WORKSPACE_EXPERIENCE;
    return {
      ...parsed,
      userAccountId: addr.ownerId,
      workspaceExperience: experience,
    };
  }

  /** Write the document atomically (temp file + fsync + rename). */
  function writeSettings(addr, doc) {
    const text = serializeSettings(doc);
    try {
      fs.mkdirSync(addr.dir, { recursive: true });
      const tmp = `${addr.file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, Buffer.from(text, 'utf8'));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, addr.file);
    } catch (err) {
      return { ok: false, code: 'write_failed', message: `${MODEL}: could not write presentation settings: ${err.message}` };
    }
    return { ok: true };
  }

  /**
   * get(ownerId): the persisted Workspace_Experience, or
   * DEFAULT_WORKSPACE_EXPERIENCE when the user has made no selection (Req 27.6).
   * A default read NEVER writes anything.
   */
  function get(ownerId) {
    const addr = resolveAddress(ownerId);
    return readSettings(addr).workspaceExperience;
  }

  /**
   * getSettings(ownerId): the full UserPresentationSettings document (including
   * any persisted customLayout and preserved unknown fields). Read-only; a
   * missing file yields defaults without writing.
   */
  function getSettings(ownerId) {
    const addr = resolveAddress(ownerId);
    return readSettings(addr);
  }

  /**
   * select(ownerId, experience): persist a Workspace_Experience selection
   * (Req 27.5). An out-of-enum value is REJECTED with
   * { ok:false, code:'unsupported_experience' } and the current experience is
   * LEFT IN EFFECT — nothing is written (Req 27.7). A valid value is persisted
   * atomically, preserving any existing customLayout and unknown fields, and
   * returns { ok:true, experience }.
   */
  function select(ownerId, experience) {
    const addr = resolveAddress(ownerId);
    if (!isValidWorkspaceExperience(experience)) {
      // Reject WITHOUT writing; the current experience stays in effect.
      return {
        ok: false,
        code: 'unsupported_experience',
        message: `${MODEL}: unsupported Workspace_Experience ${JSON.stringify(experience)}`,
      };
    }
    const current = readSettings(addr);
    const next = { ...current, userAccountId: ownerId, workspaceExperience: experience };
    const written = writeSettings(addr, next);
    if (!written.ok) return written; // no state change on failure
    return { ok: true, experience, at: now().toISOString() };
  }

  /**
   * saveCustomLayout(ownerId, layoutSpec): persist the user's arranged layout
   * for the `custom` experience (Req 27.4). The layout is associated with the
   * `custom` experience per user: this both stores the arrangement and sets the
   * workspaceExperience to `custom`, so a later Session re-applies the user's
   * own layout. `layoutSpec` must be a plain layout object. Atomic; on a failed
   * write nothing changes. Returns { ok:true, experience:'custom', customLayout }.
   */
  function saveCustomLayout(ownerId, layoutSpec) {
    const addr = resolveAddress(ownerId);
    if (!layoutSpec || typeof layoutSpec !== 'object' || Array.isArray(layoutSpec)) {
      return {
        ok: false,
        code: 'invalid_layout',
        message: `${MODEL}: a custom layout must be a plain layout object`,
      };
    }
    const current = readSettings(addr);
    const next = {
      ...current,
      userAccountId: ownerId,
      workspaceExperience: 'custom',
      customLayout: layoutSpec,
    };
    const written = writeSettings(addr, next);
    if (!written.ok) return written; // no state change on failure
    return { ok: true, experience: 'custom', customLayout: layoutSpec, at: now().toISOString() };
  }

  /**
   * forOwner(ownerId): a handle bound to one User_Account, returning
   * { get(), select(experience), saveCustomLayout(layoutSpec), getSettings() }.
   * Reads cleanly when a caller is already scoped to one account.
   */
  function forOwner(ownerId) {
    return Object.freeze({
      ownerId,
      get: () => get(ownerId),
      getSettings: () => getSettings(ownerId),
      select: (experience) => select(ownerId, experience),
      saveCustomLayout: (layoutSpec) => saveCustomLayout(ownerId, layoutSpec),
    });
  }

  return Object.freeze({
    forOwner,
    get,
    getSettings,
    select,
    saveCustomLayout,
  });
}
