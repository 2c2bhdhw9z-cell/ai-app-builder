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
 * TEXT file contents covering tricky bytes: unicode, embedded newlines, and
 * trailing whitespace, plus empty files. Kept short so 100+ iterations stay
 * fast. We keep contents free of a trailing '\n'-only ambiguity by generating
 * exact bytes.
 */
const textContents = fc.oneof(
  fc.constant(''), // empty file
  fc.constant('trailing spaces   '),
  fc.constant('líne1\nlíne2\n\tindented\n'),
  fc.constant('emoji 🚀 and üñïçodé'),
  fc.string({ minLength: 0, maxLength: 40 }),
);

/**
 * BINARY file contents (Part A): arbitrary byte buffers, including non-utf8
 * sequences and embedded 0x00 NUL bytes. fc.uint8Array is mapped to a Buffer so
 * it flows through the stores as binary and survives byte-exact.
 */
const binaryContents = fc
  .uint8Array({ minLength: 0, maxLength: 48 })
  .map((u8) => Buffer.from(u8));

/**
 * A tree entry's contents is EITHER text (a String) OR binary (a Buffer). We
 * mix both kinds in the same generated tree so round-trips are exercised over
 * text and binary together.
 */
const contents = fc.oneof(textContents, binaryContents);

/**
 * A non-empty project tree: a map { relPath: contents }. fc.dictionary with a
 * unique key set naturally dedupes colliding paths; we require >=1 entry.
 */
const projectTreeArb = fc
  .dictionary(relPath, contents, { minKeys: 1, maxKeys: 6 })
  .filter((tree) => Object.keys(tree).length >= 1)
  // Guard against a generated key that normalizes to something reserved/empty.
  .filter((tree) => Object.keys(tree).every((k) => k.length > 0 && !k.split('/').includes('.git')))
  // Reject trees where one path is a directory-prefix of another (e.g. "a" and
  // "a/a"): a single name cannot be both a file and a directory on disk, so
  // such a map is not a materializable file tree. This is independent of
  // text-vs-binary content; we exclude it so the round-trip is well-defined.
  .filter((tree) => {
    const keys = Object.keys(tree);
    return !keys.some((a) =>
      keys.some((b) => a !== b && b.startsWith(`${a}/`)),
    );
  })
  // fc.dictionary yields a null-prototype object; normalize to a plain { }
  // object so node:assert/strict deepEqual (which also compares prototypes) is
  // meaningful. Strings are coerced with String(); Buffers are preserved AS
  // Buffers so binary values reach the store and survive the deep-equal
  // comparison (deepEqual compares Buffers byte-wise, which is what we want).
  .map((tree) => {
    const plain = {};
    for (const [k, v] of Object.entries(tree)) plain[k] = Buffer.isBuffer(v) ? v : String(v);
    return plain;
  });

/**
 * The tree the stores read back, given a written tree: text entries come back
 * as Strings and binary entries come back as Buffers, EXCEPT a Buffer whose
 * bytes are valid utf8 reads back as the equal String (bytes are still
 * preserved). This mirrors decodeTreeEntry so we can assert on CONTENT.
 */
function expectedReadBack(tree) {
  const expected = {};
  for (const [k, v] of Object.entries(tree)) {
    if (Buffer.isBuffer(v)) {
      // decodeTreeEntry returns a String iff the bytes are valid, lossless utf8.
      const asString = v.toString('utf8');
      expected[k] = Buffer.from(asString, 'utf8').equals(v) ? asString : v;
    } else {
      expected[k] = String(v);
    }
  }
  return expected;
}

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

        // restore(persist(state)) == state: the read-back tree equals the
        // original tree, with text entries as Strings and binary entries as
        // Buffers (deepEqual compares Buffers byte-wise).
        const expected = expectedReadBack(tree);
        assert.deepEqual(store.readPersistedTree(PROJECT), expected);

        // The resume surface (Req 19.5/19.6): with no snapshot, resume restores
        // the most recent persisted file state — same tree.
        const snapshots = createSnapshotStore({ layout, ownerId: OWNER, persistenceStore: store });
        const resumed = snapshots.resume(PROJECT);
        assert.equal(resumed.ok, true);
        assert.equal(resumed.source, 'persisted');
        assert.deepEqual(resumed.projectTree, expected);
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
        // text-or-binary read-back the store produces), confirming the restore
        // is faithful: text as String, binary as Buffer (byte-exact).
        assert.deepEqual(r1.projectTree, expectedReadBack(tree));
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );
});
