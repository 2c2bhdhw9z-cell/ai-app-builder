/**
 * login-flow.js — the reachable OAuth 2.0 / OIDC LOGIN round-trip (final wiring pass).
 *
 * THE GAP THIS CLOSES: even with a real IdP verifier wired in, nothing could
 * actually log in. `authService.authenticate()` and `scopeSession()` are
 * IN-PROCESS calls; no HTTP surface reached them. A phone pointed at the deployed
 * server had no way to obtain the `Authorization: Bearer <token>` that every
 * gated route requires. This module is the missing browser-facing round-trip:
 *
 *   1. beginLogin()  -> the IdP authorize URL to redirect the browser to, plus
 *                       the cookie that BINDS that redirect to this browser.
 *   2. completeLogin({ code, state, cookieNonce })
 *                    -> validates the state AND the cookie, then hands the code
 *                       to the EXISTING AuthService (verifier -> User_Account)
 *                       and returns a scoped session token.
 *
 * It ADDS NO AUTH LOGIC. Credential verification, account lookup/creation and
 * token issuance all remain in the existing AuthService/IdentityManager; this is
 * the transport-shaped shell around them, plus the one thing a redirect flow
 * genuinely needs that they do not provide: CSRF protection.
 *
 * WHY THE STATE IS COOKIE-BOUND (and why a server-side set is NOT enough).
 * The attack is login CSRF / session fixation: an attacker starts a login, keeps
 * the resulting `state`, and feeds a victim a callback URL carrying that state
 * plus the ATTACKER's authorization code — logging the victim's browser into the
 * attacker's account. A server-side set of "states we issued" does NOT stop this,
 * because the attacker's state IS one we issued; membership proves nothing about
 * WHICH browser is completing the flow. So the binding here is a cookie:
 *
 *   - `beginLogin` mints a random nonce. The browser gets the nonce in an
 *     HttpOnly, SameSite=Lax cookie; the IdP round-trip carries only its SHA-256
 *     HASH inside the signed state. A state observed in a URL, a Referer header,
 *     browser history or an access log therefore does NOT reveal the cookie value
 *     needed to use it.
 *   - `completeLogin` recomputes the hash from the cookie and requires it to
 *     equal the one inside the state (timing-safe). A victim's browser carries no
 *     matching cookie, so the attacker's callback URL is refused.
 *
 * THE STATE IS STATELESS (HMAC), which is what makes it DoS-resistant. An
 * earlier design kept pending states in a capped server-side Map; because the cap
 * evicted the OLDEST entry, anyone could flush every in-flight login with a
 * handful of unauthenticated GETs — the eviction victim is by definition the user
 * currently sitting on the consent screen. Here `beginLogin` allocates NO
 * per-login server state at all: the state is self-authenticating
 * (`payload.HMAC`), carrying its own issue time so expiry needs no bookkeeping.
 * The only retained state is the set of ALREADY-CONSUMED states, kept so a
 * replayed callback cannot mint a second session; entries there are created only
 * by a SUCCESSFULLY validated callback, so an unauthenticated flood cannot
 * displace anyone's pending login.
 *
 * NOT IMPLEMENTED: PKCE (and the OIDC `nonce`). This is a CONFIDENTIAL client — it
 * holds a client secret and exchanges the code server-side over TLS against a
 * redirect URI registered with the IdP — which is the case PKCE matters least
 * for, and the login-CSRF attack it is often cited against is covered here by the
 * cookie binding above. The residual risk it WOULD close is authorization-code
 * injection: an attacker who obtains a victim's code (referrer leakage, an open
 * redirector, a proxy log) can present that code from their OWN browser with their
 * own cookie and state, because the binding proves the browser started *a* login,
 * not that it owns the code. Adding it is a small, additive change (the
 * IdentityManager forwards the whole request object, so `exchangeCode(code, {
 * codeVerifier })` plus a request field suffices) — it is deferred for scheduling,
 * not blocked by the seam. Tracked in docs/DEPLOY.md.
 *
 * Node stdlib only (crypto, URL); every collaborator, the clock, the signing key
 * and the random source are injected, so the whole flow is unit-testable offline.
 */

import crypto from 'node:crypto';

import { IDP_PROVIDERS, isSafeRedirectUri } from './oidc-verifier.js';

/** How long an unused `state` stays valid. */
export const DEFAULT_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Cap on remembered CONSUMED states (bounded memory). Only a successful callback
 * creates an entry, so this cannot be inflated by an unauthenticated caller.
 */
