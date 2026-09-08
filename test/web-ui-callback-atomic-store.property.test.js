/**
 * Property-based test for Web UI Task 8.3 (node --test).
 *
 * Property 18 — "A valid callback payload is stored atomically; an invalid one
 * is discarded" (design §"Property 18", Req 6.2, 6.3). Exact spec tag:
 *
 *   "Feature: web-ui, Property 18: A valid callback payload is stored
 *    atomically; an invalid one is discarded"
 *
 * SCOPE. For ANY `/auth/callback` HTTP 200 payload:
 *   - if `token` and `accountId` are non-empty strings AND `expiresAt` is a
 *     valid FUTURE ISO-8601 timestamp, the Token_Store ends holding EXACTLY
 *     `{ token, accountId, expiresAt }` — never a partially written record, and
 *     never carrying the extra `tokenType` field the backend also sends;
 *   - otherwise (any field missing/empty, or expiresAt not a valid future
 *     timestamp) NOTHING is written to the Token_Store and the user is returned
 *     to the login control.
 *
 * REAL COLLABORATORS. The test drives the REAL Token_Store (createTokenStore),
 * the REAL api classifier (classify(200, body) → the ok result auth.js sees),
 * and the REAL auth controller (createAuthController.handleCallback), with only
 * the clock and navigation injected. No stand-in doubles.
 *
 * ATOMICITY is asserted structurally: after an INVALID payload is applied to a
 * store that already held a good record, that good record is UNCHANGED (a bad
 * callback never evicts or partially overwrites a live session); and after a
 * VALID payload the stored record has EXACTLY the three keys, so there is no
 * observable partial state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createTokenStore, isValidRecord } from '../src/server/public/token-store.js';
import { createAuthController } from '../src/server/public/auth.js';
import { createStore } from '../src/server/public/store.js';
import { createApiClient, classify, RESULT } from '../src/server/public/api.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** A fixed reference "now" so future/past classification is deterministic. */
const NOW = Date.parse('2024-06-01T00:00:00.000Z');
const now = () => NOW;

