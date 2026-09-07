/**
 * Delegated-login wiring tests (final wiring pass).
 *
 * These prove the auth-gated surface is no longer DARK: a real, env-driven
 * OIDC/OAuth verifier resolves a real User_Account, a browser-facing round-trip
 * mints a session token, and that token opens a gated route — while an
 * UNCONFIGURED deployment stays fail-closed.
 *
 * Every test is written to FAIL if the change is reverted, and exercises REAL
 * collaborators wherever a contract is under test:
 *   - REAL RSA keys + REAL node:crypto signing/verification for id_tokens (the
 *     JWKS is served by an injected fetch, but the cryptography is genuine, so a
 *     weakened signature/alg/aud/iss/exp check actually flips a test).
 *   - the REAL AuthService / IdentityManager / SessionManager (no auth fakes) —
 *     the account is really created and the token really verifies.
 *   - the REAL createBuilderServer bound on a REAL ephemeral loopback port,
 *     driven with REAL fetch, including real Set-Cookie/Cookie round-tripping.
 * Only the NETWORK (the IdP endpoints) and the CLOCK are injected fakes, because
 * a real IdP handshake cannot run in this sandbox.
 *
 * WHAT IS NOT PROVEN HERE: that GitHub/Google actually accept our client id and
 * redirect_uri. That requires a real deploy with real credentials — see
 * docs/DEPLOY.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService, SUPPORTED_IDP_PROVIDERS } from '../src/auth/index.js';
import { createScriptedProvider } from '../src/engine/plumby.js';
import {
  createGithubOAuthVerifier,
  createGoogleOidcVerifier,
  createJwksKeyStore,
  verifyOidcIdToken,
  resolveIdpVerifier,
  IDP_PROVIDERS,
  IDP_VERIFIER_PROVIDERS,
} from '../src/auth/oidc-verifier.js';
import { createLoginFlow, resolveLoginFlow, LOGIN_STATE_COOKIE } from '../src/auth/login-flow.js';
import { startPlatformServer } from '../src/server/start.js';

// ---------------------------------------------------------------- test helpers

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // fixed ms clock base
const GOOGLE_ISS = 'https://accounts.google.com';
const CLIENT_ID = 'client-abc.apps.googleusercontent.com';

/** A stepping/settable ms clock (the codebase's injected-clock convention). */
function fakeClock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** A REAL RSA keypair plus its JWKS entry. */
function makeSigningKey(kid = 'key-1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  return { publicKey, privateKey, jwk, kid };
}

/** Sign a REAL compact JWS with the given claims. */
function makeIdToken({ privateKey, kid, alg = 'RS256', digest = 'RSA-SHA256', claims }) {
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = Buffer.from(`${h}.${p}`, 'ascii');
  const sig = crypto.sign(digest, signingInput, privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

/** Standard, currently-valid Google claims. */
function googleClaims(overrides = {}) {
  return {
    iss: GOOGLE_ISS,
    aud: CLIENT_ID,
    sub: '1098765',
    email: 'dev@example.com',
    iat: Math.floor(NOW / 1000) - 10,
    exp: Math.floor(NOW / 1000) + 3600,
    ...overrides,
  };
}

/**
 * An injected fetch that routes by URL to canned JSON, recording every call.
 * `routes` maps a URL substring to a handler returning { status?, body }.
 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, options, body: options.body });
    for (const [needle, handler] of Object.entries(routes)) {
      if (href.includes(needle)) {
        const out = await handler({ url: href, options });
        if (out.throw) throw new Error(out.throw);
        const status = out.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => {
            if (out.notJson) throw new Error('not json');
            return out.body;
          },
        };
      }
    }
    throw new Error(`fakeFetch: no route for ${href}`);
  };
  impl.calls = calls;
  return impl;
}

/** A JWKS route serving the given JWKs. */
function jwksRoute(...jwks) {
  return async () => ({ body: { keys: jwks } });
}

/** A key store over a fake JWKS endpoint. */
function keyStoreFor(fetchImpl, clock, extra = {}) {
  return createJwksKeyStore({
    jwksUri: 'https://jwks.test/certs',
    fetchImpl,
    now: clock.now,
    ...extra,
  });
}

// ============================================================ id_token crypto

test('verifyOidcIdToken accepts a genuinely signed, valid id_token', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const keyStore = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(key.jwk) }), clock);

  const claims = await verifyOidcIdToken(
    makeIdToken({ privateKey: key.privateKey, kid: key.kid, claims: googleClaims() }),
    { keyStore, issuers: [GOOGLE_ISS], audience: CLIENT_ID, now: clock.now },
  );

  assert.equal(claims.sub, '1098765');
  assert.equal(claims.iss, GOOGLE_ISS);
});

test('verifyOidcIdToken rejects a tampered payload (REAL signature check)', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const keyStore = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(key.jwk) }), clock);
  const token = makeIdToken({ privateKey: key.privateKey, kid: key.kid, claims: googleClaims() });

  // Swap the payload for one naming a DIFFERENT subject, keeping the signature.
  const [h, , s] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify(googleClaims({ sub: 'attacker' }))).toString('base64url');

  await assert.rejects(
    () => verifyOidcIdToken(`${h}.${forgedPayload}.${s}`, { keyStore, issuers: [GOOGLE_ISS], audience: CLIENT_ID, now: clock.now }),
    /signature verification failed/,
  );
});

test('verifyOidcIdToken refuses alg:none and HMAC key-confusion tokens', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const keyStore = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(key.jwk) }), clock);
  const opts = { keyStore, issuers: [GOOGLE_ISS], audience: CLIENT_ID, now: clock.now };

  // alg:'none' with a non-empty (garbage) signature: must be refused on ALG, so
  // an unsigned token can never verify.
  const h = Buffer.from(JSON.stringify({ alg: 'none', kid: key.kid, typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(googleClaims())).toString('base64url');
  await assert.rejects(() => verifyOidcIdToken(`${h}.${p}.xx`, opts), /unsupported id_token alg/);

  // HS256 signed with the public modulus as the shared secret — the classic
  // key-confusion attack. Refused because the alg allow-list is RSA-only.
  const hHs = Buffer.from(JSON.stringify({ alg: 'HS256', kid: key.kid, typ: 'JWT' })).toString('base64url');
  const mac = crypto
    .createHmac('sha256', Buffer.from(key.jwk.n, 'base64url'))
    .update(`${hHs}.${p}`)
    .digest('base64url');
  await assert.rejects(() => verifyOidcIdToken(`${hHs}.${p}.${mac}`, opts), /unsupported id_token alg/);
});

test('verifyOidcIdToken enforces iss, aud, exp, sub and an unknown kid', async () => {
  const key = makeSigningKey();
  const other = makeSigningKey('other-kid');
  const clock = fakeClock();
  const keyStore = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(key.jwk) }), clock, { minRefetchMs: 0 });
  const base = { keyStore, issuers: [GOOGLE_ISS], audience: CLIENT_ID, now: clock.now };
  const sign = (claims, kid = key.kid, privateKey = key.privateKey) =>
    makeIdToken({ privateKey, kid, claims });

  await assert.rejects(() => verifyOidcIdToken(sign(googleClaims({ iss: 'https://evil.test' })), base), /iss does not match/);
  await assert.rejects(() => verifyOidcIdToken(sign(googleClaims({ aud: 'someone-elses-client' })), base), /aud does not match/);
  await assert.rejects(() => verifyOidcIdToken(sign(googleClaims({ exp: undefined })), base), /no numeric exp/);
  await assert.rejects(() => verifyOidcIdToken(sign(googleClaims({ sub: '' })), base), /no usable sub/);
  // A token signed by a key that is NOT in the JWKS.
  await assert.rejects(() => verifyOidcIdToken(sign(googleClaims(), other.kid, other.privateKey), base), /no JWKS key matches/);
});

