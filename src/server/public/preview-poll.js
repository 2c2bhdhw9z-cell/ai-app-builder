/*
 * preview-poll.js — the 5s Preview liveness poll (spec Task 5.2; design
 *  §"Transport layer — preview-poll.js", Req 4.7, 4.8, 4.9).
 *
 * This is one of only three modules that touch the network (api / sse /
 * preview-poll). It exists because of a genuine gap in the backend contract:
 * the server PUSHES loading/ready/showing_prior/error/persistent_failure over
 * SSE, but a DEAD preview is only discoverable by polling GET /preview — there
 * is no `preview_dead` push (design "research findings", Req 4.7–4.9). So while
 * a Project_Session is open this poller calls `GET /preview?projectId=…` every
 * 5 seconds and reconciles the result into the store's preview slice.
 *
 * Behavior (Req 4.7–4.9):
 *   - 4.7: while a session is open, poll every 5,000 ms.
 *   - 4.8: a poll response reporting a NON-LIVE preview updates the preview
 *     status to a FAILURE indication tagged `source:'poll'` (so a poll-driven
 *     failure is attributable and does not masquerade as an SSE frame). The
 *     projection + non-live decision live in preview.js (previewFromServed /
 *     isNonLiveServed), which are PURE and property-tested.
 *   - 4.9: a poll that TIMES OUT (the api client enforces a 5s AbortController
 *     timeout on `/preview`) or returns a NON-SUCCESS result RETAINS the last
 *     known preview status (no store mutation) and simply continues on the next
 *     interval. A failed poll is therefore INERT — it never regresses a good
 *     preview to a failure on a transient network blip.
 *
 * TESTABILITY. The timer functions and the preview controller (which owns the
 * gated api call + the store projection) are INJECTED, defaulting to the
 * browser globals + a controller built from the passed store/api. So the whole
 * cadence and the retain/failure reconciliation run deterministically under
 * `node --test` with a fake clock and a scripted api — no real network, no real
 * timers, no browser.
 */

import { RESULT } from './api.js';
import { createPreviewController, isNonLiveServed } from './preview.js';

/** The fixed liveness poll interval (Req 4.7), in ms. */
export const POLL_INTERVAL_MS = 5_000;

/** The per-poll request timeout (Req 4.9); matches the api client `/preview` default. */
export const POLL_TIMEOUT_MS = 5_000;

/**
 * Create the preview liveness poller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function }} deps.store  the REAL store
 * @param {{ request: Function }} deps.api  the gated api client (Task 2.2)
 * @param {object} [deps.controller]  optional injected preview controller (tests);
 *                                     defaults to one built from store+api
 * @param {(cb: Function, ms: number) => any} [deps.setIntervalImpl]  injectable timer
 * @param {(id: any) => void} [deps.clearIntervalImpl]  injectable timer clear
 * @param {number} [deps.intervalMs]  override the poll interval (default 5000)
 * @returns {{ start: (projectId: string) => void, stop: () => void, pollOnce: () => Promise<object>, isRunning: () => boolean }}
 */
export function createPreviewPoll(deps = {}) {
  const { store, api } = deps;
  if (!store || typeof store.dispatch !== 'function') {
    throw new TypeError('createPreviewPoll requires a store with dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createPreviewPoll requires an api client with request');
  }

  const controller = deps.controller ?? createPreviewController({ store, api });
  const setIntervalImpl =
    deps.setIntervalImpl ?? (typeof globalThis !== 'undefined' ? globalThis.setInterval : undefined);
  const clearIntervalImpl =
    deps.clearIntervalImpl ??
    (typeof globalThis !== 'undefined' ? globalThis.clearInterval : undefined);
  const intervalMs = typeof deps.intervalMs === 'number' ? deps.intervalMs : POLL_INTERVAL_MS;

  let projectId = null;
  let timer = null;

  /**
   * Run a single poll: GET /preview?projectId=…, then reconcile.
   *   - ok + NON-LIVE served handle  -> apply a failure indication (source:poll).
   *   - ok + live/benign served handle -> apply the projected status (keeps the
   *     mirrored preview honest; a poll seeing a live preview is not a failure).
   *   - timeout / any non-ok result   -> INERT: retain the last status (Req 4.9).
   * Returns a small result describing the decision (for tests/logging).
   *
   * @returns {Promise<{ acted: boolean, reason: string, result?: object }>}
   */
  async function pollOnce() {
    if (typeof projectId !== 'string' || projectId === '') {
      return { acted: false, reason: 'no-session' };
    }
    const result = await api.request(
      'GET',
      `/preview?projectId=${encodeURIComponent(projectId)}`,
      { timeoutMs: POLL_TIMEOUT_MS },
    );

    // Req 4.9: a timeout or any non-success result is INERT — retain the last
    // known status and continue on the next interval. No store mutation.
    if (!result || result.kind !== RESULT.OK) {
      return { acted: false, reason: result ? result.kind : 'error' };
    }

    // The GET /preview success body is `{ preview: served }`.
    const served = result.data && typeof result.data === 'object' ? result.data.preview : null;
    if (!served || typeof served !== 'object') {
      // A malformed/empty success body is treated as inert too — do not regress
      // a good preview on an unexpected shape.
      return { acted: false, reason: 'no-preview-field' };
    }

    // Req 4.8: a non-live served handle drives a failure indication; a live or
    // benign handle just keeps the mirrored status honest. Either way the
    // projection is tagged source:'poll' by applyServed.
    const projected = controller.applyServed(served);
    return {
      acted: true,
      reason: isNonLiveServed(served) ? 'non-live' : 'live',
      result: projected,
    };
  }

  /** Start polling for a session (Req 4.7). Idempotent per projectId. */
  function start(id) {
    projectId = typeof id === 'string' ? id : null;
    stop();
    if (!projectId || !setIntervalImpl) return;
    timer = setIntervalImpl(() => {
      // Fire-and-forget; a rejected poll must never throw out of the timer.
      void pollOnce().catch(() => {});
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** Stop polling (session close). */
  function stop() {
    if (timer != null && clearIntervalImpl) clearIntervalImpl(timer);
    timer = null;
  }

  function isRunning() {
    return timer != null;
  }

  return { start, stop, pollOnce, isRunning };
}
