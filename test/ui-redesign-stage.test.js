/**
 * ui-redesign — THE STAGE contract.
 *
 * REPLACES three tests that encoded the deleted architecture:
 *   web-ui-layout-geometry.test.js          (five region grid geometries)
 *   web-ui-workspace-regions.test.js        (surface -> descriptor region sorting)
 *   web-ui-mobile-command-center.integration.test.js (region/panel folding)
 *
 * Those tests were correct about the old shell and are meaningless against the
 * new one: there are no longer named regions to sort surfaces into, and no
 * per-experience grid to be distinct. They are deleted deliberately, not skipped,
 * and the invariants worth keeping are re-asserted here against the new shape:
 * no horizontal overflow at 360px, touch-sized controls, palette-driven colour,
 * no hard-coded hex, CSP cleanliness, and the Work Mode staying reachable.
 *
 * What is NEW and asserted here: the app owns the canvas, the agent lives in a
 * sheet with three detents, and surfaces are placed by IDENTITY rather than by
 * backend descriptor region.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createStageView,
  stageViewModel,
  STAGE_DOM,
  DETENTS,
  SLOT_OF_SURFACE,
  OPENING_DETENT,
} from '../src/server/public/views/stage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'src', 'server', 'public');
const css = await readFile(path.join(PUBLIC, 'styles.css'), 'utf8');
const stageSrc = await readFile(path.join(PUBLIC, 'views', 'stage.js'), 'utf8');

/* ------------------------------------------------------------- DOM shim ---- */
function makeDom() {
  function makeEl(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      _listeners: {},
      className: '',
      id: '',
      type: '',
      textContent: '',
      hidden: false,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(kid) { this.append(kid); return kid; },
      append(...kids) {
        for (const kid of kids) {
          if (kid && kid._parent && Array.isArray(kid._parent.children)) {
            const i = kid._parent.children.indexOf(kid);
            if (i >= 0) kid._parent.children.splice(i, 1);
          }
          this.children.push(kid);
          if (kid) kid._parent = this;
        }
      },
      addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); },
      removeEventListener() {},
      remove() {
        if (this._parent) {
          const i = this._parent.children.indexOf(this);
          if (i >= 0) this._parent.children.splice(i, 1);
        }
      },
      click() { for (const cb of this._listeners.click || []) cb({ type: 'click' }); },
    };
  }
  return { createElement: (t) => makeEl(t) };
}

function byClass(root, cls, acc = []) {
  if (root && typeof root.className === 'string' && root.className.split(' ').includes(cls)) acc.push(root);
  for (const kid of (root && root.children) || []) byClass(kid, cls, acc);
  return acc;
}

/** The nearest ancestor carrying one of the Stage's slot classes. */
function slotOf(node) {
  const MAP = {
    [STAGE_DOM.canvasClass]: 'canvas',
    [STAGE_DOM.hudClass]: 'hud',
    [STAGE_DOM.scrollClass]: 'scroll',
    [STAGE_DOM.composeClass]: 'compose',
  };
  let cur = node && node._parent;
  while (cur) {
    const cls = typeof cur.className === 'string' ? cur.className.split(' ') : [];
    for (const c of cls) if (MAP[c]) return MAP[c];
    cur = cur._parent;
  }
  return null;
}

function fakeStore(state) {
  const dispatched = [];
  return {
    getState: () => state,
    subscribe: () => () => {},
    dispatch: (a) => dispatched.push(a),
    dispatched,
  };
}

function mountStage(state = {}) {
  const doc = makeDom();
  const surfaces = {};
  for (const name of Object.keys(SLOT_OF_SURFACE)) {
    const el = doc.createElement('div');
    surfaces[name] = { el };
  }
  const store = fakeStore(state);
  const view = createStageView({ doc, store, surfaces });
  return { view, root: view.el, surfaces, store, doc };
}

/* ================================ view model ================================ */

test('stageViewModel is total: junk or empty state still yields a renderable Stage', () => {
  for (const bad of [undefined, null, {}, 42, 'x', { workspace: null }, { workspace: { layout: 7 } }]) {
    const vm = stageViewModel(bad);
    assert.ok(DETENTS.includes(vm.detent), 'a valid detent');
    assert.equal(typeof vm.experience, 'string');
    assert.ok(vm.experience.length > 0, 'a non-empty experience');
    assert.ok(Array.isArray(vm.chips) && vm.chips.length > 0, 'always some suggestions');
    for (const name of Object.keys(SLOT_OF_SURFACE)) {
      assert.equal(typeof vm.visible[name], 'boolean');
    }
  }
});

test('the experience TUNES the opening detent; it does not rearrange anything', () => {
  for (const [experience, detent] of Object.entries(OPENING_DETENT)) {
    const vm = stageViewModel({ workspace: { experience } });
    assert.equal(vm.detent, detent, `${experience} opens at ${detent}`);
  }
  // Phone-first: the mobile experience opens with the agent OUT OF THE WAY.
  assert.equal(stageViewModel({ workspace: { experience: 'mobile-command-center' } }).detent, 'peek');
});

