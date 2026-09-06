/**
 * Project Origins INTEGRATION tests (spec subtask 14.5*, Req 6.4, 6.5, 1.1, 5.2).
 *
 * These wire the ProjectManager create -> populateOrigin pipeline together with
 * the ProjectOrigin and its collaborators to assert the end-to-end TIMING SLOs
 * and the failure/orphan-cleanup guarantee across origins:
 *
 *   (a) github-import: a small repo (<=100 MB) clones within the 120s SLO success path.
 *   (b) github-import: a >100 MB repo reports ongoing progress and honors the
 *       CONFIGURABLE 600s max clone time (default).
 *   (c) failure/orphan-cleanup: a failed import leaves NO running Sandbox —
 *       sandboxManager.release was called (reaped) in the finally + rollback.
 *   (d) creation BEGINS within the 10s SLO (Req 1.1) — reuse the ProjectManager
 *       beginsCreationMs measurement.
 *   (e) Template population within the 30s SLO (Req 5.2) — assert the measured
 *       populateMs surfaced by populateOrigin (from FEAT-002).
 *
 * WHAT IS EMPIRICALLY RUN vs SIMULATED VIA SEAMS (all offline, hermetic):
 *   - SIMULATED VIA SEAMS / INJECTED CLOCKS: the ACTUAL github network fetch is a
 *     scripted `cloner` seam (external clones cannot run offline); the container /
 *     Dev_Server / wall-clock are represented by fakes; and every SLO
 *     (10s begins-creation, 30s template, 120s import, 600s max clone) is
 *     measured against a MANUALLY-ADVANCED injected clock — NOT a real wait.
 *   - EMPIRICALLY RUN (real, local): the PersistenceStore materializes the origin
 *     tree into a REAL temp StorageLayout, so we assert on the actual on-disk
 *     exportable tree. No plumby import, no real agent, no network.
 *
 * Hermeticity: a fresh fs.mkdtemp StorageLayout per test, removed in a finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createStorageLayout } from '../src/storage/layout.js';
import { createPersistenceStore } from '../src/persistence/index.js';
import { createProjectRegistry } from '../src/project/project-registry.js';
import { createProjectManager } from '../src/project/project-manager.js';
import {
  createProjectOrigin,
  TEMPLATE_POPULATE_SLO_MS,
  IMPORT_SMALL_REPO_SLO_MS,
  IMPORT_MAX_CLONE_SLO_MS,
} from '../src/project/project-origins.js';
import { createAuthorizer } from '../src/auth/authorize.js';
import { createTemplateFixtureProvider } from './support/template-fixture.js';

const OWNER = 'acct-int';

/** The documented 10s "begins creation" SLO (Req 1.1). */
const BEGINS_CREATION_SLO_MS = 10_000;

/** A layout rooted at a fresh temp dir so real file I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-origins-int-'));
  return { base, layout: createStorageLayout(base), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/**
 * A MANUALLY-ADVANCED ms clock: reads return the current value; tests call
 * advance(ms) to move wall-clock time forward deterministically (NO real wait).
 * This is the seam the SLOs are measured against.
 */
function manualClock({ start = 0 } = {}) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** A fake SandboxManager recording acquire/exec/release (async release+exec). */
function fakeSandboxManager() {
  const acquireCalls = [];
  const execCalls = [];
  const releaseCalls = [];
  return {
    acquireCalls,
    execCalls,
    releaseCalls,
    acquire(projectId) {
      acquireCalls.push(projectId);
      return { projectId, handle: `sandbox:${projectId}` };
    },
    async exec(projectId, command, opts) {
      execCalls.push({ projectId, command, opts });
      return { stdout: '', stderr: '', exitCode: 0, denied: false, projectId };
    },
    async release(projectId) {
      releaseCalls.push(projectId);
      return { projectId, released: true, reaped: [], errors: [] };
    },
    activeProjectIds() {
      // A running Sandbox is one acquired and not yet released.
      const released = new Set(releaseCalls);
      return [...new Set(acquireCalls)].filter((id) => !released.has(id));
    },
  };
}

