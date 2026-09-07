/**
 * container-dev-server.js — a REAL Dev_Server behind the existing Dev_Server seam
 * (follow-up to spec subtask 13.2, Req 1.3, 3.1, 3.3, 3.5, 3.6).
 *
 * WHAT THIS REPLACES. `src/project/dev-server.js` implements the same seam
 * INERTLY: it records that a start was requested and synthesizes a
 * `http://preview.local/<id>` placeholder, launching nothing, so a client is
 * handed a preview URL that serves no content. This module implements the SAME
 * interface for real:
 *
 *     start({ projectId, sandbox, targetCategory }) -> { ok, url?, startedAt? }
 *     stop(projectId)                               -> { ok, stopped }
 *     isRunning(projectId)                          -> boolean
 *
 * so `PreviewController` and `ProjectManager` are untouched — the seam interface
 * is stable and the two implementations are interchangeable. It launches a
 * LONG-RUNNING dev-server process INSIDE the project's Isolation_Boundary (the
 * same bind-mounted tree, the same owner label, the same cgroup limits as an exec
 * container) and publishes its port to the host, so the URL the Preview surface
 * reports is a URL that actually answers.
 *
 * WHY `start` STAYS SYNCHRONOUS. `PreviewController.start` calls this seam
 * synchronously and inspects `started.ok` immediately (preview-controller.js);
 * returning a Promise would make `started.ok !== true` true for every start and
 * turn every preview into a startup timeout. So `start` does the synchronous part
 * — allocate the host port, resolve the dev command, compute the URL, record the
 * intent — returns the handle, and drives the container launch plus the readiness
 * probe ASYNCHRONOUSLY. `whenReady(projectId)` exposes that async result for
 * callers (and tests) that want to await it; `status(projectId)` exposes the
 * current phase. A dev server that dies is reported through the injected `onExit`
 * so `PreviewController.notifyExit` can preserve served state and offer a restart.
 *
 * THE 60s BOUND IS CLOCK-DRIVEN. Readiness is polled against the INJECTED `now`
 * and the INJECTED `sleep`, exactly like every other SLO in this codebase, so a
 * test drives the whole bound with a manual clock and never waits.
 *
 * WHAT A REAL CONTAINER HOST MUST CONFIRM (it cannot be proven in this build
 * sandbox, which has no container runtime): that the runtime accepts the emitted
 * argv, that the published port is reachable from the host, and that a generated
 * project's dev script binds 0.0.0.0 on $PORT. Everything ABOVE the runtime CLI —
 * argv construction, the fail-closed network rules, phase transitions, the
 * readiness/timeout/exit paths, port accounting and the static fallback server —
 * is exercised here against injected fakes and, for the static server, against a
 * real HTTP server on a real port.
 *
 * THE PLUMBY BOUNDARY: this module never imports the plumby package.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock and every collaborator; structured { ok:false, code, message } results
 * for expected rejections rather than throwing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';
import { WORKSPACE_MOUNT_PATH } from '../sandbox/container-backend.js';

/** The in-container port a preview dev server is asked to listen on. */
export const DEFAULT_PREVIEW_CONTAINER_PORT = 5173;

/** The <=60s "Preview available after Dev_Server start" bound (Req 1.3), in ms. */
export const READY_TIMEOUT_MS = 60_000;

/** How often readiness is polled, in ms (clock-driven, never a real wait in tests). */
export const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * How often a RUNNING Dev_Server is checked for having died. Real time, not the
 * injected clock — this is a background watchdog, not an SLO. Set to 0 to disable
 * (the tests do, and drive checkLiveness directly so nothing waits).
 */
export const DEFAULT_WATCH_INTERVAL_MS = 10_000;

/** Wall-clock limit for the `docker run -d` CALL itself (not the server's life). */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;

/** Default host port range previews are published on. */
export const DEFAULT_PORT_RANGE = Object.freeze({ from: 43_000, to: 43_999 });

/** npm scripts we will start a dev server from, in preference order. */
export const DEV_SCRIPT_PREFERENCE = Object.freeze(['dev', 'start', 'serve']);

