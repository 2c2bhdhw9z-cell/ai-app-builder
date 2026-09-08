/*
 * api.js — the gated API client with central error classification
 * (spec Task 2.2; design §"Transport layer" / §"Error Handling",
 *  Req 2.6, 2.7, 2.8, 6.4, 7.4, 7.5, 9.6, 9.7, 16.1).
 *
 * This is one of only three modules that touch the network (api / sse /
 * preview-poll). It wraps `fetch`, attaches the Bearer token to gated calls,
 * enforces per-call timeouts via AbortController, and — crucially — normalizes
 * EVERY response into ONE small tagged result (an ApiResult) so error policy
 * lives in a single place and cannot drift per surface.
 *
 * Design decisions honored here:
 *   - Non-disclosing 401: a 401 body is DISCARDED and never surfaced; the
 *     result is a bare `{ kind: 'denied' }` carrying nothing from the body
 *     (Req 16.1, 2.7). A 401 also fires a single `onAccessDenied` hook so the
 *     auth controller (Task 8) can clear the token and return to login
 *     (Req 6.7). That hook is a SEAM here — this module implements no auth.
 *   - The Token_Store is a Task-8 module. To keep this testable and to wire it
 *     later without a rewrite, the token is read through an INJECTED
 *     token-getter dependency, not imported. If a call is gated and no token is
 *     held, we resolve `{ kind: 'denied' }` WITHOUT a network call (Req 6.4).
 *   - Timeouts map to `{ kind: 'timeout' }` (Req 2.6, 4.9, 9.7); the classifier
 *     is a pure function of (status, body) so property tests drive it directly.
 *
 * DOM-free and dependency-free: no browser global is imported at module load
 * (fetch/AbortController are injected or read lazily), so the pure classifier
 * and the client factory import cleanly under `node --test`, and no runtime
 * dependency is added to the package.
 */

/** Default per-call timeouts by intent (ms). `/message` is slow; polls fast. */
export const DEFAULT_TIMEOUTS = Object.freeze({
  message: 30_000, // POST /message (Req 2.6)
  preview: 5_000, // GET /preview poll (Req 4.9)
  theme: 5_000, // POST/GET /theme (Req 9.7)
  default: 30_000,
});

/**
 * The closed set of ApiResult kinds. Every network outcome collapses to one of
 * these so per-surface code never re-derives error policy.
 * @type {Readonly<Record<string,string>>}
 */
export const RESULT = Object.freeze({
  OK: 'ok',
  DENIED: 'denied',
  RATE_LIMITED: 'rateLimited',
  VALIDATION: 'validation',
  PROTOCOL: 'protocol',
  TIMEOUT: 'timeout',
  ERROR: 'error',
});

/**
 * Pure classifier: map an HTTP status + parsed body into a tagged ApiResult.
 * This is the heart of the non-disclosing error posture and is exported so the
 * property tests exercise the REAL mapping (not a stand-in). It performs NO
 * I/O.
 *
 * Contract (design §"Central classification"):
 *   - 200 / 201 / 202       -> { kind:'ok', status, data }
 *   - 401 (ANY body)        -> { kind:'denied' }              body DISCARDED (Req 16.1, 2.7)
 *   - 429                   -> { kind:'rateLimited', limit, operation?, resource? } (Req 2.8, 7.5)
 *   - 400 with `code`       -> { kind:'protocol', code, message, data }  (Req 6.6)
 *   - 400 otherwise         -> { kind:'validation', code?, message, data } (Req 7.4, 9.6)
 *   - anything else         -> { kind:'error', status }        no raw detail
 *
 * The 401 branch returns a FROZEN, field-free object: there is deliberately no
 * path by which a value from the 401 body reaches the caller. A 400 body, by
 * contrast, is a backend-authored specific message the UI is allowed to show
 * on the surfaces that opt in (e.g. /projects validation, unsupported_theme).
 *
 * @param {number} status  the HTTP status code
 * @param {unknown} body    the parsed response body (object|string|null)
 * @returns {{ kind: string, [k: string]: any }}
 */
