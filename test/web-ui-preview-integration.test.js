/**
 * Integration test for Web UI Task 5.10 (node --test), Req 4.7, 4.10, 4.11.
 *
 * Three integration concerns that are NOT universal-logic properties:
 *
 *   1. 5s poll CADENCE with a fake clock (Req 4.7): with an injected interval
 *      timer, the poller schedules GET /preview at the 5,000 ms interval while a
 *      session is open, and stops on session close. Uses the REAL poller + REAL
 *      gated api client over a scripted fetch — no real timers, no real network.
 *
 *   2. SAME-ORIGIN iframe + the app document is NOT embeddable cross-origin
 *      (Req 4.11): the served index shell + the CSP headers the real
 *      Builder_Server emits enforce `frame-ancestors 'none'` / `X-Frame-Options:
 *      DENY` (app not embeddable), while a same-origin <iframe> inside the app
 *      pointing at a same-origin preview URL is allowed by default-src 'self'.
 *      The Preview_Pane renders exactly such a same-origin, relative-URL iframe.
 *
 *   3. The QR is an `img-src 'self' data:`-legal image (Req 4.10): the CSP the
 *      server emits includes `img-src 'self' data:`, and the Preview_Pane's QR
 *      is a `data:` image URI (never an external origin).
 *
 * The server is bound on an ephemeral port (listen 0) and driven with node's
 * global fetch, exactly as the other builder-server integration tests do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createScriptedProvider } from '../src/engine/plumby.js';
import { createStore, ACTIONS, selectPreview } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createPreviewPoll, POLL_INTERVAL_MS } from '../src/server/public/preview-poll.js';
import { createPreviewController, previewViewModel } from '../src/server/public/preview.js';
import { createPreviewPaneView, PREVIEW_DOM } from '../src/server/public/views/preview-pane.js';

// ------------------------------------------------------------- fake clock timer
// A minimal interval scheduler: registers callbacks with their interval and
// fires them when `tick(ms)` advances past a whole multiple of the interval.
function fakeIntervalTimer() {
  const timers = new Map();
  let nextId = 1;
  let now = 0;
  return {
    setIntervalImpl(cb, ms) {
      const id = nextId++;
      timers.set(id, { cb, ms, last: now });
      return { id, unref() {} };
    },
    clearIntervalImpl(handle) {
      if (handle && timers.has(handle.id)) timers.delete(handle.id);
    },
    /** Advance the clock by `ms`, firing each interval callback once per elapsed period. */
    async tick(ms) {
      now += ms;
      for (const t of timers.values()) {
        while (now - t.last >= t.ms) {
          t.last += t.ms;
          await t.cb();
        }
      }
    },
    count() {
      return timers.size;
    },
  };
}

// ------------------------------------------------------------- tiny DOM shim
function makeDom() {
  function makeEl(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      _listeners: {},
      className: '',
      id: '',
      textContent: '',
      hidden: false,
      dataset: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      removeAttribute(k) { delete this.attrs[k]; },
      append(...kids) { for (const kid of kids) this.children.push(kid); },
      replaceChildren(...kids) { this.children = kids; },
      addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); },
      removeEventListener() {},
      click() { for (const cb of this._listeners.click || []) cb({ type: 'click' }); },
      remove() {},
    };
  }
  return { createElement: (t) => makeEl(t), createTextNode: (t) => ({ text: String(t) }) };
}

function byId(root, id) {
  if (root && root.id === id) return root;
  for (const kid of (root && root.children) || []) {
    const found = byId(kid, id);
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------- (1) poll cadence

test('Task 5.10: the preview poll fires GET /preview at the 5s cadence and stops on close (Req 4.7)', async () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'cadence-1' });

  const calls = [];
  const fetchImpl = async (path) => {
    calls.push(path);
    return { status: 200, async json() { return { preview: { status: 'served', url: '/p/', snapshotId: 's', showingPrior: false, buildError: null } }; } };
  };
  const api = createApiClient({ getToken: () => 'tok', fetchImpl });
  const clock = fakeIntervalTimer();
  const poll = createPreviewPoll({
    store,
    api,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
  });

  assert.equal(POLL_INTERVAL_MS, 5_000, 'the cadence constant is 5s (Req 4.7)');

  poll.start('cadence-1');
  assert.equal(calls.length, 0, 'no poll before the first interval elapses');

  await clock.tick(4_999);
  assert.equal(calls.length, 0, 'no poll just before 5s');
  await clock.tick(1);
  assert.equal(calls.length, 1, 'exactly one poll at 5s');
  await clock.tick(10_000);
  assert.equal(calls.length, 3, 'three polls total after 15s (5s cadence)');
  for (const p of calls) assert.match(p, /^\/preview\?projectId=cadence-1$/, 'GET /preview carries the projectId');

  poll.stop();
  await clock.tick(20_000);
  assert.equal(calls.length, 3, 'no further polls after stop() (session close)');
});

