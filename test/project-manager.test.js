/**
 * ProjectManager tests (spec subtask 13.3*, Req 1.1, 1.3, 1.4, 1.5, 1.6, 1.7,
 * 5.7). Covers the creation-input validation boundaries, the creation-timing /
 * registry / totalProjects-quota behaviour (13.1), and the generation -> verify
 * -> Dev_Server-start / editable-on-fail pipeline branch (13.2), plus the
 * additive POST /projects Builder-Server route wired in FEAT-001.
 *
 * Everything here is HERMETIC and OFFLINE — exactly as context.json mandates:
 *   - a real ProjectRegistry over a temp StorageLayout under os.tmpdir(),
 *     removed in a finally (mirrors test/persistence.test.js);
 *   - a FAKE sandboxManager that RECORDS every acquire(projectId) call (never
 *     provisions a real Sandbox — impossible offline);
 *   - an INJECTED ms clock (a mutable counter) so the "begins creation" SLO is
 *     observable WITHOUT a real wait;
 *   - an INJECTED verify seam returning the plumby 'verdict: PASS'/'verdict:
 *     FAIL' TEXT contract;
 *   - a FAKE Dev_Server seam that RECORDS start/stop calls (launches nothing);
 *   - a lightweight FAKE agentFactory whose agent.send() just resolves (the real
 *     plumby boundary is exercised elsewhere via test/support/scripted-agent.js;
 *     the ProjectManager only needs an agent with send()).
 *
 * MUTATION SENSITIVITY (documented for the reviewer):
 *   - The description boundary asserts BOTH 5000 (accept) and 5001 (reject). An
 *     off-by-one on MAX_DESCRIPTION_CHARS (e.g. `> 5000` -> `>= 5000`, or the
 *     limit set to 5001) flips exactly one of these two cases.
 *   - The pipeline asserts verify-PASS starts the Dev_Server exactly once and
 *     verify-FAIL starts it ZERO times. Mutating the FAIL branch to also start
 *     the Dev_Server flips the FAIL test's `startCalls.length === 0` assertion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStorageLayout } from '../src/storage/layout.js';
import { createProjectRegistry } from '../src/project/project-registry.js';
import { createProjectManager, MAX_DESCRIPTION_CHARS } from '../src/project/project-manager.js';
import { Target_Category, Project_Origin } from '../src/model/enums.js';
import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createQuotaManager } from '../src/ops/quota-manager.js';

const OWNER = 'acct-1';

// ---------------------------------------------------------------- test harness

/** A layout rooted at a fresh temp dir, so real registry file I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-projmgr-'));
  return { base, layout: createStorageLayout(base), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/**
 * A fake SandboxManager that RECORDS every acquire(projectId) call and returns a
 * deterministic handle. It launches no real Sandbox (impossible offline).
 */
function fakeSandboxManager() {
  const acquireCalls = [];
  return {
    acquireCalls,
    acquire(projectId) {
      acquireCalls.push(projectId);
      return { projectId, handle: `sandbox:${projectId}` };
    },
    activeProjectIds() {
      return [...new Set(acquireCalls)];
    },
  };
}

/** A fake Dev_Server seam that RECORDS start/stop calls; launches nothing. */
function fakeDevServer() {
  const startCalls = [];
  const stopCalls = [];
  return {
    startCalls,
    stopCalls,
    start(args) {
      startCalls.push(args);
      return { ok: true, url: `http://preview.local/${args?.projectId}`, startedAt: 'T0' };
    },
    stop(projectId) {
      stopCalls.push(projectId);
      return { ok: true, stopped: true };
    },
    isRunning(projectId) {
      return startCalls.some((c) => c.projectId === projectId);
    },
  };
}

/**
 * A lightweight fake agentFactory: it yields an agent whose send() records the
 * message and resolves. The ProjectManager reaches plumby ONLY through this
 * injected seam, so no plumby import happens in tests (boundary invariant held).
 */
function fakeAgentFactory() {
  const sends = [];
  const factory = () => ({
    agent: {
      cwd: '/tmp/project',
      async send(text) {
        sends.push(text);
      },
    },
  });
  factory.sends = sends;
  return factory;
}

