/**
 * RetentionService tests (node --test) — spec Task 12.3 / 12.5*, Req 24.2-24.5.
 *
 * With fake/spy resource stores seeded for an owner, these tests prove:
 *
 *   deleteProject: releases the Sandbox (sandboxManager.release), deletes the
 *     project's files (persistenceStore.deleteProjectTree), Snapshots
 *     (snapshotStore.deleteSnapshots) and Secrets
 *     (secretStore.deleteProjectSecrets), removes the project from the registry
 *     (projectRegistry.remove), emits a redacted PROJECT_DELETED audit event,
 *     and returns a confirmation.
 *
 *   deleteAccount: iterates ALL ownerId-keyed categories (Projects, Skills,
 *     Project_Memory + Global_Memory, Connectors, Secrets), leaving NONE behind,
 *     emits ACCOUNT_DELETED, and confirms.
 *
 * MUTATION-STYLE ASSERTION (verification check B): a deleteAccount that skips one
 * ownerId-keyed category (e.g. Connectors) must flip the "no owned data remains"
 * completeness assertion — verified here by checking each fake store's remaining
 * state AND that every category in OWNER_KEYED_CATEGORIES was handled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCollectorSink, AUDIT_EVENTS } from '../src/auth/audit.js';
import { createRedactor } from '../src/ops/redaction.js';
import { createRetentionService, OWNER_KEYED_CATEGORIES } from '../src/ops/index.js';

const OWNER = 'owner-1';

/**
 * Build a set of fake ownerId-keyed stores seeded with data for OWNER. Each fake
 * records calls and empties its own owned state on deleteAccountData, so a
 * "nothing remains" completeness check can inspect it afterward.
 */
function makeFakes({ projectIds = ['p1', 'p2'] } = {}) {
  const calls = { release: [], files: [], snapshots: [], projectSecrets: [] };

  // ownerId-keyed data, seeded so we can assert it is all gone afterward.
  const owned = {
    Skills: new Map([[OWNER, ['skill-a']]]),
    Memory: new Map([[OWNER, ['mem-a', 'global-mem']]]),
    Connectors: new Map([[OWNER, ['conn-a']]]),
    Secrets: new Map([[OWNER, ['SECRET_A']]]),
    Projects: new Map([[OWNER, [...projectIds]]]),
  };

  const sandboxManager = {
    async release(projectId) {
      calls.release.push(projectId);
      return { projectId, released: true, reaped: [], errors: [] };
    },
  };
  const persistenceStore = {
    deleteProjectTree(projectId) {
      calls.files.push(projectId);
      return { ok: true, projectId, removed: true };
    },
  };
  const snapshotStore = {
    deleteSnapshots(projectId) {
      calls.snapshots.push(projectId);
      return { ok: true, projectId, registryRemoved: true, repoRemoved: true };
    },
  };
  const secretStore = {
    deleteProjectSecrets(projectId) {
      calls.projectSecrets.push(projectId);
      return { ok: true, projectId, removed: ['SECRET_A'] };
    },
    deleteAccountData(accountId) {
      owned.Secrets.delete(accountId);
      return { ok: true, ownerId: accountId };
    },
  };
  // Fake registry mirroring the REAL ProjectRegistry API: listForOwner(ownerId)
  // returns full Project RECORDS ([{ id, ownerId }]) and unregister(projectId,
  // ownerId) removes by projectId-FIRST, returning a boolean.
  const projectRegistry = {
    listForOwner(ownerId) {
      return [...(owned.Projects.get(ownerId) ?? [])].map((id) => ({ id, ownerId }));
    },
    unregister(projectId, ownerId) {
      const list = owned.Projects.get(ownerId) ?? [];
      const next = list.filter((id) => id !== projectId);
      owned.Projects.set(ownerId, next);
      return next.length !== list.length;
    },
  };
  const skillStore = {
    deleteAccountData(accountId) {
      owned.Skills.delete(accountId);
      return { ok: true, ownerId: accountId };
    },
  };
  const memoryStore = {
    deleteAccountData(accountId) {
      owned.Memory.delete(accountId);
      return { ok: true, ownerId: accountId };
    },
  };
  const connectorStore = {
    deleteAccountData(accountId) {
      owned.Connectors.delete(accountId);
      return { ok: true, ownerId: accountId };
    },
  };

  return {
    calls,
    owned,
    sandboxManager,
    persistenceStore,
    snapshotStore,
    secretStore,
    projectRegistry,
    skillStore,
    memoryStore,
    connectorStore,
  };
}

