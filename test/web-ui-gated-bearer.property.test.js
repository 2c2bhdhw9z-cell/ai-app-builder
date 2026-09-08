/**
 * Property-based test for Web UI Task 8.4 (node --test).
 *
 * Property 19 — "Every gated request while a token is held carries the Bearer
 * header" (design §"Property 19", Req 6.4, 3.1). Exact spec tag:
 *
 *   "Feature: web-ui, Property 19: Every gated request while a token is held
 *    carries the Bearer header"
 *
 * SCOPE. While a Token_Store record is present, EVERY gated operation the
 * client issues carries `Authorization: Bearer <token>` with the STORED token:
 *   - the gated api.js calls: POST /message, POST /confirm, POST /projects,
 *     GET /preview, POST /preview/restart, GET/POST /theme, GET/POST
 *     /work-mode, GET/POST /workspace-experience; and
 *   - the sse.js `GET /events` connect (which uses a fetch()-based reader
 *     precisely so the Bearer CAN be attached — a native EventSource cannot).
 *
 * REAL COLLABORATORS. The token is read through the SAME `getToken` seam the
 * shipping app.js wires from the REAL Token_Store into BOTH createApiClient and
 * createSseClient. The test builds the REAL clients with `getToken:
 * () => tokenStore.getToken()` and an injected fetch that CAPTURES the outgoing
 * headers, then asserts the exact Bearer value. No stand-in token source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createTokenStore } from '../src/server/public/token-store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createSseClient } from '../src/server/public/sse.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

const NOW = Date.parse('2024-06-01T00:00:00.000Z');
const now = () => NOW;

/**
 * The full set of gated operations the client issues, as (method, path) pairs.
 * Mirrors the design's Property-19 enumeration exactly.
 */
const GATED_OPS = [
  ['POST', '/message'],
  ['POST', '/confirm'],
  ['POST', '/projects'],
  ['GET', '/preview'],
  ['POST', '/preview/restart'],
  ['GET', '/theme'],
  ['POST', '/theme'],
  ['GET', '/work-mode'],
  ['POST', '/work-mode'],
  ['GET', '/workspace-experience'],
  ['POST', '/workspace-experience'],
];

/** Header lookup tolerant of case (fetch init headers are a plain object here). */
function authHeaderOf(init) {
  const h = (init && init.headers) || {};
  return h.authorization ?? h.Authorization ?? null;
}

const nonEmptyStr = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.length > 0);
const futureIso = fc
  .integer({ min: 10_000, max: 5 * 365 * 24 * 3600 * 1000 })
  .map((d) => new Date(NOW + d).toISOString());

// ------------------------------------------------------ Property 19 (Task 8.4)

test(
  webUiTag(19, 'Every gated request while a token is held carries the Bearer header'),
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ token: nonEmptyStr, accountId: nonEmptyStr, expiresAt: futureIso }),
        fc.constantFrom(...GATED_OPS.map((_, i) => i)),
        async (record, opIndex) => {
          const [method, path] = GATED_OPS[opIndex];

          // A REAL Token_Store holding the record; the SAME seam app.js wires.
          const tokenStore = createTokenStore({ now, storage: null });
          assert.equal(tokenStore.set(record), true, 'record stored');
          const getToken = () => tokenStore.getToken();

          // ---- api.js gated call carries the Bearer -----------------------
          let captured = null;
          const api = createApiClient({
            getToken,
            fetchImpl: async (url, init) => {
              captured = { url, init };
              return { status: 200, json: async () => ({}) };
            },
          });
          const body = method === 'POST' ? { any: 'thing' } : undefined;
          await api.request(method, path, body ? { body } : {});

          assert.ok(captured, `fetch was invoked for ${method} ${path}`);
          assert.equal(
            authHeaderOf(captured.init),
            `Bearer ${record.token}`,
            `${method} ${path} carries Authorization: Bearer <stored token>`,
          );
          return true;
        },
      ),
      fcConfig,
    );
  },
);

test(
  webUiTag(19, 'the /events SSE connect carries the Bearer header from the same token seam'),
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ token: nonEmptyStr, accountId: nonEmptyStr, expiresAt: futureIso }),
        fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.length > 0),
        async (record, projectId) => {
          const tokenStore = createTokenStore({ now, storage: null });
          assert.equal(tokenStore.set(record), true);
          const getToken = () => tokenStore.getToken();

          let captured = null;
          // A fetch that captures the /events open, then returns a stream that
          // ends immediately so the reader completes without a real network.
          const fetchImpl = async (url, init) => {
            captured = { url, init };
            return {
              status: 200,
              body: {
                async *[Symbol.asyncIterator]() {
                  /* immediately-closing stream */
                },
              },
            };
          };
          const sse = createSseClient({
            getToken,
            fetchImpl,
            AbortControllerImpl: class {
              constructor() {
                this.signal = {};
              }
              abort() {}
            },
            // Immediate timer so any scheduled reconnect does not linger.
            setTimeoutImpl: () => ({ unref() {} }),
            clearTimeoutImpl: () => {},
          });

          sse.connect(projectId);
          // Let the async open run.
          await Promise.resolve();
          await Promise.resolve();

          assert.ok(captured, 'the /events stream was opened');
          assert.ok(String(captured.url).includes('/events'), 'opened GET /events');
          assert.equal(
            authHeaderOf(captured.init),
            `Bearer ${record.token}`,
            'the /events connect carries Authorization: Bearer <stored token>',
          );
          sse.disconnect();
          return true;
        },
      ),
      fcConfig,
    );
  },
);

// -------------------------------------------- guard: no token → no Bearer, no call

test('Property 19 guard: with NO token held, a gated api call attaches no Bearer and makes no network call', async () => {
  const tokenStore = createTokenStore({ now, storage: null });
  let called = false;
  const api = createApiClient({
    getToken: () => tokenStore.getToken(),
    fetchImpl: async () => {
      called = true;
      return { status: 200, json: async () => ({}) };
    },
  });
  const result = await api.request('POST', '/message', { body: { text: 'hi' } });
  assert.equal(called, false, 'no network call is made without a token (Req 6.4)');
  assert.equal(result.kind, 'denied', 'a gated call with no token resolves denied');
});
