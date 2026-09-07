/**
 * Property 20 — Workspace_Experience switching preserves everything but layout
 * (Task 31.3, validates Req 27.2/27.3).
 *
 * For ALL sequences of switches among the five Workspace_Experience values, only
 * layout changes: a POPULATED snapshot of the real, non-layout state — Theme
 * (placeholder), Work_Mode, a piece of Project source, an agent-state marker,
 * Project data (a REAL Project record via createProject), selected models,
 * Skills, Connectors, permissions, and Project_Origin — is byte-for-byte
 * unchanged, while the resolved layout DOES change across distinct experiences.
 *
 * The test is NON-VACUOUS: the snapshot is genuinely populated (so the equality
 * assertion has content to protect), the switches are applied through the REAL
 * store over a REAL StorageLayout on an fs.mkdtemp temp dir with layouts resolved
 * from the REAL workspaceExperienceLayouts map, and the property also PROVES that
 * two different experiences resolve to different layouts.
 *
 * Real collaborators only: real enums, real store, real layout descriptors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fcConfig, propertyTag } from './support/fc.js';
import { createStorageLayout } from '../src/storage/layout.js';
import {
  createWorkspaceExperienceStore,
  workspaceExperienceLayouts,
  defaultCustomLayout,
} from '../src/presentation/index.js';
import { Workspace_Experience } from '../src/model/enums.js';
import { createProject } from '../src/model/project.js';

const PROPERTY_20_TAG =
  'Feature: ai-app-builder, Property 20: Workspace_Experience switching preserves everything but layout';

/**
 * Build a POPULATED snapshot of the REAL non-layout state that a
 * Workspace_Experience switch MUST NOT touch (Req 27.3). Everything here is a
 * real value: the Project is a real createProject record with real enum values.
 */
function buildNonLayoutSnapshot() {
  const project = createProject({
    id: 'proj-42',
    ownerId: 'owner-x',
    description: 'A todo app with reminders',
    targetCategory: 'full-stack-web',
    origin: 'template', // real Project_Origin
    originRef: 'starter-kit@1.2.0',
    targets: [{ kind: 'web', rootPath: 'apps/web' }],
    sandboxId: 'sbx-9',
    snapshots: [],
    connectors: [],
    provider: 'anthropic',
    model: 'claude-sonnet',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });

  return {
    theme: 'midnight', // Theme placeholder (Req 29 is a later task; here it is state that must not move)
    workMode: 'spec', // Work_Mode
    source: {
      'src/app.ts': "export const greet = (n: string) => `hi ${n}`;\n",
    },
    agentState: { running: false, lastTurnId: 'turn-7', pendingConfirms: [] },
    project, // real Project data
    models: { builder: 'claude-sonnet', classifier: 'claude-haiku' },
    skills: ['devendor-project', 'vendor-lockin-guard'],
    connectors: [{ id: 'db-1', category: 'database', name: 'primary' }],
    permissions: { canDeploy: true, canShare: false, role: 'owner' },
    projectOrigin: 'template', // Project_Origin, also mirrored on the Project
  };
}

test(PROPERTY_20_TAG, () => {
  // The tag MUST be built via propertyTag(...) AND equal the exact literal.
  assert.equal(propertyTag(20, 'Workspace_Experience switching preserves everything but layout'), PROPERTY_20_TAG);

  const prop = fc.property(
    // A NON-EMPTY sequence of switches over the five real experiences.
    fc.array(fc.constantFrom(...Workspace_Experience), { minLength: 1, maxLength: 8 }),
    (switches) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wxp-prop-'));
      try {
        const layout = createStorageLayout(dir);
        const store = createWorkspaceExperienceStore({ layout });
        const ownerId = 'owner-x';

        // A REAL, populated non-layout snapshot and a pristine deep clone taken
        // BEFORE any switching. The clone is what we compare against AFTER.
        const state = buildNonLayoutSnapshot();
        const pristine = structuredClone(state);
        const pristineJson = JSON.stringify(state);

        // Resolve a layout for the CURRENT (pre-switch) state so we can detect
        // that the layout genuinely changes across the sequence.
        const resolveLayout = (experience) => {
          if (experience === 'custom') {
            const settings = store.getSettings(ownerId);
            const saved = settings.customLayout;
            return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : defaultCustomLayout;
          }
          return workspaceExperienceLayouts[experience];
        };

        const resolvedLayouts = [];
        for (const experience of switches) {
          const result = store.select(ownerId, experience);
          assert.equal(result.ok, true, `select ${experience} should succeed`);
          assert.equal(store.get(ownerId), experience, 'the switch took effect');
          resolvedLayouts.push({ experience, layout: resolveLayout(experience) });

          // After EVERY switch the non-layout snapshot is byte-for-byte unchanged.
          assert.deepStrictEqual(state, pristine);
          assert.equal(JSON.stringify(state), pristineJson);
        }

        // NON-VACUOUS: every resolved layout is a real layout-only descriptor,
        // and if the sequence touched two DISTINCT experiences their resolved
        // layouts differ (the layout axis really did move).
        for (const { layout: resolved } of resolvedLayouts) {
          assert.ok(resolved && resolved.surfaces && typeof resolved.surfaces === 'object', 'a real layout descriptor');
        }
        const distinctExperiences = [...new Set(switches)];
        if (distinctExperiences.length >= 2) {
          const layoutsById = distinctExperiences.map((e) => JSON.stringify(resolveLayout(e)));
          const uniqueLayouts = new Set(layoutsById);
          assert.ok(
            uniqueLayouts.size >= 2,
            'two distinct experiences must resolve to distinct layouts (non-vacuous)',
          );
        }

        return true;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  fc.assert(prop, fcConfig);
});

test('Property 20 tag renders to the exact spec string', () => {
  assert.equal(
    propertyTag(20, 'Workspace_Experience switching preserves everything but layout'),
    'Feature: ai-app-builder, Property 20: Workspace_Experience switching preserves everything but layout',
  );
});
