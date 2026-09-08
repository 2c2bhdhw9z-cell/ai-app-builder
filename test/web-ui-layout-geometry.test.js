/**
 * Structural CSS test for the five Workspace_Experience geometries (node --test)
 * — platform Req 27.2, 27.8, 29; web-ui Req 8.3, 11.1, 11.2, 11.3.
 *
 * views/layout.js decides the ARRANGEMENT (which surface in which region);
 * styles.css turns it into the actual GEOMETRY. A headless test cannot lay out
 * pixels, so these assertions are structural over the REAL served stylesheet —
 * the same approach the existing mobile integration test uses:
 *
 *   - each of the five experiences declares its OWN body geometry, and
 *     kiro-style / vibe-first / technical-workbench / mobile-command-center are
 *     four DIFFERENT declarations (the regression: they used to render the same);
 *   - the Technical Workbench is a real IDE grid — a sidebar + editor row over a
 *     full-width dock (Req 27.8);
 *   - EVERY experience collapses to a single column at <=720px and cannot
 *     overflow horizontally at 360px;
 *   - every geometry is palette-driven only (no hard-coded color), so each
 *     experience stays fully theme-able per (account, experience) (Req 29);
 *   - the collapse toggle a collapsed surface offers is touch-sized (Req 11.3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CSS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'server',
  'public',
  'styles.css',
);

const css = await readFile(CSS_PATH, 'utf8');

/** Strip comments so prose in comments is never matched as a declaration. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of the `@media (max-width: N px)` block, by brace matching. */
function mediaBlock(text, query) {
  const start = text.indexOf(query);
  assert.notEqual(start, -1, `stylesheet declares ${query}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${query}`);
}

