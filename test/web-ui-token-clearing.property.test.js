/**
 * Property-based test for Web UI Task 8.6 (node --test).
 *
 * Property 21 — "Every token-clearing trigger fully empties the Token_Store"
 * (design §"Property 21", Req 6.7, 6.9). Exact spec tag:
 *
 *   "Feature: web-ui, Property 21: Every token-clearing trigger fully empties
 *    the Token_Store"
 *
 * SCOPE. For ANY of the three clearing triggers —
 *   (a) the stored expiresAt being reached,
 *   (b) any gated request returning an Access_Denied_Response (a 401, wired
 *       through the api.js onAccessDenied seam the auth controller registers), and
 *   (c) the user activating logout —
 * the Token_Store ends with NO field remaining (token, accountId, expiresAt all
 * gone, in BOTH the in-memory record AND the optional sessionStorage backend),
 * store.auth.hasToken mirrors the cleared state, and the user is returned to the
 * login control.
 *
 * REAL COLLABORATORS. The REAL Token_Store (with an in-memory sessionStorage
 * double so the persistence sink is also asserted clear), the REAL api client
 * (its onAccessDenied fired by a real 401 from an injected fetch), and the REAL
 * auth controller. Only the clock, timers, navigation, and network are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createTokenStore, STORAGE_KEY } from '../src/server/public/token-store.js';
import { createAuthController } from '../src/server/public/auth.js';
import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** A minimal in-memory Storage double so we can assert the sink is cleared. */
function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _has: (k) => map.has(k),
  };
}

/** Assert the Token_Store is fully empty in memory AND in its backend. */
function assertFullyCleared(tokenStore, storage, store) {
  assert.equal(tokenStore.getRecord(), null, 'no in-memory record remains');
  assert.equal(tokenStore.getToken(), null, 'no token remains');
  assert.equal(tokenStore.getAccountId(), null, 'no accountId remains');
  assert.equal(tokenStore.getExpiresAt(), null, 'no expiresAt remains');
  assert.equal(tokenStore.hasToken(), false, 'hasToken() is false');
  assert.equal(storage._has(STORAGE_KEY), false, 'the persistence backend holds no record');
  assert.equal(store.getState().auth.hasToken, false, 'store mirrors the cleared token state');
  const notice = store.getState().session.notice;
  assert.ok(notice && notice.kind === 'reauth', 'the user is returned to the login control');
}

const nonEmptyStr = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0);

// ------------------------------------------------------ Property 21 (Task 8.6)

test(
  webUiTag(21, 'Every token-clearing trigger fully empties the Token_Store'),
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ token: nonEmptyStr, accountId: nonEmptyStr }),
        fc.integer({ min: 1_000, max: 3_600_000 }), // ms until expiry
        fc.constantFrom('expiry', 'gated401', 'logout'),
        fc.constantFrom('/message', '/confirm', '/projects', '/preview', '/theme', '/work-mode'),
        async (base, ttlMs, trigger, gatedPath) => {
          const NOW = Date.parse('2024-06-01T00:00:00.000Z');
          let clockMs = NOW;
          const now = () => clockMs;
          const expiresAt = new Date(NOW + ttlMs).toISOString();

          const storage = memStorage();
          const tokenStore = createTokenStore({ now, storage });
          const store = createStore();

          // A fetch that returns a 401 (so onAccessDenied fires for the gated401
          // trigger); irrelevant for the other triggers.
          const api = createApiClient({
            getToken: () => tokenStore.getToken(),
            fetchImpl: async () => ({ status: 401, json: async () => ({ error: 'access denied' }) }),
          });

          // Injected timer that records the armed expiry callback so the test
          // can fire it deterministically when it advances the clock.
          let armedCb = null;
          let armedDelay = null;
          const auth = createAuthController({
            store,
            api,
            tokenStore,
            navigate: () => {},
            now,
            setTimeoutImpl: (cb, ms) => {
              armedCb = cb;
              armedDelay = ms;
              return { unref() {} };
            },
            clearTimeoutImpl: () => {
              armedCb = null;
            },
          });

          // Log in with a valid future record (via handleCallback's ok branch so
          // the expiry timer is armed exactly as in production).
          const ok = auth.handleCallback({
            kind: 'ok',
            data: { token: base.token, accountId: base.accountId, expiresAt, tokenType: 'Bearer' },
          });
          assert.equal(ok.ok, true, 'logged in');
          assert.equal(store.getState().auth.hasToken, true);
          assert.equal(storage._has(STORAGE_KEY), true, 'persisted on login');

          if (trigger === 'expiry') {
            // Advance the clock to/after expiry and fire the armed timer.
            assert.equal(typeof armedDelay, 'number', 'an expiry timer was armed');
            clockMs = NOW + ttlMs; // expiresAt reached
            assert.ok(typeof armedCb === 'function', 'expiry callback is armed');
            armedCb();
          } else if (trigger === 'gated401') {
            // A gated request returns 401 → api.js fires onAccessDenied → clear.
            const res = await api.request('POST', gatedPath, { body: { any: 1 } });
            assert.equal(res.kind, 'denied');
          } else {
            // logout
            auth.logout();
          }

          assertFullyCleared(tokenStore, storage, store);
          return true;
        },
      ),
      fcConfig,
    );
  },
);

// -------------------------------------- guard: clearing is idempotent + total

test('Property 21 guard: a second clear is a harmless no-op and leaves nothing', () => {
  const now = () => Date.parse('2024-06-01T00:00:00.000Z');
  const storage = memStorage();
  const tokenStore = createTokenStore({ now, storage });
  const store = createStore();
  const api = createApiClient({ getToken: () => tokenStore.getToken(), fetchImpl: async () => ({ status: 401, json: async () => ({}) }) });
  const auth = createAuthController({ store, api, tokenStore, navigate: () => {}, now, setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {} });

  auth.handleCallback({ kind: 'ok', data: { token: 't', accountId: 'a', expiresAt: new Date(now() + 60000).toISOString() } });
  auth.logout();
  auth.logout();
  assertFullyCleared(tokenStore, storage, store);
});
