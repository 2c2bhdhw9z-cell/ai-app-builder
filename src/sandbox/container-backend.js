/**
 * THE CONTAINER BACKEND (spec subtask 5.1 / 5.2, Req 8.1–8.6).
 *
 * A thin abstraction over the OS-level container runtime. The SandboxManager
 * talks ONLY to this interface (create/run/remove/inspect), so the concrete
 * backend can later be swapped from a Docker/OCI CLI (Podman here) to
 * gVisor/Firecracker WITHOUT changing the manager or its acquire/exec/release
 * contract. Everything runtime-specific — the exact `docker run` flags, cgroup
 * handling, orphan reaping — lives behind this seam.
 *
 * THE ISOLATION this backend requests for every per-project container:
 *   (a) its OWN container root filesystem (the image root; nothing of the host);
 *   (b) ONLY that project's exportable tree bind-mounted at a fixed workspace
 *       path (source path supplied by the manager from layout.exportableProjectTree);
 *   (c) a PRIVATE PID namespace (default for a fresh container — the container
 *       sees only its own processes);
 *   (d) a PRIVATE network namespace whose egress is governed by the allowlist
 *       (v1: `--network none` when the allowlist is empty — total deny — the
 *       honest containment we can actually enforce in this sandbox; a future
 *       host with a filtering network can widen this to the allowed hosts);
 *   (e) a REQUEST to apply cgroup CPU/memory/pids limits.
 *
 * CRITICAL ENVIRONMENT CAVEAT (verified in this sandbox): cgroup resource-limit
 * flags (--memory / --cpus / --pids-limit) FAIL TO LAUNCH a container here
 * because nested cgroup delegation is unavailable ('conmon cgroupfs ... threaded
 * mode' / crun cannot open memory.max). So limit application is CONFIGURABLE and
 * DEGRADES GRACEFULLY: the backend attempts a run WITH the requested cgroup
 * flags, and if the runtime rejects them with a recognizable cgroup error it
 * retries WITHOUT them and reports `limitsApplied: false`. The manager still
 * requests limits through config; on a host with working cgroup delegation the
 * same code applies them and reports `limitsApplied: true`. We NEVER claim
 * limits are enforced when they were skipped.
 *
 * EXEC MODEL (v1): one-shot `docker run --rm ...` per command (avoids the
 * sandbox's long-running/detached-container heuristic). The interface is kept
 * open to a warm-container `docker exec` optimization later. Wall-clock
 * execution-time limits are enforced IN-PROCESS (a timeout that kills+reaps the
 * child) regardless of cgroup support — see runOneShot's `timeoutMs`.
 */

import { execFile } from 'node:child_process';

/** The fixed in-container path a project's tree is always mounted at. */
export const WORKSPACE_MOUNT_PATH = '/workspace';

/** Default container image (matches plumby's Dockerfile base — Node 22). */
export const DEFAULT_IMAGE = 'node:22-slim';

/** Label key used to tag every container we own, for orphan reaping. */
export const OWNER_LABEL = 'aab.sandbox';

/**
 * A cgroup-rejection error looks like one of these in Podman/crun/conmon when
 * nested delegation is unavailable. Used to decide whether to retry WITHOUT
 * limits (graceful degrade) vs. surface a real failure.
 */
const CGROUP_ERROR_PATTERNS = [
  /cgroup/i,
  /memory\.max/i,
  /pids\.max/i,
  /cpu\.max/i,
  /conmon/i,
  /threaded mode/i,
  /delegat/i,
];

function looksLikeCgroupRejection(text) {
  const s = String(text ?? '');
  return CGROUP_ERROR_PATTERNS.some((re) => re.test(s));
}

/**
 * Run the runtime CLI once, capturing stdout/stderr/exit. Enforces a wall-clock
 * timeout in-process: on timeout the child (and thus a `docker run --rm`) is
 * killed, which reaps the one-shot container. Never rejects for a non-zero exit
 * — it resolves a result object so callers can branch on `code`.
 *
 * @param {string} bin      runtime binary (e.g. 'docker')
 * @param {string[]} args   CLI args
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  wall-clock kill timeout
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ code:number|null, stdout:string, stderr:string, timedOut:boolean, signal:string|null }>}
 */
function runCli(bin, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined,
        killSignal: 'SIGKILL',
        signal,
      },
      (error, stdout, stderr) => {
        const timedOut = !!error && error.killed === true && error.signal === 'SIGKILL';
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut,
          signal: error?.signal ?? null,
        });
      },
    );
    // Guard against the (unlikely) spawn error path.
    child.on('error', (err) => {
      resolve({ code: 127, stdout: '', stderr: String(err?.message ?? err), timedOut: false, signal: null });
    });
  });
}