/**
 * A dependency-free static preview server, run as `node -e <this>` INSIDE the
 * container for a project that has no dev script (a plain HTML/CSS/JS app).
 *
 * WHY INLINE SOURCE: the sandbox has deny-by-default egress, so we cannot install
 * a static-server package to serve a static project — and requiring one would
 * make the commonest generated project the one case that cannot be previewed.
 * Node's standard library is already in the image, so this needs nothing.
 *
 * It refuses path traversal (resolve + containment check) even though it only
 * ever runs inside the container over a single project's tree.
 */
export const STATIC_PREVIEW_SERVER_SRC = `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const realpath = fs.realpath.native || fs.realpath;
const root = process.env.AAB_STATIC_ROOT || process.cwd();
const port = Number(process.env.PORT) || ${DEFAULT_PREVIEW_CONTAINER_PORT};
const host = process.env.HOST || '0.0.0.0';
const types = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8'
};
function send(res, code, body) {
  try { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(body); } catch (e) {}
}
// EVERY request is wrapped: an fs call that validates its argument SYNCHRONOUSLY
// (a NUL byte makes fs.stat throw despite the callback form) would otherwise
// escape as an uncaught exception and kill the preview on a single bad request.
function handle(req, res) {
  var p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { send(res, 400, 'bad request'); return; }
  if (p.indexOf('\\0') !== -1) { send(res, 400, 'bad request'); return; }
  var target = path.resolve(root, '.' + p);
  if (!contained(root, target)) { send(res, 403, 'forbidden'); return; }
  fs.stat(target, function (err, st) {
    var file = !err && st.isDirectory() ? path.join(target, 'index.html') : target;
    // Resolve symlinks BEFORE serving: a lexical check alone lets a symlink
    // inside the tree read outside the served root.
    realpath(file, function (rpErr, real) {
      if (rpErr) { send(res, 404, 'not found'); return; }
      if (!contained(root, real)) { send(res, 403, 'forbidden'); return; }
      fs.readFile(real, function (e, buf) {
        if (e) { send(res, 404, 'not found'); return; }
        try {
          res.writeHead(200, {
            'content-type': types[path.extname(real).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-store'
          });
          res.end(buf);
        } catch (e2) {}
      });
    });
  });
}
function contained(base, candidate) {
  if (candidate === base) return true;
  var rel = path.relative(base, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
var server = http.createServer(function (req, res) {
  try { handle(req, res); } catch (e) { send(res, 400, 'bad request'); }
});
server.on('clientError', function (err, socket) { try { socket.destroy(); } catch (e) {} });
server.listen(port, host, function () {
  console.log('aab static preview listening on ' + host + ':' + port);
});
`;

/**
 * Resolve HOW to start a dev server for a project — a PURE function over the
 * project's package.json, so the decision is fully testable without a container.
 *
 * The command is always an ARGV VECTOR, never a shell string, and the project's
 * script BODY is never interpolated into a command: we run `npm run <name>`, so
 * untrusted generated content is executed by npm inside the container exactly as
 * a developer would run it, and never by a host shell.
 *
 * PORT BINDING. `PORT` and `HOST` are exported into the container for every kind
 * of dev server. Most toolchains honor them; Vite notably does NOT, so when the
 * project declares Vite we append the equivalent explicit flags. A project whose
 * dev script ignores both will start but bind the wrong interface/port — that is
 * the one failure mode a real container host has to confirm, and it surfaces here
 * as a readiness timeout with the container's logs attached.
 *
 * @param {object} [args]
 * @param {object|null} [args.packageJson]   parsed package.json, or null if absent
 * @param {string} [args.targetCategory]     the project's Target category
 * @param {number} [args.port]               in-container port to listen on
 * @param {boolean} [args.hasIndexHtml]      does the tree have a servable index.html?
 * @param {string} [args.workspacePath]      in-container mount path (static root)
 * @returns {{ ok:true, kind:'npm-script'|'static', script?:string, command:string[],
 *             env:Object<string,string> }
 *          | { ok:false, code:string, message:string }}
 */