/** A no-op api client whose only role here is the onAccessDenied seam. */
function makeApi() {
  return createApiClient({ getToken: () => null, fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
}

/** Build the auth controller over real store + real tokenStore (no browser). */
function makeController(tokenStore) {
  const store = createStore();
  const api = makeApi();
  const auth = createAuthController({
    store,
    api,
    tokenStore,
    navigate: () => {},
    now,
    // No real timers: an armed expiry uses a no-op timer so the test never
    // schedules against the real clock.
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  return { store, auth };
}

// ---------------------------------------------------------------- generators

/** A non-empty opaque string (token / accountId). */
const nonEmptyStr = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0);

/** A valid FUTURE ISO-8601 timestamp relative to NOW. */
const futureIso = fc
  .integer({ min: 1_000, max: 5 * 365 * 24 * 3600 * 1000 })
  .map((deltaMs) => new Date(NOW + deltaMs).toISOString());

/** A VALID callback data payload (plus the backend's tokenType). */
const validPayload = fc
  .record({ token: nonEmptyStr, accountId: nonEmptyStr, expiresAt: futureIso })
  .map((r) => ({ ...r, tokenType: 'Bearer' }));

/** A PAST or non-future ISO timestamp (invalid for storage). */
const nonFutureExpiry = fc.oneof(
  fc.integer({ min: 0, max: 10 * 365 * 24 * 3600 * 1000 }).map((d) => new Date(NOW - d).toISOString()),
  fc.constant(new Date(NOW).toISOString()), // exactly now → already expired
);

/** A value that is NOT a valid ISO-8601 timestamp string. */
const malformedExpiry = fc.oneof(
  fc.constantFrom('', 'not-a-date', 'tomorrow', '2024-13-40T99:99:99Z', 'NaN'),
  fc.integer(), // wrong type entirely
  fc.constant(null),
  fc.constant(undefined),
);

/**
 * An INVALID callback payload: exactly one defect injected — a missing/empty
 * token or accountId, or a non-future / malformed expiresAt.
 */
const invalidPayload = fc.oneof(
  // missing/empty token
  fc.record({ token: fc.constantFrom('', null, undefined), accountId: nonEmptyStr, expiresAt: futureIso }),
  // missing/empty accountId
  fc.record({ token: nonEmptyStr, accountId: fc.constantFrom('', null, undefined), expiresAt: futureIso }),
  // non-future expiresAt
  fc.record({ token: nonEmptyStr, accountId: nonEmptyStr, expiresAt: nonFutureExpiry }),
  // malformed expiresAt
  fc.record({ token: nonEmptyStr, accountId: nonEmptyStr, expiresAt: malformedExpiry }),
);

// ------------------------------------------------------ Property 18 (Task 8.3)

test(
  webUiTag(18, 'A valid callback payload is stored atomically; an invalid one is discarded'),
  () => {
    // Part A: a VALID 200 payload is stored as EXACTLY { token, accountId, expiresAt }.
    fc.assert(
      fc.property(validPayload, (data) => {
        const tokenStore = createTokenStore({ now, storage: null });
        const { store, auth } = makeController(tokenStore);

        // The REAL api classifier produces the ok result auth.js consumes.
        const result = classify(200, data);
        assert.equal(result.kind, RESULT.OK);

        const outcome = auth.handleCallback(result);
        assert.equal(outcome.ok, true, 'a valid payload logs in');

        const rec = tokenStore.getRecord();
        assert.ok(rec, 'a record is held');
        // EXACT shape: the three fields only — tokenType is NOT smuggled in.
        assert.deepEqual(Object.keys(rec).sort(), ['accountId', 'expiresAt', 'token']);
        assert.equal(rec.token, data.token);
        assert.equal(rec.accountId, data.accountId);
        assert.equal(rec.expiresAt, data.expiresAt);
        // Store mirrors token presence; no return-to-login notice on success.
        assert.equal(store.getState().auth.hasToken, true);
        assert.equal(store.getState().session.notice, null);
        return true;
      }),
      fcConfig,
    );

    // Part B: an INVALID 200 payload writes NOTHING and returns to login. And,
    // to prove ATOMICITY against an existing session, it does not evict or
    // partially overwrite a previously-stored good record.
    fc.assert(
      fc.property(validPayload, invalidPayload, (good, bad) => {
        assert.equal(isValidRecord(bad, now), false, 'generator produced an invalid payload');

        // (i) empty store: an invalid payload leaves it empty and returns to login.
        {
          const tokenStore = createTokenStore({ now, storage: null });
          const { store, auth } = makeController(tokenStore);
          const outcome = auth.handleCallback(classify(200, bad));
          assert.equal(outcome.ok, false, 'invalid payload does not log in');
          assert.equal(tokenStore.getRecord(), null, 'nothing written on invalid payload');
          assert.equal(store.getState().auth.hasToken, false);
          const notice = store.getState().session.notice;
          assert.ok(notice && notice.kind === 'loginFailed', 'returned to login control with generic notice');
        }

        // (ii) existing good record: an invalid callback must NOT disturb it.
        {
          const tokenStore = createTokenStore({ now, storage: null });
          const { auth } = makeController(tokenStore);
          assert.equal(auth.handleCallback(classify(200, good)).ok, true);
          const before = tokenStore.getRecord();
          auth.handleCallback(classify(200, bad));
          const after = tokenStore.getRecord();
          assert.deepEqual(after, before, 'a bad callback leaves the live record byte-identical');
        }
        return true;
      }),
      fcConfig,
    );
  },
);

// -------------------------------------------- Test-quality guard (not vacuous)

test('Property 18 guard: isValidRecord agrees with the generators', () => {
  // A concrete valid record validates; a concrete invalid one does not.
  assert.equal(
    isValidRecord({ token: 't', accountId: 'a', expiresAt: new Date(NOW + 1000).toISOString() }, now),
    true,
  );
  assert.equal(
    isValidRecord({ token: 't', accountId: 'a', expiresAt: new Date(NOW - 1000).toISOString() }, now),
    false,
  );
  assert.equal(isValidRecord({ token: '', accountId: 'a', expiresAt: new Date(NOW + 1000).toISOString() }, now), false);
});