/** An injected ms clock that advances by `step` on each read. */
function steppingClock({ start = 1000, step = 5 } = {}) {
  let t = start;
  const now = () => {
    const v = t;
    t += step;
    return v;
  };
  now.peek = () => t;
  return now;
}

/** Sequential id factory so acquire/register assertions are deterministic. */
function seqIdFactory(prefix = 'proj') {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/** Assemble a ProjectManager over a real registry + all fake seams. */
function makeManager({ layout, quotaManager, snapshotStore, verify, now, idFactory } = {}) {
  const registry = createProjectRegistry({ layout });
  const sandboxManager = fakeSandboxManager();
  const devServer = fakeDevServer();
  const agentFactory = fakeAgentFactory();
  const manager = createProjectManager({
    registry,
    sandboxManager,
    quotaManager,
    snapshotStore,
    devServer,
    agentFactory,
    verify,
    now: now ?? steppingClock(),
    idFactory: idFactory ?? seqIdFactory(),
  });
  return { manager, registry, sandboxManager, devServer, agentFactory };
}

const VALID = { targetCategory: 'web', origin: 'blank' };

// -------------------------------------------------- validation boundary (1.4)

test('validateCreateInput: whitespace-only description is rejected and creates NO project (no acquire)', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const { manager, sandboxManager } = makeManager({ layout });
    for (const description of ['', '   ', '\n\t ']) {
      const created = manager.createProject({ accountId: OWNER, description, ...VALID });
      assert.equal(created.ok, false, `"${description}" must be rejected`);
      assert.equal(created.code, 'DESCRIPTION_REQUIRED');
      assert.equal(created.message, 'a description is required');
    }
    // NO Project was created and NO Sandbox was allocated on the invalid path.
    assert.equal(sandboxManager.acquireCalls.length, 0, 'acquire must never be called on reject');
    assert.equal(makeRegistryCount(base, OWNER), 0, 'registry must stay empty');
  } finally {
    cleanup();
  }
});

test('validateCreateInput: 1-char accepted, 5000-char accepted, 5001-char rejected (5000 boundary is mutation-sensitive)', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const { manager } = makeManager({ layout });
    assert.equal(MAX_DESCRIPTION_CHARS, 5000, 'the limit under test is 5000');

    // 1 char -> accept.
    const one = manager.validateCreateInput({ description: 'x', ...VALID });
    assert.equal(one.ok, true, '1-char description accepted');

    // 5000 chars -> accept. An off-by-one to `>= 5000` would flip THIS case.
    const at = manager.validateCreateInput({ description: 'a'.repeat(5000), ...VALID });
    assert.equal(at.ok, true, 'exactly 5000 chars accepted');
    assert.equal(at.description.length, 5000);

    // 5001 chars -> reject. An off-by-one to `> 5001` would flip THIS case.
    const over = manager.validateCreateInput({ description: 'a'.repeat(5001), ...VALID });
    assert.equal(over.ok, false, 'exactly 5001 chars rejected');
    assert.equal(over.code, 'DESCRIPTION_LENGTH');
    assert.match(over.message, /5,000 characters/);
  } finally {
    cleanup();
  }
});

test('createProject: an over-length description creates NO project and never acquires a Sandbox', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const { manager, sandboxManager } = makeManager({ layout });
    const created = manager.createProject({ accountId: OWNER, description: 'a'.repeat(5001), ...VALID });
    assert.equal(created.ok, false);
    assert.equal(created.code, 'DESCRIPTION_LENGTH');
    assert.equal(sandboxManager.acquireCalls.length, 0);
    assert.equal(makeRegistryCount(base, OWNER), 0);
  } finally {
    cleanup();
  }
});

// -------------------------------------------- enum validation (Req 1.5, 1.6)

