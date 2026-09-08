/**
 * Property-based test for Web UI Task 2.4 (node --test).
 *
 * Property 31 — "An Access_Denied_Response yields one generic indication and
 * discloses nothing" (design §"Property 31", Req 16.1, 2.7, 5.5, 15.6). The
 * test carries the EXACT spec tag required by the web-ui spec:
 *
 *   "Feature: web-ui, Property 31: An Access_Denied_Response yields one generic
 *    indication and discloses nothing"
 *
 * SCOPE (transport layer, api.js). For ANY HTTP 401 response — including
 * adversarial bodies that embed project ids, filesystem paths, or
 * resource-existence hints — the client must:
 *   1. produce a SINGLE generic denial: `{ kind: 'denied' }`;
 *   2. carry NOTHING from the 401 body: no field NAME and no field VALUE from
 *      the body appears anywhere in the returned result (Req 16.1, 2.7); and
 *   3. do so identically regardless of which gated surface issued the call
 *      (5.5, 15.6) — the classification is centralized, so one 401 body maps to
 *      one bare denied result no matter the path.
 * A 401 additionally fires the `onAccessDenied` seam (so the auth controller
 * can clear the token and return to login, Req 6.7) — we assert it fires
 * exactly once and that its context carries no body detail either.
 *
 * This exercises the REAL classifier `classify(401, body)` AND the REAL
 * `createApiClient(...).request(...)` driven by an injected fetch returning a
 * synthetic 401 (a real collaborator, not an over-mock). The "no field value
 * leaks" check deep-walks the ENTIRE returned result object and asserts no
 * generated body value is present as a substring anywhere.
 *
 * Hermetic: pure logic + an injected fetch stub. No network, no server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { classify, createApiClient, RESULT } from '../src/server/public/api.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag. */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ---------------------------------------------------------------- generators

/**
 * Distinctive, greppable sentinel values that would be a disclosure if leaked.
 * Each is unusual enough that an accidental substring collision with a static
 * string like "denied" is effectively impossible.
 */
const secretValue = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }).map((s) => `PROJ-${s}-ID`), // project id
  fc.string({ minLength: 1, maxLength: 40 }).map((s) => `/srv/projects/${s}/main.js`), // path
  fc.constantFrom(
    'project exists',
    'no such project',
    'account 12345 owns this',
    'forbidden: not your resource',
    's3://bucket/secret-key',
    'stacktrace at handler.js:42',
  ),
);

/**
 * An adversarial 401 body: an object mixing the backend's generic marker with
 * disclosure-bearing fields (ids/paths/existence hints), plus occasionally a
 * non-object body (string / null) to prove those are handled too. Returns
 * `{ body, sensitiveValues }` so the test knows exactly which strings must NOT
 * appear in the result.
 */
const adversarial401 = fc
  .record({
    includeGenericError: fc.boolean(),
    projectId: secretValue,
    path: secretValue,
    hint: secretValue,
    extraKey: fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
    extraVal: secretValue,
    shape: fc.constantFrom('object', 'string', 'null'),
  })
  .map(({ includeGenericError, projectId, path, hint, extraKey, extraVal, shape }) => {
    if (shape === 'null') {
      return { body: null, sensitiveValues: [] };
    }
    if (shape === 'string') {
      // A raw string body embedding a disclosure.
      return { body: hint, sensitiveValues: [hint] };
    }
    const body = {
      projectId,
      resourcePath: path,
      existence: hint,
      [extraKey]: extraVal,
    };
    if (includeGenericError) body.error = 'access denied';
    // Every VALUE that is a disclosure (not the generic marker/keys).
    const sensitiveValues = [projectId, path, hint, extraVal];
    return { body, sensitiveValues };
  });

/** A fetch stub returning a synthetic response with the given status/body. */
function fetchReturning(status, body) {
  return async () => ({
    status,
    async json() {
      if (body === null) return null;
      return body;
    },
  });
}

