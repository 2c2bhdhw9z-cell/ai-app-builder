/*
 * workspace.js — the Workspace_Experience controller (spec Task 10.1; design
 * §"Controllers — workspace.js", Req 8.1–8.6, 11.1).
 *
 * This is the feature logic that turns a Workspace_Experience selection into a
 * `POST /workspace-experience` call and applies the resulting frame as a
 * LAYOUT-ONLY change. A Workspace_Experience is pure presentation — a saved
 * arrangement/visibility/sizing of the builder surfaces — so selecting one
 * changes ONLY the layout slice and never Project data, the Theme, the
 * Work_Mode, the Preview, or the Session activity. That non-mutation invariant
 * is enforced by the store's PURE `WORKSPACE_EXPERIENCE_SET` reducer (which
 * reads only experience/layout/attribution); this controller never dispatches
 * anything that could touch another slice, so it is layout-only by construction.
 *
 * The backend contract this consumes is FIXED (read from
 * src/server/builder-server.js handleGetWorkspaceExperience /
 * handleSelectWorkspaceExperience + workspaceExperienceFrame +
 * src/model/enums.js Workspace_Experience):
 *
 *   GET  /workspace-experience  (Bearer gated, per-account)
 *     200 → { type:'workspace_experience', experience, layout, attribution? }
 *
 *   POST /workspace-experience  body { experience }              (Bearer gated)
 *     200 → { type:'workspace_experience', experience, layout, attribution? }
 *     400 → { error, code, current: { ...workspace_experience frame } }  (unsupported)
 *
 *   POST /workspace-experience  body { customLayout }            (custom save)
 *     200 → { type:'workspace_experience', experience:'custom', layout }
 *
 * On an unsupported 400 the backend returns the STILL-CURRENT experience under
 * `current` (so nothing changed); this controller applies that current frame so
 * the surface confirms it did not change, and surfaces a generic notice.
 *
 * DOM-free and dependency-free: the `store` and the gated `api` client are
 * INJECTED so the whole controller runs under `node --test` with the REAL store
 * reducer and the REAL api client (driven by an injected fetch), never a
 * stand-in double. It imports only the store action names + the api result
 * kinds. The arrangement itself is the view's job (views/stage.js); this
 * controller only mutates the store's workspace slice.
 */

import { ACTIONS } from './store.js';
import { RESULT } from './api.js';

/** The five Workspace_Experience options offered by the control (Req 8.1).
 *  Mirrors src/model/enums.js `Workspace_Experience`, in the same order. */
export const WORKSPACE_EXPERIENCES = Object.freeze([
  'kiro-style',
  'vibe-first',
  'technical-workbench',
  'mobile-command-center',
  'custom',
]);

/** Human labels for each experience, used by the control. Presentation only. */
export const EXPERIENCE_LABELS = Object.freeze({
  'kiro-style': 'Kiro-style Workspace',
  'vibe-first': 'Vibe-first Workspace',
  'technical-workbench': 'Technical Workbench',
  'mobile-command-center': 'Mobile Command Center',
  custom: 'Custom Workspace',
});

/** Client-authored, non-disclosing notice text. Exported so the view + tests
 *  reference the same strings. None carries a backend body field. */
export const WORKSPACE_MESSAGES = Object.freeze({
  UNSUPPORTED: 'That workspace layout is unavailable.',
  REAUTH: 'Your session expired. Please sign in again.',
  ERROR: 'The workspace layout could not be changed.',
});

/** True iff `value` is one of the five supported Workspace_Experience options. */
export function isSupportedExperience(value) {
  return WORKSPACE_EXPERIENCES.includes(value);
}

/**
 * Apply a workspace_experience frame to the store as LAYOUT ONLY (Req 8.3, 8.4).
 * PURE aside from the single store dispatch: it forwards ONLY the three layout
 * fields (experience, layout, attribution) to WORKSPACE_EXPERIENCE_SET, which
 * the reducer enforces cannot touch any other slice. Exported so both the SSE
 * frame path (frames.js) and this controller's own POST/GET responses funnel
 * through one apply.
 *
 * @param {{ dispatch: Function }} store
 * @param {{ experience?: string, layout?: object, attribution?: string }} frame
 */
export function applyWorkspaceFrame(store, frame) {
  const f = frame && typeof frame === 'object' ? frame : {};
  store.dispatch({
    type: ACTIONS.WORKSPACE_EXPERIENCE_SET,
    experience: typeof f.experience === 'string' ? f.experience : undefined,
    layout: f.layout,
    attribution: typeof f.attribution === 'string' ? f.attribution : null,
  });
}

