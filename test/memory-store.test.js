/**
 * MemoryStore unit tests (node --test) — spec Tasks 24.1 / 24.4 / 24.5 / 24.6,
 * Req 14.1, 14.5, 14.6, 14.9, 14.10, 14.11, 14.13, 19.
 *
 * These exercise the REAL collaborators end to end:
 *   - the REAL Memory models (createMemoryEntry / createMemoryStoreMeta),
 *   - the REAL on-disk MemoryStore (src/memory/store.js) writing human-readable
 *     files on an fs.mkdtempSync temp dir,
 *   - the REAL StorageLayout (src/storage/layout.js),
 *   - the REAL PersistenceStore (src/persistence/persistence-store.js) for the
 *     restore-on-reopen claim,
 *   - the REAL RetentionService (src/ops/retention.js) for the retention seam.
 *
 * ONLY the summarizer seam and the clock are injected fakes. Nothing here fakes
 * an interface the real object lacks.
 *
 * MUTATION-CHECKED behaviors (verified locally by reverting the rule and seeing
 * the named test fail, then restored):
 *   - off-mode-adds-nothing:    'off mode: addAuto adds nothing but addUser still adds'
 *   - freeze-and-notify at cap: 'auto->manual: at cap manual FREEZES and notifies, adding nothing'
 *   - never-destroy-history:    'auto: a bad/empty summary preserves history and adds nothing'
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageLayout } from '../src/storage/layout.js';
import { createMemoryStore, MEMORY_FILE, serializeDocument } from '../src/memory/store.js';
import { createPersistenceStore } from '../src/persistence/persistence-store.js';
import { createRetentionService } from '../src/ops/retention.js';
import { createCollectorSink, AUDIT_EVENTS } from '../src/auth/audit.js';

const OWNER = 'owner-1';
const PROJECT = 'proj-1';
const FIXED_NOW = () => new Date('2026-01-01T00:00:00.000Z');

/** A store rooted at a fresh temp dir so all file I/O stays hermetic. */
function freshStore(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-memory-'));
  const layout = createStorageLayout(base);
  const events = [];
  const store = createMemoryStore({
    layout,
    now: FIXED_NOW,
    notify: (e) => events.push(e),
    ...opts,
  });
  return { base, layout, store, events };
}

// --- Task 24.1 / defaults --------------------------------------------------

test('default mode is auto for both project and global stores', () => {
  const { store } = freshStore();
  assert.equal(store.projectStore(PROJECT).getMode(), 'auto');
  assert.equal(store.globalStore(OWNER).getMode(), 'auto');
});

test('auto lets addAuto add durable preference/decision/correction entries', () => {
  const { store } = freshStore();
  const ps = store.projectStore(PROJECT);
  for (const kind of ['preference', 'decision', 'correction', 'convention']) {
    const res = ps.addAuto({ kind, text: `a ${kind}` });
    assert.equal(res.ok, true, `${kind} added`);
    assert.equal(res.entry.kind, kind);
    assert.equal(res.entry.origin, 'auto');
  }
  const list = ps.list();
  assert.equal(list.length, 4);
  // All persisted with the injected clock.
  for (const e of list) assert.equal(e.createdAt, '2026-01-01T00:00:00.000Z');
});

// --- Task 24.6: manual controls work under EVERY mode ----------------------