test('verifyOidcIdToken accepts an ARRAY aud containing our client, rejects one without it', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const keyStore = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(key.jwk) }), clock);
  const base = { keyStore, issuers: [GOOGLE_ISS], audience: CLIENT_ID, now: clock.now };

  // Google issues an array `aud` in some configurations.
  const multi = makeIdToken({
    privateKey: key.privateKey,
    kid: key.kid,
    claims: googleClaims({ aud: ['other-client', CLIENT_ID] }),
  });
  assert.equal((await verifyOidcIdToken(multi, base)).sub, '1098765');

  const foreign = makeIdToken({
    privateKey: key.privateKey,
    kid: key.kid,
    claims: googleClaims({ aud: ['other-client', 'third-party'] }),
  });
  await assert.rejects(() => verifyOidcIdToken(foreign, base), /aud does not match/);
});

test('verifyOidcIdToken rejects not-yet-valid (nbf) and future-issued (iat) tokens', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const keyStore = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(key.jwk) }), clock);
  const base = { keyStore, issuers: [GOOGLE_ISS], audience: CLIENT_ID, now: clock.now };
  const future = Math.floor(NOW / 1000) + 3600;

  await assert.rejects(
    () => verifyOidcIdToken(makeIdToken({ privateKey: key.privateKey, kid: key.kid, claims: googleClaims({ nbf: future }) }), base),
    /not yet valid/,
  );
  await assert.rejects(
    () => verifyOidcIdToken(makeIdToken({ privateKey: key.privateKey, kid: key.kid, claims: googleClaims({ iat: future }) }), base),
    /issued in the future/,
  );
});

test('verifyOidcIdToken expires a token against the INJECTED clock (tolerance respected)', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const keyStore = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(key.jwk) }), clock);
  const opts = { keyStore, issuers: [GOOGLE_ISS], audience: CLIENT_ID, now: clock.now };
  const token = makeIdToken({ privateKey: key.privateKey, kid: key.kid, claims: googleClaims() });

  assert.equal((await verifyOidcIdToken(token, opts)).sub, '1098765');

  // Just inside expiry + the 60s default tolerance: still valid.
  clock.advance(3600_000 + 30_000);
  assert.equal((await verifyOidcIdToken(token, opts)).sub, '1098765');

  // Past expiry + tolerance: refused. No real waiting anywhere.
  clock.advance(60_000);
  await assert.rejects(() => verifyOidcIdToken(token, opts), /has expired/);
});

test('the signature is checked BEFORE any claim is trusted (ordering is observable)', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const keyStore = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(key.jwk) }), clock);

  // A token that is BOTH badly signed AND long expired. If claims were read
  // first, this would fail with "has expired"; the signature must win.
  const token = makeIdToken({
    privateKey: key.privateKey,
    kid: key.kid,
    claims: googleClaims({ exp: Math.floor(NOW / 1000) - 100_000 }),
  });
  const [h, p] = token.split('.');
  const garbage = `${h}.${p}.${Buffer.from('not-a-signature').toString('base64url')}`;

  await assert.rejects(
    () => verifyOidcIdToken(garbage, { keyStore, issuers: [GOOGLE_ISS], audience: CLIENT_ID, now: clock.now }),
    /signature verification failed/,
  );
});

// ================================================================ JWKS store

test('the JWKS store caches, then refetches after its TTL (injected clock)', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const fetchImpl = fakeFetch({ 'jwks.test': jwksRoute(key.jwk) });
  const keyStore = keyStoreFor(fetchImpl, clock, { cacheTtlMs: 60_000 });

  await keyStore.keyFor(key.kid, 'RS256');
  await keyStore.keyFor(key.kid, 'RS256');
  assert.equal(fetchImpl.calls.length, 1, 'second lookup must be served from cache');
  assert.equal(keyStore._cachedKeyCount(), 1);

  clock.advance(60_000);
  await keyStore.keyFor(key.kid, 'RS256');
  assert.equal(fetchImpl.calls.length, 2, 'an expired cache must refetch');
});

test('an unknown kid triggers at most one refetch, then respects the refetch FLOOR', async () => {
  const key = makeSigningKey();
  const rotated = makeSigningKey('rotated-kid');
  const clock = fakeClock();
  let serveRotated = false;
  const fetchImpl = fakeFetch({
    'jwks.test': async () => ({ body: { keys: serveRotated ? [rotated.jwk] : [key.jwk] } }),
  });
  const keyStore = keyStoreFor(fetchImpl, clock, { minRefetchMs: 60_000 });

  await keyStore.keyFor(key.kid, 'RS256');
  assert.equal(fetchImpl.calls.length, 1);

  // Unknown kid immediately after a fetch: the floor forbids another fetch, so
  // this fails WITHOUT hammering the issuer's key endpoint.
  serveRotated = true;
  await assert.rejects(() => keyStore.keyFor(rotated.kid, 'RS256'), /no JWKS key matches/);
  assert.equal(fetchImpl.calls.length, 1, 'the refetch floor must suppress the refetch');

  // Once the floor has passed, a rotated key IS picked up.
  clock.advance(60_000);
  const imported = await keyStore.keyFor(rotated.kid, 'RS256');
  assert.equal(imported.asymmetricKeyType, 'rsa');
  assert.equal(fetchImpl.calls.length, 2);
});

test('the JWKS store refuses AMBIGUOUS and unusable keys instead of picking by position', async () => {
  const real = makeSigningKey('k1');
  const attacker = makeSigningKey('k1'); // SAME kid — a poisoned/malformed JWKS
  const clock = fakeClock();

  // Two usable keys claiming the same kid: refuse, never "first match wins"
  // (which would let response ORDER decide which key is trusted).
  const dup = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(attacker.jwk, real.jwk) }), clock, { minRefetchMs: 0 });
  await assert.rejects(() => dup.keyFor('k1', 'RS256'), /no JWKS key matches/);

  // A key pinned to a DIFFERENT alg, and an encryption-use key, are both unusable.
  const mismatched = keyStoreFor(
    fakeFetch({ 'jwks.test': jwksRoute({ ...real.jwk, alg: 'RS512' }) }),
    clock,
    { minRefetchMs: 0 },
  );
  await assert.rejects(() => mismatched.keyFor('k1', 'RS256'), /no JWKS key matches/);

  const encOnly = keyStoreFor(
    fakeFetch({ 'jwks.test': jwksRoute({ ...real.jwk, use: 'enc' }) }),
    clock,
    { minRefetchMs: 0 },
  );
  await assert.rejects(() => encOnly.keyFor('k1', 'RS256'), /no JWKS key matches/);
});