/**
 * Create the Workspace_Experience controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function, subscribe?: Function }} deps.store
 *   the REAL observable store (createStore()).
 * @param {{ request: Function }} deps.api
 *   the REAL gated api client (createApiClient()).
 * @returns {{
 *   experiences: readonly string[],
 *   labels: typeof EXPERIENCE_LABELS,
 *   select: (experience: string) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 *   saveCustomLayout: (layout: object) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 *   bootstrap: () => Promise<{ ok: boolean, experience?: string }>,
 * }}
 */
export function createWorkspaceController({ store, api } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createWorkspaceController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createWorkspaceController requires an api client with request()');
  }

  /**
   * Apply a transport result carrying a workspace_experience frame (the 200 body
   * or the 400 `current` fallback) to the store, layout-only. Shared by select /
   * saveCustomLayout / bootstrap so every applied frame goes through one path.
   * @param {object} data  the frame-shaped body
   */
  function applyFrameData(data) {
    if (data && typeof data === 'object' && data.type === 'workspace_experience') {
      applyWorkspaceFrame(store, data);
    }
  }

  /**
   * Select/switch the Workspace_Experience (Req 8.2). POSTs the selected value
   * with the Bearer (api.js attaches it), then applies the returned layout-only
   * frame. On an unsupported 400 the backend returns the STILL-CURRENT frame
   * under `current`; we apply that (nothing changed) and set a generic notice.
   *
   * @param {string} experience  one of the five Workspace_Experience values
   * @returns {Promise<{ ok: boolean, reason?: string, result?: object }>}
   */
  async function select(experience) {
    const result = await api.request('POST', '/workspace-experience', {
      body: { experience },
    });

    switch (result.kind) {
      case RESULT.OK: {
        applyFrameData(result.data);
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        return { ok: true, result };
      }
      case RESULT.VALIDATION:
      case RESULT.PROTOCOL: {
        // Unsupported experience: the backend left the current one in effect and
        // returned it under `current`. Apply that so the surface confirms nothing
        // changed (Req 8.3 non-mutation), and show a generic notice.
        const current = result.data && result.data.current;
        applyFrameData(current);
        store.dispatch({
          type: ACTIONS.NOTICE_SET,
          kind: 'validation',
          message: WORKSPACE_MESSAGES.UNSUPPORTED,
        });
        return { ok: false, reason: 'validation', result };
      }
      case RESULT.DENIED:
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: WORKSPACE_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };
      default:
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: WORKSPACE_MESSAGES.ERROR });
        return { ok: false, reason: 'error', result };
    }
  }

  /**
   * Save a `custom` arrangement (Req 8.6): POST the arranged layout as
   * `customLayout`; the backend persists it per-account and returns a `custom`
   * frame we apply layout-only.
   * @param {object} layout  a plain layout descriptor object
   * @returns {Promise<{ ok: boolean, reason?: string, result?: object }>}
   */
  async function saveCustomLayout(layout) {
    const result = await api.request('POST', '/workspace-experience', {
      body: { customLayout: layout },
    });
    if (result.kind === RESULT.OK) {
      applyFrameData(result.data);
      store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
      return { ok: true, result };
    }
    if (result.kind === RESULT.DENIED) {
      store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: WORKSPACE_MESSAGES.REAUTH });
      return { ok: false, reason: 'denied', result };
    }
    store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: WORKSPACE_MESSAGES.ERROR });
    return { ok: false, reason: 'error', result };
  }

  /**
   * Bootstrap the default Workspace_Experience for an account that has selected
   * none (Req 8.5): GET /workspace-experience and apply the reported default
   * layout-only. A denied/failed read leaves the (null) layout untouched so the
   * shell renders a sensible default until a later frame arrives.
   * @returns {Promise<{ ok: boolean, experience?: string }>}
   */
  async function bootstrap() {
    const result = await api.request('GET', '/workspace-experience');
    if (result.kind === RESULT.OK && result.data && result.data.type === 'workspace_experience') {
      applyFrameData(result.data);
      return { ok: true, experience: result.data.experience };
    }
    return { ok: false };
  }

  return {
    experiences: WORKSPACE_EXPERIENCES,
    labels: EXPERIENCE_LABELS,
    select,
    saveCustomLayout,
    bootstrap,
  };
}
