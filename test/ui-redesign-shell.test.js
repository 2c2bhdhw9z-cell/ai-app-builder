/**
 * ui-redesign — invariants that must survive every shell rewrite.
 *
 * THIS FILE EXISTS TO STOP INVARIANTS LEAKING AWAY. Three tests were deleted when
 * the region-grid architecture was removed:
 *   web-ui-layout-geometry.test.js
 *   web-ui-workspace-regions.test.js
 *   web-ui-mobile-command-center.integration.test.js
 * They asserted five per-experience grid geometries and surface-to-region sorting,
 * neither of which exists any more. But they ALSO asserted things that are still
 * true and still matter: no horizontal overflow at 360px, touch-sized controls,
 * palette-driven colour, and CSP cleanliness.
 *
 * Those are re-asserted here. When the real surfaces (Vibe / IDE / Preview, see
 * .kiro/specs/ui-redesign/PLAN.md) replace the interim shell, MOVE these assertions
 * to them. Do not delete them with the shell.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createShellView,
  shellViewModel,
  SHELL_DOM,
  STACK_ORDER,
} from '../src/server/public/views/shell.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'src', 'server', 'public');
const css = await readFile(path.join(PUBLIC, 'styles.css'), 'utf8');
const shellSrc = await readFile(path.join(PUBLIC, 'views', 'shell.js'), 'utf8');

/* -------------------------------------------------------------- DOM shim ---- */
function makeDom() {
  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      className: '',
      id: '',
      hidden: false,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(k) { this.append(k); return k; },
      append(...kids) {
        for (const kid of kids) {
          if (kid && kid._parent) {
            const i = kid._parent.children.indexOf(kid);
            if (i >= 0) kid._parent.children.splice(i, 1);
          }
          this.children.push(kid);
          if (kid) kid._parent = this;
        }
      },
      addEventListener() {}, removeEventListener() {}, remove() {},
    };
  }
  return { createElement: (t) => el(t) };
}
function collect(root, pred, acc = []) {
  if (root && pred(root)) acc.push(root);
  for (const k of (root && root.children) || []) collect(k, pred, acc);
  return acc;
}
function mount(state = {}) {
  const doc = makeDom();
  const surfaces = {};
  for (const n of STACK_ORDER) surfaces[n] = { el: doc.createElement('div') };
  const view = createShellView({ doc, store: { getState: () => state, subscribe: () => () => {} }, surfaces });
  return { view, root: view.el, surfaces };
}

/* ------------------------------------------------------------ view model ---- */

test('shellViewModel is total: junk state still renders every surface', () => {
  for (const bad of [undefined, null, {}, 7, 'x', { workspace: null }, { workspace: { layout: 3 } }]) {
    const vm = shellViewModel(bad);
    for (const n of STACK_ORDER) assert.equal(vm.visible[n], true, `${n} defaults visible`);
  }
});

test('a descriptor can hide a surface without enumerating them all', () => {
  const vm = shellViewModel({ workspace: { layout: { surfaces: { filePanel: { visible: false } } } } });
  assert.equal(vm.visible.filePanel, false);
  assert.equal(vm.visible.preview, true);
});

test('surfaces are placed by identity, and no named regions remain', () => {
  const { root, surfaces } = mount();
  const slots = collect(root, (n) => n.getAttribute && n.getAttribute('data-surface'));
  assert.equal(slots.length, STACK_ORDER.length, 'every surface is mounted');
  assert.deepEqual(slots.map((s) => s.getAttribute('data-surface')), [...STACK_ORDER],
    'in the declared stack order');
  const regions = collect(root, (n) => n.getAttribute && n.getAttribute('data-region'));
  assert.deepEqual(regions, [], 'the region grid is gone and must not come back');
  for (const n of STACK_ORDER) assert.ok(surfaces[n].el._parent, `${n} is attached`);
});

test('a hidden surface is hidden on the slot, not by removing the view', () => {
  const { root, surfaces } = mount({ workspace: { layout: { surfaces: { preview: { visible: false } } } } });
  const slot = collect(root, (n) => n.getAttribute && n.getAttribute('data-surface') === 'preview')[0];
  assert.equal(slot.hidden, true, 'the slot is hidden');
  assert.ok(surfaces.preview.el._parent, 'the view itself stays mounted, so state survives');
});

/* ------------------------------------------------------------------ CSP ---- */