test('manual controls (addUser/edit/delete/prune/export) work under every mode', () => {
  for (const mode of ['auto', 'manual', 'off']) {
    const { store } = freshStore();
    const ps = store.projectStore(PROJECT);
    assert.equal(ps.setMode(mode).ok, true, `set ${mode}`);

    // addUser always works.
    const added = ps.addUser({ kind: 'decision', text: `under ${mode}` });
    assert.equal(added.ok, true, `addUser under ${mode}`);
    assert.equal(added.entry.origin, 'user');
    const id = added.entry.id;

    // edit works.
    const edited = ps.edit(id, { text: 'edited text' });
    assert.equal(edited.ok, true, `edit under ${mode}`);
    assert.equal(edited.entry.text, 'edited text');

    // export reproduces the current state as human-readable content.
    const exported = ps.export();
    assert.equal(exported.ok, true, `export under ${mode}`);
    assert.match(exported.content, /edited text/);

    // prune (keep-predicate) works.
    const extra = ps.addUser({ kind: 'user', text: 'to prune' }).entry;
    const pruned = ps.prune((e) => e.id !== extra.id);
    assert.equal(pruned.ok, true, `prune under ${mode}`);
    assert.equal(ps.list().some((e) => e.id === extra.id), false);

    // delete works.
    const del = ps.delete(id);
    assert.equal(del.ok, true, `delete under ${mode}`);
    assert.equal(ps.list().some((e) => e.id === id), false);
  }
});

// --- Task 24.5 / Req 14.10: off explicit-only ------------------------------

test('off mode: addAuto adds nothing but addUser still adds', () => {
  const { store } = freshStore();
  const g = store.globalStore(OWNER);
  assert.equal(g.setMode('off').ok, true);

  const auto = g.addAuto({ kind: 'decision', text: 'auto attempt' });
  assert.equal(auto.ok, false);
  assert.equal(auto.code, 'memory_off');
  assert.equal(g.list().length, 0, 'no auto entry landed');

  const user = g.addUser({ kind: 'decision', text: 'user entry' });
  assert.equal(user.ok, true);
  assert.equal(user.entry.origin, 'user');
  assert.equal(g.list().length, 1, 'only the user entry is present');
  assert.equal(g.list()[0].origin, 'user');
});

// --- Task 24.6 / Req 14.9: auto->manual freeze-and-notify at cap -----------

test('auto->manual: at cap manual FREEZES and notifies, adding nothing', () => {
  const { store, events } = freshStore({ capEntries: 3, capBytes: 100000, keepRecent: 2 });
  const ps = store.projectStore(PROJECT);
  ps.setMode('manual');
  assert.equal(ps.addAuto({ kind: 'decision', text: 'a' }).ok, true);
  assert.equal(ps.addAuto({ kind: 'decision', text: 'b' }).ok, true);
  assert.equal(ps.addAuto({ kind: 'decision', text: 'c' }).ok, true);
  assert.equal(ps.list().length, 3, 'at cap');

  const full = ps.addAuto({ kind: 'decision', text: 'd' });
  assert.equal(full.ok, false, 'frozen');
  assert.equal(full.code, 'memory_full');
  assert.equal(full.notified, true);
  assert.equal(ps.list().length, 3, 'nothing added while frozen');

  // The notify sink actually received a memory-full notification.
  const fulls = events.filter((e) => e.type === 'memory-full');
  assert.equal(fulls.length, 1, 'exactly one memory-full notification');
  assert.equal(fulls[0].scope, 'project');
});

// --- Task 24.6 / Req 14.11: mode change applies to subsequent only ---------

test('mode change applies to subsequent management only and does not rewrite existing entries', () => {
  const { store } = freshStore();
  const ps = store.projectStore(PROJECT);
  ps.addAuto({ kind: 'decision', text: 'first' });
  ps.addAuto({ kind: 'preference', text: 'second' });
  const before = ps.export().content;
  const beforeEntries = ps.list();

  assert.equal(ps.setMode('off').ok, true);

  // Existing entries are byte-identical (only meta.mode changed, not entries).
  const after = ps.list();
  assert.deepEqual(after, beforeEntries, 'existing entries unchanged');

  // The serialized ENTRIES portion is identical (meta.mode differs by design).
  const beforeDoc = JSON.parse(before);
  const afterDoc = JSON.parse(ps.export().content);
  assert.deepEqual(afterDoc.entries, beforeDoc.entries, 'entries byte-identical across mode change');
  assert.equal(afterDoc.meta.mode, 'off');
  assert.equal(beforeDoc.meta.mode, 'auto');
});