/** A fake Dev_Server seam recording start/stop. */
function fakeDevServer() {
  const startCalls = [];
  return {
    startCalls,
    start(args) {
      startCalls.push(args);
      return { ok: true, url: `http://preview.local/${args?.projectId}` };
    },
    stop() {
      return { ok: true };
    },
  };
}

/** A fake agentFactory yielding an agent whose send() resolves. */
function fakeAgentFactory() {
  return () => ({ agent: { async send() {} } });
}

/** A monotonic id factory. */
function seqIdFactory(prefix = 'proj') {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

// --- (a) github-import small repo <=100 MB clones within the 120s SLO -------

test('(a) github-import: a small repo (<=100 MB) clones within the 120s SLO and materializes the cloned tree', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const clock = manualClock({ start: 1000 });
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const authorizer = createAuthorizer();

    // Scripted cloner (SEAM): runs the clone as a bash command through the
    // confined exec seam, advances the INJECTED clock to model a ~40s clone
    // (< the 120s SLO), and returns the cloned tree. No real network.
    const cloner = {
      async clone({ ref, exec, onProgress }) {
        assert.equal(typeof exec, 'function', 'clone runs through the confined Sandbox exec seam');
        await exec(`git clone ${ref} .`, { timeoutMs: IMPORT_SMALL_REPO_SLO_MS });
        clock.advance(40_000); // 40s < 120s SLO (injected clock, not a real wait)
        onProgress({ phase: 'done' });
        return {
          ok: true,
          sizeBytes: 20 * 1024 * 1024, // 20 MB — a small repo
          projectTree: { 'package.json': '{"name":"imported"}\n', 'index.js': "console.log('imported');\n" },
        };
      },
    };
    const projectOrigin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      devServer: fakeDevServer(),
      projectOrigin,
      persistenceStore,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: clock,
      idFactory: seqIdFactory('imp'),
    });

    const created = manager.createProject({
      accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'github-import', ref: 'https://github.com/acme/app.git',
    });
    assert.equal(created.ok, true);

    const populated = await manager.populateOrigin({
      project: created.project,
      sandbox: created.sandbox,
      userAccount: { id: OWNER },
      repoResource: { id: 'https://github.com/acme/app.git', ownerId: OWNER },
    });

    assert.equal(populated.ok, true, 'small-repo import succeeds');
    assert.equal(populated.origin, 'github-import');
    // The clone completed within the 120s SLO (measured against the injected clock).
    assert.ok(typeof populated.populateMs === 'number' && populated.populateMs <= IMPORT_SMALL_REPO_SLO_MS, 'import within the 120s SLO');
    // The cloned tree materialized into the Project's real exportable tree.
    assert.deepEqual(Object.keys(persistenceStore.readPersistedTree(created.project.id)).sort(), ['index.js', 'package.json']);
    // The clone was issued as a confined bash command through the Sandbox exec path.
    assert.equal(sandboxManager.execCalls.length, 1);
    assert.match(sandboxManager.execCalls[0].command, /git clone/);
  } finally {
    cleanup();
  }
});

// --- (b) >100 MB repo reports progress + honors the configurable 600s max ---

