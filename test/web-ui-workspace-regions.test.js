/**
 * Unit/integration test for the Workspace_Experience REGION arrangement
 * (node --test) — platform Req 27.2, 27.3, 27.4, 27.8; web-ui Req 8.3, 8.4, 11.1,
 * 11.4.
 *
 * THE GAP THIS TEST CLOSES: views/layout.js used to sort every surface into just
 * a "main" column or a "preview panel", ignoring the layout descriptor's
 * `regions` entirely — so `kiro-style`, `vibe-first`, `technical-workbench` and
 * `custom` all rendered the SAME shell. Requirement 27.2 says a selection changes
 * the arrangement/visibility/sizing of the Activity_Stream, Preview, chat/compose
 * area, file and tool panels, and Session_Header; Requirement 27.8 says the
 * Technical Workbench is an IDE-style surface with the file/tool panels ALONGSIDE
 * the editor. That is only true if the descriptor's regions are honored.
 *
 * These tests drive the REAL layout view over the REAL FROZEN descriptors from
 * src/presentation/layouts.js through the REAL store, on a tiny same-origin DOM
 * shim (no jsdom, no dependency), and assert:
 *
 *   1. every surface lands in the region ITS DESCRIPTOR names, in `order`;
 *   2. the workbench specifically: filePanel→sidebar, preview→editor,
 *      compose+activityStream→dock (Req 27.8);
 *   3. kiro-style / vibe-first / technical-workbench / mobile are FOUR DIFFERENT
 *      arrangements (the regression that let them all look the same);
 *   4. the workbench renders its honest, non-affiliated attribution credit;
 *   5. vibe-first hides the filePanel (visible:false) and marks compose primary;
 *   6. a collapsed collapsible surface renders collapsed but stays expandable;
 *   7. switching experiences MOVES the same surface element instances and
 *      mutates nothing outside the workspace slice (Req 27.3 / Property 24);
 *   8. mobile-command-center is one column with the Work_Mode still visible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, ACTIONS } from '../src/server/public/store.js';
import { createWorkModeController } from '../src/server/public/work-mode.js';
import {
  createLayoutView,
  layoutViewModel,
  LAYOUT_DOM,
} from '../src/server/public/views/layout.js';
import { createSessionHeaderView } from '../src/server/public/views/session-header.js';
import {
  workspaceExperienceLayouts,
  WORKBENCH_ATTRIBUTION,
} from '../src/presentation/layouts.js';

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
      append(...kids) {
        for (const kid of kids) {
          // Mirror the DOM: appending an attached node MOVES it.
          if (kid && kid._parent && Array.isArray(kid._parent.children)) {
            const i = kid._parent.children.indexOf(kid);
            if (i >= 0) kid._parent.children.splice(i, 1);
          }
          this.children.push(kid);
          if (kid) kid._parent = this;
        }
      },
      replaceChildren(...kids) {
        for (const old of this.children) if (old) old._parent = null;
        this.children = kids;
        for (const k of kids) if (k) k._parent = this;
      },
      addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); },
      removeEventListener() {},
      remove() {},
      click() { for (const cb of this._listeners.click || []) cb({ type: 'click' }); },
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
/** The nearest ancestor region container of a node (its rendered region). */
function regionOf(node) {
  let cur = node && node._parent;
  while (cur) {
    if (cur.getAttribute && cur.getAttribute('data-region')) return cur.getAttribute('data-region');
    cur = cur._parent;
  }
  return null;
}
/** surface name -> { region, hidden, collapsed, emphasis, size, index } as RENDERED. */
function rendered(root) {
  const out = {};
  for (const wrapper of collect(root, (n) => n.getAttribute && n.getAttribute('data-surface'))) {
    const name = wrapper.getAttribute('data-surface');
    const region = regionOf(wrapper);
    const siblings = (wrapper._parent && wrapper._parent.children) || [];
    out[name] = {
      region,
      index: siblings.indexOf(wrapper),
      hidden: wrapper.hidden === true,
      collapsed: wrapper.getAttribute('data-collapsed') === 'true',
      collapsible: wrapper.getAttribute('data-collapsible') === 'true',
      emphasis: wrapper.getAttribute('data-emphasis'),
      size: wrapper.getAttribute('data-size'),
    };
  }
  return out;
}
/** A comparable signature of a rendered arrangement (region + order per surface). */
function signature(root) {
  const r = rendered(root);
  return Object.keys(r)
    .sort()
    .map((name) => `${name}@${r[name].region}#${r[name].index}${r[name].hidden ? '(hidden)' : ''}`)
    .join('|');
}

