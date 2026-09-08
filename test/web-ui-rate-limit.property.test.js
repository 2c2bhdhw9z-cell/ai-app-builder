/**
 * Property-based test for Web UI Task 2.3 (node --test).
 *
 * Property 4 — "A rate-limited surface displays the named limit and retains
 * input" (design §"Property 4", Req 2.8, 7.5). The test carries the EXACT spec
 * tag required by the web-ui spec:
 *
 *   "Feature: web-ui, Property 4: A rate-limited surface displays the named
 *    limit and retains input"
 *
 * SCOPE (this is the TRANSPORT layer). The full property spans two layers:
 *   (a) the transport layer (api.js) must map ANY HTTP 429 that names an
 *       exceeded limit to a tagged { kind:'rateLimited', limit, ... } result
 *       that PRESERVES the named limit (and its operation/resource) verbatim,
 *       so nothing downstream has to re-derive it; and
 *   (b) the surface/controller layer must then DISPLAY that named limit and
 *       RETAIN the user's input for retry.
 * Half (b) — input retention on the prompt/project-creation surfaces — lives in
 * the builder/projects controllers built in later tasks (3.x/9.x) and is
 * exercised there. This test covers exactly what belongs to THIS layer: the
 * faithful, lossless mapping of a named-limit 429, proven two ways —
 *   1. against the REAL pure classifier `classify(429, body)`; and
 *   2. end-to-end through the REAL `createApiClient(...).request(...)` driven by
 *      an injected fetch that returns a synthetic 429 (a real collaborator, not
 *      an over-mock of the client itself).
 *
 * The generator mirrors the backend's real 429 shapes (see the Builder Server
 * quota responses): a rate limit is `{ error, limit, operation }`; a resource
 * quota is `{ error, limit, resource }`. Adversarial extras (unrelated fields)
 * are mixed in to prove they neither break the mapping nor leak into a place
 * that would mask the named limit.
 *
 * Hermetic: pure logic + an injected fetch stub. No network, no server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { classify, createApiClient, RESULT } from '../src/server/public/api.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag (distinct from the platform-wide ai-app-builder tag). */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ---------------------------------------------------------------- generators

/** A non-empty limit name (what the backend NAMES as exceeded, e.g. Rate_Limit). */
const limitName = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** A human error string the backend attaches alongside the named limit. */
const errorMessage = fc.string({ minLength: 0, maxLength: 80 });

/** Arbitrary adversarial extra fields that must not disturb the mapping. */
const extraFields = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 12 }).filter(
    (k) => !['limit', 'operation', 'resource', 'error'].includes(k),
  ),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { maxKeys: 4 },
);

/**
 * A realistic 429 body naming an exceeded limit — either a rate limit (carries
 * `operation`) or a resource quota (carries `resource`), plus a human `error`
 * and possibly unrelated extra fields.
 */
const namedLimit429Body = fc
  .record({
    limit: limitName,
    error: errorMessage,
    kindTag: fc.constantFrom('operation', 'resource'),
    detail: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
    extras: extraFields,
  })
  .map(({ limit, error, kindTag, detail, extras }) => {
    const body = { ...extras, limit, error };
    body[kindTag] = detail; // exactly one of operation|resource, as the server does
    return body;
  });

/** A fetch stub returning a synthetic 429 with the given JSON body. */
function fetchReturning(status, body) {
  return async () => ({
    status,
    async json() {
      return body;
    },
  });
}

// ------------------------------------------------------ Property 4 (Task 2.3)

test(webUiTag(4, 'A rate-limited surface displays the named limit and retains input'), async () => {
  // Part 1: the pure classifier preserves the named limit + operation/resource.
  fc.assert(
    fc.property(namedLimit429Body, (body) => {
      const result = classify(429, body);

      assert.equal(result.kind, RESULT.RATE_LIMITED, '429 must classify as rateLimited');
      // The NAMED limit is preserved verbatim so the surface can display it.
      assert.equal(result.limit, body.limit, 'named limit preserved verbatim');
      // Whichever of operation/resource the backend sent is carried through.
      if (typeof body.operation === 'string') {
        assert.equal(result.operation, body.operation, 'operation carried through');
      }
      if (typeof body.resource === 'string') {
        assert.equal(result.resource, body.resource, 'resource carried through');
      }
      // The named limit is a non-empty string the view can render.
      assert.equal(typeof result.limit, 'string');
      assert.ok(result.limit.length > 0, 'named limit is displayable (non-empty)');
      return true;
    }),
    fcConfig,
  );

  // Part 2: end-to-end through the REAL client with an injected fetch. The
  // client resolves the same rateLimited result carrying the named limit — the
  // input-retention half is enforced by the calling controller in later tasks.
  await fc.assert(
    fc.asyncProperty(namedLimit429Body, async (body) => {
      const api = createApiClient({
        getToken: () => 'tok-present', // gated call proceeds to the network
        fetchImpl: fetchReturning(429, body),
      });
      const result = await api.request('POST', '/message', { body: { text: 'hi' } });

      assert.equal(result.kind, RESULT.RATE_LIMITED);
      assert.equal(result.limit, body.limit, 'client surfaces the named limit');
      return true;
    }),
    fcConfig,
  );
});

// -------------------------------------------- Mutation / test-quality guard

/**
 * Prove the assertion is not vacuous: a 429 whose NAMED limit differs from what
 * we assert must fail an equality check, and a non-429 status must NOT be
 * classified as rateLimited. This shows the property genuinely pins the
 * limit-preservation behavior rather than trivially passing.
 */
test('Property 4 guard: the named-limit mapping is exact and status-specific', () => {
  const rl = classify(429, { limit: 'Rate_Limit', operation: 'generation.turn', error: 'slow down' });
  assert.equal(rl.kind, RESULT.RATE_LIMITED);
  assert.equal(rl.limit, 'Rate_Limit');
  assert.equal(rl.operation, 'generation.turn');
  // A different asserted name would not match — the mapping is exact.
  assert.notEqual(rl.limit, 'Resource_Quota');

  // A 429 with no named limit still classifies as rateLimited but carries null
  // (the surface then shows a generic rate-limit notice).
  const unnamed = classify(429, { error: 'too many' });
  assert.equal(unnamed.kind, RESULT.RATE_LIMITED);
  assert.equal(unnamed.limit, null);

  // Status specificity: a 200/400 is NOT a rate-limit outcome.
  assert.notEqual(classify(200, { limit: 'Rate_Limit' }).kind, RESULT.RATE_LIMITED);
  assert.notEqual(classify(400, { limit: 'Rate_Limit' }).kind, RESULT.RATE_LIMITED);
});
