/**
 * oidc-verifier.js — REAL, env-driven delegated identity (final wiring pass).
 *
 * THE GAP THIS CLOSES: the platform's IdentityManager (src/auth/identity.js) has
 * always taken an INJECTABLE `idpVerifier` seam, and every test injected a fake.
 * The production entry point injected a FAIL-CLOSED placeholder whose
 * verifyIdToken() always threw, so every authentication attempt was denied and
 * the auth-gated routes (/message, /events, /confirm, /projects, ...) stayed
 * DARK in a real deployment. Nobody could log in. This module is the missing
 * real verifier: it speaks actual OAuth 2.0 / OIDC to GitHub and Google, driven
 * entirely by environment variables.
 *
 * IT SATISFIES THE EXISTING SEAM, UNCHANGED. A verifier here is exactly what
 * createIdentityManager already documents and validates:
 *   - verifyIdToken(idToken) -> { provider, subject, ... }   (OIDC id_token), or
 *   - exchangeCode(code)     -> { provider, subject, ... }    (auth-code grant)
 * The platform then derives `authIdentity = "<provider>:<subject>"` and looks
 * up / creates the User_Account. No password is ever stored, and `provider` is
 * always a member of SUPPORTED_IDP_PROVIDERS.
 *
 * FAIL-CLOSED BY DEFAULT (the security-critical property). `resolveIdpVerifier`
 * returns the fail-closed placeholder whenever the environment is UNCONFIGURED
 * *or PARTIALLY configured* (e.g. a client id with no secret). An operator who
 * deploys without OIDC env vars gets a server that boots, answers /healthz, and
 * denies every login — never an open one. Misconfiguration can only ever make
 * the platform MORE closed, never accidentally open.
 *
 * ZERO NEW DEPENDENCIES. RS256/384/512 id_token signature verification is done
 * with Node's stdlib crypto: a JWKS key is imported with
 * crypto.createPublicKey({ key: jwk, format: 'jwk' }) and checked with
 * crypto.verify(). `fetch` is global (Node >= 20). Both the network (`fetchImpl`)
 * and the clock (`now`) are INJECTED, so every branch here — including token
 * expiry and JWKS cache expiry — is unit-testable offline with no real IdP and
 * no real waiting.
 *
 * WHAT IS VERIFIED ON AN id_token (all of it, before any claim is trusted):
 *   signature (RSA, against the issuer's JWKS, key selected by `kid`), `alg` on
 *   an allow-list (never `none`, never HMAC — which would let the token itself
 *   pick the key), `iss` exact-match against the expected issuer set, `aud`
 *   exact-match against our client id, `exp` (required) with a small clock
 *   tolerance, `nbf`/`iat` when present, and a non-empty `sub`.
 */

import crypto from 'node:crypto';

// NOTE: SUPPORTED_IDP_PROVIDERS (identity.js) is the platform-level list of
// providers whose identities may become a User_Account. IDP_VERIFIER_PROVIDERS
// (below) is the list this module can actually BUILD a verifier for. They must
// agree, and a test asserts they do — but the dispatch here is keyed off the
// latter so a provider can never be admitted without an explicit branch.

/** Signature algorithms we accept on an id_token, mapped to Node digests.
 *
 * DELIBERATELY RSA-ONLY. Accepting an HMAC alg (HS256) would be a key-confusion
 * vulnerability: the attacker-controlled header would select a symmetric
 * algorithm and the public JWKS modulus would become the shared secret. `none`
 * is likewise absent, so an unsigned token can never verify. */
const ALLOWED_JWT_ALGS = Object.freeze({
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
});

/** Default leeway for exp/nbf/iat comparisons, covering small clock skew. */
export const DEFAULT_CLOCK_TOLERANCE_SEC = 60;

/** How long a fetched JWKS is reused before refetching. */
const DEFAULT_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * CEILING on how far past its TTL a cached JWKS may be served when the issuer is
 * unreachable. Bounded on purpose: revocation is communicated by a key
 * DISAPPEARING from the JWKS, so serving stale keys indefinitely would let an
 * attacker who can break our JWKS fetch keep a revoked key trusted forever —
 * turning a fail-closed path into a fail-open one. An hour covers real outages
 * (minutes) while staying far below a key-rotation interval (days).
 */
