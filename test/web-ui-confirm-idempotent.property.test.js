/**
 * Property-based test for Web UI Task 6.3 (node --test).
 *
 * Property 17 — "A pending confirm stays visible and is re-displayed
 * idempotently" (design §"Property 17", Req 5.3, 5.4). Exact spec tag:
 *
 *   "Feature: web-ui, Property 17: A pending confirm stays visible and is
 *    re-displayed idempotently"
 *
 * PROPERTY. For ANY sequence of intervening NON-answer frames — reasoning/
 * tool/diff activity, preview_status, theme, work_mode, other confirm_requests,
 * AND a reconnect that REPLAYS the same still-pending confirm_request — an
 * unanswered confirm remains displayed EXACTLY ONCE, keyed by its requestId,
 * until it is answered (POST /confirm) or a matching `confirm_timeout` clears
 * it. A replay of the identical confirm must NOT stack a duplicate (Req 5.4),
 * and no intervening non-answer frame may drop it (Req 5.3).
 *
 * REAL COLLABORATORS. The test drives the REAL store reducer (`createStore` +
 * its CONFIRM_ADDED de-dup) and the REAL frame dispatcher
 * (`createFrameDispatcher`) — the same shipping path SSE frames flow through —
 * and asserts on the REAL confirm view-model projection (`confirmViewModel`),
 * which is exactly what the DOM view renders (one card per requestId). Nothing
 * is stubbed: the idempotence under test is the shipping store + dispatcher +
 * view-model, not a stand-in.
 *
 * Hermetic: pure logic. No network, no server, no DOM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, ACTIONS, selectPendingConfirms } from '../src/server/public/store.js';
import { createFrameDispatcher } from '../src/server/public/frames.js';
import { confirmViewModel } from '../src/server/public/views/confirm.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag. */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ---------------------------------------------------------------- generators

const nonEmptyStr = fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0);

/** The confirm_request under test (the one that stays pending). */
const targetConfirm = fc
  .record({
    requestId: nonEmptyStr.map((s) => `REQ-${s}`),
    command: fc.string({ maxLength: 40 }),
    category: fc.constantFrom('write', 'exec', 'network', ''),
    reason: fc.string({ maxLength: 60 }),
  })
  .map((r) => ({ type: 'confirm_request', ...r }));

/**
 * An intervening NON-answer frame the dispatcher recognizes: activity, control,
 * a DIFFERENT confirm_request, or a REPLAY of the target confirm. It never
 * answers or times out the target confirm. `replayTarget` frames re-deliver the
 * IDENTICAL target confirm (a reconnect replay) and must be idempotent.
 */
function interveningFrame(target) {
  return fc.oneof(
    // Activity frames (carry their own seq so ordering is deterministic).
    fc.record({
      type: fc.constantFrom('reasoning_delta', 'text_delta', 'tool_call', 'assistant_text'),
      seq: fc.integer({ min: 0, max: 100000 }),
      text: fc.string({ maxLength: 8 }),
    }),
    // Control/state frames that must never touch a pending confirm.
    fc.record({
      type: fc.constant('preview_status'),
      status: fc.constantFrom('loading', 'ready', 'error', 'showing_prior', 'persistent_failure'),
    }),
    fc.record({ type: fc.constant('work_mode'), mode: fc.constantFrom('vibe', 'spec', 'hybrid') }),
    fc.record({ type: fc.constant('theme'), theme: fc.constant('light'), palette: fc.constant({}) }),
    // A reconnect REPLAY of the identical target confirm (Req 5.4).
    fc.constant({ ...target, __replay: true }),
    // A DIFFERENT confirm that also becomes pending (must coexist, not merge).
    fc
      .record({
        requestId: nonEmptyStr.map((s) => `OTHER-${s}`),
        command: fc.string({ maxLength: 20 }),
        category: fc.constant('exec'),
        reason: fc.string({ maxLength: 20 }),
      })
      .map((r) => ({ type: 'confirm_request', ...r })),
  );
}