test('a kid-less token resolves only against an UNAMBIGUOUS single-key JWKS', async () => {
  const a = makeSigningKey('a');
  const b = makeSigningKey('b');
  const clock = fakeClock();

  const single = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(a.jwk) }), clock, { minRefetchMs: 0 });
  assert.equal((await single.keyFor(undefined, 'RS256')).asymmetricKeyType, 'rsa');

  const multi = keyStoreFor(fakeFetch({ 'jwks.test': jwksRoute(a.jwk, b.jwk) }), clock, { minRefetchMs: 0 });
  await assert.rejects(() => multi.keyFor(undefined, 'RS256'), /no JWKS key matches/);
});

test('stale JWKS keys are served only within a CEILING, then fail closed', async () => {
  // Revocation is signalled by a key DISAPPEARING from the JWKS. Serving stale
  // keys without a bound would let an attacker who can keep our fetch failing
  // keep a revoked key trusted forever — a fail-OPEN.
  const key = makeSigningKey();
  const clock = fakeClock();
  let down = false;
  const fetchImpl = fakeFetch({
    'jwks.test': async () => (down ? { throw: 'ECONNREFUSED' } : { body: { keys: [key.jwk] } }),
  });
  const keyStore = keyStoreFor(fetchImpl, clock, {
    cacheTtlMs: 60_000,
    maxStaleMs: 600_000,
    negativeCacheMs: 0,
  });

  await keyStore.keyFor(key.kid, 'RS256'); // warm
  down = true;

  // Past the TTL but inside the ceiling: served, so an outage does not break login.
  clock.advance(60_000 + 1);
  assert.equal((await keyStore.keyFor(key.kid, 'RS256')).asymmetricKeyType, 'rsa');

  // Past the ceiling: DENIED, even though a cached key is still in memory.
  clock.advance(600_000);
  await assert.rejects(() => keyStore.keyFor(key.kid, 'RS256'), /JWKS fetch failed/);
});

test('a failed JWKS fetch is negatively cached (no outbound amplification per request)', async () => {
  // /auth/callback is unauthenticated, so one outbound fetch per verification
  // during an IdP outage is an amplifier aimed at an already-unhealthy issuer.
  const key = makeSigningKey();
  const clock = fakeClock();
  let down = false;
  const fetchImpl = fakeFetch({
    'jwks.test': async () => (down ? { throw: 'ECONNREFUSED' } : { body: { keys: [key.jwk] } }),
  });
  const keyStore = keyStoreFor(fetchImpl, clock, {
    cacheTtlMs: 60_000,
    negativeCacheMs: 30_000,
    maxStaleMs: 600_000,
  });

  await keyStore.keyFor(key.kid, 'RS256');
  assert.equal(fetchImpl.calls.length, 1);

  down = true;
  clock.advance(60_001); // TTL lapsed
  await keyStore.keyFor(key.kid, 'RS256'); // one failed attempt, then stale
  const afterFirstFailure = fetchImpl.calls.length;
  assert.equal(afterFirstFailure, 2);

  // Three more verifications inside the negative-cache window: NO new fetches.
  await keyStore.keyFor(key.kid, 'RS256');
  await keyStore.keyFor(key.kid, 'RS256');
  await keyStore.keyFor(key.kid, 'RS256');
  assert.equal(fetchImpl.calls.length, afterFirstFailure, 'a recent failure must suppress refetching');

  // Once the window passes, it tries again (and recovers when the IdP is back).
  clock.advance(30_000);
  down = false;
  await keyStore.keyFor(key.kid, 'RS256');
  assert.ok(fetchImpl.calls.length > afterFirstFailure);
});

test('a JWKS fetch failure throws when cold, but serves STALE keys during an outage', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  let down = true;
  const fetchImpl = fakeFetch({
    'jwks.test': async () => (down ? { throw: 'ECONNREFUSED' } : { body: { keys: [key.jwk] } }),
  });
  // negativeCacheMs: 0 keeps THIS test focused on the stale fallback; the
  // negative cache has its own test above.
  const keyStore = keyStoreFor(fetchImpl, clock, { cacheTtlMs: 60_000, negativeCacheMs: 0 });

  // Cold cache + unreachable issuer: fail closed (no key ⇒ no verification).
  await assert.rejects(() => keyStore.keyFor(key.kid, 'RS256'), /JWKS fetch failed/);

  // Warm the cache, then take the issuer down and let the TTL lapse.
  down = false;
  await keyStore.keyFor(key.kid, 'RS256');
  down = true;
  clock.advance(60_000);

  // Stale keys keep logins working through the outage instead of turning every
  // unauthenticated callback into a fresh outbound fetch.
  const imported = await keyStore.keyFor(key.kid, 'RS256');
  assert.equal(imported.asymmetricKeyType, 'rsa');

  // A malformed (non-JSON / keys-less) response is also a failure, not a pass.
  const badShape = keyStoreFor(fakeFetch({ 'jwks.test': async () => ({ body: { nope: true } }) }), fakeClock());
  await assert.rejects(() => badShape.keyFor('k', 'RS256'), /no keys array/);
});

// ====================================================== provider verifiers

test('the GitHub verifier exchanges a code and uses the IMMUTABLE numeric id as subject', async () => {
  const fetchImpl = fakeFetch({
    'login/oauth/access_token': async () => ({ body: { access_token: 'gho_secret' } }),
    'api.github.com/user': async ({ options }) => {
      assert.equal(options.headers.authorization, 'Bearer gho_secret');
      return { body: { id: 4242, login: 'renamed-later' } };
    },
  });

  const verifier = createGithubOAuthVerifier({
    clientId: 'cid',
    clientSecret: 'csecret',
    redirectUri: 'https://app.test/auth/callback',
    fetchImpl,
  });

  const claims = await verifier.exchangeCode('the-code');
  // The numeric id, NOT the mutable login: a renamed GitHub user must remain the
  // same platform identity.
  assert.deepEqual(claims, { provider: 'github', subject: '4242' });

  const sent = new URLSearchParams(fetchImpl.calls[0].body);
  assert.equal(sent.get('code'), 'the-code');
  assert.equal(sent.get('client_id'), 'cid');
  assert.equal(sent.get('client_secret'), 'csecret');
  assert.equal(sent.get('redirect_uri'), 'https://app.test/auth/callback');
});

test('the GitHub verifier rejects an OAuth error and a userinfo response with no id', async () => {
  const errorFetch = fakeFetch({
    'login/oauth/access_token': async () => ({ body: { error: 'bad_verification_code' } }),
  });
  await assert.rejects(
    () => createGithubOAuthVerifier({ clientId: 'c', clientSecret: 's', fetchImpl: errorFetch }).exchangeCode('x'),
    /bad_verification_code/,
  );

  const noIdFetch = fakeFetch({
    'login/oauth/access_token': async () => ({ body: { access_token: 't' } }),
    'api.github.com/user': async () => ({ body: { login: 'nobody' } }),
  });
  await assert.rejects(
    () => createGithubOAuthVerifier({ clientId: 'c', clientSecret: 's', fetchImpl: noIdFetch }).exchangeCode('x'),
    /carried no id/,
  );
});

test('a token-endpoint failure never leaks the response body into the error', async () => {
  // The body of a token-endpoint response can contain credentials.
  const leakyFetch = fakeFetch({
    'login/oauth/access_token': async () => ({ status: 500, body: { access_token: 'SUPER_SECRET_TOKEN' } }),
  });
  await assert.rejects(
    () => createGithubOAuthVerifier({ clientId: 'c', clientSecret: 's', fetchImpl: leakyFetch }).exchangeCode('x'),
    (err) => {
      assert.match(err.message, /status 500/);
      assert.ok(!err.message.includes('SUPER_SECRET_TOKEN'), 'the token must not appear in the error');
      return true;
    },
  );
});

