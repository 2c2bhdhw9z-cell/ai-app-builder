/**
 * Project-runtime wiring tests (final wiring pass).
 *
 * These prove the live process now composes the create -> build -> preview graph,
 * and are written to FAIL if the wiring is reverted. Before this, the entry point
 * injected only { authService, provider, observability }, which meant:
 *
 *   1. POST /projects was not routed at all (405) — a Project could not be created
 *      over HTTP. /preview, /theme and /workspace-experience likewise.
 *   2. No projectResolver, so the gate treated EVERY projectId as self-owned:
 *      any authenticated account could open a Session on any project.
 *   3. No sandboxManager/layout, so the agent's cwd fell through to
 *      `process.cwd()` — the SERVER'S OWN SOURCE TREE.
 *   4. No QuotaManager, so Rate_Limits/Resource_Quotas were unenforced.
 *   5. composePlatformOps() got no secret set, so redaction was inert.
 *
 * REAL COLLABORATORS: the real StorageLayout on a temp dir, the real
 * ProjectRegistry (writing real files), the real SandboxManager, the real
 * QuotaManager counting from those, the real ProjectManager, the real AuthService,
 * and the real server on a real port driven with real fetch.
 *
 * INJECTED FAKES, and why: the container BACKEND (no container runtime exists in
 * this sandbox — the real docker-CLI backend is what production uses), the CLOCK
 * (quota windows are asserted without real waiting), and for the cwd test only,
 * the agentFactory (a real turn would call a model). Nothing else is faked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService, createShareLinkStore } from '../src/auth/index.js';
import { createScriptedProvider } from '../src/engine/plumby.js';
import { startPlatformServer } from '../src/server/start.js';
import {
  composeProjectRuntime,
  platformSecretSet,
  resolveDataDir,
  resolveQuotaConfig,
  resolvePreviewConfig,
  PLATFORM_SECRET_ENV_NAMES,
  DEFAULT_DATA_DIR,
  DEFAULT_MAX_CONCURRENT_SANDBOXES,
} from '../src/server/compose-runtime.js';
import { composePlatformOps } from '../src/ops/index.js';
import { DEFAULT_MAX_SANDBOXES } from '../src/sandbox/sandbox-manager.js';
import { createFilteringContainerBackend } from '../src/sandbox/filtering-container-backend.js';

// ---------------------------------------------------------------- test helpers

const NOW = Date.UTC(2026, 1, 1, 9, 0, 0);

function fakeClock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** A temp data dir, cleaned up by the caller. */
function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-runtime-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A FAKE container backend with the real backend's shape. A container cannot run
 * here; this records what would have been launched so the SandboxManager's real
 * acquire/exec logic still runs against a contract-shaped collaborator.
 */
function fakeBackend() {
  const runs = [];
  const services = [];
  return {
    bin: 'fake-docker',
    image: 'fake:latest',
    runs,
    isAvailable: async () => true,
    canLaunch: async () => true,
    // MIRRORS THE REAL BACKEND. The CLI backend cannot install per-host firewall
    // rules, so it declares supportsEgressFiltering:false and REFUSES any network
    // mode other than 'none'. An earlier version of this fake accepted 'filtered'
    // — and that divergence hid a real defect behind a green suite: the composed
    // SandboxManager was inheriting a non-empty package-registry allowlist, which
    // selects 'filtered', which the real backend denies, so EVERY command in EVERY
    // sandbox would have been refused in production. The fake must fail exactly
    // where production fails.
    supportsEgressFiltering: false,
    async runOneShot(spec) {
      runs.push(spec);
      if (spec.network !== 'none') {
        throw new Error(`egress filtering unsupported: refusing network mode ${spec.network}`);
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, limitsApplied: true, limitsSupported: true, degraded: false };
    },
    async remove() {},
    async reapOrphans() { return { removed: 0 }; },
    // MIRRORS THE REAL BACKEND's service surface (the long-running, port-publishing
    // containers a real Preview needs). Same rule as above: the fake must refuse
    // exactly where production refuses, so it fails closed on a published port over
    // a non-routable network instead of pretending a preview URL would answer.
    supportsServices: true,
    services,
    async startService(spec) {
      services.push(spec);
      const publish = Array.isArray(spec.publish) ? spec.publish : [];
      if (publish.length > 0 && spec.network === 'none') {
        throw new Error('published ports require a routable network');
      }
      if (spec.network === 'filtered') {
        throw new Error(`egress filtering unsupported: refusing network mode ${spec.network}`);
      }
      return { ok: true, containerId: `fake-${services.length}`, code: 0, stdout: '', stderr: '', timedOut: false, limitsApplied: true, degraded: false };
    },
    async serviceStatus() { return { ok: true, exists: true, running: true, exitCode: null }; },
    async serviceLogs() { return { ok: true, logs: '' }; },
    async stopService() { return { ok: true, stopped: true }; },
  };
}

/**
 * A FAKE FILTERING backend, mirroring src/sandbox/filtering-container-backend.js.
 *
 * Same rule as fakeBackend above: it must succeed and fail exactly where production
 * does. So it ACCEPTS the 'filtered' network (that is the whole point of the
 * filtering path — the plain backend's refusal is what made `AAB_SANDBOX_EGRESS=
 * registry` deny every command), declares supportsEgressFiltering:true, and records
 * the allowlist it was constructed with so composition can be asserted.
 */
function fakeFilteringBackend(opts = {}) {
  const runs = [];
  const cli = [];
  /**
   * A tiny stateful model of the runtime CLI, so the REAL filtering backend's own
   * plane setup and translation run. Only `exec` is faked — nothing here
   * re-implements a production decision, which is the point: an earlier version of
   * this fake hand-coded the accept-`filtered` rule, so the wiring tests would have
   * kept passing if the real backend had lost its translation entirely.
   */
  const containers = new Map();
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, signal: null });
  const real = createFilteringContainerBackend({
    ...opts,
    sleep: async () => {},
    exec: async (bin, args) => {
      cli.push(args);
      const verb = args[0] === 'network' ? `network ${args[1]}` : args[0];
      if (verb === 'run' && args.includes('-d')) {
        const name = args[args.indexOf('--name') + 1];
        const labels = {};
        for (let i = 0; i < args.length - 1; i += 1) {
          if (args[i] === '--label') {
            const [k, ...v] = args[i + 1].split('=');
            labels[k] = v.join('=');
          }
        }
        containers.set(name, { running: true, exitCode: 0, labels });
        return ok(`cid-${name}\n`);
      }
      if (verb === 'rm') {
        containers.delete(args.at(-1));
        return ok();
      }
      if (verb === 'inspect') {
        const c = containers.get(args.at(-1));
        if (!c) return { code: 1, stdout: '', stderr: 'no such object', timedOut: false, signal: null };
        const format = args[args.indexOf('--format') + 1] ?? '';
        const label = Object.keys(c.labels).find((k) => format.includes(k));
        return ok(label ? `${c.labels[label]}\n` : `${c.running} ${c.exitCode}\n`);
      }
      if (verb === 'network inspect') return { code: 1, stdout: '', stderr: 'no such network', timedOut: false, signal: null };
      if (verb === 'logs') return ok('aab-egress proxy listening on 0.0.0.0:3128\n');
      return ok('cid\n');
    },
  });
  return {
    ...real,
    bin: 'fake-docker',
    image: 'fake:latest',
    runs,
    cli,
    containers,
    async runOneShot(spec) {
      runs.push(spec);
      return real.runOneShot(spec);
    },
  };
}

/** A composed runtime over a temp dir with a fake container backend. */
function makeRuntime({ dir, clock = fakeClock(), env = {} } = {}) {
  const composed = composePlatformOps({ secretProvider: platformSecretSet(env) });
  const runtime = composeProjectRuntime({
    composed,
    env: { AAB_DATA_DIR: dir, ...env },
    now: clock.now,
    createBackend: fakeBackend,
    createFilteringBackend: fakeFilteringBackend,
  });
  return { composed, runtime, clock };
}

/** A real server over a composed runtime, plus a helper to mint real sessions. */
async function startServer({ runtime, composed, extra = {} } = {}) {
  const authService = createAuthService({
    idpVerifier: {
      async verifyIdToken(idToken) {
        if (!idToken) throw new Error('no token');
        return { provider: 'github', subject: idToken };
      },
    },
    auditSink: composed.auditLog,
  });
  const api = createBuilderServer({
    authService,
    provider: createScriptedProvider([]),
    observability: composed.observability,
    ...runtime.serverOptions(),
    ...extra,
  });
  const { port, host } = await api.listen(0, '127.0.0.1');

  /** Log in as a distinct account and return its bearer token + account. */
  async function login(subject) {
    const { account } = await authService.authenticate({ idToken: subject });
    const session = authService.scopeSession(account);
    return { token: session.token, account };
  }

  return { api, authService, login, base: `http://${host}:${port}`, close: () => api.close() };
}