test('a descriptor can HIDE a surface but never has to enumerate them all', () => {
  const vm = stageViewModel({
    workspace: { experience: 'kiro-style', layout: { surfaces: { filePanel: { visible: false } } } },
  });
  assert.equal(vm.visible.filePanel, false, 'an explicit visible:false is honoured');
  assert.equal(vm.visible.preview, true, 'an unmentioned surface defaults to visible');
});

/* ================================ structure ================================= */

test('the app owns the CANVAS and the agent lives in the SHEET (the structural change)', () => {
  const { root, surfaces } = mountStage();

  assert.equal(byClass(root, STAGE_DOM.canvasClass).length, 1, 'exactly one canvas');
  assert.equal(byClass(root, STAGE_DOM.sheetClass).length, 1, 'exactly one sheet');

  // The preview is THE canvas, not a panel beside a transcript.
  assert.equal(slotOf(surfaces.preview.el), 'canvas', 'preview renders into the canvas');
  // Everything conversational is inside the sheet.
  for (const name of ['activityStream', 'confirm', 'filePanel']) {
    assert.equal(slotOf(surfaces[name].el), 'scroll', `${name} renders in the sheet`);
  }
  assert.equal(slotOf(surfaces.compose.el), 'compose', 'compose is its own pinned row');
  assert.equal(slotOf(surfaces.sessionHeader.el), 'hud', 'the header floats over the canvas');
});

test('there are no named regions left to sort surfaces into', () => {
  const { root } = mountStage();
  const withRegion = [];
  (function walk(n) {
    if (n && n.getAttribute && n.getAttribute('data-region')) withRegion.push(n);
    for (const k of (n && n.children) || []) walk(k);
  })(root);
  assert.deepEqual(withRegion, [], 'the region grid is gone, not merely restyled');
});

test('the sheet has three detents and the grip cycles them', () => {
  const { root, store } = mountStage();
  const sheet = byClass(root, STAGE_DOM.sheetClass)[0];
  const grip = byClass(root, STAGE_DOM.gripClass)[0];
  assert.ok(grip, 'the grip is a real button, so the sheet works without a drag');
  assert.equal(grip.type, 'button');

  const seen = [sheet.getAttribute('data-detent')];
  for (let i = 0; i < DETENTS.length; i += 1) {
    grip.click();
    seen.push(sheet.getAttribute('data-detent'));
  }
  for (const d of seen) assert.ok(DETENTS.includes(d), `${d} is a real detent`);
  assert.ok(new Set(seen).size >= DETENTS.length, 'cycling reaches every detent');
  assert.ok(
    store.dispatched.every((a) => a.type === 'stage/detent'),
    'detent is client-only UI state; nothing else is dispatched',
  );
});

test('the grip reports its expanded state for assistive tech', () => {
  const { root } = mountStage({ workspace: { experience: 'mobile-command-center' } });
  const grip = byClass(root, STAGE_DOM.gripClass)[0];
  assert.equal(grip.getAttribute('aria-expanded'), 'false', 'peek is collapsed');
  grip.click();
  assert.notEqual(grip.getAttribute('aria-expanded'), null, 'state is always reported');
});

test('voice leads the input row, because typing on a phone is the fallback', () => {
  const { root } = mountStage();
  const chips = byClass(root, 'sheet__chip');
  assert.ok(chips.length > 0, 'suggestion chips exist');
  const voice = byClass(root, 'sheet__chip--voice');
  assert.equal(voice.length, 1, 'exactly one voice affordance');
});

test('a chip submits a prompt the user did not have to type', () => {
  const doc = makeDom();
  const surfaces = {};
  for (const name of Object.keys(SLOT_OF_SURFACE)) surfaces[name] = { el: doc.createElement('div') };
  const sent = [];
  const view = createStageView({
    doc,
    store: fakeStore({}),
    surfaces,
    onChip: (t) => sent.push(t),
  });
  const chip = byClass(view.el, 'sheet__chip').find((c) => !c.className.includes('voice'));
  chip.click();
  assert.equal(sent.length, 1, 'tapping a chip submits it');
  assert.equal(typeof sent[0], 'string');
  assert.ok(sent[0].length > 0);
});

/* ============================== CSP + hygiene ============================== */

test('the Stage builds every node with the DOM API — no innerHTML, no inline handlers', () => {
  // Strip comments first: prose describing the rule is not a violation of it.
  const code = stageSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML/.test(code), 'no innerHTML');
  assert.ok(!/outerHTML/.test(code), 'no outerHTML');
  assert.ok(!/\bon(click|input|submit|change)\s*=/.test(code), 'no inline handler attributes');
  assert.ok(!/document\.write/.test(code), 'no document.write');
  // And it really does build nodes the safe way.
  assert.ok(/createElement\(/.test(code), 'nodes are built with createElement');
});