/** All rule bodies whose selector list contains `selector`, in source order. */
function bodies(text, selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

/** The single declaration value for `prop` in the rule(s) for `selector`. */
function decl(text, selector, prop) {
  for (const body of bodies(text, selector)) {
    const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`));
    if (m) return m[1].trim().replace(/\s+/g, ' ');
  }
  return null;
}

const sheet = stripComments(css);
const EXPERIENCES = [
  'kiro-style',
  'vibe-first',
  'technical-workbench',
  'mobile-command-center',
  'custom',
];

// --------------------------------------------- each experience has a geometry

test('each of the five Workspace_Experiences declares its own body geometry', () => {
  for (const experience of EXPERIENCES) {
    assert.ok(
      bodies(sheet, `.shell[data-experience="${experience}"] .shell__body`).length > 0,
      `${experience} has its own .shell__body geometry rule`,
    );
  }
});

test('kiro-style, vibe-first, technical-workbench and mobile are FOUR DIFFERENT geometries (regression)', () => {
  const geometry = (experience) => {
    const sel = `.shell[data-experience="${experience}"] .shell__body`;
    return [
      decl(sheet, sel, 'grid-template-columns'),
      decl(sheet, sel, 'grid-template-rows'),
      (decl(sheet, sel, 'grid-template-areas') || '').replace(/"\s+"/g, '" "'),
    ].join(' | ');
  };
  const distinct = ['kiro-style', 'vibe-first', 'technical-workbench', 'mobile-command-center'];
  const seen = new Map();
  for (const experience of distinct) {
    const g = geometry(experience);
    assert.ok(g.replace(/[|\s]/g, '') !== '', `${experience} declares a real grid template`);
    for (const [other, prior] of seen) {
      assert.notEqual(g, prior, `${experience} and ${other} must NOT share a geometry`);
    }
    seen.set(experience, g);
  }

  // kiro-style is two columns; vibe-first and mobile are one.
  assert.match(
    decl(sheet, '.shell[data-experience="kiro-style"] .shell__body', 'grid-template-columns'),
    /minmax\(0, 1fr\) minmax\(0, [\d.]+rem\)/,
    'kiro-style is a two-column conversation/preview split',
  );
  for (const single of ['vibe-first', 'mobile-command-center']) {
    assert.equal(
      decl(sheet, `.shell[data-experience="${single}"] .shell__body`, 'grid-template-columns'),
      'minmax(0, 1fr)',
      `${single} is a single column`,
    );
  }
  // custom mirrors kiro-style (until the user rearranges it — Req 27.4).
  assert.ok(
    bodies(sheet, '.shell[data-experience="custom"] .shell__body').some((b) =>
      /grid-template-columns/.test(b),
    ),
    'custom declares the kiro-style two-column start',
  );
});

// ------------------------------------------------- the IDE cockpit (Req 27.8)

test('technical-workbench is a real IDE grid: sidebar + editor over a full-width dock (Req 27.8)', () => {
  const sel = '.shell[data-experience="technical-workbench"] .shell__body';
  const areas = decl(sheet, sel, 'grid-template-areas');
  assert.ok(areas, 'the workbench uses grid-template-areas');
  const normalized = areas.replace(/\s+/g, ' ');
  assert.match(normalized, /"sidebar editor"/, 'a sidebar beside the editor');
  assert.match(normalized, /"dock dock"/, 'a dock spanning the full width beneath both');
  assert.match(
    decl(sheet, sel, 'grid-template-columns'),
    /minmax\(0, [\d.]+rem\) minmax\(0, 1fr\)/,
    'a fixed-ish sidebar and a large central editor column',
  );
  assert.ok(decl(sheet, sel, 'grid-template-rows'), 'an editor row over a dock row');

  // Each IDE region is placed into its named grid area.
  for (const region of ['sidebar', 'editor', 'dock']) {
    const regionSel = `.shell[data-experience="technical-workbench"] .shell__region[data-region="${region}"]`;
    assert.equal(decl(sheet, regionSel, 'grid-area'), region, `${region} is placed in its grid area`);
  }
  // The editor/sidebar panes scroll inside the cockpit rather than the page.
  assert.equal(
    decl(sheet, '.shell[data-experience="technical-workbench"] .shell__region', 'overflow'),
    'auto',
    'workbench panes scroll independently, like an IDE',
  );
});

// ------------------------------------- vibe-first foregrounds the compose box

test('vibe-first foregrounds the compose surface via the descriptor emphasis (Req 27.2)', () => {
  // The generic emphasis rule (any experience, any custom layout).
  const generic = bodies(sheet, '.shell__surface[data-emphasis="primary"]');
  assert.ok(generic.length > 0, 'emphasis:primary is honored generically');
  assert.match(generic.join(' '), /var\(--color-accent\)/, 'and is palette-driven');
  // Plus the vibe-first tuning.
  assert.ok(
    bodies(sheet, '.shell[data-experience="vibe-first"] .shell__surface[data-emphasis="primary"]').length > 0,
    'vibe-first tunes the foregrounded compose box further',
  );
  // The aside is a stacked region under the conversation, not a side column.
  assert.equal(
    decl(sheet, '.shell[data-experience="vibe-first"] .shell__region[data-region="aside"]', 'grid-area'),
    'aside',
  );
});

// ------------------------------------------ responsive collapse + no overflow

test('EVERY experience collapses to one column at <=720px and cannot overflow at 360px (Req 11.1, 11.2)', () => {
  const phone = stripComments(mediaBlock(css, '@media (max-width: 720px)'));

  // The collapse applies to any experience (attribute presence selector), so the
  // workbench grid and the two-column layouts all fold into one column.
  assert.equal(
    decl(phone, '.shell[data-experience] .shell__body', 'grid-template-columns'),
    'minmax(0, 1fr)',
    'one column for every experience',
  );
  assert.equal(
    decl(phone, '.shell[data-experience] .shell__body', 'grid-template-areas'),
    'none',
    'the named grid areas are dropped so regions stack',
  );
  assert.equal(decl(phone, '.shell[data-experience] .shell__body', 'height'), 'auto');
  const regionReset = bodies(phone, '.shell[data-experience] .shell__region[data-region]').join(' ');
  assert.match(regionReset, /grid-area:\s*auto/, 'each region stacks in flow');
  assert.match(regionReset, /position:\s*static/, 'no sticky side panels on a phone');

  // No horizontal overflow: the shell clips sideways, and regions/surfaces can
  // shrink below their content width.
  assert.equal(decl(sheet, '.shell', 'overflow-x'), 'hidden', 'the shell never scrolls sideways');
  assert.equal(decl(sheet, '.shell__region', 'min-width'), '0');
  assert.equal(decl(sheet, '.shell__region', 'max-width'), '100%');
  assert.equal(decl(sheet, '.shell__surface', 'min-width'), '0');
  assert.equal(decl(sheet, '.shell__surface', 'max-width'), '100%');
  // The narrow-phone (360px) tuning still exists.
  assert.ok(mediaBlock(css, '@media (max-width: 400px)').length > 0);
});

test('a collapsed surface toggle is touch-sized and every surface state has a rule (Req 11.3)', () => {
  assert.equal(decl(sheet, '.shell__collapse-toggle', 'min-height'), 'var(--touch)');
  assert.equal(decl(sheet, '.shell__collapse-toggle', 'min-width'), 'var(--touch)');
  // visible:false and the collapsed body are both actually hidden by CSS.
  assert.equal(decl(sheet, '.shell__surface[hidden]', 'display'), 'none');
  assert.equal(decl(sheet, '.shell__surface > [hidden]', 'display'), 'none');
  assert.equal(decl(sheet, '.shell__region[hidden]', 'display'), 'none');
  // size:'flex' vs 'auto' really drive growth.
  assert.match(decl(sheet, '.shell__surface[data-size="flex"]', 'flex'), /1 1 auto/);
  assert.match(decl(sheet, '.shell__surface[data-size="auto"]', 'flex'), /0 0 auto/);
});

// --------------------------------------------- theme-able: palette-driven only

test('every layout — including the workbench — is palette-driven, so all five stay theme-able (Req 27.8, 29)', () => {
  const shellSection = sheet.slice(sheet.indexOf('.shell {'));
  // No hard-coded color anywhere below the shell (the QR white scaffold aside).
  for (const hex of shellSection.match(/#[0-9a-fA-F]{3,8}\b/g) || []) {
    assert.equal(hex.toLowerCase(), '#ffffff', 'the only literal color below .shell is the QR scaffold');
  }
  // Every color/background declaration in the shell + file-panel sections reads a
  // --color-* custom property.
  const colorDecls =
    shellSection.match(/(?:^|[\s;{])(?:background-color|color|border-color)\s*:[^;}]+/g) || [];
  assert.ok(colorDecls.length > 10, 'the sections really do set colors');
  for (const d of colorDecls) {
    // `transparent` / `inherit` / `currentColor` carry no color of their own, so
    // they cannot fight a Theme; everything else must read a palette variable.
    if (/:\s*(transparent|inherit|currentColor)\s*$/i.test(d)) continue;
    // The QR image's white scaffold must be true monochrome to scan (documented
    // exception, asserted above as the ONLY literal color below .shell).
    if (/:\s*#ffffff\s*$/i.test(d)) continue;
    assert.match(d, /var\(--color-[A-Za-z]+\)/, `palette-driven declaration: ${d.trim()}`);
  }
  // The workbench's pane seams and surfaces use palette variables too.
  const workbenchBody = bodies(sheet, '.shell[data-experience="technical-workbench"] .shell__body').join(' ');
  assert.match(workbenchBody, /background-color:\s*var\(--color-badge\)/);
});