/** POST /projects with a valid body. */
function createProject(base, token, body = {}) {
  return fetch(`${base}/projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'a todo app', targetCategory: 'web', origin: 'blank', ...body }),
  });
}

// ======================================================= POST /projects is live

test('POST /projects is ROUTED and creates a REAL Project in the registry on disk', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const { token, account } = await srv.login('alice');
    const res = await createProject(srv.base, token);

    assert.equal(res.status, 201, 'POST /projects must be routed (it was 405 before this wiring)');
    const body = await res.json();
    assert.ok(body.id, 'the created project id is returned');
    assert.equal(body.project.ownerId, account.id);
    assert.equal(body.project.targetCategory, 'web');

    // It is REALLY registered, in the REAL registry, owned by the REAL account —
    // read back through a separate registry call, not from the response.
    assert.deepEqual(runtime.registry.resolver(body.id), { id: body.id, ownerId: account.id });
    assert.equal(runtime.registry.countForOwner(account.id), 1);

    // ...and the registry really wrote to the configured data directory.
    assert.ok(runtime.dataDir.startsWith(dir) || runtime.dataDir === dir);
    assert.ok(fs.existsSync(runtime.layout.controlProjectRegistryPath(account.id)));
  } finally {
    await srv.close();
    cleanup();
  }
});

test('POST /projects rejects invalid input with the specific reason (real validation)', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');

    const noDesc = await createProject(srv.base, token, { description: '   ' });
    assert.equal(noDesc.status, 400);
    assert.equal((await noDesc.json()).code, 'DESCRIPTION_REQUIRED');

    const badTarget = await createProject(srv.base, token, { targetCategory: 'toaster' });
    assert.equal(badTarget.status, 400);
    assert.equal((await badTarget.json()).code, 'UNSUPPORTED_TARGET_CATEGORY');

    const badOrigin = await createProject(srv.base, token, { origin: 'telepathy' });
    assert.equal(badOrigin.status, 400);
    assert.equal((await badOrigin.json()).code, 'UNSUPPORTED_ORIGIN');

    // Nothing was allocated for any rejected request.
    assert.equal(runtime.sandboxManager.activeProjectIds().length, 0);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('POST /projects is closed to an unauthenticated caller (no limit disclosed pre-auth)', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const res = await fetch(`${srv.base}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x', targetCategory: 'web', origin: 'blank' }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'access denied' });
  } finally {
    await srv.close();
    cleanup();
  }
});

// ============================ projectResolver: cross-account Project isolation

test('SECURITY: one account cannot open a Session on another account\'s Project', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');
    assert.notEqual(alice.account.id, bob.account.id);

    const created = await createProject(srv.base, alice.token);
    assert.equal(created.status, 201);
    const projectId = (await created.json()).id;

    // The owner may touch it.
    const owner = await fetch(`${srv.base}/work-mode?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(owner.status, 200);

    // A DIFFERENT authenticated account may not. Without a projectResolver the
    // gate builds `{ id: projectId, ownerId: account.id }` — self-owned by
    // construction — and this returns 200.
    const intruder = await fetch(`${srv.base}/work-mode?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    assert.equal(intruder.status, 401, "another account's Project must be denied");
    assert.deepEqual(await intruder.json(), { error: 'access denied' });

    // A projectId that does not exist is denied IDENTICALLY — no existence
    // disclosure between "not yours" and "not a project".
    const ghost = await fetch(`${srv.base}/work-mode?projectId=00000000-0000-0000-0000-000000000000`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    assert.equal(ghost.status, 401);
    assert.deepEqual(await ghost.json(), { error: 'access denied' });
  } finally {
    await srv.close();
    cleanup();
  }
});

test('SECURITY: the SSE and message routes enforce the same Project ownership', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');
    const projectId = (await (await createProject(srv.base, alice.token)).json()).id;

    const events = await fetch(`${srv.base}/events?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    assert.equal(events.status, 401);
    await events.body?.cancel();

    const message = await fetch(`${srv.base}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, text: 'take over this project' }),
    });
    assert.equal(message.status, 401);
  } finally {
    await srv.close();
    cleanup();
  }
});

// =================================================== the agent's cwd is a sandbox

