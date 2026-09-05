/**
 * Sandbox / per-project Isolation_Boundary tests (node --test).
 *
 * Covers the PURE and STRUCTURAL parts of spec Task 5 that are deterministic
 * WITHOUT launching a real container:
 *   (a) computeEgressAllowlist is deny-by-default, includes only active-binding
 *       hosts + the package registry, excludes 'removed' bindings, and never
 *       includes host/lateral (loopback/private/metadata) targets;
 *   (b) acquire records ONLY that project's tree as the bind-mount source
 *       (== layout.exportableProjectTree(projectId)) and no other project's tree;
 *   (c) release is idempotent and safe to call twice / after a failed acquire
 *       (orphan cleanup);
 *   (d) projectId validation rejects traversal/separators;
 *   (e) cgroup limits are REQUESTED and the backend degrades gracefully +
 *       reports whether they were applied (never claims enforcement).
 *
 * Property 1 (Isolation_Boundary invariant) runs >=100 iterations under the
 * exact spec tag. Any test needing a LIVE container is gated behind a backend
 * capability check so the suite stays green in this sandbox (live-container
 * tests land in FEAT-002).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createConnectorBinding } from '../src/model/connector.js';
import {
  computeEgressAllowlist,
  normalizeHost,
  isForbiddenEgressHost,
  DEFAULT_PACKAGE_REGISTRY_HOSTS,
} from '../src/sandbox/egress.js';
import {
  createContainerBackend,
  containerRuntimeAvailable,
  buildRunArgs,
  cgroupFlagsFor,
  WORKSPACE_MOUNT_PATH,
} from '../src/sandbox/container-backend.js';
import { createSandboxManager } from '../src/sandbox/sandbox-manager.js';
import { classifyCommand } from '../src/engine/plumby.js';

import os from 'node:os';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const BASE = '/var/lib/aab';
const REGISTRY = ['registry.npmjs.org'];

/** A minimal active ConnectorBinding with an explicit endpoint host. */
function activeBinding(host, extra = {}) {
  return {
    ...createConnectorBinding({
      connector: { service: 'svc', category: 'database', captureKind: 'api-key' },
      secretRefs: ['SECRET_NAME'],
      status: 'active',
    }),
    host,
    ...extra,
  };
}

// --- (a) egress allowlist: deny-by-default, pure -------------------------

test('(a) computeEgressAllowlist is deny-by-default and includes the package registry', () => {
  const list = computeEgressAllowlist({ bindings: [], packageRegistryHosts: REGISTRY });
  assert.equal(list.denyByDefault, true);
  assert.deepEqual(list.allowedHosts, ['registry.npmjs.org']);
  assert.ok(Object.isFrozen(list));
  assert.ok(Object.isFrozen(list.allowedHosts));
});

test('(a) an ACTIVE binding adds its host; a REMOVED binding contributes nothing', () => {
  const bindings = [
    activeBinding('api.stripe.com'),
    { ...activeBinding('db.example.com'), status: 'removed' },
  ];
  const list = computeEgressAllowlist({ bindings, packageRegistryHosts: REGISTRY });
  assert.ok(list.allowedHosts.includes('api.stripe.com'), 'active host present');
  assert.ok(!list.allowedHosts.includes('db.example.com'), 'removed host revoked');
  assert.ok(list.allowedHosts.includes('registry.npmjs.org'));
});

test('(a) removing a binding (recompute) revokes exactly that host', () => {
  const withBoth = computeEgressAllowlist({
    bindings: [activeBinding('api.stripe.com'), activeBinding('api.openai.com')],
    packageRegistryHosts: REGISTRY,
  });
  assert.ok(withBoth.allowedHosts.includes('api.stripe.com'));
  assert.ok(withBoth.allowedHosts.includes('api.openai.com'));
  const afterRemove = computeEgressAllowlist({
    bindings: [activeBinding('api.stripe.com')],
    packageRegistryHosts: REGISTRY,
  });
  assert.ok(afterRemove.allowedHosts.includes('api.stripe.com'));
  assert.ok(!afterRemove.allowedHosts.includes('api.openai.com'), 'openai revoked on removal');
});