test('the Google verifier exchanges a code and CRYPTOGRAPHICALLY verifies the returned id_token', async () => {
  const key = makeSigningKey();
  const clock = fakeClock();
  const idToken = makeIdToken({ privateKey: key.privateKey, kid: key.kid, claims: googleClaims() });
  const fetchImpl = fakeFetch({
    'oauth2.googleapis.com/token': async () => ({ body: { id_token: idToken } }),
    'googleapis.com/oauth2/v3/certs': jwksRoute(key.jwk),
  });

  const verifier = createGoogleOidcVerifier({
    clientId: CLIENT_ID,
    clientSecret: 'gsecret',
    redirectUri: 'https://app.test/auth/callback',
    fetchImpl,
    now: clock.now,
  });

  const claims = await verifier.exchangeCode('auth-code');
  assert.equal(claims.provider, 'google');
  assert.equal(claims.subject, '1098765');

  // An id_token minted by a DIFFERENT key must be refused even coming straight
  // from the token endpoint — verification, not provenance, is what counts.
  const attacker = makeSigningKey('attacker-kid');
  const forgedFetch = fakeFetch({
    'oauth2.googleapis.com/token': async () => ({
      body: { id_token: makeIdToken({ privateKey: attacker.privateKey, kid: attacker.kid, claims: googleClaims({ sub: 'evil' }) }) },
    }),
    'googleapis.com/oauth2/v3/certs': jwksRoute(key.jwk),
  });
  await assert.rejects(
    () => createGoogleOidcVerifier({ clientId: CLIENT_ID, clientSecret: 's', fetchImpl: forgedFetch, now: clock.now }).exchangeCode('c'),
    /no JWKS key matches/,
  );
});

// ============================================== resolveIdpVerifier: FAIL-CLOSED

test('resolveIdpVerifier is FAIL-CLOSED for unset, none, unknown and PARTIAL configuration', async () => {
  // (1) Completely unset — the default deployment posture.
  const unset = resolveIdpVerifier({});
  assert.equal(unset.configured, false);
  assert.equal(unset.provider, null);
  await assert.rejects(() => unset.verifier.verifyIdToken('anything'), /no identity provider configured/);
  await assert.rejects(() => unset.verifier.exchangeCode('anything'), /no identity provider configured/);

  // (2) Explicitly disabled.
  assert.equal(resolveIdpVerifier({ OIDC_PROVIDER: 'none' }).configured, false);

  // (3) Unknown provider name, and a prototype-chain name that must NOT resolve.
  for (const name of ['facebook', 'constructor', '__proto__', 'toString']) {
    const r = resolveIdpVerifier({
      OIDC_PROVIDER: name,
      OIDC_CLIENT_ID: 'a',
      OIDC_CLIENT_SECRET: 'b',
      OIDC_REDIRECT_URI: 'https://app.test/cb',
    });
    assert.equal(r.configured, false, `${name} must not configure a verifier`);
    await assert.rejects(() => r.verifier.exchangeCode('x'), /OIDC_PROVIDER/);
  }

  // (4) PARTIAL configuration must NOT half-open the door, and must name what is
  // missing so an operator can fix it.
  const partial = resolveIdpVerifier({ OIDC_PROVIDER: 'github', OIDC_CLIENT_ID: 'cid' });
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.missing, ['OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI']);
  await assert.rejects(() => partial.verifier.exchangeCode('x'), /login stays closed/);

  // (5) Whitespace-only values are empty, not configuration.
  const blank = resolveIdpVerifier({
    OIDC_PROVIDER: 'github',
    OIDC_CLIENT_ID: '   ',
    OIDC_CLIENT_SECRET: '\t',
    OIDC_REDIRECT_URI: ' ',
  });
  assert.equal(blank.configured, false);
  assert.deepEqual(blank.missing, ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI']);
});

test('resolveIdpVerifier refuses a half or plaintext issuer/JWKS override', async () => {
  const base = {
    OIDC_PROVIDER: 'google',
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'gsecret',
    OIDC_REDIRECT_URI: 'https://app.test/cb',
  };

  // An issuer without its key endpoint (or vice versa) would trust one party's
  // issuer name with another party's signing keys.
  const issuerOnly = resolveIdpVerifier({ ...base, OIDC_ISSUER: 'https://idp.test' });
  assert.equal(issuerOnly.configured, false);
  assert.match(issuerOnly.reason, /must be set together/);

  const jwksOnly = resolveIdpVerifier({ ...base, OIDC_JWKS_URI: 'https://idp.test/jwks' });
  assert.equal(jwksOnly.configured, false);
  assert.match(jwksOnly.reason, /must be set together/);

  // Plaintext key material is attacker-controllable.
  const plaintext = resolveIdpVerifier({
    ...base,
    OIDC_ISSUER: 'http://idp.test',
    OIDC_JWKS_URI: 'http://idp.test/jwks',
  });
  assert.equal(plaintext.configured, false);
  await assert.rejects(() => plaintext.verifier.verifyIdToken('x'), /https/);

  // Both, over https: accepted.
  const ok = resolveIdpVerifier({
    ...base,
    OIDC_ISSUER: 'https://idp.test',
    OIDC_JWKS_URI: 'https://idp.test/jwks',
  });
  assert.equal(ok.configured, true);
});

test('every SUPPORTED_IDP_PROVIDERS entry has an EXPLICIT verifier branch (no catch-all)', () => {
  // Guards a latent fail-open-shaped defect: the provider allow-list lives in
  // identity.js, so that is where someone will register a new provider. If this
  // dispatch ended in `else { google }`, a newly listed provider would silently
  // become a Google verifier and stamp its accounts `google:<sub>`, colliding two
  // providers' subject namespaces. Each listed provider must resolve to ITSELF.
  for (const name of SUPPORTED_IDP_PROVIDERS) {
    const r = resolveIdpVerifier({
      OIDC_PROVIDER: name,
      OIDC_CLIENT_ID: 'cid',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_REDIRECT_URI: 'https://app.test/cb',
    });
    assert.equal(r.configured, true, `${name} is listed as supported but resolves no verifier`);
    assert.equal(r.provider, name, `${name} must resolve to its OWN verifier, not another provider's`);
  }
});

test('resolveIdpVerifier builds a REAL verifier once the environment is complete', () => {
  const gh = resolveIdpVerifier({
    OIDC_PROVIDER: 'github',
    OIDC_CLIENT_ID: 'cid',
    OIDC_CLIENT_SECRET: 'csecret',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  });
  assert.equal(gh.configured, true);
  assert.equal(gh.provider, 'github');
  assert.equal(typeof gh.verifier.exchangeCode, 'function');

  const google = resolveIdpVerifier({
    OIDC_PROVIDER: 'google',
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'gsecret',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  });
  assert.equal(google.configured, true);
  assert.equal(google.provider, 'google');
  assert.equal(typeof google.verifier.verifyIdToken, 'function');
});

// ================================ REAL AuthService integration (the actual gap)