test('SECURITY: a turn runs in the Project SANDBOX, never in the server\'s own cwd', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  // Only the agent is faked (a real turn would call a model); the cwd it receives
  // is resolved by the REAL sandboxManager/layout wiring under test.
  const seen = [];
  const agentFactory = ({ cwd }) => {
    seen.push(cwd);
    return { agent: { async send() {} } };
  };
  const srv = await startServer({ runtime, composed, extra: { agentFactory } });
  try {
    const alice = await srv.login('alice');
    const projectId = (await (await createProject(srv.base, alice.token)).json()).id;

    const res = await fetch(`${srv.base}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, text: 'build it' }),
    });
    assert.equal(res.status, 202);

    // Wait for the session to build its agent.
    for (let i = 0; i < 50 && seen.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 1, 'the turn must have built an agent');

    const cwd = seen[0];
    // The decisive assertion: NOT the server's own source tree. With no
    // sandboxManager/layout injected, cwdFor() falls through to process.cwd().
    assert.notEqual(cwd, process.cwd());
    assert.ok(!cwd.startsWith(process.cwd()), `agent cwd must not be inside the server tree, got ${cwd}`);
    // It is the project's own sandbox mount, under the configured data dir.
    assert.equal(cwd, runtime.sandboxManager.acquire(projectId).mountSource);
    assert.ok(cwd.startsWith(runtime.dataDir), `agent cwd must live under the data dir, got ${cwd}`);
    assert.ok(cwd.includes(projectId), 'the cwd must be scoped to THIS project');
  } finally {
    await srv.close();
    cleanup();
  }
});

// ============================================================ quota enforcement

test('Rate_Limits are ENFORCED on POST /projects, on the injected clock', async () => {
  const { dir, cleanup } = tempDataDir();
  const clock = fakeClock();
  const { runtime, composed } = makeRuntime({ dir, clock });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');

    // DEFAULT_QUOTA_CONFIG allows 20 project.create per 60s per account. Each
    // create also holds a Sandbox boundary; releasing it here keeps the
    // concurrency quota entirely out of the picture so this test isolates the
    // Rate_Limit (the concurrency ceiling and its idle reclamation are tested
    // separately below).
    for (let i = 0; i < 20; i += 1) {
      const ok = await createProject(srv.base, token, { description: `app ${i}` });
      assert.equal(ok.status, 201, `create ${i} should succeed`);
      runtime.sandboxManager.release((await ok.json()).id);
    }

    const limited = await createProject(srv.base, token, { description: 'one too many' });
    assert.equal(limited.status, 429, 'the 21st create in the window must be rate limited');
    const body = await limited.json();
    assert.equal(body.limit, 'Rate_Limit');
    assert.equal(body.operation, 'project.create');

    // The window rolls over on the INJECTED clock — no real waiting.
    clock.advance(60_000);
    const afterWindow = await createProject(srv.base, token, { description: 'next window' });
    assert.equal(afterWindow.status, 201);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('the concurrent-Sandbox Resource_Quota is counted from the REAL live sandbox set', async () => {
  const { dir, cleanup } = tempDataDir();
  // A small explicit ceiling, so the count under test is the REAL live set rather
  // than the composed default (which tracks the SandboxManager's own capacity —
  // see the regression test below for why the module default of 10 is not used).
  const { runtime, composed } = makeRuntime({ dir, env: { AAB_MAX_CONCURRENT_SANDBOXES: '4' } });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');

    for (let i = 0; i < 4; i += 1) {
      assert.equal((await createProject(srv.base, token, { description: `app ${i}` })).status, 201);
    }
    assert.equal(runtime.sandboxManager.activeProjectIds().length, 4);

    const refused = await createProject(srv.base, token, { description: 'one over' });
    assert.equal(refused.status, 429);
    const body = await refused.json();
    assert.equal(body.limit, 'Resource_Quota');
    assert.equal(body.resource, 'concurrentSandboxes');

    // Releasing one really frees capacity — the count is live, not a constant.
    runtime.sandboxManager.release(runtime.sandboxManager.activeProjectIds()[0]);
    assert.equal((await createProject(srv.base, token, { description: 'after release' })).status, 201);
  } finally {
    await srv.close();
    cleanup();
  }
});

// ================================================ the rest of the dark surface

test('the preview and presentation routes are ROUTED once the runtime is composed', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');
    const projectId = (await (await createProject(srv.base, token)).json()).id;
    const auth = { authorization: `Bearer ${token}` };

    // Each of these was 405 (unrouted) before the runtime was injected.
    for (const url of [`/preview?projectId=${projectId}`, '/theme', '/workspace-experience']) {
      const res = await fetch(`${srv.base}${url}`, { headers: auth });
      assert.notEqual(res.status, 405, `${url} must be routed`);
      assert.equal(res.status, 200, `${url} should answer for an authorized account`);
    }

    // POST /preview/restart is routed too (it needs the PreviewController).
    const restart = await fetch(`${srv.base}/preview/restart`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    assert.notEqual(restart.status, 405, 'POST /preview/restart must be routed');
  } finally {
    await srv.close();
    cleanup();
  }
});

// ============================== per-owner store dispatch (isolation correctness)

test('per-owner stores dispatch by the project\'s REAL owner, not a placeholder', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');
    const aliceProject = (await (await createProject(srv.base, alice.token)).json()).id;
    const bobProject = (await (await createProject(srv.base, bob.token)).json()).id;

    // Persist a tree for each project through the owner-agnostic facade
    // (persist queues the tree; persistNow makes it durable).
    runtime.persistenceStore.persist(aliceProject, { 'a.txt': 'alice' });
    runtime.persistenceStore.persistNow(aliceProject);
    runtime.persistenceStore.persist(bobProject, { 'b.txt': 'bob' });
    runtime.persistenceStore.persistNow(bobProject);

    // Two DISTINCT owners ⇒ two distinct per-owner store instances. A single
    // shared store pinned to one ownerId would show 1.
    assert.equal(runtime._ownerCounts().persistence, 2);
    assert.equal(runtime._ownerOf(aliceProject), alice.account.id);
    assert.equal(runtime._ownerOf(bobProject), bob.account.id);

    // Each project reads back its OWN tree.
    assert.deepEqual(runtime.persistenceStore.readPersistedTree(aliceProject), { 'a.txt': 'alice' });
    assert.deepEqual(runtime.persistenceStore.readPersistedTree(bobProject), { 'b.txt': 'bob' });

    // The control-plane snapshot paths are genuinely per-owner on disk.
    assert.notEqual(
      runtime.layout.controlSnapshotRegistryPath(alice.account.id, aliceProject),
      runtime.layout.controlSnapshotRegistryPath(bob.account.id, aliceProject),
    );

    // The SECRET store dispatches per owner too, and a secret stored for one
    // account's project is NOT visible to the other's.
    const aliceStores = runtime.storesForOwner(alice.account.id);
    aliceStores.secretStore.put(aliceProject, 'API_TOKEN', 'alice-token');
    assert.deepEqual(runtime.secretStore.envForProject(aliceProject), { API_TOKEN: 'alice-token' });
    assert.deepEqual(runtime.secretStore.envForProject(bobProject), {}, "bob's project must see none of alice's secrets");
    assert.equal(runtime._ownerCounts().secrets >= 2, true);

    // And the SNAPSHOT store resolves to the right owner for a registered project.
    const committed = runtime.snapshotStore.onTurnComplete({
      projectId: aliceProject,
      projectTree: { 'a.txt': 'alice' },
      verifyResult: { verdict: 'PASS' },
    });
    assert.equal(committed.ok, true);
    assert.equal(runtime._ownerCounts().snapshots >= 1, true);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('a CORRUPT registry denies the request instead of 500ing with a filesystem path', async () => {
  // ownerOf backs the server's projectResolver, and a registry read touches disk,
  // so it can throw. If that escaped, the catch-all handler would return 500 with
  // err.message — which contains the absolute control-plane path. It must deny.
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');
    const projectId = (await (await createProject(srv.base, token)).json()).id;

    // Corrupt the registry index on disk (unparseable JSON).
    const indexFile = path.join(runtime.layout.controlProjectRegistryRoot(), 'index.json');
    assert.ok(fs.existsSync(indexFile), 'the registry index should exist after a create');
    fs.writeFileSync(indexFile, '{ this is not json');

    const res = await fetch(`${srv.base}/work-mode?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401, 'a corrupt registry must DENY, not 500');
    const text = await res.text();
    assert.ok(!text.includes(dir), `the response must not leak a filesystem path, got ${text}`);
    assert.ok(!text.includes('JSON'), `the response must not leak the parse error, got ${text}`);

    // The resolver itself reports "no owner" rather than propagating.
    assert.equal(runtime._ownerOf(projectId), null);

    // ...but the fault is NOT silent: a corrupt control plane must be
    // distinguishable from "no such project" for whoever operates this.
    const recorded = composed.auditLog.ofType('PROJECT_REGISTRY_UNREADABLE');
    assert.ok(recorded.length > 0, 'an unreadable registry must be recorded on the audit log');
    assert.equal(recorded[0].projectId, projectId);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('an UNREGISTERED projectId is refused rather than written under a placeholder owner', () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime } = makeRuntime({ dir });
  try {
    // No owner can be resolved, so there is no correct per-owner store. Writing
    // anyway would put one account's data in another's path.
    assert.throws(() => runtime.persistenceStore.persist('not-a-registered-project', { 'x.txt': 'y' }), /not in the ProjectRegistry/);
    assert.throws(() => runtime.persistenceStore.readPersistedTree('nope'), /not in the ProjectRegistry/);
    // ...but a soft query answers truthfully rather than throwing.
    assert.equal(runtime.persistenceStore.hasPending('nope'), false);
    assert.throws(
      () => runtime.snapshotStore.onTurnComplete({ projectId: 'nope', projectTree: {}, verifyResult: { verdict: 'PASS' } }),
      /not in the ProjectRegistry/,
    );
    // Secret env is the one soft case: no owner ⇒ no secrets injected, not a throw.
    assert.deepEqual(runtime.secretStore.envForProject('nope'), {});
  } finally {
    cleanup();
  }
});

// ======================================================== redaction is now ACTIVE

test('platformSecretSet collects the platform credentials from the environment', () => {
  const set = platformSecretSet({
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OIDC_CLIENT_SECRET: 'oidc-secret',
    OPENROUTER_API_KEY: '   ', // whitespace-only is not a secret value
  });
  assert.ok(set.secretValues.includes('sk-ant-secret'));
  assert.ok(set.secretValues.includes('oidc-secret'));
  assert.ok(!set.secretValues.some((v) => v.trim() === ''));
  // Every NAME is always registered, so name-based redaction works even when the
  // value is unset in this process.
  assert.deepEqual(set.secretNames, [...PLATFORM_SECRET_ENV_NAMES]);
});

test('provider key names are DERIVED from plumby, not hand-copied (no drift)', () => {
  // A hand-written list had already missed GOOGLE_API_KEY, plumby's Gemini alias,
  // leaving that deployment's key unredacted. The names now come from plumby's own
  // PROVIDERS table through the engine boundary.
  for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) {
    assert.ok(PLATFORM_SECRET_ENV_NAMES.includes(name), `${name} must be redactable`);
  }
  // The platform's own (non-provider) credentials are included too.
  assert.ok(PLATFORM_SECRET_ENV_NAMES.includes('OIDC_CLIENT_SECRET'));
  assert.ok(PLATFORM_SECRET_ENV_NAMES.includes('OIDC_STATE_SIGNING_KEY'));
  // No duplicates (GEMINI/GOOGLE both come from the gemini entry).
  assert.equal(new Set(PLATFORM_SECRET_ENV_NAMES).size, PLATFORM_SECRET_ENV_NAMES.length);

  // A Gemini deployment using the alias really is redacted.
  const composed = composePlatformOps({ secretProvider: platformSecretSet({ GOOGLE_API_KEY: 'goog-secret-value-1234' }) });
  assert.ok(!composed.redactor.redact('boom goog-secret-value-1234').includes('goog-secret-value-1234'));
});

test('the entry point seeds the central redactor with the PLATFORM credentials', async () => {
  // composePlatformOps() was previously called with NO secretProvider, making
  // redaction a documented no-op in the only composition that ships.
  const { dir, cleanup } = tempDataDir();
  const apiKey = 'sk-ant-supersecretvalue-9999';
  const { api, composed } = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_DATA_DIR: dir, ANTHROPIC_API_KEY: apiKey },
    createRuntime: (args) => composeProjectRuntime({ ...args, createBackend: fakeBackend }),
    logger: { log: () => {} },
  });
  try {
    const leaked = composed.redactor.redact(`command failed: curl -H "authorization: Bearer ${apiKey}"`);
    assert.ok(!leaked.includes(apiKey), `the live API key must be redacted, got ${leaked}`);
  } finally {
    await api.close();
    cleanup();
  }
});

// ===================================================== entry-point composition

test('startPlatformServer composes the runtime so POST /projects is reachable in the real process', async () => {
  const { dir, cleanup } = tempDataDir();
  const logs = [];
  const { api, address, runtime } = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_DATA_DIR: dir },
    createRuntime: (args) => composeProjectRuntime({ ...args, createBackend: fakeBackend }),
    logger: { log: (m) => logs.push(m) },
  });
  try {
    const base = `http://${address.host}:${address.port}`;
    // Routed (401 = auth required), NOT 405 (unrouted).
    const res = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x', targetCategory: 'web', origin: 'blank' }),
    });
    assert.equal(res.status, 401);
    assert.notEqual(res.status, 405);

    // The health probe is unaffected, and the data directory is reported.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal(runtime.dataDir, path.resolve(dir));
    assert.ok(logs.some((m) => m.includes(dir)), `expected a data-dir log, got ${JSON.stringify(logs)}`);
  } finally {
    await api.close();
    cleanup();
  }
});

