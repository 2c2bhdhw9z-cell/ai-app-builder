/*
 * work-mode.js — the Work_Mode controller (spec Task 12.1; design
 *  §"Controllers — work-mode.js" / §"Work_Mode state", Req 10.1–10.5).
 *
 * This is the feature logic behind the Session_Header's Work_Mode display +
 * switch control. A Work_Mode is a per-Session interaction FLOW (`vibe` /
 * `spec` / `hybrid`); `vibe` is the default for a new Session (Req 10.5, enforced
 * by the store's SESSION_OPEN reducer). It owns:
 *
 *   - `switchMode(mode)`: POST /work-mode { projectId, mode } with the Bearer
 *     (api.js attaches it) (Req 10.4). The backend does NOT apply immediately —
 *     it routes the switch through the EXISTING confirm surface and, on approval,
 *     broadcasts the new active mode on `work_mode` + `session_header` frames.
 *     Those frames are dispatched into the store by frames.js (Task 4) via
 *     WORK_MODE_SET, so the displayed mode updates through the SAME frame path as
 *     a reconnect replay — this controller only fires the request. An out-of-enum
 *     `mode` is refused 400 by the backend with the current mode left in effect;
 *     the controller keeps the displayed mode and shows a generic notice.
 *   - `applyFrame(frame)`: apply a `work_mode` or `session_header` frame to the
 *     store (Req 10.2). Shared with frames.js's mapping so a controller-driven
 *     path and the SSE path agree on the shape. A `work_mode` frame names the
 *     mode under `mode`/`choices`; a `session_header` frame under
 *     `workMode`/`workModeChoices`.
 *   - `bootstrap()`: GET /work-mode?projectId=… to read the active mode + the
 *     offered choices for an open Session and apply them (Req 10.1/10.2). Until it
 *     resolves (or with no open session) the store's `vibe` default stands
 *     (Req 10.5).
 *
 * The backend contract this consumes is FIXED (read from src/server/builder-server.js
 * handleGetWorkMode / handleSwitchWorkMode + workModeFrame / sessionHeaderFrame +
 * src/model/enums.js Work_Mode):
 *
 *   GET  /work-mode?projectId=<id>                               (Bearer gated)
 *     200 → { type:'work_mode', mode, choices }
 *   POST /work-mode  body { projectId, mode }                    (Bearer gated)
 *     200 → { ...work_mode frame, applied:<bool> }  (applied via confirm)
 *     400 → { error, code:'unsupported_work_mode', current:{ ...work_mode frame } }
 *
 * DOM-free and dependency-free: `store` and the gated `api` client are INJECTED,
 * so the controller runs under `node --test` with the REAL store reducer and the
 * REAL api client (driven by an injected fetch). It imports only the store action
 * names + the api result kinds.
 */

import { ACTIONS } from './store.js';
import { RESULT } from './api.js';

/** The three Work_Mode options offered by the switch control (Req 10.3).
 *  Mirrors src/model/enums.js `Work_Mode`, in the same order. */
export const WORK_MODE_OPTIONS = Object.freeze(['vibe', 'spec', 'hybrid']);

/** Human labels for the switch control. Presentation only. */
export const WORK_MODE_LABELS = Object.freeze({
  vibe: 'Vibe',
  spec: 'Spec',
  hybrid: 'Hybrid',
});

/** Client-authored, non-disclosing notice text. Exported so the view + tests
 *  reference the same strings. None carries a backend body field. */
export const WORK_MODE_MESSAGES = Object.freeze({
  UNSUPPORTED: 'That work mode is unavailable.',
  NOT_APPLIED: 'The work mode change was not applied.',
  REAUTH: 'Your session expired. Please sign in again.',
  ERROR: 'The work mode could not be changed.',
});

/** True iff `value` is one of the three supported Work_Mode options. */
export function isSupportedWorkMode(value) {
  return WORK_MODE_OPTIONS.includes(value);
}

/**
 * Apply a `work_mode` or `session_header` frame to the store (Req 10.2). PURE
 * aside from the single dispatch: it reads the active mode + choices from
 * EITHER frame shape and forwards them to WORK_MODE_SET. Exported so both the
 * SSE frame path (frames.js) and this controller funnel through one apply.
 *
 * @param {{ dispatch: Function }} store
 * @param {{ type?: string, mode?: string, choices?: string[], workMode?: string, workModeChoices?: string[] }} frame
 */