test('(a) host/lateral targets are NEVER allowed, even if a binding requests them', () => {
  const laterals = [
    'localhost',
    '127.0.0.1',
    '127.0.0.53',
    '10.0.0.5',
    '192.168.1.10',
    '172.16.5.5',
    '169.254.169.254',
    'metadata.google.internal',
    'host.docker.internal',
    '0.0.0.0',
    '::1',
  ];
  const bindings = laterals.map((h) => activeBinding(h));
  const list = computeEgressAllowlist({ bindings, packageRegistryHosts: REGISTRY });
  for (const h of laterals) {
    assert.ok(!list.allowedHosts.includes(h), `lateral/host target ${h} must never be allowed`);
  }
  // Only the safe registry host survives.
  assert.deepEqual(list.allowedHosts, ['registry.npmjs.org']);
});

test('(a) endpoints given as URLs are normalized to bare hosts', () => {
  const list = computeEgressAllowlist({
    bindings: [activeBinding('https://api.stripe.com/v1/charges'), activeBinding('DB.EXAMPLE.COM:5432')],
    packageRegistryHosts: [],
  });
  assert.ok(list.allowedHosts.includes('api.stripe.com'));
  assert.ok(list.allowedHosts.includes('db.example.com'));
});

test('(a) normalizeHost + isForbiddenEgressHost helpers behave', () => {
  assert.equal(normalizeHost('https://a.b.com/x'), 'a.b.com');
  assert.equal(normalizeHost('A.B.COM:443'), 'a.b.com');
  assert.equal(normalizeHost('   '), null);
  assert.equal(isForbiddenEgressHost('127.0.0.1'), true);
  assert.equal(isForbiddenEgressHost('10.1.2.3'), true);
  assert.equal(isForbiddenEgressHost('api.stripe.com'), false);
});

// --- Property 1: Isolation_Boundary invariant ----------------------------