/** Recursively collect every string appearing anywhere in a value (keys + values). */
function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  } else if (value !== null && value !== undefined) {
    out.push(String(value));
  }
  return out;
}

// ------------------------------------------------------ Property 31 (Task 2.4)

test(
  webUiTag(31, 'An Access_Denied_Response yields one generic indication and discloses nothing'),
  async () => {
    // Part 1: the pure classifier discards the body entirely.
    fc.assert(
      fc.property(adversarial401, ({ body, sensitiveValues }) => {
        const result = classify(401, body);

        // Exactly one generic denial, and NOTHING else on the result object.
        assert.equal(result.kind, RESULT.DENIED, '401 must be a generic denial');
        assert.deepEqual(Object.keys(result), ['kind'], 'denied result carries ONLY { kind }');

        // No disclosure value appears anywhere in the serialized result.
        const haystack = collectStrings(result).join('\u0000');
        for (const secret of sensitiveValues) {
          assert.ok(
            !haystack.includes(secret),
            `no 401 body value may appear in the result (leaked: ${secret})`,
          );
        }
        return true;
      }),
      fcConfig,
    );

    // Part 2: end-to-end through the REAL client, across MULTIPLE gated
    // surfaces, proving the same bare denial and the single onAccessDenied fire
    // regardless of path (Req 5.5, 15.6, 6.7).
    const gatedPaths = ['/message', '/confirm', '/projects', '/preview', '/theme', '/work-mode'];
    await fc.assert(
      fc.asyncProperty(
        adversarial401,
        fc.constantFrom(...gatedPaths),
        async ({ body, sensitiveValues }, path) => {
          let denialFires = 0;
          let deniedContext = null;
          const api = createApiClient({
            getToken: () => 'tok-present',
            fetchImpl: fetchReturning(401, body),
          });
          api.onAccessDenied((ctx) => {
            denialFires += 1;
            deniedContext = ctx;
          });

          const result = await api.request('POST', path, { body: { any: 'thing' } });

          assert.equal(result.kind, RESULT.DENIED);
          assert.deepEqual(Object.keys(result), ['kind']);

          // The access-denied seam fired exactly once...
          assert.equal(denialFires, 1, 'onAccessDenied fires exactly once per 401');
          // ...and its context discloses nothing from the body either (it only
          // knows which local call was made).
          const ctxStrings = collectStrings(deniedContext).join('\u0000');
          for (const secret of sensitiveValues) {
            assert.ok(!ctxStrings.includes(secret), 'onAccessDenied context leaks no body value');
          }

          // Nothing from the body leaked into the result.
          const haystack = collectStrings(result).join('\u0000');
          for (const secret of sensitiveValues) {
            assert.ok(!haystack.includes(secret), 'client result leaks no 401 body value');
          }
          return true;
        },
      ),
      fcConfig,
    );
  },
);

// -------------------------------------------- Mutation / test-quality guard

/**
 * Prove the leak detector is not vacuous: if the result DID carry a body value,
 * `collectStrings` + the substring check would catch it. We construct a
 * deliberately-leaky object and assert the detector flags it, then confirm the
 * real classifier does NOT produce such an object.
 */
test('Property 31 guard: the leak detector catches a value that is actually present', () => {
  const secret = 'PROJ-leaky-ID';
  const leakyResult = { kind: 'denied', echoed: { projectId: secret } };
  const leakyHaystack = collectStrings(leakyResult).join('\u0000');
  assert.ok(leakyHaystack.includes(secret), 'detector must catch a genuinely leaked value');

  // The REAL classifier never yields such a result: the body is discarded.
  const real = classify(401, { projectId: secret, error: 'access denied' });
  assert.deepEqual(Object.keys(real), ['kind']);
  const realHaystack = collectStrings(real).join('\u0000');
  assert.ok(!realHaystack.includes(secret), 'real denied result contains no body value');
});
