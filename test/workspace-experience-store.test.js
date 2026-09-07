/**
 * WorkspaceExperienceStore tests (Task 31.4, Req 27.1/27.4/27.5/27.6/27.7).
 *
 * Everything here exercises the REAL store over a REAL StorageLayout on a real
 * fs.mkdtemp temp directory — no mocks, no fakes. It proves: all five names are
 * selectable and resolve to layout-only descriptors; `custom` arrange+persist
 * per user; a persisted selection is re-applied to a LATER Session (a NEW store
 * instance over the same layout); the documented default is applied when unset
 * and NOTHING is written on a default read; an out-of-enum value is rejected
 * with the current experience left in effect and no write; and per-owner
 * isolation. The important cases are mutation-sensitive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageLayout } from '../src/storage/layout.js';
import {
  createWorkspaceExperienceStore,
  workspaceExperienceLayouts,
  defaultCustomLayout,
} from '../src/presentation/index.js';
import { Workspace_Experience, DEFAULT_WORKSPACE_EXPERIENCE } from '../src/model/enums.js';

// Keys that a LAYOUT-ONLY descriptor must NEVER carry (Req 27.2/27.3, Property 20).
const FORBIDDEN_LAYOUT_KEYS = [
  'theme',
  'work_mode',
  'workMode',
  'models',
  'model',
  'skills',
  'connectors',
  'permissions',
  'project',
  'projectData',
  'origin',
  'agentState',
  'source',
];

function mkLayout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wxp-store-'));
  const layout = createStorageLayout(dir);
  return { dir, layout, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function assertLayoutOnly(descriptor) {
  assert.ok(descriptor && typeof descriptor === 'object', 'descriptor is an object');
  for (const key of FORBIDDEN_LAYOUT_KEYS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(descriptor, key),
      `layout descriptor must NOT carry a non-layout key: ${key}`,
    );
  }
  // A real layout descriptor positions surfaces — prove it is non-empty layout data.
  assert.ok(descriptor.surfaces && typeof descriptor.surfaces === 'object', 'descriptor carries surfaces');
}

test('(a) all five names are selectable and each resolves to a layout-only descriptor', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createWorkspaceExperienceStore({ layout });
    for (const experience of Workspace_Experience) {
      const result = store.select('owner-a', experience);
      assert.equal(result.ok, true, `${experience} must be selectable`);
      assert.equal(result.experience, experience);
      assert.equal(store.get('owner-a'), experience, `${experience} persisted and read back`);

      const descriptor = workspaceExperienceLayouts[experience];
      assertLayoutOnly(descriptor);
    }
    // Sanity: exactly the five enum values have a layout entry.
    assert.deepStrictEqual(
      Object.keys(workspaceExperienceLayouts).sort(),
      [...Workspace_Experience].sort(),
    );
  } finally {
    cleanup();
  }
});

test('(b) custom: saveCustomLayout persists per user and is returned when custom is selected/getSettings', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createWorkspaceExperienceStore({ layout });
    const arranged = {
      id: 'custom',
      name: 'My Layout',
      regions: ['top', 'bottom'],
      surfaces: {
        sessionHeader: { region: 'top', visible: true, order: 0 },
        activityStream: { region: 'bottom', visible: true, order: 0 },
        compose: { region: 'bottom', visible: true, order: 1 },
        preview: { region: 'bottom', visible: false, order: 2 },
        filePanel: { region: 'bottom', visible: true, order: 3 },
      },
    };
    const saved = store.saveCustomLayout('owner-c', arranged);
    assert.equal(saved.ok, true);
    assert.equal(saved.experience, 'custom');
    assert.deepStrictEqual(saved.customLayout, arranged);

    // Selecting custom for this user returns the SAVED arrangement, not the default.
    assert.equal(store.get('owner-c'), 'custom');
    const settings = store.getSettings('owner-c');
    assert.equal(settings.workspaceExperience, 'custom');
    assert.deepStrictEqual(settings.customLayout, arranged);
    // Mutation-sensitive: the persisted custom layout is NOT the built-in default.
    assert.notDeepStrictEqual(settings.customLayout, defaultCustomLayout);

    // A non-object layout is rejected without writing.
    const bad = store.saveCustomLayout('owner-c2', 'not-a-layout');
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'invalid_layout');
    assert.ok(!fs.existsSync(layout.controlPresentationSettingsPath('owner-c2')), 'no write on invalid layout');
  } finally {
    cleanup();
  }
});

test('(c) persistence: a selection is re-applied to a LATER Session via a NEW store instance (Req 27.5)', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const first = createWorkspaceExperienceStore({ layout });
    const sel = first.select('owner-p', 'technical-workbench');
    assert.equal(sel.ok, true);

    // A NEW store instance over the SAME layout/temp dir (a later Session) must
    // read the persisted value — nothing is held in memory.
    const later = createWorkspaceExperienceStore({ layout });
    assert.equal(later.get('owner-p'), 'technical-workbench');
    assert.equal(later.getSettings('owner-p').workspaceExperience, 'technical-workbench');
  } finally {
    cleanup();
  }
});

test('(d) default applied when unset — get() returns DEFAULT and writes NOTHING (Req 27.6)', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createWorkspaceExperienceStore({ layout });
    const file = layout.controlPresentationSettingsPath('fresh-owner');
    assert.ok(!fs.existsSync(file), 'no settings file before any read');

    assert.equal(store.get('fresh-owner'), DEFAULT_WORKSPACE_EXPERIENCE);
    assert.equal(store.getSettings('fresh-owner').workspaceExperience, DEFAULT_WORKSPACE_EXPERIENCE);

    // A default read must NOT create the file (Req 27.6): nothing persisted.
    assert.ok(!fs.existsSync(file), 'get() on a fresh owner writes nothing');
  } finally {
    cleanup();
  }
});

test('(e) out-of-enum rejected — no write, current experience left in effect (Req 27.7)', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createWorkspaceExperienceStore({ layout });
    // Establish a current selection first.
    assert.equal(store.select('owner-e', 'vibe-first').ok, true);
    const before = fs.readFileSync(layout.controlPresentationSettingsPath('owner-e'), 'utf8');

    const rejected = store.select('owner-e', 'bogus');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'unsupported_experience');

    // Current experience is UNCHANGED and the on-disk file is byte-for-byte identical.
    assert.equal(store.get('owner-e'), 'vibe-first');
    const after = fs.readFileSync(layout.controlPresentationSettingsPath('owner-e'), 'utf8');
    assert.equal(after, before, 'a rejected select must not rewrite the file');

    // A rejected select on a FRESH owner must not create a file at all.
    const rej2 = store.select('never-selected', 'ide');
    assert.equal(rej2.ok, false);
    assert.equal(rej2.code, 'unsupported_experience');
    assert.ok(!fs.existsSync(layout.controlPresentationSettingsPath('never-selected')), 'no write on rejection');
  } finally {
    cleanup();
  }
});

test('(f) per-owner isolation — owner A does not affect owner B', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createWorkspaceExperienceStore({ layout });
    assert.equal(store.select('owner-A', 'mobile-command-center').ok, true);

    // Owner B, untouched, still reads the documented default.
    assert.equal(store.get('owner-B'), DEFAULT_WORKSPACE_EXPERIENCE);

    // Now set B and confirm A is unchanged.
    assert.equal(store.select('owner-B', 'vibe-first').ok, true);
    assert.equal(store.get('owner-A'), 'mobile-command-center');
    assert.equal(store.get('owner-B'), 'vibe-first');

    // The two settings resolve to DIFFERENT files (structural isolation).
    assert.notEqual(
      layout.controlPresentationSettingsPath('owner-A'),
      layout.controlPresentationSettingsPath('owner-B'),
    );
  } finally {
    cleanup();
  }
});

test('forOwner handle mirrors the flat methods for one scoped account', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createWorkspaceExperienceStore({ layout });
    const handle = store.forOwner('scoped');
    assert.equal(handle.get(), DEFAULT_WORKSPACE_EXPERIENCE);
    assert.equal(handle.select('technical-workbench').ok, true);
    assert.equal(handle.get(), 'technical-workbench');
    assert.equal(store.get('scoped'), 'technical-workbench');
  } finally {
    cleanup();
  }
});