test(propertyTag(1, 'Isolation_Boundary invariant'), async () => {
  const layout = createStorageLayout(BASE);
  // A projectId arbitrary that is always a single safe path segment.
  const safeSegment = fc
    .string({ minLength: 1, maxLength: 24 })
    .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, ''))
    .filter((s) => s.length > 0 && s !== '.' && s !== '..' && !s.includes('..'));

  // An arbitrary endpoint host that may be safe OR a lateral/host target.
  const hostArb = fc.oneof(
    fc.constantFrom('api.stripe.com', 'api.openai.com', 'db.vendor.io', 'example.com'),
    fc.constantFrom('localhost', '127.0.0.1', '10.0.0.1', '192.168.0.1', '169.254.169.254', 'host.docker.internal'),
  );

  const bindingArb = fc.record({
    host: hostArb,
    status: fc.constantFrom('active', 'removed'),
  });

  // GENERATED COMMAND STRINGS + PATHS (subtask 5.3). A representative mix of
  // benign, destructive, network, and boundary-ESCAPE-attempting commands, over
  // absolute / relative / traversal paths. The point is that NONE of these —
  // whatever the classifier would say about them — can escape the boundary:
  // exec confines them identically because it never inspects the verdict.
  const pathArb = fc.oneof(
    fc.constantFrom(
      '/etc/passwd',
      '/projects',
      '/var/lib/aab/export/projects/OTHER',
      '../../etc/shadow',
      '../sibling/secret.txt',
      './local.txt',
      'nested/rel.txt',
      '/host/root',
      '~/.ssh/id_rsa',
    ),
    safeSegment.map((s) => `../${s}/x`),
  );
  const commandArb = fc.oneof(
    fc.tuple(fc.constantFrom('cat', 'ls', 'rm', 'stat', 'head', 'touch'), pathArb).map(([c, p]) => `${c} ${p}`),
    fc.tuple(fc.constantFrom('curl', 'wget'), fc.constantFrom('http://example.com', 'http://169.254.169.254/')).map(([c, u]) => `${c} ${u}`),
    pathArb.map((p) => `echo pwned > ${p}`),
    fc.constantFrom('ls', 'echo hi', 'id', 'ps -e', 'whoami', 'pwd'),
    fc.string({ maxLength: 40 }),
  );

  // A backend that does NOT touch a real runtime but faithfully constructs the
  // isolated invocation the manager asked for, so the property can assert the
  // CONFINEMENT CONTRACT (own root image, only-this-tree mount, private PID +
  // network ns, no-new-privileges) for every generated input — this is the
  // >=100x invariant that holds regardless of whether a container can launch.
  const contractBackend = () => {
    const invocations = [];
    return {
      invocations,
      async isAvailable() { return true; },
      async runOneShot(spec) {
        const args = buildRunArgs({
          image: 'node:22-slim',
          name: spec.name,
          mountSource: spec.mountSource,
          network: spec.network,
          readOnlyMount: spec.readOnlyMount,
          labelValue: spec.name,
          command: spec.command,
        });
        invocations.push({ spec, args });
        return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null, limitsApplied: false, requestedLimits: true, degraded: true };
      },
      async remove() { return { removed: true }; },
      async reapOrphans() { return { reaped: [] }; },
    };
  };

  await fc.assert(
    fc.asyncProperty(
      safeSegment,
      safeSegment,
      fc.array(bindingArb, { maxLength: 8 }),
      commandArb,
      async (projectId, otherId, rawBindings, command) => {
        const backend = contractBackend();
        const bindings = rawBindings.map((b) => activeBinding(b.host, { status: b.status }));
        const manager = createSandboxManager({
          layout,
          backend,
          config: { packageRegistryHosts: REGISTRY, limits: { memoryMb: 256, cpus: 1, pids: 128 } },
          bindingsFor: () => bindings,
        });

        const sandbox = manager.acquire(projectId);
        const otherTree = layout.exportableProjectTree(otherId);

        // INVARIANT 1: the bind-mount source is EXACTLY this project's tree.
        assert.equal(sandbox.mountSource, layout.exportableProjectTree(projectId));
        // INVARIANT 2: it is NOT any other project's tree (when ids differ).
        if (otherId !== projectId) {
          assert.notEqual(sandbox.mountSource, otherTree);
        }
        // INVARIANT 3: the mount source is inside THIS project's export tree
        // and never escapes it.
        const rel = path.relative(layout.exportableProjectTree(projectId), sandbox.mountSource);
        assert.equal(rel, '', 'mount source must equal the project tree exactly');
        // INVARIANT 4: fixed workspace mount path.
        assert.equal(sandbox.workspacePath, WORKSPACE_MOUNT_PATH);
        // INVARIANT 5: deny-by-default egress; NEVER a host/lateral target.
        assert.equal(sandbox.egress.denyByDefault, true);
        for (const h of sandbox.egress.allowedHosts) {
          assert.equal(isForbiddenEgressHost(h), false, `allowed host ${h} must not be lateral/host`);
        }
        // INVARIANT 6: removed bindings contribute nothing.
        for (const b of bindings) {
          if (b.status === 'removed') {
            const nh = normalizeHost(b.host);
            if (nh && isForbiddenEgressHost(nh) === false) {
              const stillActive = bindings.some(
                (x) => x.status === 'active' && normalizeHost(x.host) === nh,
              );
              if (!stillActive) {
                assert.ok(!sandbox.egress.allowedHosts.includes(nh));
              }
            }
          }
        }
        // INVARIANT 7: limits are only REQUESTED — never claimed applied before a run.
        assert.equal(sandbox.limitsApplied, null);

        // INVARIANT 8 (classifier-INDEPENDENT confinement): run the generated
        // command through exec. WHATEVER the classifier would rate it, exec must
        // build an isolated invocation and never reference the verdict.
        const result = await manager.exec(projectId, command);
        assert.equal(result.projectId, projectId);
        assert.equal(result.mountSource, sandbox.mountSource);
        assert.equal(result.workspacePath, WORKSPACE_MOUNT_PATH);

        // The confinement CONTRACT the backend was asked to construct:
        const last = backend.invocations.at(-1);
        assert.ok(last, 'exec must issue exactly one isolated invocation');
        const joined = last.args.join(' ');
        // own root image, private PID ns, private/none network, no priv-esc.
        assert.ok(last.args.includes('--pid') && last.args.includes('private'), 'private PID namespace');
        assert.ok(last.args.includes('--network'), 'private network namespace requested');
        assert.ok(joined.includes('no-new-privileges'), 'no privilege escalation');
        // ONLY this project's tree is mounted — never a sibling / host path.
        const mountArgIdx = last.args.indexOf('-v');
        const mountArg = mountArgIdx >= 0 ? last.args[mountArgIdx + 1] : '';
        assert.ok(
          mountArg.startsWith(`${sandbox.mountSource}:${WORKSPACE_MOUNT_PATH}`),
          'only this project tree is bind-mounted at the workspace path',
        );
        // The ONLY bind mount is this project's tree. Assert on the -v arg
        // directly (a prefix match on the joined string would be fooled when one
        // id is a prefix of another, e.g. 'F' vs 'F0').
        const otherMountSpec = `${otherTree}:${WORKSPACE_MOUNT_PATH}`;
        if (otherId !== projectId) {
          assert.notEqual(mountArg, otherMountSpec, 'another project tree is NEVER mounted');
          assert.ok(!mountArg.startsWith(`${otherTree}:`), 'another project tree is NEVER the mount source');
        }
        assert.notEqual(mountArg, `/projects:${WORKSPACE_MOUNT_PATH}`, 'the host /projects is never mounted');
        // The command runs INSIDE the box: it appears after the image, never as
        // a host-side mount/flag, so no traversal path in it can reach the host.
        const imgIdx = last.args.indexOf('node:22-slim');
        assert.ok(imgIdx >= 0 && mountArgIdx < imgIdx, 'command executes inside the container, after the image');
      },
    ),
    fcConfig,
  );
});

