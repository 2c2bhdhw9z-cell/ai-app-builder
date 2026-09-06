/**
 * ProjectOrigin tests (spec subtask 14.1, Req 6.1-6.3, 6.8, 6.9, 5.2, 5.3).
 *
 * Covers the two origins this feature (FEAT-002) implements — 'blank' and
 * 'template' — plus the wiring that converges ALL origins onto the existing
 * ProjectManager runGeneration pipeline:
 *
 *   - blank (Req 6.2, Property 11 seed): produces ONLY minimal genuinely-runnable
 *     files (a package.json with a start script + a single entry file), NO
 *     Template applied. A mutation that writes nothing runnable (empty tree / no
 *     start script) is called out as flipping the runnability assertions here.
 *   - template (Req 6.3, 5.2): copies the fixture Template for the selected
 *     Target_Category, populates ALL its files + the dependency manifest, and
 *     exposes a measured populateMs (the 30s SLO, measured against an injected
 *     clock — not a real wait).
 *   - template partial-cleanup / failed-artifact (Req 5.3): a write failure
 *     ABORTS, produces NO projectTree (so nothing partial is persisted), and
 *     returns { ok:false, code:'TEMPLATE_WRITE_FAILED', failedArtifact }.
 *   - convergence (Req 6.9): ProjectManager.populateOrigin materializes the tree
 *     into the exportable tree via the PersistenceStore, and a failure rolls back
 *     the Sandbox + registry — then runGeneration runs the SAME pipeline for
 *     every origin.
 *
 * HERMETIC + OFFLINE: no plumby import, no real agent, temp StorageLayout under
 * os.tmpdir() removed in a finally, injected clocks, fake sandbox/devServer.
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
  IMPORT_SMALL_REPO_MAX_BYTES,
} from '../src/project/project-origins.js';
import { createSnapshotStore } from '../src/persistence/snapshot-store.js';
import { createAuthorizer } from '../src/auth/authorize.js';
import { Target_Category } from '../src/model/enums.js';
import { createProject as createProjectRecord } from '../src/model/project.js';
import { createTemplateFixtureProvider } from './support/template-fixture.js';

const OWNER = 'acct-1';

/** A layout rooted at a fresh temp dir, so real file I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-origins-'));
  return { base, layout: createStorageLayout(base), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** An injected ms clock that advances by `step` on each read. */
