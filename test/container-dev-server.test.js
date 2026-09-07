/**
 * container-dev-server tests (node --test) — the REAL Dev_Server behind the
 * Preview seam, plus the long-running/port-publishing capability it needs from
 * the container backend.
 *
 * WHAT IS PROVEN HERE, AND HOW HONESTLY:
 *
 *  (a) REAL, no fake in the loop: `resolveDevCommand` is a pure function and is
 *      tested directly; the stdlib-only static preview server is SPAWNED AS A REAL
 *      NODE PROCESS listening on a REAL PORT and driven with REAL HTTP requests,
 *      so "a static project actually gets served" is measured, not asserted.
 *  (b) REAL backend, fake CLI: the argv the container runtime would receive is
 *      built by the REAL `createContainerBackend` with only its `exec` faked —
 *      the same seam every other sandbox test injects. So the flags, the label,
 *      the mount, the published port and both fail-closed refusals are real code.
 *  (c) REAL PreviewController: the headline test composes the REAL
 *      `createPreviewController` with the REAL container dev server, so
 *      publish-on-commit reporting a LIVE url (not the `preview.local` placeholder)
 *      is an end-to-end behavioral claim about production code.
 *  (d) CLOCK-DRIVEN, never waited: the <=60s readiness bound is measured against an
 *      injected manual clock, with the poll delay injected as a clock advance.
 *
 * WHAT ONLY A REAL CONTAINER HOST CAN PROVE: that the runtime accepts this argv,
 * that the published port is reachable from the host, and that a given generated
 * project's dev script binds 0.0.0.0 on $PORT. No test here claims a container ran.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  createContainerDevServer,
  resolveDevCommand,
  STATIC_PREVIEW_SERVER_SRC,
  DEFAULT_PREVIEW_CONTAINER_PORT,
  READY_TIMEOUT_MS,
} from '../src/project/container-dev-server.js';
import { createPreviewController } from '../src/project/preview-controller.js';
import { createDevServer } from '../src/project/dev-server.js';
import {
  createContainerBackend,
  buildRunArgs,
  buildServiceArgs,
  renderPublishSpec,
  NETWORK_DENY_ALL,
  NETWORK_FILTERED,
  OWNER_LABEL,
} from '../src/sandbox/container-backend.js';

// --------------------------------------------------------------------- helpers

/** A manual ms clock: every SLO below is measured against this, never a real wait. */
function manualClock(start = 1_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** The Sandbox handle shape `SandboxManager.acquire` returns (the real fields used). */
function sandboxHandle(projectId, mountSource = `/data/projects/${projectId}/tree`) {
  return Object.freeze({
    projectId,
    mountSource,
    workspacePath: '/workspace',
    containerName: `aab-sbx-${projectId}`,
    egress: Object.freeze({ denyByDefault: true, allowedHosts: Object.freeze([]) }),
  });
}

/**
 * A recording backend exposing the service surface. Only the CLI is faked; the
 * dev server's own logic runs for real against it.
 */
function fakeServiceBackend({ start, statuses = [], logs = 'dev server log tail' } = {}) {
  const calls = { start: [], stop: [], status: [], logs: [] };
  const statusQueue = [...statuses];
  return {
    calls,
    image: 'node:22-slim',
    async startService(spec) {
      calls.start.push(spec);
      if (typeof start === 'function') return start(spec);
      return { ok: true, containerId: 'container-abc123', code: 0, stdout: 'container-abc123\n', stderr: '', timedOut: false, limitsApplied: false, degraded: false };
    },
    async serviceStatus(name) {
      calls.status.push(name);
      return statusQueue.length > 0 ? statusQueue.shift() : { ok: true, exists: true, running: true, exitCode: null };
    },
    async serviceLogs(name) {
      calls.logs.push(name);
      return { ok: true, logs };
    },
    async stopService(name) {
      calls.stop.push(name);
      return { ok: true, stopped: true };
    },
  };
}

/**
 * Build a dev server whose poll delay ADVANCES THE MANUAL CLOCK, so the readiness
 * bound elapses deterministically with zero real waiting.
 */
function makeDevServer({ backend, now, probe, ...rest }) {
  return createContainerDevServer({
    backend,
    network: 'aab-preview',
    now,
    nowIso: () => new Date(now()).toISOString(),
    probe,
    sleep: async (ms) => {
      now.advance(ms);
    },
    // The background watchdog is disabled so nothing depends on real time; the
    // liveness tests drive checkLiveness() directly instead.
    watchIntervalMs: 0,
    readPackageJson: () => ({ scripts: { dev: 'node server.js' } }),
    hasIndexHtml: () => false,
    ...rest,
  });
}

/** Ask the OS for a free TCP port (used only by the live static-server test). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ============================================================ resolveDevCommand

test('resolveDevCommand prefers dev, then start, then serve, and always exports PORT/HOST', () => {
  const dev = resolveDevCommand({ packageJson: { scripts: { dev: 'node d.js', start: 'node s.js', serve: 'node v.js' } } });
  assert.equal(dev.ok, true);
  assert.equal(dev.kind, 'npm-script');
  assert.equal(dev.script, 'dev');
  assert.deepEqual(dev.command, ['npm', 'run', 'dev']);
  assert.equal(dev.env.PORT, String(DEFAULT_PREVIEW_CONTAINER_PORT));
  assert.equal(dev.env.HOST, '0.0.0.0', 'a preview must bind every interface inside the container, not loopback');

  assert.equal(resolveDevCommand({ packageJson: { scripts: { start: 'x', serve: 'y' } } }).script, 'start');
  assert.equal(resolveDevCommand({ packageJson: { scripts: { serve: 'y' } } }).script, 'serve');
  // A blank script body is not a usable dev command.
  assert.equal(resolveDevCommand({ packageJson: { scripts: { dev: '   ' }, } }).ok, false);
});

test('resolveDevCommand passes explicit host/port flags for Vite (which ignores $PORT)', () => {
  const byDep = resolveDevCommand({ packageJson: { devDependencies: { vite: '^5' }, scripts: { dev: 'vite' } }, port: 4321 });
  assert.deepEqual(byDep.command, ['npm', 'run', 'dev', '--', '--host', '0.0.0.0', '--port', '4321']);

  // Detected from the script body too, for a project that shells out to vite.
  const byScript = resolveDevCommand({ packageJson: { scripts: { dev: 'vite --mode dev' } }, port: 4321 });
  assert.deepEqual(byScript.command, ['npm', 'run', 'dev', '--', '--host', '0.0.0.0', '--port', '4321']);

  // A non-Vite project gets NO appended flags (it honors $PORT/$HOST instead).
  const plain = resolveDevCommand({ packageJson: { scripts: { dev: 'node server.js' } }, port: 4321 });
  assert.deepEqual(plain.command, ['npm', 'run', 'dev']);
  assert.equal(plain.env.PORT, '4321');
});

test('resolveDevCommand falls back to the stdlib static server, and refuses when there is nothing to serve', () => {
  const staticCmd = resolveDevCommand({ packageJson: null, hasIndexHtml: true, workspacePath: '/workspace' });
  assert.equal(staticCmd.ok, true);
  assert.equal(staticCmd.kind, 'static');
  assert.equal(staticCmd.command[0], 'node');
  assert.equal(staticCmd.command[1], '-e');
  assert.equal(staticCmd.command[2], STATIC_PREVIEW_SERVER_SRC);
  assert.equal(staticCmd.env.AAB_STATIC_ROOT, '/workspace');
  // The fallback needs NO install, which is what makes it work under deny-all egress.
  assert.ok(!/npm|npx|yarn|pnpm/.test(staticCmd.command.join(' ')), 'the static fallback must not need a package install');

  const nothing = resolveDevCommand({ packageJson: { name: 'x' }, hasIndexHtml: false });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'NO_DEV_COMMAND');
});

test('resolveDevCommand refuses a mobile Target instead of publishing an HTTP port a phone cannot use', () => {
  const res = resolveDevCommand({ packageJson: { scripts: { dev: 'expo start' } }, targetCategory: 'mobile' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'MOBILE_PREVIEW_UNSUPPORTED');
});

test('resolveDevCommand never interpolates the project script BODY into the command vector', () => {
  // The script body is attacker-controlled generated content. We run `npm run dev`
  // so it is npm, inside the container, that interprets it — never a host shell,
  // and never spliced into our argv.
  const evil = '; rm -rf / #';
  const res = resolveDevCommand({ packageJson: { scripts: { dev: evil } } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.command, ['npm', 'run', 'dev']);
  assert.ok(!res.command.some((arg) => arg.includes('rm -rf')), 'the script body must never reach our argv');
});

// ==================================================== the static server, LIVE

test('(live) the static preview server really serves a project tree over real HTTP', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>generated app</h1>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.css'), 'body{color:red}');
  const secret = path.join(os.tmpdir(), 'aab-static-secret.txt');
  fs.writeFileSync(secret, 'must-not-be-served');

  const port = await freePort();
  // Exactly the command the container would run — same source string, same env.
  const child = spawn(process.execPath, ['-e', STATIC_PREVIEW_SERVER_SRC], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AAB_STATIC_ROOT: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(secret, { force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  // Wait for the real listener (bounded, and this is a local process, not a container).
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(500) });
      up = true;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(up, 'the static preview server must actually listen');

  const root = await fetch(base);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await root.text(), /generated app/, 'the served body must be the project index.html');

  const css = await fetch(`${base}/assets/app.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(await css.text(), 'body{color:red}');

  assert.equal((await fetch(`${base}/nope.html`)).status, 404);

  // Path traversal out of the served root is refused, even though the real server
  // only ever runs inside the container over one project's tree.
  for (const attempt of ['/../aab-static-secret.txt', '/%2e%2e/aab-static-secret.txt', '/..%2faab-static-secret.txt']) {
    const res = await fetch(`${base}${attempt}`, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `traversal ${attempt} must not be served (got ${res.status})`);
    if (res.status !== 403) {
      assert.ok(!(await res.text()).includes('must-not-be-served'), `traversal ${attempt} leaked host content`);
    }
  }

  // A SYMLINK inside the served tree must not read outside it. A purely lexical
  // resolve/relative check does not follow links, so this needs realpath.
  try {
    fs.symlinkSync(secret, path.join(dir, 'escape.txt'));
    const res = await fetch(`${base}/escape.txt`);
    assert.ok(res.status === 403 || res.status === 404, `a symlink out of the root must not be served (got ${res.status})`);
    assert.ok(!(await res.text()).includes('must-not-be-served'), 'a symlink leaked content outside the served root');
  } catch (err) {
    if (err?.code !== 'EPERM' && err?.code !== 'ENOSYS') throw err;
  }

  // THE CRASH CHECK: a decoded NUL byte makes fs.stat throw SYNCHRONOUSLY even in
  // callback form. Uncaught, that killed the server — one request ended the preview.
  const nul = await fetch(`${base}/%00`);
  assert.equal(nul.status, 400);
  // ...and the server is STILL ALIVE afterwards, which is the actual assertion.
  const after = await fetch(base);
  assert.equal(after.status, 200, 'the preview server must survive a malformed request');
  assert.match(await after.text(), /generated app/);
  assert.equal(child.exitCode, null, 'the preview process must not have exited');
});

// ============================================== backend: service argv + guards

test('buildServiceArgs runs DETACHED, keeps the container for logs, and publishes the port', () => {
  const args = buildServiceArgs({
    image: 'node:22-slim',
    name: 'aab-sbx-p1-preview-dead',
    labelValue: 'aab-sbx-p1',
    mountSource: '/data/p1/tree',
    network: 'aab-preview',
    publish: [{ hostIp: '127.0.0.1', hostPort: 43_000, containerPort: 5173 }],
    command: ['npm', 'run', 'dev'],
  });

  assert.equal(args[0], 'run');
  assert.ok(args.includes('-d'), 'a dev server must be detached; a blocking run would never return');
  assert.ok(!args.includes('--rm'), 'a service is kept after exit so its logs can explain the failure');
  assert.ok(args.includes('-p'), 'the preview port must be published');
  assert.equal(args[args.indexOf('-p') + 1], '127.0.0.1:43000:5173');
  assert.equal(args[args.indexOf('--network') + 1], 'aab-preview');
  // The preview container must not drift into weaker isolation than an exec container.
  assert.equal(args[args.indexOf('--pid') + 1], 'private');
  assert.ok(args.includes('--security-opt') && args.includes('no-new-privileges'));
  assert.equal(args[args.indexOf('--label') + 1], `${OWNER_LABEL}=aab-sbx-p1`, 'the owner label is what existing teardown reaps');
  assert.equal(args[args.indexOf('-v') + 1], '/data/p1/tree:/workspace', 'only this project tree is mounted');
  assert.deepEqual(args.slice(-4), ['node:22-slim', 'npm', 'run', 'dev']);
});

test('the one-shot argv is UNCHANGED by the additive service flags', () => {
  // Mutation check for the additive change: the exec path must be byte-identical.
  const args = buildRunArgs({
    image: 'node:22-slim',
    name: 'aab-sbx-p1-abc',
    labelValue: 'aab-sbx-p1',
    mountSource: '/data/p1/tree',
    command: ['true'],
  });
  assert.deepEqual(args, [
    'run', '--rm',
    '--pid', 'private',
    '--network', 'none',
    '--security-opt', 'no-new-privileges',
    '--name', 'aab-sbx-p1-abc',
    '--label', 'aab.sandbox=aab-sbx-p1',
    '-v', '/data/p1/tree:/workspace',
    '-w', '/workspace',
    'node:22-slim', 'true',
  ]);
  assert.ok(!args.includes('-d'), 'a one-shot exec must never be detached');
  assert.ok(!args.includes('-p'), 'a one-shot exec must never publish a port');
});

test('renderPublishSpec rejects out-of-range ports and non-literal host IPs', () => {
  assert.equal(renderPublishSpec({ hostPort: 43_000, containerPort: 5173 }), '127.0.0.1:43000:5173');
  for (const bad of [0, 65_536, -1, 1.5, '8080', undefined, NaN]) {
    assert.throws(() => renderPublishSpec({ hostPort: bad, containerPort: 5173 }), /hostPort/);
    assert.throws(() => renderPublishSpec({ hostPort: 43_000, containerPort: bad }), /containerPort/);
  }
  assert.throws(() => renderPublishSpec({ hostIp: 'evil.example.com', hostPort: 1, containerPort: 1 }), /hostIp/);
});

test('startService FAILS CLOSED on a published port over a non-routable network', async () => {
  // The honesty guard: `--network none` gives the container only loopback, so a
  // published port has no DNAT target and the preview URL could never answer.
  // A fake exec that would SUCCEED proves the refusal happens BEFORE any launch.
  let launched = 0;
  const exec = async () => {
    launched += 1;
    return { code: 0, stdout: 'cid', stderr: '', timedOut: false, signal: null };
  };
  const backend = createContainerBackend({ exec });
  assert.equal(backend.supportsServices, true);

  await assert.rejects(
    () => backend.startService({
      name: 'aab-sbx-p1-preview',
      mountSource: '/data/p1',
      command: ['npm', 'run', 'dev'],
      network: NETWORK_DENY_ALL,
      publish: [{ hostPort: 43_000, containerPort: 5173 }],
    }),
    /published ports require a routable network/,
  );
  assert.equal(launched, 0, 'nothing may be launched when the published port could not answer');

  // Same fail-closed rule as runOneShot for unenforceable egress filtering.
  await assert.rejects(
    () => backend.startService({
      name: 'aab-sbx-p1-preview',
      mountSource: '/data/p1',
      command: ['npm', 'run', 'dev'],
      network: NETWORK_FILTERED,
      publish: [{ hostPort: 43_000, containerPort: 5173 }],
    }),
    /egress filtering not supported by this backend/,
  );
  assert.equal(launched, 0);

  // A routable network with a published port DOES launch, and reports the id.
  const ok = await backend.startService({
    name: 'aab-sbx-p1-preview',
    mountSource: '/data/p1',
    command: ['npm', 'run', 'dev'],
    network: 'aab-preview',
    publish: [{ hostPort: 43_000, containerPort: 5173 }],
  });
  assert.equal(launched, 1);
  assert.equal(ok.ok, true);
  assert.equal(ok.containerId, 'cid');

  // A network-less service (no published port) is still allowed — it is honest.
  await backend.startService({ name: 'n', mountSource: '/d', command: ['true'], network: NETWORK_DENY_ALL });
  assert.equal(launched, 2);
});

test('startService removes the name-holding container before the cgroup-degrade retry', async () => {
  // `run -d` can fail AFTER creating the container, which keeps the name; without
  // the removal the retry would fail with a name conflict instead of degrading.
  const seen = [];
  const exec = async (bin, args) => {
    seen.push(args);
    if (args[0] === 'rm') return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
    const hasLimits = args.includes('--memory');
    if (hasLimits) return { code: 125, stdout: '', stderr: 'cannot set memory.max: cgroup delegation', timedOut: false, signal: null };
    return { code: 0, stdout: 'cid-degraded', stderr: '', timedOut: false, signal: null };
  };
  const backend = createContainerBackend({ exec });
  const res = await backend.startService({
    name: 'aab-sbx-p1-preview',
    mountSource: '/data/p1',
    command: ['npm', 'run', 'dev'],
    network: 'aab-preview',
    publish: [{ hostPort: 43_000, containerPort: 5173 }],
    limits: { memoryMb: 256 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.degraded, true);
  assert.equal(res.limitsApplied, false, 'we never claim limits applied when they were dropped');
  assert.equal(res.containerId, 'cid-degraded');
  const kinds = seen.map((a) => a[0]);
  assert.deepEqual(kinds, ['run', 'rm', 'run'], 'the stale name must be removed between attempts');
});

test('serviceStatus and serviceLogs report liveness and diagnostics without throwing', async () => {
  const backend = createContainerBackend({
    exec: async (bin, args) => {
      if (args[0] === 'inspect') return { code: 0, stdout: 'false 137\n', stderr: '', timedOut: false, signal: null };
      if (args[0] === 'logs') return { code: 0, stdout: 'listening\n', stderr: 'a warning\n', timedOut: false, signal: null };
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
    },
  });
  const status = await backend.serviceStatus('aab-sbx-p1-preview');
  assert.deepEqual(status, { ok: true, exists: true, running: false, exitCode: 137 });

  const logs = await backend.serviceLogs('aab-sbx-p1-preview');
  assert.equal(logs.ok, true);
  assert.match(logs.logs, /listening/);
  assert.match(logs.logs, /a warning/, 'a dev server logs to BOTH streams; the tail must carry both');

  // A missing container / absent runtime is reported, never thrown.
  const absent = createContainerBackend({
    exec: async () => ({ code: 1, stdout: '', stderr: 'no such object', timedOut: false, signal: null }),
  });
  assert.deepEqual(
    { ...(await absent.serviceStatus('gone')), code: undefined, stderr: undefined },
    { ok: false, exists: false, running: false, exitCode: null, code: undefined, stderr: undefined },
  );
});

// ================================================ the dev server: real behavior

test('start returns a REAL published URL synchronously and launches inside the project boundary', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({ backend, now, probe: async () => true, portRange: { from: 43_000, to: 43_001 } });

  const started = devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1'), targetCategory: 'web' });

  assert.equal(started.ok, true);
  // The whole point of the follow-up: NOT the inert placeholder.
  assert.equal(started.url, 'http://127.0.0.1:43000');
  assert.ok(!started.url.includes('preview.local'), 'a real preview must not report the placeholder host');
  assert.equal(started.hostPort, 43_000);
  assert.equal(devServer.isRunning('p1'), true);
  assert.equal(devServer.status('p1').phase, 'starting', 'start is synchronous; readiness is not yet established');

  const ready = await devServer.whenReady('p1');
  assert.equal(ready.ok, true);
  assert.equal(devServer.status('p1').phase, 'running');

  // It launched ONE container, inside this project's boundary, on the preview
  // network, publishing the allocated port, under the owner label.
  assert.equal(backend.calls.start.length, 1);
  const spec = backend.calls.start[0];
  assert.equal(spec.mountSource, '/data/projects/p1/tree', 'the dev server runs over the project tree ONLY');
  assert.equal(spec.labelValue, 'aab-sbx-p1', 'the owner label ties teardown to the existing reaper');
  assert.equal(spec.network, 'aab-preview');
  assert.deepEqual(spec.publish, [{ hostIp: '127.0.0.1', hostPort: 43_000, containerPort: DEFAULT_PREVIEW_CONTAINER_PORT }]);
  assert.deepEqual(spec.command, ['npm', 'run', 'dev']);
  assert.equal(spec.env.PORT, String(DEFAULT_PREVIEW_CONTAINER_PORT));
  assert.ok(spec.name.startsWith('aab-sbx-p1-preview-'), 'the container name is derived from the boundary label');
});

test('the readiness bound is measured on the INJECTED clock and reported as readyMs', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  // Answer only after two poll intervals have elapsed.
  let polls = 0;
  const devServer = makeDevServer({
    backend,
    now,
    probe: async () => {
      polls += 1;
      return polls > 2;
    },
  });

  devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  const ready = await devServer.whenReady('p1');
  assert.equal(ready.ok, true);
  assert.equal(ready.readyMs, 500, 'two 250ms poll delays, measured on the injected clock');
  assert.ok(ready.readyMs < READY_TIMEOUT_MS);
});

test('a Dev_Server that never serves times out at the bound, is torn down, and frees its port', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const exits = [];
  const devServer = makeDevServer({
    backend,
    now,
    probe: async () => false,
    onExit: (projectId, info) => exits.push({ projectId, info }),
  });

  const started = devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  assert.equal(started.ok, true);
  assert.deepEqual(devServer.heldHostPorts(), [43_000]);

  const ready = await devServer.whenReady('p1');
  assert.equal(ready.ok, false);
  assert.equal(ready.code, 'PREVIEW_READY_TIMEOUT');
  assert.match(ready.message, /60000ms/);
  // Elapsed on the injected clock crossed the bound — and nothing really waited.
  assert.ok(now() - 1_000 > READY_TIMEOUT_MS, 'the bound must be crossed on the clock');

  assert.equal(devServer.status('p1').phase, 'failed');
  assert.equal(devServer.isRunning('p1'), false);
  assert.deepEqual(devServer.heldHostPorts(), [], 'a failed preview must not leak its host port');
  assert.deepEqual(backend.calls.stop, [backend.calls.start[0].name], 'the stuck container must be removed');
  assert.equal(exits.length, 1, 'PreviewController must be told, so it can offer a restart');
  assert.equal(exits[0].projectId, 'p1');
  assert.match(exits[0].info.logs, /dev server log tail/, 'the failure carries the container logs');
});

test('a Dev_Server that dies is reported IMMEDIATELY with its exit code, not after the full bound', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend({ statuses: [{ ok: true, exists: true, running: false, exitCode: 1 }] });
  const devServer = makeDevServer({ backend, now, probe: async () => false });

  devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  const ready = await devServer.whenReady('p1');

  assert.equal(ready.ok, false);
  assert.equal(ready.code, 'DEV_SERVER_EXITED');
  assert.match(ready.message, /exited with code 1/);
  // The mutation check: without the liveness probe this would have burned the
  // whole 60s bound before reporting.
  assert.equal(now() - 1_000, 0, 'a dead container must be detected on the first poll, with no clock spent');
  assert.equal(backend.calls.status.length, 1);
});

test('a launch the backend REFUSES surfaces the refusal reason verbatim', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend({
    start: async () => {
      throw new Error('published ports require a routable network: ...');
    },
  });
  const devServer = makeDevServer({ backend, now, probe: async () => true });

  devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  const ready = await devServer.whenReady('p1');
  assert.equal(ready.ok, false);
  assert.equal(ready.code, 'PREVIEW_LAUNCH_REFUSED');
  assert.match(ready.message, /routable network/, 'a configuration refusal must not be flattened into a timeout');
  assert.deepEqual(devServer.heldHostPorts(), []);
});

test('a runtime that refuses the launch is reported with the runtime stderr', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend({
    start: async () => ({ ok: false, containerId: null, code: 125, stdout: '', stderr: 'network aab-preview not found', timedOut: false }),
  });
  const devServer = makeDevServer({ backend, now, probe: async () => true });
  devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  const ready = await devServer.whenReady('p1');
  assert.equal(ready.code, 'PREVIEW_LAUNCH_FAILED');
  assert.match(ready.message, /network aab-preview not found/);
});

test('start REFUSES without a Sandbox handle rather than launching something unconfined', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({ backend, now, probe: async () => true });

  const res = devServer.start({ projectId: 'p1', targetCategory: 'web' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SANDBOX_REQUIRED');
  assert.equal(backend.calls.start.length, 0, 'no container may be launched outside a project boundary');
  assert.deepEqual(devServer.heldHostPorts(), [], 'a refused start must not hold a port');
});

test('start refuses a project with no way to run a dev server, and launches nothing', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({
    backend,
    now,
    probe: async () => true,
    readPackageJson: () => ({ name: 'no-scripts' }),
    hasIndexHtml: () => false,
  });
  const res = devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_DEV_COMMAND');
  assert.equal(backend.calls.start.length, 0);
});

test('an unreadable project tree is refused, not crashed on', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({
    backend,
    now,
    probe: async () => true,
    readPackageJson: () => {
      throw new Error('EACCES');
    },
    hasIndexHtml: () => {
      throw new Error('EACCES');
    },
  });
  const res = devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_DEV_COMMAND');
});

test('start is idempotent, and concurrent projects never share a host port', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({ backend, now, probe: async () => true });

  const a1 = devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  const a2 = devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  assert.deepEqual(a2, { ok: true, url: a1.url, startedAt: a1.startedAt, hostPort: a1.hostPort, kind: a1.kind });
  assert.equal(backend.calls.start.length, 1, 'an already-live project must not launch a second container');

  const b = devServer.start({ projectId: 'p2', sandbox: sandboxHandle('p2') });
  assert.notEqual(b.hostPort, a1.hostPort, 'two previews must never publish on the same host port');
  assert.deepEqual(devServer.heldHostPorts(), [43_000, 43_001]);

  await devServer.whenReady('p1');
  await devServer.whenReady('p2');
});

test('port exhaustion is refused with a structured error', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({ backend, now, probe: async () => true, portRange: { from: 43_000, to: 43_000 } });
  assert.equal(devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') }).ok, true);
  const second = devServer.start({ projectId: 'p2', sandbox: sandboxHandle('p2') });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'NO_PREVIEW_PORT');
  await devServer.whenReady('p1');
});

test('stop removes the container, releases the port, and is idempotent', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({ backend, now, probe: async () => true });

  devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  await devServer.whenReady('p1');
  const name = backend.calls.start[0].name;

  const stopped = devServer.stop('p1');
  assert.deepEqual(stopped, { ok: true, stopped: true });
  await devServer.whenStopped('p1');
  assert.deepEqual(backend.calls.stop, [name], 'the real container must be removed');
  assert.equal(devServer.isRunning('p1'), false);
  assert.deepEqual(devServer.heldHostPorts(), [], 'the host port must return to the pool');

  // Idempotent, and the freed port is reusable.
  assert.deepEqual(devServer.stop('p1'), { ok: true, stopped: false });
  assert.equal(devServer.start({ projectId: 'p3', sandbox: sandboxHandle('p3') }).hostPort, 43_000);
  await devServer.whenReady('p3');
});

test('a stop that races the readiness probe wins, tears the container down, and reports no failure', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const exits = [];
  const devServer = makeDevServer({
    backend,
    now,
    probe: async () => {
      devServer.stop('p1');
      return false;
    },
    onExit: (id, info) => exits.push(info),
  });
  devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  const ready = await devServer.whenReady('p1');
  assert.equal(ready.code, 'STOPPED');
  assert.deepEqual(exits, [], 'an intentional stop is not an unexpected exit');

  // The container must actually be removed. Without this the stopped project left
  // a LIVE, port-publishing container behind while the pool thought it was free.
  await devServer.whenStopped('p1');
  assert.deepEqual(backend.calls.stop, [backend.calls.start[0].name], 'a stopped preview must be removed');
  assert.deepEqual(devServer.heldHostPorts(), []);
});

test('a stop issued BEFORE the container exists still removes it once it does', async () => {
  // The removal must be chained onto the in-flight launch. Firing it immediately
  // loses the race: `rm -f` reports "no such container", then `run -d` creates one,
  // leaving a live container publishing a port the pool believes is free.
  const now = manualClock();
  const order = [];
  const live = new Set();
  const backend = {
    calls: { start: [], stop: [], status: [], logs: [] },
    async startService(spec) {
      backend.calls.start.push(spec);
      await new Promise((r) => setTimeout(r, 5)); // creation takes a moment
      live.add(spec.name);
      order.push(`create:${spec.name}`);
      return { ok: true, containerId: 'cid', code: 0, stdout: 'cid', stderr: '', timedOut: false };
    },
    async serviceStatus() { return { ok: true, exists: true, running: true, exitCode: null }; },
    async serviceLogs() { return { ok: true, logs: '' }; },
    async stopService(name) {
      backend.calls.stop.push(name);
      live.delete(name);
      order.push(`remove:${name}`);
      return { ok: true, stopped: true };
    },
  };
  const devServer = makeDevServer({ backend, now, probe: async () => true });

  devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  const name = backend.calls.start[0].name;
  devServer.stop('p1'); // lands while the launch is still in flight
  await devServer.whenStopped('p1');

  assert.deepEqual(order, [`create:${name}`, `remove:${name}`], 'removal must follow creation, not precede it');
  assert.deepEqual([...live], [], 'no live container may survive its own stop');
  assert.deepEqual(devServer.heldHostPorts(), [], 'the port is freed only once the container is gone');
});

test('a failed preview never frees a host port another project now holds', async () => {
  // THE REPRODUCTION of a cross-project defect: releasing by bare port value let a
  // failed-then-stopped project free a port a DIFFERENT project had since claimed,
  // after which the next start was handed a URL pointing at the other project's
  // running preview.
  const now = manualClock();
  const backend = fakeServiceBackend();
  // A never comes up; everything started afterwards does. (Keyed on a flag, not on
  // the URL, precisely because B legitimately reuses A's freed port.)
  let previewsAnswer = false;
  const devServer = makeDevServer({
    backend,
    now,
    probe: async () => previewsAnswer,
    portRange: { from: 43_000, to: 43_001 },
  });

  const a = devServer.start({ projectId: 'A', sandbox: sandboxHandle('A') });
  assert.equal(a.hostPort, 43_000);
  assert.equal((await devServer.whenReady('A')).ok, false, 'A must fail');
  previewsAnswer = true;
  assert.deepEqual(devServer.heldHostPorts(), [], 'a failed preview releases its port once');

  const b = devServer.start({ projectId: 'B', sandbox: sandboxHandle('B') });
  assert.equal(b.hostPort, 43_000, 'B legitimately reuses the freed port');
  assert.equal((await devServer.whenReady('B')).ok, true);

  // Stopping the ALREADY-FAILED A must not free the port B is publishing on.
  devServer.stop('A');
  await devServer.whenStopped('A');
  assert.deepEqual(devServer.heldHostPorts(), [43_000], "B's port must still be held");

  const c = devServer.start({ projectId: 'C', sandbox: sandboxHandle('C') });
  assert.notEqual(c.hostPort, b.hostPort, 'C must never be handed the port B is serving on');
  assert.notEqual(c.url, b.url, 'two projects must never be given the same preview URL');
  await devServer.whenReady('C');
});

test('a Dev_Server that dies AFTER it came up is detected, torn down, and reported', async () => {
  // Readiness polling stops at the first success, so without a liveness check a
  // preview that OOMs later left the surface claiming a URL that no longer answers,
  // with its port still held.
  const now = manualClock();
  const backend = fakeServiceBackend();
  const exits = [];
  const devServer = makeDevServer({ backend, now, probe: async () => true, onExit: (id, info) => exits.push(info) });

  devServer.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  assert.equal((await devServer.whenReady('p1')).ok, true);
  assert.equal(devServer.status('p1').phase, 'running');

  // Still alive: nothing changes.
  assert.deepEqual(await devServer.checkLiveness('p1'), { phase: 'running', alive: true });
  assert.equal(devServer.isRunning('p1'), true);
  assert.deepEqual(exits, []);

  // Now it dies.
  backend.serviceStatus = async () => ({ ok: true, exists: true, running: false, exitCode: 137 });
  assert.deepEqual(await devServer.checkLiveness('p1'), { phase: 'failed', alive: false });

  assert.equal(devServer.isRunning('p1'), false, 'a dead preview must not still report as running');
  assert.equal(devServer.status('p1').error.code, 'DEV_SERVER_EXITED');
  assert.match(devServer.status('p1').error.message, /exited with code 137 after the Preview was serving/);
  assert.deepEqual(devServer.heldHostPorts(), [], 'a dead preview must release its port');
  assert.equal(exits.length, 1, 'PreviewController must be told so it can offer a restart');
});

test('the preview container inherits the boundary cgroup limits', async () => {
  // The longest-lived container running untrusted generated code must not be the
  // one without a memory cap.
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({ backend, now, probe: async () => true });
  const handle = { ...sandboxHandle('p1'), limits: { memoryMb: 512, cpus: 1, pids: 128 } };

  devServer.start({ projectId: 'p1', sandbox: handle });
  await devServer.whenReady('p1');
  assert.deepEqual(backend.calls.start[0].limits, { memoryMb: 512, cpus: 1, pids: 128 });
});

test('the network is REQUIRED at construction — a preview never guesses one', () => {
  const backend = fakeServiceBackend();
  assert.throws(() => createContainerDevServer({ backend }), /network must be a non-empty string/);
  assert.throws(() => createContainerDevServer({ network: 'aab-preview' }), /startService/);
  assert.throws(
    () => createContainerDevServer({ backend, network: 'aab-preview', portRange: { from: 900, to: 800 } }),
    /portRange/,
  );
});

// ============================ the headline claim, through the REAL controller

test('the REAL PreviewController publishes a LIVE preview URL, where the inert seam could not', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend();
  const devServer = makeDevServer({ backend, now, probe: async () => true });
  // The REAL controller — publish-on-commit, SLOs and all.
  const controller = createPreviewController({ devServer, now });

  const started = controller.start({ projectId: 'p1', sandbox: sandboxHandle('p1'), targetCategory: 'web' });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'ready');
  assert.equal(started.url, 'http://127.0.0.1:43000');
  await devServer.whenReady('p1');

  const published = controller.publish({ projectId: 'p1', snapshotId: 'snap-1', buildOk: true });
  assert.equal(published.status, 'served', 'a running Dev_Server must make the committed snapshot SERVED');
  assert.equal(published.url, 'http://127.0.0.1:43000');

  const served = controller.servedPreview('p1');
  assert.equal(served.status, 'served');
  assert.equal(served.snapshotId, 'snap-1');
  assert.equal(served.url, 'http://127.0.0.1:43000');
  assert.ok(!served.url.includes('preview.local'));

  // THE MUTATION CHECK: the inert seam, through the same real controller, serves
  // the placeholder host. If someone reverts the composition to the inert seam,
  // this asserts the difference rather than passing silently.
  const inert = createPreviewController({ devServer: createDevServer(), now: manualClock() });
  inert.start({ projectId: 'p1', sandbox: sandboxHandle('p1'), targetCategory: 'web' });
  const inertServed = inert.publish({ projectId: 'p1', snapshotId: 'snap-1', buildOk: true });
  assert.match(inertServed.url, /^http:\/\/preview\.local\//, 'the inert seam serves a placeholder, by design');
  assert.notEqual(inertServed.url, served.url);
});

test('a dead Dev_Server reaches PreviewController.notifyExit, which RETAINS the served preview', async () => {
  const now = manualClock();
  const backend = fakeServiceBackend({ statuses: [{ ok: true, exists: true, running: false, exitCode: 1 }] });
  let controller;
  const devServer = makeDevServer({
    backend,
    now,
    probe: async () => false,
    // Exactly how the composition root wires it.
    onExit: (projectId, info) => controller.notifyExit({ projectId, error: info.error }),
  });
  controller = createPreviewController({ devServer, now });

  // Publish a good snapshot first, with a live handle.
  controller.start({ projectId: 'p1', sandbox: sandboxHandle('p1') });
  controller.publish({ projectId: 'p1', snapshotId: 'snap-1', buildOk: true });
  assert.equal(controller.servedPreview('p1').status, 'served');

  const before = controller.servedPreview('p1');
  assert.equal(before.status, 'served');
  assert.equal(before.url, 'http://127.0.0.1:43000');

  // Now let the container die: notifyExit fires through onExit.
  await devServer.whenReady('p1');

  const served = controller.servedPreview('p1');
  // RETAINED: the committed snapshot survives the crash (Req 3.6 / Property 3).
  assert.equal(served.snapshotId, 'snap-1', 'a crashed Dev_Server must not lose the served snapshot');
  // ...and this is the part that is only true if notifyExit ACTUALLY RAN. Asserting
  // the snapshot alone was tautological: it is preserved because nothing clears it,
  // so that assertion passed even with the onExit notification deleted.
  assert.equal(served.status, 'committed', 'a dead Dev_Server must stop being reported as SERVED');
  assert.equal(served.url, null, 'a URL that no longer answers must not still be advertised');
  assert.notEqual(served.status, before.status, 'the surface must visibly change when the preview dies');
});