// --- (b) acquire bind-mounts only this project's tree --------------------

test('(b) acquire records ONLY this project\'s tree as the bind-mount source', () => {
  const layout = createStorageLayout(BASE);
  const backend = createFakeBackend();
  const manager = createSandboxManager({ layout, backend, config: { packageRegistryHosts: REGISTRY } });

  const a = manager.acquire('projA');
  const b = manager.acquire('projB');
  assert.equal(a.mountSource, layout.exportableProjectTree('projA'));
  assert.equal(b.mountSource, layout.exportableProjectTree('projB'));
  assert.notEqual(a.mountSource, b.mountSource);
  // acquire is idempotent — same handle for the same id.
  assert.strictEqual(manager.acquire('projA'), a);
});

test('(b) buildRunArgs mounts the project tree at the fixed workspace path with isolation flags', () => {
  const args = buildRunArgs({
    name: 'aab-sbx-p1',
    mountSource: '/var/lib/aab/export/projects/p1',
    network: 'none',
    labelValue: 'aab-sbx-p1',
    cgroupFlags: cgroupFlagsFor({ memoryMb: 256, cpus: 1, pids: 128 }),
    command: ['node', '-e', '1'],
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('--pid private'), 'private PID namespace');
  assert.ok(joined.includes('--network none'), 'private/deny network');
  assert.ok(joined.includes('no-new-privileges'), 'no privilege escalation');
  assert.ok(
    joined.includes(`/var/lib/aab/export/projects/p1:${WORKSPACE_MOUNT_PATH}`),
    'mounts project tree at workspace path',
  );
  assert.ok(joined.includes('--memory 256m') && joined.includes('--cpus 1') && joined.includes('--pids-limit 128'));
});

// --- (c) release idempotency + orphan cleanup ----------------------------

test('(c) release is idempotent and safe to call twice / after nothing acquired', async () => {
  const layout = createStorageLayout(BASE);
  const backend = createFakeBackend();
  const manager = createSandboxManager({ layout, backend, config: { packageRegistryHosts: REGISTRY } });

  // release before any acquire is safe (orphan cleanup path).
  const r0 = await manager.release('never-acquired');
  assert.equal(r0.released, true);

  manager.acquire('p1');
  const r1 = await manager.release('p1');
  assert.equal(r1.released, true);
  assert.equal(manager.get('p1'), null, 'record forgotten after release');
  // second release is a no-op success (idempotent).
  const r2 = await manager.release('p1');
  assert.equal(r2.released, true);

  // remove + reapOrphans were invoked (orphan cleanup after failed acquire).
  assert.ok(backend.calls.remove.includes('aab-sbx-p1'));
  assert.ok(backend.calls.reapOrphans.includes('aab-sbx-p1'));
});

test('(c) release runs cleanly in a finally alongside a thrown error', async () => {
  const layout = createStorageLayout(BASE);
  const backend = createFakeBackend();
  const manager = createSandboxManager({ layout, backend, config: { packageRegistryHosts: REGISTRY } });
  let released = false;
  await assert.rejects(async () => {
    try {
      manager.acquire('p1');
      throw new Error('boom during work');
    } finally {
      await manager.release('p1');
      released = true;
    }
  }, /boom during work/);
  assert.equal(released, true, 'release ran in finally despite the throw');
});

// --- (d) projectId validation --------------------------------------------

test('(d) acquire/release reject traversal and separators in projectId', () => {
  const layout = createStorageLayout(BASE);
  const backend = createFakeBackend();
  const manager = createSandboxManager({ layout, backend });
  assert.throws(() => manager.acquire('../escape'), /single safe path segment/);
  assert.throws(() => manager.acquire('a/b'), /single safe path segment/);
  assert.throws(() => manager.acquire('..'), /single safe path segment/);
  assert.throws(() => manager.acquire(''), /non-empty string/);
});

// --- (e) cgroup limits requested + graceful degrade ----------------------

test('(e) cgroupFlagsFor emits flags only for defined limits', () => {
  assert.deepEqual(cgroupFlagsFor({}), []);
  assert.deepEqual(cgroupFlagsFor({ memoryMb: 512 }), ['--memory', '512m']);
  assert.deepEqual(cgroupFlagsFor({ cpus: 2 }), ['--cpus', '2']);
  assert.deepEqual(cgroupFlagsFor({ pids: 64 }), ['--pids-limit', '64']);
});

test('(e) backend degrades gracefully when the runtime rejects cgroup flags', async () => {
  // A fake exec that FAILS the first (limited) run with a cgroup error, then
  // SUCCEEDS the retry without limits — the sandbox reality.
  const seen = [];
  const exec = async (bin, args) => {
    seen.push(args);
    const hasLimit = args.includes('--memory') || args.includes('--cpus') || args.includes('--pids-limit');
    if (hasLimit) {
      return { code: 126, stdout: '', stderr: 'crun: opening file `memory.max`: No such file or directory', timedOut: false, signal: null };
    }
    return { code: 0, stdout: 'ok', stderr: '', timedOut: false, signal: null };
  };
  const backend = createContainerBackend({ exec });
  const res = await backend.runOneShot({
    name: 'aab-sbx-p1',
    mountSource: '/x/p1',
    command: ['echo', 'hi'],
    limits: { memoryMb: 256, cpus: 1, pids: 128 },
  });
  assert.equal(res.code, 0, 'succeeds after dropping cgroup flags');
  assert.equal(res.requestedLimits, true);
  assert.equal(res.limitsApplied, false, 'must NOT claim limits applied when they were dropped');
  assert.equal(res.degraded, true);
  assert.equal(seen.length, 2, 'one limited attempt + one degraded retry');
});

test('(e) backend reports limitsApplied=true when a limited run succeeds', async () => {
  const exec = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null });
  const backend = createContainerBackend({ exec });
  const res = await backend.runOneShot({
    name: 'aab-sbx-p1',
    mountSource: '/x/p1',
    command: ['true'],
    limits: { memoryMb: 256 },
  });
  assert.equal(res.limitsApplied, true);
  assert.equal(res.degraded, false);
});

