/**
 * RetentionService REAL-COLLABORATOR integration test (node --test) — C1.
 *
 * Where test/ops-retention.test.js drives the service against hand-rolled fake
 * stores, THIS test wires the RetentionService to the REAL control-plane
 * collaborators against hermetic temp dirs:
 *
 *   - the REAL createProjectRegistry (src/project/project-registry.js), whose
 *     surface is listForOwner(ownerId) -> Project[] and unregister(projectId,
 *     ownerId) -> boolean (projectId FIRST);
 *   - the REAL createPersistenceStore / createSnapshotStore / createSecretStore
 *     over one createStorageLayout(baseDir) and one ownerId.
 *
 * This is the exact test that would have caught C1: retention.js used to call
 * projectRegistry.listProjectIds/remove (which the real registry does NOT
 * expose), so constructing RetentionService with the real registry threw a
 * TypeError and the right-to-deletion path (Req 24.1-24.5) was dead against the
 * production wiring. Reverting the retention.js API fix makes this test FAIL
 * (see FEAT-001 findings mutation check).
 *
 * SEAM NOTE: there is no container backend offline, so sandboxManager is an
 * in-process FAKE exposing async release(projectId). Every OTHER collaborator is
 * the real thing writing to disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageLayout } from '../src/storage/layout.js';
import { createProjectRegistry } from '../src/project/project-registry.js';
import { createPersistenceStore } from '../src/persistence/persistence-store.js';
import { createSnapshotStore } from '../src/persistence/snapshot-store.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import { createProject } from '../src/model/project.js';
import { createRetentionService } from '../src/ops/index.js';
import { createCollectorSink, AUDIT_EVENTS } from '../src/auth/audit.js';

const OWNER = 'owner-int-1';

/** A minimal in-process fake for the SandboxManager (no container backend offline). */
function makeFakeSandboxManager() {
  const released = [];
  return {
    released,
    async release(projectId) {
      released.push(projectId);
      return { projectId, released: true, reaped: [], errors: [] };
    },
  };
}

