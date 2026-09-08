/**
 * Integration test for Web UI Task 12.4 (node --test), Req 11.1–11.4.
 *
 * The Mobile Command Center at a 360px phone width. These are structural /
 * layout-contract checks (a DOM shim cannot evaluate CSS media queries, so the
 * genuinely-visual bits are exercised via the layout-arrangement contract the
 * CSS keys off of):
 *
 *   (11.1) SINGLE-COLUMN TOUCH LAYOUT: applying the real backend
 *          `mobile-command-center` workspace_experience frame drives the REAL
 *          layout view to a SINGLE column — every visible surface (session
 *          header, activity stream, compose, preview) flows in one column and
 *          the secondary preview panel is folded in (hidden as a side panel).
 *          The layout view marks data-single-column="true", which is the exact
 *          hook styles.css uses to collapse the grid to one column.
 *
 *   (11.2) NO HORIZONTAL OVERFLOW OF THE PRIMARY COLUMN: the shell + main column
 *          are declared width:100%, box-sizing:border-box, min-width:0 in
 *          styles.css so the primary column cannot overflow horizontally at
 *          360px. Asserted structurally over the served stylesheet.
 *
 *   (11.4) WORK_MODE STAYS VISIBLE: the Session_Header (with its Work_Mode
 *          switch) is pinned in the shell header region and is NEVER hidden by
 *          the single-column collapse — the mode radios are present and one is
 *          active even in the mobile-command-center layout at 360px.
 *
 * Uses the REAL store, the REAL layout + session-header views over a tiny
 * same-origin DOM shim (no jsdom / no dependency), the REAL backend layout
 * descriptor (src/presentation/layouts.js), and the REAL served stylesheet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createStore, ACTIONS } from '../src/server/public/store.js';
import { createWorkModeController } from '../src/server/public/work-mode.js';
import { createLayoutView, layoutViewModel, LAYOUT_DOM } from '../src/server/public/views/layout.js';
import { createSessionHeaderView } from '../src/server/public/views/session-header.js';
import { workspaceExperienceLayouts } from '../src/presentation/layouts.js';

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
      append(...kids) { for (const kid of kids) { this.children.push(kid); kid._parent = this; } },
      replaceChildren(...kids) { this.children = kids; for (const k of kids) k._parent = this; },
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
function collect(root, pred, acc = []) {
  if (root && pred(root)) acc.push(root);
  for (const kid of (root && root.children) || []) collect(kid, pred, acc);
  return acc;
}

const MOBILE_FRAME = {
  type: 'workspace_experience',
  experience: 'mobile-command-center',
  layout: workspaceExperienceLayouts['mobile-command-center'],
};

// ------------------------------------------------------------- (11.1) single-column

test('Task 12.4: the mobile-command-center layout is a single column with the panel folded in (Req 11.1)', () => {
  const store = createStore();

  // Build the real surfaces (minimal stand-in els for the non-header surfaces).
  const doc = makeDom();
  const wmController = createWorkModeController({ store, api: { request: async () => ({ kind: 'ok' }) } });
  const sessionHeader = createSessionHeaderView({ doc, store, controller: wmController });
  const activity = { el: doc.createElement('section') };
  const compose = { el: doc.createElement('div') };
  const preview = { el: doc.createElement('section') };

  const layout = createLayoutView({
    doc,
    store,
    surfaces: { sessionHeader, activityStream: activity, compose, preview },
  });

  // Apply the real mobile-command-center frame (layout only).
  store.dispatch({
    type: ACTIONS.WORKSPACE_EXPERIENCE_SET,
    experience: MOBILE_FRAME.experience,
    layout: MOBILE_FRAME.layout,
  });

  // Pure arrangement decision: single column, panel empty, all in main.
  const vm = layoutViewModel(store.getState());
  assert.equal(vm.singleColumn, true, 'mobile-command-center is single-column (Req 11.1)');
  assert.equal(vm.orientation, 'vertical', 'the descriptor is a vertical stack');
  assert.deepEqual(vm.panel, [], 'no surface is left in a side panel (folded into main)');
  // The main column carries activityStream, compose, and preview (in order).
  assert.ok(vm.main.includes('activityStream'), 'activity in main column');
  assert.ok(vm.main.includes('compose'), 'compose in main column');
  assert.ok(vm.main.includes('preview'), 'preview folded into the main column');

  // The rendered shell marks single-column and hides the side panel.
  const root = layout.el;
  assert.equal(root.getAttribute('data-single-column'), 'true', 'shell marked single-column for CSS collapse');
  assert.equal(root.getAttribute('data-experience'), 'mobile-command-center');
  const panelEl = byId(root, LAYOUT_DOM.panel);
  assert.equal(panelEl.hidden, true, 'the secondary panel is hidden (single column)');
});

// ------------------------------------------------------------- (11.4) Work_Mode visible

test('Task 12.4: the Work_Mode switch stays visible in the header at 360px (Req 11.4)', () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-mobile' });

  const doc = makeDom();
  const wmController = createWorkModeController({ store, api: { request: async () => ({ kind: 'ok' }) } });
  const sessionHeader = createSessionHeaderView({ doc, store, controller: wmController });
  const layout = createLayoutView({
    doc,
    store,
    surfaces: {
      sessionHeader,
      activityStream: { el: doc.createElement('section') },
      compose: { el: doc.createElement('div') },
      preview: { el: doc.createElement('section') },
    },
  });

  // Collapse to mobile-command-center.
  store.dispatch({
    type: ACTIONS.WORKSPACE_EXPERIENCE_SET,
    experience: MOBILE_FRAME.experience,
    layout: MOBILE_FRAME.layout,
  });

  // The header is in the shell header region, and its mode switch is present +
  // never hidden by the collapse (Req 11.4).
  const headerRegion = byId(layout.el, LAYOUT_DOM.header);
  assert.ok(headerRegion, 'the shell header region exists');
  assert.equal(headerRegion.hidden, false, 'the header region is not hidden');

  const modeButtons = collect(layout.el, (n) => n.getAttribute && n.getAttribute('role') === 'radio');
  assert.equal(modeButtons.length, 3, 'the three Work_Mode buttons are present in the header');
  const active = modeButtons.filter((b) => b.getAttribute('aria-checked') === 'true');
  assert.equal(active.length, 1, 'exactly one active Work_Mode is visible');
  assert.equal(active[0].getAttribute('data-mode'), 'vibe', 'the active Work_Mode (vibe default) stays visible');
});

// ------------------------------------------------------------- (11.2) no overflow (structural)

test('Task 12.4: the shell + primary column cannot overflow horizontally at 360px (Req 11.2)', async () => {
  // Read the REAL served stylesheet and assert the primary column is declared
  // full-width, border-box, min-width:0 — the invariants that guarantee no
  // horizontal overflow of the primary content column at a 360px viewport.
  const cssPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'server',
    'public',
    'styles.css',
  );
  const css = await readFile(cssPath, 'utf8');

  // Global border-box reset.
  assert.match(css, /\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box;/, 'border-box reset present');
  // The main column can shrink below content width (min-width:0) so a wide child
  // does not force horizontal scroll.
  assert.match(css, /\.shell__main\s*\{[^}]*min-width:\s*0/s, 'main column min-width:0 (no overflow)');
  assert.match(css, /\.shell__main\s*\{[^}]*width:\s*100%/s, 'main column width:100%');
  // A single-column collapse rule keys off data-single-column="true".
  assert.match(css, /\.shell\[data-single-column="true"\]\s*\.shell__body/, 'single-column collapse rule present');
  // A phone-width media query collapses the same shell to one column.
  assert.match(css, /@media\s*\(max-width:\s*720px\)/, 'phone-width media query collapses to one column');

  // Palette-driven: no hard-coded hex in the shell rules (the only allowed hex
  // is the QR scaffold #ffffff, which is not a shell rule).
  const shellBlock = css.slice(css.indexOf('.shell {'));
  const hexInShell = shellBlock.match(/#[0-9a-fA-F]{3,6}/g) || [];
  // Any hex present must be the QR white scaffold only.
  for (const h of hexInShell) {
    assert.equal(h.toLowerCase(), '#ffffff', 'the only hard-coded hex below .shell is the QR white scaffold');
  }
});
