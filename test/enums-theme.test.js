/**
 * Theme catalog enum tests (Task 33.4, Req 29.1/29.2/29.3/29.8).
 *
 * Exercises the REAL Theme catalog + predicates from src/model/enums.js — no
 * mocks. The catalog is a CLOSED set: the base light + dark themes PLUS the six
 * named color themes, each with a non-empty displayName, a base in
 * {light,dark}, and a palette carrying an IDENTICAL set of keys so a client can
 * render any theme uniformly. Every assertion is mutation-sensitive: removing a
 * named theme, unfreezing the catalog/entries/palettes, dropping a palette key,
 * or accepting an out-of-catalog value flips a test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Theme,
  THEME_CATALOG,
  isValidTheme,
  DEFAULT_THEME_BY_EXPERIENCE,
  DEFAULT_THEME,
  defaultThemeFor,
  themeCatalogEntry,
  Workspace_Experience,
} from '../src/model/enums.js';

// The six named color themes from Req 29's Definitions, PLUS the base modes.
const NAMED_THEMES = [
  'pastel-pasture',
  'out-there',
  'paranormal-purple',
  'morning-dew',
  'summer-sunset',
  'peach-popsicle',
];

// The palette keys every catalog entry MUST carry, identically.
const PALETTE_KEYS = [
  'background',
  'surface',
  'accent',
  'button',
  'badge',
  'statusInfo',
  'statusSuccess',
  'statusWarning',
  'statusError',
];

test('the catalog offers AT LEAST light, dark, and the six named color themes', () => {
  // Mutation-sensitive: removing a named theme (or a base) flips this.
  assert.ok(isValidTheme('light'), 'light is offered');
  assert.ok(isValidTheme('dark'), 'dark is offered');
  for (const id of NAMED_THEMES) {
    assert.ok(Theme.includes(id), `named theme ${id} is offered`);
    assert.ok(THEME_CATALOG[id], `named theme ${id} has a catalog entry`);
  }
  // Exactly the eight ids, and the enum is frozen (closed at runtime).
  assert.equal(Theme.length, 8);
  assert.ok(Object.isFrozen(Theme), 'Theme id list is frozen');
  assert.throws(() => {
    Theme.push('teal');
  });
  assert.equal(Theme.length, 8, 'still exactly eight after a rejected push');
});

test('every Theme id has a catalog entry with a non-empty displayName, a base in {light,dark}, and a full palette', () => {
  // Every id in the enum resolves to an entry — the catalog can never drift
  // from the id list.
  for (const id of Theme) {
    const entry = THEME_CATALOG[id];
    assert.ok(entry && typeof entry === 'object', `${id} has a catalog entry`);
    assert.equal(entry.id, id, `${id} entry.id matches its key`);

    assert.equal(typeof entry.displayName, 'string');
    assert.ok(entry.displayName.length > 0, `${id} has a non-empty displayName`);

    assert.ok(entry.base === 'light' || entry.base === 'dark', `${id} base is light|dark`);

    // The palette carries EXACTLY the identical key set for every theme.
    assert.ok(entry.palette && typeof entry.palette === 'object', `${id} has a palette`);
    assert.deepStrictEqual(
      Object.keys(entry.palette).sort(),
      [...PALETTE_KEYS].sort(),
      `${id} palette carries the identical key set`,
    );
    for (const key of PALETTE_KEYS) {
      const value = entry.palette[key];
      assert.equal(typeof value, 'string', `${id}.${key} is a string`);
      assert.ok(value.length > 0, `${id}.${key} is a non-empty color value`);
    }
  }
  // The catalog has an entry for EVERY id and no extras.
  assert.deepStrictEqual(Object.keys(THEME_CATALOG).sort(), [...Theme].sort());
  // themeCatalogEntry mirrors the map for a known id and returns null otherwise.
  assert.equal(themeCatalogEntry('light'), THEME_CATALOG.light);
  assert.equal(themeCatalogEntry('teal'), null);
});

test('the catalog, its entries, and their palettes are frozen', () => {
  assert.ok(Object.isFrozen(THEME_CATALOG), 'catalog map is frozen');
  for (const id of Theme) {
    const entry = THEME_CATALOG[id];
    assert.ok(Object.isFrozen(entry), `${id} entry is frozen`);
    assert.ok(Object.isFrozen(entry.palette), `${id} palette is frozen`);
    // Mutation-sensitive: a frozen palette rejects a write in strict mode.
    assert.throws(() => {
      entry.palette.background = '#000000';
    });
  }
  // A frozen catalog cannot gain a new theme at runtime.
  assert.throws(() => {
    THEME_CATALOG.teal = {};
  });
});

test('isValidTheme accepts every catalog id and rejects out-of-catalog values', () => {
  for (const id of Theme) {
    assert.equal(isValidTheme(id), true, `${id} must be valid`);
  }
  // Out-of-catalog values are rejected — a bad value never becomes a theme.
  const rejected = ['', 'teal', 'LIGHT', 'Dark', 'summer_sunset', ' light', 'themes'];
  for (const value of rejected) {
    assert.equal(isValidTheme(value), false, `${JSON.stringify(value)} must be rejected`);
  }
  // Non-string types are rejected too.
  for (const value of [null, undefined, {}, [], 123, true]) {
    assert.equal(isValidTheme(value), false, `${JSON.stringify(value)} must be rejected`);
  }
});

test('DEFAULT_THEME_BY_EXPERIENCE covers all five Workspace_Experience values with valid ids', () => {
  // Every experience has a default and it is a real catalog id.
  for (const experience of Workspace_Experience) {
    const id = DEFAULT_THEME_BY_EXPERIENCE[experience];
    assert.ok(id !== undefined, `${experience} has a default theme`);
    assert.equal(isValidTheme(id), true, `${experience} default ${id} is a valid theme`);
  }
  // Exactly the five experiences are keyed — no drift.
  assert.deepStrictEqual(
    Object.keys(DEFAULT_THEME_BY_EXPERIENCE).sort(),
    [...Workspace_Experience].sort(),
  );
  assert.ok(Object.isFrozen(DEFAULT_THEME_BY_EXPERIENCE), 'default map is frozen');
});

test('defaultThemeFor returns each experience default plus a documented fallback for unknown input', () => {
  for (const experience of Workspace_Experience) {
    assert.equal(
      defaultThemeFor(experience),
      DEFAULT_THEME_BY_EXPERIENCE[experience],
      `${experience} default resolved`,
    );
  }
  // The documented global fallback for an unknown experience (Req 29.3).
  assert.equal(isValidTheme(DEFAULT_THEME), true, 'the global fallback is a valid theme');
  assert.equal(DEFAULT_THEME, 'light');
  for (const unknown of ['bogus', '', undefined, null, {}]) {
    assert.equal(defaultThemeFor(unknown), DEFAULT_THEME, `unknown ${JSON.stringify(unknown)} falls back`);
  }
});
