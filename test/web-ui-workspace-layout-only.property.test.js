/**
 * Property-based test for Web UI Task 10.2 (node --test).
 *
 * Property 24 — "Applying a Workspace_Experience frame changes layout only"
 * (design §"Property 24", Req 8.3, 8.4). Exact spec tag:
 *
 *   "Feature: web-ui, Property 24: Applying a Workspace_Experience frame changes
 *    layout only"
 *
 * WHAT IS PROVEN, through the REAL store reducer + the REAL workspace controller
 * apply path (no over-mocking): applying ANY workspace_experience frame updates
 * ONLY the workspace slice (experience / layout / attribution) and leaves the
 * theme, work-mode, preview, and session-activity slices byte-for-byte
 * unchanged. The `attribution` credit is reflected iff it is a non-empty string
 * (Req 8.4). This is the LAYOUT-ONLY / non-mutation invariant (Req 8.3).
 *
 * The frame generator mirrors the backend's REAL workspace_experience frame
 * shape (src/server/builder-server.js workspaceExperienceFrame +
 * src/presentation/layouts.js): { type:'workspace_experience', experience,
 * layout, attribution? }. To make the test adversarial, the frame is also seeded
 * with STRAY sibling-slice fields (theme/palette/mode/preview/projectId) that a
 * careless applier might smuggle through — the property asserts NONE of them
 * reaches another slice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, ACTIONS } from '../src/server/public/store.js';
import { applyWorkspaceFrame, WORKSPACE_EXPERIENCES } from '../src/server/public/workspace.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ---------------------------------------------------------------- generators

const experience = fc.constantFrom(...WORKSPACE_EXPERIENCES);

/** A layout descriptor object (only its shape matters for the reducer). */
const layout = fc.record({
  id: fc.constantFrom(...WORKSPACE_EXPERIENCES),
  name: fc.string({ maxLength: 20 }),
  regions: fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
  surfaces: fc.constant({ activityStream: { region: 'main', visible: true, order: 0 } }),
});

/** attribution: sometimes absent, sometimes empty, sometimes a real string. */
const attribution = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 40 }),
);

/**
 * A workspace_experience frame, ADVERSARIALLY seeded with stray fields that
 * belong to OTHER slices — a correct applier must ignore them.
 */
const frame = fc
  .record({
    experience,
    layout,
    attribution,
    // stray fields that must NOT leak into other slices:
    theme: fc.string(),
    palette: fc.constant({ background: '#000000' }),
    mode: fc.constantFrom('vibe', 'spec', 'hybrid'),
    active: fc.constantFrom('vibe', 'spec', 'hybrid'),
    preview: fc.constant({ status: 'ready', url: 'http://evil' }),
    projectId: fc.string(),
  })
  .map((f) => {
    const out = { type: 'workspace_experience', experience: f.experience, layout: f.layout };
    if (f.attribution !== undefined) out.attribution = f.attribution;
    // splice in the stray fields
    out.theme = f.theme;
    out.palette = f.palette;
    out.mode = f.mode;
    out.active = f.active;
    out.preview = f.preview;
    out.projectId = f.projectId;
    return out;
  });

// ------------------------------------------------------ Property 24 (Task 10.2)

test(
  webUiTag(24, 'Applying a Workspace_Experience frame changes layout only'),
  async () => {
    await fc.assert(
      fc.asyncProperty(frame, async (f) => {
        // Start from a store with NON-default theme/work-mode/preview/session so
        // any accidental mutation would be visible.
        const store = createStore();
        store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-1' });
        store.dispatch({
          type: ACTIONS.THEME_COMMITTED,
          themeId: 'dark',
          palette: { background: '#0b0f19', surface: '#161b26', accent: '#60a5fa' },
        });
        store.dispatch({ type: ACTIONS.WORK_MODE_SET, active: 'spec', choices: ['vibe', 'spec', 'hybrid'] });
        store.dispatch({
          type: ACTIONS.PREVIEW_STATUS_SET,
          preview: { status: 'ready', url: '/live/', source: 'sse' },
        });

        const before = store.getState();
        const themeBefore = before.theme;
        const workModeBefore = before.workMode;
        const previewBefore = before.preview;
        const sessionBefore = before.session;

        // Apply the frame through the REAL controller apply path.
        applyWorkspaceFrame(store, f);

        const after = store.getState();

        // (Req 8.3) ONLY the workspace slice changed reference.
        assert.notStrictEqual(after.workspace, before.workspace, 'workspace slice updated');
        assert.strictEqual(after.theme, themeBefore, 'theme slice UNCHANGED (same reference)');
        assert.strictEqual(after.workMode, workModeBefore, 'work-mode slice UNCHANGED');
        assert.strictEqual(after.preview, previewBefore, 'preview slice UNCHANGED');
        assert.strictEqual(after.session, sessionBefore, 'session slice UNCHANGED');

        // The workspace slice holds exactly the frame's experience + layout.
        assert.equal(after.workspace.experience, f.experience, 'experience applied');
        assert.deepEqual(after.workspace.layout, f.layout, 'layout applied');

        // (Req 8.4) attribution reflected iff non-empty string.
        const expectAttr =
          typeof f.attribution === 'string' && f.attribution !== '' ? f.attribution : null;
        assert.equal(after.workspace.attribution, expectAttr, 'attribution shown iff non-empty');

        // No stray field leaked: theme/workMode/preview values are as before.
        assert.deepEqual(after.theme, themeBefore, 'theme values untouched');
        assert.deepEqual(after.workMode, workModeBefore, 'work-mode values untouched');
        assert.deepEqual(after.preview, previewBefore, 'preview values untouched');
        assert.equal(after.session.projectId, 'proj-1', 'session projectId untouched');
        return true;
      }),
      fcConfig,
    );
  },
);

// -------------------------------------------- Mutation / test-quality guard

test('Property 24 guard: a NON-layout dispatch (e.g. theme) would change the theme slice', () => {
  // Prove the "unchanged" assertions are not vacuous: a theme dispatch DOES
  // change the theme slice, so the property's strict-equality checks are real.
  const store = createStore();
  const before = store.getState().theme;
  store.dispatch({ type: ACTIONS.THEME_COMMITTED, themeId: 'light', palette: { background: '#fff' } });
  assert.notStrictEqual(store.getState().theme, before, 'a theme dispatch changes the theme slice');
});