/* ============================ stylesheet contract ========================== */

function stripComments(t) { return t.replace(/\/\*[\s\S]*?\*\//g, ''); }
function bodies(text, selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')).includes(selector)) out.push(m[2]);
  }
  return out;
}
function decl(text, selector, prop) {
  for (const body of bodies(text, selector)) {
    const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`));
    if (m) return m[1].trim().replace(/\s+/g, ' ');
  }
  return null;
}
const sheetCss = stripComments(css);

test('the stylesheet describes a Stage, not a region grid', () => {
  assert.ok(bodies(sheetCss, '.stage').length > 0, 'a stage rule exists');
  assert.ok(bodies(sheetCss, '.stage__canvas').length > 0, 'a canvas rule exists');
  assert.ok(bodies(sheetCss, '.sheet').length > 0, 'a sheet rule exists');
  // The deleted architecture leaves no trace.
  assert.equal(bodies(sheetCss, '.shell__body').length, 0, 'no region-grid body rule');
  assert.ok(!/\.shell\[data-experience="[a-z-]+"\]\s+\.shell__body/.test(sheetCss),
    'no per-experience grid geometry');
});

test('every detent has a rule, and peek genuinely hides the stream', () => {
  for (const d of DETENTS) {
    assert.ok(
      bodies(sheetCss, `.sheet[data-detent="${d}"]`).length > 0,
      `the ${d} detent has a rule`,
    );
  }
  assert.equal(
    decl(sheetCss, '.sheet[data-detent="peek"] .sheet__scroll', 'display'),
    'none',
    'at peek the agent is genuinely out of the way',
  );
});

test('the same DOM becomes a docked rail on a wide viewport (one breakpoint, not a second layout)', () => {
  const i = css.indexOf('@media (min-width: 60rem)');
  assert.notEqual(i, -1, 'a single wide-viewport breakpoint exists');
  let depth = 0;
  let block = '';
  for (let j = css.indexOf('{', i); j < css.length; j += 1) {
    if (css[j] === '{') depth += 1;
    else if (css[j] === '}') { depth -= 1; if (depth === 0) { block = css.slice(i, j + 1); break; } }
  }
  assert.match(block, /\.sheet\s*\{/, 'the sheet is redefined as a rail');
  assert.match(block, /grid-template-columns/, 'the canvas gives up that width');
  assert.match(stripComments(block), /\.sheet__grip[\s\S]*display:\s*none/,
    'no drag affordance on a rail, where every detent is the same column');
});

test('no horizontal overflow at 360px, and single-column by construction', () => {
  assert.equal(decl(sheetCss, '.stage', 'overflow-x'), 'hidden', 'the stage never scrolls sideways');
  assert.equal(decl(sheetCss, '.stage', 'min-width'), '0');
  assert.equal(decl(sheetCss, '.sheet', 'min-width'), '0');
  assert.equal(decl(sheetCss, '.sheet', 'max-width'), '100%');
  assert.equal(decl(sheetCss, '.stage__canvas', 'max-width'), '100%');
  // The Stage needs no collapse rule: it is one column until 60rem ADDS a rail.
  assert.match(css, /@media\s*\(max-width:\s*400px\)/, '360px tuning still exists');
  assert.match(css, /\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box;/, 'border-box reset');
});

test('every interactive Stage control is touch-sized', () => {
  for (const sel of ['.sheet__grip', '.sheet__chip']) {
    assert.equal(decl(sheetCss, sel, 'min-height'), 'var(--touch)', `${sel} meets the touch floor`);
  }
  assert.equal(decl(sheetCss, '.sheet__grip', 'min-width'), 'var(--touch)');
});

test('the Stage is palette-driven, so all eight themes still work', () => {
  const i = sheetCss.indexOf('.stage {');
  assert.notEqual(i, -1);
  const below = sheetCss.slice(i);

  for (const hex of below.match(/#[0-9a-fA-F]{3,8}\b/g) || []) {
    assert.equal(hex.toLowerCase(), '#ffffff', 'the only literal colour below the stage is the QR scaffold');
  }
  const colorDecls = below.match(/(?:^|[\s;{])(?:background-color|color|border-color)\s*:[^;}]+/g) || [];
  assert.ok(colorDecls.length > 10, 'the sections really do set colours');
  for (const d of colorDecls) {
    if (/:\s*(transparent|inherit|currentColor)\s*$/i.test(d)) continue;
    if (/:\s*#ffffff\s*$/i.test(d)) continue;
    if (/:\s*(Canvas|CanvasText|ButtonBorder|Highlight|HighlightText)\s*$/i.test(d)) continue;
    assert.match(d, /var\(--color-[A-Za-z]+\)/, `palette-driven declaration: ${d.trim()}`);
  }
});