function steppingClock({ start = 1000, step = 5 } = {}) {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

/** A minimal Project record for a given origin/category. */
function projectRecord({ origin, targetCategory = 'web', id = 'proj-1' }) {
  const iso = '2020-01-01T00:00:00.000Z';
  return createProjectRecord({
    id,
    ownerId: OWNER,
    description: 'a project',
    targetCategory,
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

// ------------------------------------------------------------- blank origin

test('blank origin: produces ONLY minimal runnable files (package.json with a start script + an entry file), no template', async () => {
  const origin = createProjectOrigin({ now: steppingClock() });
  const result = await origin.populate({
    project: projectRecord({ origin: 'blank' }),
    origin: 'blank',
    targetCategory: 'web',
  });

  assert.equal(result.ok, true);
  assert.equal(result.origin, 'blank');
  const tree = result.projectTree;

  // A package.json with a runnable start script (mutation: dropping the start
  // script or writing an empty tree flips this — nothing to run, Property 11).
  assert.ok(tree['package.json'], 'blank tree includes package.json');
  const pkg = JSON.parse(tree['package.json']);
  assert.equal(typeof pkg.scripts.start, 'string');
  assert.ok(pkg.scripts.start.length > 0, 'a non-empty start command exists');
  // A single entry file the start command runs.
  assert.ok(typeof tree['index.js'] === 'string' && tree['index.js'].length > 0, 'a runnable entry file exists');
  // NO template dependency footprint beyond the minimal manifest: only the two
  // minimal files (no framework files applied).
  assert.deepEqual(Object.keys(tree).sort(), ['index.js', 'package.json']);
  // populateMs is measured against the injected clock (well within any bound).
  assert.equal(typeof result.populateMs, 'number');
  assert.ok(result.populateMs >= 0);
});

// ------------------------------------------------------------ template origin

test('template origin: populates ALL fixture template files + the dependency manifest for EVERY Target_Category, exposing a measured populateMs', async () => {
  const templateProvider = createTemplateFixtureProvider();
  const origin = createProjectOrigin({ templateProvider, now: steppingClock() });

  for (const targetCategory of Target_Category) {
    const expected = templateProvider.forCategory(targetCategory);
    const result = await origin.populate({
      project: projectRecord({ origin: 'template', targetCategory }),
      origin: 'template',
      targetCategory,
    });
    assert.equal(result.ok, true, `template populates for ${targetCategory}`);
    assert.equal(result.origin, 'template');
    // Every template file is present, including the dependency manifest.
    assert.deepEqual(
      Object.keys(result.projectTree).sort(),
      Object.keys(expected).sort(),
      `all ${targetCategory} template files populated`,
    );
    assert.ok(result.projectTree['package.json'], `${targetCategory} dependency manifest populated`);
    // populateMs is measured and within the 30s SLO (Req 5.2), against the clock.
    assert.equal(typeof result.populateMs, 'number');
    assert.ok(result.populateMs < TEMPLATE_POPULATE_SLO_MS, 'populateMs within the 30s Template SLO');
  }
});

test('template origin: a write failure ABORTS, produces NO projectTree, and names the failed artifact (Req 5.3)', async () => {
  // Force a template whose one artifact has non-persistable contents (a number),
  // so populate must abort naming that artifact.
  const templateProvider = createTemplateFixtureProvider({
    overrides: (category) =>
      category === 'web'
        ? { 'package.json': '{"name":"x"}\n', 'broken.bin': 42 }
        : undefined,
  });
  const origin = createProjectOrigin({ templateProvider, now: steppingClock() });

  const result = await origin.populate({
    project: projectRecord({ origin: 'template', targetCategory: 'web' }),
    origin: 'template',
    targetCategory: 'web',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEMPLATE_WRITE_FAILED');
  assert.equal(result.failedArtifact, 'broken.bin', 'names the artifact that failed');
  assert.equal(result.projectTree, undefined, 'no partial tree produced on failure');
});

test('template origin: a template missing its dependency manifest is a TEMPLATE_WRITE_FAILED naming the missing manifest', async () => {
  const templateProvider = createTemplateFixtureProvider({
    overrides: (category) => (category === 'web' ? { 'index.js': "console.log('x');\n" } : undefined),
  });
  const origin = createProjectOrigin({ templateProvider, now: steppingClock() });
  const result = await origin.populate({
    project: projectRecord({ origin: 'template', targetCategory: 'web' }),
    origin: 'template',
    targetCategory: 'web',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEMPLATE_WRITE_FAILED');
  assert.equal(result.failedArtifact, 'package.json');
});

test('template origin: partial cleanup removes any earlier-materialized on-disk tree via the persistenceStore (Req 5.3)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    // Simulate an earlier partial materialization landing on disk.
    const project = projectRecord({ origin: 'template', targetCategory: 'web' });
    persistenceStore.persist(project.id, { 'partial.txt': 'half written' });
    persistenceStore.flush(project.id);
    assert.deepEqual(Object.keys(persistenceStore.readPersistedTree(project.id)), ['partial.txt']);

    // Now a failing template must clean up that on-disk partial.
    const templateProvider = createTemplateFixtureProvider({
      overrides: (category) => (category === 'web' ? { 'package.json': '{}\n', 'bad': {} } : undefined),
    });
    const origin = createProjectOrigin({ persistenceStore, templateProvider, now: steppingClock() });
    const result = await origin.populate({ project, origin: 'template', targetCategory: 'web' });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'TEMPLATE_WRITE_FAILED');
    // The on-disk partial tree was removed — nothing half-written survives.
    assert.deepEqual(persistenceStore.readPersistedTree(project.id), {}, 'partial tree cleaned up');
  } finally {
    cleanup();
  }
});

test('template origin: without a templateProvider a template origin is a structured TEMPLATE_PROVIDER_MISSING, not a throw', async () => {
  const origin = createProjectOrigin({ now: steppingClock() });
  const result = await origin.populate({
    project: projectRecord({ origin: 'template' }),
    origin: 'template',
    targetCategory: 'web',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEMPLATE_PROVIDER_MISSING');
});

// --------------------------------------------------- exhaustive dispatch guard

test('populate: an origin OUTSIDE the closed enum is rejected (defense in depth), never throws', async () => {
  const origin = createProjectOrigin({ now: steppingClock() });
  const result = await origin.populate({ origin: 'clone', targetCategory: 'web' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_ORIGIN');
});

// --------------------------- ProjectManager convergence (Req 6.9) ------------

/** A fake SandboxManager that records acquire/release calls. */
function fakeSandboxManager() {
  const acquireCalls = [];
  const releaseCalls = [];
  return {
    acquireCalls,
    releaseCalls,
    acquire(projectId) {
      acquireCalls.push(projectId);
      return { projectId, handle: `sandbox:${projectId}` };
    },
    release(projectId) {
      releaseCalls.push(projectId);
      return { projectId, released: true };
    },
    activeProjectIds() {
      return [...new Set(acquireCalls)];
    },
  };
}

/** A fake Dev_Server seam that records start/stop calls. */
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

function seqIdFactory(prefix = 'proj') {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

test('ProjectManager.populateOrigin: blank AND template both materialize into the exportable tree and route through the SAME runGeneration pipeline (Req 6.9)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    for (const origin of ['blank', 'template']) {
      const registry = createProjectRegistry({ layout });
      const sandboxManager = fakeSandboxManager();
      const devServer = fakeDevServer();
      const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
      const templateProvider = createTemplateFixtureProvider();
      const projectOrigin = createProjectOrigin({ persistenceStore, templateProvider, now: steppingClock() });
      const manager = createProjectManager({
        registry,
        sandboxManager,
        devServer,
        projectOrigin,
        persistenceStore,
        agentFactory: fakeAgentFactory(),
        verify: () => 'verdict: PASS',
        now: steppingClock(),
        idFactory: seqIdFactory(`${origin}`),
      });

      const created = manager.createProject({ accountId: OWNER, description: 'app', targetCategory: 'web', origin });
      assert.equal(created.ok, true, `${origin} create ok`);

      // Origin population is a SEPARATE step from the 10s begins-creation window.
      const populated = await manager.populateOrigin({ project: created.project, sandbox: created.sandbox });
      assert.equal(populated.ok, true, `${origin} populate ok`);
      assert.equal(typeof populated.populateMs, 'number');

      // The origin's starting tree is durable in the exportable project tree.
      const onDisk = persistenceStore.readPersistedTree(created.project.id);
      assert.ok(onDisk['package.json'], `${origin} tree materialized into the exportable tree`);

      // The SAME runGeneration pipeline runs for both origins (no forked lifecycle).
      const result = await manager.runGeneration({
        project: created.project,
        sandbox: created.sandbox,
        message: 'build it',
        projectTree: onDisk,
      });
      assert.equal(result.ok, true, `${origin} runGeneration ok`);
      assert.equal(result.verdict, 'PASS');
      assert.equal(devServer.startCalls.length, 1, `${origin} Dev_Server started once`);
    }
  } finally {
    cleanup();
  }
});

test('ProjectManager.populateOrigin: a populate failure rolls back the Sandbox AND the registry (no partial Project, no orphaned Sandbox)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    // A template provider that always fails for 'web'.
    const templateProvider = createTemplateFixtureProvider({
      overrides: () => ({ 'package.json': '{}\n', 'bad': 7 }),
    });
    const projectOrigin = createProjectOrigin({ persistenceStore, templateProvider, now: steppingClock() });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      devServer: fakeDevServer(),
      projectOrigin,
      persistenceStore,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: steppingClock(),
      idFactory: seqIdFactory(),
    });

    const created = manager.createProject({ accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'template' });
    assert.equal(created.ok, true);
    assert.equal(registry.countForOwner(OWNER), 1);

    const populated = await manager.populateOrigin({ project: created.project, sandbox: created.sandbox });
    assert.equal(populated.ok, false);
    assert.equal(populated.code, 'TEMPLATE_WRITE_FAILED');
    assert.equal(populated.failedArtifact, 'bad');

    // Rolled back: the Sandbox was released and the registry entry removed.
    assert.deepEqual(sandboxManager.releaseCalls, [created.project.id], 'sandbox reaped on populate failure');
    assert.equal(registry.countForOwner(OWNER), 0, 'no partial Project after populate failure');
    assert.equal(registry.get(created.project.id), null, 'the rolled-back project does not resolve');
  } finally {
    cleanup();
  }
});

test('ProjectManager.populateOrigin: without a projectOrigin injected it is a structured ORIGIN_UNAVAILABLE (strictly additive — existing flows unaffected)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const manager = createProjectManager({
      registry,
      sandboxManager: fakeSandboxManager(),
      devServer: fakeDevServer(),
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: steppingClock(),
      idFactory: seqIdFactory(),
    });
    const created = manager.createProject({ accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'blank' });
    assert.equal(created.ok, true);
    const populated = await manager.populateOrigin({ project: created.project, sandbox: created.sandbox });
    assert.equal(populated.ok, false);
    assert.equal(populated.code, 'ORIGIN_UNAVAILABLE');
  } finally {
    cleanup();
  }
});