const DEFAULT_JWKS_MAX_STALE_MS = 60 * 60 * 1000;

/**
 * How long a FAILED JWKS fetch is remembered. Within this window a lookup serves
 * stale keys without touching the network, so an unauthenticated /auth/callback
 * cannot be used to amplify traffic at an already-unhealthy issuer.
 */
const DEFAULT_JWKS_NEGATIVE_CACHE_MS = 30 * 1000;

/** Floor between JWKS refetches, so an unknown `kid` cannot be used to hammer
 * the issuer's key endpoint (one refresh per minute at most). */
const DEFAULT_JWKS_MIN_REFETCH_MS = 60 * 1000;

/** Network timeout for IdP calls. */
const DEFAULT_HTTP_TIMEOUT_MS = 5000;

/**
 * Static descriptors for the providers the platform delegates to (design.md §0
 * names exactly these two). Endpoint URLs live here so the verifier and the
 * login flow (src/auth/login-flow.js) agree on one source of truth.
 *
 * - github: plain OAuth 2.0. GitHub OAuth Apps issue an opaque access token, NOT
 *   an OIDC id_token, so identity comes from the authorization-code exchange
 *   followed by a userinfo lookup — hence `exchangeCode` only.
 * - google: real OIDC. The code exchange returns a signed id_token, which is
 *   verified cryptographically — hence both `exchangeCode` and `verifyIdToken`.
 */
export const IDP_PROVIDERS = Object.freeze({
  github: Object.freeze({
    provider: 'github',
    kind: 'oauth2',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    defaultScope: 'read:user',
  }),
  google: Object.freeze({
    provider: 'google',
    kind: 'oidc',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: Object.freeze(['https://accounts.google.com', 'accounts.google.com']),
    defaultScope: 'openid email',
  }),
});

/** The environment variables that drive delegated login (see docs/DEPLOY.md). */
export const OIDC_ENV_VARS = Object.freeze([
  'OIDC_PROVIDER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_SCOPE',
  'OIDC_ISSUER',
  'OIDC_JWKS_URI',
  'OIDC_STATE_SIGNING_KEY',
]);

/**
 * The providers `resolveIdpVerifier` can actually BUILD.
 *
 * HAND-KEPT, PINNED BY A TEST — not derived. It must stay in sync with both the
 * `raw === '<provider>'` branches in resolveIdpVerifier and with
 * SUPPORTED_IDP_PROVIDERS (identity.js), which is the natural place for someone to
 * "register" a provider. test/oidc-login-wiring.test.js asserts set-equality with
 * that list, and every drift direction fails CLOSED: a provider listed here with
 * no branch reaches the fail-closed return at the end of resolveIdpVerifier, and
 * one missing from IDP_PROVIDERS yields no login flow at all. Adding a provider
 * therefore means touching this constant, the dispatch, IDP_PROVIDERS, and
 * SUPPORTED_IDP_PROVIDERS together.
 */
export const IDP_VERIFIER_PROVIDERS = Object.freeze(['github', 'google']);

/**
 * Whether a redirect URI is safe to send a credential-bearing cookie to.
 *
 * The ENTIRE CSRF binding depends on this: the login nonce cookie only gets its
 * `Secure` attribute when the deployment is TLS, and a plaintext callback ships
 * both the nonce and the authorization code in cleartext. Loopback is exempt
 * because a local dev deploy has no TLS and no network attacker.
 */
