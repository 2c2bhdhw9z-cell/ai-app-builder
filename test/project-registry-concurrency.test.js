/**
 * ProjectRegistry advisory-lock concurrency tests (node --test) — H2/H3/H4.
 *
 * These tests wire the REAL createProjectRegistry over a hermetic temp dir
 * (via the REAL createStorageLayout) and drive the specific race windows the
 * first audit flagged in withLock/register/get. Rather than relying on real
 * thread/process races (which are non-deterministic offline), each test
 * manipulates the on-disk lock DIRECTORY and index.json directly to reproduce
 * the exact interleaving deterministically.
 *
 *   - H2 (stale-lock steal race): a lock freshly re-created by another writer
 *     (a NEW mtime) must NOT be wrongly stolen; the steal decision made against
 *     the OLD stat re-verifies lock identity (mtimeMs) before rmSync.
 *   - H3 (index-vs-owner-file crash window): a crash between the owner-file
 *     write (inside the per-owner lock) and the SEPARATE indexPut leaves the
 *     owner file present but the index entry missing. get()/resolver() must
 *     self-heal via scanAndIndex AND repopulate index.json; listForOwner must
 *     NOT depend on the index.
 *   - H4 (lock-exhaustion surface): when the lock can never be acquired
 *     (pre-created with a FRESH mtime so it is never stolen), withLock/register
 *     must throw a CLEAR, model-tagged 'could not acquire registry lock' error
 *     rather than a raw fs error or an uncaught non-model error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageLayout } from '../src/storage/layout.js';
import { createProjectRegistry } from '../src/project/project-registry.js';

const OWNER = 'owner-conc-1';

/** Build a valid Project record input for registry.register(). */
function projectInput(id, ownerId = OWNER) {
  return {
    id,
    ownerId,
    description: `project ${id}`,
    targetCategory: 'web',
    origin: 'blank',
    targets: [{ kind: 'web', rootPath: '.' }],
    sandboxId: `sbx-${id}`,
    snapshots: [],
    connectors: [],
    provider: 'anthropic',
    model: 'claude-x',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Stand up a fresh temp baseDir + a real layout + real registry. */
function makeWiring() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-conc-'));
  const layout = createStorageLayout(baseDir);
  const registry = createProjectRegistry({ layout });
  return { baseDir, layout, registry };
}

function cleanup(w) {
  fs.rmSync(w.baseDir, { recursive: true, force: true });
}

/** The registry root and the two lock paths under it. */
function registryRoot(layout) {
  return layout.controlProjectRegistryRoot();
}
function ownerLockPath(layout, ownerId = OWNER) {
  return `${layout.controlProjectRegistryPath(ownerId)}.lock`;
}
function indexPath(layout) {
  return path.join(registryRoot(layout), 'index.json');
}

test('register + get: baseline round-trip populates the owner file and the index', () => {
  const w = makeWiring();
  const rec = w.registry.register(projectInput('proj-a'));
  assert.equal(rec.id, 'proj-a');
  assert.equal(w.registry.get('proj-a')?.id, 'proj-a');
  // index.json maps proj-a -> OWNER.
  const idx = JSON.parse(fs.readFileSync(indexPath(w.layout), 'utf8'));
  assert.equal(idx['proj-a'], OWNER);
  cleanup(w);
});

test('concurrent-register interleaving for one owner loses no entry (serialized RMW)', () => {
  // Simulate the read-modify-write interleaving deterministically: two projects
  // for the same owner registered back-to-back must BOTH survive (the per-owner
  // lock serializes the RMW; a lost update would drop one). This is the existing
  // no-loss behavior the audit says must keep passing.
  const w = makeWiring();
  w.registry.register(projectInput('proj-1'));
  w.registry.register(projectInput('proj-2'));
  w.registry.register(projectInput('proj-3'));
  const ids = w.registry.listForOwner(OWNER).map((r) => r.id).sort();
  assert.deepEqual(ids, ['proj-1', 'proj-2', 'proj-3']);
  // Re-register (idempotent update) does not duplicate.
  w.registry.register(projectInput('proj-2'));
  assert.equal(w.registry.listForOwner(OWNER).length, 3);
  cleanup(w);
});

test('H3: get() self-heals a MISSING index entry via scanAndIndex and repopulates index.json', () => {
  const w = makeWiring();
  w.registry.register(projectInput('proj-x'));

  // Reproduce the crash window: the owner file is written but the index entry is
  // gone (delete index.json entirely, as if the process crashed after the
  // per-owner write but before indexPut).
  fs.rmSync(indexPath(w.layout), { force: true });
  assert.equal(fs.existsSync(indexPath(w.layout)), false, 'index removed for the test');

  // Sanity: listForOwner does NOT depend on the index, so it still enumerates.
  assert.deepEqual(
    w.registry.listForOwner(OWNER).map((r) => r.id),
    ['proj-x'],
    'listForOwner enumerates the owner file directly, index-independent',
  );

  // get() must still resolve the record via the scan fallback...
  const rec = w.registry.get('proj-x');
  assert.equal(rec?.id, 'proj-x');
  assert.equal(rec.ownerId, OWNER);

  // ...and it must repopulate the index (self-heal) so later lookups are cheap.
  assert.equal(fs.existsSync(indexPath(w.layout)), true, 'index.json rebuilt');
  const idx = JSON.parse(fs.readFileSync(indexPath(w.layout), 'utf8'));
  assert.equal(idx['proj-x'], OWNER, 'index repopulated by scanAndIndex');

  cleanup(w);
});

test('H3: resolver() self-heals a STALE index (points at the wrong owner) and returns {id, ownerId}', () => {
  const w = makeWiring();
  w.registry.register(projectInput('proj-y'));

  // Corrupt the index so it points proj-y at a non-existent owner (a stale entry
  // is the other face of the crash window). get() should notice the owner file
  // does not contain the record and fall through to the rescan.
  fs.writeFileSync(indexPath(w.layout), JSON.stringify({ 'proj-y': 'ghost-owner' }, null, 2));

  const resolved = w.registry.resolver('proj-y');
  assert.deepEqual(resolved, { id: 'proj-y', ownerId: OWNER });

  // Index healed back to the true owner.
  const idx = JSON.parse(fs.readFileSync(indexPath(w.layout), 'utf8'));
  assert.equal(idx['proj-y'], OWNER, 'stale index entry corrected by scanAndIndex');

  cleanup(w);
});

test('H4: register throws a clear model-tagged "could not acquire registry lock" error when the owner lock is never free', () => {
  const w = makeWiring();
  // Pre-create the per-owner lock DIRECTORY with a FRESH mtime so mkdirSync
  // always EEXISTs and the stale-steal path never fires — withLock exhausts its
  // retry budget and must fail() with a clear model error.
  const lock = ownerLockPath(w.layout);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.mkdirSync(lock, { recursive: true });
  // Keep the mtime fresh (well within LOCK_STALE_MS) — it is brand new anyway.

  assert.throws(
    () => w.registry.register(projectInput('proj-z')),
    (err) => {
      assert.ok(err instanceof Error, 'must be a real Error, not a raw fs code');
      assert.match(
        err.message,
        /could not acquire registry lock/,
        'error message names the lock-acquisition failure',
      );
      // fail() tags the error with the model name — a clean, model-tagged error
      // rather than an uncaught non-model / raw fs error.
      assert.match(err.message, /ProjectRegistry/, 'model-tagged error');
      assert.notEqual(err.code, 'EEXIST', 'not a raw fs EEXIST error');
      return true;
    },
  );

  // State is not corrupted: no owner file was written (the RMW never ran).
  assert.equal(fs.existsSync(w.layout.controlProjectRegistryPath(OWNER)), false);

  // Release the lock and confirm the registry works normally afterwards.
  fs.rmSync(lock, { recursive: true, force: true });
  const rec = w.registry.register(projectInput('proj-z'));
  assert.equal(rec.id, 'proj-z');
  assert.equal(w.registry.get('proj-z')?.id, 'proj-z');

  cleanup(w);
});

test('H2: a lock freshly re-created by another writer (new mtime) is NOT wrongly stolen', () => {
  // The steal path decides a lock is stale against an OLD stat, then rmSyncs it.
  // If between the decision and the rmSync another writer stole+re-created the
  // lock (giving it a FRESH mtime), the old decision must be re-verified so the
  // now-live lock is not deleted out from under its holder.
  //
  // We exercise the identity check directly at the seam: create a lock with an
  // OLD (stale) mtime, then in a monkey-patched statSync FIRST call return the
  // stale stat (triggering the steal decision) and on the SECOND call (the
  // re-stat immediately before rmSync) return a FRESH mtime, as if a competing
  // writer just re-created it. The registry must SKIP the rmSync and re-attempt
  // mkdir instead of blowing away the live lock.
  const w = makeWiring();
  const lock = ownerLockPath(w.layout);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.mkdirSync(lock, { recursive: true });

  const realStat = fs.statSync;
  const realRm = fs.rmSync;
  const staleMtime = Date.now() - 10 * 60_000; // 10 min old => decided stale.
  const freshMtime = Date.now(); // as if just re-created by another writer.
  let statCalls = 0;
  let rmOfLock = 0;
  let removedByTest = false;

  fs.statSync = (p, ...rest) => {
    if (p === lock) {
      statCalls += 1;
      // First stat -> stale (drives the steal decision). Every subsequent stat
      // -> fresh (a competing writer re-created it), so the identity check must
      // detect the change and refuse to steal.
      return { mtimeMs: statCalls === 1 ? staleMtime : freshMtime };
    }
    return realStat(p, ...rest);
  };
  fs.rmSync = (p, ...rest) => {
    if (p === lock) {
      rmOfLock += 1;
    }
    return realRm(p, ...rest);
  };

  // Run register with a short deadline: because the lock is never legitimately
  // stealable (identity always changes) and never released, withLock will
  // exhaust and throw. What we assert is that it NEVER rmSync'd the live lock.
  try {
    assert.throws(
      () => w.registry.register(projectInput('proj-h2')),
      /could not acquire registry lock/,
    );
  } finally {
    fs.statSync = realStat;
    fs.rmSync = realRm;
    // Clean the lock ourselves so cleanup is tidy.
    if (fs.existsSync(lock)) {
      removedByTest = true;
      realRm(lock, { recursive: true, force: true });
    }
  }

  assert.ok(statCalls >= 2, 're-stat before rmSync happened (identity re-check)');
  assert.equal(rmOfLock, 0, 'the freshly re-created lock was NOT stolen (no rmSync of the live lock)');
  assert.ok(removedByTest, 'the live lock survived until the test cleaned it up');

  cleanup(w);
});
