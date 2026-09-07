/**
 * Startup orphan-reap tests (node --test).
 *
 * THE BEHAVIOR UNDER TEST. A platform process that dies uncleanly leaves its
 * sandbox containers running — per-project cleanup happens on `release()`, which
 * never runs if the process that would call it is gone. Nothing collected them.
 * This adds an OPTIONAL reap at startup, subject to three properties that were the
 * reason it had not been done:
 *
 *   1. it must never block `/healthz`;
 *   2. it must never fail boot;
 *   3. a host with NO container runtime must be a no-op, not an error.
 *
 * WHAT IS PROVEN, AND HOW HONESTLY:
 *
 *  (a) REAL boot path: `startPlatformServer` is driven with a REAL
 *      `createBuilderServer` on a REAL ephemeral port, and `/healthz` is fetched
 *      with REAL HTTP while the reap is deliberately stalled — so "does not block
 *      readiness" is measured, not asserted.
 *  (b) REAL argv: the label filters are produced by the REAL container backend with
 *      only its `exec` faked, so the instance-scoping is real code.
 *  (c) REAL SandboxManager: the reap runs through the real manager's
 *      `reapAllOrphans`, not a stand-in.
 *
 * WHAT ONLY A REAL CONTAINER HOST CAN PROVE: that the runtime's label filters
 * select exactly these containers and that `rm -f` collects them. No test here
 * claims a container ran.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { runStartupReap, resolveStartupReapConfig, STARTUP_REAP_SCOPES } from '../src/server/startup-reap.js';
import { startPlatformServer } from '../src/server/start.js';
import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createContainerBackend, INSTANCE_LABEL, OWNER_LABEL } from '../src/sandbox/container-backend.js';
import { createSandboxManager } from '../src/sandbox/sandbox-manager.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { resolveInstanceId, composeProjectRuntime } from '../src/server/compose-runtime.js';
import { composePlatformOps } from '../src/ops/index.js';
import { createFilteringContainerBackend } from '../src/sandbox/filtering-container-backend.js';

// --------------------------------------------------------------------- helpers

/** A backend whose availability and reap results are scripted. */
function fakeBackend({ available = true, reaped = [], reapResult, onReap, instanceId = 'host-a', orphans } = {}) {
  const calls = { isAvailable: 0, reapOrphans: [], listOrphans: 0 };
  return {
    calls,
    instanceId,
    async listOrphans() {
      calls.listOrphans += 1;
      return orphans ? { ok: true, candidates: orphans } : { ok: true, candidates: [] };
    },
    async isAvailable() {
      calls.isAvailable += 1;
      if (available === 'throw') throw new Error('daemon exploded');
      return available;
    },
    async reapOrphans(labelValue, opts) {
      calls.reapOrphans.push({ labelValue, opts });
      if (onReap) return onReap(labelValue, opts);
      return reapResult ?? { reaped };
    },
    async runOneShot() {
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    async remove() {
      return { removed: true };
    },
  };
}

/** The real SandboxManager over a temp layout, so reapAllOrphans is real code. */
function realManager(backend) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-reap-'));
  const manager = createSandboxManager({ layout: createStorageLayout(dir), backend, config: { packageRegistryHosts: [] } });
  return { manager, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const collectLogs = () => {
  const lines = [];
  return { log: (m) => lines.push(String(m)), lines };
};

// ============================================================ scope resolution

test('the reap is OFF by default, and an ambiguous value cannot enable it', () => {
  assert.equal(resolveStartupReapConfig({}).scope, 'off');
  assert.equal(resolveStartupReapConfig({}).recognized, true, 'an UNSET value is a deliberate off, not a rejection');
  for (const raw of ['', '   ', 'off', '0', 'false', 'no', 'disabled']) {
    assert.equal(resolveStartupReapConfig({ AAB_STARTUP_REAP: raw }).scope, 'off', `${JSON.stringify(raw)} must be off`);
  }
  // An unrecognized value falls back to the posture that cannot destroy anything.
  for (const raw of ['yes-please', 'everything', 'ALL THE THINGS', 'instances']) {
    assert.equal(resolveStartupReapConfig({ AAB_STARTUP_REAP: raw }).scope, 'off', `${JSON.stringify(raw)} must not enable a reap`);
  }
});

test('a plain boolean opt-in gets the SAFE scope, never the destructive one', () => {
  for (const raw of ['1', 'true', 'yes', 'on', 'enabled', 'TRUE', ' On ']) {
    assert.equal(
      resolveStartupReapConfig({ AAB_STARTUP_REAP: raw }).scope,
      'instance',
      `${JSON.stringify(raw)} must select the instance scope, not all`,
    );
  }
  // The destructive scope has to be asked for by name.
  assert.equal(resolveStartupReapConfig({ AAB_STARTUP_REAP: 'all' }).scope, 'all');
  assert.equal(resolveStartupReapConfig({ AAB_STARTUP_REAP: 'instance' }).scope, 'instance');
  assert.deepEqual([...STARTUP_REAP_SCOPES], ['off', 'instance', 'all']);
});

// ================================================== the three required properties

test('a host with NO container runtime is a NO-OP, not an error', async () => {
  const backend = fakeBackend({ available: false });
  const { manager, cleanup } = realManager(backend);
  const logs = collectLogs();
  try {
    const res = await runStartupReap({ scope: 'instance', instanceId: 'host-a', sandboxManager: manager, backend, logger: logs });
    assert.deepEqual(res, { ran: false, scope: 'instance', reason: 'no-container-runtime', reaped: [] });
    // The decisive part: no sweep was even ATTEMPTED, so nothing can be destroyed
    // and nothing can hang on a host that has no runtime.
    assert.deepEqual(backend.calls.reapOrphans, []);
    assert.equal(backend.calls.isAvailable, 1, 'availability is probed first');
    assert.ok(logs.lines.some((l) => /no container runtime/.test(l)), 'and it says so, at info level');
    assert.ok(!logs.lines.some((l) => /error|fail/i.test(l)), 'a missing runtime is NOT an error');
  } finally {
    cleanup();
  }
});

test('nothing the reap can hit is allowed to fail boot', async () => {
  // Every one of these used to be a plausible way to turn cleanup into a crash.
  const cases = [
    { what: 'the availability probe throws', backend: fakeBackend({ available: 'throw' }), reason: 'no-container-runtime' },
    {
      what: 'the reap itself throws',
      backend: fakeBackend({ onReap: () => { throw new Error('rm exploded'); } }),
      reason: 'error',
    },
    {
      what: 'the runtime cannot list containers',
      backend: fakeBackend({ reapResult: { reaped: [], code: 1, stderr: 'permission denied' } }),
      reason: 'list-failed',
    },
    { what: 'the reap returns junk', backend: fakeBackend({ reapResult: null }), reason: 'ok' },
  ];

  for (const { what, backend, reason } of cases) {
    const { manager, cleanup } = realManager(backend);
    try {
      // Must RESOLVE, never reject.
      const res = await runStartupReap({ scope: 'all', sandboxManager: manager, backend, logger: collectLogs() });
      assert.equal(res.reason, reason, what);
      assert.ok(Array.isArray(res.reaped), `${what}: always a structured result`);
    } finally {
      cleanup();
    }
  }

  // A logger that throws must not escalate either.
  const backend = fakeBackend({ reaped: ['abc'] });
  const { manager, cleanup } = realManager(backend);
  try {
    const res = await runStartupReap({
      scope: 'all',
      sandboxManager: manager,
      backend,
      logger: { log() { throw new Error('logger broke'); } },
    });
    assert.equal(res.ran, true);
  } finally {
    cleanup();
  }

  // A missing reaper is reported, not thrown.
  assert.equal((await runStartupReap({ scope: 'all', sandboxManager: {}, backend })).reason, 'no-reaper');
  assert.equal((await runStartupReap({ scope: 'all', backend })).reason, 'no-reaper');
});

test('/healthz answers while the reap is STILL RUNNING — it is never on the boot path', async () => {
  // The property that made this feature risky. The reap is stalled indefinitely and
  // the REAL server is booted on a REAL port; /healthz must still answer.
  let releaseReap;
  const stalled = new Promise((resolve) => {
    releaseReap = resolve;
  });
  const backend = fakeBackend({ onReap: async () => { await stalled; return { reaped: ['stale-1'] }; } });
  const { manager, cleanup } = realManager(backend);
  const logs = collectLogs();

  const started = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_STARTUP_REAP: 'all' },
    createServer: (opts) => createBuilderServer({ ...opts }),
    createRuntime: () => ({
      dataDir: '/tmp/aab-reap-none',
      instanceId: 'host-a',
      backend,
      sandboxManager: manager,
      serverOptions: () => ({}),
    }),
    logger: logs,
  });

  try {
    // listen() has resolved, so the port is accepting: prove it with real HTTP
    // WHILE the reap is still blocked.
    const res = await fetch(`http://${started.address.host}:${started.address.port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.equal(backend.calls.reapOrphans.length, 1, 'the reap did start');

    // Now let it finish. The promise is exposed so a caller can observe the outcome
    // WITHOUT it ever having been awaited on the boot path.
    releaseReap();
    const reap = await started.startupReap;
    assert.deepEqual(reap.reaped, ['stale-1']);
    assert.equal(reap.ran, true);
  } finally {
    await started.api.close?.();
    cleanup();
  }
});

test('the reap starts strictly AFTER listen() — /healthz answers before the runtime is touched', async () => {
  // "Never awaited" is the load-bearing property, but the ORDER is what the module
  // header and DEPLOY.md assert. Moving the reap above `await api.listen(...)` left
  // every other test green, so pin it: the very first runtime call must happen after
  // the socket is open.
  const order = [];
  const backend = fakeBackend({ reaped: [] });
  const originalIsAvailable = backend.isAvailable.bind(backend);
  backend.isAvailable = async () => {
    order.push('isAvailable');
    return originalIsAvailable();
  };
  const { manager, cleanup } = realManager(backend);

  const started = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_STARTUP_REAP: 'all' },
    createServer: (opts) => {
      const api = createBuilderServer({ ...opts });
      return {
        ...api,
        listen: async (...args) => {
          const address = await api.listen(...args);
          order.push('listen');
          return address;
        },
        close: api.close?.bind(api),
      };
    },
    createRuntime: () => ({ dataDir: '/tmp/x', instanceId: 'host-a', backend, sandboxManager: manager, serverOptions: () => ({}) }),
    logger: collectLogs(),
  });

  try {
    assert.equal((await fetch(`http://${started.address.host}:${started.address.port}/healthz`)).status, 200);
    await started.startupReap;
    assert.equal(order[0], 'listen', 'the socket must be open before any container-runtime call');
    assert.ok(order.includes('isAvailable'), 'and the reap must actually have run');
  } finally {
    await started.api.close?.();
    cleanup();
  }
});

