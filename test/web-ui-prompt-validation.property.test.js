/**
 * Property-based test for Web UI Task 3.3 (node --test).
 *
 * Property 1 — "Prompt validation gates submission by trimmed length"
 * (design §"Property 1", Req 2.2, 2.3, 2.4). The test carries the EXACT spec
 * tag required by the web-ui spec:
 *
 *   "Feature: web-ui, Property 1: Prompt validation gates submission by trimmed
 *    length"
 *
 * PROPERTY. For ANY prompt string, the client issues `POST /message` (with the
 * trimmed text) IFF the string's length after trimming leading/trailing
 * whitespace is in the inclusive range 1..10,000. A string that trims to length
 * 0 (including all-whitespace strings) or to length > 10,000 is rejected with:
 *   - NO `POST /message` call, and
 *   - the entered text RETAINED in the prompt input (mirrored into the store).
 *
 * REAL COLLABORATORS (no over-mocking). The test drives the REAL builder
 * controller (`createBuilderController`) over the REAL store (`createStore`) and
 * the REAL api client (`createApiClient`). The only injected seam is a RECORDING
 * `fetch` stub so the test can OBSERVE whether a network call to `/message`
 * happened — the validation gate, the store dispatches, and the api request
 * pipeline are all the shipping code.
 *
 * GENERATORS explicitly include:
 *   - Unicode whitespace code points (so all-whitespace strings trim to 0), and
 *   - the exact boundary trimmed lengths 0, 1, 10000, 10001,
 * because those are where a naive off-by-one or a non-Unicode-aware trim breaks.
 *
 * Hermetic: pure logic + an injected fetch stub. No network, no server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import {
  createBuilderController,
  validatePrompt,
  PROMPT_MIN,
  PROMPT_MAX,
} from '../src/server/public/builder.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag. */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ---------------------------------------------------------------- generators

/**
 * A spread of Unicode whitespace code points that `String.prototype.trim`
 * strips. Includes ASCII spaces/tabs/newlines, NBSP, the en/em quad family, the
 * ideographic space, and the BOM/ZWNBSP — so an "all whitespace" string built
 * from these MUST trim to length 0.
 */
const WHITESPACE = [
  ' ', '\t', '\n', '\r', '\f', '\v',
  '\u00A0', // no-break space
  '\u1680', // ogham space mark
  '\u2000', '\u2001', '\u2002', '\u2003', '\u2004',
  '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A',
  '\u2028', '\u2029', // line/paragraph separators
  '\u202F', // narrow no-break space
  '\u205F', // medium mathematical space
  '\u3000', // ideographic space
  '\uFEFF', // zero-width no-break space (BOM)
];

const whitespaceChar = fc.constantFrom(...WHITESPACE);
const whitespaceRun = fc.array(whitespaceChar, { minLength: 0, maxLength: 6 }).map((a) => a.join(''));

/** A non-whitespace "core" character so a run's trimmed length is predictable. */
const coreChar = fc.constantFrom('a', 'b', 'Z', '9', '.', '\u00E9', '\u4E2D', '\uD83D\uDE00');

/**
 * Build a prompt whose TRIMMED length we control exactly to `coreLen`, wrapped
 * in arbitrary leading/trailing whitespace. When coreLen === 0 the whole string
 * is whitespace (or empty). Uses single-UTF16-unit core chars so `.length`
 * equals the intended count; the emoji is only used for the standalone
 * multi-unit spot-check below.
 */
function promptWithTrimmedLength(coreLen) {
  const singleUnitCore = fc.constantFrom('a', 'b', 'Z', '9', '.', '\u00E9', '\u4E2D');
  return fc
    .tuple(
      whitespaceRun,
      fc.array(singleUnitCore, { minLength: coreLen, maxLength: coreLen }),
      whitespaceRun,
    )
    .map(([lead, core, trail]) => lead + core.join('') + trail);
}

/**
 * A recording api client over the REAL createApiClient: an injected fetch stub
 * records every call so the test can assert IFF `/message` was hit, and returns
 * a 202 so a VALID submit resolves `ok` (the accepted-turn path).
 */
function recordingClient() {
  const calls = [];
  const api = createApiClient({
    getToken: () => 'tok-present', // a token is held so gated calls proceed
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 202,
        async json() {
          return { accepted: true };
        },
      };
    },
  });
  return { api, calls };
}

