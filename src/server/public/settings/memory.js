/*
 * settings/memory.js — the memory settings controller (spec Task 14.3; design
 * §"Controllers — settings/*.js", Req 14.3, 14.4, 14.5).
 *
 * The feature logic behind the memory screen:
 *   - list()      → GET the Project_Memory + Global_Memory entries + the active
 *                   Memory_Mode reported by the backend (Req 14.3).
 *   - editEntry() → POST an edit of a Memory_Entry with the Bearer (Req 14.4).
 *   - pruneEntry()→ POST a prune (delete) of a Memory_Entry with the Bearer (14.4).
 *   - setMode()   → POST the chosen Memory_Mode among auto/manual/off (Req 14.5).
 *
 * ─── ASSUMED CONTRACT (honest note) ───────────────────────────────────────
 * The Builder_Server exposes NO memory HTTP route today — memory is a backend
 * store (src/memory/store.js) that keeps human-readable, exportable files with a
 * per-scope Memory_Mode ('auto'|'manual'|'off'), none of it HTTP-surfaced. Per
 * the spec, this controller is written against a DOCUMENTED/ASSUMED contract
 * mirroring those real store shapes and does NOT add or modify any backend route:
 *
 *   GET  /settings/memory                                      (Bearer gated)
 *     200 → { project: [{ id, kind?, text }...],
 *             global:  [{ id, kind?, text }...],
 *             mode: 'auto'|'manual'|'off' }
 *   POST /settings/memory  body { op:'edit',  scope, id, text }  (Bearer gated)
 *   POST /settings/memory  body { op:'prune', scope, id }        (Bearer gated)
 *   POST /settings/memory  body { op:'mode',  mode }             (Bearer gated)
 *     200 → { project?, global?, mode? }                          (updated view)
 *     400 → { error, code? }  (invalid_mode, unknown entry)
 *     401 → (non-disclosing denial; body discarded by api.js)
 *
 * The project/global scopes, the entry { id, kind, text } shape, the Memory_Mode
 * values, and the setMode `invalid_mode` code all mirror src/memory/store.js +
 * src/model/enums.js isValidMemoryMode. Memory entries are the user's own
 * content (not secrets), so they ARE shown — this surface is about ownership.
 *
 * DOM-free and dependency-free: `store` + gated `api` are INJECTED.
 */

import { ACTIONS } from '../store.js';
import { RESULT } from '../api.js';
import { createSettingsState } from './settings-state.js';

/** The three Memory_Mode values (Req 14.5). Mirrors src/model/enums.js. */
export const MEMORY_MODES = Object.freeze(['auto', 'manual', 'off']);

/** Client-authored, non-disclosing notice text. */
export const MEMORY_MESSAGES = Object.freeze({
  REAUTH: 'Your session expired. Please sign in again.',
  REJECTED: 'That change could not be applied.',
  RATE_LIMITED: 'A usage limit was reached.',
  ERROR: 'The change could not be applied.',
});

/** True iff `value` is a supported Memory_Mode. */
export function isSupportedMode(value) {
  return MEMORY_MODES.includes(value);
}

/** Normalize a memory entry to the safe display shape. */
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const id = typeof e.id === 'string' ? e.id : null;
  if (!id) return null;
  return { id, kind: typeof e.kind === 'string' ? e.kind : '', text: typeof e.text === 'string' ? e.text : '' };
}

/**
 * Create the memory controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function }} deps.store
 * @param {{ request: Function }} deps.api
 * @returns {object}
 */
export function createMemoryController({ store, api } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createMemoryController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createMemoryController requires an api client with request()');
  }

  const surface = createSettingsState({
    project: [], // [{ id, kind, text }]
    global: [], // [{ id, kind, text }]
    mode: 'auto', // active Memory_Mode (Req 14.3)
    modes: MEMORY_MODES,
    inFlight: false,
  });

  /** Apply an updated view body (from any POST) into the surface. */
  function applyView(data) {
    if (!data || typeof data !== 'object') return;
    const patch = {};
    if (Array.isArray(data.project)) patch.project = data.project.map(normalizeEntry).filter(Boolean);
    if (Array.isArray(data.global)) patch.global = data.global.map(normalizeEntry).filter(Boolean);
    if (typeof data.mode === 'string' && isSupportedMode(data.mode)) patch.mode = data.mode;
    if (Object.keys(patch).length) surface.set(patch);
  }

  /**
   * List Project_Memory + Global_Memory + the active Memory_Mode (Req 14.3).
   * @returns {Promise<{ ok: boolean, result?: object }>}
   */
  async function list() {
    const result = await api.request('GET', '/settings/memory');
    if (result.kind === RESULT.OK && result.data && typeof result.data === 'object') {
      const project = (Array.isArray(result.data.project) ? result.data.project : []).map(normalizeEntry).filter(Boolean);
      const global = (Array.isArray(result.data.global) ? result.data.global : []).map(normalizeEntry).filter(Boolean);
      const mode = isSupportedMode(result.data.mode) ? result.data.mode : 'auto';
      surface.set({ project, global, mode });
      return { ok: true, result };
    }
    if (result.kind === RESULT.DENIED) {
      store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: MEMORY_MESSAGES.REAUTH });
    }
    return { ok: false, result };
  }

  /** Shared POST + outcome mapping for edit/prune/mode (Req 14.4, 14.5). */
  async function post(body) {
    surface.set({ inFlight: true });
    const result = await api.request('POST', '/settings/memory', { body });
    switch (result.kind) {
      case RESULT.OK:
        applyView(result.data);
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        return { ok: true, result };
      case RESULT.VALIDATION:
      case RESULT.PROTOCOL:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'validation', message: MEMORY_MESSAGES.REJECTED });
        return { ok: false, reason: 'validation', result };
      case RESULT.RATE_LIMITED: {
        surface.set({ inFlight: false });
        const named = typeof result.limit === 'string' && result.limit ? result.limit : null;
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'rateLimited', message: MEMORY_MESSAGES.RATE_LIMITED, limit: named });
        return { ok: false, reason: 'rateLimited', result };
      }
      case RESULT.DENIED:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: MEMORY_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };
      default:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: MEMORY_MESSAGES.ERROR });
        return { ok: false, reason: 'error', result };
    }
  }

  /** Edit a Memory_Entry's text (Req 14.4). scope is 'project'|'global'. */
  function editEntry(scope, id, text) {
    return post({ op: 'edit', scope, id, text });
  }

  /** Prune (delete) a Memory_Entry (Req 14.4). */
  function pruneEntry(scope, id) {
    return post({ op: 'prune', scope, id });
  }

  /**
   * Change the Memory_Mode among auto/manual/off (Req 14.5). An unsupported mode
   * is rejected client-side (no network) with a generic notice, mirroring the
   * backend's `invalid_mode` guard.
   */
  async function setMode(mode) {
    if (!isSupportedMode(mode)) {
      store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'validation', message: MEMORY_MESSAGES.REJECTED });
      return { ok: false, reason: 'validation' };
    }
    const out = await post({ op: 'mode', mode });
    if (out.ok) surface.set({ mode });
    return out;
  }

  return {
    getState: surface.getState,
    subscribe: surface.subscribe,
    modes: MEMORY_MODES,
    list,
    editEntry,
    pruneEntry,
    setMode,
  };
}