/** Build the shell with all five surfaces mounted (as app.js does). */
function mountShell(experience) {
  const doc = makeDom();
  const store = createStore();
  const wmController = createWorkModeController({ store, api: { request: async () => ({ kind: 'ok' }) } });
  const sessionHeader = createSessionHeaderView({ doc, store, controller: wmController });
  const surfaces = {
    sessionHeader,
    activityStream: { el: doc.createElement('section') },
    compose: { el: doc.createElement('div') },
    preview: { el: doc.createElement('section') },
    filePanel: { el: doc.createElement('section') },
  };
  const layout = createLayoutView({ doc, store, surfaces });
  if (experience) apply(store, experience);
  return { doc, store, layout, surfaces };
}

/** Apply the REAL backend descriptor for an experience (layout only). */
function apply(store, experience, extra = {}) {
  const descriptor = workspaceExperienceLayouts[experience];
  store.dispatch({
    type: ACTIONS.WORKSPACE_EXPERIENCE_SET,
    experience,
    layout: descriptor,
    ...extra,
  });
}

const EXPERIENCES = Object.keys(workspaceExperienceLayouts);

// ---------------------------------------------- (1) descriptor regions honored

test('each Workspace_Experience places every surface in the REGION its descriptor names (Req 27.2)', () => {
  for (const experience of EXPERIENCES) {
    const descriptor = workspaceExperienceLayouts[experience];
    const { layout } = mountShell(experience);
    const placed = rendered(layout.el);

    // The Session_Header is PINNED to the top bar whenever the descriptor puts it
    // in the first region (Req 11.4) — for the mobile stack that means the bar
    // rather than the stack's flow. Every OTHER surface goes to its named region.
    const pinned =
      !descriptor.regions.includes('header') &&
      descriptor.surfaces.sessionHeader &&
      descriptor.surfaces.sessionHeader.region === descriptor.regions[0]
        ? 'sessionHeader'
        : null;
    // When pinned, the surface renders in the shell's own top-bar slot.
    const pinnedRegion = 'header';

    for (const [name, def] of Object.entries(descriptor.surfaces)) {
      assert.ok(placed[name], `${experience}: surface ${name} is rendered`);
      assert.equal(
        placed[name].region,
        name === pinned ? pinnedRegion : def.region,
        `${experience}: ${name} is rendered in region "${name === pinned ? 'the pinned top bar' : def.region}"`,
      );
      assert.equal(
        placed[name].hidden,
        def.visible === false,
        `${experience}: ${name} visibility follows the descriptor`,
      );
      assert.equal(
        placed[name].collapsed,
        def.collapsible === true && def.collapsed === true,
        `${experience}: ${name} collapse state follows the descriptor`,
      );
      assert.equal(
        placed[name].size,
        def.size === 'flex' ? 'flex' : 'auto',
        `${experience}: ${name} sizing follows the descriptor`,
      );
    }

    // Within each region the DOM order follows the descriptor's `order`.
    const byRegion = new Map();
    for (const [name, def] of Object.entries(descriptor.surfaces)) {
      if (name === pinned) continue;
      if (!byRegion.has(def.region)) byRegion.set(def.region, []);
      byRegion.get(def.region).push({ name, order: def.order });
    }
    for (const [region, list] of byRegion) {
      const expected = list.slice().sort((a, b) => a.order - b.order).map((s) => s.name);
      const actual = list
        .slice()
        .sort((a, b) => placed[a.name].index - placed[b.name].index)
        .map((s) => s.name);
      assert.deepEqual(actual, expected, `${experience}: region "${region}" is ordered by \`order\``);
    }

    // The shell exposes the descriptor's regions for the CSS geometry.
    assert.equal(
      layout.el.getAttribute('data-regions'),
      descriptor.regions.join(' '),
      `${experience}: data-regions mirrors the descriptor`,
    );
    assert.equal(layout.el.getAttribute('data-experience'), experience);
  }
});

// ------------------------------------- (2) the Technical Workbench IDE geometry

