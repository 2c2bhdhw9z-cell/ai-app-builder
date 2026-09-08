/**
 * Property-based test for Web UI Task 5.5 (node --test).
 *
 * Property 11 — "A loading status suppresses previously rendered preview
 * content" (design §"Property 11", Req 4.3). Exact spec tag:
 *
 *   "Feature: web-ui, Property 11: A loading status suppresses previously
 *    rendered preview content"
 *
 * PROPERTY. For ANY prior preview state, applying a preview_status frame with
 * status `loading` yields a loading indicator AND suppresses any previously
 * rendered preview content (the iframe is not shown and no stale url remains).
 *
 * REAL COLLABORATORS. The REAL store reducer + REAL frame dispatcher + REAL
 * view-model. The "prior state" is generated across ALL five statuses (with and
 * without a url) so the suppression holds regardless of what was showing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore } from '../src/server/public/store.js';
import { createFrameDispatcher } from '../src/server/public/frames.js';
import { previewViewModel } from '../src/server/public/preview.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** An arbitrary PRIOR preview_status frame across the whole lifecycle. */
const priorFrame = fc.record(
  {
    status: fc.constantFrom('loading', 'ready', 'showing_prior', 'error', 'persistent_failure'),
    url: fc.option(fc.webUrl(), { nil: undefined }),
    cause: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
    showingPrior: fc.boolean(),
    restartOffered: fc.boolean(),
  },
  { requiredKeys: ['status'] },
);

test(
  webUiTag(11, 'A loading status suppresses previously rendered preview content'),
  () => {
    fc.assert(
      fc.property(priorFrame, (prior) => {
        const store = createStore();
        const dispatcher = createFrameDispatcher({ store });

        // Put the pane into an arbitrary prior state.
        dispatcher.dispatch({ type: 'preview_status', ...prior });

        // Now a loading frame.
        dispatcher.dispatch({ type: 'preview_status', status: 'loading' });

        const vm = previewViewModel(store.getState());
        assert.equal(vm.status, 'loading', 'the status becomes loading');
        assert.equal(vm.showLoading, true, 'a loading indicator is shown');
        // Suppression: the iframe is not displayed and no stale url remains.
        assert.equal(vm.showIframe, false, 'previously rendered preview content is suppressed');
        assert.equal(vm.url, null, 'no stale url remains behind the loading indicator');
        return true;
      }),
      fcConfig,
    );
  },
);