export function classify(status, body) {
  // Access denied: single, non-disclosing outcome. The body is intentionally
  // never read — no field, id, path, or existence hint escapes (Req 16.1).
  if (status === 401) {
    return Object.freeze({ kind: RESULT.DENIED });
  }

  if (status === 200 || status === 201 || status === 202) {
    return { kind: RESULT.OK, status, data: body ?? null };
  }

  if (status === 429) {
    // The backend names the exceeded limit as `{ limit, operation? , resource? }`
    // alongside a human `error` string (see builder-server quota responses).
    // We surface the NAMED limit and its operation/resource so the view can
    // display it and retain the user's input (Req 2.8, 7.5).
    const b = isObject(body) ? body : {};
    return {
      kind: RESULT.RATE_LIMITED,
      status,
      limit: typeof b.limit === 'string' ? b.limit : null,
      operation: typeof b.operation === 'string' ? b.operation : undefined,
      resource: typeof b.resource === 'string' ? b.resource : undefined,
      // The backend's human message, safe to show for a named limit.
      message: typeof b.error === 'string' ? b.error : null,
    };
  }

  if (status === 400) {
    const b = isObject(body) ? body : {};
    const code = typeof b.code === 'string' ? b.code : undefined;
    const message = typeof b.message === 'string' ? b.message : typeof b.error === 'string' ? b.error : '';
    // A 400 carrying a login-protocol `code` is a PROTOCOL fault (e.g.
    // /auth/callback). The caller must show a GENERIC message that excludes the
    // raw code (Req 6.6); we tag it distinctly and pass `code` for control flow
    // only — never for display.
    if (code !== undefined) {
      return { kind: RESULT.PROTOCOL, status, code, message, data: body ?? null };
    }
    // Otherwise a validation error whose backend-authored message the surface
    // is allowed to show (Req 7.4, 9.6).
    return { kind: RESULT.VALIDATION, status, code, message, data: body ?? null };
  }

  // Any other non-2xx (or a synthetic status for a network failure) is a
  // generic, non-disclosing error — no raw detail surfaced.
  return { kind: RESULT.ERROR, status };
}

/** Narrow a value to a non-null plain-ish object. */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Create the gated API client.
 *
 * Dependencies are injected so the module is testable and so the real
 * Token_Store (Task 8) can be wired in later without touching this file:
 *   - `getToken()`  -> the current Bearer token string, or null/'' if none.
 *                      (The SEAM for the Token_Store; NOT implemented here.)
 *   - `fetchImpl`   -> a fetch-compatible function (defaults to globalThis.fetch).
 *   - `AbortControllerImpl` -> defaults to globalThis.AbortController.
 *   - `baseUrl`     -> optional origin prefix (default '' = same origin, which
 *                      is all the CSP connect-src 'self' permits anyway).
 *
 * @param {object} [deps]
 * @param {() => (string|null|undefined)} [deps.getToken]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {typeof AbortController} [deps.AbortControllerImpl]
 * @param {string} [deps.baseUrl]
 * @returns {{ request: Function, onAccessDenied: (cb: Function) => (() => void) }}
 */
