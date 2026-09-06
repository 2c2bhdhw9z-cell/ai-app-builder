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
import { createProjectOrigin, TEMPLATE_POPULATE_SLO_MS } from '../src/project/project-origins.js';
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

test('blank origin: produces ONLY minimal runnable files (package.json with a start script + an entry file), no template', () => {
  const origin = createProjectOrigin({ now: steppingClock() });
  const result = origin.populate({
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

test('template origin: populates ALL fixture template files + the dependency manifest for EVERY Target_Category, exposing a measured populateMs', () => {
  const templateProvider = createTemplateFixtureProvider();
  const origin = createProjectOrigin({ templateProvider, now: steppingClock() });

  for (const targetCategory of Target_Category) {
    const expected = templateProvider.forCategory(targetCategory);
    const result = origin.populate({
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

test('template origin: a write failure ABORTS, produces NO projectTree, and names the failed artifact (Req 5.3)', () => {
  // Force a template whose one artifact has non-persistable contents (a number),
  // so populate must abort naming that artifact.
  const templateProvider = createTemplateFixtureProvider({
    overrides: (category) =>
      category === 'web'
        ? { 'package.json': '{"name":"x"}\n', 'broken.bin': 42 }
        : undefined,
  });
  const origin = createProjectOrigin({ templateProvider, now: steppingClock() });

  const result = origin.populate({
    project: projectRecord({ origin: 'template', targetCategory: 'web' }),
    origin: 'template',
    targetCategory: 'web',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEMPLATE_WRITE_FAILED');
  assert.equal(result.failedArtifact, 'broken.bin', 'names the artifact that failed');
  assert.equal(result.projectTree, undefined, 'no partial tree produced on failure');
});

test('template origin: a template missing its dependency manifest is a TEMPLATE_WRITE_FAILED naming the missing manifest', () => {
  const templateProvider = createTemplateFixtureProvider({
    overrides: (category) => (category === 'web' ? { 'index.js': "console.log('x');\n" } : undefined),
  });
  const origin = createProjectOrigin({ templateProvider, now: steppingClock() });
  const result = origin.populate({
    project: projectRecord({ origin: 'template', targetCategory: 'web' }),
    origin: 'template',
    targetCategory: 'web',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEMPLATE_WRITE_FAILED');
  assert.equal(result.failedArtifact, 'package.json');
});

test('template origin: partial cleanup removes any earlier-materialized on-disk tree via the persistenceStore (Req 5.3)', () => {
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
    const result = origin.populate({ project, origin: 'template', targetCategory: 'web' });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'TEMPLATE_WRITE_FAILED');
    // The on-disk partial tree was removed — nothing half-written survives.
    assert.deepEqual(persistenceStore.readPersistedTree(project.id), {}, 'partial tree cleaned up');
  } finally {
    cleanup();
  }
});

test('template origin: without a templateProvider a template origin is a structured TEMPLATE_PROVIDER_MISSING, not a throw', () => {
  const origin = createProjectOrigin({ now: steppingClock() });
  const result = origin.populate({
    project: projectRecord({ origin: 'template' }),
    origin: 'template',
    targetCategory: 'web',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEMPLATE_PROVIDER_MISSING');
});

// --------------------------------------------------- exhaustive dispatch guard

test('populate: github-import and fork are exhaustive-but-not-yet-implemented (FEAT-003), returned as structured results', () => {
  const origin = createProjectOrigin({ now: steppingClock() });
  for (const notYet of ['github-import', 'fork']) {
    const result = origin.populate({
      project: projectRecord({ origin: notYet }),
      origin: notYet,
      targetCategory: 'web',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ORIGIN_NOT_IMPLEMENTED');
  }
});

test('populate: an origin OUTSIDE the closed enum is rejected (defense in depth), never throws', () => {
  const origin = createProjectOrigin({ now: steppingClock() });
  const result = origin.populate({ origin: 'clone', targetCategory: 'web' });
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
      const populated = manager.populateOrigin({ project: created.project, sandbox: created.sandbox });
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

test('ProjectManager.populateOrigin: a populate failure rolls back the Sandbox AND the registry (no partial Project, no orphaned Sandbox)', () => {
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

    const populated = manager.populateOrigin({ project: created.project, sandbox: created.sandbox });
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

test('ProjectManager.populateOrigin: without a projectOrigin injected it is a structured ORIGIN_UNAVAILABLE (strictly additive — existing flows unaffected)', () => {
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
    const populated = manager.populateOrigin({ project: created.project, sandbox: created.sandbox });
    assert.equal(populated.ok, false);
    assert.equal(populated.code, 'ORIGIN_UNAVAILABLE');
  } finally {
    cleanup();
  }
});
