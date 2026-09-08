/*
 * auth.js — the browser OIDC login controller
 * (spec Task 8.2; design §"Controllers — auth.js", Req 6.1, 6.4, 6.5, 6.6,
 *  6.7, 6.8, 6.9).
 *
 * This controller drives the browser half of the backend's OIDC Login_Flow and
 * owns the Token_Store lifecycle. The backend contracts it consumes are FIXED
 * (read from src/server/builder-server.js + src/auth/login-flow.js):
 *
 *   GET /auth/login      → 302 to the identity provider. The browser NAVIGATES
 *                          there; the CSRF `state` is bound to a cookie the
 *                          server sets on that redirect. There is NO PKCE — the
 *                          client sends no `code_verifier` (Req 6.8).
 *   GET /auth/callback    → after the IdP round-trip the browser returns here.
 *                          The server responds:
 *                            200 { token, accountId, expiresAt, tokenType:'Bearer' }  (success)
 *                            401 { error:'access denied' }                            (IdP / gated denial)
 *                            400 { error, code }                                       (client-side protocol fault)
 *                          api.js classifies these into ApiResult kinds:
 *                            200 → { kind:'ok', data:{ token, accountId, expiresAt, tokenType } }
 *                            401 → { kind:'denied' }            (body discarded — Req 16.1)
 *                            400 → { kind:'protocol', code, message }  (code for control only)
 *
 * WHAT THIS CONTROLLER DOES with each callback outcome:
 *   - ok + VALID payload   → Token_Store.set() atomically stores exactly
 *                            { token, accountId, expiresAt } (Req 6.2); dispatch
 *                            TOKEN_SET so store.auth.hasToken mirrors login
 *                            state; arm the expiry timer; return to the builder.
 *   - ok + INVALID payload → discard (Token_Store.set returns false), show the
 *                            GENERIC login-failed notice, return to the login
 *                            control (Req 6.3). Nothing is written.
 *   - denied (401)         → generic login-failed notice, return to login, NO
 *                            value written to the Token_Store (Req 6.5).
 *   - protocol (400 code)  → generic login-failed notice that EXCLUDES the raw
 *                            `code` value, PLUS a control that restarts the
 *                            Login_Flow (Req 6.6).
 *
 * TOKEN CLEARING (Req 6.7, 6.9). Three triggers each fully empty the
 * Token_Store, dispatch TOKEN_CLEARED, and return the user to the login control
 * within 1s:
 *   - the stored expiresAt being reached (an armed timer, or an on-demand
 *     expiry check),
 *   - any gated request returning an Access_Denied_Response (wired via the
 *     api.js `onAccessDenied` seam), and
 *   - the user activating logout.
 *
 * AUTO-ATTACH (Req 6.4). The Token_Store's `getToken` is the SEAM api.js and
 * sse.js already read to attach `Authorization: Bearer <token>` to every gated
 * request and the `/events` connect. app.js (Task 8.2 wiring) passes THIS
 * store's `getToken` into createApiClient/createSseClient, so once a token is
 * held every gated call and the SSE connect carry the Bearer automatically.
 *
 * DOM-FREE / INJECTABLE. The controller owns no DOM. `navigate` (the browser
 * redirect), the `store`, the gated `api` client, the `tokenStore`, the clock
 * `now`, and the timer functions are all INJECTED, so the login navigation, the
 * callback branches, the expiry timer, and the clear-and-return flow all run
 * deterministically under `node --test` with a fake navigate + fake clock, no
 * browser. The login view (a later view module) calls `login()` / `logout()` /
 * `restart()` and reads `store.auth.hasToken` to choose the login control vs.
 * the gated surfaces.
 */

import { ACTIONS } from './store.js';
import { RESULT } from './api.js';

/** The backend login endpoints (same-origin paths). */
export const LOGIN_PATH = '/auth/login';
export const CALLBACK_PATH = '/auth/callback';

