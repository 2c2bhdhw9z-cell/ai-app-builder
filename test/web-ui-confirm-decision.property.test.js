/**
 * Property-based test for Web UI Task 6.2 (node --test).
 *
 * Property 16 — "A confirm decision posts the frame's request id"
 * (design §"Property 16", Req 5.1, 5.2). Exact spec tag:
 *
 *   "Feature: web-ui, Property 16: A confirm decision posts the frame's request
 *    id"
 *
 * PROPERTY. For ANY `confirm_request` frame delivered over the stream, when the
 * user approves or denies it, the client issues exactly one `POST /confirm`
 * whose body carries EXACTLY that frame's `requestId` and the `approved`
 * boolean the backend expects (`true` for approve, `false` for deny) — and
 * carries the Bearer via the api client (Req 5.2).
 *
 * REAL COLLABORATORS. The test drives the REAL store reducer (`createStore`),
 * the REAL frame dispatcher (`createFrameDispatcher`, which seeds the pending
 * confirm exactly as the shipping SSE path does), the REAL gated api client
 * (`createApiClient` with an injected fetch that CAPTURES the request), and the
 * REAL confirm controller (`createConfirmController`). Nothing about the
 * request shape is stubbed — the body under assertion is what the shipping
 * controller actually sends, matched against the backend's handleConfirm
 * contract ({ projectId, requestId, approved }).
 *
 * Hermetic: pure logic + an injected fetch stub. No network, no server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, ACTIONS, selectPendingConfirms } from '../src/server/public/store.js';
import { createFrameDispatcher } from '../src/server/public/frames.js';
import { createApiClient } from '../src/server/public/api.js';
import { createConfirmController } from '../src/server/public/confirm.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag. */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ---------------------------------------------------------------- generators

/** A non-empty-after-trim greppable string for ids/fields. */
const nonEmptyStr = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** A `confirm_request` frame the REAL dispatcher will seed into the store. */
const confirmFrame = fc.record({
  type: fc.constant('confirm_request'),
  requestId: nonEmptyStr.map((s) => `REQ-${s}`),
  command: fc.string({ maxLength: 60 }),
  category: fc.constantFrom('write', 'exec', 'network', ''),
  reason: fc.string({ maxLength: 80 }),
});

/**
 * A fetch stub that CAPTURES the last request (url + parsed body + headers) and
 * returns a 200 { ok:true } — the backend's success shape for POST /confirm.
 */
function capturingFetch(capture) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    capture.headers = init ? init.headers : undefined;
    return {
      status: 200,
      async json() {
        return { ok: true };
      },
    };
  };
}

// ------------------------------------------------------ Property 16 (Task 6.2)

test(webUiTag(16, "A confirm decision posts the frame's request id"), async () => {
  await fc.assert(
    fc.asyncProperty(
      confirmFrame,
      fc.boolean(), // approve (true) or deny (false)
      nonEmptyStr.map((s) => `proj-${s}`), // the open session's projectId
      nonEmptyStr.map((s) => `tok-${s}`), // the held Bearer token
      async (frame, approve, projectId, token) => {
        const store = createStore();
        // Open the session so the projectId is set (the /confirm body needs it).
        store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId });

        // Seed the pending confirm through the REAL SSE frame dispatch path.
        const dispatcher = createFrameDispatcher({ store });
        dispatcher.dispatch(frame);

        // Sanity: the store now holds exactly this pending confirm.
        const pending = selectPendingConfirms(store.getState());
        assert.ok(pending[frame.requestId] !== undefined, 'confirm was seeded into the store');

        const capture = {};
        const api = createApiClient({
          getToken: () => token,
          fetchImpl: capturingFetch(capture),
        });
        const controller = createConfirmController({ store, api });

        const outcome = approve
          ? await controller.approve(frame.requestId)
          : await controller.deny(frame.requestId);

        // (a) Exactly one POST /confirm was issued.
        assert.equal(outcome.ok, true, 'a 200 confirm resolves ok');
        assert.equal(capture.url, '/confirm', 'the decision targets POST /confirm');
        assert.equal(capture.init.method, 'POST', 'the decision is a POST');

        // (b) The body carries EXACTLY the frame's requestId (Req 5.2).
        assert.equal(
          capture.body.requestId,
          frame.requestId,
          "the POST body carries the frame's requestId verbatim",
        );

        // (c) The body carries the correct `approved` boolean the backend
        // expects (approve -> true, deny -> false), as a STRICT boolean.
        assert.equal(typeof capture.body.approved, 'boolean', 'approved is a strict boolean');
        assert.equal(capture.body.approved, approve, 'approved matches the decision');

        // (d) The projectId the backend requires rides along.
        assert.equal(capture.body.projectId, projectId, 'the POST body carries the projectId');

        // (e) The Bearer is attached (Req 5.2) — via the api client.
        assert.equal(
          capture.headers.authorization,
          `Bearer ${token}`,
          'the decision carries the Bearer header',
        );

        // (f) A successful answer clears the pending confirm (Req 5.3).
        assert.ok(
          selectPendingConfirms(store.getState())[frame.requestId] === undefined,
          'an answered confirm is cleared',
        );
        return true;
      },
    ),
    fcConfig,
  );
});

// -------------------------------------------- guards / test-quality anchors

test('Property 16 guard: answering an unknown requestId issues no POST', async () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-x' });

  let calls = 0;
  const api = createApiClient({
    getToken: () => 'tok-x',
    fetchImpl: async () => {
      calls += 1;
      return { status: 200, async json() { return { ok: true }; } };
    },
  });
  const controller = createConfirmController({ store, api });

  const outcome = await controller.approve('REQ-not-pending');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'notPending');
  assert.equal(calls, 0, 'no POST /confirm is issued for a non-pending requestId');
});

test('Property 16 guard: deny sends approved:false, approve sends approved:true', async () => {
  for (const approve of [true, false]) {
    const store = createStore();
    store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-y' });
    const dispatcher = createFrameDispatcher({ store });
    dispatcher.dispatch({ type: 'confirm_request', requestId: 'REQ-1', command: 'rm', category: 'exec', reason: 'why' });

    const capture = {};
    const api = createApiClient({ getToken: () => 'tok-y', fetchImpl: capturingFetch(capture) });
    const controller = createConfirmController({ store, api });

    if (approve) await controller.approve('REQ-1');
    else await controller.deny('REQ-1');

    assert.equal(capture.body.approved, approve);
  }
});
