/**
 * Property-based test for Web UI Task 11.4 (node --test).
 *
 * Property 28 — "A failed theme change keeps the last committed palette applied"
 * (design §"Property 28", Req 9.6, 9.7). Exact spec tag:
 *
 *   "Feature: web-ui, Property 28: A failed theme change keeps the last
 *    committed palette applied"
 *
 * WHAT IS PROVEN, end-to-end through the REAL collaborators (the REAL store, the
 * REAL createApiClient over a scripted fetch, the REAL theme controller, and a
 * RECORDING style target — no over-mocking):
 *
 *   For ANY /theme failure — an HTTP 400 { code:'unsupported_theme' }, a
 *   timeout, or any other non-200 status — the SURFACE keeps the last committed
 *   theme's palette applied (the committed store slice is untouched) and the
 *   client shows the corresponding message (unsupported vs. could-not-complete)
 *   (Req 9.6, 9.7).
 *
 * The committed baseline is established with a real THEME_CATALOG palette, then
 * a preview or commit of a DIFFERENT theme is attempted against a failing
 * backend; the surface must still resolve to the committed palette.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, ACTIONS, PALETTE_KEYS } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createThemeController, cssVarName, THEME_MESSAGES } from '../src/server/public/theme.js';
import { THEME_CATALOG, Theme } from '../src/model/enums.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

function recordingTarget() {
  const props = new Map();
  return {
    setProperty(name, value) { props.set(name, value); },
    get(name) { return props.get(name); },
  };
}

/** A fetch whose first response commits the baseline, then FAILS every /theme. */
function scriptedFetch(failure, experience) {
  let committedYet = false;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    // The FIRST call is the baseline commit — succeed so we have a committed C.
    if (!committedYet && body.action === 'commit') {
      committedYet = true;
      return {
        status: 200,
        async json() {
          return { type: 'theme', theme: body.theme, palette: THEME_CATALOG[body.theme].palette, previewed: false, workspaceExperience: experience };
        },
      };
    }
    // Subsequent calls fail per the scripted failure mode.
    if (failure.kind === 'unsupported') {
      return {
        status: 400,
        async json() {
          return { error: 'unsupported Theme', code: 'unsupported_theme', current: { type: 'theme', theme: 'light', palette: THEME_CATALOG.light.palette, previewed: false, workspaceExperience: experience } };
        },
      };
    }
    if (failure.kind === 'timeout') {
      // Never resolve within the timeout → the api client aborts → { kind:'timeout' }.
      await new Promise((r) => setTimeout(r, 50));
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    // 'other' non-200:
    return { status: 500, async json() { return { error: 'boom' }; } };
  };
  return { fetchImpl };
}

const catalogTheme = fc.constantFrom(...Theme);
const failureMode = fc.constantFrom({ kind: 'unsupported' }, { kind: 'timeout' }, { kind: 'other' });
const action = fc.constantFrom('preview', 'commit');

// ------------------------------------------------------ Property 28 (Task 11.4)

test(
  webUiTag(28, 'A failed theme change keeps the last committed palette applied'),
  async () => {
    await fc.assert(
      fc.asyncProperty(catalogTheme, catalogTheme, failureMode, action, async (committed, attempt, failure, act) => {
        const store = createStore();
        store.dispatch({ type: ACTIONS.WORKSPACE_EXPERIENCE_SET, experience: 'kiro-style', layout: {} });

        const target = recordingTarget();
        const { fetchImpl } = scriptedFetch(failure, 'kiro-style');
        const api = createApiClient({ getToken: () => 'tok', fetchImpl });
        const theme = createThemeController({ store, api, styleTarget: target, getExperience: () => 'kiro-style' });

        // Establish committed baseline C (first call succeeds).
        await theme.commit(committed);
        const committedPalette = THEME_CATALOG[committed].palette;

        // Attempt a change that FAILS.
        const out = act === 'preview' ? await theme.preview(attempt) : await theme.commit(attempt);
        assert.equal(out.ok, false, 'a failed theme change is not ok');

        // The committed slice is UNTOUCHED — still C.
        assert.equal(store.getState().theme.committedTheme, committed, 'committed theme still C after failure');

        // The SURFACE keeps C's palette applied (Req 9.6/9.7).
        for (const key of PALETTE_KEYS) {
          assert.equal(target.get(cssVarName(key)), committedPalette[key], `surface --color-${key} stays committed C`);
        }

        // The corresponding message is shown.
        const notice = store.getState().session.notice;
        assert.ok(notice, 'a notice is shown on failure');
        if (failure.kind === 'unsupported') {
          assert.equal(notice.message, THEME_MESSAGES.UNSUPPORTED, 'unsupported message (Req 9.6)');
        } else {
          assert.equal(notice.message, THEME_MESSAGES.FAILED, 'could-not-complete message (Req 9.7)');
        }
        return true;
      }),
      fcConfig,
    );
  },
);

// -------------------------------------------- Mutation / test-quality guard

test('Property 28 guard: an unsupported failure shows the unsupported message, others the failed message', async () => {
  const store = createStore();
  store.dispatch({ type: ACTIONS.WORKSPACE_EXPERIENCE_SET, experience: 'kiro-style', layout: {} });
  const target = recordingTarget();
  const { fetchImpl } = scriptedFetch({ kind: 'unsupported' }, 'kiro-style');
  const api = createApiClient({ getToken: () => 'tok', fetchImpl });
  const theme = createThemeController({ store, api, styleTarget: target, getExperience: () => 'kiro-style' });
  await theme.commit('light');
  await theme.preview('dark');
  assert.equal(store.getState().session.notice.message, THEME_MESSAGES.UNSUPPORTED);
  assert.notEqual(THEME_MESSAGES.UNSUPPORTED, THEME_MESSAGES.FAILED, 'distinct messages');
});