test('technical-workbench is an IDE surface: filePanel→sidebar, preview→editor, compose+activityStream→dock (Req 27.8)', () => {
  const { layout } = mountShell('technical-workbench');
  const placed = rendered(layout.el);

  assert.equal(placed.sessionHeader.region, 'header', 'the Session_Header is the pinned top bar');
  assert.equal(placed.filePanel.region, 'sidebar', 'the file/tool panel is the left sidebar');
  assert.equal(placed.preview.region, 'editor', 'the preview is the central editor area');
  assert.equal(placed.compose.region, 'dock', 'the chat/compose area is in the bottom dock');
  assert.equal(placed.activityStream.region, 'dock', 'the Activity_Stream is in the bottom dock');
  assert.ok(placed.compose.index < placed.activityStream.index, 'compose sits above activity in the dock');

  // The four IDE regions are real, distinct containers in the DOM.
  const regions = collect(layout.el, (n) => n.getAttribute && n.getAttribute('data-region'))
    .filter((n) => n.hidden !== true)
    .map((n) => n.getAttribute('data-region'));
  assert.deepEqual(regions, ['header', 'sidebar', 'editor', 'dock'], 'four IDE regions render');

  // Nothing about the workbench is chat-shell flattened: the file panel is NOT
  // in the same region as the compose box (that is the whole point of 27.8).
  assert.notEqual(placed.filePanel.region, placed.compose.region);
});

// ------------------------------------------- (3) the five are DIFFERENT layouts

test('kiro-style, vibe-first, technical-workbench, mobile and custom are DIFFERENT arrangements (Req 27.1/27.2 regression)', () => {
  const signatures = new Map();
  for (const experience of EXPERIENCES) {
    const { layout } = mountShell(experience);
    signatures.set(experience, signature(layout.el));
  }

  // The three the old flattened shell rendered identically must now differ.
  const distinct = ['kiro-style', 'vibe-first', 'technical-workbench', 'mobile-command-center'];
  for (const a of distinct) {
    for (const b of distinct) {
      if (a === b) continue;
      assert.notEqual(
        signatures.get(a),
        signatures.get(b),
        `${a} and ${b} must be different arrangements`,
      );
    }
  }

  // `custom` starts from the documented kiro-style arrangement but with the file
  // panel in the RIGHT region, so it is its own arrangement too (Req 27.4).
  assert.notEqual(
    signatures.get('custom'),
    signatures.get('kiro-style'),
    'custom starts from kiro-style but places the file panel in the right region',
  );

  // The pure view-model tells the same story (DOM-free).
  const vmRegions = (experience) => {
    const state = { workspace: { experience, layout: workspaceExperienceLayouts[experience], attribution: null } };
    return layoutViewModel(state).regions.map((r) => `${r.name}:${r.surfaces.map((s) => s.name).join(',')}`).join('|');
  };
  const seen = new Set(EXPERIENCES.map(vmRegions));
  assert.equal(seen.size, EXPERIENCES.length, 'all five experiences produce distinct region maps');
});

test('an arbitrary persisted `custom` layout with its own region names just works (Req 27.4)', () => {
  const { store, layout } = mountShell(null);
  // A user-arranged layout the backend persisted: three columns of the user's
  // own naming. No code here knows these names.
  store.dispatch({
    type: ACTIONS.WORKSPACE_EXPERIENCE_SET,
    experience: 'custom',
    layout: {
      id: 'custom',
      name: 'Custom Workspace',
      regions: ['topbar', 'files', 'work', 'tools'],
      surfaces: {
        sessionHeader: { region: 'topbar', visible: true, order: 0 },
        filePanel: { region: 'files', visible: true, order: 0, size: 'flex' },
        preview: { region: 'work', visible: true, order: 0, size: 'flex' },
        compose: { region: 'work', visible: true, order: 1, size: 'auto' },
        activityStream: { region: 'tools', visible: true, order: 0, size: 'flex' },
      },
    },
  });

  const placed = rendered(layout.el);
  assert.equal(placed.filePanel.region, 'files');
  assert.equal(placed.preview.region, 'work');
  assert.equal(placed.compose.region, 'work');
  assert.equal(placed.activityStream.region, 'tools');
  // The user's first region holds only the Session_Header, so that whole region
  // IS the pinned top bar (whatever they named it).
  assert.equal(placed.sessionHeader.region, 'topbar', 'the first region is the pinned top bar');
  assert.equal(
    byId(layout.el, LAYOUT_DOM.header).getAttribute('data-region'),
    'topbar',
    'the top bar renders the user-named header region',
  );
  assert.equal(layout.el.getAttribute('data-regions'), 'topbar files work tools');
});