export function resolveDevCommand({
  packageJson,
  targetCategory = 'web',
  port = DEFAULT_PREVIEW_CONTAINER_PORT,
  hasIndexHtml = false,
  workspacePath = WORKSPACE_MOUNT_PATH,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, code: 'INVALID_PORT', message: `port must be an integer in 1..65535, got ${port}` };
  }

  // A mobile/Expo preview needs a tunnel + a device, not a published HTTP port.
  // Refuse honestly instead of publishing a URL a phone cannot use.
  if (targetCategory === 'mobile') {
    return {
      ok: false,
      code: 'MOBILE_PREVIEW_UNSUPPORTED',
      message:
        'a mobile/Expo Preview needs a device-reachable Expo endpoint, not a published HTTP port; ' +
        'use PreviewController.previewMobile for the mobile surface',
    };
  }

  const env = { PORT: String(port), HOST: '0.0.0.0' };
  const scripts =
    packageJson && typeof packageJson.scripts === 'object' && packageJson.scripts !== null
      ? packageJson.scripts
      : {};

  const script = DEV_SCRIPT_PREFERENCE.find(
    (name) => typeof scripts[name] === 'string' && scripts[name].trim() !== '',
  );

  if (script) {
    const command = ['npm', 'run', script];
    // Vite ignores $PORT/$HOST, so pass its flags explicitly. `--` separates npm's
    // own arguments from the script's.
    if (declaresVite(packageJson, scripts[script])) {
      command.push('--', '--host', '0.0.0.0', '--port', String(port));
    }
    return { ok: true, kind: 'npm-script', script, command, env };
  }

  // No dev script: serve the tree statically with the stdlib-only server above.
  // This needs no install, so it works under deny-by-default egress.
  if (hasIndexHtml) {
    return {
      ok: true,
      kind: 'static',
      command: ['node', '-e', STATIC_PREVIEW_SERVER_SRC],
      env: { ...env, AAB_STATIC_ROOT: workspacePath },
    };
  }

  return {
    ok: false,
    code: 'NO_DEV_COMMAND',
    message:
      'no way to start a Dev_Server for this project: package.json declares none of ' +
      `[${DEV_SCRIPT_PREFERENCE.join(', ')}] and the tree has no index.html to serve statically`,
  };
}

/** Does this project use Vite (which ignores $PORT/$HOST)? */
function declaresVite(packageJson, scriptBody) {
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  if (Object.prototype.hasOwnProperty.call(deps, 'vite')) return true;
  // The script body is only ever PATTERN-MATCHED, never executed by us.
  return typeof scriptBody === 'string' && /\bvite\b/.test(scriptBody);
}

/** Default readiness probe: any HTTP response proves something is listening. */
async function defaultProbe(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    });
    // A 404 or a 500 still means the dev server accepted the connection and
    // answered, which is exactly what "the preview is up" means here.
    return typeof res.status === 'number' && res.status > 0;
  } catch {
    return false;
  }
}

