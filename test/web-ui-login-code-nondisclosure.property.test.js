/**
 * Property-based test for Web UI Task 8.5 (node --test).
 *
 * Property 20 — "A login-protocol code is never disclosed, and a restart is
 * offered" (design §"Property 20", Req 6.6). Exact spec tag:
 *
 *   "Feature: web-ui, Property 20: A login-protocol code is never disclosed,
 *    and a restart is offered"
 *
 * SCOPE. For ANY `/auth/callback` HTTP 400 payload carrying a login-protocol
 * `code` (the backend's shape is `{ error, code }`), the message the client
 * displays does NOT contain the raw `code` value as a substring, and a control
 * that restarts the Login_Flow is present.
 *
 * REAL COLLABORATORS. The test drives the REAL api classifier (classify(400,
 * { error, code }) → { kind:'protocol', code, message }) and the REAL auth
 * controller (handleCallback), and inspects the REAL store notice slice the
 * login view renders. The `restart` control is proven present two ways: the
 * notice carries `offerRestart:true`, and the controller exposes a `restart()`
 * that navigates to the Login_Flow.
 *
 * The generated `code` values include distinctive sentinels AND the backend's
 * real protocol codes (STATE_INVALID/EXPIRED/MISMATCH/UNBOUND, CODE_REQUIRED,
 * STATE_REQUIRED) so a leak of any of them would be caught.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createTokenStore } from '../src/server/public/token-store.js';
import { createAuthController, AUTH_MESSAGES, LOGIN_PATH } from '../src/server/public/auth.js';
import { createStore } from '../src/server/public/store.js';
import { createApiClient, classify, RESULT } from '../src/server/public/api.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

const now = () => Date.parse('2024-06-01T00:00:00.000Z');

function makeController(navigateSpy) {
  const store = createStore();
  const tokenStore = createTokenStore({ now, storage: null });
  const api = createApiClient({ getToken: () => null, fetchImpl: async () => ({ status: 400, json: async () => ({}) }) });
  const auth = createAuthController({
    store,
    api,
    tokenStore,
    navigate: navigateSpy,
    now,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  return { store, auth, tokenStore };
}

// ---------------------------------------------------------------- generators

/** A distinctive, greppable protocol code plus the backend's real ones. */
const protocolCode = fc.oneof(
  fc.constantFrom(
    'STATE_REQUIRED',
    'STATE_INVALID',
    'STATE_EXPIRED',
    'STATE_UNBOUND',
    'STATE_MISMATCH',
    'CODE_REQUIRED',
    'LOGIN_FAILED',
  ),
  fc.string({ minLength: 1, maxLength: 40 }).map((s) => `CODE-${s}-SECRET`),
);

/** A backend 400 body: { error, code }. `error` is a static-ish message. */
const protocol400 = fc.record({
  error: fc.constantFrom('login failed', 'login state is invalid', 'login state has expired'),
  code: protocolCode,
});

// ------------------------------------------------------ Property 20 (Task 8.5)

test(
  webUiTag(20, 'A login-protocol code is never disclosed, and a restart is offered'),
  () => {
    fc.assert(
      fc.property(protocol400, (body) => {
        // The REAL classifier tags a 400-with-code as a protocol fault and
        // carries the code for CONTROL FLOW only.
        const result = classify(400, body);
        assert.equal(result.kind, RESULT.PROTOCOL);
        assert.equal(result.code, body.code);

        let navigated = null;
        const { store, auth, tokenStore } = makeController((url) => {
          navigated = url;
        });

        const outcome = auth.handleCallback(result);
        assert.equal(outcome.ok, false);
        assert.equal(outcome.reason, 'protocol');
        assert.equal(outcome.restart, true, 'the controller reports a restart is offered');

        // Nothing was written to the Token_Store on a protocol fault.
        assert.equal(tokenStore.getRecord(), null);

        // The displayed notice: a GENERIC message that does NOT contain the raw
        // code as a substring, and flags a restart control (Req 6.6).
        const notice = store.getState().session.notice;
        assert.ok(notice, 'a login-failed notice is shown');
        assert.equal(notice.message, AUTH_MESSAGES.LOGIN_FAILED, 'the message is the generic login-failed text');
        assert.ok(
          !notice.message.includes(body.code),
          `the shown message must not contain the raw code (${body.code})`,
        );
        assert.equal(notice.offerRestart, true, 'the notice offers a Login_Flow restart control');

        // The restart control actually restarts the Login_Flow: activating it
        // navigates to GET /auth/login.
        auth.restart();
        assert.equal(navigated, LOGIN_PATH, 'restart navigates to the Login_Flow');
        return true;
      }),
      fcConfig,
    );
  },
);

// ------------------------------------------- guard: the detector is not vacuous

test('Property 20 guard: a message that DID contain the code would be caught', () => {
  const code = 'CODE-abc-SECRET';
  const leaky = `login failed (${code})`;
  assert.ok(leaky.includes(code), 'a leaky message contains the code');
  // The real generic message never contains a code.
  assert.ok(!AUTH_MESSAGES.LOGIN_FAILED.includes(code));
});