// ------------------------------------------------ (4) the attribution credit

test('technical-workbench renders the honest, non-affiliated attribution credit (Req 27.8 / 8.4)', () => {
  // From the DESCRIPTOR alone (no frame attribution) — the credit is part of the
  // workbench surface, so it must show whenever that experience is active.
  const fromDescriptor = mountShell('technical-workbench');
  const credit = byId(fromDescriptor.layout.el, LAYOUT_DOM.attribution);
  assert.equal(credit.hidden, false, 'the credit is shown in the workbench');
  assert.equal(credit.textContent, WORKBENCH_ATTRIBUTION);
  assert.equal(credit.textContent, 'Inspired by tools like Kiro');

  // And from the frame's attribution field (what the backend sends).
  const fromFrame = mountShell(null);
  apply(fromFrame.store, 'technical-workbench', { attribution: WORKBENCH_ATTRIBUTION });
  assert.equal(byId(fromFrame.layout.el, LAYOUT_DOM.attribution).textContent, WORKBENCH_ATTRIBUTION);

  // No other experience shows a credit.
  for (const experience of ['kiro-style', 'vibe-first', 'mobile-command-center', 'custom']) {
    const { layout } = mountShell(experience);
    assert.equal(
      byId(layout.el, LAYOUT_DOM.attribution).hidden,
      true,
      `${experience} shows no attribution credit`,
    );
  }
});

// ------------------------------- (5) vibe-first: hidden filePanel + emphasis

test('vibe-first hides the filePanel (visible:false) and foregrounds compose (emphasis:primary) (Req 27.2)', () => {
  const { layout } = mountShell('vibe-first');
  const placed = rendered(layout.el);

  assert.equal(placed.filePanel.hidden, true, 'the file panel is hidden, not rendered as content');
  assert.equal(placed.filePanel.region, 'aside', 'it stays mounted in its named region');
  assert.equal(placed.compose.emphasis, 'primary', 'the compose surface is marked primary for CSS');
  assert.equal(placed.compose.region, 'main');
  assert.ok(
    placed.compose.index < placed.activityStream.index,
    'the compose box leads the conversation column',
  );
  assert.equal(placed.preview.region, 'aside', 'the preview is tucked into the aside');
  assert.equal(placed.preview.collapsed, true, 'and starts collapsed');

  // No other experience marks a surface primary.
  const kiro = rendered(mountShell('kiro-style').layout.el);
  assert.equal(kiro.compose.emphasis, null, 'kiro-style does not foreground compose');
});

// --------------------------------- (6) collapsed surfaces stay reachable

test('a collapsed collapsible surface renders collapsed but is expandable by the user', () => {
  const { layout, surfaces } = mountShell('kiro-style');
  const wrapper = collect(
    layout.el,
    (n) => n.getAttribute && n.getAttribute('data-surface') === 'filePanel',
  )[0];

  assert.equal(wrapper.getAttribute('data-collapsible'), 'true');
  assert.equal(wrapper.getAttribute('data-collapsed'), 'true', 'starts collapsed per the descriptor');
  assert.equal(surfaces.filePanel.el.hidden, true, 'the collapsed surface body is not rendered');

  const toggle = collect(layout.el, (n) => n.getAttribute && n.getAttribute('data-toggle') === 'filePanel')[0];
  assert.ok(toggle, 'a collapsed surface still offers a toggle (it stays reachable)');
  assert.equal(toggle.hidden, false, 'the toggle itself is visible while collapsed');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  toggle.click();

  assert.equal(wrapper.getAttribute('data-collapsed'), 'false', 'the user expanded it');
  assert.equal(surfaces.filePanel.el.hidden, false, 'the surface body is now rendered');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  toggle.click();
  assert.equal(wrapper.getAttribute('data-collapsed'), 'true', 'and can collapse it again');
});

// ------------- (7) switching MOVES the same elements and touches nothing else