test('(b) github-import: a >100 MB repo reports ongoing progress and honors the configurable 600s max clone time', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const clock = manualClock({ start: 0 });
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const authorizer = createAuthorizer();
    const progress = [];

    const cloner = {
      async clone({ exec, onProgress, maxCloneMs, smallRepoMaxBytes }) {
        // The CONFIGURABLE large-repo budget defaults to 600s and is threaded through.
        assert.equal(maxCloneMs, IMPORT_MAX_CLONE_SLO_MS);
        await exec('git clone --progress <ref> .', {});
        // Stream ongoing progress as the large clone proceeds, staying under 600s.
        for (const percent of [20, 40, 60, 80, 100]) {
          clock.advance(100_000); // 5 * 100s = 500s < 600s (injected clock)
          onProgress({ percent });
        }
        return {
          ok: true,
          sizeBytes: smallRepoMaxBytes + 1, // > 100 MB — a large repo
          projectTree: { 'package.json': '{"name":"big"}\n', 'big.bin': Buffer.from([0xff, 0xfe, 0x00, 0x80]) },
        };
      },
    };
    const projectOrigin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      devServer: fakeDevServer(),
      projectOrigin,
      persistenceStore,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: clock,
      idFactory: seqIdFactory('big'),
    });

    const created = manager.createProject({
      accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'github-import', ref: 'https://github.com/acme/big.git',
    });
    assert.equal(created.ok, true);

    const populated = await manager.populateOrigin({
      project: created.project,
      sandbox: created.sandbox,
      userAccount: { id: OWNER },
      repoResource: { id: 'https://github.com/acme/big.git', ownerId: OWNER },
      onProgress: (p) => progress.push(p),
    });

    assert.equal(populated.ok, true, 'large clone under the 600s budget succeeds');
    // Ongoing progress was reported for the large repo (Req 6.5).
    assert.deepEqual(progress.map((p) => p.percent), [20, 40, 60, 80, 100], 'ongoing progress reported');
    // The clone honored the configurable 600s max (it completed in 500s < 600s).
    assert.ok(populated.populateMs <= IMPORT_MAX_CLONE_SLO_MS, 'within the configurable 600s max clone time');
  } finally {
    cleanup();
  }
});

test('(b2) github-import: a large clone EXCEEDING the configurable max clone time aborts, no partial Project, sandbox reaped', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const clock = manualClock({ start: 0 });
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const authorizer = createAuthorizer();
    const cloner = {
      async clone({ exec, smallRepoMaxBytes }) {
        await exec('git clone <ref> .', {});
        clock.advance(700_000); // 700s > 600s max clone time (injected clock)
        return { ok: true, sizeBytes: smallRepoMaxBytes + 1, projectTree: { 'big.bin': Buffer.from([0xff]) } };
      },
    };
    const projectOrigin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });
    const manager = createProjectManager({
      registry, sandboxManager, devServer: fakeDevServer(), projectOrigin, persistenceStore,
      agentFactory: fakeAgentFactory(), verify: () => 'verdict: PASS', now: clock, idFactory: seqIdFactory('slow'),
    });

    const created = manager.createProject({
      accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'github-import', ref: 'https://github.com/acme/big.git',
    });
    assert.equal(created.ok, true);
    assert.equal(registry.countForOwner(OWNER), 1);

    const populated = await manager.populateOrigin({
      project: created.project, sandbox: created.sandbox, userAccount: { id: OWNER },
      repoResource: { id: 'https://github.com/acme/big.git', ownerId: OWNER },
    });

    assert.equal(populated.ok, false);
    assert.equal(populated.code, 'IMPORT_FAILED');
    assert.match(populated.message, /max clone time/);
    // No partial Project, and the Sandbox was reaped (no orphan).
    assert.equal(registry.countForOwner(OWNER), 0, 'no partial Project after exceeding the max clone time');
    assert.ok(sandboxManager.releaseCalls.includes(created.project.id), 'sandbox reaped');
    assert.deepEqual(sandboxManager.activeProjectIds(), [], 'no running Sandbox left');
  } finally {
    cleanup();
  }
});

// --- (c) failure/orphan-cleanup leaves NO running Sandbox -------------------

