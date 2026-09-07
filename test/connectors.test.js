/**
 * Connector subsystem unit tests (node --test) — spec Task 21.3, Req 10.6, 10.7,
 * and the hosting-deploy routing case (Req 10.8).
 *
 * TESTING DISCIPLINE: these exercise REAL collaborators — a REAL StorageLayout on
 * an fs.mkdtemp temp dir, a REAL SecretStore, a REAL ConnectorBindingStore, a
 * REAL ConnectorsSteeringWriter, the REAL createConnectorService, and (for the
 * deploy case) a REAL CommandGuard driven by the REAL plumby classifier through
 * the plumby boundary (src/engine/plumby.js). The ONLY fakes are the external
 * boundaries: the OAuth/API-key capture seam (which returns REAL contracts) and,
 * for deploy, a spy SandboxManager exposing ONLY exec(...) returning the REAL
 * exec contract shape. Assertions are on REAL on-disk bytes / REAL object state.
 *
 * MUTATION SENSITIVITY (which assertion flips if the behavior is reverted) is
 * documented inline per test:
 *   - CAPTURE FAIL/CANCEL/DENY (Req 10.6): if the code were reverted to store the
 *     secret BEFORE checking capture success (or to write a binding/steering on
 *     the failure path), the byte-for-byte / list-length assertions below FLIP:
 *     the SecretStore.list would grow, the binding file bytes would change, and
 *     the steering bytes would change. The "existing connector unchanged" checks
 *     catch a partial write to prior state.
 *   - REMOVAL (Req 10.7): if secret-removal were reverted (binding dropped but
 *     secret left behind), envForProject would STILL yield the NAME:value and
 *     secretStore.get would be non-null — the two removal assertions FLIP.
 *   - DEPLOY ROUTING (Req 10.8): if deployTo bypassed the guard (called exec
 *     directly), a refuse/unapproved-confirm command would reach the exec spy and
 *     the call-count assertions FLIP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createStorageLayout } from '../src/storage/layout.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import { createCommandGuard } from '../src/sandbox/command-guard.js';
import { computeEgressAllowlist } from '../src/sandbox/egress.js';
import {
  createConnectorService,
  createConnectorBindingStore,
  createConnectorsSteeringWriter,
  defaultConnectorCatalog,
} from '../src/connectors/index.js';

const OWNER = 'owner-conn';
const PROJECT = 'proj-conn';

/** A fresh temp-rooted layout + the real stores composed over it. */
function harness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-connectors-'));
  const layout = createStorageLayout(base);
  const secretStore = createSecretStore({ layout, ownerId: OWNER });
  const bindingStore = createConnectorBindingStore({ layout, ownerId: OWNER });
  const steeringWriter = createConnectorsSteeringWriter({ layout });
  return { base, layout, secretStore, bindingStore, steeringWriter };
}

/** A capture seam that SUCCEEDS, returning the given value for each env NAME. */
function successCapture(value) {
  return ({ envNames }) =>
    Object.freeze({
      ok: true,
      credentials: Object.freeze(Object.fromEntries(envNames.map((n) => [n, `${value}:${n}`]))),
    });
}

/** A capture seam that FAILS with the given reason (a REAL failure contract). */
function failCapture(reason) {
  return () => Object.freeze({ ok: false, reason });
}