// =========================================================================
// FEAT-003: github-import + fork origins (spec 14.2, Req 6.4-6.8)
//
// HERMETIC + OFFLINE: the ACTUAL external github clone cannot run here, so the
// network fetch is a SEAM injected as a scripted `cloner`; SLO/timeout/orphan-
// cleanup are verified against fakes + a manually-advanced injected clock. The
// fork tests use a REAL SnapshotStore over a temp layout (local git works
// offline) so Property 10's "independent copy" is exercised for real.
// =========================================================================

/**
 * A manually-advanced ms clock: reads return the current value; tests call
 * advance(ms) to move wall-clock time forward deterministically (no real waits).
 */
function manualClock({ start = 0 } = {}) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  now.set = (ms) => {
    t = ms;
  };
  return now;
}

/** A SandboxManager fake that records exec + release calls (async release). */
function importSandboxManager() {
  const execCalls = [];
  const releaseCalls = [];
  return {
    execCalls,
    releaseCalls,
    async exec(projectId, command, opts) {
      execCalls.push({ projectId, command, opts });
      return { stdout: '', stderr: '', exitCode: 0, denied: false, projectId };
    },
    async release(projectId) {
      releaseCalls.push(projectId);
      return { projectId, released: true, reaped: [], errors: [] };
    },
  };
}

// ------------------------------------------------------------ github-import