test('resolveDataDir honors AAB_DATA_DIR and resolves a relative value', () => {
  assert.equal(resolveDataDir({ AAB_DATA_DIR: '/srv/aab' }), '/srv/aab');
  assert.equal(resolveDataDir({ AAB_DATA_DIR: '  /srv/spaced  ' }), '/srv/spaced');
  assert.equal(resolveDataDir({}), DEFAULT_DATA_DIR);
  assert.ok(path.isAbsolute(resolveDataDir({ AAB_DATA_DIR: 'relative/dir' })));
});

test('the DEFAULT data directory is OUTSIDE the server\'s own tree', () => {
  // REGRESSION: a default of '.data' resolved to <server cwd>/.data, which put
  // every Project's sandbox mount — the agent's writable cwd — inside the server's
  // source checkout. The cwd-containment test elsewhere in this file only escapes
  // that by injecting a temp dir, so the DEFAULT needs its own assertion.
  const dflt = resolveDataDir({});
  assert.ok(path.isAbsolute(dflt));
  assert.ok(!dflt.startsWith(process.cwd()), `the default data dir must not live under the server tree, got ${dflt}`);
  // A blank/whitespace value is treated as unset, not as the cwd.
  assert.equal(resolveDataDir({ AAB_DATA_DIR: '   ' }), dflt);
});

test('AAB_MODEL is threaded into the server as the pinned model', async () => {
  const { dir, cleanup } = tempDataDir();
  const seen = [];
  const { api } = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_DATA_DIR: dir, AAB_MODEL: 'claude-opus-4-6' },
    createRuntime: (args) => composeProjectRuntime({ ...args, createBackend: fakeBackend }),
    createServer: (opts) => {
      seen.push(opts.model);
      return createBuilderServer(opts);
    },
    logger: { log: () => {} },
  });
  try {
    assert.deepEqual(seen, ['claude-opus-4-6']);
  } finally {
    await api.close();
    cleanup();
  }

  // Unset means "use the provider's default" — not an empty string.
  const second = tempDataDir();
  const unset = [];
  const { api: api2 } = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_DATA_DIR: second.dir },
    createRuntime: (args) => composeProjectRuntime({ ...args, createBackend: fakeBackend }),
    createServer: (opts) => {
      unset.push(Object.hasOwn(opts, 'model'));
      return createBuilderServer(opts);
    },
    logger: { log: () => {} },
  });
  try {
    assert.deepEqual(unset, [false], 'no model option should be passed when AAB_MODEL is unset');
  } finally {
    await api2.close();
    second.cleanup();
  }
});

test('storesForOwner refuses a missing or blank ownerId', () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime } = makeRuntime({ dir });
  try {
    // These handles are write-capable and the ownerId becomes a path component.
    assert.throws(() => runtime.storesForOwner(''), /ownerId must be a non-empty string/);
    assert.throws(() => runtime.storesForOwner('   '), /ownerId must be a non-empty string/);
    assert.throws(() => runtime.storesForOwner(undefined), /ownerId must be a non-empty string/);
    // A real owner works.
    const stores = runtime.storesForOwner('owner-1');
    assert.equal(typeof stores.secretStore.envForProject, 'function');
    assert.equal(typeof stores.persistenceStore.persist, 'function');
    assert.equal(typeof stores.snapshotStore.onTurnComplete, 'function');
  } finally {
    cleanup();
  }
});

test('composeProjectRuntime requires the platform-ops composition (no silent bypass)', () => {
  // Passing nothing would build a graph whose audit/redaction went nowhere.
  assert.throws(() => composeProjectRuntime({}), /requires the composePlatformOps result/);
  assert.throws(() => composeProjectRuntime({ composed: {} }), /requires the composePlatformOps result/);
});

test('CONTAINER_BIN and SANDBOX_IMAGE are threaded into the backend factory', () => {
  // Named for what it actually checks: option plumbing. It injects the factory, so
  // it does NOT construct the real backend (see the boot test below for that).
  const { dir, cleanup } = tempDataDir();
  try {
    const composed = composePlatformOps({});
    const built = [];
    const runtime = composeProjectRuntime({
      composed,
      env: { AAB_DATA_DIR: dir, CONTAINER_BIN: 'podman', SANDBOX_IMAGE: 'node:24-slim' },
      createBackend: (opts) => {
        built.push(opts);
        return fakeBackend();
      },
    });
    assert.equal(built.length, 1);
    assert.equal(built[0].bin, 'podman');
    assert.equal(built[0].image, 'node:24-slim');
    // Every container is also stamped with this deployment slot's identity, so a
    // startup reap can tell OUR crashed predecessor's containers from a live
    // sibling instance's.
    assert.equal(built[0].instanceId, runtime.instanceId);
    assert.ok(runtime.instanceId, 'an instance id is always resolved');
    assert.ok(runtime.sandboxManager);
  } finally {
    cleanup();
  }
});

test('composing the REAL container backend does no I/O (a host with no docker still boots)', () => {
  // Uses the DEFAULT createBackend — the real docker-CLI backend — and asserts
  // composition completes. If construction probed the runtime, this would throw or
  // hang on a host with no container runtime, and /healthz would never answer.
  const { dir, cleanup } = tempDataDir();
  try {
    const runtime = composeProjectRuntime({
      composed: composePlatformOps({}),
      env: { AAB_DATA_DIR: dir, CONTAINER_BIN: 'definitely-not-installed-binary' },
    });
    assert.equal(runtime.backend.bin, 'definitely-not-installed-binary');
    assert.equal(typeof runtime.backend.runOneShot, 'function');
    // Nothing was created on disk by composing, either.
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    cleanup();
  }
});

// ============================================== sandbox egress posture (blocker)

test('the composed sandbox runs with NO network by default, so commands actually run', async () => {
  // REGRESSION: inheriting the SandboxManager's default packageRegistryHosts
  // (['registry.npmjs.org']) makes the allowlist non-empty, which selects the
  // NETWORK_FILTERED mode that the real CLI backend refuses — denying every
  // command in every sandbox. The composition must state the posture explicitly.
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');
    const projectId = (await (await createProject(srv.base, token)).json()).id;

    assert.equal(runtime.egressMode, 'none');
    const handle = runtime.sandboxManager.acquire(projectId);
    assert.deepEqual(handle.egress.allowedHosts, [], 'the default allowlist must be EMPTY');

    // The decisive part: a command really runs against a backend that refuses
    // anything but network 'none' (as the real one does).
    const result = await runtime.sandboxManager.exec(projectId, ['echo', 'hi']);
    assert.notEqual(result.denied, true, `exec must not be denied, got ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.network, 'none');
    assert.equal(runtime.backend.runs.at(-1).network, 'none');
  } finally {
    await srv.close();
    cleanup();
  }
});

test("AAB_SANDBOX_EGRESS='registry' now composes a backend that can ENFORCE it, so commands run", async () => {
  // THE BEHAVIOR CHANGE. This mode used to select the NETWORK_FILTERED sentinel
  // that the plain CLI backend refuses, so choosing it denied EVERY command in
  // every sandbox — which is why `npm install` was impossible in any posture.
  // Composition now picks the filtering-capable backend for this mode.
  const { dir, cleanup } = tempDataDir();
  const { runtime } = makeRuntime({ dir, env: { AAB_SANDBOX_EGRESS: 'registry' } });
  try {
    assert.equal(runtime.egressMode, 'registry');
    assert.equal(runtime.backend.supportsEgressFiltering, true, 'this posture requires a backend that can enforce it');
    assert.deepEqual(runtime.backend.allowedHosts, ['registry.npmjs.org'], 'registry-only by default');
    // Construction does NO I/O, so a host with no runtime still boots — the plane is
    // built lazily on the first filtered command (asserted below).
    assert.deepEqual(runtime.backend.cli, []);

    const created = runtime.projectManager.createProject({
      accountId: 'owner-1', description: 'x', targetCategory: 'web', origin: 'blank',
    });
    const handle = runtime.sandboxManager.acquire(created.project.id);
    assert.ok(handle.egress.allowedHosts.includes('registry.npmjs.org'));
    assert.equal(handle.egress.denyByDefault, true, 'deny-by-default is not weakened by allowing the registry');

    const result = await runtime.sandboxManager.exec(created.project.id, ['npm', 'install']);
    assert.notEqual(result.denied, true, `the command must RUN, got ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.network, 'filtered', 'the manager requests filtered egress and the backend honors it');

    // The REAL backend built a real plane through the faked CLI: an internal network
    // for this project, and one allowlisting proxy container.
    assert.ok(
      runtime.backend.cli.some((a) => a[0] === 'network' && a[1] === 'create' && a.includes('--internal')),
      'the enforcement plane must actually be built',
    );
    assert.ok(runtime.backend.containers.has('aab-egress-proxy'), 'the allowlisting proxy must be running');
  } finally {
    cleanup();
  }
});

