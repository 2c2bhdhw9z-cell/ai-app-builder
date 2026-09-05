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
  buildRunArgs,
  cgroupFlagsFor,
  WORKSPACE_MOUNT_PATH,
} from '../src/sandbox/container-backend.js';
import { createSandboxManager } from '../src/sandbox/sandbox-manager.js';

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

test(propertyTag(1, 'Isolation_Boundary invariant'), () => {
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

  fc.assert(
    fc.property(
      safeSegment,
      safeSegment,
      fc.array(bindingArb, { maxLength: 8 }),
      (projectId, otherId, rawBindings) => {
        const backend = createFakeBackend();
        const bindings = rawBindings.map((b) => activeBinding(b.host, { status: b.status }));
        const manager = createSandboxManager({
          layout,
          backend,
          config: { packageRegistryHosts: REGISTRY, limits: { memoryMb: 256, cpus: 1, pids: 128 } },
          bindingsFor: () => bindings,
        });

        const sandbox = manager.acquire(projectId);

        // INVARIANT 1: the bind-mount source is EXACTLY this project's tree.
        assert.equal(sandbox.mountSource, layout.exportableProjectTree(projectId));
        // INVARIANT 2: it is NOT any other project's tree (when ids differ).
        if (otherId !== projectId) {
          assert.notEqual(sandbox.mountSource, layout.exportableProjectTree(otherId));
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
              // only assert absence if no OTHER active binding shares the host
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