/** Read a file's exact bytes, or null when absent (for byte-for-byte diffing). */
function readBytes(p) {
  try {
    return fs.readFileSync(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Req 10.6 — capture fail/cancel/deny: nothing partial, existing state intact.
// ─────────────────────────────────────────────────────────────────────────

// Table-drive the three failure reasons and their distinct codes.
const FAILURE_CASES = [
  { reason: 'failed', code: 'CAPTURE_FAILED' },
  { reason: 'cancelled', code: 'CAPTURE_CANCELLED' },
  { reason: 'denied', code: 'CAPTURE_DENIED' },
];

for (const { reason, code } of FAILURE_CASES) {
  test(`capture ${reason} stores nothing partial and leaves existing Connectors/Secrets byte-for-byte unchanged (Req 10.6)`, async () => {
    const { base, layout, secretStore, bindingStore, steeringWriter } = harness();
    try {
      // (1) EXISTING state: add one successful connector first.
      const existing = createConnectorService({
        secretStore,
        bindingStore,
        steeringWriter,
        capture: successCapture('existing'),
        catalog: defaultConnectorCatalog,
      });
      const first = await existing.addConnector({ projectId: PROJECT, service: 'stripe' });
      assert.equal(first.ok, true);
      const [existingName] = defaultConnectorCatalog.get('stripe').envNames;

      // Snapshot the EXACT on-disk bytes + listings that must not change.
      const bindingPath = layout.controlConnectorBindingPath(OWNER, PROJECT);
      const steeringPath = steeringWriter.manifestPathFor(PROJECT);
      const secretPath = layout.controlSecretPath(OWNER, PROJECT, existingName);

      const before = {
        secretNames: secretStore.list(PROJECT),
        bindingServices: bindingStore.list(PROJECT).map((b) => b.connector.service),
        secretValue: secretStore.get(PROJECT, existingName),
        bindingBytes: readBytes(bindingPath),
        steeringBytes: readBytes(steeringPath),
        secretBytes: readBytes(secretPath),
      };
      // Sanity: the existing state is genuinely present (so the checks are real).
      assert.ok(before.secretNames.includes(existingName));
      assert.ok(before.bindingServices.includes('stripe'));
      assert.ok(before.secretValue !== null);
      assert.ok(before.bindingBytes !== null);
      assert.ok(before.steeringBytes !== null);
      assert.ok(before.secretBytes !== null);

      // (2) A SECOND addConnector whose capture returns { ok:false, reason }.
      const failing = createConnectorService({
        secretStore,
        bindingStore,
        steeringWriter,
        capture: failCapture(reason),
        catalog: defaultConnectorCatalog,
      });
      const res = await failing.addConnector({ projectId: PROJECT, service: 'clerk' });

      // The failure is reported with the DISTINCT code (Req 10.6).
      assert.equal(res.ok, false);
      assert.equal(res.code, code);
      assert.equal(res.service, 'clerk');
      assert.equal(res.reason, reason);

      // NO new Secret was stored — the list is unchanged (would GROW if the code
      // stored the credential before checking capture success). MUTATION-CHECK.
      assert.deepEqual(secretStore.list(PROJECT), before.secretNames);
      for (const failedName of defaultConnectorCatalog.get('clerk').envNames) {
        assert.equal(secretStore.get(PROJECT, failedName), null, `${failedName} must not be stored`);
        assert.equal(secretStore.has(PROJECT, failedName), false);
      }

      // NO new/changed binding — the failed service has no binding, and the set
      // of bound services is exactly what it was.
      assert.deepEqual(
        bindingStore.list(PROJECT).map((b) => b.connector.service),
        before.bindingServices,
      );
      assert.equal(bindingStore.get(PROJECT, 'clerk'), null);

      // NO steering change: the failed connector is not mentioned and the file
      // bytes are IDENTICAL to before.
      const steeringAfter = fs.readFileSync(steeringPath, 'utf8');
      assert.ok(!steeringAfter.includes('clerk'), 'failed connector must not surface in steering');

      // BYTE-FOR-BYTE unchanged: the existing connector's secret value, binding
      // file, and steering file are exactly as they were. These are the
      // assertions that FLIP if the no-partial-state guard is reverted.
      assert.equal(secretStore.get(PROJECT, existingName), before.secretValue);
      assert.deepEqual(readBytes(secretPath), before.secretBytes);
      assert.deepEqual(readBytes(bindingPath), before.bindingBytes);
      assert.deepEqual(readBytes(steeringPath), before.steeringBytes);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

test('a capture seam that THROWS is treated as a failure, nothing stored (Req 10.6)', async () => {
  const { base, secretStore, bindingStore, steeringWriter } = harness();
  try {
    const svc = createConnectorService({
      secretStore,
      bindingStore,
      steeringWriter,
      capture: () => {
        throw new Error('oauth window closed');
      },
      catalog: defaultConnectorCatalog,
    });
    const res = await svc.addConnector({ projectId: PROJECT, service: 'stripe' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CAPTURE_FAILED');
    assert.deepEqual(secretStore.list(PROJECT), []);
    assert.deepEqual(bindingStore.list(PROJECT), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Req 10.7 — removal revokes injection and reports it.
// ─────────────────────────────────────────────────────────────────────────

test('removeConnector revokes the Secret injection (get null, envForProject drops NAME, egress drops host) and reports the removal (Req 10.7)', async () => {
  const { base, secretStore, bindingStore, steeringWriter } = harness();
  try {
    const svc = createConnectorService({
      secretStore,
      bindingStore,
      steeringWriter,
      capture: successCapture('secret'),
      catalog: defaultConnectorCatalog,
    });

    // Add successfully: secret stored, binding active, steering written, and the
    // runtime env map materializes the injected NAME:value.
    const service = 'stripe';
    const [envName] = defaultConnectorCatalog.get(service).envNames;
    const host = defaultConnectorCatalog.get(service).hosts[0];
    const added = await svc.addConnector({ projectId: PROJECT, service });
    assert.equal(added.ok, true);

    // Pre-removal reality checks (so the post-removal assertions are meaningful).
    assert.equal(secretStore.get(PROJECT, envName), `secret:${envName}`);
    const envBefore = secretStore.envForProject(PROJECT);
    assert.equal(envBefore[envName], `secret:${envName}`, 'injection materializes NAME:value');
    const egressBefore = computeEgressAllowlist({ bindings: bindingStore.bindingsFor(PROJECT) });
    assert.ok(egressBefore.allowedHosts.includes(host), 'active binding authorizes the connector host');
    const steeringBefore = fs.readFileSync(steeringWriter.manifestPathFor(PROJECT), 'utf8');
    assert.ok(steeringBefore.includes(envName), 'steering references the env NAME while active');

    // --- REMOVE ---------------------------------------------------------
    const report = svc.removeConnector({ projectId: PROJECT, service });

    // The removal REPORT (Req 10.7).
    assert.equal(report.ok, true);
    assert.equal(report.removed, true);
    assert.equal(report.service, service);
    assert.ok(report.revokedSecretRefs.includes(envName), 'report names the revoked secret');

    // INJECTION REVOKED. These two assertions FLIP if secret-removal is reverted
    // (binding dropped but secret left behind): get would be non-null and
    // envForProject would still yield the NAME.  MUTATION-CHECK.
    assert.equal(secretStore.get(PROJECT, envName), null, 'secret value gone after removal');
    const envAfter = secretStore.envForProject(PROJECT);
    assert.equal(
      Object.prototype.hasOwnProperty.call(envAfter, envName),
      false,
      'envForProject no longer injects the removed NAME',
    );

    // EGRESS REVOKED: recomputing over the current (now-absent/removed) bindings
    // no longer allows the connector host.
    const egressAfter = computeEgressAllowlist({ bindings: bindingStore.bindingsFor(PROJECT) });
    assert.ok(!egressAfter.allowedHosts.includes(host), 'removed binding revokes the egress host');

    // STEERING no longer references the removed connector (the manifest was
    // regenerated from the now-empty active set, so the file is removed).
    const manifestPath = steeringWriter.manifestPathFor(PROJECT);
    if (fs.existsSync(manifestPath)) {
      const steeringAfter = fs.readFileSync(manifestPath, 'utf8');
      assert.ok(!steeringAfter.includes(envName), 'steering no longer references the removed NAME');
      assert.ok(!steeringAfter.includes(service));
    } else {
      assert.ok(true, 'steering manifest removed entirely (no active connectors)');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('removeConnector is idempotent on an absent connector and still reports success (Req 10.7)', async () => {
  const { base, secretStore, bindingStore, steeringWriter } = harness();
  try {
    const svc = createConnectorService({
      secretStore,
      bindingStore,
      steeringWriter,
      capture: successCapture('x'),
      catalog: defaultConnectorCatalog,
    });
    const report = svc.removeConnector({ projectId: PROJECT, service: 'neon' });
    assert.equal(report.ok, true);
    assert.equal(report.removed, true);
    assert.deepEqual(bindingStore.list(PROJECT), []);
    assert.deepEqual(secretStore.list(PROJECT), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('removing one connector leaves a co-existing connector fully injected (selective revocation, Req 10.7)', async () => {
  const { base, secretStore, bindingStore, steeringWriter } = harness();
  try {
    const svc = createConnectorService({
      secretStore,
      bindingStore,
      steeringWriter,
      capture: successCapture('v'),
      catalog: defaultConnectorCatalog,
    });
    await svc.addConnector({ projectId: PROJECT, service: 'stripe' });
    await svc.addConnector({ projectId: PROJECT, service: 'neon' });

    const [stripeName] = defaultConnectorCatalog.get('stripe').envNames;
    const [neonName] = defaultConnectorCatalog.get('neon').envNames;

    svc.removeConnector({ projectId: PROJECT, service: 'stripe' });

    // stripe revoked, neon untouched.
    assert.equal(secretStore.get(PROJECT, stripeName), null);
    assert.equal(secretStore.get(PROJECT, neonName), `v:${neonName}`);
    const env = secretStore.envForProject(PROJECT);
    assert.equal(Object.prototype.hasOwnProperty.call(env, stripeName), false);
    assert.equal(env[neonName], `v:${neonName}`);
    // Steering still references the surviving connector.
    const steering = fs.readFileSync(steeringWriter.manifestPathFor(PROJECT), 'utf8');
    assert.ok(steering.includes(neonName));
    assert.ok(!steering.includes(stripeName));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Req 10.8 — hosting-deploy routing through the REAL CommandGuard/classifier.
// ─────────────────────────────────────────────────────────────────────────

/**
 * A fake SandboxManager exposing ONLY exec(projectId, command, {timeoutMs,
 * signal}) and returning the REAL exec contract shape. It is a spy so we can
 * assert call counts — it is the external boundary the guard gates access to.
 */
function spyManager() {
  const calls = [];
  return {
    calls,
    exec: async (projectId, command, opts) => {
      calls.push({ projectId, command, opts });
      return Object.freeze({
        stdout: 'deployed',
        stderr: '',
        exitCode: 0,
        denied: false,
        deniedReason: null,
        timedOut: false,
        signal: null,
        projectId,
      });
    },
  };
}

/** Build a connector service wired to a REAL CommandGuard over a spy manager. */
function deployHarness() {
  const { base, secretStore, bindingStore, steeringWriter } = harness();
  const manager = spyManager();
  // REAL CommandGuard with the REAL plumby classifier (default classify goes
  // through the plumby boundary). An injected clock is not needed for the
  // allow/refuse/synchronous-consent paths; the guard's own ceilings are never
  // reached because consent resolves immediately.
  const guard = createCommandGuard({ manager });
  const svc = createConnectorService({
    secretStore,
    bindingStore,
    steeringWriter,
    capture: successCapture('x'),
    catalog: defaultConnectorCatalog,
    commandGuard: guard,
  });
  return { base, manager, svc };
}

test('deployTo: a benign (allow-class) deploy command reaches exec exactly once (Req 10.8)', async () => {
  const { base, manager, svc } = deployHarness();
  try {
    const res = await svc.deployTo({
      projectId: PROJECT,
      service: 'vercel', // a hosting-deploy connector
      command: 'vercel deploy --prod',
    });
    // The REAL classifier rated it allow; it reached the boundary through the guard.
    assert.equal(res.outcome, 'allow');
    assert.equal(res.executed, true);
    assert.equal(res.denied, false);
    assert.equal(manager.calls.length, 1, 'allow-class deploy reaches exec exactly once');
    assert.equal(manager.calls[0].command, 'vercel deploy --prod');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deployTo: a confirm-class deploy command needs consent — DENY => never executed (Req 10.8)', async () => {
  const { base, manager, svc } = deployHarness();
  try {
    // A git-based deploy that force-pushes (e.g. to a gh-pages branch) is
    // confirm-class per the REAL classifier.
    const res = await svc.deployTo({
      projectId: PROJECT,
      service: 'vercel',
      command: 'git push --force origin gh-pages',
      onConfirmRequest: () => false, // deny consent
    });
    assert.equal(res.outcome, 'confirm');
    assert.equal(res.executed, false);
    assert.equal(res.denied, true);
    // MUTATION-CHECK: if deployTo bypassed the guard, exec would have run.
    assert.equal(manager.calls.length, 0, 'confirm-class deploy must NOT execute without consent');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deployTo: a confirm-class deploy command executes once consent is GRANTED (Req 10.8)', async () => {
  const { base, manager, svc } = deployHarness();
  try {
    const res = await svc.deployTo({
      projectId: PROJECT,
      service: 'vercel',
      command: 'git push --force origin gh-pages',
      onConfirmRequest: () => true, // grant consent
    });
    assert.equal(res.outcome, 'confirm');
    assert.equal(res.confirmed, true);
    assert.equal(res.executed, true);
    assert.equal(manager.calls.length, 1, 'confirm-class deploy runs exactly once when consented');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deployTo: a refuse-class deploy command is NEVER executed (Req 10.8)', async () => {
  const { base, manager, svc } = deployHarness();
  try {
    // A destructive/malformed deploy script is refuse-class per the REAL
    // classifier; consent is irrelevant — it must never reach exec.
    const res = await svc.deployTo({
      projectId: PROJECT,
      service: 'vercel',
      command: 'rm -rf / && vercel deploy',
      onConfirmRequest: () => true,
    });
    assert.equal(res.outcome, 'refuse');
    assert.equal(res.executed, false);
    // MUTATION-CHECK: bypassing the guard would let a refuse-class command run.
    assert.equal(manager.calls.length, 0, 'refuse-class deploy must never reach exec');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('deployTo: a non-hosting-deploy connector is rejected before any guard/exec (Req 10.8)', async () => {
  const { base, manager, svc } = deployHarness();
  try {
    const res = await svc.deployTo({
      projectId: PROJECT,
      service: 'stripe', // category 'payments', not hosting-deploy
      command: 'vercel deploy --prod',
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NOT_A_DEPLOY_CONNECTOR');
    assert.equal(manager.calls.length, 0, 'a non-deploy connector never reaches exec');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
