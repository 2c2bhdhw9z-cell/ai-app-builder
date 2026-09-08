/**
 * Property-based test for Web UI Task 5.7 (node --test).
 *
 * Property 13 — "The restart control appears exactly when offered and calls
 * restart" (design §"Property 13", Req 4.6). Exact spec tag:
 *
 *   "Feature: web-ui, Property 13: The restart control appears exactly when
 *    offered and calls restart"
 *
 * PROPERTY. For ANY preview_status frame, a restart control is present IFF the
 * frame reports `restartOffered` true, and activating a present control issues
 * POST /preview/restart for the session.
 *
 * REAL COLLABORATORS. The REAL store reducer, the REAL frame dispatcher, the
 * REAL preview controller (createPreviewController) whose `restart()` posts
 * through the REAL gated api client (createApiClient) driven by a scripted
 * fetch, and the REAL Preview_Pane view (createPreviewPaneView) built over a
 * tiny same-origin DOM shim (no jsdom / no dependency). Clicking the rendered
 * restart button must reach `POST /preview/restart` with the session projectId
 * and the Bearer header — end to end through the shipping code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, ACTIONS } from '../src/server/public/store.js';
import { createFrameDispatcher } from '../src/server/public/frames.js';
import { createApiClient } from '../src/server/public/api.js';
import { createPreviewController, previewViewModel } from '../src/server/public/preview.js';
import { createPreviewPaneView, PREVIEW_DOM } from '../src/server/public/views/preview-pane.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ------------------------------------------------------------- tiny DOM shim
// A minimal, same-origin element/document shim sufficient for the view: it
// records attributes, children, click listeners, and hidden state. Not a
// browser and not a dependency — just enough real DOM surface for the view.
function makeDom() {
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      _listeners: {},
      className: '',
      id: '',
      textContent: '',
      hidden: false,
      dataset: {},
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this.attrs ? this.attrs[k] : null;
      },
      hasAttribute(k) {
        return k in this.attrs;
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      append(...kids) {
        for (const kid of kids) this.children.push(kid);
      },
      replaceChildren(...kids) {
        this.children = kids;
      },
      addEventListener(type, cb) {
        (this._listeners[type] ||= []).push(cb);
      },
      removeEventListener(type, cb) {
        this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== cb);
      },
      click() {
        for (const cb of this._listeners.click || []) cb({ type: 'click' });
      },
      remove() {},
    };
    return el;
  }
  const doc = { createElement: (t) => makeEl(t), createTextNode: (t) => ({ text: String(t) }) };
  return doc;
}

/** Depth-first find of a shim element by its id. */
function byId(root, id) {
  if (root && root.id === id) return root;
  for (const kid of (root && root.children) || []) {
    const found = byId(kid, id);
    if (found) return found;
  }
  return null;
}

test(
  webUiTag(13, 'The restart control appears exactly when offered and calls restart'),
  () => {
    fc.assert(
      fc.property(
        fc.constantFrom('loading', 'ready', 'showing_prior', 'error', 'persistent_failure'),
        fc.boolean(),
        fc.webUrl(),
        (status, restartOffered, url) => {
          const store = createStore();
          const dispatcher = createFrameDispatcher({ store });
          store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-restart' });

          // A scripted fetch records every POST /preview/restart call.
          const calls = [];
          const fetchImpl = async (path, init) => {
            calls.push({ path, init });
            return { status: 200, async json() { return { restart: { ok: true } }; } };
          };
          const api = createApiClient({ getToken: () => 'tok-123', fetchImpl });
          const controller = createPreviewController({ store, api });

          const doc = makeDom();
          const view = createPreviewPaneView({ doc, store, controller });

          // Apply the frame under test.
          dispatcher.dispatch({ type: 'preview_status', status, url, restartOffered });

          const vm = previewViewModel(store.getState());
          const btn = byId(view.el, PREVIEW_DOM.restart);

          // Presence IFF offered.
          assert.equal(vm.showRestart, restartOffered, 'view-model presence tracks restartOffered');
          assert.equal(btn.hidden, !restartOffered, 'the restart control is shown iff offered');

          return true;
        },
      ),
      fcConfig,
    );
  },
);

// A separate async property drives the CLICK → POST /preview/restart end to end
// (the sync property above cannot await the posted request).
test(
  webUiTag(13, 'activating a present restart control issues POST /preview/restart with the Bearer'),
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim() !== ''),
        async (projectId) => {
          const store = createStore();
          const dispatcher = createFrameDispatcher({ store });
          store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId });

          const calls = [];
          const fetchImpl = async (path, init) => {
            calls.push({ path, init });
            return { status: 200, async json() { return { restart: { ok: true } }; } };
          };
          const api = createApiClient({ getToken: () => 'bearer-xyz', fetchImpl });
          const controller = createPreviewController({ store, api });

          const doc = makeDom();
          const view = createPreviewPaneView({ doc, store, controller });

          // Offer the restart, then click it.
          dispatcher.dispatch({ type: 'preview_status', status: 'error', restartOffered: true });
          const btn = byId(view.el, PREVIEW_DOM.restart);
          assert.equal(btn.hidden, false, 'restart offered → control present');

          // The click handler awaits controller.restart(); trigger it and let the
          // microtasks settle.
          btn.click();
          await new Promise((r) => setTimeout(r, 0));

          assert.equal(calls.length, 1, 'exactly one restart request issued');
          const { path, init } = calls[0];
          assert.match(path, /\/preview\/restart$/, 'POST /preview/restart is the target');
          assert.equal(init.method, 'POST');
          assert.equal(init.headers.authorization, 'Bearer bearer-xyz', 'the Bearer header is attached');
          const body = JSON.parse(init.body);
          assert.equal(body.projectId, projectId, 'the session projectId is carried');
          return true;
        },
      ),
      fcConfig,
    );
  },
);