test("the boot path threads the runtime's instance id into the reap", async () => {
  // Deleting `instanceId: runtime.instanceId` from start.js left every test green,
  // while making the DEFAULT (and documented) scope a permanent no-instance-id skip.
  const backend = fakeBackend({ instanceId: 'pod-7', reaped: ['orphan-1'] });
  const { manager, cleanup } = realManager(backend);
  const started = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_STARTUP_REAP: 'instance' },
    createServer: (opts) => createBuilderServer({ ...opts }),
    createRuntime: () => ({ dataDir: '/tmp/x', instanceId: 'pod-7', backend, sandboxManager: manager, serverOptions: () => ({}) }),
    logger: collectLogs(),
  });
  try {
    const reap = await started.startupReap;
    assert.equal(reap.ran, true, `the instance scope must work on the boot path, got ${JSON.stringify(reap)}`);
    assert.equal(reap.scope, 'instance');
    assert.deepEqual(backend.calls.reapOrphans, [{ labelValue: undefined, opts: { instanceId: 'pod-7' } }]);
  } finally {
    await started.api.close?.();
    cleanup();
  }
});

test('the REAL composed runtime exposes exactly the names the reap reads', () => {
  // Every other boot test injects a fake createRuntime, so renaming `backend` or
  // `sandboxManager` in the composition root would silently turn the reap into a
  // permanent no-container-runtime no-op with a green suite.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-reap-compose-'));
  try {
    const runtime = composeProjectRuntime({
      composed: composePlatformOps({}),
      env: { AAB_DATA_DIR: dir },
      createBackend: (opts) => createContainerBackend({ ...opts, exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null }) }),
    });
    assert.equal(typeof runtime.instanceId, 'string');
    assert.ok(runtime.instanceId.length > 0);
    assert.ok(runtime.backend, 'runtime.backend is what the reap probes');
    assert.equal(typeof runtime.backend.isAvailable, 'function');
    assert.equal(typeof runtime.sandboxManager.reapAllOrphans, 'function');
    // And the backend really stamps the id the reap will filter on — the gate that
    // catches a mis-wired composition depends on these being equal.
    assert.equal(runtime.backend.instanceId, runtime.instanceId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the REAL registry-mode composition stamps containers too', async () => {
  // THE DEFECT THIS PINS: the filtering backend silently dropped `instanceId`, so in
  // the one mode a deployment needs for `npm install`, nothing was stamped and an
  // instance-scoped reap matched zero containers while reporting a clean host.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-reap-registry-'));
  const argv = [];
  try {
    const runtime = composeProjectRuntime({
      composed: composePlatformOps({}),
      env: { AAB_DATA_DIR: dir, AAB_SANDBOX_EGRESS: 'registry', AAB_INSTANCE_ID: 'pod-9' },
      createFilteringBackend: (opts) =>
        createFilteringContainerBackend({
          ...opts,
          sleep: async () => {},
          exec: async (bin, args) => {
            argv.push(args);
            if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'no such object', timedOut: false, signal: null };
            if (args[0] === 'network' && args[1] === 'inspect') return { code: 1, stdout: '', stderr: 'no such network', timedOut: false, signal: null };
            if (args[0] === 'logs') return { code: 0, stdout: 'aab-egress proxy listening on 0.0.0.0:3128\n', stderr: '', timedOut: false, signal: null };
            return { code: 0, stdout: 'cid\n', stderr: '', timedOut: false, signal: null };
          },
        }),
    });
    assert.equal(runtime.egressMode, 'registry');
    assert.equal(runtime.backend.instanceId, 'pod-9', 'the filtering backend must expose the id it stamps');

    const created = runtime.projectManager.createProject({
      accountId: 'owner-1', description: 'x', targetCategory: 'web', origin: 'blank',
    });
    await runtime.sandboxManager.exec(created.project.id, ['npm', 'install']);

    // BOTH the sandbox container and the egress proxy carry the instance label.
    const sandbox = argv.find((a) => a[0] === 'run' && a.includes('--rm'));
    const proxy = argv.find((a) => a[0] === 'run' && a.includes('-d'));
    for (const [what, args] of [['sandbox', sandbox], ['proxy', proxy]]) {
      assert.ok(args, `${what} was launched`);
      const labels = args.filter((a, i) => args[i - 1] === '--label');
      assert.ok(labels.includes(`${INSTANCE_LABEL}=pod-9`), `${what} must be stamped, or a reap cannot claim it`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('boot SUCCEEDS even when the reap fails outright', async () => {
  const backend = fakeBackend({ onReap: () => { throw new Error('runtime gone'); } });
  const { manager, cleanup } = realManager(backend);
  const logs = collectLogs();
  const started = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1', AAB_STARTUP_REAP: 'all' },
    createServer: (opts) => createBuilderServer({ ...opts }),
    createRuntime: () => ({ dataDir: '/tmp/x', instanceId: 'host-a', backend, sandboxManager: manager, serverOptions: () => ({}) }),
    logger: logs,
  });
  try {
    assert.equal((await fetch(`http://${started.address.host}:${started.address.port}/healthz`)).status, 200);
    const reap = await started.startupReap;
    assert.equal(reap.reason, 'error');
    assert.ok(logs.lines.some((l) => /startup reap failed \(ignored\)/.test(l)), 'the failure is logged, not thrown');
  } finally {
    await started.api.close?.();
    cleanup();
  }
});

test('the reap does not run at all unless it is enabled', async () => {
  const backend = fakeBackend({ reaped: ['x'] });
  const { manager, cleanup } = realManager(backend);
  const started = await startPlatformServer({
    env: { PORT: '0', HOST: '127.0.0.1' }, // AAB_STARTUP_REAP unset
    createServer: (opts) => createBuilderServer({ ...opts }),
    createRuntime: () => ({ dataDir: '/tmp/x', instanceId: 'host-a', backend, sandboxManager: manager, serverOptions: () => ({}) }),
    logger: collectLogs(),
  });
  try {
    const reap = await started.startupReap;
    assert.deepEqual(reap, { ran: false, scope: 'off', reason: 'disabled', reaped: [] });
    assert.equal(backend.calls.isAvailable, 0, 'a disabled reap must not even probe the runtime');
    assert.deepEqual(backend.calls.reapOrphans, []);
  } finally {
    await started.api.close?.();
    cleanup();
  }
});

// ============================================ instance scoping (the safety story)

test('an instance sweep REFUSES when the backend does not stamp that id', async () => {
  // THE MIS-WIRING GATE. An instance-scoped sweep filters on a label the BACKEND must
  // apply. When the composed backend silently dropped the option, the sweep matched
  // nothing and logged "no orphaned sandbox containers" — byte-identical to a clean
  // host, while every orphan kept running. "Nothing was stamped" must not look like
  // "nothing was orphaned".
  const logs = collectLogs();
  for (const backendInstance of [null, 'someone-else']) {
    const backend = fakeBackend({ reaped: ['x'] });
    backend.instanceId = backendInstance; // the mis-wired composition
    const { manager, cleanup } = realManager(backend);
    try {
      const res = await runStartupReap({ scope: 'instance', instanceId: 'host-a', sandboxManager: manager, backend, logger: logs });
      assert.equal(res.reason, 'backend-not-stamping', `backend instanceId ${JSON.stringify(backendInstance)}`);
      assert.equal(res.ran, false);
      assert.deepEqual(backend.calls.reapOrphans, [], 'nothing may be swept');
    } finally {
      cleanup();
    }
  }
  assert.ok(logs.lines.some((l) => /does not stamp this instance id/.test(l)), 'and it says why');
});

test('an orphan carrying a DIFFERENT instance id is reported, not silently left', async () => {
  // A slot RECREATED rather than restarted in place (a rescheduled pod, `compose up`
  // recreating the container), or a container predating the instance label, is
  // invisible to an instance-scoped sweep. Without this the log reads exactly like a
  // clean host while the containers leak.
  const backend = fakeBackend({
    instanceId: 'host-a',
    reaped: [],
    orphans: [
      { id: 'a1', name: 'aab-sbx-p1-x', instanceId: 'host-a' },
      { id: 'b1', name: 'aab-sbx-p2-y', instanceId: 'previous-pod' },
      { id: 'c1', name: 'aab-sbx-p3-z', instanceId: null },
    ],
  });
  const { manager, cleanup } = realManager(backend);
  const logs = collectLogs();
  try {
    const res = await runStartupReap({ scope: 'instance', instanceId: 'host-a', sandboxManager: manager, backend, logger: logs });
    assert.equal(res.ran, true);
    assert.equal(res.unclaimable, 2, 'the two containers this scope cannot claim are counted');
    assert.ok(logs.lines.some((l) => /DIFFERENT instance id/.test(l)));
    assert.ok(logs.lines.some((l) => /AAB_STARTUP_REAP=all/.test(l)), 'and the operator is told what would clear them');
  } finally {
    cleanup();
  }
});

test('a removal that FAILS is reported rather than dropped from the result', async () => {
  const backend = fakeBackend({
    reapResult: { reaped: ['gone-1'], failed: [{ id: 'stuck-1', code: 1, stderr: 'device busy' }], skipped: [] },
  });
  const { manager, cleanup } = realManager(backend);
  const logs = collectLogs();
  try {
    const res = await runStartupReap({ scope: 'all', sandboxManager: manager, backend, logger: logs });
    assert.deepEqual(res.reaped, ['gone-1']);
    assert.equal(res.failed.length, 1, 'a stuck container must not vanish from the report');
    assert.ok(logs.lines.some((l) => /could NOT be removed/.test(l)));
  } finally {
    cleanup();
  }
});

test('an unrecognized AAB_STARTUP_REAP says so instead of silently disabling itself', async () => {
  // An operator who believes reaping is on, and finds it silently off, is a defect.
  const config = resolveStartupReapConfig({ AAB_STARTUP_REAP: 'yes-please' });
  assert.deepEqual(config, { scope: 'off', recognized: false, raw: 'yes-please' });
  const backend = fakeBackend();
  const logs = collectLogs();
  const res = await runStartupReap({ ...config, sandboxManager: { reapAllOrphans: async () => ({ reaped: [] }) }, backend, logger: logs });
  assert.equal(res.reason, 'unrecognized-value');
  assert.ok(logs.lines.some((l) => /startup reap DISABLED/.test(l) && /yes-please/.test(l)));
  // A deliberate `off` stays quiet — only a REJECTED value is announced.
  const quiet = collectLogs();
  await runStartupReap({ ...resolveStartupReapConfig({ AAB_STARTUP_REAP: 'off' }), backend, logger: quiet });
  assert.deepEqual(quiet.lines, []);
});

test('a non-string env value cannot throw on the boot path', () => {
  assert.equal(resolveStartupReapConfig({ AAB_STARTUP_REAP: 1 }).scope, 'instance');
  assert.equal(resolveStartupReapConfig({ AAB_STARTUP_REAP: {} }).scope, 'off');
  assert.equal(resolveStartupReapConfig(undefined).scope, 'off');
  assert.equal(resolveStartupReapConfig(null).scope, 'off');
});

test('the instance scope sweeps ONLY this deployment slot, through the REAL manager', async () => {
  const backend = fakeBackend({ instanceId: 'pod-a', reaped: ['orphan-1', 'orphan-2'] });
  const { manager, cleanup } = realManager(backend);
  try {
    const res = await runStartupReap({
      scope: 'instance',
      instanceId: 'pod-a',
      sandboxManager: manager,
      backend,
      logger: collectLogs(),
    });
    assert.equal(res.ran, true);
    assert.deepEqual(res.reaped, ['orphan-1', 'orphan-2']);
    // The real manager forwarded the instance narrowing to the backend.
    assert.deepEqual(backend.calls.reapOrphans, [{ labelValue: undefined, opts: { instanceId: 'pod-a' } }]);
  } finally {
    cleanup();
  }
});

test("the 'all' scope is unscoped — that is exactly why it is not the default", async () => {
  const backend = fakeBackend({ reaped: ['whoevers-1'] });
  const { manager, cleanup } = realManager(backend);
  try {
    await runStartupReap({ scope: 'all', instanceId: 'pod-a', sandboxManager: manager, backend, logger: collectLogs() });
    assert.deepEqual(
      backend.calls.reapOrphans,
      [{ labelValue: undefined, opts: {} }],
      'no instance narrowing is applied, so a live sibling on the same host would be swept',
    );
  } finally {
    cleanup();
  }
});

test('an instance scope with NO instance id refuses rather than silently sweeping everything', async () => {
  // Without this, a missing id would degrade `instance` into `all` — destroying a
  // live sibling's sandboxes, which is the one outcome the scope exists to prevent.
  const backend = fakeBackend({ reaped: ['x'] });
  const { manager, cleanup } = realManager(backend);
  const logs = collectLogs();
  try {
    for (const instanceId of [undefined, '', '   ', null, 42]) {
      const res = await runStartupReap({ scope: 'instance', instanceId, sandboxManager: manager, backend, logger: logs });
      assert.equal(res.reason, 'no-instance-id', `${JSON.stringify(instanceId)} must not become an unscoped sweep`);
      assert.equal(res.ran, false);
    }
    assert.deepEqual(backend.calls.reapOrphans, [], 'nothing may be swept');
  } finally {
    cleanup();
  }
});

// ======================================= the labels, through the REAL backend argv

test('the REAL backend stamps every container with the instance label, and filters on it', async () => {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args);
    if (args[0] === 'ps') return { code: 0, stdout: 'aaa\nbbb\n', stderr: '', timedOut: false, signal: null };
    // Each candidate is INSPECTED before removal, so the narrowing is enforced rather
    // than assumed. Report the label the sweep is filtering on.
    if (args[0] === 'inspect') return { code: 0, stdout: 'pod-a /aab-sbx-old-abc\n', stderr: '', timedOut: false, signal: null };
    return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
  };
  const backend = createContainerBackend({ exec, instanceId: 'pod-a' });
  assert.equal(backend.instanceId, 'pod-a');

  // A one-shot command carries BOTH labels: the owner label (per project) and the
  // instance label (per deployment slot).
  await backend.runOneShot({ name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'] });
  const run = calls.find((a) => a[0] === 'run');
  const labels = run.filter((a, i) => run[i - 1] === '--label');
  assert.ok(labels.includes(`${OWNER_LABEL}=aab-sbx-p1`), 'the per-project owner label');
  assert.ok(labels.includes(`${INSTANCE_LABEL}=pod-a`), 'the per-instance label');

  // A long-running service (the preview dev server, the egress proxy) too — an
  // unlabelled container would be invisible to an instance-scoped reap forever.
  await backend.startService({ name: 'aab-egress-proxy', labelValue: 'aab-egress-proxy', command: ['node', '-e', ''], network: 'bridge' });
  const svc = calls.find((a) => a[0] === 'run' && a.includes('-d'));
  const svcLabels = svc.filter((a, i) => svc[i - 1] === '--label');
  assert.ok(svcLabels.includes(`${INSTANCE_LABEL}=pod-a`), 'services are stamped too');

  // And the reap filter ANDs the two labels, so it can only ever match a SUBSET.
  const res = await backend.reapOrphans(undefined, { instanceId: 'pod-a' });
  const ps = calls.find((a) => a[0] === 'ps');
  assert.deepEqual(ps, ['ps', '-a', '-q', '--filter', `label=${OWNER_LABEL}`, '--filter', `label=${INSTANCE_LABEL}=pod-a`]);
  assert.deepEqual(res.reaped, ['aaa', 'bbb']);

  // Without the option the sweep is unscoped — the pre-existing behavior, unchanged.
  calls.length = 0;
  await backend.reapOrphans();
  assert.deepEqual(calls.find((a) => a[0] === 'ps'), ['ps', '-a', '-q', '--filter', `label=${OWNER_LABEL}`]);
});

test('a sweep NEVER removes a container this process launched', async () => {
  // THE BOOT RACE. "At boot we have created none" is true at an instant; the sweep
  // spans one. The availability probe plus the listing can take tens of seconds on
  // exactly the cold daemon this feature targets, and a request acquiring a Sandbox
  // in that window creates a container stamped with OUR id — which the listing would
  // then pick up and rm -f mid-command.
  const removed = [];
  const calls = [];
  const backend = createContainerBackend({
    instanceId: 'pod-a',
    exec: async (bin, args) => {
      calls.push(args);
      if (args[0] === 'ps') return { code: 0, stdout: 'id-live\nid-orphan\n', stderr: '', timedOut: false, signal: null };
      if (args[0] === 'inspect') {
        const name = args.at(-1) === 'id-live' ? '/aab-sbx-live-abc' : '/aab-sbx-dead-xyz';
        return { code: 0, stdout: `pod-a ${name}\n`, stderr: '', timedOut: false, signal: null };
      }
      if (args[0] === 'rm') {
        removed.push(args.at(-1));
        return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
    },
  });

  // This process launches a container — as a request landing mid-sweep would.
  await backend.runOneShot({ name: 'aab-sbx-live-abc', labelValue: 'aab-sbx-live', mountSource: '/d', command: ['sleep', '30'] });

  const res = await backend.reapOrphans(undefined, { instanceId: 'pod-a' });
  assert.deepEqual(res.reaped, ['id-orphan'], "only the PREDECESSOR's container is reaped");
  assert.deepEqual(removed, ['id-orphan']);
  assert.deepEqual(res.skipped, ['aab-sbx-live-abc'], 'our own live container is skipped, and reported');
  assert.ok(!removed.includes('id-live'), 'a container of the CURRENT process must never be force-removed');
});

test('the REAL backend reports a removal that FAILED rather than dropping it', async () => {
  // A container that cannot be removed for an unexpected reason must not silently
  // vanish from the result as though it had never been a candidate — that would make
  // a partial sweep read as a clean one.
  const backend = createContainerBackend({
    instanceId: 'pod-a',
    exec: async (bin, args) => {
      if (args[0] === 'ps') return { code: 0, stdout: 'ok-1\nstuck-1\n', stderr: '', timedOut: false, signal: null };
      if (args[0] === 'inspect') return { code: 0, stdout: `pod-a /aab-sbx-${args.at(-1)}\n`, stderr: '', timedOut: false, signal: null };
      if (args[0] === 'rm') {
        return args.at(-1) === 'stuck-1'
          ? { code: 1, stdout: '', stderr: 'device or resource busy', timedOut: false, signal: null }
          : { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
    },
  });
  const res = await backend.reapOrphans(undefined, { instanceId: 'pod-a' });
  assert.deepEqual(res.reaped, ['ok-1']);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, 'stuck-1');
  assert.match(res.failed[0].stderr, /device or resource busy/, 'the reason must survive to the caller');
});

test('a candidate whose instance label does NOT match is dropped before rm -f', async () => {
  // The narrowing filter is load-bearing for a destructive operation and cannot be
  // verified in CI. So the decision is re-derived from an inspect: if the runtime's
  // label filtering ever failed to narrow, the sweep still would not widen.
  const removed = [];
  const backend = createContainerBackend({
    instanceId: 'pod-a',
    exec: async (bin, args) => {
      if (args[0] === 'ps') return { code: 0, stdout: 'mine\nsiblings\n', stderr: '', timedOut: false, signal: null };
      if (args[0] === 'inspect') {
        const who = args.at(-1) === 'mine' ? 'pod-a' : 'pod-b';
        return { code: 0, stdout: `${who} /aab-sbx-x-1\n`, stderr: '', timedOut: false, signal: null };
      }
      if (args[0] === 'rm') {
        removed.push(args.at(-1));
        return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
    },
  });
  const res = await backend.reapOrphans(undefined, { instanceId: 'pod-a' });
  assert.deepEqual(removed, ['mine'], "a live sibling's container must survive even if the filter returned it");
  assert.deepEqual(res.reaped, ['mine']);
});

test('a backend with no instanceId emits NO instance label (argv is unchanged for existing callers)', async () => {
  const calls = [];
  const backend = createContainerBackend({
    exec: async (bin, args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
    },
  });
  assert.equal(backend.instanceId, null);
  await backend.runOneShot({ name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'] });
  assert.deepEqual(calls[0], [
    'run', '--rm',
    '--pid', 'private',
    '--network', 'none',
    '--security-opt', 'no-new-privileges',
    '--name', 'aab-sbx-p1-x',
    '--label', 'aab.sandbox=aab-sbx-p1',
    '-v', '/d:/workspace',
    '-w', '/workspace',
    'node:22-slim', 'true',
  ]);
});

// ================================================================= the instance id

test('the instance id is stable across a restart in the same slot, and distinct across slots', () => {
  // Stability is what lets a restarted process recognize its predecessor's orphans;
  // distinctness is what stops it from reaping a live sibling's.
  assert.equal(resolveInstanceId({ AAB_INSTANCE_ID: 'pod-a' }), 'pod-a');
  assert.equal(resolveInstanceId({ AAB_INSTANCE_ID: 'pod-a' }), resolveInstanceId({ AAB_INSTANCE_ID: 'pod-a' }));
  assert.notEqual(resolveInstanceId({ AAB_INSTANCE_ID: 'pod-a' }), resolveInstanceId({ AAB_INSTANCE_ID: 'pod-b' }));

  // Defaults to the hostname, which survives a process restart inside a container.
  assert.equal(resolveInstanceId({}), resolveInstanceId({}));
  assert.ok(resolveInstanceId({}).length > 0);

  // Sanitized for a label value, so it can never distort the argv it lands in.
  assert.equal(resolveInstanceId({ AAB_INSTANCE_ID: 'pod a/b:c' }), 'pod-a-b-c');
  assert.equal(resolveInstanceId({ AAB_INSTANCE_ID: '--weird' }), 'weird');
  assert.equal(resolveInstanceId({ AAB_INSTANCE_ID: '!!!' }), 'aab-instance', 'never empty');
  assert.ok(resolveInstanceId({ AAB_INSTANCE_ID: 'x'.repeat(200) }).length <= 64);
  assert.match(resolveInstanceId({ AAB_INSTANCE_ID: 'a b' }), /^[A-Za-z0-9_.-]+$/);
});