export function isSafeRedirectUri(uri) {
  if (typeof uri !== 'string' || uri.trim() === '') return false;
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * A FAIL-CLOSED IdP verifier: every authentication attempt is DENIED.
 *
 * The IdentityManager requires an idpVerifier at construction, so the process
 * cannot boot without one. This is the safe default when no real provider is
 * configured: the server still boots, the unauthenticated /healthz probe still
 * answers, and every auth-gated route stays closed. It never grants access.
 *
 * `reason` is for operator-facing logs only; identity.js deliberately collapses
 * any thrown cause to `idp-rejected` so nothing leaks to a client.
 */
export function createFailClosedIdpVerifier(reason = 'no identity provider configured') {
  return {
    async verifyIdToken() {
      throw new Error(reason);
    },
    async exchangeCode() {
      throw new Error(reason);
    },
  };
}

/** Decode one base64url JWT segment as JSON, or throw. */
function decodeJwtSegment(segment, what) {
  let json;
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    throw new Error(`id_token ${what} is not valid base64url`);
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`id_token ${what} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`id_token ${what} must be a JSON object`);
  }
  return parsed;
}

/**
 * A JWKS key store with a TTL cache and a refetch floor.
 *
 * `fetchImpl` and `now` are injected, so a test drives cache hits, TTL
 * expiry, key rotation and the refetch floor deterministically with no network
 * and no real waiting.
 */
export function createJwksKeyStore({
  jwksUri,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_JWKS_CACHE_TTL_MS,
  minRefetchMs = DEFAULT_JWKS_MIN_REFETCH_MS,
  maxStaleMs = DEFAULT_JWKS_MAX_STALE_MS,
  negativeCacheMs = DEFAULT_JWKS_NEGATIVE_CACHE_MS,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
} = {}) {
  if (typeof jwksUri !== 'string' || jwksUri.trim() === '') {
    throw new TypeError('createJwksKeyStore: jwksUri must be a non-empty string');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createJwksKeyStore: fetchImpl must be a function');
  }

  /** @type {{ keys: object[], fetchedAt: number } | null} */
  let cache = null;
  let lastFetchAt = -Infinity;
  let lastFailureAt = -Infinity;

  async function fetchJwks() {
    lastFetchAt = now();
    let res;
    try {
      res = await fetchImpl(jwksUri, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`JWKS fetch failed: ${err?.message ?? err}`);
    }
    if (!res || res.ok !== true) {
      throw new Error(`JWKS fetch returned status ${res?.status ?? 'unknown'}`);
    }
    const body = await res.json();
    const keys = Array.isArray(body?.keys) ? body.keys : null;
    if (!keys) throw new Error('JWKS response has no keys array');
    cache = { keys, fetchedAt: now() };
    // Clear the negative cache on success, so a recovered issuer is not shadowed
    // by an old failure. Without this the safety of the negative-cache window
    // depends on minRefetchMs happening to exceed it — an undocumented coupling.
    lastFailureAt = -Infinity;
    return keys;
  }

  function cachedKeys() {
    if (!cache) return null;
    if (now() - cache.fetchedAt >= cacheTtlMs) return null;
    return cache.keys;
  }

  /**
   * Cached keys that are past their TTL but still WITHIN the staleness ceiling.
   * Past the ceiling this returns null, so verification fails closed rather than
   * trusting keys the issuer may since have revoked.
   */
  function staleKeys() {
    if (!cache) return null;
    if (now() - cache.fetchedAt > cacheTtlMs + maxStaleMs) return null;
    return cache.keys;
  }

  /**
   * Refetch, falling back to BOUNDED-stale cached keys if the issuer is
   * unreachable.
   *
   * Two failure properties, both deliberate:
   *   - NEGATIVE CACHE: a recent failure short-circuits the network entirely, so
   *     an outage cannot be amplified by unauthenticated /auth/callback traffic
   *     into one outbound fetch per request.
   *   - STALENESS CEILING: stale keys are served only within maxStaleMs. Beyond
   *     it we deny, because a key vanishing from the JWKS IS the revocation
   *     signal and an attacker who can keep our fetch failing must not be able to
   *     keep a revoked key alive indefinitely.
   */
  async function refreshOrStale() {
    if (now() - lastFailureAt < negativeCacheMs) {
      const stale = staleKeys();
      if (stale) return stale;
      throw new Error('JWKS endpoint recently failed and no usable cached keys remain');
    }
    try {
      return await fetchJwks();
    } catch (err) {
      lastFailureAt = now();
      const stale = staleKeys();
      if (stale) return stale;
      throw err;
    }
  }

  /**
   * Select the JWK matching `kid` and `alg`, importing it as a public key.
   *
   * A `kid` miss triggers at most one refetch (respecting the refetch floor) to
   * pick up a rotated signing key; still missing ⇒ throw, so an unknown key can
   * never be treated as valid.
   */
  async function keyFor(kid, alg) {
    let keys = cachedKeys();
    if (!keys) keys = await refreshOrStale();

    let jwk = selectJwk(keys, kid, alg);
    if (!jwk && now() - lastFetchAt >= minRefetchMs) {
      keys = await refreshOrStale();
      jwk = selectJwk(keys, kid, alg);
    }
    if (!jwk) {
      throw new Error(`no JWKS key matches kid=${JSON.stringify(kid ?? null)}`);
    }

    let key;
    try {
      key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch (err) {
      throw new Error(`JWKS key is not importable: ${err?.message ?? err}`);
    }
    if (key.asymmetricKeyType !== 'rsa') {
      // ALLOWED_JWT_ALGS is RSA-only; refuse anything else rather than
      // attempting a mismatched verification.
      throw new Error(`unsupported JWKS key type ${key.asymmetricKeyType}`);
    }
    return key;
  }

  return Object.freeze({ keyFor, _cachedKeyCount: () => cachedKeys()?.length ?? 0 });
}

/**
 * Pick a JWK by `kid`, rejecting keys whose own metadata contradicts the token
 * header (`use` must be signature use; a pinned `alg` must match).
 *
 * AMBIGUITY IS ALWAYS REFUSED, never resolved by array position. A legitimate
 * JWKS never contains two usable keys claiming the same `kid`; if one does, the
 * response is either malformed or adversarial, and picking the first match would
 * let a poisoned JWKS decide the signing key by ordering alone. The same rule
 * covers a token with no `kid`: it is accepted only against an unambiguous
 * single-candidate JWKS.
 */
function selectJwk(keys, kid, alg) {
  const usable = keys.filter(
    (k) =>
      k &&
      typeof k === 'object' &&
      k.kty === 'RSA' &&
      (k.use === undefined || k.use === 'sig') &&
      (k.alg === undefined || k.alg === alg),
  );
  const candidates =
    typeof kid === 'string' && kid !== '' ? usable.filter((k) => k.kid === kid) : usable;
  // Exactly one, or none. Two candidates ⇒ ambiguous ⇒ refuse.
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Verify an OIDC id_token and return its claims. Signature FIRST, then the
 * registered claims — a payload is never trusted before the signature checks
 * out. Any failure throws (identity.js maps that to `idp-rejected`).
 *
 * @param {string} idToken           the compact JWS
 * @param {object} opts
 * @param {{keyFor:Function}} opts.keyStore
 * @param {string[]} opts.issuers    accepted `iss` values (exact match)
 * @param {string} opts.audience     our OAuth client id; must equal `aud`
 * @param {() => number} opts.now    ms clock
 * @param {number} [opts.clockToleranceSec]
 * @returns {Promise<object>} the verified payload claims
 */
export async function verifyOidcIdToken(idToken, {
  keyStore,
  issuers,
  audience,
  now = () => Date.now(),
  clockToleranceSec = DEFAULT_CLOCK_TOLERANCE_SEC,
} = {}) {
  if (typeof idToken !== 'string' || idToken.trim() === '') {
    throw new Error('id_token must be a non-empty string');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((p) => p === '')) {
    throw new Error('id_token must have three non-empty segments');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeJwtSegment(headerB64, 'header');
  const digest = ALLOWED_JWT_ALGS[header.alg];
  if (!digest) {
    // Covers alg:'none' and any HMAC/EC alg — see ALLOWED_JWT_ALGS.
    throw new Error(`unsupported id_token alg ${JSON.stringify(header.alg ?? null)}`);
  }

  const key = await keyStore.keyFor(header.kid, header.alg);

  let signature;
  try {
    signature = Buffer.from(signatureB64, 'base64url');
  } catch {
    throw new Error('id_token signature is not valid base64url');
  }
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(digest, signingInput, key, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw new Error('id_token signature verification failed');
  }

  // ---- signature is valid; NOW the claims may be read ----
  const claims = decodeJwtSegment(payloadB64, 'payload');

  const accepted = Array.isArray(issuers) ? issuers : [issuers];
  if (typeof claims.iss !== 'string' || !accepted.includes(claims.iss)) {
    throw new Error('id_token iss does not match the expected issuer');
  }

  // `aud` may be a string or an array; our client id must be present.
  const audOk =
    typeof audience === 'string' &&
    audience !== '' &&
    (claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience)));
  if (!audOk) {
    throw new Error('id_token aud does not match the configured client id');
  }

  const nowSec = now() / 1000;
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    // An id_token with no expiry would be usable forever.
    throw new Error('id_token has no numeric exp');
  }
  if (nowSec > claims.exp + clockToleranceSec) {
    throw new Error('id_token has expired');
  }
  if (typeof claims.nbf === 'number' && Number.isFinite(claims.nbf) && nowSec < claims.nbf - clockToleranceSec) {
    throw new Error('id_token is not yet valid (nbf)');
  }
  if (typeof claims.iat === 'number' && Number.isFinite(claims.iat) && nowSec < claims.iat - clockToleranceSec) {
    throw new Error('id_token was issued in the future (iat)');
  }
  if (typeof claims.sub !== 'string' || claims.sub.trim() === '') {
    throw new Error('id_token has no usable sub');
  }

  return claims;
}

/** POST an application/x-www-form-urlencoded body and parse a JSON response.
 *
 * Response bodies from a token endpoint can contain credentials, so a failure
 * NEVER embeds the body in the thrown message — only the status code. */
async function postForm({ url, form, fetchImpl, timeoutMs, extraHeaders = {} }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...extraHeaders,
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`token endpoint request failed: ${err?.message ?? err}`);
  }
  if (!res || res.ok !== true) {
    throw new Error(`token endpoint returned status ${res?.status ?? 'unknown'}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('token endpoint response was not JSON');
  }
  if (!body || typeof body !== 'object') {
    throw new Error('token endpoint response was not a JSON object');
  }
  if (typeof body.error === 'string' && body.error !== '') {
    // OAuth error codes are safe to surface (they carry no credential).
    throw new Error(`token endpoint error: ${body.error}`);
  }
  return body;
}