test('a real verifier resolves a REAL User_Account through the REAL AuthService', async () => {
  const fetchImpl = fakeFetch({
    'login/oauth/access_token': async () => ({ body: { access_token: 'tok' } }),
    'api.github.com/user': async () => ({ body: { id: 777 } }),
  });
  // The REAL AuthService + IdentityManager + SessionManager — no auth fakes.
  const authService = createAuthService({
    idpVerifier: createGithubOAuthVerifier({ clientId: 'c', clientSecret: 's', fetchImpl }),
  });

  const { account, denied } = await authService.authenticate({ code: 'abc' });
  assert.ok(!denied, 'a valid code must NOT be denied (this is the gap being closed)');
  // authIdentity is derived as "<provider>:<subject>" and no password exists.
  assert.equal(account.authIdentity, 'github:777');
  assert.equal(account.password, undefined);

  // The session token really verifies through the real SessionManager.
  const session = authService.scopeSession(account);
  assert.equal(authService.tryVerifySession(session.token).accountId, account.id);

  // Second login for the SAME identity reuses the SAME account (no duplicate).
  const again = await authService.authenticate({ code: 'def' });
  assert.equal(again.account.id, account.id);
});

test('the fail-closed verifier denies through the REAL AuthService (unconfigured deploy stays shut)', async () => {
  const authService = createAuthService({ idpVerifier: resolveIdpVerifier({}).verifier });
  assert.deepEqual(await authService.authenticate({ code: 'x' }), { denied: true });
  assert.deepEqual(await authService.authenticate({ idToken: 'y' }), { denied: true });
});

// ================================================================ login flow

/** A login flow over a fake GitHub, on an injected clock. */
function makeFlow({ clock = fakeClock(), subject = 4242, extra = {} } = {}) {
  const fetchImpl = fakeFetch({
    'login/oauth/access_token': async () => ({ body: { access_token: 'tok' } }),
    'api.github.com/user': async () => ({ body: { id: subject } }),
  });
  const authService = createAuthService({
    idpVerifier: createGithubOAuthVerifier({ clientId: 'cid', clientSecret: 'csecret', fetchImpl }),
    now: clock.now,
  });
  const loginFlow = createLoginFlow({
    authService,
    provider: 'github',
    clientId: 'cid',
    redirectUri: 'https://app.test/auth/callback',
    now: clock.now,
    ...extra,
  });
  return { authService, loginFlow, clock };
}

test('beginLogin builds an authorize URL and a browser-binding cookie', () => {
  const { loginFlow } = makeFlow();
  const { url, state, cookie } = loginFlow.beginLogin();

  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, IDP_PROVIDERS.github.authorizeUrl);
  assert.equal(parsed.searchParams.get('client_id'), 'cid');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app.test/auth/callback');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('state'), state);
  assert.equal(parsed.searchParams.get('scope'), IDP_PROVIDERS.github.defaultScope);

  // The cookie carries the nonce; the STATE carries only its hash, so a state
  // seen in a URL/Referer/log cannot be turned into the cookie it needs.
  // (https ⇒ the __Host- prefixed name; see the dedicated prefix test.)
  assert.equal(cookie.name, `__Host-${LOGIN_STATE_COOKIE}`);
  assert.ok(cookie.value.length >= 20, 'the nonce must be unguessable');
  assert.ok(!state.includes(cookie.value), 'the state must NOT contain the raw nonce');
  assert.equal(cookie.secure, true, 'an https redirect URI must yield a Secure cookie');
});

test('LOGIN CSRF: a state is useless without the matching browser cookie', async () => {
  const { loginFlow } = makeFlow();

  // The attacker starts a login and keeps the state + their own code.
  const attacker = loginFlow.beginLogin();

  // The victim is fed the attacker's callback URL. Their browser has NO cookie
  // for this login...
  const unbound = await loginFlow.completeLogin({ code: 'attacker-code', state: attacker.state });
  assert.equal(unbound.ok, false);
  assert.equal(unbound.code, 'STATE_UNBOUND');

  // ...or a cookie from a DIFFERENT login of their own.
  const victimOwn = loginFlow.beginLogin();
  const mismatched = await loginFlow.completeLogin({
    code: 'attacker-code',
    state: attacker.state,
    cookieNonce: victimOwn.cookie.value,
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, 'STATE_MISMATCH');

  // Only the browser that started THAT login can complete it.
  const ok = await loginFlow.completeLogin({
    code: 'code',
    state: attacker.state,
    cookieNonce: attacker.cookie.value,
  });
  assert.equal(ok.ok, true);
});

test('a forged or tampered state fails its HMAC (not just an unknown-set lookup)', async () => {
  const { loginFlow } = makeFlow();
  const { cookie } = loginFlow.beginLogin();

  // Entirely made up.
  assert.equal((await loginFlow.completeLogin({ code: 'c', state: 'forged', cookieNonce: cookie.value })).code, 'STATE_INVALID');

  // A well-formed state whose payload was edited (extended TTL) but not re-signed.
  const payload = Buffer.from(JSON.stringify({ h: 'x', t: Date.now() }), 'utf8').toString('base64url');
  assert.equal(
    (await loginFlow.completeLogin({ code: 'c', state: `${payload}.badsig`, cookieNonce: cookie.value })).code,
    'STATE_INVALID',
  );
});

test('login state is SINGLE-USE and expires on the injected clock', async () => {
  const clock = fakeClock();
  const { loginFlow } = makeFlow({ clock, extra: { stateTtlMs: 600_000 } });

  const first = loginFlow.beginLogin();
  const ok = await loginFlow.completeLogin({ code: 'c', state: first.state, cookieNonce: first.cookie.value });
  assert.equal(ok.ok, true);
  assert.equal(typeof ok.token, 'string');

  // REPLAY of the same callback must not mint a second session.
  const replay = await loginFlow.completeLogin({ code: 'c', state: first.state, cookieNonce: first.cookie.value });
  assert.equal(replay.code, 'STATE_INVALID');

  // Expiry is measured on the injected clock — no real waiting.
  const stale = loginFlow.beginLogin();
  clock.advance(600_001);
  const expired = await loginFlow.completeLogin({ code: 'c', state: stale.state, cookieNonce: stale.cookie.value });
  assert.equal(expired.code, 'STATE_EXPIRED');
});

test('an unauthenticated /auth/login FLOOD cannot break an in-flight login', async () => {
  // Regression guard: an earlier design kept pending states in a capped map and
  // evicted the OLDEST, so a burst of unauthenticated login starts destroyed the
  // login of whoever was on the consent screen. The stateless state has no shared
  // capacity to contend over.
  const { loginFlow } = makeFlow();
  const victim = loginFlow.beginLogin();

  for (let i = 0; i < 5000; i += 1) loginFlow.beginLogin();

  const ok = await loginFlow.completeLogin({ code: 'c', state: victim.state, cookieNonce: victim.cookie.value });
  assert.equal(ok.ok, true, 'a flood of login starts must not invalidate a pending login');
  // Nothing was retained for any of those 5001 starts; only the completed one.
  assert.equal(loginFlow.consumedCount(), 1);
});

test('completeLogin surfaces an IdP denial as AUTH_DENIED without leaking the cause', async () => {
  const clock = fakeClock();
  const flow = createLoginFlow({
    authService: createAuthService({
      idpVerifier: { async exchangeCode() { throw new Error('idp said no: secret-detail'); } },
      now: clock.now,
    }),
    provider: 'google',
    clientId: 'cid',
    redirectUri: 'https://app.test/cb',
    now: clock.now,
  });

  const { state, cookie } = flow.beginLogin();
  const denied = await flow.completeLogin({ code: 'c', state, cookieNonce: cookie.value });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'AUTH_DENIED');
  assert.equal(denied.message, 'access denied');
  assert.ok(!JSON.stringify(denied).includes('secret-detail'));
});