test('validateCreateInput: every INVALID Target_Category is rejected naming Target_Category, no project created', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const { manager, sandboxManager } = makeManager({ layout });
    for (const bad of ['desktop', '', 'WEB', 'web ', null, undefined, 42]) {
      const created = manager.createProject({
        accountId: OWNER,
        description: 'a valid description',
        targetCategory: bad,
        origin: 'blank',
      });
      assert.equal(created.ok, false, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(created.code, 'UNSUPPORTED_TARGET_CATEGORY');
      assert.match(created.message, /Target_Category/);
    }
    assert.equal(sandboxManager.acquireCalls.length, 0, 'no acquire on invalid Target_Category');
    assert.equal(makeRegistryCount(base, OWNER), 0, 'no project persisted');
  } finally {
    cleanup();
  }
});

test('validateCreateInput: every INVALID Project_Origin is rejected naming Project_Origin, no project created', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const { manager, sandboxManager } = makeManager({ layout });
    for (const bad of ['clone', '', 'Blank', 'template ', null, undefined, 7]) {
      const created = manager.createProject({
        accountId: OWNER,
        description: 'a valid description',
        targetCategory: 'web',
        origin: bad,
      });
      assert.equal(created.ok, false, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(created.code, 'UNSUPPORTED_ORIGIN');
      assert.match(created.message, /Project_Origin/);
    }
    assert.equal(sandboxManager.acquireCalls.length, 0, 'no acquire on invalid Project_Origin');
    assert.equal(makeRegistryCount(base, OWNER), 0, 'no project persisted');
  } finally {
    cleanup();
  }
});

test('validateCreateInput: every VALID Target_Category and Project_Origin passes validation', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const { manager } = makeManager({ layout });
    for (const targetCategory of Target_Category) {
      const r = manager.validateCreateInput({ description: 'ok', targetCategory, origin: 'blank' });
      assert.equal(r.ok, true, `Target_Category '${targetCategory}' must validate`);
    }
    for (const origin of Project_Origin) {
      const r = manager.validateCreateInput({ description: 'ok', targetCategory: 'web', origin });
      assert.equal(r.ok, true, `Project_Origin '${origin}' must validate`);
    }
  } finally {
    cleanup();
  }
});

// ------------------------------ creation timing / registry / quota (Req 1.1)

test('createProject happy path: registers the project, acquires the Sandbox once, returns the handle, records a clock-measured begins-creation time', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    // A clock that advances 5ms per read: startedAt=1000, ... beganAt reflects
    // exactly the injected delta, proving the SLO is observable without a wait.
    const now = steppingClock({ start: 1000, step: 5 });
    const { manager, registry, sandboxManager } = makeManager({ layout, now, idFactory: seqIdFactory() });

    assert.equal(registry.countForOwner(OWNER), 0);

    const created = manager.createProject({
      accountId: OWNER,
      description: 'build me a todo app',
      ...VALID,
    });
    assert.equal(created.ok, true);
    assert.equal(created.project.id, 'proj-1');
    assert.equal(created.project.ownerId, OWNER);

    // Registered: countForOwner increments.
    assert.equal(registry.countForOwner(OWNER), 1);

    // Exactly ONE acquire, keyed by the new projectId; the Sandbox handle returns.
    assert.equal(sandboxManager.acquireCalls.length, 1, 'acquire called exactly once');
    assert.equal(sandboxManager.acquireCalls[0], 'proj-1');
    assert.deepEqual(created.sandbox, { projectId: 'proj-1', handle: 'sandbox:proj-1' });

    // The begins-creation time is measured from the injected clock. With reads
    // at startedAt (1000) then beganAt (later), the elapsed is a positive
    // multiple of the injected step — observable, not a real wait.
    assert.equal(typeof created.beginsCreationMs, 'number');
    assert.ok(created.beginsCreationMs > 0, 'begins-creation elapsed is positive (from the injected clock)');
    assert.ok(created.beginsCreationMs < 10_000, 'well within the 10s begins-creation SLO');
  } finally {
    cleanup();
  }
});