/** True if any recorded fetch targeted the /message endpoint. */
function postedMessage(calls) {
  return calls.some((c) => typeof c.url === 'string' && c.url.includes('/message'));
}

// ------------------------------------------------------ Property 1 (Task 3.3)

test(webUiTag(1, 'Prompt validation gates submission by trimmed length'), async () => {
  // A generator over the interesting partitions: the exact boundaries plus a
  // random spread on each side of both bounds, and pure-whitespace strings.
  const boundaryCoreLen = fc.oneof(
    fc.constant(0), // trims to 0 -> reject (empty)
    fc.constant(PROMPT_MIN), // 1 -> accept (lower boundary)
    fc.constant(PROMPT_MAX), // 10000 -> accept (upper boundary)
    fc.constant(PROMPT_MAX + 1), // 10001 -> reject (over)
    fc.integer({ min: 0, max: 3 }), // near-empty spread
    fc.integer({ min: PROMPT_MAX - 2, max: PROMPT_MAX + 2 }), // near-upper spread
    fc.integer({ min: 1, max: PROMPT_MAX }), // interior valid spread
  );

  await fc.assert(
    fc.asyncProperty(boundaryCoreLen, async (coreLen) => {
      const prompt = fc.sample(promptWithTrimmedLength(coreLen), 1)[0];

      const store = createStore();
      const { api, calls } = recordingClient();
      const controller = createBuilderController({ store, api });

      const trimmed = prompt.trim();
      const shouldSubmit = trimmed.length >= PROMPT_MIN && trimmed.length <= PROMPT_MAX;

      // The pure validator agrees with the length predicate (real gate).
      assert.equal(validatePrompt(prompt).ok, shouldSubmit, 'validator matches the length gate');

      const outcome = await controller.submit(prompt);

      if (shouldSubmit) {
        // Submitted: exactly one /message call was made.
        assert.ok(postedMessage(calls), 'a valid prompt submits POST /message');
        assert.equal(
          calls.filter((c) => c.url.includes('/message')).length,
          1,
          'exactly one /message call for one submit',
        );
        assert.equal(outcome.ok, true);
      } else {
        // Rejected: NO /message call, and the entered text is retained.
        assert.ok(!postedMessage(calls), 'a rejected prompt makes NO /message call');
        assert.equal(outcome.ok, false);
        assert.equal(
          store.getState().session.pendingPromptText,
          prompt,
          'the entered text is retained on rejection',
        );
      }
      return true;
    }),
    fcConfig,
  );

  // Spot-check: an all-whitespace string (built purely from Unicode whitespace)
  // trims to 0 and is rejected without a network call — the Unicode-trim case.
  await fc.assert(
    fc.asyncProperty(
      fc.array(whitespaceChar, { minLength: 1, maxLength: 12 }).map((a) => a.join('')),
      async (allWs) => {
        const store = createStore();
        const { api, calls } = recordingClient();
        const controller = createBuilderController({ store, api });
        const outcome = await controller.submit(allWs);
        assert.equal(validatePrompt(allWs).ok, false, 'all-whitespace trims to empty');
        assert.equal(outcome.ok, false);
        assert.ok(!postedMessage(calls), 'all-whitespace makes no /message call');
        assert.equal(store.getState().session.pendingPromptText, allWs, 'whitespace text retained');
        return true;
      },
    ),
    fcConfig,
  );
});

// -------------------------------------------- Mutation / test-quality guard

/**
 * Prove the boundary is EXACT and the test is not vacuous: 0 rejects, 1 and
 * 10000 accept, 10001 rejects. If the gate were `<`/`>` off by one, one of
 * these flips.
 */
test('Property 1 guard: trimmed-length boundaries 0/1/10000/10001 are exact', () => {
  assert.equal(validatePrompt('   ').ok, false, '0 (all ws) rejects');
  assert.equal(validatePrompt(' a ').ok, true, '1 accepts');
  assert.equal(validatePrompt('a'.repeat(PROMPT_MAX)).ok, true, '10000 accepts');
  assert.equal(validatePrompt('a'.repeat(PROMPT_MAX + 1)).ok, false, '10001 rejects');
  // Whitespace padding does not change the trimmed length verdict at the bound.
  assert.equal(validatePrompt(`\u3000${'a'.repeat(PROMPT_MAX)}\u00A0`).ok, true, 'padded 10000 accepts');
  assert.equal(validatePrompt(`  ${'a'.repeat(PROMPT_MAX + 1)}  `).ok, false, 'padded 10001 rejects');
});