test('github-import: a small repo (<=100 MB) clones within the 120s SLO, produces the cloned tree, and reports cloneMs', async () => {
  const clock = manualClock({ start: 1000 });
  const authorizer = createAuthorizer();
  const sandboxManager = importSandboxManager();
  // Scripted cloner: runs the clone as a bash command through the confined exec
  // seam, advances the injected clock to model a ~30s clone, returns a tree.
  const cloner = {
    async clone({ ref, exec, onProgress }) {
      assert.equal(typeof exec, 'function', 'the clone runs through the confined exec seam');
      await exec(`git clone ${ref} .`, { timeoutMs: 120_000 });
      clock.advance(30_000); // 30s < 120s SLO
      onProgress({ phase: 'done' });
      return { ok: true, sizeBytes: 5 * 1024 * 1024, projectTree: { 'README.md': '# imported\n', 'index.js': "console.log('imported');\n" } };
    },
  };
  const origin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });

  const result = await origin.populate({
    project: projectRecord({ origin: 'github-import', id: 'imp-1' }),
    sandbox: { projectId: 'imp-1' },
    origin: 'github-import',
    targetCategory: 'web',
    ref: 'https://github.com/acme/app.git',
    userAccount: { id: OWNER },
    repoResource: { id: 'https://github.com/acme/app.git', ownerId: OWNER },
  });

  assert.equal(result.ok, true);
  assert.equal(result.origin, 'github-import');
  assert.deepEqual(Object.keys(result.projectTree).sort(), ['README.md', 'index.js']);
  assert.equal(typeof result.cloneMs, 'number');
  assert.ok(result.cloneMs <= IMPORT_SMALL_REPO_SLO_MS, 'cloneMs within the 120s import SLO');
  // The clone WAS issued as a confined bash command through the Sandbox exec path.
  assert.equal(sandboxManager.execCalls.length, 1);
  assert.match(sandboxManager.execCalls[0].command, /git clone/);
  // Sandbox reaped in a finally even on success (Req 6.5) — no orphan lingers.
  assert.deepEqual(sandboxManager.releaseCalls, ['imp-1']);
});

test('github-import: a large repo (>100 MB) reports ongoing progress and honors a configurable max clone time (default 600s)', async () => {
  const clock = manualClock({ start: 0 });
  const authorizer = createAuthorizer();
  const sandboxManager = importSandboxManager();
  const progress = [];
  const cloner = {
    async clone({ exec, onProgress, maxCloneMs, smallRepoMaxBytes }) {
      // The configurable large-repo budget is threaded through (default 600s).
      assert.equal(maxCloneMs, IMPORT_MAX_CLONE_SLO_MS);
      await exec('git clone --progress <ref> .', {});
      // Stream progress as a large clone proceeds, staying under the 600s budget.
      for (const pct of [25, 50, 75, 100]) {
        clock.advance(120_000); // 4 * 120s = 480s < 600s
        onProgress({ percent: pct });
      }
      return { ok: true, sizeBytes: smallRepoMaxBytes + 1, projectTree: { 'big.bin': Buffer.from('x'.repeat(16)) } };
    },
  };
  const origin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });

  const result = await origin.populate({
    project: projectRecord({ origin: 'github-import', id: 'imp-large' }),
    sandbox: { projectId: 'imp-large' },
    origin: 'github-import',
    targetCategory: 'web',
    ref: 'https://github.com/acme/big.git',
    userAccount: { id: OWNER },
    repoResource: { id: 'https://github.com/acme/big.git', ownerId: OWNER },
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.ok, true, 'large clone under the 600s budget succeeds');
  assert.deepEqual(progress.map((p) => p.percent), [25, 50, 75, 100], 'ongoing progress was reported');
  assert.ok(result.cloneMs <= IMPORT_MAX_CLONE_SLO_MS);
  assert.deepEqual(sandboxManager.releaseCalls, ['imp-large']);
});

test('github-import: a large clone EXCEEDING the configurable max clone time aborts with the cause, no partial Project, sandbox reaped', async () => {
  const clock = manualClock({ start: 0 });
  const authorizer = createAuthorizer();
  const sandboxManager = importSandboxManager();
  const cloner = {
    async clone({ exec, smallRepoMaxBytes }) {
      await exec('git clone <ref> .', {});
      clock.advance(700_000); // 700s > 600s max clone time
      return { ok: true, sizeBytes: smallRepoMaxBytes + 1, projectTree: { 'big.bin': Buffer.from('x') } };
    },
  };
  const origin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });

  const result = await origin.populate({
    project: projectRecord({ origin: 'github-import', id: 'imp-slow' }),
    sandbox: { projectId: 'imp-slow' },
    origin: 'github-import',
    targetCategory: 'web',
    ref: 'https://github.com/acme/big.git',
    userAccount: { id: OWNER },
    repoResource: { id: 'https://github.com/acme/big.git', ownerId: OWNER },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'IMPORT_FAILED');
  assert.match(result.message, /max clone time/);
  assert.equal(result.projectTree, undefined, 'no partial tree on timeout');
  // Sandbox reaped in the finally even on the failure path (Req 6.5).
  assert.deepEqual(sandboxManager.releaseCalls, ['imp-slow'], 'orphan sandbox reaped on failure');
});