/**
 * Client-authored, non-disclosing notice text. These are the ONLY strings the
 * controller shows on a failed login; none carries a backend `code`, a 401 body
 * field, or any account/Project detail (Req 6.5, 6.6, 16.1). Exported so the
 * view and tests reference the same text.
 */
export const AUTH_MESSAGES = Object.freeze({
  // A single GENERIC login-failed message for EVERY failure branch (denial,
  // invalid payload, protocol fault). Deliberately identical across branches so
  // it discloses nothing about which branch occurred.
  LOGIN_FAILED: 'Login failed. Please try signing in again.',
  // The re-auth notice shown when a held session is cleared (expiry / gated
  // 401). Same non-disclosing posture.
  SESSION_ENDED: 'Your session has ended. Please sign in again.',
});

/** How close to `expiresAt` (ms) an armed expiry timer must fire — well under the 1s ceiling (Req 6.7). */
export const EXPIRY_CLEAR_WITHIN_MS = 1_000;

/**
 * Create the auth controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function, subscribe?: Function }} deps.store
 *   the REAL observable store (createStore()).
 * @param {{ request: Function, onAccessDenied: Function }} deps.api
 *   the REAL gated api client (createApiClient()). Its `onAccessDenied` seam is
 *   registered here so ANY gated 401 clears the token and returns to login.
 * @param {object} deps.tokenStore
 *   the REAL Token_Store (createTokenStore()).
 * @param {(url: string) => void} [deps.navigate]
 *   the browser navigation seam (defaults to a same-origin location assign in a
 *   browser; a no-op elsewhere). Called synchronously by `login()`/`restart()`
 *   so the navigation happens within 500ms of activation (Req 6.1).
 * @param {() => number} [deps.now]  ms clock (defaults to Date.now).
 * @param {(cb: Function, ms: number) => any} [deps.setTimeoutImpl]  injectable timer.
 * @param {(id: any) => void} [deps.clearTimeoutImpl]  injectable timer clear.
 * @returns {{
 *   login: () => void,
 *   restart: () => void,
 *   logout: () => void,
 *   handleCallback: (result: object) => { ok: boolean, reason?: string },
 *   completeLoginFromQuery: (query: string) => Promise<{ ok: boolean, reason?: string }>,
 *   checkExpiry: () => boolean,
 *   isLoggedIn: () => boolean,
 *   dispose: () => void,
 * }}
 */
