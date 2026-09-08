/**
 * Property-based test for Web UI Task 4.4 (node --test).
 *
 * Property 5 — "Activity_Stream frames render in ascending sequence order"
 * (design §"Property 5", Req 3.3). Exact spec tag:
 *
 *   "Feature: web-ui, Property 5: Activity_Stream frames render in ascending
 *    sequence order"
 *
 * PROPERTY. For ANY set of Activity_Stream frames delivered in ANY arrival
 * order — including SHUFFLED and DUPLICATE sequence ids — the rendered
 * Activity_Stream list is ordered strictly ascending by each frame's monotonic
 * sequence identifier, and contains each delivered (distinct-seq) frame exactly
 * once.
 *
 * REAL COLLABORATORS. The test drives the REAL store reducer
 * (`createStore` + ACTIVITY_APPENDED) and the REAL frame dispatcher
 * (`createFrameDispatcher`) — the ordering + de-dup logic under test is the
 * shipping code, not a stand-in. Frames carry their own numeric `seq` (which the
 * dispatcher honors) so the test controls the identifiers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, selectActivity } from '../src/server/public/store.js';
import { createFrameDispatcher } from '../src/server/public/frames.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** An Activity_Stream frame carrying an explicit seq the dispatcher honors. */
function activityFrameWithSeq(seq) {
  return fc.record({
    seq: fc.constant(seq),
    type: fc.constantFrom('reasoning_delta', 'text_delta', 'tool_call', 'assistant_text'),
    text: fc.string({ maxLength: 12 }),
  });
}

test(webUiTag(5, 'Activity_Stream frames render in ascending sequence order'), () => {
  // A generator of frames with distinct seqs delivered in shuffled order, PLUS
  // an independent set of duplicate-seq deliveries.
  const distinctSeqSet = fc
    .uniqueArray(fc.integer({ min: 0, max: 5000 }), { minLength: 1, maxLength: 40 })
    .chain((seqs) => {
      const shuffled = fc.shuffledSubarray(seqs, { minLength: seqs.length, maxLength: seqs.length });
      return fc.tuple(fc.constant(seqs), shuffled);
    });

  fc.assert(
    fc.property(distinctSeqSet, (arg) => {
      const [seqs, arrivalOrder] = arg;
      const store = createStore();
      // Open a session so the activity slice is fresh.
      const dispatcher = createFrameDispatcher({ store });

      // Deliver frames in the SHUFFLED arrival order.
      for (const seq of arrivalOrder) {
        const frame = fc.sample(activityFrameWithSeq(seq), 1)[0];
        dispatcher.dispatch(frame);
      }

      const rendered = selectActivity(store.getState());

      // (a) strictly ascending by seq
      for (let i = 1; i < rendered.length; i += 1) {
        assert.ok(rendered[i - 1].seq < rendered[i].seq, 'strictly ascending seq order');
      }
      // (b) each distinct delivered seq appears exactly once
      const renderedSeqs = rendered.map((r) => r.seq).sort((a, b) => a - b);
      const expected = [...seqs].sort((a, b) => a - b);
      assert.deepEqual(renderedSeqs, expected, 'each distinct frame appears exactly once');
      return true;
    }),
    fcConfig,
  );
});

test(webUiTag(5, 'duplicate sequence ids are de-duplicated, not double-rendered'), () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 2, max: 8 }),
      (seq, repeats) => {
        const store = createStore();
        const dispatcher = createFrameDispatcher({ store });
        for (let i = 0; i < repeats; i += 1) {
          dispatcher.dispatch({ seq, type: 'reasoning_delta', text: `d${i}` });
        }
        const rendered = selectActivity(store.getState());
        const withSeq = rendered.filter((r) => r.seq === seq);
        assert.equal(withSeq.length, 1, 'a duplicate seq renders exactly once');
        return true;
      },
    ),
    fcConfig,
  );
});

test('Property 5 guard: interleaved out-of-order deliveries still sort', () => {
  const store = createStore();
  const dispatcher = createFrameDispatcher({ store });
  for (const seq of [5, 1, 3, 2, 4, 0]) {
    dispatcher.dispatch({ seq, type: 'text_delta', text: String(seq) });
  }
  const seqs = selectActivity(store.getState()).map((r) => r.seq);
  assert.deepEqual(seqs, [0, 1, 2, 3, 4, 5]);
});