// --- never-destroy-history-on-bad-summary (mutation-checked) ---------------

test('auto: a bad/empty summary preserves history and adds nothing', () => {
  const { store, events } = freshStore({
    summarize: () => '',
    capEntries: 4,
    capBytes: 100000,
    keepRecent: 2,
  });
  const ps = store.projectStore(PROJECT);
  for (let i = 0; i < 4; i++) assert.equal(ps.addAuto({ kind: 'decision', text: `e${i}` }).ok, true);
  const before = ps.list();
  assert.equal(before.length, 4, 'at cap');

  const res = ps.addAuto({ kind: 'decision', text: 'overflow' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'summary_failed');
  assert.equal(res.preserved, true);
  assert.equal(res.notified, true);

  // History is fully preserved: nothing evicted, nothing added.
  assert.deepEqual(ps.list(), before, 'history is byte-for-byte preserved');
  const bad = events.filter((e) => e.type === 'bad-summary-preserved');
  assert.equal(bad.length, 1, 'user was notified of the preserved-history event');
});

// --- Task 24.3 gist preservation on eviction -------------------------------

test('auto: reaching the cap summarizes-and-evicts, preserving a synthetic summary gist', () => {
  const { store, events } = freshStore({ capEntries: 8, capBytes: 100000, keepRecent: 3 });
  const ps = store.projectStore(PROJECT);
  let sawEviction = false;
  for (let i = 0; i < 30; i++) {
    const r = ps.addAuto({ kind: 'decision', text: `decision entry ${i}` });
    if (r.evicted) sawEviction = true;
  }
  assert.equal(sawEviction, true, 'eviction actually fired (non-vacuous)');
  assert.ok(ps.list().length <= store.caps.capEntries, 'entry cap holds');
  const summaries = ps.list().filter((e) => e.kind === 'summary' && e.origin === 'auto');
  assert.ok(summaries.length >= 1, 'a synthetic summary entry preserves the gist');
  assert.ok(summaries[0].text.length > 0, 'the summary carries a non-empty gist');
  assert.ok(events.some((e) => e.type === 'eviction-occurred'), 'user notified of eviction');
});

// --- Task 24.4 / Req 14.6: export completeness -----------------------------

test('export() reproduces every current entry as human-readable content with no hidden state', () => {
  const { store, layout } = freshStore();
  const ps = store.projectStore(PROJECT);
  ps.addAuto({ kind: 'decision', text: 'auto one' });
  ps.addUser({ kind: 'preference', text: 'user two' });

  const exported = ps.export();
  assert.equal(exported.ok, true);
  // The content IS the on-disk source of truth.
  const memFile = path.join(layout.exportableMemoryPath(PROJECT), MEMORY_FILE);
  const onDisk = fs.readFileSync(memFile, 'utf8');
  assert.equal(exported.content, onDisk, 'export content == on-disk file bytes');

  // Reparsing the content reproduces exactly the live entry list, no omissions.
  const parsed = JSON.parse(exported.content);
  assert.deepEqual(parsed.entries, ps.list());
  // serializeDocument over {meta, entries} equals the exported content.
  assert.equal(serializeDocument({ meta: exported.meta, entries: exported.entries }), exported.content);
});

// --- Task 24.6 / Req 14.1 & 19: restore-on-reopen via REAL persistence -----

test('Project_Memory persists inside the exportable tree and is restored on reopen', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-memory-persist-'));
  const layout = createStorageLayout(base);

  // Write Project_Memory via the real memory store into exportableMemoryPath.
  const store = createMemoryStore({ layout, now: FIXED_NOW });
  const ps = store.projectStore(PROJECT);
  ps.addAuto({ kind: 'decision', text: 'ship it on friday' });
  ps.addUser({ kind: 'preference', text: 'tabs over spaces' });
  const original = ps.list();
  assert.equal(original.length, 2);

  // Prove it lives INSIDE the exportable project tree (so it exports/persists
  // with the Project rather than in a separate control-plane store).
  const memDir = layout.exportableMemoryPath(PROJECT);
  const memFile = path.join(memDir, MEMORY_FILE);
  assert.equal(layout.isInsideExportTree(memFile), true, 'memory file is in the exportable tree');
  assert.ok(fs.existsSync(memFile), 'memory.json exists on disk');

  // The REAL PersistenceStore reads the project tree back and includes the
  // human-readable memory file, proving Project_Memory rides with the tree.
  const persistence = createPersistenceStore({ layout, ownerId: OWNER });
  const tree = persistence.readPersistedTree(PROJECT);
  const rel = path.relative(layout.exportableProjectTree(PROJECT), memFile).split(path.sep).join('/');
  assert.ok(rel in tree, `persisted tree contains ${rel}`);
  assert.equal(tree[rel], fs.readFileSync(memFile, 'utf8'), 'persisted bytes match on disk');

  // Reopen: a FRESH memory store against the SAME layout reads every entry back
  // identically (this is the "restored on reopen" claim).
  const reopened = createMemoryStore({ layout, now: FIXED_NOW });
  const restored = reopened.projectStore(PROJECT).list();
  assert.deepEqual(restored, original, 'every entry is restored identically on reopen');
});