test('switching experiences MOVES the same surface elements and mutates nothing outside the workspace slice (Req 27.3)', () => {
  const { store, layout, surfaces } = mountShell('kiro-style');

  // Seed non-default sibling slices so any accidental mutation is visible.
  store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-layout' });
  store.dispatch({
    type: ACTIONS.THEME_COMMITTED,
    themeId: 'dark',
    palette: { background: '#0b0f19' },
  });
  store.dispatch({ type: ACTIONS.WORK_MODE_SET, active: 'spec', choices: ['vibe', 'spec', 'hybrid'] });
  store.dispatch({ type: ACTIONS.PREVIEW_STATUS_SET, preview: { status: 'ready', url: '/live/', source: 'sse' } });

  const identities = Object.fromEntries(Object.entries(surfaces).map(([k, v]) => [k, v.el]));
  const before = store.getState();

  apply(store, 'technical-workbench');

  // Same element instances, new regions — MOVED, not rebuilt.
  const placed = rendered(layout.el);
  for (const [name, el] of Object.entries(identities)) {
    assert.strictEqual(surfaces[name].el, el, `${name} element instance is preserved`);
    // The element is still inside the shell (its wrapper was moved with it).
    assert.ok(placed[name], `${name} is still rendered`);
  }
  assert.equal(placed.filePanel.region, 'sidebar', 'the file panel moved to the workbench sidebar');
  assert.equal(placed.preview.region, 'editor', 'the preview moved to the editor region');

  // Nothing but the workspace slice changed (Property 24's invariant, at the view).
  const after = store.getState();
  assert.notStrictEqual(after.workspace, before.workspace, 'the workspace slice changed');
  assert.strictEqual(after.theme, before.theme, 'theme slice UNCHANGED');
  assert.strictEqual(after.workMode, before.workMode, 'work-mode slice UNCHANGED');
  assert.strictEqual(after.preview, before.preview, 'preview slice UNCHANGED');
  assert.strictEqual(after.session, before.session, 'session slice UNCHANGED');

  // Switch back: same instances again, original regions restored.
  apply(store, 'kiro-style');
  const back = rendered(layout.el);
  assert.equal(back.filePanel.region, 'left');
  assert.equal(back.preview.region, 'right');
  for (const [name, el] of Object.entries(identities)) {
    assert.strictEqual(surfaces[name].el, el, `${name} element instance survived the round trip`);
  }

  // A user-operated collapse is LOCAL view state: it dispatches nothing.
  const stateBeforeToggle = store.getState();
  collect(layout.el, (n) => n.getAttribute && n.getAttribute('data-toggle') === 'filePanel')[0].click();
  assert.strictEqual(store.getState(), stateBeforeToggle, 'collapsing dispatches nothing at all');
});

// ------------------------------------------- (8) mobile: one touch column

test('mobile-command-center is ONE column at 360px with the Work_Mode still visible (Req 11.1, 11.4)', () => {
  const { layout } = mountShell('mobile-command-center');

  assert.equal(layout.el.getAttribute('data-single-column'), 'true');
  assert.equal(layout.el.getAttribute('data-orientation'), 'vertical');

  // Exactly ONE body region renders, and every surface is in it.
  const bodyRegions = collect(layout.el, (n) => n.getAttribute && n.getAttribute('data-region'))
    .filter((n) => n.hidden !== true && n.getAttribute('data-role') !== 'header');
  assert.equal(bodyRegions.length, 1, 'a single stacked body region');
  assert.equal(bodyRegions[0].getAttribute('data-region'), 'stack');

  const placed = rendered(layout.el);
  for (const name of ['activityStream', 'compose', 'preview', 'filePanel']) {
    assert.equal(placed[name].region, 'stack', `${name} stacks in the one column`);
  }
  // The secondary side-panel slot is not used at all.
  assert.equal(byId(layout.el, LAYOUT_DOM.panel).hidden, true, 'no side panel in the mobile column');

  // The Session_Header (with the Work_Mode switch) is pinned to the top bar, not
  // buried in the scrolling stack, and is never hidden (Req 11.4).
  const headerBar = byId(layout.el, LAYOUT_DOM.header);
  assert.equal(headerBar.hidden, false, 'the top bar is never hidden');
  assert.equal(headerBar.getAttribute('data-role'), 'header');
  assert.equal(placed.sessionHeader.hidden, false);
  assert.ok(
    collect(headerBar, (n) => n.getAttribute && n.getAttribute('data-surface') === 'sessionHeader').length === 1,
    'the Session_Header is pinned in the top bar',
  );
  const modeButtons = collect(layout.el, (n) => n.getAttribute && n.getAttribute('role') === 'radio');
  assert.equal(modeButtons.length, 3, 'the Work_Mode switch is still rendered');
  assert.equal(
    modeButtons.filter((b) => b.getAttribute('aria-checked') === 'true').length,
    1,
    'the active Work_Mode is observable (Req 11.4)',
  );
});