test('deleteProject releases sandbox + deletes files/snapshots/secrets + drops registry + confirms', async () => {
  const f = makeFakes();
  const audit = createCollectorSink();
  const redactor = createRedactor({ secretValues: ['SECRET_A'] });
  const svc = createRetentionService({
    persistenceStore: f.persistenceStore,
    snapshotStore: f.snapshotStore,
    sandboxManager: f.sandboxManager,
    secretStore: f.secretStore,
    projectRegistry: f.projectRegistry,
    auditSink: audit,
    redactor,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const res = await svc.deleteProject({ id: OWNER }, 'p1');

  // Confirmation object.
  assert.equal(res.ok, true);
  assert.equal(res.confirmed, true);
  assert.equal(res.deleted, 'Project');
  assert.equal(res.projectId, 'p1');

  // Every teardown step fired, exactly for p1.
  assert.deepEqual(f.calls.release, ['p1']);
  assert.deepEqual(f.calls.files, ['p1']);
  assert.deepEqual(f.calls.snapshots, ['p1']);
  assert.deepEqual(f.calls.projectSecrets, ['p1']);

  // Registry entry removed.
  assert.deepEqual(f.projectRegistry.listForOwner(OWNER).map((r) => r.id), ['p2']);

  // A single redacted PROJECT_DELETED event, scoped to the acting account.
  const evts = audit.ofType(AUDIT_EVENTS.PROJECT_DELETED);
  assert.equal(evts.length, 1);
  assert.equal(evts[0].accountId, OWNER);
  assert.equal(evts[0].projectId, 'p1');
});

test('deleteAccount iterates ALL ownerId-keyed categories, leaving none behind, and confirms', async () => {
  const f = makeFakes({ projectIds: ['p1', 'p2', 'p3'] });
  const audit = createCollectorSink();
  const svc = createRetentionService({
    persistenceStore: f.persistenceStore,
    snapshotStore: f.snapshotStore,
    sandboxManager: f.sandboxManager,
    secretStore: f.secretStore,
    projectRegistry: f.projectRegistry,
    skillStore: f.skillStore,
    memoryStore: f.memoryStore,
    connectorStore: f.connectorStore,
    auditSink: audit,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const res = await svc.deleteAccount({ id: OWNER });

  assert.equal(res.ok, true);
  assert.equal(res.confirmed, true);
  assert.equal(res.deleted, 'User_Account');

  // COMPLETENESS: every canonical ownerId-keyed category was handled.
  for (const cat of OWNER_KEYED_CATEGORIES) {
    assert.ok(cat in res.categories, `category ${cat} must be in the confirmation`);
    assert.equal(res.categories[cat].handled, true, `category ${cat} must be handled`);
  }

  // All three projects were fully torn down (loop deleteProject).
  assert.deepEqual(f.calls.release.sort(), ['p1', 'p2', 'p3']);
  assert.deepEqual(f.calls.files.sort(), ['p1', 'p2', 'p3']);
  assert.deepEqual(f.calls.snapshots.sort(), ['p1', 'p2', 'p3']);

  // NO owned data remains in ANY ownerId-keyed category. This is the assertion
  // that mutation-check B flips: skipping a category (e.g. Connectors) leaves
  // owned.Connectors still populated for OWNER.
  assert.equal(f.owned.Projects.get(OWNER)?.length ?? 0, 0, 'no Projects remain');
  assert.equal(f.owned.Skills.has(OWNER), false, 'no Skills remain');
  assert.equal(f.owned.Memory.has(OWNER), false, 'no Project/Global memory remains');
  assert.equal(f.owned.Connectors.has(OWNER), false, 'no Connectors remain');
  assert.equal(f.owned.Secrets.has(OWNER), false, 'no Secrets remain');

  // Exactly one ACCOUNT_DELETED event, carrying the REAL per-category outcome
  // (every category deleted here) plus the canonical list for reference.
  const evts = audit.ofType(AUDIT_EVENTS.ACCOUNT_DELETED);
  assert.equal(evts.length, 1);
  assert.equal(evts[0].accountId, OWNER);
  assert.deepEqual(evts[0].categoryList, OWNER_KEYED_CATEGORIES);
  const allDeleted = Object.fromEntries(OWNER_KEYED_CATEGORIES.map((c) => [c, 'deleted']));
  assert.deepEqual(evts[0].categories, allDeleted);
});

test('ACCOUNT_DELETED audit event records the REAL per-category outcome (deleted vs skipped)', async () => {
  // Optional stores omitted: Skills / Memory / Connectors are skipped.
  const f = makeFakes({ projectIds: [] });
  const audit = createCollectorSink();
  const svc = createRetentionService({
    persistenceStore: f.persistenceStore,
    snapshotStore: f.snapshotStore,
    sandboxManager: f.sandboxManager,
    secretStore: f.secretStore,
    projectRegistry: f.projectRegistry,
    auditSink: audit,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  await svc.deleteAccount({ id: OWNER });

  const evt = audit.ofType(AUDIT_EVENTS.ACCOUNT_DELETED)[0];
  // The audit trail must NOT overstate completeness: skipped categories are
  // recorded as 'skipped', deleted ones as 'deleted'. This is the assertion
  // that flips if the event reverts to emitting the static category list.
  assert.deepEqual(evt.categories, {
    Projects: 'deleted',
    Skills: 'skipped',
    Project_Memory: 'skipped',
    Global_Memory: 'skipped',
    Connectors: 'skipped',
    Secrets: 'deleted',
  });
});

test('strict mode (requireAllCategories) FAILS when an ownerId-keyed store is absent — no fail-open', async () => {
  const f = makeFakes({ projectIds: [] });
  const audit = createCollectorSink();
  const svc = createRetentionService({
    persistenceStore: f.persistenceStore,
    snapshotStore: f.snapshotStore,
    sandboxManager: f.sandboxManager,
    secretStore: f.secretStore,
    projectRegistry: f.projectRegistry,
    // Skills/Memory/Connectors deliberately NOT injected.
    requireAllCategories: true,
    auditSink: audit,
  });

  await assert.rejects(() => svc.deleteAccount({ id: OWNER }), /strict mode/);
  // Fail-closed: it does not confirm and emits NO ACCOUNT_DELETED event.
  assert.equal(audit.ofType(AUDIT_EVENTS.ACCOUNT_DELETED).length, 0);
});

test('strict mode (requireAllCategories) CONFIRMS when every ownerId-keyed store is present', async () => {
  const f = makeFakes({ projectIds: ['p1'] });
  const svc = createRetentionService({
    persistenceStore: f.persistenceStore,
    snapshotStore: f.snapshotStore,
    sandboxManager: f.sandboxManager,
    secretStore: f.secretStore,
    projectRegistry: f.projectRegistry,
    skillStore: f.skillStore,
    memoryStore: f.memoryStore,
    connectorStore: f.connectorStore,
    requireAllCategories: true,
  });

  const res = await svc.deleteAccount({ id: OWNER });
  assert.equal(res.ok, true);
  assert.equal(res.confirmed, true);
});

test('deleteAccount records optional categories with no injected store as skipped (still named)', async () => {
  // Only the required seams + projectRegistry: optional stores omitted.
  const f = makeFakes({ projectIds: [] });
  const svc = createRetentionService({
    persistenceStore: f.persistenceStore,
    snapshotStore: f.snapshotStore,
    sandboxManager: f.sandboxManager,
    secretStore: f.secretStore,
    projectRegistry: f.projectRegistry,
  });

  const res = await svc.deleteAccount({ id: OWNER });
  // Every canonical category is still named in the confirmation, so nothing is
  // silently dropped even when a subsystem is not wired.
  for (const cat of OWNER_KEYED_CATEGORIES) {
    assert.ok(cat in res.categories, `category ${cat} must be named`);
  }
  // Secrets (required) is deleted; the optional ones report skipped.
  assert.equal(res.categories.Secrets.handled, true);
  assert.equal(res.categories.Skills.handled, false);
  assert.equal(res.categories.Connectors.handled, false);
});

test('createRetentionService requires its core seams', () => {
  assert.throws(() => createRetentionService({}), /persistenceStore/);
});