export function applyWorkModeFrame(store, frame) {
  const f = frame && typeof frame === 'object' ? frame : {};
  // A session_header frame names the mode under workMode/workModeChoices; a
  // work_mode frame under mode/choices. Read whichever is present.
  const active = typeof f.mode === 'string' ? f.mode : typeof f.workMode === 'string' ? f.workMode : undefined;
  const choices = Array.isArray(f.choices)
    ? f.choices
    : Array.isArray(f.workModeChoices)
      ? f.workModeChoices
      : undefined;
  store.dispatch({ type: ACTIONS.WORK_MODE_SET, active, choices });
}

/**
 * Create the Work_Mode controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function, subscribe?: Function }} deps.store
 *   the REAL observable store (createStore()).
 * @param {{ request: Function }} deps.api
 *   the REAL gated api client (createApiClient()).
 * @returns {{
 *   options: readonly string[],
 *   labels: typeof WORK_MODE_LABELS,
 *   switchMode: (mode: string) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 *   applyFrame: (frame: object) => void,
 *   bootstrap: () => Promise<{ ok: boolean, mode?: string }>,
 * }}
 */
export function createWorkModeController({ store, api } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createWorkModeController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createWorkModeController requires an api client with request()');
  }

  /**
   * Request a Work_Mode switch (Req 10.4). Reads the open Session's projectId
   * and POSTs { projectId, mode }; api.js attaches the Bearer. With no open
   * session there is nothing to switch, so we no-op with a generic notice rather
   * than sending a project-less request. The actual displayed-mode update
   * arrives on the `work_mode`/`session_header` broadcast frame (frames.js), so
   * this method only fires the request and maps failures onto a notice.
   * @param {string} mode
   */
  async function switchMode(mode) {
    const projectId = store.getState().session.projectId;
    if (typeof projectId !== 'string' || projectId === '') {
      store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: WORK_MODE_MESSAGES.ERROR });
      return { ok: false, reason: 'no-session' };
    }

    const result = await api.request('POST', '/work-mode', { body: { projectId, mode } });

    switch (result.kind) {
      case RESULT.OK: {
        // The backend applies via confirm and broadcasts the new active mode on
        // work_mode/session_header frames (handled by frames.js). If the body
        // reports the switch was NOT applied (denied/fail-closed confirm), show a
        // generic notice; otherwise clear any prior notice.
        const applied = result.data && result.data.applied;
        if (applied === false) {
          store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: WORK_MODE_MESSAGES.NOT_APPLIED });
          return { ok: false, reason: 'not-applied', result };
        }
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        return { ok: true, result };
      }
      case RESULT.VALIDATION:
      case RESULT.PROTOCOL:
        // Unsupported mode: the current mode stays in effect (Req 10.2 — the
        // display only changes on a frame). Show a generic notice.
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'validation', message: WORK_MODE_MESSAGES.UNSUPPORTED });
        return { ok: false, reason: 'validation', result };
      case RESULT.DENIED:
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: WORK_MODE_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };
      default:
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: WORK_MODE_MESSAGES.ERROR });
        return { ok: false, reason: 'error', result };
    }
  }

  /** Apply a work_mode / session_header frame to the store (Req 10.2). */
  function applyFrame(frame) {
    applyWorkModeFrame(store, frame);
  }

  /**
   * Read the open Session's active Work_Mode + choices (Req 10.1/10.2). GET
   * /work-mode?projectId=…; apply the frame. With no open session this is a
   * no-op and the store's `vibe` default stands (Req 10.5).
   * @returns {Promise<{ ok: boolean, mode?: string }>}
   */
  async function bootstrap() {
    const projectId = store.getState().session.projectId;
    if (typeof projectId !== 'string' || projectId === '') return { ok: false };
    const result = await api.request('GET', `/work-mode?projectId=${encodeURIComponent(projectId)}`);
    if (result.kind === RESULT.OK && result.data && result.data.type === 'work_mode') {
      applyFrame(result.data);
      return { ok: true, mode: result.data.mode };
    }
    return { ok: false };
  }

  return {
    options: WORK_MODE_OPTIONS,
    labels: WORK_MODE_LABELS,
    switchMode,
    applyFrame,
    bootstrap,
  };
}
