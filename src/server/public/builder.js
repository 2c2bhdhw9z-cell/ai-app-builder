/*
 * builder.js — prompt validation + the core-builder submit controller
 * (spec Task 3.1; design §"Controllers — builder.js", Req 2.2–2.8).
 *
 * This is the feature logic that turns a user's prompt-submit intent into a
 * `POST /message` call, driving the running-turn indicator through the store
 * and mapping every transport outcome (ok / timeout / denied / rateLimited /
 * error) onto a store action + a non-disclosing user notice. It owns NO DOM:
 * the prompt view (Task 3.2) reads the store slices this controller mutates and
 * calls back into `submit()`. Both collaborators — the store and the api
 * client — are INJECTED, so the whole controller is exercised under
 * `node --test` with the REAL store reducer and the REAL api client (driven by
 * an injected fetch), never a stand-in double.
 *
 * Why the validation lives here as a pure, exported function:
 *   - Req 2.2/2.3/2.4 are a single trim-based gate (submit iff the trimmed
 *     length is in 1..10,000). Factoring it out (`validatePrompt`) lets the
 *     property test (Task 3.3) drive the REAL gate across Unicode whitespace
 *     and the exact boundary lengths (0, 1, 10000, 10001), and lets the view
 *     reuse the identical rule for its disabled/enabled affordance.
 *
 * Why the concurrency gate is enforced in TWO places:
 *   - The store's SUBMIT_STARTED reducer already refuses to represent two
 *     concurrent in-flight turns (a second dispatch is a no-op while
 *     submitInFlight is true). This controller ALSO checks submitInFlight
 *     BEFORE issuing the network call, so a second concurrent submit makes ZERO
 *     additional `POST /message` calls for the session (Req 2.5). The store is
 *     the source of truth; the controller's pre-check is what prevents the
 *     wasted request.
 *
 * The 30s timeout itself is enforced inside api.js (AbortController); this
 * controller reacts to the resulting `{ kind: 'timeout' }` by ending the
 * in-flight turn, re-enabling submit, RETAINING the prompt text, and setting a
 * timeout notice (Req 2.6). A 401 maps to a re-auth notice with NO project
 * detail (Req 2.7); a 429 sets a named-limit notice and keeps the text for
 * retry (Req 2.8).
 */

import { ACTIONS, selectSubmitInFlight } from './store.js';
import { RESULT } from './api.js';

/** The inclusive trimmed-length bounds for a submittable prompt (Req 2.1–2.4). */
export const PROMPT_MIN = 1;
export const PROMPT_MAX = 10_000;

/**
 * The closed set of rejection reasons `validatePrompt` can return, so the view
 * and the tests branch on a stable name rather than a message string.
 * @type {Readonly<Record<string,string>>}
 */
export const REJECT = Object.freeze({
  EMPTY: 'empty', // trims to length 0 (incl. all-whitespace) — Req 2.3
  TOO_LONG: 'tooLong', // trims to length > 10,000 — Req 2.4
});

/**
 * Client-authored, non-disclosing notice messages. These are the ONLY strings
 * the controller shows the user; none carries backend body detail (Req 2.7,
 * 16.1). Exported so the view and tests reference the same text.
 */
export const MESSAGES = Object.freeze({
  EMPTY: 'Enter a prompt to continue.',
  TOO_LONG: `Prompt exceeds the ${PROMPT_MAX.toLocaleString('en-US')}-character maximum.`,
  TIMEOUT: 'The request timed out. Your prompt was kept — try again.',
  REAUTH: 'Your session expired. Please sign in again.',
  RATE_LIMITED: 'A usage limit was reached.',
  ERROR: 'Something went wrong sending your prompt. Please try again.',
});

/**
 * Pure prompt validation (Req 2.2, 2.3, 2.4). Trims leading/trailing whitespace
 * with the language's own Unicode-aware `String.prototype.trim` (so every
 * Unicode whitespace code point the runtime recognizes is stripped — matching
 * the backend's own trim semantics), then gates on the trimmed LENGTH.
 *
 * Length is measured in UTF-16 code units (`String.prototype.length`) — the
 * same unit the requirement's "1 to 10,000 characters" and the textarea's
 * maxlength use — so the gate and the input affordance agree exactly.
 *
 * @param {unknown} raw  the raw prompt text (anything the view holds)
 * @returns {{ ok: true, text: string }
 *          | { ok: false, reason: 'empty'|'tooLong', text: string }}
 *   On success, `text` is the TRIMMED text to send. On rejection, `text` is the
 *   trimmed text too (the caller retains the ORIGINAL entered text in the input
 *   regardless; this field is informational).
 */
export function validatePrompt(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  const len = trimmed.length;
  if (len < PROMPT_MIN) {
    return { ok: false, reason: REJECT.EMPTY, text: trimmed };
  }
  if (len > PROMPT_MAX) {
    return { ok: false, reason: REJECT.TOO_LONG, text: trimmed };
  }
  return { ok: true, text: trimmed };
}

/**
 * Create the builder submit controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function, subscribe?: Function }} deps.store
 *   the REAL observable store (createStore()).
 * @param {{ request: Function }} deps.api
 *   the REAL gated api client (createApiClient()).
 * @returns {{
 *   validate: typeof validatePrompt,
 *   canSubmit: () => boolean,
 *   submit: (rawText: string) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 * }}
 */