test('github-import: an honored configurable maxCloneMs override bounds the clone', async () => {
  const clock = manualClock({ start: 0 });
  const authorizer = createAuthorizer();
  const sandboxManager = importSandboxManager();
  const cloner = {
    async clone({ exec, maxCloneMs, smallRepoMaxBytes }) {
      assert.equal(maxCloneMs, 5000, 'the factory maxCloneMs override is threaded through');
      await exec('git clone <ref> .', {});
      clock.advance(6000); // 6s > the 5s override
      return { ok: true, sizeBytes: smallRepoMaxBytes + 1, projectTree: { 'big.bin': Buffer.from('x') } };
    },
  };
  const origin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock, maxCloneMs: 5000 });

  const result = await origin.populate({
    project: projectRecord({ origin: 'github-import', id: 'imp-cfg' }),
    sandbox: { projectId: 'imp-cfg' },
    origin: 'github-import',
    targetCategory: 'web',
    ref: 'https://github.com/acme/big.git',
    userAccount: { id: OWNER },
    repoResource: { id: 'https://github.com/acme/big.git', ownerId: OWNER },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IMPORT_FAILED');
  assert.deepEqual(sandboxManager.releaseCalls, ['imp-cfg']);
});

test('github-import: an invalid/inaccessible ref aborts with the cause, no partial Project, sandbox reaped in a finally (Req 6.5)', async () => {
  const clock = manualClock({ start: 0 });
  const authorizer = createAuthorizer();
  const sandboxManager = importSandboxManager();
  const cloner = {
    async clone({ exec }) {
      await exec('git clone <bad-ref> .', {});
      // The confined clone command failed inside the box (invalid/inaccessible).
      return { ok: false, message: 'repository not found or access denied' };
    },
  };
  const origin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });

  const result = await origin.populate({
    project: projectRecord({ origin: 'github-import', id: 'imp-bad' }),
    sandbox: { projectId: 'imp-bad' },
    origin: 'github-import',
    targetCategory: 'web',
    ref: 'https://github.com/acme/missing.git',
    userAccount: { id: OWNER },
    repoResource: { id: 'https://github.com/acme/missing.git', ownerId: OWNER },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'IMPORT_FAILED');
  assert.match(result.message, /not found or access denied/);
  assert.equal(result.projectTree, undefined, 'no partial tree on invalid ref');
  assert.deepEqual(sandboxManager.releaseCalls, ['imp-bad'], 'orphan sandbox reaped on invalid-ref failure');
});

test('github-import: a cloner that THROWS is caught, aborts with IMPORT_FAILED, and still reaps the sandbox in the finally', async () => {
  const clock = manualClock({ start: 0 });
  const authorizer = createAuthorizer();
  const sandboxManager = importSandboxManager();
  const cloner = {
    async clone() {
      throw new Error('network unreachable');
    },
  };
  const origin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });
  const result = await origin.populate({
    project: projectRecord({ origin: 'github-import', id: 'imp-throw' }),
    sandbox: { projectId: 'imp-throw' },
    origin: 'github-import',
    targetCategory: 'web',
    ref: 'https://github.com/acme/x.git',
    userAccount: { id: OWNER },
    repoResource: { id: 'https://github.com/acme/x.git', ownerId: OWNER },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IMPORT_FAILED');
  assert.match(result.message, /network unreachable/);
  assert.deepEqual(sandboxManager.releaseCalls, ['imp-throw'], 'sandbox reaped even when the cloner throws');
});

test('github-import: authorization is checked BEFORE cloning — an unauthorized repo never triggers the fetch and creates nothing', async () => {
  const clock = manualClock({ start: 0 });
  // An authorizer that denies (the requester owns nothing and holds no grant).
  const authorizer = createAuthorizer();
  const sandboxManager = importSandboxManager();
  let cloneCalled = false;
  const cloner = {
    async clone() {
      cloneCalled = true;
      return { ok: true, projectTree: {} };
    },
  };
  const origin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });

  const result = await origin.populate({
    project: projectRecord({ origin: 'github-import', id: 'imp-unauth' }),
    sandbox: { projectId: 'imp-unauth' },
    origin: 'github-import',
    targetCategory: 'web',
    ref: 'https://github.com/someone-else/private.git',
    // The repo is owned by someone else; a requester with a DIFFERENT id and no
    // grant is denied BEFORE the fetch.
    repoResource: { id: 'https://github.com/someone-else/private.git', ownerId: 'someone-else' },
    userAccount: { id: 'intruder' },
    grants: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'IMPORT_UNAUTHORIZED');
  assert.equal(cloneCalled, false, 'the network clone was NEVER attempted after a denial');
});

test('github-import (TRUST BOUNDARY): a repoResource whose ownerId DIFFERS from the requester, with no grant, is DENIED — the caller cannot forge ownership to self-authorize', async () => {
  // The trust boundary named in project-origins.js: `repoResource.ownerId` is
  // caller-asserted, so this layer must FAIL CLOSED when the asserted repo owner
  // is not the requester and no grant covers the access. Production MUST populate
  // repoResource from the VERIFIED connected GitHub identity; this test pins the
  // fail-closed behavior that guarantee relies on.
  const clock = manualClock({ start: 0 });
  const authorizer = createAuthorizer();
  const sandboxManager = importSandboxManager();
  let cloneCalled = false;
  const cloner = {
    async clone() {
      cloneCalled = true;
      return { ok: true, projectTree: { 'index.js': "console.log('leaked');\n" } };
    },
  };
  const origin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: clock });

  const result = await origin.populate({
    project: projectRecord({ origin: 'github-import', id: 'imp-forged' }),
    sandbox: { projectId: 'imp-forged' },
    origin: 'github-import',
    targetCategory: 'web',
    ref: 'https://github.com/victim/private.git',
    // The repo is (asserted to be) owned by 'victim'; the REQUESTER is a
    // different account holding NO grant. resolveAccess denies (owner mismatch,
    // no grant), so the clone is never attempted and nothing is created.
    repoResource: { id: 'https://github.com/victim/private.git', ownerId: 'victim' },
    userAccount: { id: 'not-the-owner' },
    grants: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'IMPORT_UNAUTHORIZED');
  assert.equal(cloneCalled, false, 'a forged/mismatched repo owner never triggers the fetch');
  assert.deepEqual(sandboxManager.execCalls, [], 'no confined clone command was issued');
});

