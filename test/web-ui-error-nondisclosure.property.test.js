/**
 * Property-based test for Web UI Task 4.8 (node --test).
 *
 * Property 9 — "The error-frame / access-denied renderer discloses nothing
 * beyond the safe fields" (design §"Property 9", Req 3.8, 16.2). Exact spec tag:
 *
 *   "Feature: web-ui, Property 9: The error-frame / access-denied renderer
 *    discloses nothing beyond the safe fields"
 *
 * PROPERTY. For ANY `error` SSE frame carrying arbitrary ADDITIONAL fields
 * (cause, stack, secret, ids, path, projectId, …), the projection reads ONLY
 * `message` + `correlationId`; NO other field value appears in the projection or
 * in the state the dispatcher writes. The client shows the generic message and
 * the correlation id and nothing else.
 *
 * REAL COLLABORATORS. Drives the REAL `safeErrorFrame` projection and the REAL
 * frame dispatcher over the REAL store (`createFrameDispatcher` + createStore),
 * then scans the resulting store state for any adversarial secret value —
 * asserting none leaked. Adversarial values are made distinctive (a random
 * unguessable token) so a substring scan of the serialized state is a strong
 * non-disclosure check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { safeErrorFrame, createFrameDispatcher } from '../src/server/public/frames.js';
import { createStore } from '../src/server/public/store.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// A distinctive secret token unlikely to collide with safe content.
const secretValue = fc.string({ minLength: 6, maxLength: 40 }).map((s) => `SECRET_${s}_XYZ`);

/** An error frame seeded with adversarial extra fields carrying secret values. */
const adversarialErrorFrame = fc
  .record({
    message: fc.string({ maxLength: 60 }),
    correlationId: fc.string({ maxLength: 40 }),
    cause: secretValue,
    stack: secretValue,
    secret: secretValue,
    projectId: secretValue,
    path: secretValue,
    accountId: secretValue,
    detail: secretValue,
    internal: fc.record({ nested: secretValue }),
  })
  .map((f) => ({ type: 'error', ...f }));

test(webUiTag(9, 'The error-frame / access-denied renderer discloses nothing beyond the safe fields'), () => {
  fc.assert(
    fc.property(adversarialErrorFrame, (frame) => {
      // The set of secret values that MUST NOT appear anywhere downstream.
      const secrets = [
        frame.cause,
        frame.stack,
        frame.secret,
        frame.projectId,
        frame.path,
        frame.accountId,
        frame.detail,
        frame.internal.nested,
      ].filter((v) => typeof v === 'string' && v.length > 0);

      // (1) The pure projection reads ONLY message + correlationId.
      const safe = safeErrorFrame(frame);
      assert.deepEqual(Object.keys(safe).sort(), ['correlationId', 'message']);
      assert.equal(safe.message, typeof frame.message === 'string' ? frame.message : '');
      assert.equal(
        safe.correlationId,
        typeof frame.correlationId === 'string' ? frame.correlationId : '',
      );
      const safeSerialized = JSON.stringify(safe);
      for (const s of secrets) {
        assert.ok(!safeSerialized.includes(s), 'safe projection leaks no secret field');
      }

      // (2) The dispatcher writes only safe fields into the store; scan the WHOLE
      // resulting state for any secret value.
      const store = createStore();
      const dispatcher = createFrameDispatcher({ store });
      dispatcher.dispatch(frame);
      const stateSerialized = JSON.stringify(store.getState());
      for (const s of secrets) {
        assert.ok(!stateSerialized.includes(s), 'store state leaks no secret field');
      }

      // The generic message DID land in the notice (so the user is informed).
      const notice = store.getState().session.notice;
      assert.ok(notice, 'an error notice was set');
      assert.equal(notice.kind, 'error');
      assert.equal(notice.message, safe.message);
      return true;
    }),
    fcConfig,
  );
});

test('Property 9 guard: a bare error frame yields empty-but-safe fields', () => {
  const safe = safeErrorFrame({ type: 'error' });
  assert.deepEqual(safe, { message: '', correlationId: '' });
  // A non-object input is tolerated.
  assert.deepEqual(safeErrorFrame(null), { message: '', correlationId: '' });
});