/**
 * A GitHub OAuth 2.0 verifier (`exchangeCode` only — GitHub OAuth Apps issue no
 * id_token). The authorization code is exchanged for an access token, which is
 * used ONCE to read the authenticated user's immutable numeric id. That id, not
 * the mutable login/username, becomes the subject — a renamed account must stay
 * the same platform identity.
 */
export function createGithubOAuthVerifier({
  clientId,
  clientSecret,
  redirectUri,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  tokenUrl = IDP_PROVIDERS.github.tokenUrl,
  userInfoUrl = IDP_PROVIDERS.github.userInfoUrl,
} = {}) {
  requireNonEmpty('createGithubOAuthVerifier', 'clientId', clientId);
  requireNonEmpty('createGithubOAuthVerifier', 'clientSecret', clientSecret);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createGithubOAuthVerifier: fetchImpl must be a function');
  }

  async function exchangeCode(code) {
    if (typeof code !== 'string' || code.trim() === '') {
      throw new Error('authorization code must be a non-empty string');
    }
    const token = await postForm({
      url: tokenUrl,
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      },
      fetchImpl,
      timeoutMs,
    });
    const accessToken = token.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new Error('GitHub token response carried no access_token');
    }

    let res;
    try {
      res = await fetchImpl(userInfoUrl, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'ai-app-builder',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`GitHub userinfo request failed: ${err?.message ?? err}`);
    }
    if (!res || res.ok !== true) {
      throw new Error(`GitHub userinfo returned status ${res?.status ?? 'unknown'}`);
    }
    const user = await res.json();
    // The numeric id is immutable; `login` can be changed by the user.
    const subject = user && user.id !== undefined && user.id !== null ? String(user.id) : '';
    if (subject === '') {
      throw new Error('GitHub userinfo carried no id');
    }
    return { provider: 'github', subject };
  }

  return { exchangeCode };
}