test('createLoginFlow and resolveLoginFlow reject prototype-chain provider names', () => {
  const authService = createAuthService({ idpVerifier: { async exchangeCode() { return { provider: 'github', subject: 's' }; } } });

  // A bare `IDP_PROVIDERS[provider]` lookup would accept these and build a flow
  // with an undefined authorize endpoint — a routed login surface that 500s.
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.throws(
      () => createLoginFlow({ authService, provider: name, clientId: 'c', redirectUri: 'https://a.test/cb' }),
      /provider must be one of/,
      `${name} must be refused`,
    );
    assert.equal(
      resolveLoginFlow(
        { OIDC_PROVIDER: name, OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b', OIDC_REDIRECT_URI: 'https://a.test/cb' },
        { authService },
      ),
      null,
      `${name} must not resolve a flow`,
    );
  }
});

test('resolveLoginFlow returns null unless the environment is COMPLETE', () => {
  const authService = createAuthService({ idpVerifier: { async exchangeCode() { return { provider: 'github', subject: 's' }; } } });
  assert.equal(resolveLoginFlow({}, { authService }), null);
  assert.equal(resolveLoginFlow({ OIDC_PROVIDER: 'github' }, { authService }), null);
  assert.equal(
    resolveLoginFlow({ OIDC_PROVIDER: 'github', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b' }, { authService }),
    null,
    'a missing redirect URI must not produce a login surface',
  );

  const flow = resolveLoginFlow(
    { OIDC_PROVIDER: 'github', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b', OIDC_REDIRECT_URI: 'https://app.test/cb' },
    { authService },
  );
  assert.ok(flow, 'a complete environment must produce a login flow');
  assert.equal(flow.provider, 'github');
});

// ==================================== HTTP surface: login -> token -> gated route

/** A REAL Builder Server on an ephemeral loopback port. */
async function startServer(opts) {
  const api = createBuilderServer({ provider: createScriptedProvider([]), ...opts });
  const { port, host } = await api.listen(0, '127.0.0.1');
  return { api, base: `http://${host}:${port}`, close: () => api.close() };
}

/** Drive GET /auth/login and return { state, cookiePair } as a browser would. */
async function beginLoginOverHttp(base) {
  const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'the login redirect must set the binding cookie');
  return {
    res,
    state: new URL(res.headers.get('location')).searchParams.get('state'),
    cookiePair: setCookie.split(';')[0],
    setCookie,
  };
}

test('GET /auth/login redirects to the identity provider with a bound cookie', async () => {
  const { loginFlow, authService } = makeFlow();
  const { base, close } = await startServer({ authService, loginFlow });
  try {
    const { res, state, setCookie } = await beginLoginOverHttp(base);
    const location = new URL(res.headers.get('location'));
    assert.equal(`${location.origin}${location.pathname}`, IDP_PROVIDERS.github.authorizeUrl);
    assert.ok(state, 'the redirect must carry a CSRF state');
    // The cookie must be script-inaccessible and not sent on cross-site
    // subrequests, and neither it nor the redirect may be cached.
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    assert.match(res.headers.get('cache-control'), /no-store/);
  } finally {
    await close();
  }
});

test('END TO END: /auth/callback mints a token that OPENS a gated route', async () => {
  const { loginFlow, authService } = makeFlow();
  const { base, close } = await startServer({ authService, loginFlow });
  try {
    // Before logging in, the gated route is closed.
    assert.equal((await fetch(`${base}/work-mode?projectId=p1`)).status, 401);

    // Drive the real round-trip: /auth/login issues state+cookie, the IdP would
    // redirect back with (code, state) — which is exactly what we request here,
    // presenting the cookie the way a browser does.
    const { state, cookiePair } = await beginLoginOverHttp(base);
    const cb = await fetch(`${base}/auth/callback?code=real-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookiePair },
    });

    assert.equal(cb.status, 200);
    const body = await cb.json();
    assert.equal(body.tokenType, 'Bearer');
    assert.equal(typeof body.token, 'string');
    assert.ok(body.accountId);
    // A minted token must never be cached, and the spent cookie is cleared.
    assert.match(cb.headers.get('cache-control'), /no-store/);
    assert.match(cb.headers.get('set-cookie'), /Max-Age=0/);

    // THE POINT OF THE WHOLE UNIT: that token authenticates a real gated request.
    const gated = await fetch(`${base}/work-mode?projectId=p1`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    assert.equal(gated.status, 200, 'the freshly minted token must open a gated route');
    // Assert the real payload, not merely truthiness: /work-mode reports the
    // Session's active Work_Mode, which defaults to 'vibe', plus its choices.
    const mode = await gated.json();
    assert.equal(mode.mode, 'vibe');
    assert.ok(Array.isArray(mode.choices) && mode.choices.length > 0);

    // The account really exists in the store the AuthService owns.
    const accounts = authService._identity.accountStore.all();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].authIdentity, 'github:4242');
  } finally {
    await close();
  }
});

test('LOGIN CSRF over HTTP: an attacker-supplied callback URL is refused', async () => {
  const { loginFlow, authService } = makeFlow();
  const { base, close } = await startServer({ authService, loginFlow });
  try {
    // The attacker starts a login and keeps the state (their browser holds the
    // matching cookie; the victim's browser does not).
    const attacker = await beginLoginOverHttp(base);

    // The victim follows the attacker's callback URL WITHOUT the cookie.
    const victim = await fetch(`${base}/auth/callback?code=attacker-code&state=${encodeURIComponent(attacker.state)}`);
    assert.equal(victim.status, 400);
    assert.equal((await victim.json()).code, 'STATE_UNBOUND');

    // No session was minted for anyone, and no account was created.
    assert.equal(authService._identity.accountStore.all().length, 0);
  } finally {
    await close();
  }
});

test('COOKIE TOSSING: a duplicated login cookie is refused, not resolved by order', async () => {
  // Cookies sharing a name but set by different origins/paths are ALL sent, and
  // the browser orders them by path specificity. If the server read the FIRST
  // match, an attacker able to set a cookie on this domain (a sibling subdomain,
  // or any plaintext origin on it) could place their nonce ahead of the victim's
  // and have the victim's browser complete the ATTACKER's login.
  const attackerFlow = makeFlow({ subject: 999 });
  const { loginFlow, authService } = makeFlow({ subject: 4242 });
  const { base, close } = await startServer({ authService, loginFlow });
  try {
    const victim = await beginLoginOverHttp(base);
    const attacker = await beginLoginOverHttp(base);
    const name = loginFlow.cookieName;
    const victimNonce = victim.cookiePair.slice(name.length + 1);
    const attackerNonce = attacker.cookiePair.slice(name.length + 1);

    // The attacker's nonce ordered FIRST, with the victim's real cookie present.
    const shadowed = await fetch(`${base}/auth/callback?code=c&state=${encodeURIComponent(attacker.state)}`, {
      headers: { cookie: `${name}=${attackerNonce}; ${name}=${victimNonce}` },
    });
    assert.equal(shadowed.status, 400, 'an ambiguous cookie must not authorize a login');
    assert.equal((await shadowed.json()).code, 'STATE_UNBOUND');

    // ...and the reverse order is equally refused: ambiguity itself is the signal.
    const reversed = await fetch(`${base}/auth/callback?code=c&state=${encodeURIComponent(attacker.state)}`, {
      headers: { cookie: `${name}=${victimNonce}; ${name}=${attackerNonce}` },
    });
    assert.equal(reversed.status, 400);

    // No session was minted and no account created by either attempt.
    assert.equal(authService._identity.accountStore.all().length, 0);
    void attackerFlow;
  } finally {
    await close();
  }
});

test('an https deployment uses the __Host- cookie prefix (browser-enforced binding)', () => {
  // __Host- forbids a Domain attribute, so a sibling subdomain cannot mint a
  // cookie by this name for our host at all.
  const { loginFlow } = makeFlow();
  assert.equal(loginFlow.cookieName, '__Host-aab_login_state');
  assert.equal(loginFlow.cookieSecure, true);

  // A loopback dev deploy cannot use __Host- (it requires Secure), so it falls
  // back to the bare name and relies on the exactly-one-match parser.
  const local = createLoginFlow({
    authService: createAuthService({ idpVerifier: { async exchangeCode() { return { provider: 'github', subject: 's' }; } } }),
    provider: 'github',
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:8080/auth/callback',
  });
  assert.equal(local.cookieName, LOGIN_STATE_COOKIE);
  assert.equal(local.cookieSecure, false);
});

test('an unvalidated /auth/callback does NOT clear an in-flight login cookie', async () => {
  // Otherwise any cross-site GET to /auth/callback becomes a way to cancel a
  // victim's login.
  const { loginFlow, authService } = makeFlow();
  const { base, close } = await startServer({ authService, loginFlow });
  try {
    // An IdP-error callback proves nothing about who sent it.
    const errored = await fetch(`${base}/auth/callback?error=access_denied`);
    assert.equal(errored.status, 401);
    assert.equal(errored.headers.get('set-cookie'), null, 'must not clear a cookie it did not validate');

    // A forged state likewise.
    const forged = await fetch(`${base}/auth/callback?code=c&state=nope`);
    assert.equal(forged.status, 400);
    assert.equal(forged.headers.get('set-cookie'), null);

    // A VALIDATED callback does clear it, with the attributes mirrored.
    const { state, cookiePair } = await beginLoginOverHttp(base);
    const ok = await fetch(`${base}/auth/callback?code=c&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookiePair },
    });
    assert.equal(ok.status, 200);
    const cleared = ok.headers.get('set-cookie');
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /Secure/, 'the deletion must mirror Secure or it cannot overwrite the cookie');
  } finally {
    await close();
  }
});

