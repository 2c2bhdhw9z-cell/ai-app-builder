/**
 * THE THEME STORE (spec Task 33.1, Req 29, Property 22).
 *
 * Persists a user's COMMITTED Theme PER (User_Account, Workspace_Experience)
 * pair (Req 29.2) — NOT a single per-user value. It lives in the SAME
 * control-plane UserPresentationSettings document introduced in Task 31
 * (controlRoot/presentation/<ownerId>/presentation.json), stored as a
 * `themesByExperience` MAP `{ <experience>: <themeId> }` ALONGSIDE
 * workspaceExperience/customLayout WITHOUT clobbering them or any unknown
 * field. A later Session re-applies each experience's committed Theme by
 * reading `themesByExperience` back (Req 29.5).
 *
 * It mirrors the composing-factory conventions of
 * src/presentation/workspace-experience-store.js: a factory
 * `createThemeStore({ layout, now })` that validates its layout dependency and
 * returns a FROZEN handle, an INJECTED clock `now`, structured
 * `{ ok:false, code, message }` results, NO state change on failure, and ATOMIC
 * writes (temp file + fsync + rename), with a read-modify-write that PRESERVES
 * all sibling + unknown fields.
 *
 * DEFAULT READ (Req 29.3): entering an experience with no committed Theme
 * yields THAT experience's default via defaultThemeFor(experience) and writes
 * NOTHING. A persisted out-of-catalog value reads back as the experience
 * default (defensive read, no throw).
 *
 * REJECTION (Req 29.8): committing an out-of-catalog Theme, or a Theme for an
 * out-of-enum Workspace_Experience, is REJECTED and NOTHING is written, leaving
 * the current committed Theme in effect.
 *
 * NON-MUTATION (Req 29.6, Property 22): this store touches ONLY the
 * UserPresentationSettings document. It never reads or writes Project data,
 * agent state, models, Skills, Connectors, permissions, Work_Mode,
 * Workspace_Experience layout, or Project_Origin — a Theme selection is pure
 * visual appearance and is independent of the Workspace_Experience and
 * Work_Mode.
 *
 * HANDLE SHAPE: the store exposes a per-owner handle via `forOwner(ownerId)` —
 * returning bound `{ getCommitted(experience), getAllCommitted(),
 * commit(experience, theme), getSettings() }` — and flat convenience methods
 * that take the ownerId explicitly. Per-owner isolation is structural: every
 * path comes from `layout.controlPresentationSettingsPath(ownerId)`.
 *
 * PLUMBY BOUNDARY: this module imports Node stdlib + the data model/enums only.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  isValidWorkspaceExperience,
  isValidTheme,
  defaultThemeFor,
} from '../model/enums.js';

const MODEL = 'ThemeStore';

/**
 * Serialize a UserPresentationSettings document to human-readable JSON text
 * (2-space, trailing newline) so it stays user-readable in the control plane.
 */
