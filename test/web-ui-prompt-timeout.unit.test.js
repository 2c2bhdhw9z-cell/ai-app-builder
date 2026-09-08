/**
 * Unit test for Web UI Task 3.6 (node --test) — the 30-second `POST /message`
 * timeout, driven by a FAKE CLOCK / injected timer (Req 2.6).
 *
 * REQUIREMENT (2.6). When a `POST /message` request does not receive any
 * response within 30 seconds, the client MUST:
 *   - end the in-flight state for that Project_Session,
 *   - re-enable the submit control,
 *   - RETAIN the submitted prompt text for retry, and
 *   - display a message indicating the request timed out.
 *
 * APPROACH — real collaborators, fake time. The timeout is enforced INSIDE the
 * shipping api client (`createApiClient`) via an AbortController + a timer. To
 * make the 30s deterministic and instantaneous, we:
 *   1. install a FAKE CLOCK over `globalThis.setTimeout`/`clearTimeout` (the
 *      timer source api.js reads) that records scheduled callbacks and only
 *      runs them when the test advances time; and
 *   2. inject a fetch stub whose promise NEVER resolves on its own — it only
 *      rejects with an AbortError when the request's AbortController fires.
 * Then advancing the fake clock past 30s triggers api.js's abort, the fetch
 * rejects as aborted, and the client resolves `{ kind: 'timeout' }`. The REAL
 * builder controller + REAL store map that onto the store; we assert the four
 * Req-2.6 effects on the real store slice. Nothing about the timeout is mocked
 * away — only the passage of time and the network are controlled.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, selectSubmitInFlight } from '../src/server/public/store.js';
import { createApiClient, DEFAULT_TIMEOUTS } from '../src/server/public/api.js';
import { createBuilderController, MESSAGES } from '../src/server/public/builder.js';

/**
 * A minimal fake clock over globalThis.setTimeout/clearTimeout. Records each
 * scheduled timer with its delay; `advance(ms)` fires every timer whose delay
 * is <= the elapsed time. Restores the real timers on `restore()`.
 */
function installFakeClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let seq = 0;
  const timers = new Map(); // id -> { at, cb }

  globalThis.setTimeout = (cb, delay = 0) => {
    const id = ++seq;
    timers.set(id, { at: now + Number(delay), cb });
    // Mimic Node's timer handle enough for api.js's optional `.unref()`.
    return { id, unref() { return this; } };
  };
  globalThis.clearTimeout = (handle) => {
    const id = handle && typeof handle === 'object' ? handle.id : handle;
    timers.delete(id);
  };

  return {
    advance(ms) {
      now += ms;
      // Fire due timers in scheduled order.
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id);
          t.cb();
        }
      }
    },
    pending() {
      return timers.size;
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** A real-enough AbortController: a signal object + listeners fired on abort(). */
class TestAbortController {
  constructor() {
    const listeners = new Set();
    this.signal = {
      aborted: false,
      addEventListener: (type, cb) => {
        if (type === 'abort') listeners.add(cb);
      },
      removeEventListener: (type, cb) => {
        if (type === 'abort') listeners.delete(cb);
      },
    };
    this._listeners = listeners;
  }
  abort() {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    for (const cb of this._listeners) cb();
  }
}

/** An AbortError-shaped rejection, as a real aborted fetch would produce. */
function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * A fetch stub that models a hung request: it resolves ONLY when its abort
 * signal fires (rejecting with an AbortError), and never on its own. Records
 * that a /message call was made.
 */
function hangingFetch(record) {
  return (url, init) =>
    new Promise((_resolve, reject) => {
      if (typeof url === 'string' && url.includes('/message')) record.calls += 1;
      const signal = init && init.signal;
      if (signal && signal.aborted) {
        reject(abortError());
        return;
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => reject(abortError()));
      }
      // Otherwise it hangs forever — the fake clock's abort is the only exit.
    });
}

test('Task 3.6: a /message that does not respond within 30s times out, retains text, re-enables submit', async () => {
  const clock = installFakeClock();
  try {
    const record = { calls: 0 };
    const store = createStore();
    const api = createApiClient({
      getToken: () => 'tok-present',
      fetchImpl: hangingFetch(record),
      AbortControllerImpl: TestAbortController,
    });
    const controller = createBuilderController({ store, api });

    const raw = '  build me a scheduling app  ';
    const trimmed = raw.trim();

    // Kick off the submit; it will hang until the fake clock aborts it.
    const submitPromise = controller.submit(raw);

    // Let SUBMIT_STARTED dispatch and the fetch enter its awaiting state.
    await Promise.resolve();
    await Promise.resolve();

    // The turn is in flight, the control is disabled, the /message call was made.
    assert.equal(selectSubmitInFlight(store.getState()), true, 'turn is in flight');
    assert.equal(record.calls, 1, 'POST /message was issued');
    // The trimmed text is retained while in flight.
    assert.equal(store.getState().session.pendingPromptText, trimmed, 'trimmed text retained in flight');

    // Not yet timed out just before 30s.
    clock.advance(DEFAULT_TIMEOUTS.message - 1);
    await Promise.resolve();
    assert.equal(selectSubmitInFlight(store.getState()), true, 'still in flight before 30s');

    // Cross the 30s boundary: api.js aborts, fetch rejects aborted, result is timeout.
    clock.advance(1);
    const outcome = await submitPromise;

    // Req 2.6 effects on the REAL store:
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'timeout', 'the controller reports a timeout');
    assert.equal(selectSubmitInFlight(store.getState()), false, 'submit is re-enabled');
    assert.equal(
      store.getState().session.pendingPromptText,
      trimmed,
      'the submitted prompt text is retained for retry',
    );
    const notice = store.getState().session.notice;
    assert.ok(notice, 'a notice is shown');
    assert.equal(notice.kind, 'timeout', 'the notice classifies as a timeout');
    assert.equal(notice.message, MESSAGES.TIMEOUT, 'a timed-out message is displayed');
    return true;
  } finally {
    clock.restore();
  }
});

test('Task 3.6 guard: with no timeout crossed, the turn stays in flight (the clock drives the timeout)', async () => {
  const clock = installFakeClock();
  try {
    const record = { calls: 0 };
    const store = createStore();
    const api = createApiClient({
      getToken: () => 'tok-present',
      fetchImpl: hangingFetch(record),
      AbortControllerImpl: TestAbortController,
    });
    const controller = createBuilderController({ store, api });

    const submitPromise = controller.submit('a valid prompt');
    await Promise.resolve();
    await Promise.resolve();

    // Advance only partway — the timeout must NOT have fired.
    clock.advance(5_000);
    await Promise.resolve();
    assert.equal(selectSubmitInFlight(store.getState()), true, 'no premature timeout');

    // Clean up: fire the timeout so the pending promise settles and the test
    // does not leak a hanging fetch.
    clock.advance(DEFAULT_TIMEOUTS.message);
    await submitPromise;
    return true;
  } finally {
    clock.restore();
  }
});
