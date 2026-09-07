/**
 * ThemeStore tests (Task 33.4, Req 29.2/29.3/29.4/29.5/29.7/29.8).
 *
 * Everything here exercises the REAL store over a REAL StorageLayout on a real
 * fs.mkdtemp temp directory — no mocks, no fakes. The committed Theme is PER
 * (User_Account, Workspace_Experience) and lives in the SAME Task-31
 * UserPresentationSettings document, so these cases prove: a default read for an
 * uncommitted experience writes NOTHING; a commit persists per pair and
 * re-applies to a LATER Session (a NEW store instance over the same layout);
 * committing one experience never changes another's; an out-of-catalog theme /
 * out-of-enum experience is rejected leaving the prior value in effect and
 * writing nothing; and a commit does NOT clobber the workspaceExperience /
 * customLayout / unknown fields written by the REAL WorkspaceExperienceStore
 * into the SAME document. The important cases are mutation-sensitive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageLayout } from '../src/storage/layout.js';
import {
  createThemeStore,
  createWorkspaceExperienceStore,
} from '../src/presentation/index.js';
import { defaultThemeFor } from '../src/model/enums.js';

function mkLayout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-theme-store-'));
  const layout = createStorageLayout(dir);
  return { dir, layout, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('(a) getCommitted for an uncommitted experience returns that experience default and writes NOTHING (Req 29.3)', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createThemeStore({ layout });
    const file = layout.controlPresentationSettingsPath('fresh-owner');
    assert.ok(!fs.existsSync(file), 'no settings file before any read');

    // Each experience surfaces its OWN documented default when nothing committed.
    assert.equal(store.getCommitted('fresh-owner', 'vibe-first'), defaultThemeFor('vibe-first'));
    assert.equal(store.getCommitted('fresh-owner', 'technical-workbench'), defaultThemeFor('technical-workbench'));
    assert.equal(store.getCommitted('fresh-owner', 'kiro-style'), defaultThemeFor('kiro-style'));

    // A default read must NOT create the file (Req 29.3): nothing persisted.
    assert.ok(!fs.existsSync(file), 'a default read writes nothing');
    assert.deepStrictEqual(store.getAllCommitted('fresh-owner'), {});
  } finally {
    cleanup();
  }
});

test('(b) commit persists per (owner, experience) and a NEW store instance over the same layout reads it back (Req 29.5)', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const first = createThemeStore({ layout });
    const committed = first.commit('owner-p', 'vibe-first', 'out-there');
    assert.equal(committed.ok, true);
    assert.equal(committed.experience, 'vibe-first');
    assert.equal(committed.theme, 'out-there');
    assert.ok(typeof committed.at === 'string' && committed.at.length > 0, 'commit stamps `at`');

    // A NEW store instance over the SAME layout (a later Session) reads it back —
    // nothing is held in memory.
    const later = createThemeStore({ layout });
    assert.equal(later.getCommitted('owner-p', 'vibe-first'), 'out-there');
    assert.deepStrictEqual(later.getAllCommitted('owner-p'), { 'vibe-first': 'out-there' });
  } finally {
    cleanup();
  }
});

test('(c) commit for experience A does not change experience B (per-experience isolation, Req 29.2/29.7)', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createThemeStore({ layout });
    assert.equal(store.commit('owner-c', 'vibe-first', 'out-there').ok, true);
    assert.equal(store.commit('owner-c', 'technical-workbench', 'paranormal-purple').ok, true);

    // Only the two committed experiences appear; each surfaces its own theme.
    assert.deepStrictEqual(store.getAllCommitted('owner-c'), {
      'vibe-first': 'out-there',
      'technical-workbench': 'paranormal-purple',
    });
    assert.equal(store.getCommitted('owner-c', 'vibe-first'), 'out-there');
    assert.equal(store.getCommitted('owner-c', 'technical-workbench'), 'paranormal-purple');

    // Re-committing A leaves B untouched (mutation-sensitive).
    assert.equal(store.commit('owner-c', 'vibe-first', 'morning-dew').ok, true);
    assert.equal(store.getCommitted('owner-c', 'vibe-first'), 'morning-dew');
    assert.equal(store.getCommitted('owner-c', 'technical-workbench'), 'paranormal-purple', 'B unchanged');

    // An uncommitted experience still surfaces its own default.
    assert.equal(store.getCommitted('owner-c', 'kiro-style'), defaultThemeFor('kiro-style'));
  } finally {
    cleanup();
  }
});

test('(d) an out-of-catalog theme is rejected, writes nothing, leaves the prior committed theme in effect (Req 29.8)', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createThemeStore({ layout });
    // Establish a prior committed theme.
    assert.equal(store.commit('owner-d', 'vibe-first', 'summer-sunset').ok, true);
    const file = layout.controlPresentationSettingsPath('owner-d');
    const before = fs.readFileSync(file); // Buffer snapshot.

    const rejected = store.commit('owner-d', 'vibe-first', 'teal');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'unsupported_theme');

    // Prior committed theme is UNCHANGED and the file is byte-for-byte identical.
    assert.equal(store.getCommitted('owner-d', 'vibe-first'), 'summer-sunset');
    assert.ok(before.equals(fs.readFileSync(file)), 'a rejected commit does not rewrite the file');

    // A rejected commit on a FRESH owner creates no file at all.
    const rej2 = store.commit('never-committed', 'vibe-first', '');
    assert.equal(rej2.ok, false);
    assert.equal(rej2.code, 'unsupported_theme');
    assert.ok(!fs.existsSync(layout.controlPresentationSettingsPath('never-committed')), 'no write on rejection');
  } finally {
    cleanup();
  }
});

test('(e) commit does NOT clobber a pre-existing workspaceExperience/customLayout written by the workspace-experience store', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const owner = 'owner-e';
    // Write real non-theme state into the SAME document via the REAL workspace store.
    const wxStore = createWorkspaceExperienceStore({ layout });
    assert.equal(wxStore.select(owner, 'technical-workbench').ok, true);
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
    assert.equal(wxStore.saveCustomLayout(owner, arranged).ok, true);
    // saveCustomLayout selects 'custom'; capture the sibling fields now on disk.
    const beforeDoc = JSON.parse(fs.readFileSync(layout.controlPresentationSettingsPath(owner), 'utf8'));
    assert.equal(beforeDoc.workspaceExperience, 'custom');
    assert.deepStrictEqual(beforeDoc.customLayout, arranged);

    // Now commit a Theme into the SAME document.
    const themeStore = createThemeStore({ layout });
    assert.equal(themeStore.commit(owner, 'technical-workbench', 'paranormal-purple').ok, true);

    // The sibling fields SURVIVE byte-equivalent, and the theme was added.
    const afterDoc = JSON.parse(fs.readFileSync(layout.controlPresentationSettingsPath(owner), 'utf8'));
    assert.equal(afterDoc.workspaceExperience, 'custom', 'workspaceExperience preserved');
    assert.deepStrictEqual(afterDoc.customLayout, arranged, 'customLayout preserved');
    assert.equal(afterDoc.themesByExperience['technical-workbench'], 'paranormal-purple', 'theme added');

    // And the REAL workspace store still reads its fields back afterward.
    assert.equal(wxStore.get(owner), 'custom');
    assert.deepStrictEqual(wxStore.getSettings(owner).customLayout, arranged);

    // Symmetric: a subsequent workspace-store write must not drop the theme.
    assert.equal(wxStore.select(owner, 'vibe-first').ok, true);
    assert.equal(themeStore.getCommitted(owner, 'technical-workbench'), 'paranormal-purple', 'theme survives a later wx write');
  } finally {
    cleanup();
  }
});

test('(f) an out-of-enum experience is rejected with code unsupported_experience and no write', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createThemeStore({ layout });
    const rejected = store.commit('owner-f', 'bogus-experience', 'light');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'unsupported_experience');
    assert.ok(!fs.existsSync(layout.controlPresentationSettingsPath('owner-f')), 'no write on rejection');
    assert.deepStrictEqual(store.getAllCommitted('owner-f'), {});
  } finally {
    cleanup();
  }
});

test('forOwner handle mirrors the flat methods for one scoped account', () => {
  const { layout, cleanup } = mkLayout();
  try {
    const store = createThemeStore({ layout });
    const handle = store.forOwner('scoped');
    assert.equal(handle.getCommitted('vibe-first'), defaultThemeFor('vibe-first'));
    assert.equal(handle.commit('vibe-first', 'out-there').ok, true);
    assert.equal(handle.getCommitted('vibe-first'), 'out-there');
    assert.equal(store.getCommitted('scoped', 'vibe-first'), 'out-there');
    assert.deepStrictEqual(handle.getAllCommitted(), { 'vibe-first': 'out-there' });
  } finally {
    cleanup();
  }
});
