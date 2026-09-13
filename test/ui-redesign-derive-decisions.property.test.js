/**
 * ui-redesign — the DERIVED DECISION LAYER.
 *
 * Properties 32–37 of the ui-redesign design. These cover the fix for a real
 * shipped defect: `styles.css` painted body text with `var(--color-accent)`, so
 * body contrast equalled accent-on-background and FAILED WCAG AA on four of the
 * eight shipped themes (pastel-pasture 2.15:1, morning-dew 2.36:1,
 * summer-sunset 2.63:1, peach-popsicle 2.14:1).
 *
 * Real collaborators only: these exercise the REAL exported `deriveDecisions`
 * and the REAL `THEME_CATALOG`, never a stand-in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  deriveDecisions,
  applyPalette,
  applyDerivedDecisions,
} from '../src/server/public/theme.js';
import { PALETTE_KEYS } from '../src/server/public/store.js';
import { THEME_CATALOG } from '../src/model/enums.js';

const RUNS = { numRuns: 200 };
const AA = 4.5;

const tag = (n, title) => `Feature: ui-redesign, Property ${n}: ${title}`;

/* ---- WCAG 2.x helpers, implemented once for the whole file ---- */
function parseHex(v) {
  let h = String(v).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const la = luminance(parseHex(a));
  const lb = luminance(parseHex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ---- generators ---- */
const hex = fc
  .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
  .map(([r, g, b]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`);

const anyPalette = fc.record(Object.fromEntries(PALETTE_KEYS.map((k) => [k, hex])));

/** Adversarial: background and surface within ~1% luminance of each other. */
const nearIdenticalPalette = fc.tuple(hex, fc.integer({ min: 0, max: 4 })).map(([bg, d]) => {
  const [r, g, b] = parseHex(bg);
  const near = `#${[r, g, b].map((c) => Math.min(255, c + d).toString(16).padStart(2, '0')).join('')}`;
  return Object.fromEntries(PALETTE_KEYS.map((k) => [k, k === 'surface' ? near : bg]));
});

/** Adversarial: every fill parked in the mid-luminance dead zone. */
const midLuminancePalette = fc
  .tuple(...PALETTE_KEYS.map(() => fc.integer({ min: 110, max: 150 })))
  .map((vals) =>
    Object.fromEntries(
      PALETTE_KEYS.map((k, i) => [k, `#${vals[i].toString(16).padStart(2, '0').repeat(3)}`]),
    ),
  );

const adversarial = fc.oneof(anyPalette, nearIdenticalPalette, midLuminancePalette);

/* =================== Property 32 =================== */
test(tag(32, 'derivation is a pure function of the nine inputs'), () => {
  fc.assert(
    fc.property(adversarial, (palette) => {
      const a = deriveDecisions(palette);
      const b = deriveDecisions(palette);
      assert.deepEqual(a, b, 'two calls with the same palette are deeply equal');
      // order independence: deriving something else in between changes nothing
      deriveDecisions({ ...palette, background: '#123456' });
      assert.deepEqual(deriveDecisions(palette), a, 'no dependence on call order');
    }),
    RUNS,
  );
});

test('Property 32 guard: malformed input degrades safely and never throws', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, { background: '#zz' }, { background: 7 }]) {
    const d = assert.doesNotThrow(() => deriveDecisions(bad)) ?? deriveDecisions(bad);
    assert.ok(/^#[0-9a-f]{6}$/.test(d.ink), 'ink is a usable hex');
    assert.ok(/^#[0-9a-f]{6}$/.test(d.paper), 'paper is a usable hex');
    for (const k of PALETTE_KEYS) assert.ok(/^#[0-9a-f]{6}$/.test(d.on[k]), `on.${k} is a usable hex`);
  }
});

/* =================== Property 33 =================== */
test(tag(33, 'polarity is correct for arbitrary palettes'), () => {
  fc.assert(
    fc.property(adversarial, (palette) => {
      const d = deriveDecisions(palette);
      const expected = luminance(parseHex(palette.background)) < 0.5 ? 'dark' : 'light';
      assert.equal(d.polarity, expected, 'polarity follows background luminance');
      assert.equal(d.colorScheme, expected, 'colorScheme mirrors polarity');
    }),
    RUNS,
  );
});

/* =================== Property 34 =================== */
test(tag(34, 'every on-* token is the higher-contrast anchor for its fill'), () => {
  fc.assert(
    fc.property(adversarial, (palette) => {
      const d = deriveDecisions(palette);
      for (const key of PALETTE_KEYS) {
        const fill = palette[key];
        const chosen = contrast(d.on[key], fill);
        const other = d.on[key] === d.ink ? contrast(d.paper, fill) : contrast(d.ink, fill);
        assert.ok(
          chosen >= other - 1e-9,
          `on.${key} picked the higher-contrast anchor (${chosen.toFixed(2)} vs ${other.toFixed(2)})`,
        );
      }
    }),
    RUNS,
  );
});

/* =================== Property 35 =================== */
test(tag(35, 'body text meets WCAG AA on arbitrary palettes'), () => {
  fc.assert(
    fc.property(adversarial, (palette) => {
      const d = deriveDecisions(palette);
      const onBg = contrast(d.on.background, palette.background);
      const onSurf = contrast(d.on.surface, palette.surface);
      assert.ok(onBg >= AA, `on-background vs background is ${onBg.toFixed(2)}:1, needs >= ${AA}`);
      assert.ok(onSurf >= AA, `on-surface vs surface is ${onSurf.toFixed(2)}:1, needs >= ${AA}`);
    }),
    RUNS,
  );
});

/* =================== Property 36 =================== */
test(tag(36, 'body text meets WCAG AA on all eight shipped themes'), () => {
  // The four that FAILED before this layer existed, with their old ratios.
  const previouslyFailing = {
    'pastel-pasture': 2.15,
    'morning-dew': 2.36,
    'summer-sunset': 2.63,
    'peach-popsicle': 2.14,
  };
  const ids = Object.keys(THEME_CATALOG);
  assert.equal(ids.length, 8, 'the catalog still ships exactly eight themes');

  for (const [id, theme] of Object.entries(THEME_CATALOG)) {
    const p = theme.palette;
    const d = deriveDecisions(p);

    const onBg = contrast(d.on.background, p.background);
    const onSurf = contrast(d.on.surface, p.surface);
    assert.ok(onBg >= AA, `${id}: on-background is ${onBg.toFixed(2)}:1`);
    assert.ok(onSurf >= AA, `${id}: on-surface is ${onSurf.toFixed(2)}:1`);

    if (id in previouslyFailing) {
      // Document the regression this layer fixes: the OLD accent-as-text path
      // really did fail, and the NEW derived path really does pass.
      const oldRatio = contrast(p.accent, p.background);
      assert.ok(oldRatio < AA, `${id}: accent-as-text did fail AA (${oldRatio.toFixed(2)}:1)`);
      assert.ok(
        Math.abs(oldRatio - previouslyFailing[id]) < 0.05,
        `${id}: old ratio still ~${previouslyFailing[id]}:1`,
      );
      assert.ok(onBg > oldRatio, `${id}: derived foreground beats accent-as-text`);
    }
  }
});

/* =================== Property 37 =================== */
test(tag(37, 'the anchor hue nudge never costs legibility'), () => {
  fc.assert(
    fc.property(adversarial, (palette) => {
      const d = deriveDecisions(palette);
      const bg = palette.background;
      // The nudged anchor actually used for body text clears AA...
      assert.ok(contrast(d.on.background, bg) >= AA, 'nudged anchor clears the AA floor');
      // ...and is never worse than the un-nudged neutral by more than a bounded
      // tolerance, so warmth is never bought with legibility.
      // Bounded PROPORTIONALLY, not by an absolute number of points: on a pure
      // black background the un-nudged best is 21:1, so an absolute tolerance is
      // meaningless while 17:1 is still excellent. What matters is that the nudge
      // never gives away a large fraction of the available contrast.
      const pureBest = Math.max(contrast('#000000', bg), contrast('#ffffff', bg));
      assert.ok(
        contrast(d.on.background, bg) >= pureBest * 0.7,
        `nudge kept >=70% of the un-nudged contrast (got ${contrast(d.on.background, bg).toFixed(2)} of ${pureBest.toFixed(2)})`,
      );
    }),
    RUNS,
  );
});

/* ---- Property 38 (contract preservation) in its applyPalette form ---- */
test(tag(38, 'applyPalette still sets EXACTLY the nine themeable inputs (Property 26 verbatim)'), () => {
  fc.assert(
    fc.property(anyPalette, (palette) => {
      // web-ui Property 26 is an EXCLUSIVITY assertion: it asserts
      // `target.size() === PALETTE_KEYS.length`, i.e. exactly nine properties on
      // the surface. So the derived layer must NOT ride inside applyPalette; it
      // is a separate call. This property pins that separation.
      const nine = new Map();
      const count = applyPalette({ setProperty: (n, v) => nine.set(n, v) }, palette);
      assert.equal(count, PALETTE_KEYS.length, 'all nine Layer-0 inputs were set');
      assert.equal(nine.size, PALETTE_KEYS.length, 'and EXACTLY nine, nothing more');
      for (const key of PALETTE_KEYS) {
        assert.equal(nine.get(`--color-${key}`), palette[key], `--color-${key} came from the palette`);
      }

      // The derived layer is additive and never overwrites a Layer-0 name.
      const all = new Map();
      const attrs = new Map();
      const target = { setProperty: (n, v) => all.set(n, v) };
      const element = { setAttribute: (n, v) => attrs.set(n, v) };
      applyPalette(target, palette);
      applyDerivedDecisions(target, palette, element);

      const d = deriveDecisions(palette);
      for (const key of PALETTE_KEYS) {
        assert.equal(all.get(`--color-${key}`), palette[key], `--color-${key} survived the derived pass`);
      }
      assert.equal(all.get('--color-ink'), d.ink);
      assert.equal(all.get('--color-paper'), d.paper);
      assert.equal(all.get('--color-shadow'), d.shadowColor);
      for (const key of PALETTE_KEYS) {
        const cap = `--color-on${key[0].toUpperCase()}${key.slice(1)}`;
        assert.equal(all.get(cap), d.on[key], `${cap} emitted`);
      }
      assert.equal(all.get('color-scheme'), d.colorScheme);
      assert.equal(attrs.get('data-polarity'), d.polarity);
    }),
    RUNS,
  );
});

/* ---- Property 39: preview-then-cancel is the identity over the FULL set ---- */
test(tag(39, 'preview-then-cancel restores every derived token'), () => {
  fc.assert(
    fc.property(anyPalette, anyPalette, (committed, previewed) => {
      const snap = () => {
        const m = new Map();
        const el = new Map();
        return { m, el, target: { setProperty: (n, v) => m.set(n, v) }, element: { setAttribute: (n, v) => el.set(n, v) } };
      };
      const apply = (s2, pal) => {
        applyPalette(s2.target, pal);
        applyDerivedDecisions(s2.target, pal, s2.element);
      };

      const before = snap();
      apply(before, committed);

      const after = snap();
      apply(after, committed);
      apply(after, previewed); // preview
      apply(after, committed); // cancel == re-apply, no bookkeeping

      assert.deepEqual([...after.m.entries()].sort(), [...before.m.entries()].sort(),
        'every custom property returned to its committed value');
      assert.deepEqual([...after.el.entries()], [...before.el.entries()],
        'data-polarity returned to its committed value');
    }),
    RUNS,
  );
});
