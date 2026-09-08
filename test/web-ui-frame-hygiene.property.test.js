/**
 * Property-based test for Web UI Task 4.7 (node --test).
 *
 * Property 8 — "Unrecognized or oversized frames are dropped without closing
 * the stream" (design §"Property 8", Req 3.9). Exact spec tag:
 *
 *   "Feature: web-ui, Property 8: Unrecognized or oversized frames are dropped
 *    without closing the stream"
 *
 * PROPERTY. For ANY received frame, if its serialized size exceeds 1,048,576
 * bytes OR its `type` is not in the recognized frame-type set, the client
 * renders nothing and mutates no state for that frame while leaving the SSE
 * connection OPEN; every recognized, in-size frame is dispatched to its handler.
 *
 * REAL COLLABORATORS. Drives the REAL `createSseClient` fed by an injected fetch
 * whose body is an async-iterable emitting real `data: …\n\n` SSE frames (the
 * same wire the server writes). We observe which frames reach `onFrame` and that
 * the status stays OPEN throughout — the hygiene gate + the parser under test
 * are the shipping code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createSseClient, SSE_STATUS } from '../src/server/public/sse.js';
import { RECOGNIZED_TYPES, MAX_FRAME_BYTES } from '../src/server/public/frames.js';
import { fcConfig } from './support/fc.js';

/** Pump microtasks until the async body reader has fully drained. */
async function pump(n = 80) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/** A getReader()-style body delivering all chunks then done. */
function readerBody(chunks) {
  let i = 0;
  return {
    getReader() {
      return {
        read: async () =>
          i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true },
        cancel: async () => {},
      };
    },
  };
}

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

class FakeAbortController {
  constructor() {
    this.signal = { aborted: false };
  }
  abort() {
    this.signal.aborted = true;
  }
}

/**
 * Build an SSE client whose fetch streams the given `data:` payload strings, one
 * frame per element, then ends the stream. Records the frames that reach
 * onFrame and every status emitted.
 */
function clientOverFrames(payloads) {
  const received = [];
  const statuses = [];
  // Open comment + retry hint (mirrors the real server) then each frame, each as
  // its own chunk on the wire.
  const chunks = [': connected\n', 'retry: 2000\n\n', ...payloads.map((p) => `data: ${p}\n\n`)];
  const client = createSseClient({
    getToken: () => 'tok',
    AbortControllerImpl: FakeAbortController,
    setTimeoutImpl: (cb) => { void cb; return 0; }, // never auto-fire reconnect in this test
    clearTimeoutImpl: () => {},
    fetchImpl: async () => ({ status: 200, body: readerBody(chunks) }),
  });
  client.onFrame((f) => received.push(f));
  client.onStatus((s) => statuses.push(s));
  return { client, received, statuses };
}

/** A generator of mixed frames: recognized, unrecognized-type, and oversized. */
const mixedFrame = fc.oneof(
  // recognized in-size frames
  fc.record({ type: fc.constantFrom(...RECOGNIZED_TYPES), text: fc.string({ maxLength: 8 }) }),
  // unrecognized types
  fc.record({
    type: fc.constantFrom('bogus', 'evil', 'unknown_frame', 'preview', 'THEME'),
    text: fc.string({ maxLength: 8 }),
  }),
  // an oversized-but-recognized frame (huge string pushes it over 1 MiB)
  fc.constant({ type: 'reasoning_delta', text: 'x'.repeat(MAX_FRAME_BYTES + 16) }),
);

test(webUiTag(8, 'Unrecognized or oversized frames are dropped without closing the stream'), async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(mixedFrame, { minLength: 1, maxLength: 25 }), async (frames) => {
      const payloads = frames.map((f) => JSON.stringify(f));
      const { client, received, statuses } = clientOverFrames(payloads);

      client.connect('proj');
      // Let the async body reader drain fully.
      await pump();

      // Expected surviving frames: recognized type AND serialized size < cap.
      const expected = payloads.filter((p) => {
        if (Buffer.byteLength(p, 'utf8') >= MAX_FRAME_BYTES) return false;
        let obj;
        try {
          obj = JSON.parse(p);
        } catch {
          return false;
        }
        return typeof obj.type === 'string' && RECOGNIZED_TYPES.has(obj.type);
      });

      assert.equal(received.length, expected.length, 'only recognized in-size frames delivered');
      for (const f of received) {
        assert.ok(RECOGNIZED_TYPES.has(f.type), 'a delivered frame has a recognized type');
        assert.ok(
          Buffer.byteLength(JSON.stringify(f), 'utf8') < MAX_FRAME_BYTES,
          'a delivered frame is within the size cap',
        );
      }

      // The connection was OPENED and never went to lost/closed as a RESULT of a
      // dropped frame (Req 3.9). It reached OPEN; it did not report LOST.
      assert.ok(statuses.includes(SSE_STATUS.OPEN), 'stream opened');
      assert.ok(!statuses.includes(SSE_STATUS.LOST), 'a dropped frame never lost the stream');
      return true;
    }),
    fcConfig,
  );
});

test('Property 8 guard: an oversized recognized frame is dropped, a small one passes', async () => {
  const big = JSON.stringify({ type: 'reasoning_delta', text: 'y'.repeat(MAX_FRAME_BYTES) });
  const small = JSON.stringify({ type: 'reasoning_delta', text: 'hi' });
  const { client, received } = clientOverFrames([big, small]);
  client.connect('p');
  await pump();
  assert.equal(received.length, 1, 'only the small frame survives');
  assert.equal(received[0].text, 'hi');
});