/**
 * Translate a requested-limits object into cgroup CLI flags. Only defined
 * limits produce flags, so an empty/absent config yields no flags at all.
 *
 * @param {object} [limits] { memoryMb, cpus, pids }
 * @returns {string[]}
 */
export function cgroupFlagsFor(limits = {}) {
  const flags = [];
  if (limits && typeof limits.memoryMb === 'number' && limits.memoryMb > 0) {
    flags.push('--memory', `${Math.floor(limits.memoryMb)}m`);
  }
  if (limits && typeof limits.cpus === 'number' && limits.cpus > 0) {
    flags.push('--cpus', String(limits.cpus));
  }
  if (limits && typeof limits.pids === 'number' && limits.pids > 0) {
    flags.push('--pids-limit', String(Math.floor(limits.pids)));
  }
  return flags;
}

/**
 * Build the `docker run` argument vector for a one-shot command.
 *
 * @param {object} spec
 * @returns {string[]}
 */
export function buildRunArgs(spec) {
  const {
    image = DEFAULT_IMAGE,
    name,
    mountSource,
    workspacePath = WORKSPACE_MOUNT_PATH,
    readOnlyMount = false,
    network = 'none',
    cgroupFlags = [],
    command = [],
    labelValue,
  } = spec;

  const args = ['run', '--rm'];
  // (c) Private PID namespace is the default for a fresh container; being
  // explicit documents the intent and guards against a changed runtime default.
  args.push('--pid', 'private');
  // (d) Private network namespace; egress governed by the allowlist. v1 maps an
  // empty allowlist to total deny via `--network none`.
  args.push('--network', network);
  // Never gain privileges beyond the image; drop the ambient set.
  args.push('--security-opt', 'no-new-privileges');
  if (name) args.push('--name', name);
  if (labelValue) args.push('--label', `${OWNER_LABEL}=${labelValue}`);
  // (b) ONLY this project's tree, mounted at the fixed workspace path.
  if (mountSource) {
    const mode = readOnlyMount ? ':ro' : '';
    args.push('-v', `${mountSource}:${workspacePath}${mode}`);
    args.push('-w', workspacePath);
  }
  // (e) Requested cgroup limits (may be dropped on the graceful-degrade retry).
  args.push(...cgroupFlags);
  args.push(image);
  args.push(...command);
  return args;
}

/**
 * Standalone capability probe: can a real container be LAUNCHED in the current
 * environment? (subtask 5.2). Tests gate live-container assertions behind this
 * so the suite stays green everywhere: where a runtime can actually run a
 * throwaway container it returns true (as in this sandbox), and where it cannot
 * (no runtime, no permission, CI without a daemon) it returns false and the
 * live assertions are skipped cleanly via t.skip.
 *
 * This is stronger than a mere `version` check: it performs a one-shot
 * `docker run --rm <image> true` so a present-but-unusable runtime is reported
 * as unavailable. Never throws — a failure to launch is simply `false`.
 *
 * @param {object} [opts]
 * @param {string} [opts.bin]      runtime binary (default 'docker')
 * @param {string} [opts.image]    tiny image to smoke-launch (default 'alpine:latest')
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.exec]   injectable CLI runner (tests)
 * @returns {Promise<boolean>}
 */
export async function containerRuntimeAvailable({
  bin = 'docker',
  image = 'alpine:latest',
  timeoutMs = 60_000,
  exec = runCli,
} = {}) {
  try {
    const res = await exec(bin, ['run', '--rm', image, 'true'], { timeoutMs });
    return res.code === 0 && res.timedOut !== true;
  } catch {
    return false;
  }
}

/**
 * Create a container backend bound to a runtime CLI binary.
 *
 * @param {object} [opts]
 * @param {string} [opts.bin]      runtime binary (default 'docker' — Podman-compatible)
 * @param {string} [opts.image]    default image for one-shot runs
 * @param {(bin:string,args:string[],o?:object)=>Promise<object>} [opts.exec]  injectable CLI runner (tests)
 * @returns {object} backend
 */
