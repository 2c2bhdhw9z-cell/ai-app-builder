/*
 * token-store.js — the Web UI's client-side Bearer_Token holder
 * (spec Task 8.1; design §"Data Models — Token_Store", Req 6.2, 6.3, 16.3).
 *
 * The Token_Store holds the `{ token, accountId, expiresAt }` record the
 * backend login flow mints (`/auth/callback` → `{ token, accountId, expiresAt,
 * tokenType:'Bearer' }`). Every gated API request and the `/events` SSE connect
 * read the current token from here through the SAME injected `getToken` seam
 * api.js and sse.js already expose (Task 8.2 wires it in). This module is the
 * ONE place the secret lives; the store.js state only mirrors token PRESENCE.
 *
 * THREE invariants this module enforces, each a requirement:
 *
 *   1. ATOMIC WRITE (Req 6.2). `set()` writes all three fields as a single
 *      indivisible record or writes NOTHING. There is deliberately no code path
 *      that leaves the record partially present (e.g. a token with no
 *      expiresAt). Internally the record is a single frozen object assigned in
 *      one statement; a rejected payload never touches the held record at all.
 *
 *   2. VALIDATE-BEFORE-WRITE (Req 6.3). `set()` validates the payload BEFORE it
 *      mutates anything: `token` and `accountId` must be non-empty strings, and
 *      `expiresAt` must be a valid ISO-8601 timestamp strictly in the FUTURE
 *      relative to the injected clock. An invalid payload is discarded and the
 *      previously held record (if any) is left untouched — `set()` returns
 *      `false` so the caller (auth.js) can show the generic login-failed notice
 *      and return to the login control.
 *
 *   3. NO CROSS-ORIGIN-READABLE SINK (Req 16.3). The token is NEVER written to
 *      `document.cookie` (readable by the server and by any script on the
 *      origin, and attached to every same-origin request) nor to any other sink
 *      a different origin could read. The PRIMARY store is an in-memory,
 *      module-scoped variable — same-origin JS can read it, no other origin can.
 *      An OPTIONAL `sessionStorage` backend gives continuity across reloads;
 *      `sessionStorage` is origin-scoped by the browser's same-origin policy and
 *      cleared when the tab closes, so it satisfies Req 16.3 while surviving a
 *      refresh. `localStorage` shared across subdomains and cookies are
 *      explicitly rejected — the storage backend is INJECTED and this module
 *      never references `document.cookie`.
 *
 * TESTABILITY. The clock (`now`) and the persistence backend (`storage`) are
 * INJECTED (defaulting to `Date.now` and, in a browser, `sessionStorage`), so
 * the whole store — atomic write, future-expiry validation, and clear — runs
 * deterministically under `node --test` with a fake clock and an in-memory
 * storage double, without a browser. It is DOM-free and dependency-free, adds
 * no runtime dependency, and touches `plumby` not at all.
 */

/** The sessionStorage key under which the record is persisted (when a backend is present). */
export const STORAGE_KEY = 'aab_token_record';

/**
 * Validate a would-be TokenRecord payload against Req 6.3, using the given
 * clock. Exported and PURE so the property test (Task 8.3) drives the REAL
 * validator across missing fields and past/invalid expiresAt values.
 *
 * A payload is valid iff ALL hold:
 *   - `token`      is a non-empty string (after no trimming — a token is opaque)
 *   - `accountId`  is a non-empty string
 *   - `expiresAt`  is a string that parses as a valid ISO-8601 timestamp AND is
 *                  strictly in the FUTURE relative to `now()`.
 *
 * @param {unknown} payload  the candidate record (anything the caller holds)
 * @param {() => number} now  the ms clock (Date.now-compatible)
 * @returns {boolean}  true iff the payload is a storable TokenRecord
 */
export function isValidRecord(payload, now = Date.now) {
  if (!payload || typeof payload !== 'object') return false;
  const { token, accountId, expiresAt } = payload;
  if (typeof token !== 'string' || token === '') return false;
  if (typeof accountId !== 'string' || accountId === '') return false;
  if (typeof expiresAt !== 'string' || expiresAt === '') return false;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false; // not a valid timestamp at all
  const current = typeof now === 'function' ? now() : Date.now();
  // Strictly future: an already-elapsed expiry is not storable (Req 6.3). A
  // record whose expiresAt equals `now` is treated as already expired.
  return ms > current;
}

/**
 * Create a Token_Store.
 *
 * @param {object} [deps]
 * @param {() => number} [deps.now]  injectable ms clock (defaults to Date.now).
 * @param {Storage|null} [deps.storage]  optional persistence backend with
 *   `getItem`/`setItem`/`removeItem` (defaults to the browser's `sessionStorage`
 *   when present, else null = in-memory only). NEVER `document.cookie` and never
 *   `localStorage`; the caller chooses an origin-scoped, tab-scoped backend
 *   (Req 16.3). A backend that throws (e.g. storage disabled) degrades to
 *   in-memory-only without losing the token.
 * @returns {{
 *   set: (payload: object) => boolean,
 *   clear: () => void,
 *   getToken: () => (string|null),
 *   getAccountId: () => (string|null),
 *   getExpiresAt: () => (string|null),
 *   hasToken: () => boolean,
 *   isValid: (now?: number) => boolean,
 *   getRecord: () => (object|null),
 * }}
 */