test('resolveIdpVerifier refuses a plaintext non-loopback OIDC_REDIRECT_URI', async () => {
  // The whole CSRF binding rests on a Secure cookie, and a plaintext callback
  // exposes the authorization code itself.
  const base = { OIDC_PROVIDER: 'github', OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'secret' };

  const plaintext = resolveIdpVerifier({ ...base, OIDC_REDIRECT_URI: 'http://app.example.com/auth/callback' });
  assert.equal(plaintext.configured, false);
  assert.deepEqual(plaintext.missing, ['OIDC_REDIRECT_URI']);
  await assert.rejects(() => plaintext.verifier.exchangeCode('x'), /https/);

  // Loopback http is exempt (local development has no TLS and no network attacker).
  assert.equal(resolveIdpVerifier({ ...base, OIDC_REDIRECT_URI: 'http://127.0.0.1:8080/auth/callback' }).configured, true);
  assert.equal(resolveIdpVerifier({ ...base, OIDC_REDIRECT_URI: 'http://localhost:8080/auth/callback' }).configured, true);
  // https anywhere is fine; a non-URL is not.
  assert.equal(resolveIdpVerifier({ ...base, OIDC_REDIRECT_URI: 'https://app.example.com/auth/callback' }).configured, true);
  assert.equal(resolveIdpVerifier({ ...base, OIDC_REDIRECT_URI: 'not-a-url' }).configured, false);
});

test('a configured OIDC_STATE_SIGNING_KEY makes states survive a flow rebuild (restart)', async () => {
  // Without a stable key, every restart invalidates in-flight logins and two
  // replicas reject each other's states.
  const env = {
    OIDC_PROVIDER: 'github',
    OIDC_CLIENT_ID: 'cid',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    // >= MIN_STATE_SIGNING_KEY_CHARS, or it would be ignored as too weak.
    OIDC_STATE_SIGNING_KEY: 'a-stable-shared-key-for-both-instances-32+',
  };
  const idp = { async exchangeCode() { return { provider: 'github', subject: 'user-1' }; } };

  const first = resolveLoginFlow(env, { authService: createAuthService({ idpVerifier: idp }) });
  const begun = first.beginLogin();

  // A SECOND flow (a restarted process / another replica) with the same key.
  const second = resolveLoginFlow(env, { authService: createAuthService({ idpVerifier: idp }) });
  const acrossRestart = await second.completeLogin({
    code: 'c',
    state: begun.state,
    cookieNonce: begun.cookie.value,
  });
  assert.equal(acrossRestart.ok, true, 'a shared signing key must validate the other instance\'s state');

  // Without the shared key, the other instance cannot validate it.
  const { OIDC_STATE_SIGNING_KEY: _drop, ...noKey } = env;
  const isolated = resolveLoginFlow(noKey, { authService: createAuthService({ idpVerifier: idp }) });
  const rejected = await isolated.completeLogin({
    code: 'c',
    state: begun.state,
    cookieNonce: begun.cookie.value,
  });
  assert.equal(rejected.code, 'STATE_INVALID');
});

test('resolveLoginFlow independently refuses a plaintext redirect URI', () => {
  // Defence in depth: the flow must not mint a non-Secure/non-__Host- cookie even
  // if it were reached without the entry point's gate on the verifier.
  const authService = createAuthService({ idpVerifier: { async exchangeCode() { return { provider: 'github', subject: 's' }; } } });
  const env = (redirect) => ({
    OIDC_PROVIDER: 'github',
    OIDC_CLIENT_ID: 'cid',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: redirect,
  });
  assert.equal(resolveLoginFlow(env('http://app.example.com/auth/callback'), { authService }), null);
  assert.ok(resolveLoginFlow(env('https://app.example.com/auth/callback'), { authService }));
  assert.ok(resolveLoginFlow(env('http://localhost:8080/auth/callback'), { authService }));
});

test('a too-short OIDC_STATE_SIGNING_KEY is ignored rather than silently weakening state signing', async () => {
  const authService = createAuthService({ idpVerifier: { async exchangeCode() { return { provider: 'github', subject: 's' }; } } });
  const env = (key) => ({
    OIDC_PROVIDER: 'github',
    OIDC_CLIENT_ID: 'cid',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'https://app.test/cb',
    OIDC_STATE_SIGNING_KEY: key,
  });

  // A weak key must NOT be adopted: two flows configured with the same short key
  // must not validate each other's states (proving neither used it).
  const weak = 'hunter2';
  assert.ok(weak.length < 32);
  const a = resolveLoginFlow(env(weak), { authService });
  const b = resolveLoginFlow(env(weak), { authService });
  const begun = a.beginLogin();
  const cross = await b.completeLogin({ code: 'c', state: begun.state, cookieNonce: begun.cookie.value });
  assert.equal(cross.code, 'STATE_INVALID', 'a sub-floor key must be ignored, not used');

  // A key at/above the floor IS adopted (the shared-key test above covers reuse).
  const strong = 'x'.repeat(32);
  const c = resolveLoginFlow(env(strong), { authService });
  const d = resolveLoginFlow(env(strong), { authService });
  const begun2 = c.beginLogin();
  const ok = await d.completeLogin({ code: 'c', state: begun2.state, cookieNonce: begun2.cookie.value });
  assert.equal(ok.ok, true);
});