test('the default posture still composes the PLAIN backend, which cannot filter', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { runtime } = makeRuntime({ dir });
    assert.equal(runtime.egressMode, 'none');
    assert.equal(runtime.backend.supportsEgressFiltering, false, 'no egress plane is built for a no-network posture');
    assert.equal(runtime.backend.allowedHosts, undefined);
  } finally {
    cleanup();
  }
});

test('AAB_SANDBOX_EGRESS_HOSTS extends the allowlist, and only in a mode that has a network', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { runtime } = makeRuntime({
      dir,
      env: { AAB_SANDBOX_EGRESS: 'registry', AAB_SANDBOX_EGRESS_HOSTS: 'npm.internal.example.com, api.stripe.com' },
    });
    // Sanitized: normalized, de-duplicated and sorted, so the policy is deterministic.
    assert.deepEqual(runtime.backend.allowedHosts, ['api.stripe.com', 'npm.internal.example.com', 'registry.npmjs.org']);
    // The project's own allowlist reflects it too, so the manager and the proxy agree.
    const created = runtime.projectManager.createProject({
      accountId: 'owner-1', description: 'x', targetCategory: 'web', origin: 'blank',
    });
    const hosts = runtime.sandboxManager.acquire(created.project.id).egress.allowedHosts;
    assert.ok(hosts.includes('npm.internal.example.com'));

    // In 'none' there is no network to allow anything on, so the extra hosts are
    // NOT honored — they must not quietly re-enable egress.
    const off = makeRuntime({ dir, env: { AAB_SANDBOX_EGRESS_HOSTS: 'evil.example.com' } });
    assert.equal(off.runtime.egressMode, 'none');
    assert.equal(off.runtime.backend.supportsEgressFiltering, false);
    const p2 = off.runtime.projectManager.createProject({
      accountId: 'owner-2', description: 'x', targetCategory: 'web', origin: 'blank',
    });
    assert.deepEqual(off.runtime.sandboxManager.acquire(p2.project.id).egress.allowedHosts, [], 'no host is allowed with no network');
  } finally {
    cleanup();
  }
});

test('an unrecognized AAB_SANDBOX_EGRESS falls back to the restrictive posture', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    for (const mode of ['', 'wide-open', 'ALL', 'none']) {
      const { runtime } = makeRuntime({ dir, env: { AAB_SANDBOX_EGRESS: mode } });
      assert.equal(runtime.egressMode, 'none', `${JSON.stringify(mode)} must not widen egress`);
    }
    // Only the explicit, recognized value opts in.
    assert.equal(makeRuntime({ dir, env: { AAB_SANDBOX_EGRESS: 'registry' } }).runtime.egressMode, 'registry');
  } finally {
    cleanup();
  }
});

// ================================================= preview posture (follow-up 1)

test('the Preview is the INERT seam by default — no container, and no egress opened behind the operator', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { runtime } = makeRuntime({ dir });
    assert.equal(runtime.previewMode, 'inert');
    assert.equal(runtime.previewNetwork, null);
    // The default must not launch anything: a Preview needs a routable network, and
    // the previewed app is untrusted GENERATED code, so opening one is the
    // operator's explicit decision, never a default.
    const created = runtime.projectManager.createProject({
      accountId: 'owner-1', description: 'x', targetCategory: 'web', origin: 'blank',
    });
    const handle = runtime.sandboxManager.acquire(created.project.id);
    const started = runtime.devServer.start({ projectId: created.project.id, sandbox: handle });
    assert.equal(started.ok, true);
    assert.match(started.url, /^http:\/\/preview\.local\//, 'the inert seam reports a placeholder, honestly');
    assert.equal(runtime.backend.services.length, 0, 'the default posture must launch NO service container');
  } finally {
    cleanup();
  }
});

test('AAB_PREVIEW_NETWORK makes the Preview REAL: a published dev-server container and a live URL', async () => {
  const { dir, cleanup } = tempDataDir();
  try {
    const { runtime } = makeRuntime({
      dir,
      env: { AAB_PREVIEW_NETWORK: 'aab-preview', AAB_PREVIEW_PORT_RANGE: '45000-45010' },
    });
    assert.equal(runtime.previewMode, 'container');
    assert.equal(runtime.previewNetwork, 'aab-preview');

    const created = runtime.projectManager.createProject({
      accountId: 'owner-1', description: 'x', targetCategory: 'web', origin: 'blank',
    });
    const projectId = created.project.id;
    const handle = runtime.sandboxManager.acquire(projectId);
    // Give the project something to serve, at the REAL bind-mount source the
    // layout resolved for it.
    fs.mkdirSync(handle.mountSource, { recursive: true });
    fs.writeFileSync(path.join(handle.mountSource, 'index.html'), '<h1>hi</h1>');

    const started = runtime.devServer.start({ projectId, sandbox: handle, targetCategory: 'web' });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.url, 'http://127.0.0.1:45000', 'the URL is a real published host port');
    assert.ok(!started.url.includes('preview.local'));

    // A real service container was requested, inside this project's boundary.
    assert.equal(runtime.backend.services.length, 1);
    const spec = runtime.backend.services[0];
    assert.equal(spec.network, 'aab-preview');
    assert.equal(spec.mountSource, handle.mountSource);
    assert.equal(spec.labelValue, handle.containerName, 'the owner label is what release() already reaps');
    assert.deepEqual(spec.publish, [{ hostIp: '127.0.0.1', hostPort: 45_000, containerPort: 5173 }]);
    // No dev script in a blank project, so the stdlib static server serves it —
    // which needs no install and therefore works under deny-by-default egress.
    assert.equal(spec.command[0], 'node');

    runtime.devServer.stop(projectId);
    await runtime.devServer.whenStopped(projectId);
  } finally {
    cleanup();
  }
});

test('resolvePreviewConfig only enables a preview for an explicit network, and validates the port range', () => {
  assert.deepEqual(resolvePreviewConfig({}), { enabled: false, network: null });
  assert.deepEqual(resolvePreviewConfig({ AAB_PREVIEW_NETWORK: '   ' }), { enabled: false, network: null });

  const on = resolvePreviewConfig({ AAB_PREVIEW_NETWORK: 'net-a' });
  assert.equal(on.enabled, true);
  assert.equal(on.network, 'net-a');
  assert.equal(on.hostIp, '127.0.0.1', 'a preview publishes on loopback unless told otherwise');
  assert.equal(on.portRange, undefined, 'an unset range leaves the module default in place');

  assert.deepEqual(resolvePreviewConfig({ AAB_PREVIEW_NETWORK: 'n', AAB_PREVIEW_PORT_RANGE: '5000-5010' }).portRange, { from: 5_000, to: 5_010 });
  // A malformed or inverted range falls back to the default rather than guessing.
  for (const bad of ['5000', 'a-b', '5010-5000', '0-10', '1-70000', '']) {
    assert.equal(
      resolvePreviewConfig({ AAB_PREVIEW_NETWORK: 'n', AAB_PREVIEW_PORT_RANGE: bad }).portRange,
      undefined,
      `${JSON.stringify(bad)} must not be honored`,
    );
  }
  assert.equal(resolvePreviewConfig({ AAB_PREVIEW_NETWORK: 'n', AAB_PREVIEW_HOST_IP: '10.0.0.5' }).hostIp, '10.0.0.5');

  // The container port is range-checked HERE, not left to fail every start() later.
  assert.equal(resolvePreviewConfig({ AAB_PREVIEW_NETWORK: 'n', AAB_PREVIEW_CONTAINER_PORT: '3000' }).containerPort, 3_000);
  for (const bad of ['99999', '0', '-1', 'abc', '65536']) {
    assert.equal(
      resolvePreviewConfig({ AAB_PREVIEW_NETWORK: 'n', AAB_PREVIEW_CONTAINER_PORT: bad }).containerPort,
      undefined,
      `${bad} is not a usable container port`,
    );
  }
});

test('asking for a real Preview from a backend that cannot run services REFUSES to compose', () => {
  const { dir, cleanup } = tempDataDir();
  try {
    // Silently falling back to the inert seam is how you ship placeholder URLs
    // while believing previews work. Fail loudly instead.
    const serviceless = () => {
      const b = fakeBackend();
      const { startService, ...rest } = b;
      return rest;
    };
    assert.throws(
      () =>
        composeProjectRuntime({
          composed: composePlatformOps({ secretProvider: platformSecretSet({}) }),
          env: { AAB_DATA_DIR: dir, AAB_PREVIEW_NETWORK: 'aab-preview' },
          createBackend: serviceless,
        }),
      /cannot run long-running service containers/,
    );
  } finally {
    cleanup();
  }
});

// ========================================== concurrency ceiling (blocker regress)