test('createProject: over the totalProjects quota is refused naming the limit, with NO acquire and NO registry write', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const devServer = fakeDevServer();
    // A QuotaManager whose totalProjects ceiling is 0, using the registry's
    // countForOwner as the projectCounter seam — so ANY create is over-quota.
    const quotaManager = createQuotaManager({
      config: { quota: { maxTotalProjects: 0 } },
      projectCounter: (accountId) => registry.countForOwner(accountId),
    });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      quotaManager,
      devServer,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: steppingClock(),
      idFactory: seqIdFactory(),
    });

    const created = manager.createProject({ accountId: OWNER, description: 'nope', ...VALID });
    assert.equal(created.ok, false);
    assert.equal(created.code, 'QUOTA_EXCEEDED');
    assert.equal(created.limit, 'Resource_Quota');
    assert.equal(created.resource, 'totalProjects');
    assert.match(created.message, /max total Projects/);

    // NO allocation and NO registry write on the over-quota path.
    assert.equal(sandboxManager.acquireCalls.length, 0, 'no acquire when over quota');
    assert.equal(registry.countForOwner(OWNER), 0, 'no project persisted when over quota');
  } finally {
    cleanup();
  }
});

test('createProject: over the concurrentSandboxes quota is refused naming the limit BEFORE acquire, with NO acquire and NO registry write (review finding 1)', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const devServer = fakeDevServer();
    // A QuotaManager whose concurrent-Sandbox ceiling is 0 (via a fixed
    // concurrency counter) so ANY create is over the concurrent boundary — the
    // same ceiling the /message path enforces. totalProjects is left generous.
    const quotaManager = createQuotaManager({
      config: { quota: { maxConcurrentSandboxes: 0, maxTotalProjects: 50 } },
      projectCounter: (accountId) => registry.countForOwner(accountId),
      concurrencyCount: () => 0,
    });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      quotaManager,
      devServer,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: steppingClock(),
      idFactory: seqIdFactory(),
    });

    const created = manager.createProject({ accountId: OWNER, description: 'nope', ...VALID });
    assert.equal(created.ok, false);
    assert.equal(created.code, 'QUOTA_EXCEEDED');
    assert.equal(created.limit, 'Resource_Quota');
    assert.equal(created.resource, 'concurrentSandboxes');
    assert.match(created.message, /concurrent Sandboxes/);

    // Refused BEFORE any allocation and BEFORE any registry write — matching the
    // gate ordering (quota -> acquire). If the concurrentSandboxes gate were
    // removed, acquire would run and this assertion would flip.
    assert.equal(sandboxManager.acquireCalls.length, 0, 'no acquire when over concurrent quota');
    assert.equal(registry.countForOwner(OWNER), 0, 'no project persisted when over concurrent quota');
  } finally {
    cleanup();
  }
});

test('createProject: rolls back the registry entry when acquire throws AFTER registration — no partial Project (review finding 5)', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    // A SandboxManager whose acquire THROWS (simulating a provisioning failure
    // after the record has been registered).
    const acquireCalls = [];
    const sandboxManager = {
      acquire(projectId) {
        acquireCalls.push(projectId);
        throw new Error('provisioning failed');
      },
      activeProjectIds() {
        return [];
      },
    };
    const manager = createProjectManager({
      registry,
      sandboxManager,
      devServer: fakeDevServer(),
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: steppingClock(),
      idFactory: seqIdFactory(),
    });

    const created = manager.createProject({ accountId: OWNER, description: 'app', ...VALID });
    assert.equal(created.ok, false);
    assert.equal(created.code, 'SANDBOX_ACQUIRE_FAILED');
    assert.equal(acquireCalls.length, 1, 'acquire was attempted (after registration)');

    // The compensating rollback removed the registry entry — no orphaned record.
    // Without the rollback this count would be 1 (a partial Project).
    assert.equal(registry.countForOwner(OWNER), 0, 'registry has NO leftover entry after acquire failure');
    assert.equal(makeRegistryCount(base, OWNER), 0, 'on-disk registry has NO leftover entry');
    // The projectId no longer resolves — nothing partial survives.
    assert.equal(registry.get('proj-1'), null, 'the rolled-back project does not resolve');
  } finally {
    cleanup();
  }
});

// ---------------------------- registry concurrency + lookup (findings 2, 3) --