export function createApiClient(deps = {}) {
  const getToken = typeof deps.getToken === 'function' ? deps.getToken : () => null;
  const fetchImpl =
    deps.fetchImpl ?? (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  const AbortControllerImpl =
    deps.AbortControllerImpl ??
    (typeof globalThis !== 'undefined' ? globalThis.AbortController : undefined);
  const baseUrl = deps.baseUrl ?? '';

  /**
   * onAccessDenied listeners. A 401 fires each exactly once per denied
   * response. The auth controller (Task 8) registers here to clear the token
   * and return to login (Req 6.7). Kept as a set so listeners can unsubscribe.
   * @type {Set<Function>}
   */
  const accessDeniedListeners = new Set();

  function onAccessDenied(cb) {
    if (typeof cb === 'function') accessDeniedListeners.add(cb);
    return () => accessDeniedListeners.delete(cb);
  }

  function fireAccessDenied(context) {
    for (const cb of accessDeniedListeners) {
      try {
        cb(context);
      } catch {
        // A listener throwing must not break request handling or leak detail.
      }
    }
  }

  /**
   * Perform a gated (or ungated) request and resolve to an ApiResult.
   *
   * @param {string} method  HTTP method (GET/POST/…)
   * @param {string} path    same-origin path (e.g. '/message')
   * @param {object} [opts]
   * @param {any} [opts.body]          JSON body (object) for write requests
   * @param {number} [opts.timeoutMs]  per-call timeout; defaults by path intent
   * @param {boolean} [opts.gated=true] attach Bearer; deny-without-network if no token
   * @param {'json'|'blob'|'text'} [opts.expect='json'] how to read a 2xx body
   * @returns {Promise<{ kind: string, [k: string]: any }>}
   */
  async function request(method, path, opts = {}) {
    const { body, gated = true, expect = 'json' } = opts;
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : timeoutFor(path);

    let token = null;
    if (gated) {
      token = getToken();
      // Gated + no token: deny WITHOUT a network call (Req 6.4). This does NOT
      // fire onAccessDenied — there is no server denial, just a missing token;
      // the login gate handles presenting the login control.
      if (!token) {
        return Object.freeze({ kind: RESULT.DENIED });
      }
    }

    const headers = { accept: 'application/json' };
    if (gated && token) headers.authorization = `Bearer ${token}`;
    let bodyInit;
    if (body !== undefined && body !== null) {
      headers['content-type'] = 'application/json';
      bodyInit = JSON.stringify(body);
    }

    const controller = AbortControllerImpl ? new AbortControllerImpl() : undefined;
    let timedOut = false;
    let timer;
    if (controller && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      // Do not keep the Node event loop alive for a client timer (harmless in a
      // browser; helpful for tests that inject a real timer).
      if (typeof timer?.unref === 'function') timer.unref();
    }

    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: bodyInit,
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      // An AbortController-driven abort is a timeout (Req 2.6, 4.9, 9.7). Any
      // other fetch rejection (network failure) is a generic, non-disclosing
      // error — its message is never surfaced.
      if (timedOut || isAbortError(err)) {
        return { kind: RESULT.TIMEOUT };
      }
      return { kind: RESULT.ERROR };
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status = res.status;

    // A 401 is classified WITHOUT reading the body (it is discarded) and fires
    // the access-denied seam exactly once (Req 16.1, 2.7, 6.7).
    if (status === 401) {
      fireAccessDenied({ path, method });
      return classify(401, null);
    }

    // Parse the body for the classifier. On a 2xx we honor `expect`; on a
    // non-2xx we best-effort read JSON (the classifier only reads recognized,
    // safe fields, and never for 401).
    let parsed = null;
    try {
      if (status >= 200 && status < 300 && expect !== 'json') {
        parsed = expect === 'blob' ? await res.blob() : await res.text();
        return { kind: RESULT.OK, status, data: parsed };
      }
      parsed = await safeJson(res);
    } catch {
      parsed = null;
    }

    return classify(status, parsed);
  }

  /** Choose a default timeout from the request path's intent. */
  function timeoutFor(path) {
    if (typeof path !== 'string') return DEFAULT_TIMEOUTS.default;
    if (path.startsWith('/message')) return DEFAULT_TIMEOUTS.message;
    if (path.startsWith('/preview')) return DEFAULT_TIMEOUTS.preview;
    if (path.startsWith('/theme')) return DEFAULT_TIMEOUTS.theme;
    return DEFAULT_TIMEOUTS.default;
  }

  return { request, onAccessDenied };
}

/** True for a DOMException/AbortError-shaped rejection from an aborted fetch. */
function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20 || err.code === 'ABORT_ERR');
}

/** Read a JSON body, tolerating an empty/invalid body by returning null. */
async function safeJson(res) {
  if (typeof res.json !== 'function') return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}