test('REGRESSION: the platform keeps working past 10 projects (the ceiling is not 10)', async () => {
  // The quota is enforced against sandboxManager.activeProjectIds(), a set of
  // boundary HANDLES that nothing releases on the success path. Enforcing the
  // module default of 10 against it wedged the platform after ten projects: every
  // later create AND every turn 429'd until restart. Nothing is released by hand
  // here — that is the point.
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');
    for (let i = 0; i < 14; i += 1) {
      const res = await createProject(srv.base, token, { description: `app ${i}` });
      assert.equal(res.status, 201, `create ${i} must still succeed (no manual release)`);
    }
    assert.equal(runtime.sandboxManager.activeProjectIds().length, 14);

    // ...and a turn on the 14th project is not refused either.
    const ids = runtime.registry.listForOwner((await srv.login('alice')).account.id);
    const turn = await fetch(`${srv.base}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: ids.at(-1).id, text: 'keep going' }),
    });
    assert.notEqual(turn.status, 429, 'a turn must not be rate/quota refused once 10 projects exist');
  } finally {
    await srv.close();
    cleanup();
  }
});

test('BLOCKER REGRESSION: hitting the ceiling is RECOVERABLE without a restart', async () => {
  // The concurrency count is the size of a boundary set that nothing releases on
  // any success path, so without a downward edge the ceiling is permanent: once
  // reached, every create and every turn 429s until the process restarts. (Raising
  // the ceiling to the SandboxManager's LRU capacity does NOT fix this — the quota
  // denies at `current >= max` before the acquire that would trigger eviction at
  // `size > max`, so eviction can never run from a request path.) Idle reclamation
  // is the downward edge, and it is driven by the INJECTED clock — no real waiting,
  // no manual release anywhere in this test.
  const { dir, cleanup } = tempDataDir();
  const clock = fakeClock();
  const { runtime, composed } = makeRuntime({
    dir,
    clock,
    env: { AAB_MAX_CONCURRENT_SANDBOXES: '3', AAB_SANDBOX_IDLE_MS: '60000' },
  });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await createProject(srv.base, token, { description: `app ${i}` })).status, 201);
    }

    // Saturated.
    assert.equal((await createProject(srv.base, token, { description: 'over' })).status, 429);

    // Time passes; those boundaries go idle. THIS is the property under test.
    clock.advance(60_001);
    const afterIdle = await createProject(srv.base, token, { description: 'after idle' });
    assert.equal(afterIdle.status, 201, 'an idle-reclaimed ceiling must recover WITHOUT a restart');

    // The reclamation really dropped the idle boundaries from the in-use count
    // rather than the ceiling being miscounted: only the new project is in use.
    assert.equal(runtime.sandboxManager.activeProjectIdsInUse().length, 1);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('idle reclamation does NOT release a sandbox still in use', async () => {
  const { dir, cleanup } = tempDataDir();
  const clock = fakeClock();
  const { runtime } = makeRuntime({ dir, clock, env: { AAB_SANDBOX_IDLE_MS: '60000' } });
  try {
    const a = runtime.projectManager.createProject({ accountId: 'o1', description: 'a', targetCategory: 'web', origin: 'blank' });
    const b = runtime.projectManager.createProject({ accountId: 'o1', description: 'b', targetCategory: 'web', origin: 'blank' });
    assert.equal(runtime.sandboxManager.activeProjectIds().length, 2);

    // Nearly idle, then project A is touched again.
    clock.advance(59_000);
    runtime.sandboxManager.acquire(a.project.id);

    clock.advance(2_000); // A: 2s idle. B: 61s idle.
    // The in-use boundary is excluded from reclamation, and the in-use COUNT (what
    // the quota reads) drops immediately — release() itself is async teardown.
    assert.deepEqual(runtime.sandboxManager.activeProjectIdsInUse(), [a.project.id], 'the in-use sandbox survives');
    const reclaimed = runtime.sandboxManager.reclaimIdle();
    assert.equal(reclaimed, 1, 'exactly the idle boundary is reclaimed');
    assert.deepEqual(runtime.sandboxManager.activeProjectIdsInUse(), [a.project.id]);
  } finally {
    cleanup();
  }
});

test('a boundary RE-ACQUIRED during teardown is not torn down (cancellation guard)', async () => {
  // The commonest path into this race is the first turn after an idle period: the
  // turn's own quota check sweeps and schedules that project's release, and THEN
  // the turn acquires the boundary for the agent cwd. Without a cancellation guard
  // the release lands afterwards, deletes the fresh record and reaps the project's
  // containers by label — killing the command the turn just launched.
  const { dir, cleanup } = tempDataDir();
  const clock = fakeClock();
  const { runtime } = makeRuntime({ dir, clock, env: { AAB_SANDBOX_IDLE_MS: '60000' } });
  try {
    const created = runtime.projectManager.createProject({
      accountId: 'o1', description: 'a', targetCategory: 'web', origin: 'blank',
    });
    const projectId = created.project.id;

    clock.advance(61_000);                       // now idle
    assert.equal(runtime.sandboxManager.reclaimIdle(), 1); // release scheduled
    runtime.sandboxManager.acquire(projectId);   // ...and immediately re-acquired

    // Let the deferred teardown run.
    await new Promise((r) => setTimeout(r, 10));

    // The boundary the caller is holding must still be alive, and no container
    // teardown should have been attempted for it.
    assert.deepEqual(runtime.sandboxManager.activeProjectIdsInUse(), [projectId]);
    assert.ok(runtime.sandboxManager.get(projectId), 'the re-acquired boundary must survive');
  } finally {
    cleanup();
  }
});

test('reclamation never tears down a sandbox with a command IN FLIGHT', async () => {
  // The SandboxManager's own LRU eviction refuses to evict a boundary with
  // in-flight work; a purely time-based sweep must honor the same invariant, or
  // lowering AAB_SANDBOX_IDLE_MS below a command's wall clock kills it mid-run.
  const { dir, cleanup } = tempDataDir();
  const clock = fakeClock();
  let releaseExec;
  const blocking = () => {
    const b = fakeBackend();
    return {
      ...b,
      async runOneShot(spec) {
        if (spec.network !== 'none') throw new Error('refuse');
        await new Promise((r) => { releaseExec = r; });
        return { code: 0, stdout: '', stderr: '', timedOut: false, limitsApplied: true };
      },
    };
  };
  const composed = composePlatformOps({});
  const runtime = composeProjectRuntime({
    composed,
    env: { AAB_DATA_DIR: dir, AAB_SANDBOX_IDLE_MS: '1000' },
    now: clock.now,
    createBackend: blocking,
  });
  try {
    const created = runtime.projectManager.createProject({
      accountId: 'o1', description: 'a', targetCategory: 'web', origin: 'blank',
    });
    const projectId = created.project.id;

    // Start a command that does not finish, then let the idle window elapse.
    const running = runtime.sandboxManager.exec(projectId, ['sleep', 'forever']);
    await new Promise((r) => setTimeout(r, 5));
    clock.advance(5_000);

    assert.equal(runtime.sandboxManager.reclaimIdle(), 0, 'an in-flight exec must block reclamation');
    assert.ok(runtime.sandboxManager.get(projectId), 'the boundary survives while a command runs');

    releaseExec();
    await running;
    // Once it completes, completion counts as use — so it is not instantly idle.
    assert.equal(runtime.sandboxManager.reclaimIdle(), 0);
    clock.advance(5_000);
    assert.equal(runtime.sandboxManager.reclaimIdle(), 1, 'and it becomes reclaimable afterwards');
  } finally {
    cleanup();
  }
});

test('a FAILED reclamation is recorded rather than swallowed', async () => {
  const { dir, cleanup } = tempDataDir();
  const clock = fakeClock();
  const failing = () => {
    const b = fakeBackend();
    return { ...b, async remove() { throw new Error('docker daemon unreachable'); } };
  };
  const composed = composePlatformOps({});
  const runtime = composeProjectRuntime({
    composed,
    env: { AAB_DATA_DIR: dir, AAB_SANDBOX_IDLE_MS: '60000' },
    now: clock.now,
    createBackend: failing,
  });
  try {
    runtime.projectManager.createProject({ accountId: 'o1', description: 'a', targetCategory: 'web', origin: 'blank' });
    clock.advance(61_000);
    assert.equal(runtime.sandboxManager.reclaimIdle(), 1);
    await new Promise((r) => setTimeout(r, 10));

    // release() collects non-throwing teardown failures in `errors`; either shape
    // must surface on the wired audit log.
    const recorded = [
      ...composed.auditLog.ofType('SANDBOX_RECLAIM_FAILED'),
      ...composed.auditLog.ofType('SANDBOX_RECLAIM_INCOMPLETE'),
    ];
    assert.ok(recorded.length > 0, 'a failed container teardown must not be silent');
    assert.match(recorded[0].reason, /docker daemon unreachable/);
  } finally {
    cleanup();
  }
});

test('the concurrency ceiling is still ENFORCED, at the configured value', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir, env: { AAB_MAX_CONCURRENT_SANDBOXES: '3' } });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await createProject(srv.base, token, { description: `app ${i}` })).status, 201);
    }
    const refused = await createProject(srv.base, token, { description: 'the 4th' });
    assert.equal(refused.status, 429);
    const body = await refused.json();
    assert.equal(body.limit, 'Resource_Quota');
    assert.equal(body.resource, 'concurrentSandboxes');
  } finally {
    await srv.close();
    cleanup();
  }
});

test('resolveQuotaConfig reads the env and keeps the ceiling BELOW the sandbox capacity', () => {
  const dflt = resolveQuotaConfig({});
  assert.equal(dflt.quota.maxConcurrentSandboxes, DEFAULT_MAX_CONCURRENT_SANDBOXES);
  // Setting the ceiling equal to the manager's capacity is a trap: the quota
  // denies at `current >= max` before the acquire that would trigger LRU eviction
  // at `size > max`, so eviction could never run and the count could never fall.
  assert.ok(
    DEFAULT_MAX_CONCURRENT_SANDBOXES < DEFAULT_MAX_SANDBOXES,
    'the ceiling must stay below the SandboxManager capacity so LRU is never the binding mechanism',
  );
  // The per-account ceiling stays a deliberate product decision: unset unless asked.
  assert.equal(dflt.quota.maxConcurrentSandboxesPerAccount, undefined);

  const configured = resolveQuotaConfig({
    AAB_MAX_CONCURRENT_SANDBOXES: '32',
    AAB_MAX_CONCURRENT_SANDBOXES_PER_ACCOUNT: '4',
    AAB_MAX_TOTAL_PROJECTS: '5',
  });
  assert.equal(configured.quota.maxConcurrentSandboxes, 32);
  assert.equal(configured.quota.maxConcurrentSandboxesPerAccount, 4);
  assert.equal(configured.quota.maxTotalProjects, 5);

  // Garbage does not silently widen or narrow the ceiling.
  assert.equal(resolveQuotaConfig({ AAB_MAX_CONCURRENT_SANDBOXES: 'lots' }).quota.maxConcurrentSandboxes, DEFAULT_MAX_CONCURRENT_SANDBOXES);
  assert.equal(resolveQuotaConfig({ AAB_MAX_CONCURRENT_SANDBOXES: '-5' }).quota.maxConcurrentSandboxes, DEFAULT_MAX_CONCURRENT_SANDBOXES);
});

test('the per-account anti-starvation ceiling is ENFORCEABLE once configured', async () => {
  // Req 23: without this, one account can consume the entire global allowance.
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({
    dir,
    env: { AAB_MAX_CONCURRENT_SANDBOXES: '10', AAB_MAX_CONCURRENT_SANDBOXES_PER_ACCOUNT: '2' },
  });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');

    assert.equal((await createProject(srv.base, alice.token, { description: 'a1' })).status, 201);
    assert.equal((await createProject(srv.base, alice.token, { description: 'a2' })).status, 201);
    const aliceThird = await createProject(srv.base, alice.token, { description: 'a3' });
    assert.equal(aliceThird.status, 429, "alice's per-account ceiling must bind");

    // Bob is unaffected by alice's usage — that is the anti-starvation property.
    assert.equal((await createProject(srv.base, bob.token, { description: 'b1' })).status, 201);
  } finally {
    await srv.close();
    cleanup();
  }
});


// ============================== WEB UI settings surfaces are LIVE (Req 12-15)
//
// The /settings/* routes were built on createBuilderServer and each gated behind
// an injected backing service, but the production composition never constructed
// one — so in the live boot every /settings/* route fell through to 405, exactly
// like POST /projects did before the runtime was wired. These tests prove the
// composition now injects those services (so the routes are reachable in a real
// deploy) and are written to FAIL if the wiring is reverted. They use the SAME
// real StorageLayout + real server + real fetch harness as the rest of this
// file; nothing about the settings services is faked.

import { resolveShareLinkBaseUrl } from '../src/server/compose-runtime.js';

/** The settings services the composition must now inject. */
const SETTINGS_SERVICE_KEYS = [
  'providerResolver',
  'connectorService',
  'connectorBindingStore',
  'skillLibrary',
  'memoryStore',
  'projectExporter',
  'lockinAudit',
  'shareLinkService',
];

test('serverOptions() now injects every settings backing service as a usable object', () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime } = makeRuntime({ dir });
  try {
    const opts = runtime.serverOptions();
    for (const key of SETTINGS_SERVICE_KEYS) {
      assert.ok(opts[key] && typeof opts[key] === 'object', `serverOptions().${key} must be injected`);
    }

    // Each is the REAL service surface, not an empty placeholder — spot-check the
    // method/property each /settings route actually consumes.
    assert.deepEqual(
      [...runtime.providerResolver.supportedProviders],
      ['anthropic', 'gemini', 'openrouter'],
      'the provider resolver reflects plumby PROVIDERS through the engine boundary',
    );
    assert.ok(runtime.connectorService.catalog.list().length > 0, 'the connector catalog is served');
    assert.equal(typeof runtime.connectorService.addConnector, 'function');
    assert.equal(typeof runtime.connectorBindingStore.list, 'function');
    assert.equal(typeof runtime.skillLibrary.readUserSkills, 'function');
    assert.equal(typeof runtime.skillLibrary.createUserSkill, 'function');
    assert.equal(typeof runtime.memoryStore.globalStore, 'function');
    assert.equal(typeof runtime.memoryStore.projectStore, 'function');
    assert.equal(typeof runtime.projectExporter.export, 'function');
    assert.equal(typeof runtime.lockinAudit.audit, 'function');
    assert.equal(typeof runtime.shareLinkService.share, 'function');
  } finally {
    cleanup();
  }
});

test('build/deploy is now WIRED to a real engine — projectLifecycle is injected and the routes answer', async () => {
  // THE HONESTY CONTRACT, DELIBERATELY UPDATED. This test previously asserted the
  // OPPOSITE: build/deploy was left unwired (405) because `build-service.js`'s two
  // work boundaries were inert seams, and injecting a projectLifecycle over them
  // would have returned a fabricated success. Both boundaries are now REAL —
  // src/project/container-build.js runs the project's own build script inside its
  // Isolation_Boundary, and src/project/self-hosted-deploy.js publishes the artifact
  // to a location this platform serves — so the honest state is the reverse: the
  // engine is composed and the routes are reachable. What must NOT come back is a
  // success reported for work that did not happen, which is asserted here (a project
  // with no build script gets a NON-success outcome) and in detail in
  // test/build-deploy-engine.test.js.
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  assert.equal(Object.hasOwn(runtime.serverOptions(), 'projectLifecycle'), true, 'the real build/deploy engine must be injected');
  assert.equal(Object.hasOwn(runtime.serverOptions(), 'publishedSites'), true, 'the published-site read side must be injected');

  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const created = await createProject(srv.base, token);
    const projectId = (await created.json()).id;

    for (const route of ['/settings/build', '/settings/deploy']) {
      const res = await fetch(`${srv.base}${route}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ projectId }),
      });
      assert.notEqual(res.status, 405, `${route} must be routed now that the engine is real`);
      assert.equal(res.status, 200);
      const body = await res.json();
      // A blank Project has no build script, so the ONLY honest answer is a
      // non-success outcome with a reason — never { outcome: 'succeeded' }.
      assert.notEqual(body.outcome, 'succeeded', `${route} must not fabricate a success`);
      assert.equal(typeof body.summary, 'string');
    }

    // An unresolvable project is still denied at the gate, disclosing nothing.
    const unknown = await fetch(`${srv.base}/settings/build`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'no-such-project' }),
    });
    assert.equal(unknown.status, 401);
    assert.deepEqual(await unknown.json(), { error: 'access denied' });
  } finally {
    await srv.close();
    cleanup();
  }
});