test('registry.register: concurrent CROSS-PROCESS registrations for one owner do not clobber each other (review finding 2)', async () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    // Genuinely concurrent registrations must exercise the cross-process lock:
    // spawn N child processes that each register a distinct project for the SAME
    // owner into the SAME on-disk registry, started as close to simultaneously
    // as possible. Without the per-owner file lock, overlapping read-modify-write
    // cycles clobber each other and the final count is < N (a lost update).
    const N = 12;
    const workers = Array.from({ length: N }, (_, i) =>
      runRegisterWorker({ base, ownerId: OWNER, projectId: `p-${i}`, index: i }),
    );
    const codes = await Promise.all(workers);
    assert.ok(codes.every((c) => c === 0), `all ${N} register workers exit 0 (codes: ${codes})`);

    // EVERY record survived — no lost update under real concurrency.
    const registry = createProjectRegistry({ layout });
    assert.equal(registry.countForOwner(OWNER), N, `all ${N} concurrent registrations must survive`);
    for (let i = 0; i < N; i += 1) {
      assert.ok(registry.get(`p-${i}`), `p-${i} must be resolvable`);
    }
  } finally {
    cleanup();
  }
});

test('registry.get/resolver: resolves across MANY owners via the index without a full scan (review finding 3)', () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    // Register one project each for several owners.
    const owners = ['acct-a', 'acct-b', 'acct-c', 'acct-d'];
    owners.forEach((ownerId, i) => {
      registry.register({
        id: `proj-${ownerId}`,
        ownerId,
        description: `d${i}`,
        targetCategory: 'web',
        origin: 'blank',
        sandboxId: `proj-${ownerId}`,
        targets: [],
        snapshots: [],
        connectors: [],
        provider: 'anthropic',
        model: 'claude-sonnet',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
    });

    // Each project resolves to its correct owner, cross-owner.
    for (const ownerId of owners) {
      const rec = registry.get(`proj-${ownerId}`);
      assert.ok(rec, `proj-${ownerId} resolves`);
      assert.equal(rec.ownerId, ownerId);
      assert.deepEqual(registry.resolver(`proj-${ownerId}`), { id: `proj-${ownerId}`, ownerId });
    }
    // An unknown id resolves to null (deny without disclosure).
    assert.equal(registry.get('nope'), null);
    assert.equal(registry.resolver('nope'), null);

    // The projectId -> ownerId index exists on disk and maps every project to
    // its owner, so lookups do not need to scan every owner file.
    const indexPath = path.join(base, 'control-plane', 'registry', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const ownerId of owners) {
      assert.equal(index[`proj-${ownerId}`], ownerId, `index maps proj-${ownerId} -> ${ownerId}`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------- generation -> verify -> Dev_Server (1.3, 1.7)

test('pipeline: verify PASS starts the Dev_Server exactly once and commits a turn-pass snapshot', async () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const snapshotCalls = [];
    const snapshotStore = {
      onTurnComplete(args) {
        snapshotCalls.push(args);
        return { ok: true, committed: true, snapshotId: 'snap-1', trigger: 'turn-pass' };
      },
    };
    const { manager, devServer } = makeManager({
      layout,
      snapshotStore,
      verify: () => 'verdict: PASS\nall checks green',
    });

    const created = manager.createProject({ accountId: OWNER, description: 'app', ...VALID });
    assert.equal(created.ok, true);

    const projectTree = { 'index.js': 'export const x = 1;\n' };
    const result = await manager.runGeneration({
      project: created.project,
      sandbox: created.sandbox,
      message: 'build it',
      projectTree,
    });

    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'PASS');
    // Dev_Server started EXACTLY once, keyed by the project id.
    assert.equal(devServer.startCalls.length, 1, 'Dev_Server started exactly once on PASS');
    assert.equal(devServer.startCalls[0].projectId, created.project.id);
    // The turn-pass snapshot policy was REUSED (not reinvented).
    assert.equal(snapshotCalls.length, 1, 'snapshotStore.onTurnComplete reused on PASS');
    assert.equal(snapshotCalls[0].projectId, created.project.id);
    assert.equal(snapshotCalls[0].verifyResult.verdict, 'PASS');
    assert.deepEqual(snapshotCalls[0].projectTree, projectTree);
    assert.ok(result.snapshot && result.snapshot.committed === true);
  } finally {
    cleanup();
  }
});

test('pipeline: verify FAIL does NOT start the Dev_Server, surfaces the captured error, leaves files editable (verify-branch is mutation-sensitive)', async () => {
  const { base, layout, cleanup } = tempLayout();
  try {
    const snapshotCalls = [];
    const snapshotStore = {
      onTurnComplete(args) {
        snapshotCalls.push(args);
        return { ok: true, committed: true };
      },
    };
    const failText = 'verdict: FAIL\nexit code: 1\nsrc/app.js:10 SyntaxError: unexpected token';
    const { manager, devServer } = makeManager({
      layout,
      snapshotStore,
      verify: () => failText,
    });

    const created = manager.createProject({ accountId: OWNER, description: 'app', ...VALID });
    assert.equal(created.ok, true);

    const result = await manager.runGeneration({
      project: created.project,
      sandbox: created.sandbox,
      message: 'build it',
      projectTree: { 'index.js': 'boom(' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.verdict, 'FAIL');
    // The Dev_Server was NOT started. Mutating the FAIL branch to also start it
    // flips THIS assertion (the mutation-sensitivity guarantee).
    assert.equal(devServer.startCalls.length, 0, 'Dev_Server NOT started on FAIL');
    // The captured error output is surfaced.
    assert.match(result.outputTail, /SyntaxError/);
    // Files are left editable (no destructive tree change); NO turn-pass snapshot.
    assert.equal(result.editable, true, 'files remain editable on FAIL');
    assert.equal(snapshotCalls.length, 0, 'no turn-pass snapshot committed on FAIL');
  } finally {
    cleanup();
  }
});

// ----------------- PreviewController wiring in finalizePass (Task 18, additive)

/**
 * A fake PreviewController that RECORDS start/publish calls. Used to prove the
 * ProjectManager PASS path routes through it when injected, and never touches it
 * on FAIL. Launches nothing (offline seam).
 */
function fakePreviewController() {
  const startCalls = [];
  const publishCalls = [];
  return {
    startCalls,
    publishCalls,
    start(args) {
      startCalls.push(args);
      return { ok: true, status: 'ready', url: `http://preview.local/${args?.projectId}`, startupMs: 1, previewAvailableMs: 2 };
    },
    publish(args) {
      publishCalls.push(args);
      return { ok: true, status: 'served', snapshotId: args?.snapshotId, publishMs: 1, showingPrior: false };
    },
  };
}

/** Assemble a ProjectManager with an injected PreviewController + fakes. */
function makeManagerWithPreview({ layout, previewController, verify, snapshotStore } = {}) {
  const registry = createProjectRegistry({ layout });
  const sandboxManager = fakeSandboxManager();
  const devServer = fakeDevServer();
  const agentFactory = fakeAgentFactory();
  const manager = createProjectManager({
    registry,
    sandboxManager,
    snapshotStore,
    previewController,
    devServer,
    agentFactory,
    verify,
    now: steppingClock(),
    idFactory: seqIdFactory(),
  });
  return { manager, registry, sandboxManager, devServer, previewController };
}

test('pipeline: with an injected PreviewController, a verify-PASS turn publishes the committed snapshot exactly once and starts the preview lifecycle', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const snapshotStore = {
      onTurnComplete() {
        return { ok: true, committed: true, snapshotId: 'snap-77', trigger: 'turn-pass' };
      },
    };
    const previewController = fakePreviewController();
    const { manager, devServer } = makeManagerWithPreview({
      layout,
      previewController,
      snapshotStore,
      verify: () => 'verdict: PASS',
    });

    const created = manager.createProject({ accountId: OWNER, description: 'app', ...VALID });
    const result = await manager.runGeneration({
      project: created.project,
      sandbox: created.sandbox,
      message: 'build it',
      projectTree: { 'index.js': 'export const x = 1;\n' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'PASS');
    // Routed THROUGH the PreviewController: its start was called, and the direct
    // devServer.start was NOT (the controller owns the lifecycle now).
    assert.equal(previewController.startCalls.length, 1, 'preview lifecycle started via the controller');
    assert.equal(devServer.startCalls.length, 0, 'direct devServer.start bypassed when a controller is injected');
    // The committed snapshot was published EXACTLY once with buildOk:true.
    assert.equal(previewController.publishCalls.length, 1, 'committed snapshot published exactly once');
    assert.equal(previewController.publishCalls[0].snapshotId, 'snap-77');
    assert.equal(previewController.publishCalls[0].buildOk, true);
  } finally {
    cleanup();
  }
});

test('pipeline: with an injected PreviewController, a verify-FAIL turn publishes ZERO times and starts NO preview (FAIL branch is mutation-sensitive)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const previewController = fakePreviewController();
    const { manager, devServer } = makeManagerWithPreview({
      layout,
      previewController,
      verify: () => 'verdict: FAIL\nexit code: 1\nboom',
    });

    const created = manager.createProject({ accountId: OWNER, description: 'app', ...VALID });
    const result = await manager.runGeneration({
      project: created.project,
      sandbox: created.sandbox,
      message: 'build it',
      projectTree: { 'index.js': 'boom(' },
    });

    assert.equal(result.ok, false);
    assert.equal(result.verdict, 'FAIL');
    // A FAIL must neither start the preview lifecycle nor publish anything. A
    // mutation that started/published on FAIL flips these assertions.
    assert.equal(previewController.startCalls.length, 0, 'no preview start on FAIL');
    assert.equal(previewController.publishCalls.length, 0, 'no publish on FAIL');
    assert.equal(devServer.startCalls.length, 0, 'Dev_Server not started on FAIL');
  } finally {
    cleanup();
  }
});

test('pipeline: with NO PreviewController the existing direct devServer.start behavior is unchanged (byte-identical, additive)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const { manager, devServer } = makeManager({
      layout,
      verify: () => 'verdict: PASS',
    });
    const created = manager.createProject({ accountId: OWNER, description: 'app', ...VALID });
    const result = await manager.runGeneration({
      project: created.project,
      sandbox: created.sandbox,
      message: 'build it',
      projectTree: { 'index.js': 'export const x = 1;\n' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'PASS');
    // No controller: the direct devServer.start still runs exactly once.
    assert.equal(devServer.startCalls.length, 1, 'direct devServer.start unchanged with no controller');
    assert.equal(result.preview, undefined, 'no preview field emitted without a controller');
  } finally {
    cleanup();
  }
});

