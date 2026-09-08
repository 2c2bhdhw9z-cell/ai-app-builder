/**
 * Property-based test for Web UI Task 4.6 (node --test).
 *
 * Property 7 — "SSE reconnection is bounded in interval and count"
 * (design §"Property 7", Req 3.5, 3.6). Exact spec tag:
 *
 *   "Feature: web-ui, Property 7: SSE reconnection is bounded in interval and
 *    count"
 *
 * PROPERTY. For ANY sequence of connection drops, EVERY automatic reconnection
 * attempt is scheduled with a delay not exceeding 5,000 ms, and the client makes
 * AT MOST 10 consecutive automatic attempts before ceasing and reporting the
 * stream lost.
 *
 * REAL COLLABORATORS. Two facets, both against the shipping code:
 *   (1) the PURE scheduler `reconnectDelay` is asserted ≤5,000ms across all
 *       attempt numbers; and
 *   (2) the REAL `createSseClient` is driven with an INJECTED fetch that always
 *       fails to open, an INJECTED fake clock (setTimeout/clearTimeout), and an
 *       injected AbortController, so the whole reconnect loop runs
 *       deterministically: we count the scheduled delays and assert there are at
 *       most 10, each ≤5,000ms, and that the terminal status is 'lost'.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  createSseClient,
  reconnectDelay,
  MAX_RECONNECT_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
  SSE_STATUS,
} from '../src/server/public/sse.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** A controllable fake clock: records scheduled delays and lets us drain them. */
function fakeClock() {
  let nextId = 1;
  const timers = new Map(); // id -> { cb, delay }
  const scheduledDelays = [];
  return {
    scheduledDelays,
    setTimeout: (cb, delay) => {
      const id = nextId++;
      timers.set(id, { cb, delay });
      scheduledDelays.push(delay);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    /** Fire all currently-pending timers, up to `max` rounds, awaiting between. */
    async drain(max = 100) {
      let rounds = 0;
      while (timers.size > 0 && rounds < max) {
        rounds += 1;
        const [id, t] = timers.entries().next().value;
        timers.delete(id);
        t.cb();
        // Let the async openOnce() microtasks settle before the next round.
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    },
  };
}

class FakeAbortController {
  constructor() {
    this.signal = { aborted: false };
  }
  abort() {
    this.signal.aborted = true;
  }
}

test(webUiTag(7, 'SSE reconnection is bounded in interval and count'), async () => {
  // Facet (1): the pure delay is ALWAYS within [0, 5000] for any attempt number.
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10_000 }), (attempt) => {
      const d = reconnectDelay(attempt);
      assert.ok(d >= 0, 'delay is non-negative');
      assert.ok(d <= MAX_RECONNECT_DELAY_MS, `delay ${d} <= ${MAX_RECONNECT_DELAY_MS}`);
      return true;
    }),
    fcConfig,
  );

  // Facet (2): the REAL client with an always-failing fetch makes at most 10
  // automatic attempts, each scheduled ≤5s, then reports 'lost'. Vary HOW the
  // open fails (network throw vs non-2xx) to exercise both drop paths.
  await fc.assert(
    fc.asyncProperty(fc.constantFrom('throw', 'status-500', 'status-503'), async (mode) => {
      const clock = fakeClock();
      const statuses = [];
      let fetchCalls = 0;

      const client = createSseClient({
        getToken: () => 'tok', // a token is held so the open is attempted
        AbortControllerImpl: FakeAbortController,
        setTimeoutImpl: clock.setTimeout,
        clearTimeoutImpl: clock.clearTimeout,
        fetchImpl: async () => {
          fetchCalls += 1;
          if (mode === 'throw') throw new Error('network down');
          const status = mode === 'status-500' ? 500 : 503;
          return { status, body: null };
        },
      });
      client.onStatus((s) => statuses.push(s));

      client.connect('proj-1'); // first open attempt (synchronous kickoff)
      await Promise.resolve();
      await Promise.resolve();
      // Drain every scheduled reconnect until the loop ceases.
      await clock.drain(200);

      // At most 10 scheduled automatic reconnect delays (Req 3.6).
      assert.ok(
        clock.scheduledDelays.length <= MAX_RECONNECT_ATTEMPTS,
        `scheduled ${clock.scheduledDelays.length} <= ${MAX_RECONNECT_ATTEMPTS}`,
      );
      // Every scheduled delay is within the 5s cap (Req 3.5).
      for (const d of clock.scheduledDelays) {
        assert.ok(d <= MAX_RECONNECT_DELAY_MS, `scheduled delay ${d} <= ${MAX_RECONNECT_DELAY_MS}`);
      }
      // Terminal status is 'lost' after the budget is exhausted (Req 3.6).
      assert.equal(client.getStatus(), SSE_STATUS.LOST, 'ends lost');
      assert.ok(statuses.includes(SSE_STATUS.LOST), 'emitted a lost status');
      // The initial open + up to 10 reconnect opens = at most 11 fetches.
      assert.ok(fetchCalls <= MAX_RECONNECT_ATTEMPTS + 1, 'bounded number of opens');
      return true;
    }),
    { numRuns: 30 },
  );
});

test('Property 7 guard: reconnectNow resets the attempt budget', async () => {
  const clock = fakeClock();
  const client = createSseClient({
    getToken: () => 'tok',
    AbortControllerImpl: FakeAbortController,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    fetchImpl: async () => {
      throw new Error('down');
    },
  });
  client.connect('p');
  await Promise.resolve();
  await Promise.resolve();
  await clock.drain(200);
  assert.equal(client.getStatus(), SSE_STATUS.LOST);
  const firstBudget = clock.scheduledDelays.length;
  assert.ok(firstBudget <= MAX_RECONNECT_ATTEMPTS && firstBudget >= 1);

  // Manual reconnect resets the counter and tries again (a fresh budget).
  client.reconnectNow();
  await Promise.resolve();
  await Promise.resolve();
  await clock.drain(200);
  assert.equal(client.getStatus(), SSE_STATUS.LOST);
  // A second full budget of scheduled attempts was appended.
  assert.ok(clock.scheduledDelays.length > firstBudget, 'reconnectNow re-armed the budget');
});
