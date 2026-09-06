/**
 * Property 10 — "Fork independence" (spec subtask 14.4*, Req 6.6).
 *
 * fast-check property (>=100 iterations) over generated project trees: for ALL
 * forked Projects, forking copies the source's MOST RECENT Snapshot as an
 * INDEPENDENT starting state, so mutating the fork's tree/Buffers NEVER changes
 * the origin Project's file state. We fork, mutate the fork, then compare — the
 * origin's most-recent snapshot must be byte-for-byte unchanged.
 *
 * WHAT IS EMPIRICALLY RUN vs SIMULATED VIA SEAMS:
 *   - EMPIRICALLY RUN (real, local, offline): the SnapshotStore + PersistenceStore
 *     run for REAL over a fresh temp StorageLayout — the source's snapshot is a
 *     REAL per-project git commit (local git works offline), and the fork copy
 *     goes through the real latestSnapshot + restore path. Nothing about the
 *     copy/independence is faked.
 *   - SIMULATED VIA SEAM: authorization uses the real authorizer with an
 *     owner-matched account (no network identity provider); there is no clock
 *     dependence in the fork branch, so no injected clock is needed. No network,
 *     no container.
 *
 * MUTATION SENSITIVITY: independence holds ONLY because the fork branch returns a
 * DEEP copy (Buffers copied via Buffer.from, strings immutable). A mutation that
 * SHARED state — a shallow copy `{ ...tree }` that reuses the same Buffer
 * instances, or handing back the restored tree directly — would let a write to
 * the fork's Buffer alias into the origin's snapshot bytes, FLIPPING this
 * property. The generators deliberately include Buffer (binary) entries so a
 * shared-Buffer regression is caught; the in-place Buffer mutation below
 * (`byte[0] ^= 0xff`) is exactly what a shared Buffer would leak to the origin.
 *
 * NOTE (from FEAT-003): the tree codec decodes valid-utf8 bytes back to a
 * String, so a "binary" fixture must use NON-utf8 bytes to actually round-trip
 * as a Buffer. The `binaryContents` generator forces a leading 0xff (an invalid
 * utf8 start byte) so at least one entry is a genuine Buffer to deep-copy.
 *
 * Hermeticity: every iteration allocates a fresh fs.mkdtemp layout removed in a
 * finally; git touches ONLY the per-project temp repo, never this repo's .git.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createPersistenceStore } from '../src/persistence/index.js';
import { createSnapshotStore } from '../src/persistence/snapshot-store.js';
import { createProjectRegistry } from '../src/project/project-registry.js';
import { createProjectOrigin } from '../src/project/project-origins.js';
import { createAuthorizer } from '../src/auth/authorize.js';
import { createProject as createProjectRecord } from '../src/model/project.js';

const OWNER = 'prop10-owner';

/** A bounded, safe relative path made of 1-2 lower-case segments (.git-free). */
const segment = fc
  .string({ minLength: 1, maxLength: 8, unit: fc.constantFrom(...'abcdefghijklmnop0123456789_'.split('')) })
  .filter((s) => s.length > 0 && s !== '.' && s !== '..' && s !== 'git');

const relPath = fc
  .array(segment, { minLength: 1, maxLength: 2 })
  .map((segs) => segs.join('/'))
  .map((p) => (p.endsWith('.git') ? `${p}x` : p));

/** Text contents (round-trips as a String). */
const textContents = fc.oneof(
  fc.constant(''),
  fc.constant('líne1\nlíne2\n'),
  fc.string({ minLength: 0, maxLength: 32 }),
);

/**
 * BINARY contents that genuinely round-trip as a Buffer: we force a leading
 * 0xff (an invalid utf8 start byte) so the tree codec cannot decode it back to
 * a String. This is what exercises the deep-copy-of-Buffers half of Property 10.
 */
const binaryContents = fc
  .uint8Array({ minLength: 0, maxLength: 32 })
  .map((u8) => Buffer.from([0xff, ...u8]));

/**
 * A source project tree with at least one entry, guaranteed to include at least
 * one genuine binary (Buffer) entry so the shared-Buffer regression is always
 * exercised. Directory-prefix collisions are excluded (a name cannot be both a
 * file and a dir on disk).
 */
const sourceTreeArb = fc
  .tuple(
    // A guaranteed binary entry under a fixed name.
    binaryContents,
    // Plus a small map of extra text/binary entries.
    fc.dictionary(relPath, fc.oneof(textContents, binaryContents), { minKeys: 0, maxKeys: 4 }),
  )
  .map(([bin, rest]) => {
    const tree = { 'assets/blob.bin': bin };
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'assets/blob.bin') continue;
      tree[k] = Buffer.isBuffer(v) ? v : String(v);
    }
    return tree;
  })
  .filter((tree) => {
    const keys = Object.keys(tree);
    return !keys.some((a) => keys.some((b) => a !== b && b.startsWith(`${a}/`)));
  });