export function createTokenStore(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  // Default to sessionStorage in a browser; null (in-memory only) elsewhere or
  // when explicitly disabled by passing `storage: null`.
  const storage =
    deps.storage !== undefined
      ? deps.storage
      : typeof globalThis !== 'undefined' && globalThis.sessionStorage
        ? globalThis.sessionStorage
        : null;

  /**
   * The single held record, or null. This is the PRIMARY in-memory store
   * (module/closure-scoped): same-origin JS can read it, no other origin can
   * (Req 16.3). It is only ever assigned as ONE complete frozen object or set
   * to null — never partially populated (Req 6.2).
   * @type {Readonly<{token:string, accountId:string, expiresAt:string}>|null}
   */
  let record = null;

  // Rehydrate from the optional origin-scoped backend on construction so a page
  // reload within the same tab keeps the session (Req 16.3 continuity). A
  // persisted-but-now-expired or malformed value is dropped, not resurrected.
  hydrateFromStorage();

  function hydrateFromStorage() {
    if (!storage || typeof storage.getItem !== 'function') return;
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      return; // storage unavailable → in-memory only
    }
    if (typeof raw !== 'string' || raw === '') return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      removeFromStorage();
      return;
    }
    // Only accept a still-valid, future record. A stale persisted record is
    // discarded (and removed) rather than loaded expired.
    if (isValidRecord(parsed, now)) {
      record = freezeRecord(parsed);
    } else {
      removeFromStorage();
    }
  }

  function persistToStorage() {
    if (!storage || typeof storage.setItem !== 'function' || !record) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(record));
    } catch {
      // Persistence is best-effort continuity only; the in-memory record
      // remains authoritative if the backend refuses the write.
    }
  }

  function removeFromStorage() {
    if (!storage || typeof storage.removeItem !== 'function') return;
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  /**
   * Atomically store a validated TokenRecord (Req 6.2, 6.3).
   *
   * Validation runs FIRST; only a fully valid payload is written, and it is
   * written as ONE frozen object holding exactly the three fields (any extra
   * fields the callback carried — e.g. `tokenType` — are intentionally NOT
   * copied into the record). An invalid payload leaves the held record
   * untouched and returns false.
   *
   * @param {object} payload  `{ token, accountId, expiresAt }` (extra keys ignored)
   * @returns {boolean}  true iff the record was written
   */
  function set(payload) {
    if (!isValidRecord(payload, now)) {
      // Discard without writing (Req 6.3). The prior record (if any) is
      // deliberately left intact — a bad callback does not evict a good session.
      return false;
    }
    // Build the complete record, then assign in a SINGLE statement so it is
    // never observably partial (Req 6.2). Only the three fields are copied.
    record = freezeRecord({
      token: payload.token,
      accountId: payload.accountId,
      expiresAt: payload.expiresAt,
    });
    persistToStorage();
    return true;
  }

  /**
   * Atomically clear the record (Req 6.7, 6.9). Drops the in-memory record AND
   * removes it from the optional backend in one call, so no field survives in
   * either sink.
   */
  function clear() {
    record = null;
    removeFromStorage();
  }

  /** The current Bearer token string, or null when none is held. */
  function getToken() {
    return record ? record.token : null;
  }

  /** The current accountId, or null when none is held. */
  function getAccountId() {
    return record ? record.accountId : null;
  }

  /** The current expiresAt ISO-8601 string, or null when none is held. */
  function getExpiresAt() {
    return record ? record.expiresAt : null;
  }

  /** Whether ANY record is currently held (regardless of freshness). */
  function hasToken() {
    return record !== null;
  }

  /**
   * Whether the currently held record is present AND not yet expired at the
   * given time (defaults to the injected clock). A store holding no record, or
   * one whose expiresAt has been reached, is NOT valid (Req 6.7 expiry).
   *
   * @param {number} [atMs]  the time to check against (defaults to now())
   * @returns {boolean}
   */
  function isValid(atMs) {
    if (!record) return false;
    const current = typeof atMs === 'number' ? atMs : now();
    const ms = Date.parse(record.expiresAt);
    return Number.isFinite(ms) && ms > current;
  }

  /**
   * The full held record as a plain copy, or null. A copy (not the frozen
   * internal reference) so a caller cannot mutate the store's state, and so
   * tests can assert the exact stored shape.
   */
  function getRecord() {
    return record ? { token: record.token, accountId: record.accountId, expiresAt: record.expiresAt } : null;
  }

  return { set, clear, getToken, getAccountId, getExpiresAt, hasToken, isValid, getRecord };
}

/** Freeze a plain 3-field record so the held reference is immutable. */
function freezeRecord(r) {
  return Object.freeze({ token: r.token, accountId: r.accountId, expiresAt: r.expiresAt });
}
