/**
 * Property-based tests for Task 8 — Persistence + Snapshots (node --test).
 *
 * Built on the PersistenceStore + SnapshotStore delivered by FEAT-001. Each
 * property runs >=100 iterations via fcConfig and carries the EXACT spec tag.
 *
 *   Property 4 (subtask 8.3*, Resumability, Req 19.1/19.5/19.6):
 *     for all Projects, restore(persist(state)) == state. We persist a
 *     fast-check-generated project tree, force durability via the injected
 *     clock/flush seam (NOT a real 2s sleep), then read the state back and
 *     deep-equal the restored { relPath: contents } map to the original.
 *     `restore` here is the persist/read round-trip that resumability rests on;
 *     we also assert resume() (snapshot-preferring surface, Req 19.5/19.6)
 *     yields the same tree when only persisted state exists.
 *
 *   Property 6 (subtask 8.4*, Snapshot idempotence, Req 19.7/19.8):
 *     for all Projects/Snapshots, restore(restore(s)) == restore(s). We
 *     commitSnapshot a generated tree to a REAL per-project git repo, restore
 *     twice, and assert the RESTORED TREE CONTENT is byte-identical across the
 *     two restores (deep-equal). We assert on tree content, NOT on git SHA
 *     re-derivation, because commit SHAs embed timestamps/identity.
 *
 * Hermeticity: every iteration allocates a fresh fs.mkdtemp base removed in a
 * finally; git touches ONLY the per-project temp repo, never the ai-app-builder
 * repo's own .git.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createPersistenceStore, createSnapshotStore } from '../src/persistence/index.js';

const OWNER = 'owner-1';
const PROJECT = 'proj-1';

/**
 * A generator for a single safe RELATIVE path made of 1-3 lower-case segments.
 * Bounded and .git-free so trees stay small and never collide with the repo dir.
 * Segments avoid path separators, '.'/'..', and leading/trailing dots.
 */
const segment = fc
  .string({ minLength: 1, maxLength: 8, unit: fc.constantFrom(...'abcdefghijklmnop0123456789_'.split('')) })
  .filter((s) => s.length > 0 && s !== '.' && s !== '..' && s !== 'git');

const relPath = fc
  .array(segment, { minLength: 1, maxLength: 3 })
  .map((segs) => segs.join('/'))
  .map((p) => (p.endsWith('.git') ? `${p}x` : p));

/**
 * File contents covering tricky bytes: unicode, embedded newlines, and trailing
 * whitespace, plus empty files. Kept short so 100+ iterations stay fast. We keep
 * contents free of a trailing '\n'-only ambiguity by generating exact bytes.
 */
const contents = fc.oneof(
  fc.constant(''), // empty file
  fc.constant('trailing spaces   '),
  fc.constant('líne1\nlíne2\n\tindented\n'),
  fc.constant('emoji 🚀 and üñïçodé'),
  fc.string({ minLength: 0, maxLength: 40 }),
);

/**
 * A non-empty project tree: a map { relPath: contents }. fc.dictionary with a
 * unique key set naturally dedupes colliding paths; we require >=1 entry.
 */
const projectTreeArb = fc
  .dictionary(relPath, contents, { minKeys: 1, maxKeys: 6 })
  .filter((tree) => Object.keys(tree).length >= 1)
  // Guard against a generated key that normalizes to something reserved/empty.
  .filter((tree) => Object.keys(tree).every((k) => k.length > 0 && !k.split('/').includes('.git')))
  // fc.dictionary yields a null-prototype object; normalize to a plain { }
  // object of utf8 strings so it matches the shape the stores read back and so
  // node:assert/strict deepEqual (which also compares prototypes) is meaningful.
  .map((tree) => {
    const plain = {};
    for (const [k, v] of Object.entries(tree)) plain[k] = String(v);
    return plain;
  });

/** Allocate a fresh hermetic layout for one property iteration. */
function freshLayout(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { base, layout: createStorageLayout(base) };
}

// --- Property 4: Resumability restores prior state (8.3*) ------------------

test(propertyTag(4, 'Resumability restores prior state'), () => {
  fc.assert(
    fc.property(projectTreeArb, (tree) => {
      const { base, layout } = freshLayout('aab-prop4-');
      try {
        // A store with an INJECTED clock + manual scheduler so we never sleep 2s.
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

        // persist(state): schedules the idle-debounced durable write.
        const scheduled = store.persist(PROJECT, tree);
        assert.equal(scheduled.ok, true);
        assert.equal(scheduled.scheduled, true);
        assert.equal(store.hasPending(PROJECT), true);

        // Force durability via the flush seam (the "became idle" event), no sleep.
        const flushed = store.flush(PROJECT);
        assert.equal(flushed.ok, true);
        assert.equal(flushed.durable, true);
        assert.equal(store.hasPending(PROJECT), false);

        // restore(persist(state)) == state: the read-back tree equals the original.
        assert.deepEqual(store.readPersistedTree(PROJECT), tree);

        // The resume surface (Req 19.5/19.6): with no snapshot, resume restores
        // the most recent persisted file state — same tree.
        const snapshots = createSnapshotStore({ layout, ownerId: OWNER, persistenceStore: store });
        const resumed = snapshots.resume(PROJECT);
        assert.equal(resumed.ok, true);
        assert.equal(resumed.source, 'persisted');
        assert.deepEqual(resumed.projectTree, tree);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );
});

// --- Property 6: Snapshot idempotence (8.4*) -------------------------------

test(propertyTag(6, 'Snapshot idempotence'), () => {
  fc.assert(
    fc.property(projectTreeArb, (tree) => {
      const { base, layout } = freshLayout('aab-prop6-');
      try {
        const store = createSnapshotStore({ layout, ownerId: OWNER });

        // Commit the generated tree to a REAL per-project git repo under the temp
        // base. snapshotId is the commit SHA (content-addressed).
        const committed = store.commitSnapshot(PROJECT, tree, { trigger: 'explicit' });
        assert.equal(committed.ok, true);
        const snapshotId = committed.snapshotId;

        // restore(s): first restore of the snapshot.
        const r1 = store.restore(PROJECT, snapshotId);
        assert.equal(r1.ok, true);

        // restore(restore(s)): apply restore again to the result of restore. The
        // second restore must yield tree content byte-identical to the first.
        const r2 = store.restore(PROJECT, snapshotId);
        assert.equal(r2.ok, true);

        // Idempotence asserted on RESTORED TREE CONTENT, not on SHA re-derivation.
        assert.deepEqual(r2.projectTree, r1.projectTree);

        // And the restored content matches the committed tree (normalized to the
        // utf8 read-back the store produces), confirming the restore is faithful.
        const expected = {};
        for (const [k, v] of Object.entries(tree)) {
          expected[k] = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
        }
        assert.deepEqual(r1.projectTree, expected);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );
});
