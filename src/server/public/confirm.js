/*
 * confirm.js — the confirm-class command approval controller
 * (spec Task 6.1; design §"Controllers — confirm.js", Req 5.1–5.5, 11.3).
 *
 * A confirm-class command the Builder_Agent proposes is surfaced to the client
 * as a `confirm_request` SSE frame. frames.js (Task 4.2) already dispatches that
 * frame into the store's pendingConfirms slice (CONFIRM_ADDED, keyed by
 * requestId) and clears it on a `confirm_timeout` frame (CONFIRM_CLEARED). This
 * controller owns the USER-DECISION half: turning an approve/deny intent into a
 * `POST /confirm` carrying the frame's requestId + the decision, and mapping the
 * transport outcome back onto the store.
 *
 * It owns NO DOM. The confirm view (views/confirm.js) reads the pendingConfirms
 * slice this controller clears and calls back into `decide()`. Both
 * collaborators — the REAL store and the REAL gated api client — are INJECTED,
 * so the controller is exercised under `node --test` with the shipping store
 * reducer and the shipping api classifier (driven by an injected fetch), never
 * a stand-in double.
 *
 * The backend contract (read from src/server/builder-server.js handleConfirm):
 *   POST /confirm  body: { projectId, requestId, approved: boolean }
 *     - `projectId` is REQUIRED (400 without it) — it keys the per-session
 *       pending-confirm registry alongside the authenticated accountId.
 *     - `approved === true` ALLOWS the command; anything else DENIES it. The
 *       backend's resolve-once guard makes a repeated POST a harmless 200, and
 *       an unanswered prompt FAILS CLOSED under the guard's <=60s ceiling — so
 *       the view must keep the prompt visible until the user acts (Req 5.3).
 *     - The Bearer is attached by api.js on this gated call (Req 5.2).
 *
 * Non-disclosing 401 (Req 5.5): api.js discards a 401 body and resolves a bare
 * `{ kind:'denied' }`; the controller maps that to a re-auth notice with NO
 * project-specific detail. It does NOT clear the pending confirm on a denial —
 * the prompt stays visible so a re-authenticated user can still act before the
 * fail-closed timeout.
 *
 * Idempotent re-display on reconnect replay (Req 5.4) is a STORE property: the
 * server replays a still-pending confirm_request among its current-state frames
 * on reconnect, and the store's CONFIRM_ADDED reducer de-dupes an identical
 * re-add (same requestId + payload) to the SAME state reference. This controller
 * therefore does nothing special for replay; the view, subscribed to the
 * pendingConfirms selector, simply does not re-render for a no-op re-add.
 */

import { ACTIONS, selectPendingConfirms, selectProjectId } from './store.js';
import { RESULT } from './api.js';

/**
 * Client-authored, non-disclosing notice text. The re-auth message is the ONLY
 * string shown on a 401 and carries NO backend body detail (Req 5.5, 16.1).
 * Exported so the view and tests reference the same text.
 */
export const CONFIRM_MESSAGES = Object.freeze({
  REAUTH: 'Your session expired. Please sign in again.',
  ERROR: 'The decision could not be sent. Please try again.',
});

/**
 * The two decisions a user can make on a Confirm_Prompt, mapped to the boolean
 * `approved` field the backend expects. Exported so the view and tests branch on
 * a stable name rather than a raw boolean.
 * @type {Readonly<Record<string, boolean>>}
 */
export const DECISION = Object.freeze({
  APPROVE: true,
  DENY: false,
});

/**
 * Create the confirm controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function, subscribe?: Function }} deps.store
 *   the REAL observable store (createStore()).
 * @param {{ request: Function }} deps.api
 *   the REAL gated api client (createApiClient()).
 * @returns {{
 *   approve: (requestId: string) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 *   deny: (requestId: string) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 *   decide: (requestId: string, approved: boolean) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 * }}
 */
export function createConfirmController({ store, api }) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createConfirmController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createConfirmController requires an api client with request()');
  }

  /**
   * Answer a pending Confirm_Prompt.
   *
   * Flow:
   *   1. Guard: the requestId must name a CURRENTLY pending confirm. Answering
   *      an unknown/already-cleared requestId makes ZERO network calls and
   *      returns a `notPending` rejection (so a double-click after the prompt
   *      cleared, or a stale requestId, cannot fire a spurious POST).
   *   2. POST /confirm with { projectId, requestId, approved } and the Bearer
   *      (attached by api.js). `approved` is coerced to a strict boolean so the
   *      backend's `approved === true` allow-check is exact (Req 5.2).
   *   3. Map the outcome:
   *        ok          -> clear the pending confirm (answered) — Req 5.3 done.
   *        denied(401) -> re-auth notice, NO project detail, KEEP the confirm
   *                       visible so a re-authenticated user can still act (5.5).
   *        other/error/timeout -> generic notice, KEEP the confirm visible for a
   *                       retry before the fail-closed timeout (5.3).
   *
   * @param {string} requestId  the confirm frame's request id
   * @param {boolean} approved  the decision (true = approve, false = deny)
   * @returns {Promise<{ ok: boolean, reason?: string, result?: object }>}
   */
  async function decide(requestId, approved) {
    // (1) Only answer a currently-pending confirm.
    if (typeof requestId !== 'string' || requestId === '') {
      return { ok: false, reason: 'notPending' };
    }
    const pending = selectPendingConfirms(store.getState());
    if (!pending || pending[requestId] === undefined) {
      return { ok: false, reason: 'notPending' };
    }

    const projectId = selectProjectId(store.getState());

    // (2) POST the decision carrying the frame's requestId + the Bearer. The
    // `approved` field is a STRICT boolean so the backend's allow-check is exact.
    const result = await api.request('POST', '/confirm', {
      body: { projectId, requestId, approved: approved === true },
    });

    // (3) Map the transport outcome.
    switch (result.kind) {
      case RESULT.OK:
        // Answered: clear the pending confirm so the view removes it (Req 5.3).
        store.dispatch({ type: ACTIONS.CONFIRM_CLEARED, requestId });
        return { ok: true, result };

      case RESULT.DENIED:
        // Req 5.5: surface a re-authentication prompt with NO project-specific
        // detail (api.js already discarded the 401 body). Do NOT clear the
        // confirm — keep it visible so a re-authenticated retry can still act.
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: CONFIRM_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };

      default:
        // timeout / validation / protocol / error: a generic, non-disclosing
        // notice. Keep the confirm visible so the user can retry the decision
        // before the backend's fail-closed timeout elapses (Req 5.3).
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: CONFIRM_MESSAGES.ERROR });
        return { ok: false, reason: 'error', result };
    }
  }

  /** Approve a pending Confirm_Prompt (POST /confirm approved:true). */
  function approve(requestId) {
    return decide(requestId, DECISION.APPROVE);
  }

  /** Deny a pending Confirm_Prompt (POST /confirm approved:false). */
  function deny(requestId) {
    return decide(requestId, DECISION.DENY);
  }

  return { approve, deny, decide };
}
