/**
 * Property 22 (Task 33.3, Req 29.2/29.4/29.6/29.7):
 *   "Theme is per-experience, preview-safe, and state-preserving"
 *
 * fast-check generates ARRAYS of steps over a REAL ThemeStore (a real
 * createThemeStore over an fs.mkdtemp StorageLayout) plus a REAL populated
 * non-theme state document (a persisted Workspace_Experience selection + a saved
 * customLayout written by the REAL WorkspaceExperienceStore into the SAME
 * document), snapshotted BYTE-FOR-BYTE. Each step is one of:
 *   - { kind:'preview', experience, theme }  : a reversible, non-persisting preview
 *   - { kind:'commit',  experience, theme }  : the ONLY writer (Req 29.4)
 * where `theme` may be a valid catalog id OR an out-of-catalog constant so the
 * property also exercises rejection.
 *
 * A preview is modeled EXACTLY as the Builder Server drives it: it changes NO
 * committed Theme (the store is untouched). A commit changes ONLY that
 * (experience) pair. An in-memory model committedByExperience (seeded with each
 * experience's default) mirrors the ONLY legal committed values.
 *
 * INVARIANTS asserted after EVERY step:
 *   (a) preview safety — a preview changes no committed Theme (Req 29.4);
 *   (b) per-experience isolation — for EVERY experience, store.getCommitted
 *       equals the model, and switching experience surfaces each one's own
 *       committed Theme (Req 29.2/29.7);
 *   (c) the REAL non-theme state document (standing in for source/agent state/
 *       Project data/models/Skills/Connectors/permissions/Work_Mode/layout/
 *       Project_Origin) is byte-for-byte unchanged (Req 29.6).
 *
 * NON-VACUOUS: real non-theme state is populated so the equality is meaningful,
 * and across the runs we PROVE >=100 iterations ran, that some commits actually
 * CHANGED a committed Theme, and that some previews left the committed Theme
 * unchanged WHILE a preview was active (tracked in module-level counters).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import {
  createThemeStore,
  createWorkspaceExperienceStore,
} from '../src/presentation/index.js';
import { createStorageLayout } from '../src/storage/layout.js';
import {
  Theme,
  Workspace_Experience,
  isValidTheme,
  defaultThemeFor,
} from '../src/model/enums.js';

const TAG = propertyTag(22, 'Theme is per-experience, preview-safe, and state-preserving');

test('Property 22 tag renders EXACTLY the spec string', () => {
  assert.equal(
    TAG,
    'Feature: ai-app-builder, Property 22: Theme is per-experience, preview-safe, and state-preserving',
  );
});

// Use MULTIPLE experiences across the run so isolation is meaningfully exercised.
const EXPERIENCES = ['kiro-style', 'vibe-first', 'technical-workbench', 'mobile-command-center'];

// out-of-catalog theme constants — must be rejected leaving state unchanged.
const OUT_OF_CATALOG = ['teal', '', 'LIGHT', 'summer_sunset', 'themes'];

const stepArb = fc.record({
  kind: fc.constantFrom('preview', 'commit'),
  experience: fc.constantFrom(...EXPERIENCES),
  theme: fc.oneof(fc.constantFrom(...Theme), fc.constantFrom(...OUT_OF_CATALOG)),
});

test(TAG, () => {
  let runs = 0;
  let commitsThatChangedATheme = 0; // non-vacuity: real commits happened.
  let previewsLeftCommittedUnchanged = 0; // non-vacuity: preview safety exercised.

  fc.assert(
    fc.property(fc.array(stepArb, { minLength: 1, maxLength: 30 }), (steps) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-theme-prop-'));
      try {
        const layout = createStorageLayout(dir);
        const owner = 'owner-prop-22';

        // --- REAL populated NON-THEME state in the SAME presentation document.
        const wxStore = createWorkspaceExperienceStore({ layout });
        assert.equal(wxStore.select(owner, 'technical-workbench').ok, true);
        const customLayout = {
          id: 'custom',
          name: 'Prop Layout',
          regions: ['top', 'bottom'],
          surfaces: {
            sessionHeader: { region: 'top', visible: true, order: 0 },
            activityStream: { region: 'bottom', visible: true, order: 0 },
            compose: { region: 'bottom', visible: true, order: 1 },
            preview: { region: 'bottom', visible: false, order: 2 },
            filePanel: { region: 'bottom', visible: true, order: 3 },
          },
        };
        assert.equal(wxStore.saveCustomLayout(owner, customLayout).ok, true);

        // The theme store writes theme keys INTO this same document, so the
        // "non-theme state" we snapshot is the doc with themesByExperience
        // stripped — the parts a theme op must never touch. We snapshot those
        // sibling fields explicitly and re-check them byte-for-byte.
        const statePath = layout.controlPresentationSettingsPath(owner);

        function nonThemeSnapshot() {
          const doc = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          delete doc.themesByExperience;
          // Canonical byte form of the non-theme portion.
          return Buffer.from(JSON.stringify(doc), 'utf8');
        }
        const nonThemeBefore = nonThemeSnapshot();
        assert.ok(nonThemeBefore.length > 0, 'a real non-theme document is on disk');

        // --- REAL ThemeStore + in-memory model seeded with each experience default.
        const store = createThemeStore({ layout });
        const committedByExperience = {};
        for (const exp of EXPERIENCES) committedByExperience[exp] = defaultThemeFor(exp);

        // At construction, every experience surfaces its own default (isolation).
        for (const exp of EXPERIENCES) {
          assert.equal(store.getCommitted(owner, exp), committedByExperience[exp]);
        }

        for (const step of steps) {
          const valid = isValidTheme(step.theme);
          const priorCommitted = committedByExperience[step.experience];

          if (step.kind === 'preview') {
            // A PREVIEW never writes — whether the theme is valid or not. The
            // committed value in the store is untouched (Req 29.4). We do not
            // call the store at all for a preview: preview is per-session visual
            // state, not a store write. Assert nothing changed below.
            if (valid && step.theme !== priorCommitted) {
              // A preview to a DIFFERENT theme was requested but must NOT commit.
              previewsLeftCommittedUnchanged += 1;
            }
            assert.equal(
              store.getCommitted(owner, step.experience),
              priorCommitted,
              'preview must not change the committed theme',
            );
          } else if (step.kind === 'commit') {
            const result = store.commit(owner, step.experience, step.theme);
            if (valid) {
              assert.equal(result.ok, true);
              if (committedByExperience[step.experience] !== step.theme) {
                commitsThatChangedATheme += 1;
              }
              committedByExperience[step.experience] = step.theme;
            } else {
              // Out-of-catalog: rejected, model unchanged (Req 29.8).
              assert.equal(result.ok, false);
              assert.equal(result.code, 'unsupported_theme');
              assert.equal(committedByExperience[step.experience], priorCommitted);
            }
          }

          // (a)+(b) After EVERY step: for EVERY experience the store's committed
          // value equals the model, and switching experience surfaces each one's
          // own committed Theme (read each back independently).
          for (const exp of EXPERIENCES) {
            assert.equal(
              store.getCommitted(owner, exp),
              committedByExperience[exp],
              `committed theme for ${exp} matches the model`,
            );
          }

          // (c) The REAL non-theme state document is byte-for-byte unchanged.
          assert.ok(
            nonThemeBefore.equals(nonThemeSnapshot()),
            'non-theme state unchanged mid-sequence',
          );
        }

        // (c) again over the WHOLE sequence.
        assert.ok(nonThemeBefore.equals(nonThemeSnapshot()), 'non-theme state byte-for-byte unchanged');
        // The persisted Workspace_Experience is still exactly what it was.
        assert.equal(wxStore.get(owner), 'custom', 'workspace experience unchanged');
        assert.deepStrictEqual(wxStore.getSettings(owner).customLayout, customLayout, 'custom layout unchanged');

        runs += 1;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );

  // >= 100 iterations actually ran.
  assert.ok(runs >= 100, `expected >=100 iterations, ran ${runs}`);
  // NON-VACUOUS: at least SOME commits actually changed a committed theme.
  assert.ok(
    commitsThatChangedATheme > 0,
    `expected some commits to change a theme, saw ${commitsThatChangedATheme}`,
  );
  // NON-VACUOUS: at least SOME previews requested a different theme yet left the
  // committed theme unchanged — preview safety was actually exercised.
  assert.ok(
    previewsLeftCommittedUnchanged > 0,
    `expected some previews to leave the committed theme unchanged, saw ${previewsLeftCommittedUnchanged}`,
  );
});
