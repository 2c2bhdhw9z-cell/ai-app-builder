/**
 * Unit tests for Web UI Task 12.3 (node --test), Req 10.3, 10.5.
 *
 *   (10.5) NEW-SESSION VIBE DEFAULT: a newly opened Project_Session displays
 *          `vibe` as the active Work_Mode UNTIL a differing frame is received.
 *          Proven through the REAL store (SESSION_OPEN defaults workMode to
 *          'vibe') + the REAL Session_Header view-model + the REAL work-mode
 *          apply path (a differing frame moves it).
 *
 *   (10.3) MODE OPTION SET: the switch control offers exactly the three
 *          Work_Modes (vibe / spec / hybrid). Asserted on the controller's
 *          exposed option set AND on the rendered radio buttons of the REAL
 *          Session_Header view.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, ACTIONS } from '../src/server/public/store.js';
import {
  createWorkModeController,
  applyWorkModeFrame,
  WORK_MODE_OPTIONS,
} from '../src/server/public/work-mode.js';
import {
  createSessionHeaderView,
  sessionHeaderViewModel,
  SESSION_HEADER_DOM,
} from '../src/server/public/views/session-header.js';

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

function collect(root, pred, acc = []) {
  if (root && pred(root)) acc.push(root);
  for (const kid of (root && root.children) || []) collect(kid, pred, acc);
  return acc;
}

// ------------------------------------------------------------- (10.5) vibe default

test('Task 12.3: a new Project_Session displays vibe until a differing frame (Req 10.5)', () => {
  const store = createStore();
  // Fresh store defaults to vibe.
  assert.equal(sessionHeaderViewModel(store.getState()).active, 'vibe', 'fresh store shows vibe');

  // Opening a NEW session (re)defaults to vibe.
  store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-vibe' });
  assert.equal(store.getState().workMode.active, 'vibe', 'new session defaults work-mode to vibe');
  assert.equal(sessionHeaderViewModel(store.getState()).active, 'vibe', 'header displays vibe on new session');

  // A DIFFERING frame updates it (Req 10.5 "until a differing frame").
  applyWorkModeFrame(store, { type: 'work_mode', mode: 'hybrid', choices: ['vibe', 'spec', 'hybrid'] });
  assert.equal(sessionHeaderViewModel(store.getState()).active, 'hybrid', 'differing frame moves it off vibe');

  // Opening ANOTHER new session resets back to vibe (Req 10.5).
  store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-2' });
  assert.equal(sessionHeaderViewModel(store.getState()).active, 'vibe', 'a fresh session is vibe again');
});

// ------------------------------------------------------------- (10.3) mode option set

test('Task 12.3: the switch control offers exactly vibe / spec / hybrid (Req 10.3)', () => {
  assert.deepEqual([...WORK_MODE_OPTIONS], ['vibe', 'spec', 'hybrid'], 'the three modes, in order');

  // The rendered radio buttons of the REAL Session_Header view.
  const store = createStore();
  const controller = createWorkModeController({ store, api: { request: async () => ({ kind: 'ok' }) } });
  const doc = makeDom();
  const view = createSessionHeaderView({ doc, store, controller });

  const modeButtons = collect(view.el, (n) => n.getAttribute && n.getAttribute('role') === 'radio');
  const modes = modeButtons.map((b) => b.getAttribute('data-mode'));
  assert.deepEqual(modes, ['vibe', 'spec', 'hybrid'], 'the switch renders exactly the three modes');

  // The active one (vibe by default) is marked checked.
  const active = modeButtons.find((b) => b.getAttribute('aria-checked') === 'true');
  assert.ok(active, 'exactly one mode is active');
  assert.equal(active.getAttribute('data-mode'), 'vibe', 'vibe is the default active');
});
