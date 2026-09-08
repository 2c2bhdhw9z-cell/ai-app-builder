/**
 * Property-based test for Web UI Task 8.7 (node --test).
 *
 * Property 22 — "No Login_Flow request carries a PKCE code verifier"
 * (design §"Property 22", Req 6.8). Exact spec tag:
 *
 *   "Feature: web-ui, Property 22: No Login_Flow request carries a PKCE code
 *    verifier"
 *
 * SCOPE. For ANY request the client issues as part of the Login_Flow, the
 * request carries NO PKCE parameter (`code_verifier`, `code_challenge`,
 * `code_challenge_method`, or a bare `pkce`) — neither in the navigation URL
 * (GET /auth/login), nor in the /auth/callback request (URL query, headers, or
 * body). The client relies SOLELY on the backend's cookie-bound `state`
 * (design §"Login returns a raw bearer token … there is no PKCE").
 *
 * REAL COLLABORATORS. The test drives the REAL auth controller
 * (createAuthController) with an injected `navigate` spy and a REAL api client
 * (createApiClient) built over an injected `fetchImpl` that CAPTURES the exact
 * outgoing request (url, headers, body). It asserts against:
 *   (a) login() and restart() — the navigation seam receives a /auth/login URL
 *       with no PKCE query parameter and no PKCE body; and
 *   (b) completeLoginFromQuery(...) — the GET /auth/callback the client issues
 *       carries no PKCE param in its URL query and no PKCE field anywhere
 *       (headers or body) in the request.
 *
 * The generated callback `query` deliberately mixes in the IdP-authored `code`
 * and `state` params (which ARE expected — `code` is the OAuth authorization
 * code, NOT a PKCE verifier), plus adversarial extra params, so the test proves
 * the client never SYNTHESIZES a PKCE verifier and never smuggles one through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createTokenStore } from '../src/server/public/token-store.js';
import { createAuthController, LOGIN_PATH, CALLBACK_PATH } from '../src/server/public/auth.js';
import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

const NOW = Date.parse('2024-06-01T00:00:00.000Z');
const now = () => NOW;

/**
 * The PKCE parameter names that MUST NEVER appear in any Login_Flow request.
 * `code_verifier`/`code_challenge`/`code_challenge_method` are the RFC 7636
 * PKCE fields; `pkce` is a catch-all. Note `code` (the OAuth authorization
 * code) is deliberately NOT in this set — it is the IdP's grant, not a PKCE
 * verifier, and the callback legitimately carries it.
 */
const PKCE_PARAMS = ['code_verifier', 'code_challenge', 'code_challenge_method', 'pkce'];

/** True iff a query/URL string carries any PKCE parameter as its OWN key. */
function urlHasPkce(url) {
  const qIndex = url.indexOf('?');
  const search = qIndex >= 0 ? url.slice(qIndex) : '';
  const params = new URLSearchParams(search);
  return PKCE_PARAMS.some((p) => params.has(p));
}

/** Deeply scan any request artifact (object/string) for a PKCE field/token. */
function artifactHasPkce(value) {
  if (value == null) return false;
  if (typeof value === 'string') {
    // A serialized body (e.g. JSON) that names a PKCE field.
    return PKCE_PARAMS.some((p) => value.includes(p));
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (PKCE_PARAMS.includes(k)) return true;
      if (artifactHasPkce(v)) return true;
    }
    return false;
  }
  return false;
}

/** Assert an entire captured fetch request (url/headers/body) is PKCE-free. */
function assertRequestPkceFree(captured, label) {
  assert.ok(captured, `${label}: a request was issued`);
  assert.equal(urlHasPkce(String(captured.url)), false, `${label}: URL query carries no PKCE param`);
  assert.equal(artifactHasPkce(captured.init && captured.init.headers), false, `${label}: headers carry no PKCE field`);
  assert.equal(artifactHasPkce(captured.init && captured.init.body), false, `${label}: body carries no PKCE field`);
}