test('the shell builds every node with the DOM API', () => {
  const code = shellSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/innerHTML|outerHTML|document\.write/.test(code), 'no HTML injection');
  assert.ok(!/\bon(click|input|submit|change)\s*=/.test(code), 'no inline handlers');
  assert.ok(/createElement\(/.test(code), 'nodes built with createElement');
});

test('the shell is labelled interim and points at the real plan', () => {
  assert.match(shellSrc, /PLAN\.md/, 'points a reader at the authoritative plan');
  assert.match(shellSrc, /INTERIM|interim/, 'is explicitly labelled temporary');
});

/* ------------------------------------------------------ stylesheet rules ---- */

function strip(t) { return t.replace(/\/\*[\s\S]*?\*\//g, ''); }
function bodies(text, selector) {
  const out = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')).includes(selector)) out.push(m[2]);
  }
  return out;
}
function decl(text, selector, prop) {
  for (const b of bodies(text, selector)) {
    const m = b.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`));
    if (m) return m[1].trim().replace(/\s+/g, ' ');
  }
  return null;
}
const sheet = strip(css);

test('INVARIANT: no horizontal overflow at 360px', () => {
  assert.equal(decl(sheet, '.shell', 'overflow-x'), 'hidden', 'the shell never scrolls sideways');
  assert.equal(decl(sheet, '.shell', 'min-width'), '0');
  assert.equal(decl(sheet, '.shell__main', 'min-width'), '0');
  assert.equal(decl(sheet, '.shell__main', 'width'), '100%');
  assert.equal(decl(sheet, '.shell__slot', 'min-width'), '0');
  assert.equal(decl(sheet, '.shell__slot', 'max-width'), '100%');
  assert.match(css, /\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box;/, 'border-box reset');
  assert.match(css, /@media\s*\(max-width:\s*400px\)/, '360px tuning exists');
});

test('INVARIANT: interactive controls meet the touch floor', () => {
  assert.equal(decl(sheet, '.shell__settings-toggle', 'min-height'), 'var(--touch)');
  for (const sel of ['.prompt__submit', '.confirm__approve', '.session-header__mode']) {
    assert.equal(decl(sheet, sel, 'min-height'), 'var(--touch)', `${sel} meets the touch floor`);
  }
  assert.match(sheet, /--touch:\s*2\.75rem/, 'the floor is 44px');
});

test('INVARIANT: every colour below the token block is palette-driven', () => {
  const i = sheet.indexOf('.shell {');
  assert.notEqual(i, -1);
  const below = sheet.slice(i);

  for (const hex of below.match(/#[0-9a-fA-F]{3,8}\b/g) || []) {
    assert.equal(hex.toLowerCase(), '#ffffff', 'only the monochrome QR scaffold is literal');
  }
  const decls = below.match(/(?:^|[\s;{])(?:background-color|color|border-color)\s*:[^;}]+/g) || [];
  assert.ok(decls.length > 10, 'the sections really do set colours');
  for (const d of decls) {
    if (/:\s*(transparent|inherit|currentColor)\s*$/i.test(d)) continue;
    if (/:\s*#ffffff\s*$/i.test(d)) continue;
    if (/:\s*(Canvas|CanvasText|ButtonBorder|Highlight|HighlightText)\s*$/i.test(d)) continue;
    assert.match(d, /var\(--color-[A-Za-z]+\)/, `palette-driven: ${d.trim()}`);
  }
});

test('INVARIANT: reduced motion collapses every duration', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const i = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.match(css.slice(i, i + 400), /transition-duration:\s*1ms/);
});

test('INVARIANT: the diff marker is still text, not colour', () => {
  assert.ok(bodies(sheet, '.activity__diff-marker').length > 0, 'the textual marker has a rule');
  assert.ok(bodies(sheet, '.activity__diff-line[data-marker="+"]').length > 0, 'added lines are addressable');
  assert.ok(bodies(sheet, '.activity__diff-line[data-marker="-"]').length > 0, 'removed lines are addressable');
});

test('the superseded shells left no trace in the stylesheet', () => {
  assert.equal(bodies(sheet, '.shell__body').length, 0, 'no region-grid body rule');
  assert.equal(bodies(sheet, '.sheet').length, 0, 'no canvas+sheet rule');
  assert.equal(bodies(sheet, '.stage').length, 0, 'no stage rule');
  assert.ok(!/data-detent/.test(sheet), 'no sheet detents');
  assert.ok(!/\.shell\[data-experience="[a-z-]+"\]\s+\.shell__body/.test(sheet),
    'no per-experience grid geometry');
});