/** Build a valid Project record input for registry.register(). */
function projectInput(id) {
  return {
    id,
    ownerId: OWNER,
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

/** Stand up a fresh temp baseDir + the full set of REAL collaborators. */
function makeRealWiring() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-int-'));
  const layout = createStorageLayout(baseDir);
  const registry = createProjectRegistry({ layout });
  const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
  const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
  const secretStore = createSecretStore({ layout, ownerId: OWNER });
  const sandboxManager = makeFakeSandboxManager();
  return { baseDir, layout, registry, persistenceStore, snapshotStore, secretStore, sandboxManager };
}

/** Register a project and seed real on-disk file tree + secret for it. */
function seedProject(w, id) {
  w.registry.register(projectInput(id));
  // Real persisted file tree on disk (debounceMs:0 => persist is synchronous).
  const persisted = w.persistenceStore.persist(id, { 'index.js': `// ${id}\n` });
  assert.equal(persisted.ok, true, `persist ${id} should succeed`);
  // Real secret value on disk (out-of-tree).
  w.secretStore.put(id, 'API_KEY', `secret-for-${id}`);
}

test('RetentionService.deleteProject with the REAL registry removes the record + on-disk tree + secret', async () => {
  const w = makeRealWiring();
  const audit = createCollectorSink();
  const svc = createRetentionService({
    persistenceStore: w.persistenceStore,
    snapshotStore: w.snapshotStore,
    sandboxManager: w.sandboxManager,
    secretStore: w.secretStore,
    projectRegistry: w.registry, // REAL registry — the C1 wiring under test.
    auditSink: audit,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  seedProject(w, 'proj-a');
  seedProject(w, 'proj-b');

  // Sanity: both projects registered and their files/secrets exist on disk.
  assert.equal(w.registry.get('proj-a')?.id, 'proj-a');
  assert.equal(w.registry.listForOwner(OWNER).length, 2);
  const treeA = w.layout.exportableProjectTree('proj-a');
  assert.ok(fs.existsSync(path.join(treeA, 'index.js')), 'proj-a tree should exist');
  assert.equal(w.secretStore.has('proj-a', 'API_KEY'), true);

  const res = await svc.deleteProject({ id: OWNER }, 'proj-a');

  assert.equal(res.ok, true);
  assert.equal(res.confirmed, true);
  assert.equal(res.projectId, 'proj-a');
  // The real unregister returns a boolean; the confirmation records it.
  assert.equal(res.steps.registry, true, 'registry.unregister should report a removal');

  // Record gone from the REAL registry.
  assert.equal(w.registry.get('proj-a'), null, 'proj-a must be gone from the registry');
  assert.deepEqual(
    w.registry.listForOwner(OWNER).map((r) => r.id),
    ['proj-b'],
    'only proj-b should remain for the owner',
  );

  // On-disk file tree + secret gone.
  assert.equal(fs.existsSync(treeA), false, "proj-a's exportable tree must be deleted");
  assert.equal(w.secretStore.has('proj-a', 'API_KEY'), false, "proj-a's secret must be deleted");

  // proj-b untouched.
  assert.equal(w.secretStore.has('proj-b', 'API_KEY'), true, "proj-b's secret must survive");

  // Sandbox release fired for proj-a and a redacted PROJECT_DELETED was emitted.
  assert.deepEqual(w.sandboxManager.released, ['proj-a']);
  const evts = audit.ofType(AUDIT_EVENTS.PROJECT_DELETED);
  assert.equal(evts.length, 1);
  assert.equal(evts[0].projectId, 'proj-a');

  fs.rmSync(w.baseDir, { recursive: true, force: true });
});

test('RetentionService.deleteAccount enumerates owned projects via the REAL listForOwner and tears them all down', async () => {
  const w = makeRealWiring();
  const audit = createCollectorSink();
  const svc = createRetentionService({
    persistenceStore: w.persistenceStore,
    snapshotStore: w.snapshotStore,
    sandboxManager: w.sandboxManager,
    secretStore: w.secretStore,
    projectRegistry: w.registry, // REAL registry.
    auditSink: audit,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  seedProject(w, 'proj-1');
  seedProject(w, 'proj-2');
  seedProject(w, 'proj-3');
  assert.equal(w.registry.listForOwner(OWNER).length, 3);
  const ownerSecretDir = path.dirname(
    path.dirname(w.layout.controlSecretPath(OWNER, 'proj-1', 'API_KEY')),
  );
  assert.equal(fs.existsSync(ownerSecretDir), true, "owner's secret dir should exist");

  const res = await svc.deleteAccount({ id: OWNER });

  assert.equal(res.ok, true);
  assert.equal(res.confirmed, true);
  assert.equal(res.deleted, 'User_Account');
  assert.equal(res.categories.Projects.count, 3, 'all three owned projects torn down');

  // The REAL registry lists nothing for the owner anymore.
  assert.deepEqual(w.registry.listForOwner(OWNER), [], 'no projects remain for the owner');
  for (const id of ['proj-1', 'proj-2', 'proj-3']) {
    assert.equal(w.registry.get(id), null, `${id} must be gone`);
    assert.equal(fs.existsSync(w.layout.exportableProjectTree(id)), false, `${id} tree gone`);
  }

  // Every owned project's sandbox was released.
  assert.deepEqual([...w.sandboxManager.released].sort(), ['proj-1', 'proj-2', 'proj-3']);

  // The owner's on-disk secret subtree is gone (Secrets category deleted).
  assert.equal(fs.existsSync(ownerSecretDir), false, "owner's secret dir must be deleted");

  // Exactly one ACCOUNT_DELETED audit event for the owner.
  const evts = audit.ofType(AUDIT_EVENTS.ACCOUNT_DELETED);
  assert.equal(evts.length, 1);
  assert.equal(evts[0].accountId, OWNER);

  fs.rmSync(w.baseDir, { recursive: true, force: true });
});

test('createRetentionService does NOT throw when constructed with the REAL ProjectRegistry (C1 regression guard)', () => {
  const w = makeRealWiring();
  assert.doesNotThrow(() =>
    createRetentionService({
      persistenceStore: w.persistenceStore,
      snapshotStore: w.snapshotStore,
      sandboxManager: w.sandboxManager,
      secretStore: w.secretStore,
      projectRegistry: w.registry,
    }),
  );
  fs.rmSync(w.baseDir, { recursive: true, force: true });
});