// ------------------------------------------------------ Property 17 (Task 6.3)

test(webUiTag(17, 'A pending confirm stays visible and is re-displayed idempotently'), () => {
  fc.assert(
    fc.property(
      targetConfirm,
      fc.array(fc.constant(null), { minLength: 0, maxLength: 30 }), // length control
      (target, lengthCtl) => {
        // Build the intervening sequence with knowledge of the target so a
        // replay is byte-identical.
        const seq = fc.sample(
          fc.array(interveningFrame(target), {
            minLength: lengthCtl.length,
            maxLength: lengthCtl.length,
          }),
          1,
        )[0];

        const store = createStore();
        const dispatcher = createFrameDispatcher({ store });

        // The target confirm arrives first and becomes pending.
        dispatcher.dispatch(target);
        assertVisibleOnce(store, target, 'after first delivery');

        // Deliver every intervening non-answer frame (including replays).
        for (const frame of seq) {
          // Strip our test-only marker before dispatch (the dispatcher ignores
          // unknown keys anyway, but keep the wire shape faithful).
          const { __replay, ...wire } = frame;
          dispatcher.dispatch(wire);
          // INVARIANT: through every intervening frame, the target stays visible
          // EXACTLY ONCE (Req 5.3 stays visible, Req 5.4 no duplicate on replay).
          assertVisibleOnce(store, target, 'after an intervening non-answer frame');
        }

        // Now ANSWER it via a matching confirm_timeout — it must clear (Req 5.3).
        dispatcher.dispatch({ type: 'confirm_timeout', requestId: target.requestId });
        const afterClear = confirmViewModel(store.getState()).filter(
          (r) => r.requestId === target.requestId,
        );
        assert.equal(afterClear.length, 0, 'a matching confirm_timeout clears the confirm');
        return true;
      },
    ),
    fcConfig,
  );
});

/** Assert the target confirm is present in the view-model EXACTLY once. */
function assertVisibleOnce(store, target, when) {
  const rows = confirmViewModel(store.getState());
  const matches = rows.filter((r) => r.requestId === target.requestId);
  assert.equal(matches.length, 1, `target confirm visible exactly once (${when})`);
  // The store's underlying map is likewise keyed once by requestId.
  const pending = selectPendingConfirms(store.getState());
  assert.ok(pending[target.requestId] !== undefined, `target confirm pending in store (${when})`);
}

// -------------------------------------------- guards / test-quality anchors

test('Property 17 guard: an identical replay produces the SAME state reference (no churn)', () => {
  const store = createStore();
  const dispatcher = createFrameDispatcher({ store });
  const frame = { type: 'confirm_request', requestId: 'REQ-1', command: 'rm -rf', category: 'exec', reason: 'cleanup' };

  dispatcher.dispatch(frame);
  const before = store.getState();
  // Replay the identical confirm (reconnect current-state replay).
  dispatcher.dispatch(frame);
  const after = store.getState();

  assert.equal(after, before, 'an idempotent replay does not create a new state (no re-render)');
  assert.equal(confirmViewModel(after).filter((r) => r.requestId === 'REQ-1').length, 1);
});

test('Property 17 guard: two distinct confirms coexist, each visible once', () => {
  const store = createStore();
  const dispatcher = createFrameDispatcher({ store });
  dispatcher.dispatch({ type: 'confirm_request', requestId: 'A', command: 'a', category: 'exec', reason: '' });
  dispatcher.dispatch({ type: 'confirm_request', requestId: 'B', command: 'b', category: 'write', reason: '' });

  const rows = confirmViewModel(store.getState());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.requestId).sort(), ['A', 'B']);

  // Clearing A leaves B visible once.
  dispatcher.dispatch({ type: 'confirm_timeout', requestId: 'A' });
  const rest = confirmViewModel(store.getState());
  assert.deepEqual(rest.map((r) => r.requestId), ['B']);
});