test('(e) backend enforces a wall-clock timeout in-process (reaps the run)', async () => {
  // Simulate the runtime returning a timed-out result (as runCli would on kill).
  const exec = async () => ({ code: null, stdout: '', stderr: '', timedOut: true, signal: 'SIGKILL' });
  const backend = createContainerBackend({ exec });
  const res = await backend.runOneShot({ name: 'aab-sbx-p1', mountSource: '/x/p1', command: ['sleep', '999'], timeoutMs: 50 });
  assert.equal(res.timedOut, true);
});

// --- backend availability gate (keeps live tests out of this suite) ------

test('backend exposes isAvailable() as the live-container capability gate', async () => {
  const backend = createContainerBackend({ exec: async () => ({ code: 0, stdout: '5.2.3', stderr: '', timedOut: false, signal: null }) });
  assert.equal(typeof backend.isAvailable, 'function');
  assert.equal(await backend.isAvailable(), true);
});

// --- containerRuntimeAvailable() capability probe (subtask 5.2) -----------

test('containerRuntimeAvailable() reports true only when a container can LAUNCH', async () => {
  // Injected exec: a successful `run --rm ... true` means available.
  const okBackendExec = async (_bin, args) => {
    assert.ok(args.includes('run') && args.includes('--rm'), 'probe uses a one-shot run');
    return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
  };
  assert.equal(await containerRuntimeAvailable({ exec: okBackendExec }), true);

  // A present-but-unusable runtime (run fails) -> false.
  const failExec = async () => ({ code: 125, stdout: '', stderr: 'cannot connect to daemon', timedOut: false, signal: null });
  assert.equal(await containerRuntimeAvailable({ exec: failExec }), false);

  // A timed-out probe -> false (never throws).
  const timeoutExec = async () => ({ code: null, stdout: '', stderr: '', timedOut: true, signal: 'SIGKILL' });
  assert.equal(await containerRuntimeAvailable({ exec: timeoutExec }), false);
});