/**
 * A Google OIDC verifier: `verifyIdToken` (full cryptographic verification) plus
 * `exchangeCode` (authorization-code grant, then verify the returned id_token
 * through the same path — an unverified id_token is never trusted).
 */
export function createGoogleOidcVerifier({
  clientId,
  clientSecret,
  redirectUri,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  clockToleranceSec = DEFAULT_CLOCK_TOLERANCE_SEC,
  tokenUrl = IDP_PROVIDERS.google.tokenUrl,
  jwksUri = IDP_PROVIDERS.google.jwksUri,
  issuers = IDP_PROVIDERS.google.issuers,
  keyStore,
} = {}) {
  requireNonEmpty('createGoogleOidcVerifier', 'clientId', clientId);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createGoogleOidcVerifier: fetchImpl must be a function');
  }
  const keys =
    keyStore ?? createJwksKeyStore({ jwksUri, fetchImpl, now, timeoutMs });

  async function verifyIdToken(idToken) {
    const claims = await verifyOidcIdToken(idToken, {
      keyStore: keys,
      issuers,
      audience: clientId,
      now,
      clockToleranceSec,
    });
    return { provider: 'google', subject: claims.sub, email: claims.email };
  }

  async function exchangeCode(code) {
    if (typeof code !== 'string' || code.trim() === '') {
      throw new Error('authorization code must be a non-empty string');
    }
    requireNonEmpty('createGoogleOidcVerifier', 'clientSecret', clientSecret);
    const token = await postForm({
      url: tokenUrl,
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      },
      fetchImpl,
      timeoutMs,
    });
    if (typeof token.id_token !== 'string' || token.id_token === '') {
      throw new Error('Google token response carried no id_token');
    }
    // Verify the id_token cryptographically even though it came straight from
    // the token endpoint: verification is the ONLY thing that establishes which
    // subject this code belonged to.
    return verifyIdToken(token.id_token);
  }

  return { verifyIdToken, exchangeCode };
}

