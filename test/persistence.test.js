/**
 * PersistenceStore + SnapshotStore tests (node --test).
 *
 * Covers spec subtasks 8.1, 8.2, and the 8.5* unit cases, Req 19.1-19.8:
 *
 *   PersistenceStore (8.1, Req 19.1, 19.2, 19.9):
 *     (a) persist(tree) then readPersistedTree round-trips the same tree, the
 *         persisted files live UNDER exportableProjectTree (isInsideExportTree
 *         === true) and the snapshot registry is OUTSIDE every export tree;
 *     (b) idle debounce: with an injected clock + scheduler, persist becomes
 *         durable within the 2s idle budget via flush() (NOT a real 2s sleep);
 *     (c) a persistence FAILURE (injected failing writeTree) retains the last
 *         good state unchanged and returns a structured persistence error.
 *
 *   SnapshotStore (8.2 + 8.5*, Req 19.3-19.8):
 *     (d) commitSnapshot returns a snapshotId that equals `git rev-parse HEAD`
 *         in the project's OWN repo (under the temp base, never the source repo);
 *     (e) TURN-PASS commits a snapshot but TURN-FAIL does not;
 *     (f) EXPLICIT commit records a snapshot with trigger 'explicit';
 *     (g) restore(snapshotId) returns the exact tree state at that snapshot and
 *         is idempotent (restore(restore(s)) == restore(s));
 *     (h) MISSING/UNREADABLE snapshot restore leaves the working tree UNCHANGED
 *         and returns a restore error;
 *     (i) resume with >=1 snapshot restores the most recent complete snapshot;
 *         resume with 0 snapshots restores the most recent persisted file state.
 *
 * All git operations run FOR REAL against per-project repos created in hermetic
 * fs.mkdtemp temp dirs, always removed in a finally. Commits pin an explicit
 * committer identity so they never depend on host git config.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { createStorageLayout } from '../src/storage/layout.js';
import {
  createPersistenceStore,
  createSnapshotStore,
  MAX_DEBOUNCE_MS,
  SNAPSHOT_IDENTITY,
} from '../src/persistence/index.js';

const OWNER = 'owner-1';
const PROJECT = 'proj-1';

/** A layout rooted at a fresh temp dir, so real file/git I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-persist-'));
  return { base, layout: createStorageLayout(base) };
}

/** Read HEAD sha of a real git repo directly (bypassing the store). */
function gitHead(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

// --- 8.1 PersistenceStore -------------------------------------------------

test('persist + readPersistedTree round-trips the tree UNDER the exportable tree', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createPersistenceStore({ layout, ownerId: OWNER });
    const tree = {
      'index.js': 'export const x = 1;\n',
      'src/app.js': 'console.log("hi");\n',
      'README.md': '# hello\n',
    };
    // debounce default is the 2s ceiling; force durability with flush().
    const scheduled = store.persist(PROJECT, tree);
    assert.equal(scheduled.ok, true);
    assert.equal(scheduled.scheduled, true);
    const flushed = store.flush(PROJECT);
    assert.equal(flushed.ok, true);
    assert.equal(flushed.durable, true);

    // Round-trips exactly.
    assert.deepEqual(store.readPersistedTree(PROJECT), tree);

    // The persisted files live UNDER the exportable project tree.
    const root = layout.exportableProjectTree(PROJECT);
    assert.equal(layout.isInsideExportTree(path.join(root, 'index.js')), true);
    assert.ok(fs.existsSync(path.join(root, 'src/app.js')));

    // The snapshot registry is OUTSIDE every export tree.
    const registry = layout.controlSnapshotRegistryPath(OWNER, PROJECT);
    assert.equal(layout.isInsideExportTree(registry), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('debounce ceiling is enforced and default is the 2s budget', () => {
  const { base, layout } = tempLayout();
  try {
    assert.equal(createPersistenceStore({ layout }).debounceMs, MAX_DEBOUNCE_MS);
    assert.throws(() => createPersistenceStore({ layout, debounceMs: 2001 }), /2000/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('idle debounce: durable within the 2s budget via injected clock + scheduler', () => {
  const { base, layout } = tempLayout();
  try {
    // Injected clock + manual scheduler: no real timers, no real sleeping.
    let clock = 0;
    const timers = [];
    const store = createPersistenceStore({
      layout,
      ownerId: OWNER,
      now: () => clock,
      debounceMs: 2000,
      setTimer: (fn, ms) => {
        const t = { fireAt: clock + ms, fn, cancelled: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        if (t) t.cancelled = true;
      },
    });

    // A burst of edits within the window all coalesce and refresh the deadline.
    const r1 = store.persist(PROJECT, { 'a.txt': 'v1' });
    assert.equal(r1.deadline, 2000);
    clock = 1500;
    const r2 = store.persist(PROJECT, { 'a.txt': 'v2' });
    assert.equal(r2.deadline, 3500, 'deadline refreshes on each edit while idle-pending');
    assert.equal(store.hasPending(PROJECT), true);

    // Fire the debounce timer (the most recent, non-cancelled one) — this is the
    // "became idle for 2s" event. It makes the LATEST tree durable.
    const live = timers.filter((t) => !t.cancelled);
    assert.equal(live.length, 1);
    live[0].fn();

    assert.equal(store.hasPending(PROJECT), false, 'pending write cleared after it fires');
    assert.deepEqual(store.readPersistedTree(PROJECT), { 'a.txt': 'v2' });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('persistence FAILURE retains the last good state unchanged and returns an error', () => {
  const { base, layout } = tempLayout();
  try {
    // First: a good writer persists v1 durably.
    const good = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const first = good.persist(PROJECT, { 'data.txt': 'good-v1' });
    assert.equal(first.ok, true);
    assert.deepEqual(good.readPersistedTree(PROJECT), { 'data.txt': 'good-v1' });

    // Now a store whose writeTree always throws mid-write.
    const failing = createPersistenceStore({
      layout,
      ownerId: OWNER,
      debounceMs: 0,
      writeTree: () => {
        throw new Error('disk full');
      },
    });
    const res = failing.persist(PROJECT, { 'data.txt': 'bad-v2' });
    assert.equal(res.ok, false);
    assert.equal(res.error.kind, 'persistence-failure');
    assert.match(res.error.message, /disk full/);

    // The last good state is unchanged (v1 still on disk, v2 never landed).
    assert.deepEqual(good.readPersistedTree(PROJECT), { 'data.txt': 'good-v1' });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('auto-flush (debounce timer path) failure is surfaced via onError and retains state', () => {
  const { base, layout } = tempLayout();
  try {
    // First persist a good v1 durably (debounce 0) with a plain store, so there
    // is a last-good state to retain.
    const good = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    good.persist(PROJECT, { 'data.txt': 'good-v1' });
    assert.deepEqual(good.readPersistedTree(PROJECT), { 'data.txt': 'good-v1' });

    // A store whose writeTree throws, wired with the injected clock/scheduler and
    // observable error/persist sinks. We drive the ACTUAL scheduled timer callback.
    let clock = 0;
    const timers = [];
    const errors = [];
    const persists = [];
    const store = createPersistenceStore({
      layout,
      ownerId: OWNER,
      now: () => clock,
      debounceMs: 2000,
      writeTree: () => {
        throw new Error('disk full');
      },
      setTimer: (fn, ms) => {
        const t = { fireAt: clock + ms, fn, cancelled: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        if (t) t.cancelled = true;
      },
      onError: (projectId, error) => errors.push({ projectId, error }),
      onPersist: (projectId, result) => persists.push({ projectId, result }),
    });

    // Schedule the idle-debounced write of v2 (which will fail when it fires).
    const scheduled = store.persist(PROJECT, { 'data.txt': 'bad-v2' });
    assert.equal(scheduled.scheduled, true);
    assert.equal(store.hasPending(PROJECT), true);

    // Fire the real scheduled timer callback (the "became idle for 2s" event).
    const live = timers.filter((t) => !t.cancelled);
    assert.equal(live.length, 1);
    live[0].fn();

    // (a) the onError sink was invoked with a structured error.
    assert.equal(errors.length, 1);
    assert.equal(errors[0].projectId, PROJECT);
    assert.equal(errors[0].error.kind, 'persistence-failure');
    assert.match(errors[0].error.message, /disk full/);
    // onPersist observed the same failed result.
    assert.equal(persists.length, 1);
    assert.equal(persists[0].result.ok, false);

    // (b) the last-good persisted state is unchanged (v1 still on disk).
    assert.deepEqual(good.readPersistedTree(PROJECT), { 'data.txt': 'good-v1' });

    // (c) the pending state is retained so a later flush can retry.
    assert.equal(store.hasPending(PROJECT), true);
    // A later flush with the failing writer still fails and still returns the
    // structured error directly to the caller (explicit-path contract unchanged).
    const retried = store.flush(PROJECT);
    assert.equal(retried.ok, false);
    assert.equal(retried.error.kind, 'persistence-failure');
    assert.equal(store.hasPending(PROJECT), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('persist rejects non-string (Buffer) contents to keep the utf8 round-trip honest', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    assert.throws(
      () => store.persist(PROJECT, { 'bin.dat': Buffer.from([0xff, 0xfe, 0x00]) }),
      /must be a string/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 8.2 SnapshotStore ----------------------------------------------------

test('commitSnapshot records a content-addressed commit in the project OWN repo', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSnapshotStore({ layout, ownerId: OWNER });
    const res = store.commitSnapshot(PROJECT, { 'index.js': 'const a = 1;\n' }, { trigger: 'explicit' });
    assert.equal(res.ok, true);
    assert.equal(typeof res.snapshotId, 'string');
    assert.match(res.snapshotId, /^[0-9a-f]{40}$/);

    // snapshotId === the real HEAD sha of the project's own repo.
    const root = layout.exportableProjectTree(PROJECT);
    assert.equal(gitHead(root), res.snapshotId);

    // The repo lives under the temp base, NOT in the ai-app-builder source repo.
    assert.ok(root.startsWith(base), 'project repo must be under the hermetic temp base');

    // The committer identity is the pinned deterministic one.
    const committer = execFileSync('git', ['log', '-1', '--format=%cn <%ce>'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    assert.equal(committer, `${SNAPSHOT_IDENTITY.name} <${SNAPSHOT_IDENTITY.email}>`);

    // Recorded as a Snapshot with the reused model shape.
    assert.equal(res.snapshot.trigger, 'explicit');
    assert.equal(res.snapshot.id, res.snapshotId);
    assert.equal(res.snapshot.projectId, PROJECT);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the ai-app-builder repo .git is never touched by snapshot commits', () => {
  const { base, layout } = tempLayout();
  const sourceRepo = path.resolve(process.cwd());
  const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepo, encoding: 'utf8' }).trim();
  const beforeStatus = execFileSync('git', ['status', '--porcelain'], { cwd: sourceRepo, encoding: 'utf8' });
  try {
    const store = createSnapshotStore({ layout, ownerId: OWNER });
    store.commitSnapshot(PROJECT, { 'a.js': '1' }, { trigger: 'explicit' });
    store.commitSnapshot(PROJECT, { 'a.js': '2' }, { trigger: 'turn-pass' });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  const afterHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepo, encoding: 'utf8' }).trim();
  const afterStatus = execFileSync('git', ['status', '--porcelain'], { cwd: sourceRepo, encoding: 'utf8' });
  assert.equal(afterHead, beforeHead, 'source repo HEAD must be unchanged');
  assert.equal(afterStatus, beforeStatus, 'source repo working tree must be unchanged');
});

test('registry-write failure rolls HEAD back so no orphaned commit is retained', () => {
  const { base, layout } = tempLayout();
  try {
    // First commit succeeds normally, establishing a parent HEAD + registry.
    const store = createSnapshotStore({ layout, ownerId: OWNER });
    const first = store.commitSnapshot(PROJECT, { 'a.js': 'v1' }, { trigger: 'explicit' });
    assert.equal(first.ok, true);

    const root = layout.exportableProjectTree(PROJECT);
    const parentHead = gitHead(root);
    assert.equal(parentHead, first.snapshotId);

    // A second store whose registry path is FORCED to be unwritable: point it at
    // a path whose parent dir is actually a regular file, so saveRegistry's
    // mkdirSync throws ENOTDIR AFTER the git commit has already succeeded.
    const blocker = path.join(base, 'registry-blocker');
    fs.writeFileSync(blocker, 'i am a file, not a dir');
    const brokenLayout = Object.create(layout);
    brokenLayout.controlSnapshotRegistryPath = () => path.join(blocker, 'nested', 'registry.json');

    const failing = createSnapshotStore({ layout: brokenLayout, ownerId: OWNER });
    const res = failing.commitSnapshot(PROJECT, { 'a.js': 'v2' }, { trigger: 'turn-pass' });

    // Structured error returned.
    assert.equal(res.ok, false);
    assert.equal(res.error.kind, 'snapshot-registry-failure');
    assert.equal(res.error.rolledBackTo, parentHead);

    // The repo does NOT retain an unreachable/orphaned commit: HEAD is back at
    // the parent, and the working tree reflects the parent (v1, not v2).
    assert.equal(gitHead(root), parentHead);
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'v1');

    // And restore/resume of the most recent COMPLETE snapshot still works and is
    // the parent (the orphan is neither reachable nor recorded).
    assert.equal(store.latestSnapshot(PROJECT).id, parentHead);
    const resumed = store.resume(PROJECT);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.snapshotId, parentHead);
    assert.deepEqual(resumed.projectTree, { 'a.js': 'v1' });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('registry-write failure on the FIRST commit leaves the repo with no reachable commit', () => {
  const { base, layout } = tempLayout();
  try {
    const blocker = path.join(base, 'registry-blocker-first');
    fs.writeFileSync(blocker, 'file');
    const brokenLayout = Object.create(layout);
    brokenLayout.controlSnapshotRegistryPath = () => path.join(blocker, 'nested', 'registry.json');

    const failing = createSnapshotStore({ layout: brokenLayout, ownerId: OWNER });
    const res = failing.commitSnapshot(PROJECT, { 'a.js': 'v1' }, { trigger: 'explicit' });
    assert.equal(res.ok, false);
    assert.equal(res.error.kind, 'snapshot-registry-failure');
    assert.equal(res.error.rolledBackTo, null);

    // No parent existed, so after rollback the repo has no reachable HEAD commit
    // (rev-parse on an unborn HEAD exits non-zero).
    const root = layout.exportableProjectTree(PROJECT);
    let head = '';
    try {
      head = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      head = '';
    }
    assert.equal(head, '', 'HEAD must be unborn after rolling back the first commit');

    // The registry has no record and there is no latest snapshot.
    const store = createSnapshotStore({ layout, ownerId: OWNER });
    assert.equal(store.listSnapshots(PROJECT).length, 0);
    assert.equal(store.latestSnapshot(PROJECT), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 8.5* turn-trigger policy ---------------------------------------------

test('TURN-PASS commits a snapshot but TURN-FAIL does not', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSnapshotStore({ layout, ownerId: OWNER });

    // FAIL turn: no snapshot committed.
    const failRes = store.onTurnComplete({
      projectId: PROJECT,
      projectTree: { 'app.js': 'broken();' },
      verifyResult: { verdict: 'FAIL' },
    });
    assert.equal(failRes.committed, false);
    assert.equal(store.listSnapshots(PROJECT).length, 0);

    // PASS turn: one snapshot committed with trigger 'turn-pass'.
    const passRes = store.onTurnComplete({
      projectId: PROJECT,
      projectTree: { 'app.js': 'ok();' },
      verifyResult: { verdict: 'PASS' },
    });
    assert.equal(passRes.committed, true);
    const snaps = store.listSnapshots(PROJECT);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].trigger, 'turn-pass');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('EXPLICIT commit records a snapshot with trigger explicit', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSnapshotStore({ layout, ownerId: OWNER });
    const res = store.commitExplicit(PROJECT, { 'note.txt': 'save me' });
    assert.equal(res.ok, true);
    const latest = store.latestSnapshot(PROJECT);
    assert.equal(latest.trigger, 'explicit');
    assert.equal(latest.id, res.snapshotId);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 8.2 restore ----------------------------------------------------------

test('restore returns the exact tree state at that snapshot and is idempotent', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSnapshotStore({ layout, ownerId: OWNER });
    const treeV1 = { 'a.js': 'v1-a', 'dir/b.js': 'v1-b' };
    const s1 = store.commitSnapshot(PROJECT, treeV1, { trigger: 'explicit' });

    // A second snapshot changes + deletes files.
    store.commitSnapshot(PROJECT, { 'a.js': 'v2-a', 'c.js': 'v2-c' }, { trigger: 'turn-pass' });

    // Restore back to s1: exact tree content (including the deleted-in-v2 dir/b.js
    // reappears, and the v2-only c.js is gone).
    const r1 = store.restore(PROJECT, s1.snapshotId);
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.projectTree, treeV1);

    // Idempotent: restore(restore(s)) yields identical tree content.
    const r2 = store.restore(PROJECT, s1.snapshotId);
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.projectTree, r1.projectTree);

    // And the on-disk working tree matches too.
    const root = layout.exportableProjectTree(PROJECT);
    assert.ok(fs.existsSync(path.join(root, 'dir/b.js')));
    assert.ok(!fs.existsSync(path.join(root, 'c.js')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('MISSING/UNREADABLE snapshot restore leaves current state unchanged + returns error', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSnapshotStore({ layout, ownerId: OWNER });
    store.commitSnapshot(PROJECT, { 'a.js': 'current' }, { trigger: 'explicit' });

    const root = layout.exportableProjectTree(PROJECT);
    // Capture the working tree bytes before the bogus restore.
    const before = fs.readFileSync(path.join(root, 'a.js'), 'utf8');
    const beforeHead = gitHead(root);

    // Unknown snapshot id (not in registry).
    const missing = store.restore(PROJECT, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(missing.ok, false);
    assert.equal(missing.error.kind, 'restore-missing');

    // State unchanged.
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), before);
    assert.equal(gitHead(root), beforeHead);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 8.2 resume rules -----------------------------------------------------

test('resume with >=1 snapshot restores the most recent complete snapshot', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSnapshotStore({ layout, ownerId: OWNER });
    store.commitSnapshot(PROJECT, { 'app.js': 'first' }, { trigger: 'explicit' });
    const latest = store.commitSnapshot(PROJECT, { 'app.js': 'second' }, { trigger: 'turn-pass' });

    const res = store.resume(PROJECT);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'snapshot');
    assert.equal(res.snapshotId, latest.snapshotId);
    assert.deepEqual(res.projectTree, { 'app.js': 'second' });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resume with 0 snapshots restores the most recent persisted file state', () => {
  const { base, layout } = tempLayout();
  try {
    const persistence = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    persistence.persist(PROJECT, { 'draft.txt': 'work-in-progress' });

    const store = createSnapshotStore({ layout, ownerId: OWNER, persistenceStore: persistence });
    // No snapshot committed.
    assert.equal(store.listSnapshots(PROJECT).length, 0);

    const res = store.resume(PROJECT);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'persisted');
    assert.deepEqual(res.projectTree, { 'draft.txt': 'work-in-progress' });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
