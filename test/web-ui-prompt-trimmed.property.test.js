/**
 * Property-based test for Web UI Task 3.4 (node --test).
 *
 * Property 2 — "A submitted prompt carries the trimmed text" (design
 * §"Property 2", Req 2.2). The test carries the EXACT spec tag required by the
 * web-ui spec:
 *
 *   "Feature: web-ui, Property 2: A submitted prompt carries the trimmed text"
 *
 * PROPERTY. For ANY prompt string that passes validation, the body sent to
 * `POST /message` contains EXACTLY the input trimmed of leading and trailing
 * whitespace — never the raw input. Equivalently: the transmitted text equals
 * `raw.trim()`, has no leading/trailing whitespace, and (when the raw input had
 * surrounding whitespace) is strictly shorter than the raw input.
 *
 * REAL COLLABORATORS. The REAL builder controller sends through the REAL api
 * client; the only seam is a recording fetch stub that captures the JSON body
 * actually put on the wire, so the assertion is against the shipping request
 * pipeline, not a re-derivation of what "should" have been sent.
 *
 * Hermetic: pure logic + an injected fetch stub. No network, no server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createBuilderController, PROMPT_MAX } from '../src/server/public/builder.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag. */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ---------------------------------------------------------------- generators

/** Unicode whitespace runs to wrap a core payload with. */
const WHITESPACE = [
  ' ', '\t', '\n', '\r', '\f', '\u00A0', '\u2003', '\u3000', '\uFEFF', '\u202F',
];
const whitespaceRun = fc
  .array(fc.constantFrom(...WHITESPACE), { minLength: 0, maxLength: 5 })
  .map((a) => a.join(''));

/**
 * A "core" payload that is guaranteed to have NO leading/trailing whitespace
 * and length in 1..maxCore, and that may itself contain interior whitespace
 * (which trim MUST preserve). Built by sandwiching interior content between two
 * non-whitespace anchor chars, or a single non-whitespace char.
 */
const nonWs = fc.constantFrom('a', 'Z', '9', '.', '!', '\u00E9', '\u4E2D', 'x', '_');
function corePayload(maxCore = 60) {
  const single = nonWs.map((c) => c);
  const multi = fc
    .tuple(nonWs, fc.string({ minLength: 0, maxLength: maxCore - 2 }), nonWs)
    .map(([a, mid, b]) => a + mid + b)
    // Guarantee the assembled core has no leading/trailing whitespace even if
    // `mid` began/ended with some (the anchors dominate, but be explicit).
    .filter((s) => s.length >= 1 && s === trimNothingLeadingTrailingGuard(s));
  return fc.oneof(single, multi);
}

/**
 * Guard used by the generator's filter: returns the string only if it has no
 * leading/trailing whitespace, else a mutated string so the filter drops it.
 * (Cheap and explicit rather than trusting the anchors alone.)
 */
function trimNothingLeadingTrailingGuard(s) {
  return s.trim() === s ? s : `${s}\u0000`;
}

/** A recording api client returning 202 so a valid submit resolves ok. */
function recordingClient() {
  const bodies = [];
  const api = createApiClient({
    getToken: () => 'tok-present',
    fetchImpl: async (url, init) => {
      if (typeof url === 'string' && url.includes('/message')) {
        bodies.push(init && typeof init.body === 'string' ? JSON.parse(init.body) : null);
      }
      return { status: 202, async json() { return { accepted: true }; } };
    },
  });
  return { api, bodies };
}

// ------------------------------------------------------ Property 2 (Task 3.4)

test(webUiTag(2, 'A submitted prompt carries the trimmed text'), async () => {
  await fc.assert(
    fc.asyncProperty(
      whitespaceRun,
      corePayload(80),
      whitespaceRun,
      async (lead, core, trail) => {
        const raw = lead + core + trail;
        // Only exercise inputs that actually pass validation (Property 1 owns
        // the gate itself); here we assert what a PASSING input transmits.
        const trimmed = raw.trim();
        fc.pre(trimmed.length >= 1 && trimmed.length <= PROMPT_MAX);

        const store = createStore();
        const { api, bodies } = recordingClient();
        const controller = createBuilderController({ store, api });

        const outcome = await controller.submit(raw);
        assert.equal(outcome.ok, true, 'a valid prompt submits');

        assert.equal(bodies.length, 1, 'exactly one /message body captured');
        const sent = bodies[0];
        assert.ok(sent && typeof sent.text === 'string', 'body carries a text field');

        // The CORE property: transmitted text is exactly raw.trim().
        assert.equal(sent.text, trimmed, 'transmitted text is the trimmed input');
        // ...and therefore has no surrounding whitespace.
        assert.equal(sent.text, sent.text.trim(), 'transmitted text has no edge whitespace');
        // If the raw input had surrounding whitespace, the sent text is shorter
        // than the raw — proving the raw was NOT sent verbatim.
        if (lead.length + trail.length > 0) {
          assert.ok(sent.text.length < raw.length, 'raw (untrimmed) input was not sent');
        }
        return true;
      },
    ),
    fcConfig,
  );
});

// -------------------------------------------- Mutation / test-quality guard

/**
 * Prove the assertion pins trimming (not vacuous): a raw input with known
 * padding transmits exactly the interior, and interior whitespace is preserved.
 */
test('Property 2 guard: edges trimmed, interior preserved', async () => {
  const store = createStore();
  const { api, bodies } = recordingClient();
  const controller = createBuilderController({ store, api });

  const raw = '\u3000  build a\ttodo  app  \n';
  const outcome = await controller.submit(raw);
  assert.equal(outcome.ok, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].text, 'build a\ttodo  app', 'edges trimmed, interior kept');
  assert.notEqual(bodies[0].text, raw, 'not the raw input');
});
