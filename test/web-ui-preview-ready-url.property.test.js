/**
 * Property-based test for Web UI Task 5.4 (node --test).
 *
 * Property 10 — "A ready preview frame is applied only with a usable URL"
 * (design §"Property 10", Req 4.1, 4.2). Exact spec tag:
 *
 *   "Feature: web-ui, Property 10: A ready preview frame is applied only with a
 *    usable URL"
 *
 * PROPERTY. For ANY preview_status frame with status `ready`:
 *   - if its `url` is a NON-EMPTY string, the preview state becomes
 *     { status:'ready', url } with any prior loading indicator/content replaced
 *     (Req 4.1);
 *   - if its `url` is MISSING or EMPTY, the PRIOR preview state is retained and
 *     a URL-unavailable error indication is shown (Req 4.2).
 *
 * REAL COLLABORATORS. The test drives the REAL store reducer
 * (createStore + PREVIEW_STATUS_SET) through the REAL frame dispatcher
 * (createFrameDispatcher) — i.e. the shipping preview_status → store path — and
 * reads the decision through the REAL pure view-model (previewViewModel). No
 * stand-in doubles.
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

/** A non-empty, realistic same-origin-ish preview URL. */
const usableUrl = fc
  .webUrl()
  .filter((u) => typeof u === 'string' && u.length > 0);

/** An "unusable" url field: absent (undefined) or the empty string. */
const unusableUrl = fc.constantFrom('', undefined);

test(
  webUiTag(10, 'A ready preview frame is applied only with a usable URL'),
  () => {
    fc.assert(
      fc.property(usableUrl, (url) => {
        const store = createStore();
        const dispatcher = createFrameDispatcher({ store });

        // A prior loading state (what a fresh session shows) then a ready frame
        // carrying a usable url.
        dispatcher.dispatch({ type: 'preview_status', status: 'loading' });
        dispatcher.dispatch({ type: 'preview_status', status: 'ready', url });

        const vm = previewViewModel(store.getState());
        assert.equal(vm.status, 'ready', 'a usable url yields a ready status');
        assert.equal(vm.url, url, 'the ready url is applied verbatim');
        assert.equal(vm.showIframe, true, 'the ready preview is displayed (iframe shown)');
        assert.equal(vm.showLoading, false, 'the prior loading indicator is replaced');
        assert.equal(vm.urlUnavailable, false, 'no url-unavailable error for a usable url');
        return true;
      }),
      fcConfig,
    );
  },
);

test(
  webUiTag(10, 'a ready frame with a missing or empty URL retains prior state and errors'),
  () => {
    fc.assert(
      fc.property(usableUrl, unusableUrl, (priorUrl, badUrl) => {
        const store = createStore();
        const dispatcher = createFrameDispatcher({ store });

        // Establish a KNOWN-GOOD ready preview first.
        dispatcher.dispatch({ type: 'preview_status', status: 'ready', url: priorUrl });
        const before = previewViewModel(store.getState());
        assert.equal(before.url, priorUrl);

        // Now a ready frame WITHOUT a usable url. The url key is present-but-empty
        // OR absent; both are "unusable".
        const frame = { type: 'preview_status', status: 'ready' };
        if (badUrl !== undefined) frame.url = badUrl; // present-but-empty
        dispatcher.dispatch(frame);

        const after = previewViewModel(store.getState());
        // Req 4.2: prior state retained ...
        assert.equal(after.url, priorUrl, 'the previously displayed url is retained');
        assert.equal(after.status, 'ready', 'the prior ready status is retained');
        // ... and a URL-unavailable error is shown.
        assert.equal(after.urlUnavailable, true, 'a URL-unavailable error indication is shown');
        return true;
      }),
      fcConfig,
    );
  },
);