function serializeSettings(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Create the Theme store.
 *
 * @param {object} args
 * @param {object} args.layout  a StorageLayout supplying
 *   controlPresentationSettingsPath(ownerId) (control-plane, out-of-tree).
 * @param {() => Date} [args.now]  injected clock (default () => new Date()).
 * @returns {object} store (frozen)
 */
export function createThemeStore({ layout, now = () => new Date() } = {}) {
  if (!layout || typeof layout.controlPresentationSettingsPath !== 'function') {
    throw new TypeError(
      `${MODEL}: layout with controlPresentationSettingsPath(ownerId) is required`,
    );
  }

  /** Resolve the on-disk file + dir for an owner's presentation settings. */
  function resolveAddress(ownerId) {
    // Calling through the layout validates ownerId AND asserts the path is
    // outside every export tree (structural non-leakage).
    const file = layout.controlPresentationSettingsPath(ownerId);
    return { ownerId, dir: path.dirname(file), file };
  }

  /**
   * Read the current UserPresentationSettings document for an owner. A missing
   * file (the user has made no selection) yields a minimal shape WITHOUT
   * writing anything: { userAccountId, themesByExperience: {} }. Any unknown
   * fields already present (workspaceExperience/customLayout/etc.) are returned
   * as-is for forward-compat.
   */
  function readSettings(addr) {
    let raw;
    try {
      raw = fs.readFileSync(addr.file, 'utf8');
    } catch {
      return { userAccountId: addr.ownerId, themesByExperience: {} };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${MODEL}: corrupt presentation settings at ${addr.file}: ${err.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { userAccountId: addr.ownerId, themesByExperience: {} };
    }
    // Preserve all sibling + unknown fields verbatim. Normalize only the map
    // this store owns: it must be a plain object (a corrupt/absent value reads
    // as an empty map rather than throwing).
    const rawMap = parsed.themesByExperience;
    const themesByExperience =
      rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap) ? rawMap : {};
    return {
      ...parsed,
      userAccountId: addr.ownerId,
      themesByExperience,
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
   * getCommitted(ownerId, experience): the committed Theme id for that (owner,
   * experience), or defaultThemeFor(experience) when none is committed (Req
   * 29.3). A persisted out-of-catalog value defensively reads back as the
   * experience default. A default read NEVER writes anything.
   */
  function getCommitted(ownerId, experience) {
    const addr = resolveAddress(ownerId);
    const map = readSettings(addr).themesByExperience;
    const committed = map[experience];
    return isValidTheme(committed) ? committed : defaultThemeFor(experience);
  }

  /**
   * getAllCommitted(ownerId): a shallow copy of the themesByExperience map (may
   * be empty). Read-only; a missing file yields {} without writing.
   */
  function getAllCommitted(ownerId) {
    const addr = resolveAddress(ownerId);
    return { ...readSettings(addr).themesByExperience };
  }

  /**
   * getSettings(ownerId): the full UserPresentationSettings document (including
   * any workspaceExperience/customLayout and preserved unknown fields).
   * Read-only; a missing file yields the minimal shape without writing.
   */
  function getSettings(ownerId) {
    const addr = resolveAddress(ownerId);
    return readSettings(addr);
  }

  /**
   * commit(ownerId, experience, theme): persist a committed Theme for a
   * (User_Account, Workspace_Experience) pair (Req 29.4). An out-of-enum
   * experience is REJECTED with { ok:false, code:'unsupported_experience' } and
   * an out-of-catalog theme with { ok:false, code:'unsupported_theme' } (Req
   * 29.8) — in either case NOTHING is written and the current committed Theme
   * stays in effect. A valid pair does read-modify-write, setting
   * themesByExperience[experience]=theme while PRESERVING
   * workspaceExperience/customLayout/other experiences' themes/unknown fields,
   * atomically, and returns { ok:true, experience, theme, at }.
   */
  function commit(ownerId, experience, theme) {
    const addr = resolveAddress(ownerId);
    // Validate the experience first, then the theme; reject WITHOUT writing.
    if (!isValidWorkspaceExperience(experience)) {
      return {
        ok: false,
        code: 'unsupported_experience',
        message: `${MODEL}: unsupported Workspace_Experience ${JSON.stringify(experience)}`,
      };
    }
    if (!isValidTheme(theme)) {
      return {
        ok: false,
        code: 'unsupported_theme',
        message: `${MODEL}: unsupported Theme ${JSON.stringify(theme)}`,
      };
    }
    const current = readSettings(addr);
    const next = {
      ...current,
      userAccountId: ownerId,
      themesByExperience: { ...current.themesByExperience, [experience]: theme },
    };
    const written = writeSettings(addr, next);
    if (!written.ok) return written; // no state change on failure
    return { ok: true, experience, theme, at: now().toISOString() };
  }

  /**
   * forOwner(ownerId): a handle bound to one User_Account, returning
   * { getCommitted(experience), getAllCommitted(), commit(experience, theme),
   * getSettings() }. Reads cleanly when a caller is already scoped to one
   * account.
   */
  function forOwner(ownerId) {
    return Object.freeze({
      ownerId,
      getCommitted: (experience) => getCommitted(ownerId, experience),
      getAllCommitted: () => getAllCommitted(ownerId),
      commit: (experience, theme) => commit(ownerId, experience, theme),
      getSettings: () => getSettings(ownerId),
    });
  }

  return Object.freeze({
    forOwner,
    getCommitted,
    getAllCommitted,
    getSettings,
    commit,
  });
}