// -------------------------------------------------------------------- fork

/** Seed a real source Project (registry + persisted tree + a snapshot). */
function seedSource({ layout, registry, snapshotStore, persistenceStore, id = 'src-1', tree }) {
  const record = projectRecord({ origin: 'blank', id });
  registry.register(record);
  persistenceStore.persist(id, tree);
  persistenceStore.flush(id);
  const committed = snapshotStore.commitExplicit(id, tree);
  return { record, committed };
}

test('fork: copies the source Project MOST RECENT Snapshot as an INDEPENDENT starting state (Property 10 — mutating the fork never touches the origin)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
    const authorizer = createAuthorizer();

    // Non-utf8 bytes so the content round-trips as a genuine Buffer (binary),
    // exercising the deep-copy-of-Buffers half of Property 10.
    const sourceTree = { 'index.js': "console.log('source v2');\n", 'data.bin': Buffer.from([0xff, 0xfe, 0x00, 0x80]) };
    // Commit an older snapshot first, then the most-recent one, to prove "most recent".
    seedSource({ layout, registry, snapshotStore, persistenceStore, id: 'src-1', tree: { 'index.js': "console.log('source v1');\n" } });
    snapshotStore.commitExplicit('src-1', sourceTree);

    // Capture ONE restored source object and force the fork to be built from THIS
    // exact object, so the deep copy is OBSERVABLE. A bare re-restore after
    // mutation would re-read fresh bytes from git and pass even for a shallow /
    // no-copy fork; wrapping restore() to return `sourceForFork` lets us assert
    // Buffer non-identity and that this same in-memory object is never aliased.
    const originLatest0 = snapshotStore.latestSnapshot('src-1');
    const sourceForFork = snapshotStore.restore('src-1', originLatest0.id);
    assert.equal(sourceForFork.ok, true);
    const capturingSnapshotStore = {
      latestSnapshot: (id) => snapshotStore.latestSnapshot(id),
      restore: (id, snapId) => {
        if (id === 'src-1' && snapId === originLatest0.id) return sourceForFork;
        return snapshotStore.restore(id, snapId);
      },
    };

    const origin = createProjectOrigin({ snapshotStore: capturingSnapshotStore, persistenceStore, authorizer, projectRegistry: registry, now: steppingClock() });

    const result = await origin.populate({
      project: projectRecord({ origin: 'fork', id: 'fork-1' }),
      origin: 'fork',
      targetCategory: 'web',
      ref: 'src-1',
      userAccount: { id: OWNER },
    });

    assert.equal(result.ok, true);
    assert.equal(result.origin, 'fork');
    // The MOST RECENT snapshot's tree was copied (v2, plus the binary file).
    assert.equal(result.projectTree['index.js'], "console.log('source v2');\n");
    assert.ok(Buffer.isBuffer(result.projectTree['data.bin']));
    assert.deepEqual([...result.projectTree['data.bin']], [0xff, 0xfe, 0x00, 0x80]);

    // Property 10 (deep copy is OBSERVABLE): the fork's Buffer must be a DISTINCT
    // instance from the source's Buffer — a shallow copy (`out[rel] = contents`)
    // or a no-copy return would FAIL this assertion directly.
    assert.notEqual(
      result.projectTree['data.bin'],
      sourceForFork.projectTree['data.bin'],
      'fork Buffer must be a distinct instance from the source (deep copy)',
    );

    // Property 10: mutate the fork's tree/buffer and confirm the origin is
    // unchanged. Check BOTH (a) the SAME in-memory object the fork was built from
    // (a shared Buffer would leak the flip into it) AND (b) the origin's durable
    // most-recent snapshot re-read from git (belt-and-braces).
    result.projectTree['data.bin'][0] = 99;
    result.projectTree['index.js'] = 'tampered';
    assert.deepEqual([...sourceForFork.projectTree['data.bin']], [0xff, 0xfe, 0x00, 0x80], 'the source object the fork was built from is untouched');
    assert.equal(sourceForFork.projectTree['index.js'], "console.log('source v2');\n", 'source object index.js untouched');
    const originLatest = snapshotStore.latestSnapshot('src-1');
    const originRestored = snapshotStore.restore('src-1', originLatest.id);
    assert.equal(originRestored.projectTree['index.js'], "console.log('source v2');\n", 'origin source unchanged');
    assert.deepEqual([...originRestored.projectTree['data.bin']], [0xff, 0xfe, 0x00, 0x80], 'origin binary bytes untouched');
  } finally {
    cleanup();
  }
});