test('(c) github-import failure: orphan-cleanup leaves NO running Sandbox — release was called in the finally + rollback (Req 6.5)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const clock = manualClock({ start: 0 });
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const authorizer = createAuthorizer();
    // A cloner that fails on an invalid/inaccessible ref.
    const cloner = {
      async clone({ exec }) {
        await exec('git clone <bad-ref> .', {});
        return { ok: false, message: 'repository not found or access denied' };
      },
    };
    const projectOrigin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });
    const manager = createProjectManager({
      registry, sandboxManager, devServer: fakeDevServer(), projectOrigin, persistenceStore,
      agentFactory: fakeAgentFactory(), verify: () => 'verdict: PASS', now: clock, idFactory: seqIdFactory('bad'),
    });

    const created = manager.createProject({
      accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'github-import', ref: 'https://github.com/acme/missing.git',
    });
    assert.equal(created.ok, true);
    // The Sandbox is running immediately after acquire.
    assert.deepEqual(sandboxManager.activeProjectIds(), [created.project.id]);

    const populated = await manager.populateOrigin({
      project: created.project, sandbox: created.sandbox, userAccount: { id: OWNER },
      repoResource: { id: 'https://github.com/acme/missing.git', ownerId: OWNER },
    });

    assert.equal(populated.ok, false);
    assert.equal(populated.code, 'IMPORT_FAILED');
    assert.match(populated.message, /not found or access denied/);
    // The failure path REAPED the Sandbox (origin finally + manager rollback both
    // call release; it is idempotent). No orphaned Sandbox survives.
    assert.ok(sandboxManager.releaseCalls.includes(created.project.id), 'sandboxManager.release was called (reaped)');
    assert.deepEqual(sandboxManager.activeProjectIds(), [], 'no running Sandbox left after the failed import');
    // And no partial Project remains in the registry.
    assert.equal(registry.countForOwner(OWNER), 0, 'no partial Project');
    // No file tree was materialized for the failed import.
    assert.deepEqual(persistenceStore.readPersistedTree(created.project.id), {}, 'no partial tree persisted');
  } finally {
    cleanup();
  }
});

// --- (d) creation BEGINS within the 10s SLO (Req 1.1) -----------------------

test('(d) creation begins within the 10s SLO — beginsCreationMs is measured and within 10s across all origins (Req 1.1)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    // Each createProject reads the clock at start and after acquire. Our fake
    // acquire does no clock advance, so beginsCreationMs reflects the acquire
    // window; we ALSO advance a small, bounded amount to prove the measurement
    // is honest and comfortably within the 10s SLO (all against the injected clock).
    for (const origin of ['blank', 'template']) {
      const clock = manualClock({ start: 5000 });
      const registry = createProjectRegistry({ layout });
      const sandboxManager = {
        acquire(projectId) {
          clock.advance(1500); // model ~1.5s to allocate the Sandbox — well under 10s
          return { projectId, handle: `sandbox:${projectId}` };
        },
        async release() {},
      };
      const manager = createProjectManager({
        registry,
        sandboxManager,
        devServer: fakeDevServer(),
        agentFactory: fakeAgentFactory(),
        verify: () => 'verdict: PASS',
        now: clock,
        idFactory: seqIdFactory(`begin-${origin}`),
      });

      const created = manager.createProject({ accountId: OWNER, description: 'app', targetCategory: 'web', origin });
      assert.equal(created.ok, true, `${origin} create ok`);
      assert.equal(typeof created.beginsCreationMs, 'number');
      assert.ok(created.beginsCreationMs >= 0);
      assert.ok(created.beginsCreationMs <= BEGINS_CREATION_SLO_MS, `${origin} creation begins within the 10s SLO (got ${created.beginsCreationMs}ms)`);
    }
  } finally {
    cleanup();
  }
});

// --- (e) Template population within the 30s SLO (Req 5.2) -------------------

test('(e) template population completes within the 30s SLO — measured populateMs (Req 5.2)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    // The 30s SLO is measured against the injected clock, NOT a real wait: the
    // template branch does no clock advance, so populateMs reflects the (near-
    // zero) assembly time and is comfortably within the 30s bound.
    const clock = manualClock({ start: 0 });
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const templateProvider = createTemplateFixtureProvider();
    const projectOrigin = createProjectOrigin({ persistenceStore, templateProvider, now: clock });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      devServer: fakeDevServer(),
      projectOrigin,
      persistenceStore,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: clock,
      idFactory: seqIdFactory('tmpl'),
    });

    const created = manager.createProject({ accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'template' });
    assert.equal(created.ok, true);

    const populated = await manager.populateOrigin({ project: created.project, sandbox: created.sandbox });
    assert.equal(populated.ok, true, 'template populate ok');
    assert.equal(typeof populated.populateMs, 'number');
    assert.ok(populated.populateMs < TEMPLATE_POPULATE_SLO_MS, `template population within the 30s SLO (got ${populated.populateMs}ms)`);
    // The template tree (incl. the dependency manifest) materialized durably.
    assert.ok(persistenceStore.readPersistedTree(created.project.id)['package.json'], 'dependency manifest materialized');
  } finally {
    cleanup();
  }
});
