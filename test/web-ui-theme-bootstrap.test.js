/**
 * Unit tests for Web UI Task 11.5 (node --test), Req 9.2, 9.8.
 *
 *   (9.8) DEFAULT THEME BOOTSTRAP: when the account has committed no Theme for
 *         the current Workspace_Experience, the client calls GET /theme and
 *         applies the reported default palette AS THE LAST COMMITTED theme.
 *         Proven through the REAL store + createApiClient over a scripted fetch +
 *         the REAL theme controller + a recording style target: bootstrap()
 *         records the reported theme as committed and applies its palette to the
 *         surface.
 *
 *   (9.2) THEME OPTION SET: the catalog control offers exactly the eight catalog
 *         Themes. Asserted on the controller's exposed option set AND on the
 *         rendered <select> options of the REAL controls view.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, ACTIONS, PALETTE_KEYS } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createThemeController, cssVarName, THEMES } from '../src/server/public/theme.js';
import { createWorkspaceController } from '../src/server/public/workspace.js';
import {
  createWorkspaceControlsView,
  WORKSPACE_CONTROLS_DOM,
} from '../src/server/public/views/workspace-controls.js';
import { THEME_CATALOG } from '../src/model/enums.js';

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

function recordingTarget() {
  const props = new Map();
  return { setProperty(n, v) { props.set(n, v); }, get(n) { return props.get(n); } };
}

// ------------------------------------------------------------- (9.8) bootstrap

test('Task 11.5: the default Theme is bootstrapped from GET /theme and recorded as committed (Req 9.8)', async () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.WORKSPACE_EXPERIENCE_SET, experience: 'technical-workbench', layout: {} });

  // technical-workbench defaults to the neutral 'dark' theme (enums.js
  // DEFAULT_THEME_BY_EXPERIENCE); GET /theme reports that committed frame.
  const defaultThemeId = 'dark';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 200,
      async json() {
        return {
          type: 'theme',
          theme: defaultThemeId,
          palette: THEME_CATALOG[defaultThemeId].palette,
          previewed: false,
          workspaceExperience: 'technical-workbench',
        };
      },
    };
  };
  const api = createApiClient({ getToken: () => 'tok', fetchImpl });
  const target = recordingTarget();
  const theme = createThemeController({ store, api, styleTarget: target, getExperience: () => 'technical-workbench' });

  assert.equal(store.getState().theme.committedTheme, null, 'no committed theme before bootstrap');

  const out = await theme.bootstrap();

  assert.equal(out.ok, true);
  assert.equal(out.theme, defaultThemeId, 'reports the default theme');
  // A GET /theme was issued carrying the experience + Bearer.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.match(String(calls[0].url), /\/theme\?workspaceExperience=technical-workbench$/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  // Recorded AS COMMITTED (Req 9.8) and applied to the surface.
  assert.equal(store.getState().theme.committedTheme, defaultThemeId, 'default recorded as committed');
  for (const key of PALETTE_KEYS) {
    assert.equal(target.get(cssVarName(key)), THEME_CATALOG[defaultThemeId].palette[key], `surface --color-${key} applied`);
  }
});

// ------------------------------------------------------------- (9.2) option set

test('Task 11.5: the theme control offers exactly the eight catalog Themes (Req 9.2)', () => {
  assert.deepEqual(
    [...THEMES],
    ['light', 'dark', 'pastel-pasture', 'out-there', 'paranormal-purple', 'morning-dew', 'summer-sunset', 'peach-popsicle'],
    'the eight catalog themes, in order',
  );
  assert.equal(THEMES.length, 8, 'exactly eight themes');
  // Every offered theme is a real catalog entry.
  for (const t of THEMES) assert.ok(THEME_CATALOG[t], `${t} is a real catalog theme`);

  // The rendered <select> options of the REAL controls view.
  const store = createStore();
  const workspace = createWorkspaceController({ store, api: { request: async () => ({ kind: 'ok' }) } });
  const theme = createThemeController({ store, api: { request: async () => ({ kind: 'ok' }) }, styleTarget: { setProperty() {} } });
  const doc = makeDom();
  const view = createWorkspaceControlsView({ doc, store, workspace, theme });

  const select = byId(view.el, WORKSPACE_CONTROLS_DOM.themeSelect);
  assert.ok(select, 'the theme <select> exists');
  const values = select.children.map((o) => o.value);
  assert.deepEqual(values, [...THEMES], 'the <select> offers exactly the eight themes');
});