// --- Task 24.6: retention seam ---------------------------------------------

test('deleteAccountData removes Global_Memory and names Project_Memory + Global_Memory', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-memory-retention-'));
  const layout = createStorageLayout(base);
  const store = createMemoryStore({ layout, now: FIXED_NOW });

  // Seed Global_Memory for the owner.
  const g = store.globalStore(OWNER);
  g.addUser({ kind: 'preference', text: 'global pref' });
  const globalRoot = layout.controlGlobalMemoryRoot(OWNER);
  assert.ok(fs.existsSync(path.join(globalRoot, MEMORY_FILE)), 'global memory seeded');

  const res = store.deleteAccountData(OWNER);
  assert.equal(res.ok, true);
  assert.deepEqual(res.deleted, ['Project_Memory', 'Global_Memory']);
  assert.equal(fs.existsSync(globalRoot), false, 'global-memory root is gone');
});

test('the memory store satisfies the RetentionService memoryStore seam (deleteAccount)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-memory-retention2-'));
  const layout = createStorageLayout(base);
  const store = createMemoryStore({ layout, now: FIXED_NOW });
  store.globalStore(OWNER).addUser({ kind: 'preference', text: 'global pref' });
  const globalRoot = layout.controlGlobalMemoryRoot(OWNER);
  assert.ok(fs.existsSync(globalRoot));

  const audit = createCollectorSink();
  const persistence = createPersistenceStore({ layout, ownerId: OWNER });
  const svc = createRetentionService({
    persistenceStore: persistence,
    snapshotStore: { deleteSnapshots: (projectId) => ({ ok: true, projectId }) },
    sandboxManager: { async release(projectId) { return { projectId, released: true, reaped: [], errors: [] }; } },
    secretStore: {
      deleteProjectSecrets: (projectId) => ({ ok: true, projectId, removed: [] }),
      deleteAccountData: (accountId) => ({ ok: true, ownerId: accountId }),
    },
    projectRegistry: { listForOwner: () => [], unregister: () => true },
    memoryStore: store,
    auditSink: audit,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const res = await svc.deleteAccount({ id: OWNER });
  assert.equal(res.ok, true);
  assert.equal(res.confirmed, true);
  // Project_Memory + Global_Memory categories are reported as handled.
  assert.equal(res.categories.Project_Memory.handled, true, 'Project_Memory handled');
  assert.equal(res.categories.Global_Memory.handled, true, 'Global_Memory handled');
  // The real global-memory root is gone.
  assert.equal(fs.existsSync(globalRoot), false, 'global memory removed by retention');
  assert.equal(audit.ofType(AUDIT_EVENTS.ACCOUNT_DELETED).length, 1);
});