// ------------------------------------------------------------- (2) same-origin iframe

test('Task 5.10: the Preview_Pane renders a SAME-ORIGIN iframe for a same-origin preview URL (Req 4.11)', () => {
  const store = createStore();
  const controller = createPreviewController({ store, api: { request: async () => ({ kind: 'ok' }) } });
  const doc = makeDom();
  const view = createPreviewPaneView({ doc, store, controller });

  // A same-origin, relative preview URL (what the backend serves).
  store.dispatch({ type: ACTIONS.PREVIEW_STATUS_SET, preview: { status: 'ready', url: '/preview/app/', source: 'sse' } });
  view.render();

  const frame = byId(view.el, PREVIEW_DOM.frame);
  assert.ok(frame, 'the preview iframe element exists');
  assert.equal(frame.tagName, 'IFRAME', 'preview is rendered in an <iframe>');
  assert.equal(frame.hidden, false, 'the iframe is shown for a ready+url state');
  const src = frame.getAttribute('src');
  assert.equal(src, '/preview/app/', 'the iframe src is the same-origin preview URL');
  // Same-origin: no external scheme/host in the iframe src.
  assert.ok(!/^[a-z]+:\/\//i.test(src), 'the iframe src is relative / same-origin (no external origin)');

  const vm = previewViewModel(store.getState());
  assert.equal(vm.showIframe, true);
});

test('Task 5.10: the served app document is NOT embeddable cross-origin (frame-ancestors none / XFO DENY) (Req 4.11)', async () => {
  const server = createBuilderServer({ authService: minimalAuth(), provider: createScriptedProvider([]) });
  const { port, host } = await server.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`http://${host}:${port}/`);
    assert.equal(res.status, 200, 'GET / serves the shell');
    assert.match(res.headers.get('content-type') || '', /text\/html/, 'GET / is HTML, not JSON');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors 'none'/, "CSP forbids the app being framed (frame-ancestors 'none')");
    assert.equal((res.headers.get('x-frame-options') || '').toUpperCase(), 'DENY', 'X-Frame-Options: DENY');
    // default-src 'self' is what allows a SAME-ORIGIN child iframe inside the app.
    assert.match(csp, /default-src 'self'/, "default-src 'self' permits a same-origin child iframe");
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------------- (3) QR is data: image, CSP-legal

test('Task 5.10: the mobile QR is an img-src \'self\' data:-legal data: image (Req 4.10)', async () => {
  // (a) The served CSP allows img-src 'self' data:.
  const server = createBuilderServer({ authService: minimalAuth(), provider: createScriptedProvider([]) });
  const { port, host } = await server.listen(0, '127.0.0.1');
  let csp;
  try {
    const res = await fetch(`http://${host}:${port}/`);
    csp = res.headers.get('content-security-policy') || '';
  } finally {
    await server.close();
  }
  assert.match(csp, /img-src 'self' data:/, "CSP permits data: images (img-src 'self' data:)");

  // (b) The Preview_Pane's QR src is a data: image URI (no external origin), so
  // it is legal under that CSP.
  const store = createStore();
  const controller = createPreviewController({ store, api: { request: async () => ({ kind: 'ok' }) } });
  const doc = makeDom();
  const view = createPreviewPaneView({ doc, store, controller });

  store.dispatch({ type: ACTIONS.PREVIEW_MOBILE_SET, url: 'exp://192.168.1.5:19000' });
  view.render();

  const mobile = byId(view.el, PREVIEW_DOM.mobile);
  assert.equal(mobile.hidden, false, 'the mobile block is shown when a connection URL is present');
  const urlEl = byId(view.el, PREVIEW_DOM.mobileUrl);
  assert.equal(urlEl.textContent, 'exp://192.168.1.5:19000', 'the connection URL is shown as selectable text');
  const qr = byId(view.el, PREVIEW_DOM.mobileQr);
  const src = qr.getAttribute('src');
  assert.ok(src.startsWith('data:image/'), 'the QR src is a data: image URI');
  assert.ok(!/^https?:\/\//i.test(src), 'the QR src references no external origin');
});

// ------------------------------------------------------------- test harness

/** A REAL AuthService with a denying IdP — GET / is served BEFORE auth gating
 * anyway, so no token is needed; this just satisfies the server's construction
 * contract exactly as the other builder-server tests do. */
function minimalAuth() {
  const denyingIdp = {
    async verifyIdToken() {
      throw new Error('denied');
    },
  };
  return createAuthService({ idpVerifier: denyingIdp });
}