export function createBuilderController({ store, api }) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createBuilderController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createBuilderController requires an api client with request()');
  }

  /** Whether a submit is admissible right now (no turn in flight). Req 2.5. */
  function canSubmit() {
    return !selectSubmitInFlight(store.getState());
  }

  /**
   * Validate and (if valid and admissible) submit a prompt.
   *
   * Flow:
   *   1. Concurrency gate (Req 2.5): if a turn is already in flight for the
   *      session, make ZERO network calls and return a `busy` rejection. This
   *      is checked BEFORE validation so a rapid second Enter-press during an
   *      in-flight turn cannot even reach the network.
   *   2. Validate (Req 2.2/2.3/2.4): on reject, DO NOT call POST /message,
   *      RETAIN the entered text (the view keeps the original; we also mirror
   *      the raw text into the store so a re-render preserves it), and set the
   *      matching notice.
   *   3. On valid submit: mark the turn in flight (SUBMIT_STARTED with the
   *      TRIMMED text retained for retry), then POST /message with the TRIMMED
   *      text. api.js enforces the 30s timeout internally.
   *   4. Map the transport result to a store action + notice:
   *        ok          -> end turn, clear retained text (Req 2.2 satisfied)
   *        timeout     -> end turn, RETAIN text, timeout notice (Req 2.6)
   *        denied(401) -> end turn, RETAIN text, re-auth notice, NO detail (2.7)
   *        rateLimited -> end turn, RETAIN text, named-limit notice (Req 2.8)
   *        other/error -> end turn, RETAIN text, generic error notice
   *
   * @param {string} rawText  the raw text currently in the prompt input
   * @returns {Promise<{ ok: boolean, reason?: string, result?: object }>}
   */
  async function submit(rawText) {
    // (1) Concurrency gate — no second concurrent submit for this session.
    if (selectSubmitInFlight(store.getState())) {
      return { ok: false, reason: 'busy' };
    }

    // (2) Validation — pure trim-based gate.
    const verdict = validatePrompt(rawText);
    if (!verdict.ok) {
      // Retain the ORIGINAL entered characters (Req 2.3/2.4) and surface the
      // matching, client-authored message. No network call is made.
      store.dispatch({ type: ACTIONS.PROMPT_TEXT_SET, text: typeof rawText === 'string' ? rawText : '' });
      store.dispatch({
        type: ACTIONS.NOTICE_SET,
        kind: 'validation',
        message: verdict.reason === REJECT.TOO_LONG ? MESSAGES.TOO_LONG : MESSAGES.EMPTY,
      });
      return { ok: false, reason: verdict.reason };
    }

    const trimmed = verdict.text;

    // (3) Begin the in-flight turn. SUBMIT_STARTED retains the trimmed text for
    // retry and clears any prior notice. (The store no-ops a duplicate start,
    // but we already guarded above.)
    store.dispatch({ type: ACTIONS.SUBMIT_STARTED, promptText: trimmed });

    // Send the TRIMMED text (never the raw input) — Req 2.2. api.js attaches
    // the Bearer header and enforces the 30s /message timeout internally.
    const result = await api.request('POST', '/message', { body: { text: trimmed } });

    // (4) Map the outcome.
    switch (result.kind) {
      case RESULT.OK:
        // The turn was accepted. End the in-flight state; the live turn
        // progress now arrives over SSE (Task 4). Clear the retained text —
        // the prompt was consumed successfully.
        store.dispatch({ type: ACTIONS.SUBMIT_ENDED, retainText: false });
        store.dispatch({ type: ACTIONS.PROMPT_TEXT_SET, text: '' });
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        return { ok: true, result };

      case RESULT.TIMEOUT:
        // Req 2.6: end in-flight, re-enable submit, RETAIN the prompt text for
        // retry, show a timed-out message.
        store.dispatch({ type: ACTIONS.SUBMIT_ENDED, retainText: true });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'timeout', message: MESSAGES.TIMEOUT });
        return { ok: false, reason: 'timeout', result };

      case RESULT.DENIED:
        // Req 2.7: re-authentication prompt, NO project-specific detail from the
        // response (api.js already discarded the 401 body). Retain the text so a
        // re-authenticated retry keeps the user's work.
        store.dispatch({ type: ACTIONS.SUBMIT_ENDED, retainText: true });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };

      case RESULT.RATE_LIMITED: {
        // Req 2.8: display the NAMED limit and keep the prompt text for retry.
        const named = typeof result.limit === 'string' && result.limit.length > 0 ? result.limit : null;
        store.dispatch({ type: ACTIONS.SUBMIT_ENDED, retainText: true });
        store.dispatch({
          type: ACTIONS.NOTICE_SET,
          kind: 'rateLimited',
          message: MESSAGES.RATE_LIMITED,
          limit: named,
        });
        return { ok: false, reason: 'rateLimited', result };
      }

      default:
        // validation/protocol/error — a generic, non-disclosing error notice.
        // Retain the text so the user can retry without retyping.
        store.dispatch({ type: ACTIONS.SUBMIT_ENDED, retainText: true });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: MESSAGES.ERROR });
        return { ok: false, reason: 'error', result };
    }
  }

  return { validate: validatePrompt, canSubmit, submit };
}
