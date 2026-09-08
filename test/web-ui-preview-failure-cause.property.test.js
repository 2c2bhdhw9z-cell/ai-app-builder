/**
 * Property-based test for Web UI Task 5.6 (node --test).
 *
 * Property 12 — "Failure-state frames show a cause summary iff one is present"
 * (design §"Property 12", Req 4.4, 4.5). Exact spec tag:
 *
 *   "Feature: web-ui, Property 12: Failure-state frames show a cause summary iff
 *    one is present"
 *
 * PROPERTY. For ANY preview_status frame with status `showing_prior`, `error`,
 * or `persistent_failure`, the client shows the corresponding indicator AND
 * displays the frame's safe `cause` summary text IFF that summary is a
 * non-empty string.
 *
 * REAL COLLABORATORS. The REAL store reducer + REAL frame dispatcher + REAL
 * view-model. The cause generator includes empty strings, whitespace-only
 * strings, and non-empty strings so the "iff present" boundary is exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore } from '../src/server/public/store.js';
import { createFrameDispatcher } from '../src/server/public/frames.js';
import { previewViewModel } from '../src/server/public/preview.js';
import { statusMessageFor } from '../src/server/public/views/preview-pane.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

const failureStatus = fc.constantFrom('showing_prior', 'error', 'persistent_failure');

// A cause value: sometimes absent, sometimes empty/whitespace (→ no summary),
// sometimes a genuine non-empty single-line-ish string (→ summary shown).
const causeArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.constantFrom('   ', '\n', '\t '),
  fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim() !== ''),
);

test(
  webUiTag(12, 'Failure-state frames show a cause summary iff one is present'),
  () => {
    fc.assert(
      fc.property(failureStatus, causeArb, (status, cause) => {
        const store = createStore();
        const dispatcher = createFrameDispatcher({ store });

        const frame = { type: 'preview_status', status };
        if (cause !== undefined) frame.cause = cause;
        dispatcher.dispatch(frame);

        const vm = previewViewModel(store.getState());

        // The corresponding indicator is shown for every failure status.
        if (status === 'showing_prior') {
          assert.equal(vm.showPrior, true, 'showing_prior indicator shown');
        } else {
          assert.equal(vm.showFailure, true, 'failure indicator shown for error/persistent_failure');
        }
        // The pane always produces a non-empty status message for these states.
        assert.notEqual(statusMessageFor(vm), '', 'a failure indicator message is present');

        // The "iff present" rule: the cause is shown exactly when the frame
        // carried a non-empty (after-trim) cause string.
        const expectSummary = typeof cause === 'string' && cause.trim() !== '';
        if (expectSummary) {
          assert.equal(typeof vm.cause, 'string', 'cause summary is present');
          assert.notEqual(vm.cause, '', 'cause summary is non-empty');
        } else {
          assert.equal(vm.cause, null, 'no cause summary when the frame had none');
        }
        return true;
      }),
      fcConfig,
    );
  },
);