// --- LIVE-CONTAINER CONTAINMENT (subtask 5.2, gated on a real runtime) ----
//
// These launch REAL one-shot containers via the docker/Podman CLI and observe
// actual confinement. They are gated behind containerRuntimeAvailable() so the
// suite stays green where no runtime can launch; in this sandbox they DO run.
// Each proves an axis of the Isolation_Boundary AND that out-of-box target
// state is preserved / a denied indication is returned where the boundary
// actively refuses.

const RUNTIME_LIVE = await containerRuntimeAvailable();

/**
 * Build a manager backed by the REAL container backend, using alpine:latest
 * (Node 22-slim lacks ps/wget). Each project gets its own temp tree on the host
 * so we can prove writes land only inside the mounted tree.
 */
function liveSetup() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-live-'));
  // Two SIBLING project trees under the same export root; each has a secret.
  const layout = createStorageLayout(baseDir);
  const backend = createContainerBackend({ bin: 'docker', image: 'alpine:latest' });
  const manager = createSandboxManager({
    layout,
    backend,
    // Empty registry -> empty allowlist -> `--network none` (total deny), which
    // is what the network-confinement test needs.
    config: { packageRegistryHosts: [], limits: {}, execTimeoutMs: 60_000 },
  });
  return { baseDir, layout, backend, manager };
}

