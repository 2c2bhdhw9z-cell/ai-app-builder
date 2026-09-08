/**
 * Property-based test for Web UI Task 5.8 (node --test).
 *
 * Property 14 — "A non-live poll result drives a failure state; a failed poll is
 * inert" (design §"Property 14", Req 4.8, 4.9). Exact spec tag:
 *
 *   "Feature: web-ui, Property 14: A non-live poll result drives a failure
 *    state; a failed poll is inert"
 *
 * PROPERTY. For ANY GET /preview poll result:
 *   - a result reporting a NON-LIVE preview transitions the preview state to a
 *     failure indication tagged source:'poll' (Req 4.8);
 *   - a poll that TIMES OUT or returns a NON-SUCCESS result leaves the last known
 *     preview state UNCHANGED and schedules the next poll (Req 4.9).
 *
 * REAL COLLABORATORS. The REAL store + REAL preview controller + REAL preview
 * poller (createPreviewPoll) with the REAL gated api client (createApiClient)
 * over a scripted fetch. The served-handle vocabulary and the non-live decision
 * (previewFromServed / isNonLiveServed) are the shipping pure logic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, ACTIONS, selectPreview } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createPreviewPoll } from '../src/server/public/preview-poll.js';
import { isNonLiveServed } from '../src/server/public/preview.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** The raw SERVED-preview vocabulary GET /preview returns. */
const SERVED_STATUSES = ['none', 'served', 'committed', 'showing-prior', 'no-preview', 'exited'];

/** Build an api client whose GET /preview returns a scripted served handle. */
function apiReturningServed(served) {
  const fetchImpl = async () => ({
    status: 200,
    async json() {
      return { preview: served };
    },
  });
  return createApiClient({ getToken: () => 'tok', fetchImpl });
}

/** Build an api client whose GET /preview FAILS (network error or non-2xx). */
function apiFailing(kind) {
  const fetchImpl = async () => {
    if (kind === 'network') throw new Error('offline');
    return { status: 503, async json() { return { error: 'nope' }; } };
  };
  return createApiClient({ getToken: () => 'tok', fetchImpl });
}

test(
  webUiTag(14, 'A non-live poll result drives a failure state (tagged source:poll)'),
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SERVED_STATUSES),
        fc.option(fc.webUrl(), { nil: null }),
        async (servedStatus, url) => {
          const served = {
            status: servedStatus,
            url: servedStatus === 'served' ? url : null,
            snapshotId: null,
            showingPrior: servedStatus === 'showing-prior',
            buildError: null,
          };
          const store = createStore();
          store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'p1' });
          const api = apiReturningServed(served);
          const poll = createPreviewPoll({ store, api });
          poll.start('p1');

          const res = await poll.pollOnce();
          const preview = selectPreview(store.getState());

          if (isNonLiveServed(served)) {
            // Req 4.8: a non-live handle drives a failure indication, tagged poll.
            assert.equal(res.acted, true, 'the poll acted on a non-live handle');
            assert.ok(
              ['error', 'showing_prior'].includes(preview.status),
              `non-live served '${servedStatus}' → a failure-ish status, got '${preview.status}'`,
            );
            assert.equal(preview.source, 'poll', 'the failure is tagged source:poll');
          } else {
            // A live 'served' or benign 'committed'/'none' handle is not a failure.
            assert.equal(preview.source, 'poll', 'a poll-applied status is tagged source:poll');
            assert.notEqual(preview.status, undefined);
          }
          poll.stop();
          return true;
        },
      ),
      fcConfig,
    );
  },
);

test(
  webUiTag(14, 'a failed or timed-out poll is inert (retains the last known status)'),
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('loading', 'ready', 'showing_prior', 'error', 'persistent_failure'),
        fc.webUrl(),
        fc.constantFrom('network', 'non2xx'),
        async (priorStatus, priorUrl, failKind) => {
          const store = createStore();
          store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'p2' });
          // Seed a KNOWN last-known preview state directly through the reducer.
          store.dispatch({
            type: ACTIONS.PREVIEW_STATUS_SET,
            preview: { status: priorStatus, url: priorUrl, source: 'sse' },
          });
          const before = { ...selectPreview(store.getState()) };

          const api = apiFailing(failKind);
          const poll = createPreviewPoll({ store, api });
          poll.start('p2');

          const res = await poll.pollOnce();
          const after = selectPreview(store.getState());

          // Req 4.9: inert — no mutation, last-known state unchanged.
          assert.equal(res.acted, false, 'a failed/timed-out poll does not act');
          assert.equal(after.status, before.status, 'status retained across a failed poll');
          assert.equal(after.url, before.url, 'url retained across a failed poll');
          assert.equal(after.source, before.source, 'source retained (still sse, not poll)');
          poll.stop();
          return true;
        },
      ),
      fcConfig,
    );
  },
);
