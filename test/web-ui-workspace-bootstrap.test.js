/**
 * Unit tests for Web UI Task 10.4 (node --test), Req 8.1, 8.5.
 *
 * Two non-universal criteria:
 *
 *   (8.5) DEFAULT EXPERIENCE BOOTSTRAP: when the account has selected no
 *         Workspace_Experience, the client renders the default reported by
 *         GET /workspace-experience. Proven end-to-end through the REAL store +
 *         the REAL createApiClient over a scripted fetch + the REAL workspace
 *         controller: bootstrap() reads the default frame and applies it
 *         layout-only, so the store's workspace slice reflects the reported
 *         default experience + layout.
 *
 *   (8.1) EXPERIENCE OPTION SET: the control offers exactly the five
 *         Workspace_Experiences (kiro-style / vibe-first / technical-workbench /
 *         mobile-command-center / custom). Asserted on the controller's exposed
 *         option set AND on the rendered <select> options of the REAL controls
 *         view (built over a tiny same-origin DOM shim — no jsdom / no dep).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createWorkspaceController, WORKSPACE_EXPERIENCES } from '../src/server/public/workspace.js';
import { createThemeController } from '../src/server/public/theme.js';
import {
  createWorkspaceControlsView,
  WORKSPACE_CONTROLS_DOM,
} from '../src/server/public/views/workspace-controls.js';

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
      value: '',
      hidden: false,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      removeAttribute(k) { delete this.attrs[k]; },
      append(...kids) { for (const kid of kids) this.children.push(kid); },
      replaceChildren(...kids) { this.children = kids; },
      addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); },
      removeEventListener() {},
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

// ------------------------------------------------------------- (8.5) bootstrap

test('Task 10.4: the default Workspace_Experience is bootstrapped from GET /workspace-experience (Req 8.5)', async () => {
  const store = createStore();
  // GET /workspace-experience reports the default (kiro-style) for an account
  // that has selected none — mirrors the backend workspaceExperienceFrame shape.
  const defaultFrame = {
    type: 'workspace_experience',
    experience: 'kiro-style',
    layout: { id: 'kiro-style', name: 'Kiro-style Workspace', regions: ['header', 'main', 'panel'], surfaces: {} },
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, async json() { return defaultFrame; } };
  };
  const api = createApiClient({ getToken: () => 'tok', fetchImpl });
  const workspace = createWorkspaceController({ store, api });

  // Before bootstrap: no experience selected.
  assert.equal(store.getState().workspace.experience, null, 'no experience before bootstrap');

  const out = await workspace.bootstrap();

  assert.equal(out.ok, true);
  assert.equal(out.experience, 'kiro-style', 'reports the default experience');
  // A GET was issued to /workspace-experience carrying the Bearer.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(String(calls[0].url).endsWith('/workspace-experience'));
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  // The store's workspace slice reflects the reported default, layout-only.
  const ws = store.getState().workspace;
  assert.equal(ws.experience, 'kiro-style', 'default experience applied');
  assert.deepEqual(ws.layout, defaultFrame.layout, 'default layout applied');
});

test('Task 10.4: a denied/failed GET leaves the experience unselected (no crash)', async () => {
  const store = createStore();
  const fetchImpl = async () => ({ status: 401, async json() { return { error: 'access denied' }; } });
  const api = createApiClient({ getToken: () => 'tok', fetchImpl });
  const workspace = createWorkspaceController({ store, api });
  const out = await workspace.bootstrap();
  assert.equal(out.ok, false);
  assert.equal(store.getState().workspace.experience, null, 'stays unselected on a denied read');
});

// ------------------------------------------------------------- (8.1) option set

test('Task 10.4: the experience control offers exactly the five Workspace_Experiences (Req 8.1)', () => {
  // The controller's exposed option set.
  assert.deepEqual(
    [...WORKSPACE_EXPERIENCES],
    ['kiro-style', 'vibe-first', 'technical-workbench', 'mobile-command-center', 'custom'],
    'the five experiences, in order',
  );

  // The rendered <select> options of the REAL controls view.
  const store = createStore();
  const workspace = createWorkspaceController({ store, api: { request: async () => ({ kind: 'ok' }) } });
  const theme = createThemeController({ store, api: { request: async () => ({ kind: 'ok' }) }, styleTarget: { setProperty() {} } });
  const doc = makeDom();
  const view = createWorkspaceControlsView({ doc, store, workspace, theme });

  const select = byId(view.el, WORKSPACE_CONTROLS_DOM.experienceSelect);
  assert.ok(select, 'the experience <select> exists');
  const values = select.children.map((o) => o.value);
  assert.deepEqual(
    values,
    ['kiro-style', 'vibe-first', 'technical-workbench', 'mobile-command-center', 'custom'],
    'the <select> offers exactly the five experiences',
  );
});