export const DEFAULT_MAX_CONSUMED_STATES = 2000;

/** The cookie that binds an in-flight login to one browser. */
export const LOGIN_STATE_COOKIE = 'aab_login_state';

/**
 * Minimum length for a configured OIDC_STATE_SIGNING_KEY. 32 characters is the
 * base64 length of 24 random bytes; the documented recipe (`openssl rand -base64
 * 32`) comfortably clears it.
 */
export const MIN_STATE_SIGNING_KEY_CHARS = 32;

/** Constant-time string comparison that tolerates unequal lengths. */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Create the login flow.
 *
 * @param {object} args
 * @param {object} args.authService      the EXISTING AuthService (authenticate + scopeSession)
 * @param {string} args.provider         'github' | 'google' (an IDP_PROVIDERS OWN key)
 * @param {string} args.clientId         OAuth client id
 * @param {string} args.redirectUri      the callback URL registered with the IdP
 * @param {string} [args.scope]          override the provider's default scope
 * @param {string} [args.authorizeUrl]   override the provider's authorize endpoint
 * @param {() => number} [args.now]      injectable ms clock (state TTL)
 * @param {string|Buffer} [args.signingKey]  HMAC key for the stateless state
 * @param {() => string} [args.randomNonce]  injectable nonce generator
 * @param {number} [args.stateTtlMs]
 * @param {number} [args.maxConsumedStates]
 * @returns {object} frozen flow
 */
