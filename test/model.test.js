/**
 * Data-model factory tests (node --test).
 *
 * Each factory accepts a valid record and rejects invalid enum values with a
 * clear error. Also asserts the design-mandated invariants: MemoryStoreMeta
 * defaults, ConnectorBinding.secretRefs are names only, and the Secret record
 * carries ciphertext/wrappedDataKey and NO plaintext value field.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createUserAccount,
  createAuthorization,
  createProject,
  createTarget,
  createSnapshot,
  createConnector,
  createConnectorBinding,
  createSecret,
  createSkill,
  createMemoryEntry,
  createMemoryStoreMeta,
  createDeploymentArtifact,
  createShareLink,
  createVerifyResult,
  MEMORY_STORE_DEFAULTS,
} from '../src/model/index.js';

const NOW = '2024-01-01T00:00:00.000Z';

test('User_Account: valid record; rejects missing fields', () => {
  const acct = createUserAccount({ id: 'u1', authIdentity: 'auth0|abc', createdAt: NOW });
  assert.deepEqual(acct, { id: 'u1', authIdentity: 'auth0|abc', createdAt: NOW });
  assert.throws(() => createUserAccount({ id: 'u1', createdAt: NOW }), /authIdentity/);
});

test('Authorization: valid record; rejects bad resourceType and relation', () => {
  const authz = createAuthorization({
    userAccountId: 'u1',
    resourceType: 'project',
    resourceId: 'p1',
    relation: 'owner',
  });
  assert.equal(authz.relation, 'owner');
  assert.throws(
    () => createAuthorization({ userAccountId: 'u1', resourceType: 'bad', resourceId: 'p1', relation: 'owner' }),
    /resourceType/,
  );
  assert.throws(
    () => createAuthorization({ userAccountId: 'u1', resourceType: 'project', resourceId: 'p1', relation: 'maybe' }),
    /relation/,
  );
});

function validProject(overrides = {}) {
  return createProject({
    id: 'p1',
    ownerId: 'u1',
    description: 'a demo app',
    targetCategory: 'web',
    origin: 'blank',
    targets: [],
    sandboxId: 'sb1',
    snapshots: [],
    connectors: [],
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

test('Project: valid record; rejects invalid targetCategory, origin, provider', () => {
  const p = validProject();
  assert.equal(p.targetCategory, 'web');
  assert.equal(p.originRef, undefined);
  assert.throws(() => validProject({ targetCategory: 'desktop' }), /targetCategory/);
  assert.throws(() => validProject({ origin: 'zip-upload' }), /origin/);
  assert.throws(() => validProject({ provider: 'openai' }), /provider/);
});

test('Target: valid record; rejects invalid kind', () => {
  const t = createTarget({ kind: 'backend', rootPath: 'api' });
  assert.equal(t.kind, 'backend');
  assert.throws(() => createTarget({ kind: 'desktop', rootPath: 'x' }), /kind/);
});

test('Snapshot: valid record; rejects invalid trigger', () => {
  const s = createSnapshot({ id: 'sha1', projectId: 'p1', createdAt: NOW, trigger: 'turn-pass' });
  assert.equal(s.trigger, 'turn-pass');
  assert.equal(s.parentId, undefined);
  assert.throws(
    () => createSnapshot({ id: 'sha1', projectId: 'p1', createdAt: NOW, trigger: 'auto' }),
    /trigger/,
  );
});

test('Connector: valid record; rejects invalid category and captureKind', () => {
  const c = createConnector({ service: 'supabase', category: 'database', captureKind: 'api-key' });
  assert.equal(c.category, 'database');
  assert.throws(
    () => createConnector({ service: 'x', category: 'analytics', captureKind: 'api-key' }),
    /category/,
  );
  assert.throws(
    () => createConnector({ service: 'x', category: 'database', captureKind: 'password' }),
    /captureKind/,
  );
});

test('ConnectorBinding: secretRefs are NAMES only; rejects non-string refs and bad status', () => {
  const binding = createConnectorBinding({
    connector: { service: 'stripe', category: 'payments', captureKind: 'api-key' },
    secretRefs: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    status: 'active',
  });
  assert.deepEqual(binding.secretRefs, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
  // No secret VALUES anywhere in the binding — refs are strings, not objects.
  for (const ref of binding.secretRefs) assert.equal(typeof ref, 'string');
  assert.throws(
    () =>
      createConnectorBinding({
        connector: { service: 'stripe', category: 'payments', captureKind: 'api-key' },
        secretRefs: [{ name: 'STRIPE_SECRET_KEY', value: 'sk_live_leak' }],
        status: 'active',
      }),
    /secretRefs\[0\] must be a non-empty string/,
  );
  assert.throws(
    () =>
      createConnectorBinding({
        connector: { service: 'stripe', category: 'payments', captureKind: 'api-key' },
        secretRefs: [],
        status: 'paused',
      }),
    /status/,
  );
});

test('Secret: carries ciphertext + wrappedDataKey and NO plaintext value field', () => {
  const secret = createSecret({
    projectId: 'p1',
    name: 'DATABASE_URL',
    ciphertext: new Uint8Array([1, 2, 3]),
    wrappedDataKey: new Uint8Array([4, 5, 6]),
  });
  assert.ok(secret.ciphertext instanceof Uint8Array);
  assert.ok(secret.wrappedDataKey instanceof Uint8Array);
  assert.equal('value' in secret, false, 'Secret must not have a plaintext value field');
  // A caller trying to smuggle a plaintext value is rejected outright.
  assert.throws(
    () =>
      createSecret({
        projectId: 'p1',
        name: 'DATABASE_URL',
        value: 'postgres://leak',
        ciphertext: new Uint8Array([1]),
        wrappedDataKey: new Uint8Array([2]),
      }),
    /must never carry a plaintext `value` field/,
  );
  // Missing ciphertext is rejected.
  assert.throws(
    () => createSecret({ projectId: 'p1', name: 'X', wrappedDataKey: new Uint8Array([1]) }),
    /ciphertext/,
  );
});

test('Skill: valid user + stocked; user requires ownerId; rejects invalid kind', () => {
  const userSkill = createSkill({
    name: 'deploy',
    invocationName: 'user/deploy',
    description: 'deploy helper',
    body: '# Deploy',
    kind: 'user',
    ownerId: 'u1',
    path: '/skills/user/deploy',
  });
  assert.equal(userSkill.ownerId, 'u1');

  const stocked = createSkill({
    name: 'lint',
    invocationName: 'lint',
    description: 'lint helper',
    body: '# Lint',
    kind: 'stocked',
    path: '/skills/lint',
  });
  assert.equal('ownerId' in stocked, false);

  assert.throws(
    () => createSkill({ name: 'x', invocationName: 'x', description: '', body: '', kind: 'user', path: '/p' }),
    /requires an ownerId/,
  );
  assert.throws(
    () => createSkill({ name: 'x', invocationName: 'x', description: '', body: '', kind: 'plugin', path: '/p' }),
    /kind/,
  );
});

test('MemoryEntry: valid record; rejects invalid scope, kind, origin', () => {
  const entry = createMemoryEntry({
    id: 'm1',
    scope: 'project',
    kind: 'decision',
    text: 'use ESM',
    createdAt: NOW,
    origin: 'auto',
  });
  assert.equal(entry.kind, 'decision');
  assert.throws(() => createMemoryEntry({ id: 'm1', scope: 'team', kind: 'decision', text: '', createdAt: NOW, origin: 'auto' }), /scope/);
  assert.throws(() => createMemoryEntry({ id: 'm1', scope: 'project', kind: 'idea', text: '', createdAt: NOW, origin: 'auto' }), /kind/);
  assert.throws(() => createMemoryEntry({ id: 'm1', scope: 'project', kind: 'decision', text: '', createdAt: NOW, origin: 'system' }), /origin/);
});

test('MemoryStoreMeta: defaults mode=auto, capBytes=65536, capEntries=200', () => {
  const meta = createMemoryStoreMeta({ scope: 'project' });
  assert.equal(meta.mode, 'auto');
  assert.equal(meta.capBytes, 65536);
  assert.equal(meta.capEntries, 200);
  assert.deepEqual(MEMORY_STORE_DEFAULTS, { mode: 'auto', capBytes: 65536, capEntries: 200 });
  // Explicit overrides win, but a bad mode is rejected.
  assert.equal(createMemoryStoreMeta({ scope: 'global', mode: 'off' }).mode, 'off');
  assert.throws(() => createMemoryStoreMeta({ scope: 'project', mode: 'paused' }), /mode/);
});

test('DeploymentArtifact: valid record; rejects invalid targetKind', () => {
  const art = createDeploymentArtifact({ targetKind: 'web', path: 'dist', exitStatus: 0 });
  assert.equal(art.exitStatus, 0);
  assert.throws(() => createDeploymentArtifact({ targetKind: 'desktop', path: 'dist', exitStatus: 0 }), /targetKind/);
});

test('ShareLink: valid record defaults access read-only + revoked false; rejects bad access', () => {
  const link = createShareLink({ token: 'tok', projectId: 'p1', createdAt: NOW, expiresAt: NOW });
  assert.equal(link.access, 'read-only');
  assert.equal(link.revoked, false);
  assert.throws(
    () => createShareLink({ token: 'tok', projectId: 'p1', access: 'read-write', createdAt: NOW, expiresAt: NOW }),
    /access/,
  );
});

test('VerifyResult: valid record; rejects invalid verdict', () => {
  const vr = createVerifyResult({ verdict: 'PASS', exitCode: 0, failureLines: '', outputTail: 'ok' });
  assert.equal(vr.verdict, 'PASS');
  assert.throws(() => createVerifyResult({ verdict: 'MAYBE', exitCode: 1 }), /verdict/);
});