export function createContainerBackend({ bin = 'docker', image = DEFAULT_IMAGE, exec = runCli } = {}) {
  /**
   * Detect whether the runtime is usable at all (binary present + `version`
   * succeeds). Cached-free; callers gate live-container work behind it.
   */
  async function isAvailable() {
    const res = await exec(bin, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
    if (res.code === 0) return true;
    // `docker version` may print client info and still exit non-zero without a
    // server; fall back to a plain `--version` which only needs the client.
    const res2 = await exec(bin, ['--version'], { timeoutMs: 10_000 });
    return res2.code === 0;
  }

  /**
   * Run a single command one-shot in a fresh, isolated container. Applies the
   * requested cgroup limits, degrading gracefully if the runtime rejects them.
   *
   * @param {object} run
   * @param {string} run.name              container name (also the reap label value)
   * @param {string} run.mountSource       host path to bind-mount (this project's tree ONLY)
   * @param {string[]} run.command         command vector to run in the container
   * @param {object} [run.limits]          { memoryMb, cpus, pids }
   * @param {string} [run.network]         network mode (default 'none')
   * @param {boolean} [run.readOnlyMount]
   * @param {number} [run.timeoutMs]       in-process wall-clock kill timeout
   * @param {AbortSignal} [run.signal]
   * @returns {Promise<{ code, stdout, stderr, timedOut, limitsApplied, limitsSupported, degraded }>}
   */
  async function runOneShot({
    name,
    mountSource,
    command = [],
    limits = {},
    network = 'none',
    readOnlyMount = false,
    timeoutMs,
    signal,
  }) {
    const cgroupFlags = cgroupFlagsFor(limits);
    const requestedLimits = cgroupFlags.length > 0;

    const baseSpec = {
      image,
      name,
      mountSource,
      network,
      readOnlyMount,
      labelValue: name,
      command,
    };

    // First attempt: WITH the requested cgroup flags (if any).
    let res = await exec(bin, buildRunArgs({ ...baseSpec, cgroupFlags }), { timeoutMs, signal });

    // Graceful degrade: if the ONLY reason we failed to launch is that the
    // runtime rejected the cgroup flags, retry WITHOUT them and flag that limits
    // were requested-but-not-applied. We never silently pretend they applied.
    let limitsApplied = requestedLimits;
    let limitsSupported = requestedLimits;
    let degraded = false;
    if (requestedLimits && res.code !== 0 && !res.timedOut && looksLikeCgroupRejection(res.stderr)) {
      degraded = true;
      limitsApplied = false;
      limitsSupported = false;
      res = await exec(bin, buildRunArgs({ ...baseSpec, cgroupFlags: [] }), { timeoutMs, signal });
    }

    return {
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: res.timedOut,
      signal: res.signal,
      // limitsApplied is only meaningful when we requested limits at all.
      limitsApplied: requestedLimits ? limitsApplied : false,
      limitsSupported: requestedLimits ? limitsSupported : true,
      requestedLimits,
      degraded,
    };
  }

  /**
   * Force-remove a container by name. Idempotent: removing a non-existent
   * container is treated as success (the resource is already gone).
   */
  async function remove(name) {
    if (!name) return { removed: false };
    const res = await exec(bin, ['rm', '-f', name], { timeoutMs: 15_000 });
    // `rm -f` of a missing container exits non-zero with "no such container";
    // that is the desired end state, so report success.
    const gone = res.code === 0 || /no such container|not found|no container/i.test(res.stderr);
    return { removed: gone, code: res.code, stderr: res.stderr };
  }

  /**
   * Reap orphaned containers we own (labelled OWNER_LABEL). Optionally scoped to
   * a single label value (one project). Used for orphan cleanup after a failed
   * import/acquire (Req 6.5) and by release().
   */
  async function reapOrphans(labelValue) {
    const filter = labelValue ? `${OWNER_LABEL}=${labelValue}` : OWNER_LABEL;
    const list = await exec(bin, ['ps', '-a', '-q', '--filter', `label=${filter}`], { timeoutMs: 15_000 });
    if (list.code !== 0) return { reaped: [], code: list.code, stderr: list.stderr };
    const ids = list.stdout.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const reaped = [];
    for (const id of ids) {
      const res = await exec(bin, ['rm', '-f', id], { timeoutMs: 15_000 });
      if (res.code === 0 || /no such container|not found/i.test(res.stderr)) reaped.push(id);
    }
    return { reaped };
  }

  /**
   * Instance-scoped runtime probe: can this backend actually LAUNCH a
   * container? Delegates to the module-level containerRuntimeAvailable() using
   * this backend's bin/exec, so tests that inject a fake `exec` can drive it.
   */
  async function canLaunch({ image: probeImage = 'alpine:latest', timeoutMs = 60_000 } = {}) {
    return containerRuntimeAvailable({ bin, image: probeImage, timeoutMs, exec });
  }

  return Object.freeze({
    bin,
    image,
    isAvailable,
    canLaunch,
    runOneShot,
    remove,
    reapOrphans,
    // Exposed for tests / introspection.
    buildRunArgs,
    cgroupFlagsFor,
  });
}