test('fork: a source with NO snapshot yet falls back to its most recent persisted tree (Req 6.7)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
    const authorizer = createAuthorizer();

    // Register + persist a tree, but DO NOT commit any snapshot.
    registry.register(projectRecord({ origin: 'blank', id: 'src-nosnap' }));
    persistenceStore.persist('src-nosnap', { 'app.js': "console.log('persisted only');\n" });
    persistenceStore.flush('src-nosnap');

    const origin = createProjectOrigin({ snapshotStore, persistenceStore, authorizer, projectRegistry: registry, now: steppingClock() });
    const result = await origin.populate({
      project: projectRecord({ origin: 'fork', id: 'fork-2' }),
      origin: 'fork',
      targetCategory: 'web',
      ref: 'src-nosnap',
      userAccount: { id: OWNER },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.projectTree), ['app.js']);
    assert.equal(result.projectTree['app.js'], "console.log('persisted only');\n");
  } finally {
    cleanup();
  }
});

test('fork: a source with neither a snapshot nor a persisted tree is rejected (FORK_EMPTY), creating nothing', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
    const authorizer = createAuthorizer();
    registry.register(projectRecord({ origin: 'blank', id: 'src-empty' }));

    const origin = createProjectOrigin({ snapshotStore, persistenceStore, authorizer, projectRegistry: registry, now: steppingClock() });
    const result = await origin.populate({
      project: projectRecord({ origin: 'fork', id: 'fork-3' }),
      origin: 'fork',
      targetCategory: 'web',
      ref: 'src-empty',
      userAccount: { id: OWNER },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FORK_EMPTY');
    assert.equal(result.projectTree, undefined);
  } finally {
    cleanup();
  }
});

test('fork: a NONEXISTENT source Project is rejected (FORK_NOT_FOUND) and creates nothing', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
    const authorizer = createAuthorizer();

    const origin = createProjectOrigin({ snapshotStore, persistenceStore, authorizer, projectRegistry: registry, now: steppingClock() });
    const result = await origin.populate({
      project: projectRecord({ origin: 'fork', id: 'fork-4' }),
      origin: 'fork',
      targetCategory: 'web',
      ref: 'does-not-exist',
      userAccount: { id: OWNER },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FORK_NOT_FOUND');
    assert.equal(result.projectTree, undefined);
  } finally {
    cleanup();
  }
});

test('fork: an UNAUTHORIZED source Project (owned by another account, no grant) is rejected (FORK_UNAUTHORIZED), creating nothing', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
    const authorizer = createAuthorizer();

    // Source owned by OWNER, with a real snapshot.
    seedSource({ layout, registry, snapshotStore, persistenceStore, id: 'src-owned', tree: { 'index.js': "console.log('x');\n" } });

    const origin = createProjectOrigin({ snapshotStore, persistenceStore, authorizer, projectRegistry: registry, now: steppingClock() });
    // A DIFFERENT requester with no grant must be denied.
    const result = await origin.populate({
      project: projectRecord({ origin: 'fork', id: 'fork-5' }),
      origin: 'fork',
      targetCategory: 'web',
      ref: 'src-owned',
      userAccount: { id: 'intruder' },
      grants: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FORK_UNAUTHORIZED');
    assert.equal(result.projectTree, undefined);
  } finally {
    cleanup();
  }
});

test('fork: a valid read-only Share_Link grant authorizes a non-owner to fork the source', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
    const authorizer = createAuthorizer();
    seedSource({ layout, registry, snapshotStore, persistenceStore, id: 'src-shared', tree: { 'index.js': "console.log('shared');\n" } });

    const origin = createProjectOrigin({ snapshotStore, persistenceStore, authorizer, projectRegistry: registry, now: steppingClock() });
    const result = await origin.populate({
      project: projectRecord({ origin: 'fork', id: 'fork-6' }),
      origin: 'fork',
      targetCategory: 'web',
      ref: 'src-shared',
      userAccount: { id: 'guest' },
      grants: [{ projectId: 'src-shared', access: 'read-only', revoked: false }],
    });
    assert.equal(result.ok, true, 'a live read-only Share_Link grants the fork');
    assert.equal(result.projectTree['index.js'], "console.log('shared');\n");
  } finally {
    cleanup();
  }
});

// ------------------- ProjectManager convergence for import + fork -----------

test('ProjectManager.populateOrigin: a github-import failure rolls back the Sandbox AND registry (no partial Project, no orphaned Sandbox)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const authorizer = createAuthorizer();
    // The ProjectManager's fakeSandboxManager records release; the origin uses
    // the SAME manager so its finally-release and the rollback both hit it.
    const sandboxManager = fakeSandboxManager();
    const cloner = { async clone() { return { ok: false, message: 'bad ref' }; } };
    const projectOrigin = createProjectOrigin({ authorizer, sandboxManager, cloner, now: steppingClock() });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      devServer: fakeDevServer(),
      projectOrigin,
      persistenceStore,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: steppingClock(),
      idFactory: seqIdFactory('imp'),
    });

    const created = manager.createProject({
      accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'github-import', ref: 'https://github.com/x/y.git',
    });
    assert.equal(created.ok, true);
    assert.equal(registry.countForOwner(OWNER), 1);

    const populated = await manager.populateOrigin({
      project: created.project,
      sandbox: created.sandbox,
      userAccount: { id: OWNER },
      repoResource: { id: 'https://github.com/x/y.git', ownerId: OWNER },
    });
    assert.equal(populated.ok, false);
    assert.equal(populated.code, 'IMPORT_FAILED');
    // Sandbox reaped (origin finally + rollback are both idempotent) and the
    // registry entry rolled back — no partial Project, no orphaned Sandbox.
    assert.ok(sandboxManager.releaseCalls.includes(created.project.id), 'sandbox reaped on import failure');
    assert.equal(registry.countForOwner(OWNER), 0, 'no partial Project after import failure');
  } finally {
    cleanup();
  }
});