function makeSetup() {
  const store = createStore();
  const tokenStore = createTokenStore({ now, storage: null });
  let captured = null;
  const api = createApiClient({
    getToken: () => tokenStore.getToken(),
    fetchImpl: async (url, init) => {
      captured = { url, init };
      // Return a benign 200 so completeLoginFromQuery resolves; the shape is
      // irrelevant to the PKCE assertions (we inspect the REQUEST, not reply).
      return {
        status: 200,
        json: async () => ({
          token: 'tok',
          accountId: 'acct',
          expiresAt: new Date(NOW + 3_600_000).toISOString(),
          tokenType: 'Bearer',
        }),
      };
    },
  });
  const navigated = [];
  const auth = createAuthController({
    store,
    api,
    tokenStore,
    navigate: (url) => navigated.push(url),
    now,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  return { auth, navigated, getCaptured: () => captured };
}

// ---------------------------------------------------------------- generators

const nonEmptyStr = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.length > 0);

/**
 * A callback query string as the IdP would hand it back: `code` + `state`
 * (both expected and NOT PKCE), optionally prefixed with '?', with adversarial
 * extra params mixed in — but never a PKCE param, since the CLIENT is what we
 * assert never synthesizes one.
 */
const callbackQuery = fc
  .record({
    code: nonEmptyStr,
    state: nonEmptyStr,
    lead: fc.constantFrom('?', ''),
    extras: fc.array(
      fc.tuple(fc.constantFrom('scope', 'session_state', 'iss', 'foo'), nonEmptyStr),
      { maxLength: 3 },
    ),
  })
  .map(({ code, state, lead, extras }) => {
    const params = new URLSearchParams();
    params.set('code', code);
    params.set('state', state);
    for (const [k, v] of extras) params.set(k, v);
    return `${lead}${params.toString()}`;
  });

// ------------------------------------------------------ Property 22 (Task 8.7)

test(
  webUiTag(22, 'No Login_Flow request carries a PKCE code verifier'),
  async () => {
    await fc.assert(
      fc.asyncProperty(callbackQuery, async (query) => {
        const { auth, navigated, getCaptured } = makeSetup();

        // (a) login() navigates to /auth/login with NO PKCE param and no body.
        auth.login();
        // (a') restart() (the 400-branch control) does the same.
        auth.restart();

        assert.equal(navigated.length, 2, 'both login() and restart() navigated');
        for (const url of navigated) {
          assert.ok(
            String(url).startsWith(LOGIN_PATH),
            'the Login_Flow navigation targets GET /auth/login',
          );
          assert.equal(urlHasPkce(String(url)), false, 'the /auth/login navigation carries no PKCE param');
        }

        // (b) completeLoginFromQuery issues GET /auth/callback with the IdP's
        // code+state but NO client-synthesized PKCE verifier anywhere.
        await auth.completeLoginFromQuery(query);
        const captured = getCaptured();
        assert.ok(String(captured.url).includes(CALLBACK_PATH), 'the callback request targets /auth/callback');
        // The OAuth `code` IS expected on the callback (it is not PKCE).
        assert.ok(urlHasCode(String(captured.url)), 'the callback carries the IdP authorization code (not PKCE)');
        // …but no PKCE param/field in URL, headers, or body.
        assertRequestPkceFree(captured, 'GET /auth/callback');
        return true;
      }),
      fcConfig,
    );
  },
);

/** True iff the URL carries the OAuth authorization `code` (expected, not PKCE). */
function urlHasCode(url) {
  const qIndex = url.indexOf('?');
  const params = new URLSearchParams(qIndex >= 0 ? url.slice(qIndex) : '');
  return params.has('code');
}

// -------------------------------------- guard: the detector is not vacuous

test('Property 22 guard: urlHasPkce / artifactHasPkce actually detect a PKCE leak', () => {
  assert.equal(urlHasPkce('/auth/login?code_verifier=abc'), true);
  assert.equal(urlHasPkce('/auth/callback?code=x&state=y'), false);
  assert.equal(artifactHasPkce({ code_challenge: 'x' }), true);
  assert.equal(artifactHasPkce({ authorization: 'Bearer x' }), false);
  assert.equal(artifactHasPkce(JSON.stringify({ pkce: '1' })), true);
});