/** Default sleep. Tests inject one that ADVANCES THE MANUAL CLOCK instead. */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** Read + parse a project's package.json from the host-side tree. Null on any failure. */
function defaultReadPackageJson(mountSource) {
  try {
    return JSON.parse(fs.readFileSync(path.join(mountSource, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Does the tree have an index.html we could serve statically? */
function defaultHasIndexHtml(mountSource) {
  return (
    fs.existsSync(path.join(mountSource, 'index.html')) ||
    fs.existsSync(path.join(mountSource, 'public', 'index.html'))
  );
}

/**
 * Create a REAL, container-backed Dev_Server implementing the Dev_Server seam.
 *
 * @param {object} args
 * @param {object} args.backend  container backend with startService/stopService/
 *        serviceStatus/serviceLogs (src/sandbox/container-backend.js). REQUIRED.
 * @param {string} args.network  the CONCRETE container network the preview joins.
 *        REQUIRED and never defaulted: a preview must publish a port, a published
 *        port needs a routable network, and silently picking one would grant the
 *        generated app egress the deny-by-default posture forbids. The operator
 *        states it (AAB_PREVIEW_NETWORK).
 * @param {string} [args.image]  image for the dev-server container (default: backend.image)
 * @param {string} [args.hostIp='127.0.0.1']  host IP previews are published on
 * @param {number} [args.containerPort]  in-container listen port
 * @param {{from:number,to:number}} [args.portRange]  host ports previews may use
 * @param {() => number} [args.now]  injectable ms clock (drives the readiness bound)
 * @param {() => string} [args.nowIso]  injectable ISO clock for startedAt
 * @param {number} [args.readyTimeoutMs]  the <=60s readiness bound
 * @param {number} [args.pollIntervalMs]
 * @param {(url:string)=>Promise<boolean>} [args.probe]  readiness probe seam
 * @param {(ms:number)=>Promise<void>} [args.sleep]  poll delay seam
 * @param {object} [args.limits]  cgroup limits requested for the dev-server container
 * @param {boolean} [args.readOnlyMount=false]  a dev server usually needs to write
 * @param {(projectId:string, info:object)=>void} [args.onExit]  called when a
 *        started Dev_Server fails or dies, so PreviewController.notifyExit can run
 * @param {(mountSource:string)=>object|null} [args.readPackageJson]  fs seam
 * @param {(mountSource:string)=>boolean} [args.hasIndexHtml]  fs seam
 * @param {(args:object)=>string} [args.urlFor]  preview-URL synthesizer
 * @returns {object} devServer seam (frozen)
 */
export function createContainerDevServer({
  backend,
  network,
  image,
  hostIp = '127.0.0.1',
  containerPort = DEFAULT_PREVIEW_CONTAINER_PORT,
  portRange = DEFAULT_PORT_RANGE,
  now = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  readyTimeoutMs = READY_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  probe = defaultProbe,
  sleep = defaultSleep,
  watchIntervalMs = DEFAULT_WATCH_INTERVAL_MS,
  limits,
  readOnlyMount = false,
  onExit,
  readPackageJson = defaultReadPackageJson,
  hasIndexHtml = defaultHasIndexHtml,
  workspacePath = WORKSPACE_MOUNT_PATH,
  urlFor = ({ hostIp: ip, hostPort }) => `http://${ip}:${hostPort}`,
} = {}) {
  const model = 'ContainerDevServer';
  if (!backend || typeof backend.startService !== 'function' || typeof backend.stopService !== 'function') {
    fail(model, 'backend with startService(...) and stopService(...) is required');
  }
  // FAIL CLOSED on the network: never guess a network for untrusted generated code.
  requireString(model, 'network', network);
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');
  if (typeof probe !== 'function') fail(model, 'probe must be a function');
  if (typeof sleep !== 'function') fail(model, 'sleep must be a function');
  if (
    !portRange ||
    !Number.isInteger(portRange.from) ||
    !Number.isInteger(portRange.to) ||
    portRange.from < 1 ||
    portRange.to > 65_535 ||
    portRange.from > portRange.to
  ) {
    fail(model, 'portRange must be { from, to } integers within 1..65535 with from <= to');
  }

  /** Per-project Dev_Server records, keyed by projectId. */
  const records = new Map();
  /** Host ports currently held by a record, so two previews never collide. */
  const heldPorts = new Set();
  /** Last stop promise per project, so callers/tests can await teardown. */
  const stops = new Map();
  /** The liveness watchdog interval, or null when not watching. */
  let watchTimer = null;

  /**
   * Claim the lowest free host port in the range. Synchronous BY DESIGN: `start`
   * must return the preview URL synchronously (see the module docstring), so we
   * cannot ask the OS for an ephemeral port (that is async). A port that is free
   * here but taken by an unrelated host process shows up as a launch failure with
   * the runtime's own message, not as a silent wrong URL.
   */
  function claimPort() {
    for (let port = portRange.from; port <= portRange.to; port += 1) {
      if (!heldPorts.has(port)) {
        heldPorts.add(port);
        return port;
      }
    }
    return null;
  }

  /**
   * Release the host port a record OWNS, exactly once.
   *
   * Ownership matters: releasing by bare value let a failed-then-stopped project
   * free a port a DIFFERENT project had since claimed, after which the next start
   * was handed a URL pointing at the other project's running preview. The
   * `portHeld` flag makes release idempotent per record, so no record can ever
   * free a port it no longer holds.
   */
  function releasePort(record) {
    if (record && record.portHeld === true) {
      heldPorts.delete(record.hostPort);
      record.portHeld = false;
    }
  }

  /** Is this record in a phase where a Dev_Server is expected to be up? */
  function isLive(record) {
    return !!record && (record.phase === 'starting' || record.phase === 'running');
  }

  /**
   * start({ projectId, sandbox, targetCategory }) — launch the Dev_Server for a
   * project inside its Isolation_Boundary and return the REAL preview URL.
   *
   * Synchronous by contract (PreviewController inspects the result immediately).
   * The container launch and readiness probe run asynchronously; await them with
   * whenReady(projectId).
   *
   * Idempotent: starting an already-live project returns the existing handle.
   *
   * @returns {{ ok:true, url:string, startedAt:string, hostPort:number, kind:string }
   *          | { ok:false, code:string, message:string }}
   */
  function start({ projectId, sandbox, targetCategory } = {}) {
    requireString(model, 'projectId', projectId);

    const existing = records.get(projectId);
    if (isLive(existing)) {
      return {
        ok: true,
        url: existing.url,
        startedAt: existing.startedAt,
        hostPort: existing.hostPort,
        kind: existing.kind,
      };
    }

    // The Dev_Server runs INSIDE the project's Isolation_Boundary, so we need the
    // boundary's bind-mount source. No sandbox handle means no boundary to run in
    // — refuse rather than launch something unconfined.
    const mountSource = typeof sandbox?.mountSource === 'string' ? sandbox.mountSource : null;
    if (!mountSource) {
      return {
        ok: false,
        code: 'SANDBOX_REQUIRED',
        message:
          `cannot start a Dev_Server for project ${projectId} without its Sandbox handle: ` +
          'a preview runs INSIDE the project Isolation_Boundary, and the boundary supplies ' +
          'the mount source. Acquire the Sandbox first.',
      };
    }

    // HOW to start it — a pure decision over the project's own manifest.
    let packageJson = null;
    let indexHtml = false;
    try {
      packageJson = readPackageJson(mountSource);
      indexHtml = hasIndexHtml(mountSource) === true;
    } catch {
      // An unreadable tree is not a crash: it just means no manifest was found,
      // and resolveDevCommand will refuse with a structured reason.
      packageJson = null;
      indexHtml = false;
    }
    const resolved = resolveDevCommand({
      packageJson,
      targetCategory,
      port: containerPort,
      hasIndexHtml: indexHtml,
      workspacePath,
    });
    if (resolved.ok !== true) return resolved;

    const hostPort = claimPort();
    if (hostPort === null) {
      return {
        ok: false,
        code: 'NO_PREVIEW_PORT',
        message: `no free preview host port in ${portRange.from}..${portRange.to}`,
      };
    }

    // The owner label ties this container to the project's boundary, so the
    // EXISTING teardown paths (SandboxManager.release, the owner-label reaper)
    // clean it up too. The handle carries that label value as containerName.
    const labelValue = typeof sandbox?.containerName === 'string' ? sandbox.containerName : `aab-sbx-${projectId}`;
    const containerName = `${labelValue}-preview-${crypto.randomBytes(4).toString('hex')}`;

    const record = {
      projectId,
      phase: 'starting',
      url: urlFor({ hostIp, hostPort, projectId }),
      startedAt: nowIso(),
      startedMs: now(),
      hostPort,
      portHeld: true,
      containerName,
      labelValue,
      containerId: null,
      kind: resolved.kind,
      script: resolved.script ?? null,
      command: resolved.command,
      targetCategory: targetCategory ?? null,
      error: null,
      logs: null,
      readyMs: null,
    };
    records.set(projectId, record);

    // Drive the launch + readiness probe asynchronously. The promise is retained
    // (whenReady) and can never reject: launch() converts every failure into a
    // structured result, and the .catch is a belt-and-braces guard so a bug here
    // can never surface as an unhandled rejection that kills the process.
    record.launch = launch(record, { mountSource, command: resolved.command, env: resolved.env, sandbox }).catch(
      (err) => markFailed(record, 'DEV_SERVER_START_FAILED', err?.message ?? String(err)),
    );

    // A live preview is worth watching: a dev server that dies AFTER it started
    // serving must not leave the surface claiming it is up.
    ensureWatching();

    return { ok: true, url: record.url, startedAt: record.startedAt, hostPort, kind: record.kind };
  }

  /**
   * The async half of start: launch the container, then poll the published URL
   * until it answers, the container dies, or the readiness bound elapses. Every
   * elapsed measurement uses the INJECTED clock.
   */
  async function launch(record, { mountSource, command, env, sandbox }) {
    // The preview container is the LONGEST-LIVED container running untrusted
    // generated code, so it must not be the one without resource limits: inherit
    // the boundary's requested limits unless explicitly overridden.
    const effectiveLimits = limits ?? sandbox?.limits;
    let started;
    try {
      started = await backend.startService({
        name: record.containerName,
        labelValue: record.labelValue,
        mountSource,
        workspacePath,
        command,
        env,
        network,
        publish: [{ hostIp, hostPort: record.hostPort, containerPort }],
        ...(effectiveLimits ? { limits: effectiveLimits } : {}),
        readOnlyMount,
        ...(image ? { image } : {}),
        timeoutMs: launchTimeoutMs,
      });
    } catch (err) {
      // A fail-closed refusal from the backend (unenforceable egress filtering, a
      // published port on a non-routable network) lands here. It is a
      // configuration error and must be reported as-is, not retried.
      return markFailed(record, 'PREVIEW_LAUNCH_REFUSED', err?.message ?? String(err));
    }

    if (started?.ok !== true) {
      return markFailed(
        record,
        'PREVIEW_LAUNCH_FAILED',
        started?.stderr?.trim() || `container runtime refused the Dev_Server launch (exit ${started?.code ?? 'n/a'})`,
      );
    }
    record.containerId = started.containerId ?? null;
    record.limitsApplied = started.limitsApplied === true;

    // Readiness. A hard iteration cap backs up the clock check so a mis-injected
    // non-advancing clock can never spin forever.
    const t0 = now();
    const maxPolls = Math.max(1, Math.ceil(readyTimeoutMs / Math.max(1, pollIntervalMs)) + 2);
    for (let poll = 0; poll < maxPolls; poll += 1) {
      // A concurrent stop() wins. Teardown is NOT done here: stop() chains its own
      // removal onto this promise precisely so the container is removed after it
      // exists, however the race lands.
      if (record.phase === 'stopped') return { ok: false, code: 'STOPPED', message: 'Dev_Server was stopped' };

      const answered = await probe(record.url);
      // Re-check after the await: a stop() during the probe must not be resurrected
      // into 'running' by a probe that then succeeded.
      if (record.phase === 'stopped') return { ok: false, code: 'STOPPED', message: 'Dev_Server was stopped' };
      if (answered) {
        record.phase = 'running';
        record.readyMs = now() - t0;
        return { ok: true, phase: 'running', url: record.url, readyMs: record.readyMs };
      }

      // The bound is checked BEFORE the liveness inspect so a slow inspect cannot
      // push the real elapsed time past the bound by a whole extra round trip.
      if (now() - t0 > readyTimeoutMs) break;

      // Did it die instead of coming up? Report that immediately, with its logs,
      // rather than waiting out the full bound.
      const status = await serviceStatusSafe(record.containerName);
      if (status.exists === true && status.running === false) {
        return markFailed(
          record,
          'DEV_SERVER_EXITED',
          `Dev_Server exited with code ${status.exitCode ?? 'unknown'} before serving the Preview`,
        );
      }

      await sleep(pollIntervalMs);
    }

    return markFailed(
      record,
      'PREVIEW_READY_TIMEOUT',
      `Dev_Server did not serve the Preview within ${readyTimeoutMs}ms`,
    );
  }

  /** backend.serviceStatus, never throwing (an absent runtime is "unknown"). */
  async function serviceStatusSafe(name) {
    if (typeof backend.serviceStatus !== 'function') return { ok: false, exists: false, running: false };
    try {
      return await backend.serviceStatus(name);
    } catch {
      return { ok: false, exists: false, running: false };
    }
  }

  /** backend.serviceLogs, never throwing. */
  async function serviceLogsSafe(name) {
    if (typeof backend.serviceLogs !== 'function') return '';
    try {
      const res = await backend.serviceLogs(name);
      return typeof res?.logs === 'string' ? res.logs : '';
    } catch {
      return '';
    }
  }

  /**
   * Record a failed Dev_Server: capture the reason AND the container's logs (what
   * makes the failure explainable), free the host port, remove the container so a
   * dead one is not left holding its name, and notify the caller so
   * PreviewController can preserve served state and offer a restart.
   */
  async function markFailed(record, code, message) {
    // A stop() that already ran owns the teardown; don't double-report.
    if (record.phase === 'stopped') return { ok: false, code: 'STOPPED', message: 'Dev_Server was stopped' };
    record.phase = 'failed';
    record.error = { code, message };
    const logs = await serviceLogsSafe(record.containerName);
    // Re-check AFTER the await: a stop() landing in that window owns the teardown,
    // and reporting an onExit for a deliberate stop would offer a bogus restart.
    if (record.phase === 'stopped') return { ok: false, code: 'STOPPED', message: 'Dev_Server was stopped' };
    record.logs = logs;
    releasePort(record);
    try {
      await backend.stopService(record.containerName);
    } catch {
      // Teardown is best effort; the owner-label reaper is the backstop.
    }
    if (typeof onExit === 'function') {
      try {
        onExit(record.projectId, { code, error: message, logs: record.logs, url: record.url });
      } catch {
        // A misbehaving observer must not turn into a Dev_Server failure.
      }
    }
    return { ok: false, code, message, logs: record.logs };
  }

  /**
   * stop(projectId) — tear down the project's Dev_Server. Idempotent: stopping a
   * project that was never started is success.
   *
   * Synchronous by contract (the seam's shape). The container removal runs
   * asynchronously; await it with whenStopped(projectId).
   */
  function stop(projectId) {
    requireString(model, 'projectId', projectId);
    const record = records.get(projectId);
    if (!record) return { ok: true, stopped: false };

    const wasLive = isLive(record);
    record.phase = 'stopped';
    records.delete(projectId);

    /**
     * Removal is chained onto the IN-FLIGHT LAUNCH, not fired immediately.
     *
     * Firing it immediately loses the race: a `rm -f` issued before the container
     * exists reports "no such container", then `run -d` creates it — leaving a
     * live, port-publishing container running untrusted code while the port pool
     * believed the port was free. Waiting for the launch to settle means the
     * container exists (or definitively does not) before we remove it.
     *
     * The port is held until removal completes, for the same reason: handing it to
     * another project while the old container may still publish it is how two
     * projects end up on one URL.
     */
    const teardown = Promise.resolve(record.launch)
      .catch(() => undefined)
      .then(() => backend.stopService(record.containerName))
      .catch(() => ({ ok: false, stopped: false }))
      .then((res) => {
        releasePort(record);
        return res;
      });
    stops.set(projectId, teardown);
    if (records.size === 0) stopWatching();
    return { ok: true, stopped: wasLive };
  }

  /** Introspection: is a Dev_Server starting or running for this project? */
  function isRunning(projectId) {
    requireString(model, 'projectId', projectId);
    return isLive(records.get(projectId));
  }

  /**
   * status(projectId) — the current Dev_Server phase and diagnostics. `phase` is
   * one of 'none' | 'starting' | 'running' | 'failed'.
   */
  function status(projectId) {
    requireString(model, 'projectId', projectId);
    const record = records.get(projectId);
    if (!record) return { phase: 'none', url: null, error: null };
    return {
      phase: record.phase,
      url: record.url,
      startedAt: record.startedAt,
      hostPort: record.hostPort,
      containerName: record.containerName,
      containerId: record.containerId,
      kind: record.kind,
      script: record.script,
      command: [...record.command],
      readyMs: record.readyMs,
      error: record.error,
      logs: record.logs,
    };
  }

  /**
   * whenReady(projectId) — await the asynchronous launch + readiness result for a
   * started project. Resolves (never rejects) with { ok:true, phase:'running', ... }
   * or a structured failure. A project that was never started resolves NOT_STARTED.
   */
  function whenReady(projectId) {
    requireString(model, 'projectId', projectId);
    const record = records.get(projectId);
    if (!record?.launch) {
      return Promise.resolve({ ok: false, code: 'NOT_STARTED', message: `no Dev_Server start for project ${projectId}` });
    }
    return record.launch;
  }

  /** whenStopped(projectId) — await the asynchronous teardown from stop(). */
  function whenStopped(projectId) {
    requireString(model, 'projectId', projectId);
    return stops.get(projectId) ?? Promise.resolve({ ok: true, stopped: false });
  }

  /**
   * checkLiveness(projectId) — verify a RUNNING Dev_Server is still alive, and if
   * it has died, fail it exactly as a startup failure would (logs captured, port
   * released, container removed, onExit fired so PreviewController can retain the
   * served snapshot and offer a restart).
   *
   * WHY THIS EXISTS: readiness polling ends the moment the probe succeeds, so
   * without this nothing ever looked at the container again — a dev server that
   * OOMed an hour later left the surface reporting a URL that no longer answered,
   * with its port still held. Req 3.6 has to cover "died later", which is the
   * common case for a generated app, not just "never came up".
   *
   * Exposed so a caller (and the tests) can drive it deterministically instead of
   * waiting for the interval.
   */
  async function checkLiveness(projectId) {
    requireString(model, 'projectId', projectId);
    const record = records.get(projectId);
    if (!record || record.phase !== 'running') {
      return { phase: record?.phase ?? 'none', alive: null };
    }
    const status = await serviceStatusSafe(record.containerName);
    if (status.exists === true && status.running === false) {
      await markFailed(
        record,
        'DEV_SERVER_EXITED',
        `Dev_Server exited with code ${status.exitCode ?? 'unknown'} after the Preview was serving`,
      );
      return { phase: 'failed', alive: false };
    }
    return { phase: record.phase, alive: true };
  }

  /** Sweep every live record once. Used by the watchdog interval. */
  async function checkAllLiveness() {
    for (const projectId of [...records.keys()]) {
      await checkLiveness(projectId);
    }
  }

  /**
   * Start the liveness watchdog if one is configured and not already running. The
   * timer is UNREF'd so it can never hold the process open, and the whole thing is
   * disabled with watchIntervalMs <= 0 (which is what the tests do, driving
   * checkLiveness directly so nothing depends on real time).
   */
  function ensureWatching() {
    if (!(watchIntervalMs > 0) || watchTimer !== null) return;
    watchTimer = setInterval(() => {
      void checkAllLiveness().catch(() => {});
    }, watchIntervalMs);
    watchTimer.unref?.();
  }

  /** Stop the watchdog (also called automatically when nothing is left to watch). */
  function stopWatching() {
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  /** The host ports currently held by live/starting previews (introspection). */
  function heldHostPorts() {
    return [...heldPorts].sort((a, b) => a - b);
  }

  return Object.freeze({
    start,
    stop,
    isRunning,
    status,
    whenReady,
    whenStopped,
    checkLiveness,
    stopWatching,
    heldHostPorts,
    network,
    containerPort,
    hostIp,
    readyTimeoutMs,
  });
}