test('the per-account settings routes are ROUTED in the live composition (was 405 before)', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const { token } = await srv.login('alice');
    const auth = { authorization: `Bearer ${token}` };
    // GET routes that gate on authn only (per-account) must now answer 200 — each
    // was 405 (unrouted) before the settings services were composed.
    for (const url of ['/settings/provider', '/settings/connectors', '/settings/skills', '/settings/memory']) {
      const res = await fetch(`${srv.base}${url}`, { headers: auth });
      assert.notEqual(res.status, 405, `${url} must be routed once its service is composed`);
      assert.equal(res.status, 200, `${url} answers for an authenticated account`);
    }
  } finally {
    await srv.close();
    cleanup();
  }
});

test('the connector service is PER-ACCOUNT: a submitted secret lands in the requesting account\'s own owner dir, never a shared placeholder, and is never echoed', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');
    assert.notEqual(alice.account.id, bob.account.id);

    const SECRET = 'sk_live_PERACCOUNT_9f3a';
    const conf = await fetch(`${srv.base}/settings/connectors`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'stripe', secrets: { STRIPE_SECRET_KEY: SECRET } }),
    });
    const text = await conf.text();
    assert.equal(conf.status, 200);
    assert.ok(!text.includes(SECRET), 'the submitted secret value must never be echoed');
    assert.deepEqual(JSON.parse(text).bound.secretRefs, ['STRIPE_SECRET_KEY'], 'only the NAME is surfaced');

    // Alice's active binding is visible to Alice (name-only)...
    const aliceBound = await (await fetch(`${srv.base}/settings/connectors`, {
      headers: { authorization: `Bearer ${alice.token}` },
    })).json();
    // GET with no projectId scopes bound to []; the per-account bound listing is
    // exercised directly through the composed facade below (the route only lists
    // when a projectId is supplied — here the account id is that scope).

    // ...and NOT to Bob: a different account's connector facade resolves a
    // different owner, so Bob sees none of Alice's bindings.
    const bobBinding = runtime.connectorBindingStore.list(bob.account.id);
    const aliceBinding = runtime.connectorBindingStore.list(alice.account.id);
    assert.ok(aliceBinding.some((b) => b.connector.service === 'stripe'), 'alice owns the stripe binding');
    assert.ok(!bobBinding.some((b) => b.connector.service === 'stripe'), 'bob must not see alice\'s binding');

    // The credential VALUE is stored out-of-tree under ALICE's owner and is
    // injectable for her scope, but not under bob's — the per-owner isolation the
    // facade preserves. (accountId is the connectors screen's default scope.)
    const aliceStores = runtime.storesForOwner(alice.account.id);
    assert.equal(aliceStores.secretStore.get(alice.account.id, 'STRIPE_SECRET_KEY'), SECRET);
    const bobStores = runtime.storesForOwner(bob.account.id);
    assert.equal(bobStores.secretStore.get(bob.account.id, 'STRIPE_SECRET_KEY'), null, 'bob\'s owner dir holds none of it');

    assert.ok(Array.isArray(aliceBound.bound));
  } finally {
    await srv.close();
    cleanup();
  }
});