// ---------------------------- POST /projects endpoint (Req 1.4, gate reuse) --

/** A fake IdP verifier: any idToken maps to a stable subject. */
function fakeIdp(subject = 'user-1') {
  return {
    async verifyIdToken(idToken) {
      if (!idToken) throw new Error('no token');
      return { provider: 'github', subject: `${subject}:${idToken}` };
    },
  };
}

/** Construct an AuthService and mint a real session token for one account. */
async function authWithToken(idToken = 'tok') {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { account } = await authService.authenticate({ idToken });
  const session = authService.scopeSession(account);
  return { authService, account, token: session.token };
}

/** Start a Builder Server on an ephemeral port; returns base URL + close(). */
async function startServer(opts) {
  const server = createBuilderServer(opts);
  const { port, host } = await server.listen(0, '127.0.0.1');
  return { server, base: `http://${host}:${port}`, close: () => server.close() };
}

test('POST /projects: authenticated valid create returns 201 and creates the Project', async () => {
  const { base: tmpBase, layout, cleanup } = tempLayout();
  try {
    const { authService, account, token } = await authWithToken();
    const { manager, registry, sandboxManager } = makeManager({ layout });

    const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory(), projectManager: manager });
    try {
      const res = await fetch(`${base}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ description: 'a todo app', targetCategory: 'web', origin: 'blank' }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.ok(typeof body.id === 'string' && body.id.length > 0, 'created project id returned');
      assert.equal(body.project.ownerId, account.id);
      // The Project is really registered and the Sandbox was acquired once.
      assert.equal(registry.countForOwner(account.id), 1);
      assert.equal(sandboxManager.acquireCalls.length, 1);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('POST /projects: an invalid description returns 400 with the specific message and NO Project', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const { authService, account, token } = await authWithToken();
    const { manager, registry, sandboxManager } = makeManager({ layout });

    const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory(), projectManager: manager });
    try {
      const res = await fetch(`${base}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ description: '   ', targetCategory: 'web', origin: 'blank' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'a description is required');
      // No allocation, no registry write.
      assert.equal(registry.countForOwner(account.id), 0);
      assert.equal(sandboxManager.acquireCalls.length, 0);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test("POST /projects: over-rate 'project.create' returns 429 naming the limit with NO allocation", async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const { authService, account, token } = await authWithToken();
    const { manager, registry, sandboxManager } = makeManager({ layout });
    // A QuotaManager whose project.create Rate_Limit is 0/window — so the very
    // first create is over-rate, refused BEFORE any allocation.
    const quotaManager = createQuotaManager({
      config: { rate: { 'project.create': { max: 0, windowMs: 60_000 } } },
    });

    const { base, close } = await startServer({
      authService,
      agentFactory: fakeAgentFactory(),
      projectManager: manager,
      quotaManager,
    });
    try {
      const res = await fetch(`${base}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ description: 'a todo app', targetCategory: 'web', origin: 'blank' }),
      });
      assert.equal(res.status, 429);
      const body = await res.json();
      assert.equal(body.limit, 'Rate_Limit');
      assert.equal(body.operation, 'project.create');
      assert.match(body.error, /Rate_Limit exceeded/);
      // Refused before any allocation.
      assert.equal(registry.countForOwner(account.id), 0);
      assert.equal(sandboxManager.acquireCalls.length, 0);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

test('POST /projects: unauthenticated request is denied 401 with no disclosure and no allocation', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const authService = createAuthService({ idpVerifier: fakeIdp() });
    const { manager, registry, sandboxManager } = makeManager({ layout });
    const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory(), projectManager: manager });
    try {
      const res = await fetch(`${base}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: 'a todo app', targetCategory: 'web', origin: 'blank' }),
      });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'access denied' });
      assert.equal(registry.countForOwner(OWNER), 0);
      assert.equal(sandboxManager.acquireCalls.length, 0);
    } finally {
      await close();
    }
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------- test helpers

