/**
 * Property-based test for Web UI Task 11.3 (node --test).
 *
 * Property 27 — "Theme preview is non-committing and cancel is a round-trip to
 * committed" (design §"Property 27", Req 9.3, 9.4, 9.5). Exact spec tag:
 *
 *   "Feature: web-ui, Property 27: Theme preview is non-committing and cancel is
 *    a round-trip to committed"
 *
 * WHAT IS PROVEN, end-to-end through the REAL collaborators (the REAL store
 * reducer, the REAL createApiClient over a scripted fetch that returns the real
 * THEME_CATALOG palettes, the REAL theme controller, and a RECORDING style
 * target — no over-mocking):
 *
 *   For any committed theme C and any previewed theme T:
 *     - previewing T applies T's palette to the SURFACE while leaving the
 *       last-committed theme + palette equal to C (Req 9.3, non-committing);
 *     - committing T applies T's palette and records T as the last committed
 *       theme (Req 9.4);
 *     - cancelling a preview restores the surface EXACTLY to C's palette —
 *       preview-then-cancel is the identity on the committed palette (Req 9.5).
 *
 * The surface is asserted via the recording style target's current --color-*
 * values (the same interface as document.documentElement.style), so the SURFACE
 * (not just the store) is proven to round-trip.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, ACTIONS, PALETTE_KEYS } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createThemeController, cssVarName } from '../src/server/public/theme.js';
import { THEME_CATALOG, Theme } from '../src/model/enums.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** A recording style target: mirrors CSSOM `element.style.setProperty`. */
function recordingTarget() {
  const props = new Map();
  return {
    setProperty(name, value) { props.set(name, value); },
    snapshot() { return new Map(props); },
    get(name) { return props.get(name); },
  };
}

/** Assert the surface currently shows the given catalog theme's palette. */
function assertSurfaceIs(target, themeId, label) {
  const palette = THEME_CATALOG[themeId].palette;
  for (const key of PALETTE_KEYS) {
    assert.equal(target.get(cssVarName(key)), palette[key], `${label}: --color-${key} == ${themeId}`);
  }
}

/**
 * A scripted fetch for /theme that returns a themeFrame whose palette is the
 * REAL catalog palette for the requested theme + the requested action's
 * `previewed` flag. Mirrors the backend handleTheme response shape.
 */
function themeFetch(experience) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    const theme = body.theme;
    return {
      status: 200,
      async json() {
        return {
          type: 'theme',
          theme,
          palette: THEME_CATALOG[theme].palette,
          previewed: body.action === 'preview',
          workspaceExperience: experience,
        };
      },
    };
  };
  return { fetchImpl, calls };
}

const themeId = fc.constantFrom(...Theme);

// ------------------------------------------------------ Property 27 (Task 11.3)

test(
  webUiTag(27, 'Theme preview is non-committing and cancel is a round-trip to committed'),
  async () => {
    await fc.assert(
      fc.asyncProperty(themeId, themeId, async (committed, previewed) => {
        const store = createStore();
        // Fix a current experience so the controller sends it (and the theme is
        // per (account, experience)).
        store.dispatch({ type: ACTIONS.WORKSPACE_EXPERIENCE_SET, experience: 'kiro-style', layout: {} });

        const target = recordingTarget();
        const { fetchImpl } = themeFetch('kiro-style');
        const api = createApiClient({ getToken: () => 'tok', fetchImpl });
        const theme = createThemeController({ store, api, styleTarget: target, getExperience: () => 'kiro-style' });

        // Establish the committed baseline C by committing it.
        await theme.commit(committed);
        assert.equal(store.getState().theme.committedTheme, committed, 'C committed');
        assertSurfaceIs(target, committed, 'after commit(C)');
        const committedSnapshot = target.snapshot();

        // Preview T (non-committing): the SURFACE shows T, but committed stays C.
        await theme.preview(previewed);
        assertSurfaceIs(target, previewed, 'after preview(T)');
        assert.equal(store.getState().theme.committedTheme, committed, 'committed still C after preview (Req 9.3)');
        assert.equal(store.getState().theme.previewedTheme, previewed, 'previewed is T');

        // Cancel: preview-then-cancel is the IDENTITY on the committed palette —
        // the surface reverts EXACTLY to C (Req 9.5).
        theme.cancel();
        assertSurfaceIs(target, committed, 'after cancel reverts to C');
        assert.equal(store.getState().theme.previewedTheme, null, 'preview cleared on cancel');
        assert.equal(store.getState().theme.committedTheme, committed, 'committed still C after cancel');
        // The surface equals the exact committed snapshot from before the preview.
        for (const key of PALETTE_KEYS) {
          assert.equal(target.get(cssVarName(key)), committedSnapshot.get(cssVarName(key)), `round-trip --color-${key}`);
        }

        // Commit T: now committed becomes T and the surface shows T (Req 9.4).
        await theme.commit(previewed);
        assert.equal(store.getState().theme.committedTheme, previewed, 'committed is now T after commit(T)');
        assert.equal(store.getState().theme.previewedTheme, null, 'preview cleared on commit');
        assertSurfaceIs(target, previewed, 'after commit(T)');
        return true;
      }),
      fcConfig,
    );
  },
);

// -------------------------------------------- Mutation / test-quality guard

test('Property 27 guard: preview does NOT change committed, and commit DOES', async () => {
  const store = createStore();
  const target = recordingTarget();
  const { fetchImpl } = themeFetch('kiro-style');
  const api = createApiClient({ getToken: () => 'tok', fetchImpl });
  const theme = createThemeController({ store, api, styleTarget: target, getExperience: () => 'kiro-style' });

  await theme.commit('light');
  await theme.preview('dark');
  assert.equal(store.getState().theme.committedTheme, 'light', 'preview left committed at light');
  await theme.commit('dark');
  assert.equal(store.getState().theme.committedTheme, 'dark', 'commit moved committed to dark');
});
