/**
 * Property-based test for Web UI Task 11.2 (node --test).
 *
 * Property 26 — "Applying a theme frame sets the full palette on the surface"
 * (design §"Property 26", Req 9.1). Exact spec tag:
 *
 *   "Feature: web-ui, Property 26: Applying a theme frame sets the full palette
 *    on the surface"
 *
 * WHAT IS PROVEN, through the REAL palette applier (theme.js `applyPalette`): for
 * ANY palette, applying it sets ALL NINE `--color-*` CSS custom properties on
 * the style target to the palette's corresponding values, using EXACTLY the
 * names the design lists (--color-background, --color-surface, --color-accent,
 * --color-button, --color-badge, --color-statusInfo, --color-statusSuccess,
 * --color-statusWarning, --color-statusError). The target is a RECORDING style
 * object exposing setProperty(name, value) — the same interface as the browser's
 * `document.documentElement.style` — so the property runs DOM-free while
 * exercising the shipping applier (no over-mocking).
 *
 * The palette generators cover BOTH the eight real THEME_CATALOG palettes and
 * arbitrary generated 9-key palettes, so the mapping is proven over the real
 * data and the general space.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { PALETTE_KEYS } from '../src/server/public/store.js';
import { applyPalette, cssVarName, CSS_VAR_NAMES } from '../src/server/public/theme.js';
import { THEME_CATALOG } from '../src/model/enums.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** A recording style target: mirrors CSSOM `element.style.setProperty`. */
function recordingTarget() {
  const props = new Map();
  return {
    setProperty(name, value) { props.set(name, value); },
    get(name) { return props.has(name) ? props.get(name) : undefined; },
    size() { return props.size; },
  };
}

/** A hex color generator. */
const hex = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, '0')}`);

/** An arbitrary full 9-key palette. */
const generatedPalette = fc.record(
  Object.fromEntries(PALETTE_KEYS.map((k) => [k, hex])),
);

/** The eight real catalog palettes. */
const catalogPalette = fc.constantFrom(
  ...Object.values(THEME_CATALOG).map((t) => t.palette),
);

const anyPalette = fc.oneof(generatedPalette, catalogPalette);

// ------------------------------------------------------ Property 26 (Task 11.2)

test(
  webUiTag(26, 'Applying a theme frame sets the full palette on the surface'),
  () => {
    // The nine var names are exactly the design's list.
    assert.deepEqual(CSS_VAR_NAMES, [
      '--color-background',
      '--color-surface',
      '--color-accent',
      '--color-button',
      '--color-badge',
      '--color-statusInfo',
      '--color-statusSuccess',
      '--color-statusWarning',
      '--color-statusError',
    ]);

    fc.assert(
      fc.property(anyPalette, (palette) => {
        const target = recordingTarget();
        const set = applyPalette(target, palette);

        // All nine properties were set (Property 26).
        assert.equal(set, PALETTE_KEYS.length, 'all nine properties set');
        assert.equal(target.size(), PALETTE_KEYS.length, 'exactly nine custom properties on the surface');

        // Each --color-<key> equals the palette's value for that key.
        for (const key of PALETTE_KEYS) {
          assert.equal(
            target.get(cssVarName(key)),
            palette[key],
            `--color-${key} resolves to the palette value`,
          );
        }
        return true;
      }),
      fcConfig,
    );
  },
);

// -------------------------------------------- Mutation / test-quality guard

test('Property 26 guard: a missing palette key is not written (partial palette is total-safe)', () => {
  const target = recordingTarget();
  const partial = { background: '#123456' }; // only one key
  const set = applyPalette(target, partial);
  assert.equal(set, 1, 'only the present key is written');
  assert.equal(target.get('--color-background'), '#123456');
  assert.equal(target.get('--color-accent'), undefined, 'absent key not written');
  // A null target / null palette is a no-op, not a crash.
  assert.equal(applyPalette(null, partial), 0);
  assert.equal(applyPalette(target, null), 0);
});