/**
 * Spawn a child Node process that registers ONE project into the shared on-disk
 * registry under `base`, for cross-process concurrency testing (review finding
 * 2). All workers target the SAME owner file, so the per-owner cross-process
 * lock is what keeps their read-modify-write cycles from clobbering each other.
 * Resolves with the child's exit code.
 */
function runRegisterWorker({ base, ownerId, projectId, index }) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const registryModule = path.resolve(here, '../src/project/project-registry.js');
  const layoutModule = path.resolve(here, '../src/storage/layout.js');
  const src = `
    import { createStorageLayout } from ${JSON.stringify(layoutModule)};
    import { createProjectRegistry } from ${JSON.stringify(registryModule)};
    const layout = createStorageLayout(${JSON.stringify(base)});
    const registry = createProjectRegistry({ layout });
    registry.register({
      id: ${JSON.stringify(projectId)},
      ownerId: ${JSON.stringify(ownerId)},
      description: 'project ' + ${JSON.stringify(index)},
      targetCategory: 'web',
      origin: 'blank',
      sandboxId: ${JSON.stringify(projectId)},
      targets: [], snapshots: [], connectors: [],
      provider: 'anthropic', model: 'claude-sonnet',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && stderr) process.stderr.write(`register worker ${projectId} stderr: ${stderr}\n`);
      resolve(code);
    });
  });
}

/** Count persisted projects for an owner by reading the on-disk registry file. */
function makeRegistryCount(base, ownerId) {
  const p = path.join(base, 'control-plane', 'registry', ownerId, 'projects.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
}
