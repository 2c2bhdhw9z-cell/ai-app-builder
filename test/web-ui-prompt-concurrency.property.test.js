/**
 * Property-based test for Web UI Task 3.5 (node --test).
 *
 * Property 3 — "An in-flight turn admits no second concurrent submit" (design
 * §"Property 3", Req 2.5). The test carries the EXACT spec tag required by the
 * web-ui spec:
 *
 *   "Feature: web-ui, Property 3: An in-flight turn admits no second concurrent
 *    submit"
 *
 * PROPERTY. For ANY number of submit attempts made WHILE a Project_Session's
 * turn is in flight, the client issues ZERO additional `POST /message` calls
 * for that session and keeps the submit control disabled until the turn ends.
 * Concretely: with one in-flight `/message` request held open, N further valid
 * submits (N generated 1..12) produce NO further `/message` calls, and the
 * store's `submitInFlight` gate stays true throughout (so a subscribed view
 * keeps the control disabled). Once the first turn resolves, the gate clears
 * and a fresh submit is admitted again.
 *
 * REAL COLLABORATORS. The REAL builder controller over the REAL store and REAL
 * api client. The only seam is a fetch stub whose first `/message` response is
 * a DEFERRED promise the test resolves on demand — this is how a genuine
 * in-flight turn is represented without a real network. The concurrency gate,
 * the store's SUBMIT_STARTED no-op-when-in-flight invariant, and the request
 * pipeline are all shipping code.
 *
 * Hermetic: pure logic + a deferred fetch stub. No network, no server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, selectSubmitInFlight } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createBuilderController } from '../src/server/public/builder.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag. */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** A resolvable deferred, so the test controls when the in-flight turn ends. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A fetch stub that holds the FIRST /message request open (returns a promise
 * the test resolves later) and records every /message call. Later /message
 * calls — which the gate should PREVENT — would resolve immediately, so if the
 * gate ever leaked, we'd both see an extra recorded call and an extra response.
 */
function gatingClient() {
  const calls = [];
  const firstResponse = deferred();
  let seen = 0;
  const api = createApiClient({
    getToken: () => 'tok-present',
    fetchImpl: async (url) => {
      if (typeof url === 'string' && url.includes('/message')) {
        calls.push(url);
        seen += 1;
        if (seen === 1) {
          // First turn: stay in flight until the test resolves it.
          await firstResponse.promise;
        }
      }
      return { status: 202, async json() { return { accepted: true }; } };
    },
  });
  return { api, calls, endFirstTurn: () => firstResponse.resolve() };
}

// ------------------------------------------------------ Property 3 (Task 3.5)

test(webUiTag(3, 'An in-flight turn admits no second concurrent submit'), async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 12 }), // number of concurrent second-attempts
      fc.array(fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length >= 1), {
        minLength: 1,
        maxLength: 12,
      }),
      async (attempts, texts) => {
        const store = createStore();
        const { api, calls, endFirstTurn } = gatingClient();
        const controller = createBuilderController({ store, api });

        // Track that a subscribed view would see the control disabled: capture
        // the last observed submitInFlight value through a real subscription.
        let lastInFlight = selectSubmitInFlight(store.getState());
        const unsub = store.subscribe(selectSubmitInFlight, (v) => {
          lastInFlight = v;
        });

        // Start the first turn; DO NOT await — it stays in flight (held open).
        const first = controller.submit('first valid prompt');

        // Let the microtask queue advance so SUBMIT_STARTED has been dispatched
        // and the fetch has been entered (and is now awaiting our deferred).
        await Promise.resolve();
        await Promise.resolve();

        assert.equal(selectSubmitInFlight(store.getState()), true, 'turn is in flight');
        assert.equal(lastInFlight, true, 'a subscribed view sees the control disabled');
        assert.equal(calls.length, 1, 'exactly one /message call so far');

        // Fire N concurrent second submits while the first is still in flight.
        const concurrent = [];
        for (let i = 0; i < attempts; i += 1) {
          const t = texts[i % texts.length];
          concurrent.push(controller.submit(t));
        }
        const results = await Promise.all(concurrent);

        // Every one of them was refused as busy, with NO extra /message call.
        for (const r of results) {
          assert.equal(r.ok, false);
          assert.equal(r.reason, 'busy', 'a concurrent submit is refused as busy');
        }
        assert.equal(calls.length, 1, 'no additional /message call during the in-flight turn');
        assert.equal(selectSubmitInFlight(store.getState()), true, 'gate held through attempts');

        // End the first turn; the gate clears and a fresh submit is admitted.
        endFirstTurn();
        const firstOutcome = await first;
        assert.equal(firstOutcome.ok, true, 'the first turn completes ok');
        assert.equal(selectSubmitInFlight(store.getState()), false, 'gate clears after the turn');
        assert.equal(lastInFlight, false, 'the view is re-enabled after the turn');

        // A subsequent submit is now admitted (a second /message call happens).
        const after = await controller.submit('a second, sequential prompt');
        assert.equal(after.ok, true);
        assert.equal(calls.length, 2, 'a sequential submit after the turn is admitted');

        unsub();
        return true;
      },
    ),
    fcConfig,
  );
});

// -------------------------------------------- Mutation / test-quality guard

/**
 * Prove the gate is real and the test is not vacuous: without the in-flight
 * gate two sequential submits DO make two calls, and the store's SUBMIT_STARTED
 * refuses to re-arm while already in flight (a second start is a no-op).
 */
test('Property 3 guard: sequential submits are admitted; the store refuses a double-start', async () => {
  // Two sequential (not concurrent) submits make two calls — the gate only
  // blocks CONCURRENT ones.
  const store = createStore();
  const { api, calls, endFirstTurn } = gatingClient();
  const controller = createBuilderController({ store, api });
  const first = controller.submit('one');
  await Promise.resolve();
  await Promise.resolve();
  endFirstTurn();
  await first;
  await controller.submit('two');
  assert.equal(calls.length, 2, 'sequential submits each call once');

  // Store-level invariant: a second SUBMIT_STARTED while in flight is a no-op.
  const { ACTIONS } = await import('../src/server/public/store.js');
  const s = createStore();
  s.dispatch({ type: ACTIONS.SUBMIT_STARTED, promptText: 'a' });
  const before = s.getState();
  s.dispatch({ type: ACTIONS.SUBMIT_STARTED, promptText: 'b' });
  assert.equal(s.getState(), before, 'a double-start is a no-op (same state reference)');
  assert.equal(s.getState().session.pendingPromptText, 'a', 'the in-flight text is not clobbered');
});