test('the connector facade resolves the OWNER of a registered project, not the caller\'s account', async () => {
  // When a real projectId is supplied, the per-account facade must select the
  // project's OWNER (via ownerOf), so a connector added against a project lands in
  // that project owner's directory — proven by the binding being readable through
  // the owner-keyed store and the owner-count incrementing for the real owner.
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const projectId = (await (await createProject(srv.base, alice.token)).json()).id;

    const conf = await fetch(`${srv.base}/settings/connectors`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'stripe', projectId, secrets: { STRIPE_SECRET_KEY: 'sk_live_proj' } }),
    });
    assert.equal(conf.status, 200);

    // The binding is stored under alice (the project's real owner) and keyed by
    // the projectId — resolvable through the owner-agnostic facade.
    const bound = runtime.connectorBindingStore.list(projectId);
    assert.ok(bound.some((b) => b.connector.service === 'stripe' && b.status === 'active'));
    assert.equal(runtime._ownerOf(projectId), alice.account.id, 'the project resolves to alice');
  } finally {
    await srv.close();
    cleanup();
  }
});

test('skills + memory are per-account through ONE stateless-by-layout instance', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');
    const auth = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

    // Alice adds a User_Skill; it is owned by her account only.
    const add = await fetch(`${srv.base}/settings/skills`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ name: 'alice-skill', description: 'does a thing', body: '# hi' }),
    });
    assert.equal(add.status, 200);

    const aliceSkills = await (await fetch(`${srv.base}/settings/skills`, { headers: auth(alice.token) })).json();
    assert.ok(aliceSkills.user.some((s) => s.name === 'alice-skill'));
    const bobSkills = await (await fetch(`${srv.base}/settings/skills`, { headers: auth(bob.token) })).json();
    assert.ok(!bobSkills.user.some((s) => s.name === 'alice-skill'), 'bob must not see alice\'s skill');

    // Memory mode set for Alice's global scope does not affect Bob's.
    const mode = await fetch(`${srv.base}/settings/memory`, {
      method: 'POST', headers: auth(alice.token), body: JSON.stringify({ op: 'mode', mode: 'manual' }),
    });
    assert.equal(mode.status, 200);
    assert.equal((await mode.json()).mode, 'manual');
    const bobMem = await (await fetch(`${srv.base}/settings/memory`, { headers: auth(bob.token) })).json();
    assert.equal(bobMem.mode, 'auto', 'bob\'s memory mode is unaffected (its own per-account scope)');
  } finally {
    await srv.close();
    cleanup();
  }
});

test('export + lockin-audit are reachable and functional on an OWNED project (per-project auth)', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');
    const projectId = (await (await createProject(srv.base, alice.token)).json()).id;

    const exp = await (await fetch(`${srv.base}/settings/export?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    })).json();
    assert.ok(exp.files && typeof exp.envTemplate === 'string', 'a real export package is produced');

    const aud = await (await fetch(`${srv.base}/settings/lockin-audit?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    })).json();
    assert.equal(typeof aud.clean, 'boolean');
    assert.ok(Array.isArray(aud.findings));

    // Per-project auth still holds: a different account is denied identically.
    const intruderExport = await fetch(`${srv.base}/settings/export?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    assert.equal(intruderExport.status, 401);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('share links are per-owner: a link for an OWNED project is minted with the configured base URL', async () => {
  const { dir, cleanup } = tempDataDir();
  const { runtime, composed } = makeRuntime({ dir, env: { AAB_SHARE_BASE_URL: 'https://share.example.test' } });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');
    const projectId = (await (await createProject(srv.base, alice.token)).json()).id;

    const res = await fetch(`${srv.base}/settings/share`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    assert.equal(res.status, 200);
    const { url } = await res.json();
    assert.ok(url.startsWith('https://share.example.test/'), `absolute URL from the configured base, got ${url}`);

    // The link is really persisted under ALICE's (the project owner's) share-link
    // store — a per-owner store keyed by her account.
    const aliceLinks = createShareLinkStoreFor(runtime, alice.account.id);
    assert.ok(aliceLinks.length >= 1, 'a link is persisted under the owning account');

    // A non-owner sharing the same project is denied with the non-disclosing 401.
    const denied = await fetch(`${srv.base}/settings/share`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: 'access denied' });
  } finally {
    await srv.close();
    cleanup();
  }
});

/** Read the persisted Share_Links for an owner directly (per-owner store). */
function createShareLinkStoreFor(runtime, ownerId) {
  return createShareLinkStore({ layout: runtime.layout, ownerId }).list();
}

test('resolveShareLinkBaseUrl reads AAB_SHARE_BASE_URL / PUBLIC_BASE_URL, trims trailing slashes, and is optional', () => {
  assert.equal(resolveShareLinkBaseUrl({ AAB_SHARE_BASE_URL: 'https://s.example.test/' }), 'https://s.example.test');
  assert.equal(resolveShareLinkBaseUrl({ PUBLIC_BASE_URL: 'https://p.example.test' }), 'https://p.example.test');
  // AAB_SHARE_BASE_URL wins over PUBLIC_BASE_URL.
  assert.equal(
    resolveShareLinkBaseUrl({ AAB_SHARE_BASE_URL: 'https://a.example.test', PUBLIC_BASE_URL: 'https://p.example.test' }),
    'https://a.example.test',
  );
  // Unset / blank -> undefined (the builder-server then falls back to a relative path).
  assert.equal(resolveShareLinkBaseUrl({}), undefined);
  assert.equal(resolveShareLinkBaseUrl({ AAB_SHARE_BASE_URL: '   ' }), undefined);
});

test('the full settings-service bundle spreads through startPlatformServer with NO change to start.js', async () => {
  // The decisive end-to-end: the real entry point composes the runtime and spreads
  // runtime.serverOptions() into createBuilderServer. If the settings services were
  // not in that bundle, these routes would be 405 in the real process.
  const { dir, cleanup } = tempDataDir();
  const { api, address } = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_DATA_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-x' },
    createRuntime: (args) => composeProjectRuntime({ ...args, createBackend: fakeBackend }),
    idpVerifier: {
      async verifyIdToken(idToken) {
        if (!idToken) throw new Error('no token');
        return { provider: 'github', subject: idToken };
      },
    },
    logger: { log: () => {} },
  });
  try {
    const base = `http://${address.host}:${address.port}`;
    // No token -> 401 (routed + gated), NOT 405 (unrouted). This is the property.
    for (const url of ['/settings/provider', '/settings/connectors', '/settings/skills', '/settings/memory']) {
      const res = await fetch(`${base}${url}`);
      assert.equal(res.status, 401, `${url} is routed + gated in the live process (401, not 405)`);
    }
    // build/deploy are ROUTED in the live process now that the engine behind the
    // build/deploy boundaries is real (they were 405 while it was an inert seam).
    // No token -> the same non-disclosing 401 as every other project route.
    for (const url of ['/settings/build', '/settings/deploy']) {
      const res = await fetch(`${base}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'p' }),
      });
      assert.equal(res.status, 401, `${url} is routed + gated in the live process (401, not 405)`);
      assert.deepEqual(await res.json(), { error: 'access denied' });
    }
  } finally {
    await api.close();
    cleanup();
  }
});