function requireNonEmpty(fn, field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${fn}: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Resolve the IdP verifier from the environment — the production decision point.
 *
 * Returns a descriptor rather than a bare verifier so the entry point can LOG
 * what happened (and a test can assert it) without re-deriving the logic:
 *   { verifier, provider, configured, missing, reason }
 *
 * FAIL-CLOSED: `configured` is only true when the selected provider has every
 * credential it needs. Unset, unknown, or partially configured env ⇒ the
 * fail-closed verifier, with `missing` naming exactly what to set.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @returns {{ verifier:object, provider:string|null, configured:boolean, missing:string[], reason:string }}
 */
export function resolveIdpVerifier(env = process.env, deps = {}) {
  const { fetchImpl = globalThis.fetch, now = () => Date.now() } = deps;

  const raw = (env.OIDC_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'none') {
    const reason =
      'no identity provider configured (set OIDC_PROVIDER=github|google plus its client credentials)';
    return {
      verifier: createFailClosedIdpVerifier(reason),
      provider: null,
      configured: false,
      missing: ['OIDC_PROVIDER'],
      reason,
    };
  }

  // Derived from the dispatch table below, NOT from a second hand-kept list.
  if (!IDP_VERIFIER_PROVIDERS.includes(raw)) {
    const reason = `unsupported OIDC_PROVIDER ${JSON.stringify(raw)}: must be one of [${IDP_VERIFIER_PROVIDERS.join(', ')}]`;
    return {
      verifier: createFailClosedIdpVerifier(reason),
      provider: null,
      configured: false,
      missing: ['OIDC_PROVIDER'],
      reason,
    };
  }

  const clientId = (env.OIDC_CLIENT_ID ?? '').trim();
  const clientSecret = (env.OIDC_CLIENT_SECRET ?? '').trim();
  const redirectUri = (env.OIDC_REDIRECT_URI ?? '').trim();

  // Both supported providers use the authorization-code grant, so all three are
  // required. A missing piece keeps the deploy CLOSED rather than half-open.
  const missing = [];
  if (clientId === '') missing.push('OIDC_CLIENT_ID');
  if (clientSecret === '') missing.push('OIDC_CLIENT_SECRET');
  if (redirectUri === '') missing.push('OIDC_REDIRECT_URI');
  if (missing.length > 0) {
    const reason = `OIDC_PROVIDER=${raw} is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing; login stays closed`;
    return {
      verifier: createFailClosedIdpVerifier(reason),
      provider: raw,
      configured: false,
      missing,
      reason,
    };
  }

  // The redirect URI must be TLS (or loopback). The login cookie that carries the
  // CSRF binding is only marked Secure for an https callback, and a plaintext
  // callback exposes the authorization code itself — so a plaintext non-loopback
  // redirect makes the whole login flow unsafe rather than merely unencrypted.
  if (!isSafeRedirectUri(redirectUri)) {
    const reason =
      `OIDC_REDIRECT_URI must be an https:// URL (or http:// on loopback for local development); ` +
      `got ${JSON.stringify(redirectUri)}. A plaintext callback would expose the login cookie and ` +
      'the authorization code, so login stays closed';
    return {
      verifier: createFailClosedIdpVerifier(reason),
      provider: raw,
      configured: false,
      missing: ['OIDC_REDIRECT_URI'],
      reason,
    };
  }

  if (raw === 'github') {
    return {
      verifier: createGithubOAuthVerifier({ clientId, clientSecret, redirectUri, fetchImpl }),
      provider: 'github',
      configured: true,
      missing: [],
      reason: 'github OAuth verifier configured',
    };
  }

  // EXPLICIT, never a catch-all. An `else google` fallthrough here would stamp a
  // newly-registered provider's accounts with `google:<sub>`, colliding two
  // providers' subject namespaces. Anything without its own branch falls through
  // to the fail-closed return below instead.
  if (raw === 'google') {
    const issuerOverride = (env.OIDC_ISSUER ?? '').trim();
    const jwksOverride = (env.OIDC_JWKS_URI ?? '').trim();

    // The issuer and its key endpoint must be overridden TOGETHER: accepting one
    // alone yields a verifier whose trusted issuer and whose signing keys come
    // from different parties, which is never an intended configuration.
    if ((issuerOverride === '') !== (jwksOverride === '')) {
      const reason =
        'OIDC_ISSUER and OIDC_JWKS_URI must be set together (an issuer without its key endpoint, ' +
        'or a key endpoint without its issuer, is never a valid configuration); login stays closed';
      return {
        verifier: createFailClosedIdpVerifier(reason),
        provider: 'google',
        configured: false,
        missing: [issuerOverride === '' ? 'OIDC_ISSUER' : 'OIDC_JWKS_URI'],
        reason,
      };
    }
    // Key material fetched over plaintext http is attacker-controllable, and the
    // JWKS is precisely what decides whether a token is authentic.
    for (const [name, value] of [['OIDC_ISSUER', issuerOverride], ['OIDC_JWKS_URI', jwksOverride]]) {
      if (value !== '' && !value.toLowerCase().startsWith('https://')) {
        const reason = `${name} must be an https:// URL (plaintext key material is attacker-controllable); login stays closed`;
        return {
          verifier: createFailClosedIdpVerifier(reason),
          provider: 'google',
          configured: false,
          missing: [name],
          reason,
        };
      }
    }

    return {
      verifier: createGoogleOidcVerifier({
        clientId,
        clientSecret,
        redirectUri,
        fetchImpl,
        now,
        ...(issuerOverride !== '' ? { issuers: [issuerOverride] } : {}),
        ...(jwksOverride !== '' ? { jwksUri: jwksOverride } : {}),
      }),
      provider: 'google',
      configured: true,
      missing: [],
      reason: 'google OIDC verifier configured',
    };
  }

  const reason = `OIDC_PROVIDER=${raw} has no verifier implementation; login stays closed`;
  return {
    verifier: createFailClosedIdpVerifier(reason),
    provider: null,
    configured: false,
    missing: ['OIDC_PROVIDER'],
    reason,
  };
}