export function createAuthController({
  store,
  api,
  tokenStore,
  navigate,
  now = () => Date.now(),
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createAuthController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createAuthController requires an api client with request()');
  }
  if (!tokenStore || typeof tokenStore.set !== 'function' || typeof tokenStore.clear !== 'function') {
    throw new TypeError('createAuthController requires a tokenStore with set()/clear()');
  }

  const navigateTo =
    typeof navigate === 'function'
      ? navigate
      : (url) => {
          // Default browser navigation: a same-origin assign. A no-op outside a
          // browser so importing this module under node --test never crashes.
          if (typeof globalThis !== 'undefined' && globalThis.location && typeof globalThis.location.assign === 'function') {
            globalThis.location.assign(url);
          }
        };
  const clock = typeof now === 'function' ? now : () => Date.now();
  const setTimer =
    setTimeoutImpl ?? (typeof globalThis !== 'undefined' ? globalThis.setTimeout : undefined);
  const clearTimer =
    clearTimeoutImpl ?? (typeof globalThis !== 'undefined' ? globalThis.clearTimeout : undefined);

  /** The armed expiry timer handle, or null. */
  let expiryTimer = null;

  // Register the gated-401 clearing seam (Req 6.7). api.js fires this exactly
  // once per gated Access_Denied_Response; we clear-and-return-to-login. Keep
  // the unsubscribe so dispose() can detach in a test.
  const unsubscribeAccessDenied =
    typeof api.onAccessDenied === 'function'
      ? api.onAccessDenied(() => clearAndReturnToLogin(AUTH_MESSAGES.SESSION_ENDED))
      : () => {};

  /** Cancel any armed expiry timer. */
  function disarmExpiry() {
    if (expiryTimer != null && typeof clearTimer === 'function') clearTimer(expiryTimer);
    expiryTimer = null;
  }

  /**
   * Arm a timer to clear the token at its expiresAt (Req 6.7). Fires slightly
   * before/at the boundary so the clear-and-return completes within 1s of the
   * expiry being reached. If the timer source is absent (degenerate test), the
   * on-demand `checkExpiry()` is the fallback.
   */
  function armExpiry(expiresAtIso) {
    disarmExpiry();
    const ms = Date.parse(expiresAtIso);
    if (!Number.isFinite(ms) || typeof setTimer !== 'function') return;
    const delay = Math.max(0, ms - clock());
    expiryTimer = setTimer(() => {
      expiryTimer = null;
      // Only clear if the record is genuinely at/after expiry now.
      if (!tokenStore.isValid(clock())) {
        clearAndReturnToLogin(AUTH_MESSAGES.SESSION_ENDED);
      }
    }, delay);
    if (expiryTimer && typeof expiryTimer.unref === 'function') expiryTimer.unref();
  }

  /**
   * Clear the Token_Store fully, mirror the cleared state into the store, and
   * return the user to the login control — the single clearing path all three
   * triggers (expiry / gated 401 / logout) funnel through (Req 6.7, 6.9). Idempotent.
   *
   * @param {string} message  the non-disclosing notice to show at the login control.
   */
  function clearAndReturnToLogin(message) {
    disarmExpiry();
    tokenStore.clear(); // atomic: drops in-memory + sessionStorage (Req 6.7/6.9, 16.3)
    store.dispatch({ type: ACTIONS.TOKEN_CLEARED });
    // Any open session is torn down by the view layer reacting to hasToken:false;
    // we surface a generic notice so the login control explains the return.
    store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message });
  }

  /**
   * Begin the Login_Flow (Req 6.1). Navigates the browser to GET /auth/login
   * SYNCHRONOUSLY, so the navigation happens well within the 500ms budget of the
   * user activating the control. Sends NO PKCE `code_verifier` and no query
   * parameters of its own — the backend mints the cookie-bound `state` (Req 6.8).
   */
  function login() {
    navigateTo(LOGIN_PATH);
  }

  /**
   * Restart the Login_Flow after a protocol fault (Req 6.6). Same as `login()` —
   * a fresh GET /auth/login mints a new cookie-bound state. Exposed under its own
   * name so the restart control the 400-branch offers is unambiguous.
   */
  function restart() {
    navigateTo(LOGIN_PATH);
  }

  /**
   * Log out (Req 6.9). Clears the Token_Store and returns to the login control
   * within 1s. No network call is needed — the client-side session is the token.
   */
  function logout() {
    clearAndReturnToLogin(AUTH_MESSAGES.SESSION_ENDED);
  }

  /**
   * Apply an /auth/callback ApiResult (from api.js) to the Token_Store + store.
   * This is the PURE decision core (given an already-classified result), so the
   * property tests drive every branch without a live server.
   *
   * @param {{ kind: string, data?: object, code?: string }} result  api.js ApiResult for GET /auth/callback
   * @returns {{ ok: boolean, reason?: string, restart?: boolean }}
   */
  function handleCallback(result) {
    const kind = result && result.kind;

    if (kind === RESULT.OK) {
      // 200: the backend returned { token, accountId, expiresAt, tokenType }.
      // Token_Store.set VALIDATES (non-empty token/accountId, future ISO-8601
      // expiresAt) and stores ATOMICALLY, copying ONLY the three fields (Req
      // 6.2, 6.3). A missing/invalid field → set returns false → discard.
      const data = result.data ?? {};
      const stored = tokenStore.set({
        token: data.token,
        accountId: data.accountId,
        expiresAt: data.expiresAt,
      });
      if (!stored) {
        // Invalid payload (Req 6.3): nothing written, generic notice, back to login.
        clearNoticeToLoginFailed();
        return { ok: false, reason: 'invalidPayload' };
      }
      // Success: mirror token presence into the store so gated views unlock, arm
      // the expiry timer, and clear any prior login notice.
      store.dispatch({ type: ACTIONS.TOKEN_SET, accountId: tokenStore.getAccountId() });
      store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
      armExpiry(tokenStore.getExpiresAt());
      return { ok: true };
    }

    if (kind === RESULT.DENIED) {
      // 401 IdP/gated denial (Req 6.5): generic notice, return to login, write
      // NOTHING. api.js already discarded the 401 body.
      ensureNoToken();
      clearNoticeToLoginFailed();
      return { ok: false, reason: 'denied' };
    }

    if (kind === RESULT.PROTOCOL) {
      // 400 with a login-protocol `code` (Req 6.6): a GENERIC message that
      // EXCLUDES the raw code, PLUS a restart control. We never interpolate
      // result.code into the shown message; it is control-flow only.
      ensureNoToken();
      clearNoticeToLoginFailed(/* offerRestart */ true);
      return { ok: false, reason: 'protocol', restart: true };
    }

    // Any other outcome (validation without code / timeout / error): treat as a
    // generic login failure with a restart offer — still non-disclosing.
    ensureNoToken();
    clearNoticeToLoginFailed(true);
    return { ok: false, reason: 'error', restart: true };
  }

  /**
   * Drive the callback end-to-end: issue GET /auth/callback (UNGATED — the
   * client has no token yet, and this is how it obtains one) carrying the IdP's
   * `code`+`state` query string, then apply the classified result. The
   * cookie-bound `state` travels automatically as a same-origin cookie; the
   * client adds NO PKCE verifier (Req 6.8).
   *
   * @param {string} query  the callback query string (e.g. '?code=…&state=…' or 'code=…&state=…')
   * @returns {Promise<{ ok: boolean, reason?: string, restart?: boolean }>}
   */
  async function completeLoginFromQuery(query) {
    const qs = typeof query === 'string' ? (query.startsWith('?') ? query : query ? `?${query}` : '') : '';
    // UNGATED: no Bearer to attach yet; the response is how we get one. api.js
    // still classifies 200/401/400 into ok/denied/protocol for handleCallback.
    const result = await api.request('GET', `${CALLBACK_PATH}${qs}`, { gated: false });
    return handleCallback(result);
  }

  /**
   * On-demand expiry check (Req 6.7). If a record is held but no longer valid at
   * `now`, clear it and return to login. Returns true iff it cleared. This is the
   * fallback for environments without a timer and a guard the view can call on
   * focus/visibility.
   */
  function checkExpiry() {
    if (tokenStore.hasToken() && !tokenStore.isValid(clock())) {
      clearAndReturnToLogin(AUTH_MESSAGES.SESSION_ENDED);
      return true;
    }
    return false;
  }

  /** Whether a valid (unexpired) token is currently held. */
  function isLoggedIn() {
    return tokenStore.isValid(clock());
  }

  /** Detach the api.js access-denied listener and cancel the expiry timer. */
  function dispose() {
    disarmExpiry();
    unsubscribeAccessDenied();
  }

  // ---- small internal helpers ----

  /** Belt-and-braces: a denial/fault must leave NO token behind (Req 6.5). */
  function ensureNoToken() {
    if (tokenStore.hasToken()) {
      tokenStore.clear();
      store.dispatch({ type: ACTIONS.TOKEN_CLEARED });
    }
  }

  /** Set the generic login-failed notice (optionally flagged to offer restart). */
  function clearNoticeToLoginFailed(offerRestart = false) {
    store.dispatch({
      type: ACTIONS.NOTICE_SET,
      kind: 'loginFailed',
      message: AUTH_MESSAGES.LOGIN_FAILED,
      // The view reads `offerRestart` to render a restart control (Req 6.6). It
      // rides on the notice as a boolean flag, never the backend code.
      offerRestart: offerRestart === true,
    });
  }

  return {
    login,
    restart,
    logout,
    handleCallback,
    completeLoginFromQuery,
    checkExpiry,
    isLoggedIn,
    dispose,
  };
}