test('IDP_VERIFIER_PROVIDERS and SUPPORTED_IDP_PROVIDERS agree exactly (no list drift)', () => {
  // The dispatch table is the single source of truth; identity.js's platform list
  // must not drift from it, or a provider could be "supported" with no branch.
  assert.deepEqual([...IDP_VERIFIER_PROVIDERS].sort(), [...SUPPORTED_IDP_PROVIDERS].sort());
});

test('/auth/callback rejects a forged state and an IdP error redirect (no-store on every path)', async () => {
  const { loginFlow, authService } = makeFlow();
  const { base, close } = await startServer({ authService, loginFlow });
  try {
    const { cookiePair } = await beginLoginOverHttp(base);

    const forged = await fetch(`${base}/auth/callback?code=c&state=never-issued`, {
      headers: { cookie: cookiePair },
    });
    assert.equal(forged.status, 400);
    assert.equal((await forged.json()).code, 'STATE_INVALID');
    // The request URL carried code+state, so no correlated response may be cached.
    assert.match(forged.headers.get('cache-control'), /no-store/);

    // The IdP redirects back with an error (user cancelled): a denial, and the
    // IdP's text is not echoed back.
    const errored = await fetch(`${base}/auth/callback?error=access_denied&error_description=nope`);
    assert.equal(errored.status, 401);
    const body = await errored.json();
    assert.deepEqual(body, { error: 'access denied' });
    assert.ok(!JSON.stringify(body).includes('nope'));
    assert.match(errored.headers.get('cache-control'), /no-store/);
  } finally {
    await close();
  }
});

test('with NO loginFlow injected the /auth routes are not routed at all (strictly additive)', async () => {
  const { base, close } = await startServer({
    authService: createAuthService({ idpVerifier: resolveIdpVerifier({}).verifier }),
  });
  try {
    // 405, exactly as any unknown path — an unconfigured deploy advertises no
    // login surface it could not honor.
    assert.equal((await fetch(`${base}/auth/login`, { redirect: 'manual' })).status, 405);
    assert.equal((await fetch(`${base}/auth/callback?code=c&state=s`)).status, 405);
    // The pre-existing surface is untouched.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await close();
  }
});

test('POST to the login routes is not routed (GET-only surface)', async () => {
  const { loginFlow, authService } = makeFlow();
  const { base, close } = await startServer({ authService, loginFlow });
  try {
    assert.equal((await fetch(`${base}/auth/login`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/auth/callback`, { method: 'POST' })).status, 405);
  } finally {
    await close();
  }
});

// ============================ the ENTRY POINT wires login from the environment

test('startPlatformServer routes /auth/login when OIDC_* is complete, and not when it is not', async () => {
  // A COMPLETE environment: the entry point must resolve a real verifier AND a
  // login flow, and hand the flow to the server. No network is touched — the
  // authorize redirect is built locally.
  const logs = [];
  const configured = await startPlatformServer({
    env: {
      PORT: '0',
      HOST: '127.0.0.1',
      OIDC_PROVIDER: 'github',
      OIDC_CLIENT_ID: 'cid',
      OIDC_CLIENT_SECRET: 'csecret',
      OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    },
    logger: { log: (m) => logs.push(m) },
  });
  try {
    const res = await fetch(`http://${configured.address.host}:${configured.address.port}/auth/login`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302, 'a configured deploy must expose the login redirect');
    assert.ok(new URL(res.headers.get('location')).href.startsWith(IDP_PROVIDERS.github.authorizeUrl));
    assert.ok(logs.some((m) => /github login enabled/.test(m)), `got ${JSON.stringify(logs)}`);
  } finally {
    await configured.api.close();
  }

  // An UNCONFIGURED environment: same entry point, no login surface at all.
  const unconfigured = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1' },
    logger: { log: () => {} },
  });
  try {
    const res = await fetch(`http://${unconfigured.address.host}:${unconfigured.address.port}/auth/login`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 405, 'an unconfigured deploy must expose no login surface');
  } finally {
    await unconfigured.api.close();
  }
});

test('startPlatformServer does NOT route login when the verifier failed closed', async () => {
  // The two resolvers must not disagree. This env is chosen so the disagreement
  // is REAL: all three credentials are present (so resolveLoginFlow, which never
  // looks at OIDC_ISSUER, happily builds a flow) while the VERIFIER fails closed
  // on the half issuer/JWKS override. Only the entry point's gate on the
  // verifier's verdict keeps /auth/* unrouted here — with a partial-credentials
  // env instead, resolveLoginFlow would return null on its own and the gate would
  // not be exercised at all.
  const logs = [];
  const { api, address } = await startPlatformServer({
    env: {
      PORT: '0',
      HOST: '127.0.0.1',
      OIDC_PROVIDER: 'google',
      OIDC_CLIENT_ID: 'cid',
      OIDC_CLIENT_SECRET: 'csecret',
      OIDC_REDIRECT_URI: 'https://app.test/cb',
      OIDC_ISSUER: 'https://idp.test', // ...with no OIDC_JWKS_URI ⇒ verifier closed
    },
    logger: { log: (m) => logs.push(m) },
  });
  try {
    assert.equal((await fetch(`http://${address.host}:${address.port}/auth/login`, { redirect: 'manual' })).status, 405);
    assert.ok(logs.some((m) => /LOGIN DISABLED/.test(m)), `got ${JSON.stringify(logs)}`);
    // ...and it must NOT simultaneously claim a working callback.
    assert.ok(!logs.some((m) => /login callback expects/.test(m)), `contradictory logs: ${JSON.stringify(logs)}`);
  } finally {
    await api.close();
  }
});

test('a plaintext OIDC_REDIRECT_URI leaves the whole login surface unrouted end to end', async () => {
  // docs/DEPLOY.md states a plaintext-callback deploy denies every login; assert it
  // at the running-server level, not just at the resolver.
  const logs = [];
  const { api, address } = await startPlatformServer({
    env: {
      PORT: '0',
      HOST: '127.0.0.1',
      OIDC_PROVIDER: 'github',
      OIDC_CLIENT_ID: 'cid',
      OIDC_CLIENT_SECRET: 'csecret',
      OIDC_REDIRECT_URI: 'http://app.example.com/auth/callback', // plaintext, not loopback
    },
    logger: { log: (m) => logs.push(m) },
  });
  try {
    assert.equal((await fetch(`http://${address.host}:${address.port}/auth/login`, { redirect: 'manual' })).status, 405);
    assert.equal((await fetch(`http://${address.host}:${address.port}/auth/callback?code=c&state=s`)).status, 405);
    // The health probe still answers — the process is up, login is simply closed.
    assert.equal((await fetch(`http://${address.host}:${address.port}/healthz`)).status, 200);
    assert.ok(logs.some((m) => /LOGIN DISABLED/.test(m) && /https/.test(m)), `got ${JSON.stringify(logs)}`);
  } finally {
    await api.close();
  }
});