export function createLoginFlow({
  authService,
  provider,
  clientId,
  redirectUri,
  scope,
  authorizeUrl,
  now = () => Date.now(),
  signingKey = crypto.randomBytes(32),
  randomNonce = () => crypto.randomBytes(32).toString('base64url'),
  stateTtlMs = DEFAULT_LOGIN_STATE_TTL_MS,
  maxConsumedStates = DEFAULT_MAX_CONSUMED_STATES,
} = {}) {
  if (!authService || typeof authService.authenticate !== 'function' || typeof authService.scopeSession !== 'function') {
    throw new TypeError('createLoginFlow requires an authService with authenticate() and scopeSession()');
  }
  // OWN-property lookup only: a bare `IDP_PROVIDERS[provider]` would resolve
  // inherited names like 'constructor' or '__proto__' and build a flow with an
  // undefined endpoint (fail-OPEN-shaped: a routed login surface that 500s).
  if (typeof provider !== 'string' || !Object.hasOwn(IDP_PROVIDERS, provider)) {
    throw new TypeError(
      `createLoginFlow: provider must be one of [${Object.keys(IDP_PROVIDERS).join(', ')}], got ${JSON.stringify(provider ?? null)}`,
    );
  }
  const descriptor = IDP_PROVIDERS[provider];
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new TypeError('createLoginFlow: clientId must be a non-empty string');
  }
  if (typeof redirectUri !== 'string' || redirectUri.trim() === '') {
    throw new TypeError('createLoginFlow: redirectUri must be a non-empty string');
  }
  if (typeof now !== 'function') throw new TypeError('createLoginFlow: now must be a function');
  if (typeof randomNonce !== 'function') {
    throw new TypeError('createLoginFlow: randomNonce must be a function');
  }

  const endpoint = typeof authorizeUrl === 'string' && authorizeUrl !== '' ? authorizeUrl : descriptor.authorizeUrl;
  const effectiveScope = typeof scope === 'string' && scope !== '' ? scope : descriptor.defaultScope;
  // Only send the cookie over TLS when the deployment itself is TLS. A plain-http
  // redirect URI (a local/dev deploy) would silently never receive a Secure
  // cookie, breaking login with no clue why.
  const cookieSecure = redirectUri.toLowerCase().startsWith('https:');
  /**
   * The `__Host-` prefix is the browser-enforced half of the anti-cookie-tossing
   * defence: a cookie so named MUST be Secure, MUST be Path=/, and MUST carry no
   * Domain attribute — which forbids a sibling subdomain from setting a cookie by
   * that name for this host at all. It requires Secure, so it is only usable on a
   * TLS deployment; a loopback dev deploy falls back to the bare name (and relies
   * on the exactly-one-match rule in the server's cookie parser).
   */
  const cookieName = cookieSecure ? `__Host-${LOGIN_STATE_COOKIE}` : LOGIN_STATE_COOKIE;

  /** Already-consumed state hashes -> consumption time. Insertion-ordered. */
  const consumed = new Map();

  function hashNonce(nonce) {
    return crypto.createHash('sha256').update(String(nonce)).digest('base64url');
  }

  function sign(payloadB64) {
    return crypto.createHmac('sha256', signingKey).update(payloadB64).digest('base64url');
  }

  /** Forget consumed entries that can no longer be replayed anyway (expired). */
  function purgeConsumed() {
    const cutoff = now() - stateTtlMs;
    for (const [hash, at] of consumed) {
      if (at <= cutoff) consumed.delete(hash);
      else break; // insertion order tracks consumption time.
    }
  }

  /**
   * Start a login: mint the browser-binding nonce and the signed state, and build
   * the IdP authorize URL. Allocates NO pending server state.
   *
   * @returns {{ url:string, state:string, cookie:{name:string,value:string,maxAgeSec:number,secure:boolean}, expiresAt:number }}
   */
  function beginLogin() {
    const nonce = randomNonce();
    if (typeof nonce !== 'string' || nonce.trim() === '') {
      throw new TypeError('createLoginFlow: randomNonce must return a non-empty string');
    }
    const issuedAt = now();
    // The state carries only the HASH of the nonce, so a state seen in a URL /
    // Referer / log cannot be turned into the cookie value it requires.
    const payload = { h: hashNonce(nonce), t: issuedAt };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const state = `${payloadB64}.${sign(payloadB64)}`;

    const url = new URL(endpoint);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (effectiveScope) url.searchParams.set('scope', effectiveScope);

    return {
      url: url.toString(),
      state,
      cookie: {
        name: cookieName,
        value: nonce,
        maxAgeSec: Math.ceil(stateTtlMs / 1000),
        secure: cookieSecure,
      },
      expiresAt: issuedAt + stateTtlMs,
    };
  }

  /** Verify a state's signature and decode it. Returns the payload or null. */
  function openState(state) {
    const dot = state.lastIndexOf('.');
    if (dot <= 0 || dot === state.length - 1) return null;
    const payloadB64 = state.slice(0, dot);
    const signature = state.slice(dot + 1);
    // Timing-safe: a byte-by-byte comparison would leak how much of a forged
    // signature was correct.
    if (!timingSafeEqualStrings(signature, sign(payloadB64))) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.h !== 'string' || payload.h === '') return null;
    if (typeof payload.t !== 'number' || !Number.isFinite(payload.t)) return null;
    return payload;
  }

  /**
   * Finish a login from the IdP callback.
   *
   * Order: signature -> expiry -> COOKIE BINDING -> single-use -> code exchange.
   * The cookie check comes before anything that could create state or contact the
   * IdP, and the state is consumed before the exchange so a replay cannot mint a
   * second session.
   *
   * @param {{ code?:string, state?:string, cookieNonce?:string }} params
   * @returns {Promise<{ok:true, token:string, accountId:string, expiresAt:*} | {ok:false, code:string, message:string}>}
   */
  async function completeLogin({ code, state, cookieNonce } = {}) {
    if (typeof state !== 'string' || state.trim() === '') {
      return { ok: false, code: 'STATE_REQUIRED', message: 'login state is required' };
    }
    const payload = openState(state);
    if (!payload) {
      return { ok: false, code: 'STATE_INVALID', message: 'login state is invalid' };
    }
    if (now() - payload.t > stateTtlMs) {
      return { ok: false, code: 'STATE_EXPIRED', message: 'login state has expired' };
    }

    // THE CSRF CHECK: this callback must come from the same browser that started
    // the login. Without the matching cookie the state is useless, which is what
    // defeats an attacker-supplied callback URL.
    if (typeof cookieNonce !== 'string' || cookieNonce === '') {
      return { ok: false, code: 'STATE_UNBOUND', message: 'login cookie is missing' };
    }
    if (!timingSafeEqualStrings(hashNonce(cookieNonce), payload.h)) {
      return { ok: false, code: 'STATE_MISMATCH', message: 'login state does not match this browser' };
    }

    // From here on the caller PROVED it owns this login (valid signature + the
    // matching cookie). `bound: true` tells the transport it may clear the cookie:
    // clearing on an UNvalidated request would let any cross-site GET to
    // /auth/callback destroy a victim's in-flight login.
    const bound = true;

    // Single-use.
    purgeConsumed();
    if (consumed.has(payload.h)) {
      return { ok: false, bound, code: 'STATE_INVALID', message: 'login state has already been used' };
    }
    if (typeof code !== 'string' || code.trim() === '') {
      return { ok: false, bound, code: 'CODE_REQUIRED', message: 'an authorization code is required' };
    }
    consumed.set(payload.h, now());
    // Memory backstop. Entries normally leave via purgeConsumed() once they are
    // past the TTL and can no longer be replayed anyway, so the map size is
    // naturally bounded by (login rate x TTL); this cap only bites if that exceeds
    // maxConsumedStates. Unlike the pending-state cap this replaced, it cannot be
    // driven by an unauthenticated caller — only a callback with a valid signature
    // AND the matching cookie ever adds an entry.
    //
    // ACCEPTED RESIDUAL: hitting the cap evicts a still-live entry, making that one
    // state replayable. The actor would have to be the browser that already owns
    // the matching cookie, and the result is a second session for the account it
    // already authenticated as — so the exposure is a duplicate session, not access
    // to anyone else's account.
    while (consumed.size > maxConsumedStates) {
      const oldest = consumed.keys().next();
      if (oldest.done) break;
      consumed.delete(oldest.value);
    }

    // The EXISTING AuthService does the real work: verifier -> claims ->
    // authIdentity -> User_Account (created on first login).
    const result = await authService.authenticate({ code });
    if (!result || result.denied || !result.account) {
      return { ok: false, bound, code: 'AUTH_DENIED', message: 'access denied' };
    }

    const session = authService.scopeSession(result.account);
    return {
      ok: true,
      bound,
      token: session.token,
      accountId: session.accountId,
      expiresAt: session.expiresAt,
    };
  }

  return Object.freeze({
    beginLogin,
    completeLogin,
    consumedCount: () => consumed.size,
    cookieName,
    cookieSecure,
    provider: descriptor.provider,
    redirectUri,
  });
}