test('ProjectManager.populateOrigin: a github-import SUCCESS materializes the cloned tree AND routes through the SAME runGeneration pipeline — a single Dev_Server start (Req 6.9 convergence, like the other origins)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const devServer = fakeDevServer();
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const authorizer = createAuthorizer();

    // A scripted cloner (SEAM) that succeeds and returns a runnable tree. The
    // ACTUAL network fetch cannot run offline, so it is injected.
    const cloner = {
      async clone() {
        return { ok: true, sizeBytes: 1024, projectTree: { 'package.json': '{"name":"imported"}\n', 'index.js': "console.log('imported');\n" } };
      },
    };
    const projectOrigin = createProjectOrigin({ authorizer, sandboxManager, cloner, persistenceStore, now: steppingClock() });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      devServer,
      projectOrigin,
      persistenceStore,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: steppingClock(),
      idFactory: seqIdFactory('imp-ok'),
    });

    const created = manager.createProject({
      accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'github-import', ref: 'https://github.com/acme/app.git',
    });
    assert.equal(created.ok, true);

    // Population is a SEPARATE step from the 10s begins-creation window.
    const populated = await manager.populateOrigin({
      project: created.project,
      sandbox: created.sandbox,
      userAccount: { id: OWNER },
      repoResource: { id: 'https://github.com/acme/app.git', ownerId: OWNER },
    });
    assert.equal(populated.ok, true, 'github-import populate ok');
    assert.equal(populated.origin, 'github-import');

    // The cloned tree materialized into the Project's OWN exportable tree.
    const onDisk = persistenceStore.readPersistedTree(created.project.id);
    assert.deepEqual(Object.keys(onDisk).sort(), ['index.js', 'package.json']);

    // CONVERGENCE (Req 6.9): the SAME runGeneration pipeline runs for the import
    // origin — exactly like blank/template/fork — a single Dev_Server start, no
    // forked lifecycle.
    const result = await manager.runGeneration({ project: created.project, sandbox: created.sandbox, message: 'build it', projectTree: onDisk });
    assert.equal(result.ok, true, 'github-import runGeneration ok');
    assert.equal(result.verdict, 'PASS');
    assert.equal(devServer.startCalls.length, 1, 'Dev_Server started once for the import origin');
  } finally {
    cleanup();
  }
});

test('ProjectManager.populateOrigin: a fork materializes the copied tree into the FORK own exportable tree and routes through runGeneration (Req 6.9)', async () => {
  const { layout, cleanup } = tempLayout();
  try {
    const registry = createProjectRegistry({ layout });
    const sandboxManager = fakeSandboxManager();
    const devServer = fakeDevServer();
    const persistenceStore = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
    const snapshotStore = createSnapshotStore({ layout, ownerId: OWNER });
    const authorizer = createAuthorizer();

    // Seed a real source with a snapshot.
    seedSource({ layout, registry, snapshotStore, persistenceStore, id: 'src-conv', tree: { 'package.json': '{"name":"src"}\n', 'index.js': "console.log('src');\n" } });

    const projectOrigin = createProjectOrigin({ snapshotStore, persistenceStore, authorizer, projectRegistry: registry, now: steppingClock() });
    const manager = createProjectManager({
      registry,
      sandboxManager,
      devServer,
      projectOrigin,
      persistenceStore,
      agentFactory: fakeAgentFactory(),
      verify: () => 'verdict: PASS',
      now: steppingClock(),
      idFactory: seqIdFactory('fork'),
    });

    const created = manager.createProject({ accountId: OWNER, description: 'app', targetCategory: 'web', origin: 'fork', ref: 'src-conv' });
    assert.equal(created.ok, true);

    const populated = await manager.populateOrigin({ project: created.project, sandbox: created.sandbox, userAccount: { id: OWNER } });
    assert.equal(populated.ok, true, 'fork populate ok');
    assert.equal(populated.origin, 'fork');

    // The copied tree is durable in the FORK's OWN exportable tree, separate from the source.
    const forkTree = persistenceStore.readPersistedTree(created.project.id);
    assert.deepEqual(Object.keys(forkTree).sort(), ['index.js', 'package.json']);

    // The SAME runGeneration pipeline runs for the fork origin (no forked lifecycle).
    const result = await manager.runGeneration({ project: created.project, sandbox: created.sandbox, message: 'go', projectTree: forkTree });
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'PASS');
    assert.equal(devServer.startCalls.length, 1, 'Dev_Server started once for the fork');
  } finally {
    cleanup();
  }
});