/** A minimal Project record for a source/fork. */
function projectRecord({ origin, id }) {
  const iso = '2020-01-01T00:00:00.000Z';
  return createProjectRecord({
    id,
    ownerId: OWNER,
    description: 'p',
    targetCategory: 'web',
    origin,
    sandboxId: id,
    targets: [],
    snapshots: [],
    connectors: [],
    provider: 'anthropic',
    model: 'claude-sonnet',
    createdAt: iso,
    updatedAt: iso,
  });
}

/** Allocate a fresh hermetic layout for one property iteration. */
function freshLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-prop10-'));
  return { base, layout: createStorageLayout(base) };
}

// EXACT spec tag (rendered by propertyTag below, kept greppable here verbatim):
//   Feature: ai-app-builder, Property 10: Fork independence
test(propertyTag(10, 'Fork independence'), async () => {
  await fc.assert(
    fc.asyncProperty(sourceTreeArb, async (sourceTree) => {
      const { base, layout } = freshLayout();
      try {
        const registry = createProjectRegistry({ layout });
        const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
        const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
        const authorizer = createAuthorizer();

        // Seed a REAL source Project: register it, persist the tree, and commit
        // an OLDER snapshot then the MOST RECENT one, to prove "most recent".
        const sourceId = 'src';
        registry.register(projectRecord({ origin: 'blank', id: sourceId }));
        persistenceStore.persist(sourceId, sourceTree);
        persistenceStore.flush(sourceId);
        snapshotStore.commitExplicit(sourceId, { 'stale.txt': 'older snapshot\n' });
        const committed = snapshotStore.commitExplicit(sourceId, sourceTree);
        assert.equal(committed.ok, true);

        // Capture the origin's most-recent snapshot BEFORE forking (the baseline
        // we require to be untouched after the fork is mutated).
        const beforeLatest = snapshotStore.latestSnapshot(sourceId);
        const beforeRestored = snapshotStore.restore(sourceId, beforeLatest.id);
        assert.equal(beforeRestored.ok, true);
        // A deep, structured snapshot of the origin's bytes to compare against.
        const beforeBytes = normalize(beforeRestored.projectTree);

        // Fork it (owner is authorized). The fork copies the MOST RECENT snapshot.
        const origin = createProjectOrigin({ snapshotStore, persistenceStore, authorizer, projectRegistry: registry });
        const forked = await origin.populate({
          project: projectRecord({ origin: 'fork', id: 'fork' }),
          origin: 'fork',
          targetCategory: 'web',
          ref: sourceId,
          userAccount: { id: OWNER },
        });
        assert.equal(forked.ok, true, 'fork populate ok');
        assert.equal(forked.origin, 'fork');
        const forkTree = forked.projectTree;

        // The fork must equal the source's most-recent snapshot content.
        assert.deepEqual(normalize(forkTree), beforeBytes, 'fork copies the most recent snapshot');

        // MUTATE THE FORK aggressively: flip a byte in every Buffer in place
        // (this is precisely what a shared Buffer would leak into the origin),
        // reassign string entries, and add a brand-new file to the fork.
        for (const [k, v] of Object.entries(forkTree)) {
          if (Buffer.isBuffer(v) && v.length > 0) {
            v[0] ^= 0xff; // in-place mutation — aliases the origin iff shared
          } else if (typeof v === 'string') {
            forkTree[k] = `${v}::tampered`;
          }
        }
        forkTree['injected-by-fork.txt'] = 'only in the fork\n';

        // COMPARE: the origin's most-recent snapshot must be byte-for-byte the
        // same as before the fork was mutated (independent, deep copy).
        const afterLatest = snapshotStore.latestSnapshot(sourceId);
        const afterRestored = snapshotStore.restore(sourceId, afterLatest.id);
        assert.equal(afterRestored.ok, true);
        assert.deepEqual(normalize(afterRestored.projectTree), beforeBytes, 'origin snapshot unchanged after fork mutation');

        // And the origin's persisted tree is likewise untouched by fork edits.
        assert.deepEqual(normalize(persistenceStore.readPersistedTree(sourceId)), beforeBytes, 'origin persisted tree unchanged');
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );
});

/**
 * Normalize a { relPath: contents } tree to a comparable plain object: Buffers
 * become arrays of bytes (so deepEqual compares byte content), strings stay
 * strings. This lets us detect ANY byte drift in the origin.
 */
function normalize(tree) {
  const out = {};
  for (const [k, v] of Object.entries(tree)) {
    out[k] = Buffer.isBuffer(v) ? ['buffer', ...v] : ['string', String(v)];
  }
  return out;
}