/**
 * Build the login flow from the environment, or return null when delegated login
 * is not fully configured.
 *
 * Returning NULL is what keeps an unconfigured deploy safe AND honest: the entry
 * point then injects no flow, so /auth/login and /auth/callback are not routed at
 * all (405) instead of advertising a login that cannot possibly succeed. Mirrors
 * resolveIdpVerifier's fail-closed contract and reads the SAME env vars.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @param {object} deps
 * @param {object} deps.authService
 * @param {() => number} [deps.now]
 * @returns {object|null}
 */
export function resolveLoginFlow(env = process.env, { authService, now } = {}) {
  // An explicitly configured signing key survives restarts and is shared by
  // replicas; without one the default is fresh random bytes per process, so
  // in-flight logins are invalidated by a restart and a second replica rejects
  // the first's states (the user simply retries). See docs/DEPLOY.md.
  //
  // A SHORT key is worse than no key: it would be a guessable HMAC secret in place
  // of 32 random bytes, so anything under the floor is ignored (with the per-process
  // random default used instead) rather than silently weakening state signing.
  const rawKey = (env.OIDC_STATE_SIGNING_KEY ?? '').trim();
  const configuredKey = rawKey.length >= MIN_STATE_SIGNING_KEY_CHARS ? rawKey : '';
  const provider = (env.OIDC_PROVIDER ?? '').trim().toLowerCase();
  // OWN-property check: `IDP_PROVIDERS[provider]` alone would accept inherited
  // names ('constructor', '__proto__', 'toString'), producing a routed login
  // surface on a deploy whose verifier correctly failed closed.
  if (!Object.hasOwn(IDP_PROVIDERS, provider)) return null;

  const clientId = (env.OIDC_CLIENT_ID ?? '').trim();
  const clientSecret = (env.OIDC_CLIENT_SECRET ?? '').trim();
  const redirectUri = (env.OIDC_REDIRECT_URI ?? '').trim();
  // The same completeness rule as resolveIdpVerifier: without all three the
  // exchange cannot succeed, so expose no login surface.
  if (clientId === '' || clientSecret === '' || redirectUri === '') return null;
  // ...and the same TLS rule, applied INDEPENDENTLY rather than relying on the
  // entry point's gate on the verifier. A plaintext non-loopback callback would
  // otherwise mint a non-Secure, non-__Host- cookie — the exact binding this
  // module's CSRF defence rests on.
  if (!isSafeRedirectUri(redirectUri)) return null;

  const scope = (env.OIDC_SCOPE ?? '').trim();

  return createLoginFlow({
    authService,
    provider,
    clientId,
    redirectUri,
    ...(scope !== '' ? { scope } : {}),
    ...(configuredKey !== '' ? { signingKey: configuredKey } : {}),
    ...(typeof now === 'function' ? { now } : {}),
  });
}