function ensureTree(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('(live) filesystem confinement: cannot see the host /projects or a sibling project tree', { skip: !RUNTIME_LIVE ? 'no container runtime' : false }, async () => {
  const { baseDir, layout, manager } = liveSetup();
  try {
    const a = ensureTree(layout.exportableProjectTree('projA'));
    const b = ensureTree(layout.exportableProjectTree('projB'));
    fs.writeFileSync(path.join(a, 'a.txt'), 'inside-A');
    fs.writeFileSync(path.join(b, 'secretB.txt'), 'sibling-secret');

    // The container sees ONLY its own tree at /workspace.
    const own = await manager.exec('projA', 'ls /workspace');
    assert.equal(own.exitCode, 0);
    assert.ok(own.stdout.includes('a.txt'), 'own tree visible at /workspace');

    // The host /projects path is NOT visible inside the box.
    const host = await manager.exec('projA', 'ls /projects');
    assert.notEqual(host.exitCode, 0, 'host /projects is not present in the container');

    // The SIBLING project tree (its host path) is NOT visible either.
    const sibling = await manager.exec('projA', `cat ${path.join(b, 'secretB.txt')}`);
    assert.notEqual(sibling.exitCode, 0, 'sibling tree host path not visible');
    assert.ok(!sibling.stdout.includes('sibling-secret'), 'sibling secret never leaks into the box');

    // TARGET STATE PRESERVED: the sibling secret on the host is untouched.
    assert.equal(fs.readFileSync(path.join(b, 'secretB.txt'), 'utf8'), 'sibling-secret');
  } finally {
    await manager.release('projA');
    await manager.release('projB');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('(live) PID-namespace confinement: the container sees only its own tiny process table', { skip: !RUNTIME_LIVE ? 'no container runtime' : false }, async () => {
  const { baseDir, layout, manager } = liveSetup();
  try {
    ensureTree(layout.exportableProjectTree('projA'));
    // `ps -e` inside a private PID namespace shows only a handful of processes.
    const res = await manager.exec('projA', 'ps -e | wc -l');
    assert.equal(res.exitCode, 0);
    const count = parseInt(res.stdout.trim(), 10);
    assert.ok(Number.isFinite(count) && count < 15, `expected a tiny process table, saw ${res.stdout.trim()}`);
  } finally {
    await manager.release('projA');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('(live) network confinement: under a deny-by-default (empty) allowlist an outbound attempt fails', { skip: !RUNTIME_LIVE ? 'no container runtime' : false }, async () => {
  const { baseDir, layout, manager } = liveSetup();
  try {
    ensureTree(layout.exportableProjectTree('projA'));
    // The manager maps an empty allowlist to `--network none` — total deny.
    assert.equal(manager.acquire('projA').egress.allowedHosts.length, 0, 'empty allowlist -> total network deny');
    const res = await manager.exec('projA', 'wget -T 3 -q -O- http://example.com');
    // No route to the outside world: wget fails inside the box.
    assert.notEqual(res.exitCode, 0, 'outbound network is denied by default');
    assert.ok(!res.stdout.includes('<html'), 'no response body reached the container');
  } finally {
    await manager.release('projA');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('(live) no cross-Sandbox access: a write lands ONLY in that project tree, unseen by another sandbox', { skip: !RUNTIME_LIVE ? 'no container runtime' : false }, async () => {
  const { baseDir, layout, manager } = liveSetup();
  try {
    const a = ensureTree(layout.exportableProjectTree('projA'));
    const b = ensureTree(layout.exportableProjectTree('projB'));

    // Write from inside projA's box; it must land in projA's host tree.
    const w = await manager.exec('projA', 'echo hello-from-A > /workspace/created.txt');
    assert.equal(w.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(a, 'created.txt'), 'utf8').trim(), 'hello-from-A');

    // projB's tree never received it (no cross-Sandbox write).
    assert.ok(!fs.existsSync(path.join(b, 'created.txt')), 'write did not cross into sibling tree');

    // And projB's own box cannot see projA's file at its /workspace either.
    const bSees = await manager.exec('projB', 'ls /workspace');
    assert.ok(!bSees.stdout.includes('created.txt'), 'sibling sandbox cannot see the other project\'s write');
  } finally {
    await manager.release('projA');
    await manager.release('projB');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('(live) boundary-escape attempt is denied by the wall-clock reaper, target state preserved', { skip: !RUNTIME_LIVE ? 'no container runtime' : false }, async () => {
  const { baseDir, layout, manager } = liveSetup();
  try {
    ensureTree(layout.exportableProjectTree('projA'));
    // A command that would run forever is killed + reaped by the in-process
    // wall-clock timeout — the boundary actively refuses -> denied.
    const res = await manager.exec('projA', 'sleep 999', { timeoutMs: 1500 });
    assert.equal(res.timedOut, true, 'the run hit the wall-clock limit');
    assert.equal(res.denied, true, 'a boundary refusal is reported as denied');
  } finally {
    await manager.release('projA');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- subtask 5.4: an `allow`-class command is STILL confined ---------------
//
// Req 8.5 / subtask 5.4: isolation is INDEPENDENT of gating. A command the
// classifier rates `allow` runs through the very same boundary and is confined
// exactly like any other — the container, not the verdict, provides safety.

test('(5.4) an allow-classified command (verified via classifyCommand) is still fully confined', { skip: !RUNTIME_LIVE ? 'no container runtime' : false }, async () => {
  // Confirm the command really is `allow`-class per plumby's classifier.
  assert.equal(classifyCommand('ls /projects').outcome, 'allow', 'ls is an allow-class command');
  assert.equal(classifyCommand('echo hi').outcome, 'allow');

  const { baseDir, layout, manager } = liveSetup();
  try {
    const a = ensureTree(layout.exportableProjectTree('projA'));
    fs.writeFileSync(path.join(a, 'a.txt'), 'inside-A');

    // The benign `allow` command runs inside the box and still cannot see the
    // host: exec never consulted the verdict, so confinement is identical.
    const res = await manager.exec('projA', 'ls /projects');
    assert.notEqual(res.exitCode, 0, 'even an allow-class command cannot see the host /projects');

    const own = await manager.exec('projA', 'ls /workspace');
    assert.equal(own.exitCode, 0);
    assert.ok(own.stdout.includes('a.txt'), 'the allow-class command is confined to this project tree');
  } finally {
    await manager.release('projA');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('(5.4) exec confines allow/confirm/refuse commands IDENTICALLY (no classifier branch)', async () => {
  // Prove classifier-independence WITHOUT a live container: exec builds the same
  // isolated invocation regardless of what the classifier would say.
  assert.equal(classifyCommand('ls').outcome, 'allow');
  assert.equal(classifyCommand('rm -rf /').outcome, 'refuse');

  const layout = createStorageLayout(BASE);
  const seen = [];
  const backend = {
    async isAvailable() { return true; },
    async runOneShot(spec) {
      seen.push(spec);
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null, limitsApplied: false, requestedLimits: false, degraded: false };
    },
    async remove() { return { removed: true }; },
    async reapOrphans() { return { reaped: [] }; },
  };
  const manager = createSandboxManager({ layout, backend, config: { packageRegistryHosts: REGISTRY } });

  await manager.exec('projA', 'ls');            // allow
  await manager.exec('projA', 'rm -rf /');      // refuse
  await manager.exec('projA', 'git push');      // confirm-ish

  // Every invocation targeted the SAME isolated boundary shape: same mount
  // source, same workspace path, same network policy. The verdict changed
  // nothing about how the command was confined.
  const tree = layout.exportableProjectTree('projA');
  assert.equal(seen.length, 3);
  for (const spec of seen) {
    assert.equal(spec.mountSource, tree, 'same project tree for every verdict class');
  }
  assert.ok(seen.every((s) => s.mountSource === seen[0].mountSource && s.network === seen[0].network),
    'the isolated invocation shape is identical regardless of classifier verdict');
});

/**
 * A fake container backend that records calls and never touches a real runtime.
 * Lets the manager's structural behavior be tested deterministically.
 */
function createFakeBackend() {
  const calls = { runOneShot: [], remove: [], reapOrphans: [] };
  return {
    calls,
    async isAvailable() {
      return true;
    },
    async runOneShot(spec) {
      calls.runOneShot.push(spec);
      return { code: 0, stdout: '', stderr: '', timedOut: false, limitsApplied: false, requestedLimits: true, degraded: true };
    },
    async remove(name) {
      calls.remove.push(name);
      return { removed: true };
    },
    async reapOrphans(labelValue) {
      calls.reapOrphans.push(labelValue);
      return { reaped: [] };
    },
  };
}

// --- FEAT-003: per-command overhead path returns a numeric measurement -----
//
// A LIGHTWEIGHT smoke assertion for the prototype-first overhead path, guarded
// behind containerRuntimeAvailable() so CI stays green where no runtime can
// launch. It does NOT assert a specific latency number (latency is
// environment-dependent — the AUTHORITATIVE numbers come from running
// `node eval/sandbox-benchmark.js`, reported by the agent). It only proves that
// routing a command through the boundary completes and yields a finite,
// non-negative wall-clock measurement, so the budgeted quantity is always
// measurable. In this sandbox containers launch, so this runs for real.

test('(FEAT-003) per-command overhead path returns a finite numeric measurement', { skip: !RUNTIME_LIVE ? 'no container runtime' : false }, async () => {
  const { baseDir, layout, manager } = liveSetup();
  try {
    ensureTree(layout.exportableProjectTree('projA'));
    manager.acquire('projA');
    // Warm up so we time steady-state per-command overhead, not first spin-up.
    await manager.exec('projA', 'true');

    const t0 = performance.now();
    const res = await manager.exec('projA', 'true');
    const elapsedMs = performance.now() - t0;

    assert.equal(res.exitCode, 0, 'the no-op command runs inside the boundary');
    assert.ok(Number.isFinite(elapsedMs), 'the overhead path yields a finite measurement');
    assert.ok(elapsedMs >= 0, 'a wall-clock measurement is non-negative');
    // Deliberately NO hard latency bound here — see the block comment above.
  } finally {
    await manager.release('projA');
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
