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

/**
 * Network policy sentinels the manager hands the backend.
 *
 *   NETWORK_DENY_ALL   ('none')     — total egress deny. A REAL Docker/Podman
 *                                      mode; genuinely enforced + live-tested.
 *   NETWORK_FILTERED   ('filtered') — deny-by-default egress LIMITED to an
 *                                      allowlist of hosts. This requires a
 *                                      backend that can install per-host
 *                                      firewall rules. A plain docker/OCI CLI
 *                                      backend CANNOT do this, so it must
 *                                      FAIL CLOSED (see runOneShot) rather than
 *                                      silently attach unfiltered networking.
 *
 * We deliberately do NOT use '--network private': it is NOT a filtering mode.
 * Verified empirically under this rootful Podman 5.2.3, `docker run --network
 * private` launches successfully (exit 0) and the container gets FULL default
 * egress (fetched http://example.com through it) — i.e. it FAILS OPEN, quietly
 * violating deny-by-default for exactly the projects that have connectors. So a
 * populated allowlist is mapped to NETWORK_FILTERED, which this CLI backend does
 * not support and therefore refuses honestly instead of faking enforcement.
 */
export const NETWORK_DENY_ALL = 'none';
export const NETWORK_FILTERED = 'filtered';

/**
 * The set of network modes a plain docker/OCI CLI backend can HONESTLY enforce.
 * 'none' (total deny) is enforceable and live-tested. Per-host egress filtering
 * ('filtered') is NOT — a future CNI/firewall-capable backend can add it and
 * advertise support via `supportsEgressFiltering`.
 */
const CLI_ENFORCEABLE_NETWORKS = Object.freeze(['none']);

/**
 * Message used when a published port is requested on a network mode that cannot
 * carry inbound traffic.
 *
 * WHY THIS IS AN ERROR AND NOT A WARNING. A published port is only reachable if
 * three things line up: a runtime NAT/DNAT rule (`-p`), a route from the host to
 * the container (a veth pair on a bridge), and a listener inside the container.
 * `--network none` gives the container ONLY a loopback interface — there is no
 * veth and no container IP, so the DNAT rule has no target and the published
 * port serves nothing. Accepting the combination would hand a caller a preview
 * URL that can never answer, which is precisely the dishonesty the Dev_Server
 * seam was faulted for. So we refuse the launch and say why.
 */
export const PUBLISH_REQUIRES_ROUTABLE_NETWORK =
  'published ports require a routable network: `--network none` gives the container ' +
  'only a loopback interface (no veth, no container IP), so a published port has no ' +
  'DNAT target and can never be reached. Launching would yield a preview URL that ' +
  'serves nothing, so the request is DENIED. Configure a concrete container network ' +
  'that permits inbound traffic for the preview container (see AAB_PREVIEW_NETWORK).';

/** Message used when a populated egress allowlist cannot be enforced. */
export const EGRESS_FILTERING_UNSUPPORTED =
  'egress filtering not supported by this backend: a populated egress allowlist ' +
  'requires per-host firewall rules this container backend cannot install, so the ' +
  'command is DENIED rather than run with unfiltered network access (fail-closed). ' +
  "Only an empty allowlist ('--network none', total deny) is enforceable here.";

/** Default container image (matches plumby's Dockerfile base — Node 22). */
export const DEFAULT_IMAGE = 'node:22-slim';

/** Label key used to tag every container we own, for orphan reaping. */
export const OWNER_LABEL = 'aab.sandbox';

/**
 * The ONLY runtime verbs `rawExec` will run: read-only inspection and network
 * plumbing. Deliberately an allowlist — see rawExec.
 */
export const RAW_EXEC_VERBS = Object.freeze(['network', 'inspect', 'ps', 'version']);

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
 * @param {Object<string,string>} [opts.childEnv]  env for the CHILD process; the
 *        runtime reads name-only `-e NAME` references from here so secret VALUES
 *        travel through the child environment, NOT the logged argv. Merged over
 *        process.env.
 * @returns {Promise<{ code:number|null, stdout:string, stderr:string, timedOut:boolean, signal:string|null }>}
 */
function runCli(bin, args, { timeoutMs, signal, childEnv } = {}) {
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
        // Secret values are injected here (merged over process.env) so the
        // runtime's `-e NAME` references resolve WITHOUT the value ever
        // appearing in `args` (the logged command line).
        env: childEnv ? { ...process.env, ...childEnv } : undefined,
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
 * Validate + render one port-publish spec into a `-p` value.
 *
 * Ports are rendered into the runtime argv, so they are validated as integers in
 * the legal TCP range and the host IP is restricted to a literal address. This is
 * belt-and-braces (we never interpolate through a shell — execFile takes an argv
 * vector) but it keeps a malformed/hostile port from ever reaching the CLI.
 *
 * @param {{hostIp?:string, hostPort:number, containerPort:number}} spec
 * @returns {string} e.g. '127.0.0.1:43001:5173'
 */
export function renderPublishSpec(spec) {
  const { hostIp = '127.0.0.1', hostPort, containerPort } = spec ?? {};
  for (const [field, value] of [['hostPort', hostPort], ['containerPort', containerPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new TypeError(`publish.${field} must be an integer in 1..65535, got ${JSON.stringify(value)}`);
    }
  }
  // A literal IPv4 address or a bracketed IPv6 literal only — never a hostname,
  // which the runtime would resolve at launch time.
  if (typeof hostIp !== 'string' || !/^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\])$/.test(hostIp)) {
    throw new TypeError(`publish.hostIp must be a literal IP address, got ${JSON.stringify(hostIp)}`);
  }
  return `${hostIp}:${hostPort}:${containerPort}`;
}

/**
 * Build the `docker run` argument vector for a one-shot command, or — with
 * `detach` — for a LONG-RUNNING service container (the Dev_Server preview).
 *
 * The one-shot defaults are unchanged: `detach:false`, `autoRemove:true`, no
 * published ports produces exactly the argv this builder always produced. The
 * service flags are additive so BOTH shapes share one definition of the
 * isolation flags (`--pid private`, `--network`, `--security-opt`, the mount and
 * the label) — a preview container must not be able to drift into weaker
 * isolation than an exec container.
 *
 * SECRET ENV INJECTION (spec subtask 7.1): when `env` is a { NAME: value } map,
 * we emit NAME-ONLY `-e NAME` references — NEVER `-e NAME=value` — so the secret
 * VALUE does not appear in the argv (the logged command line). The runtime reads
 * the value from the CHILD process environment (see runOneShot's childEnv, passed
 * to execFile's `env` option), which is where the actual values travel. Podman /
 * Docker both support `-e NAME` (no `=`): the variable is copied from the CLI
 * process environment into the container. This keeps values out of argv AND out
 * of the mounted project tree.
 *
 * @param {object} spec
 * @param {Object<string,string>} [spec.env]  { NAME: value } secret env map
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
    labels,
    env,
    detach = false,
    autoRemove = true,
    publish = [],
  } = spec;

  const args = ['run'];
  // A one-shot run self-cleans. A DETACHED service deliberately does NOT: we keep
  // the exited container so `logs`/`inspect` can explain WHY a dev server died,
  // and remove it explicitly on stop (and via the owner-label reaper).
  if (autoRemove) args.push('--rm');
  if (detach) args.push('-d');
  // (c) Private PID namespace is the default for a fresh container; being
  // explicit documents the intent and guards against a changed runtime default.
  args.push('--pid', 'private');
  // (d) Private network namespace; egress governed by the allowlist. v1 maps an
  // empty allowlist to total deny via `--network none`.
  args.push('--network', network);
  // Never gain privileges beyond the image; drop the ambient set.
  args.push('--security-opt', 'no-new-privileges');
  // Inbound port publishing (the Dev_Server preview). Bound to an explicit host
  // IP — defaulting to loopback — so a preview is never published on every host
  // interface by accident.
  for (const one of Array.isArray(publish) ? publish : []) {
    args.push('-p', renderPublishSpec(one));
  }
  if (name) args.push('--name', name);
  if (labelValue) args.push('--label', `${OWNER_LABEL}=${labelValue}`);
  // Extra labels, sorted for a deterministic argv. Used to record policy a running
  // container was started with (e.g. the egress allowlist fingerprint) so it can be
  // compared before the container is adopted rather than trusted on its name.
  if (labels && typeof labels === 'object') {
    for (const key of Object.keys(labels).sort()) {
      args.push('--label', `${key}=${labels[key]}`);
    }
  }
  // (b) ONLY this project's tree, mounted at the fixed workspace path.
  if (mountSource) {
    const mode = readOnlyMount ? ':ro' : '';
    args.push('-v', `${mountSource}:${workspacePath}${mode}`);
    args.push('-w', workspacePath);
  }
  // Secret env injection: name-only references. The VALUE is supplied to the
  // child process environment (execFile `env`), never embedded here.
  if (env && typeof env === 'object') {
    for (const envName of Object.keys(env).sort()) {
      args.push('-e', envName);
    }
  }
  // (e) Requested cgroup limits (may be dropped on the graceful-degrade retry).
  args.push(...cgroupFlags);
  args.push(image);
  args.push(...command);
  return args;
}

/**
 * Build the `docker run` argv for a LONG-RUNNING service container: detached,
 * NOT auto-removed (so a crash leaves logs to read), otherwise carrying exactly
 * the same isolation flags as a one-shot run.
 *
 * @param {object} spec  same shape as buildRunArgs, plus `publish`
 * @returns {string[]}
 */
export function buildServiceArgs(spec) {
  return buildRunArgs({ ...spec, detach: true, autoRemove: false });
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
export function createContainerBackend({
  bin = 'docker',
  image = DEFAULT_IMAGE,
  exec = runCli,
  permittedNetworks = CLI_ENFORCEABLE_NETWORKS,
  isNetworkPermitted,
} = {}) {
  // The set of network modes THIS instance will launch into. Defaults to the
  // CLI-enforceable set ('none' only), so a plain backend keeps failing closed on
  // everything else. A filtering-capable composition (see
  // filtering-container-backend.js) permits exactly its OWN internal network name
  // here — never a general-purpose network, and never the 'filtered' SENTINEL,
  // which stays refused below because no plain CLI backend can honor it.
  const permitted = Object.freeze([...permittedNetworks]);
  if (permitted.includes(NETWORK_FILTERED)) {
    throw new TypeError(
      'createContainerBackend: the FILTERED sentinel cannot be a permitted network — ' +
        'it names a capability, not a network. Permit the concrete network that implements it.',
    );
  }
  // A composition that creates networks DYNAMICALLY (one per project) cannot list
  // them up front, so it supplies a predicate over the set it actually created.
  // The predicate still cannot admit the sentinel.
  if (isNetworkPermitted !== undefined && typeof isNetworkPermitted !== 'function') {
    throw new TypeError('createContainerBackend: isNetworkPermitted must be a function');
  }
  const networkAllowed = (network) =>
    network !== NETWORK_FILTERED &&
    (typeof isNetworkPermitted === 'function' ? isNetworkPermitted(network) === true : permitted.includes(network));
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
   * @param {Object<string,string>} [run.env]  { NAME: value } secret env map. The
   *        NAMES are emitted as name-only `-e NAME` references (values stay out of
   *        argv) and the VALUES are passed to the child process env so the runtime
   *        resolves them. Values never touch the mounted project tree.
   * @param {number} [run.timeoutMs]       in-process wall-clock kill timeout
   * @param {AbortSignal} [run.signal]
   * @returns {Promise<{ code, stdout, stderr, timedOut, limitsApplied, limitsSupported, degraded }>}
   */
  async function runOneShot({
    name,
    labelValue,
    mountSource,
    command = [],
    limits = {},
    network = 'none',
    readOnlyMount = false,
    env,
    timeoutMs,
    signal,
  }) {
    // FAIL CLOSED for any network mode this backend cannot honestly enforce.
    // A populated egress allowlist arrives as NETWORK_FILTERED; a plain CLI
    // backend cannot install per-host firewall rules, so it must NOT launch a
    // container with unfiltered networking (that would fail open and break the
    // deny-by-default promise). We refuse the launch with an explicit reason —
    // never emit an unusable/ambiguous `--network <sentinel>` flag to docker.
    if (!networkAllowed(network)) {
      throw new Error(EGRESS_FILTERING_UNSUPPORTED);
    }

    const cgroupFlags = cgroupFlagsFor(limits);
    const requestedLimits = cgroupFlags.length > 0;

    // Secret env injection: the NAMES become name-only `-e NAME` references in
    // argv, and the VALUES are handed to the child process environment so the
    // runtime resolves each reference WITHOUT the value appearing on the command
    // line. `childEnv` is undefined when there are no secrets (no-op).
    const hasEnv = env && typeof env === 'object' && Object.keys(env).length > 0;
    const childEnv = hasEnv ? { ...env } : undefined;

    const baseSpec = {
      image,
      name,
      mountSource,
      network,
      readOnlyMount,
      // HONOR THE CALLER'S LABEL VALUE. The SandboxManager passes the STABLE
      // per-project label (`aab-sbx-<projectId>`) while `name` is a per-run unique
      // name. Labelling with `name` meant every one-shot container carried a label
      // value nothing could predict, so `reapOrphans(labelValueFor(projectId))` —
      // the per-project orphan cleanup release() performs — matched NOTHING. It
      // falls back to `name` only when no label value was supplied.
      labelValue: labelValue ?? name,
      command,
      env: hasEnv ? env : undefined,
    };

    // First attempt: WITH the requested cgroup flags (if any).
    let res = await exec(bin, buildRunArgs({ ...baseSpec, cgroupFlags }), { timeoutMs, signal, childEnv });

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
      res = await exec(bin, buildRunArgs({ ...baseSpec, cgroupFlags: [] }), { timeoutMs, signal, childEnv });
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
   * Run an arbitrary runtime CLI command through this backend's injected runner.
   *
   * The narrow, explicit escape hatch for runtime plumbing that is NOT a container
   * launch — `network create`, `network connect` — used by the filtering backend to
   * build its enforcement plane. It deliberately does NOT accept a container `run`:
   * every launch must go through runOneShot/startService so the isolation flags and
   * the fail-closed network checks cannot be bypassed.
   *
   * @param {string[]} args
   * @returns {Promise<{code, stdout, stderr, timedOut, signal}>}
   */
  async function rawExec(args, { timeoutMs = 30_000, signal } = {}) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new TypeError('rawExec: args must be a non-empty array');
    }
    // AN ALLOWLIST, NOT A DENYLIST. Denying `run`/`create`/`exec` looked sufficient
    // and was not: docker's management form (`container run ...`) sails past it, as
    // do `start` and `cp` (which is arbitrary host-filesystem access as the daemon
    // user). Since this is on the backend's PUBLIC surface, the guard has to mean
    // what it says, so only read-only/plumbing verbs are permitted and every
    // container launch must go through runOneShot/startService where the isolation
    // flags and the fail-closed network checks are applied.
    if (!RAW_EXEC_VERBS.includes(args[0])) {
      throw new TypeError(
        `rawExec refuses '${args[0]}': only [${RAW_EXEC_VERBS.join(', ')}] are permitted. ` +
          'Container launches must go through runOneShot/startService so the isolation flags ' +
          'and the fail-closed network checks cannot be bypassed.',
      );
    }
    return exec(bin, args, { timeoutMs, signal });
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
   * Start a LONG-RUNNING service container (the Dev_Server behind a Preview) and
   * return as soon as the runtime has accepted it — the process keeps running
   * inside the container after this resolves.
   *
   * This is the capability the Dev_Server seam was missing: `runOneShot` awaits
   * completion, so a dev server started through it would block forever (and, being
   * serialized per project by the manager's mutex, would deadlock every other
   * command for that project). A service is detached instead, and its readiness is
   * established by the CALLER probing the published URL.
   *
   * FAIL-CLOSED, twice:
   *   - a network mode this backend cannot honestly enforce (NETWORK_FILTERED) is
   *     refused, exactly as in runOneShot;
   *   - a published port on a non-routable network (`none`) is refused, because it
   *     would produce a preview URL that can never answer.
   *
   * @param {object} svc
   * @param {string} svc.name             container name (used for stop/inspect/logs)
   * @param {string} [svc.labelValue]     owner-label value (defaults to name) so the
   *        existing label reaper and per-project release() tear this container down
   * @param {string} svc.mountSource      host path to bind-mount (this project's tree ONLY)
   * @param {string[]} svc.command        command vector to run in the container
   * @param {Array<{hostIp?:string,hostPort:number,containerPort:number}>} [svc.publish]
   * @param {string} [svc.network]        concrete container network (NOT 'none' when publishing)
   * @param {object} [svc.limits]         { memoryMb, cpus, pids }
   * @param {Object<string,string>} [svc.env]  name-only `-e NAME` refs; values via child env
   * @param {number} [svc.timeoutMs]      wall-clock limit for the LAUNCH call itself
   * @returns {Promise<{ ok:boolean, containerId:string|null, code, stdout, stderr, timedOut,
   *                     limitsApplied:boolean, degraded:boolean }>}
   */
  async function startService({
    name,
    labelValue,
    labels,
    mountSource,
    workspacePath = WORKSPACE_MOUNT_PATH,
    command = [],
    publish = [],
    limits = {},
    network = NETWORK_DENY_ALL,
    readOnlyMount = false,
    env,
    image: serviceImage = image,
    timeoutMs = 60_000,
    signal,
  } = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('startService: name must be a non-empty string');
    }
    // Same fail-closed rule as runOneShot: never fake egress enforcement.
    if (network === NETWORK_FILTERED) {
      throw new Error(EGRESS_FILTERING_UNSUPPORTED);
    }
    const publishList = Array.isArray(publish) ? publish : [];
    // Never hand back a preview URL that physically cannot answer.
    if (publishList.length > 0 && network === NETWORK_DENY_ALL) {
      throw new Error(PUBLISH_REQUIRES_ROUTABLE_NETWORK);
    }

    const cgroupFlags = cgroupFlagsFor(limits);
    const requestedLimits = cgroupFlags.length > 0;
    const hasEnv = env && typeof env === 'object' && Object.keys(env).length > 0;
    const childEnv = hasEnv ? { ...env } : undefined;

    const baseSpec = {
      image: serviceImage,
      name,
      mountSource,
      workspacePath,
      network,
      readOnlyMount,
      labelValue: labelValue ?? name,
      ...(labels ? { labels } : {}),
      command,
      publish: publishList,
      env: hasEnv ? env : undefined,
    };

    let res = await exec(bin, buildServiceArgs({ ...baseSpec, cgroupFlags }), { timeoutMs, signal, childEnv });

    // Same graceful cgroup degrade as runOneShot. One extra step matters here: a
    // `run -d` that fails AFTER the container was created still holds the name, so
    // the retry would fail with a name conflict. Remove it first.
    let limitsApplied = requestedLimits;
    let degraded = false;
    if (requestedLimits && res.code !== 0 && !res.timedOut && looksLikeCgroupRejection(res.stderr)) {
      degraded = true;
      limitsApplied = false;
      await remove(name);
      res = await exec(bin, buildServiceArgs({ ...baseSpec, cgroupFlags: [] }), { timeoutMs, signal, childEnv });
    }

    // `run -d` prints the new container id on stdout.
    const containerId = res.code === 0 ? (res.stdout.trim().split(/\s+/)[0] || null) : null;
    return {
      ok: res.code === 0 && res.timedOut !== true,
      containerId,
      code: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: res.timedOut,
      limitsApplied: requestedLimits ? limitsApplied : false,
      degraded,
    };
  }

  /**
   * Inspect a service container's liveness. Used to distinguish "still starting"
   * from "already died" while polling readiness, so a crashed dev server is
   * reported immediately with its exit code instead of after the full timeout.
   *
   * A missing container (or an absent runtime) is reported as
   * `{ ok:false, exists:false }` — never thrown.
   *
   * @returns {Promise<{ ok:boolean, exists:boolean, running:boolean, exitCode:number|null }>}
   */
  async function serviceStatus(name) {
    if (!name) return { ok: false, exists: false, running: false, exitCode: null };
    const res = await exec(bin, ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', name], {
      timeoutMs: 10_000,
    });
    if (res.code !== 0) {
      return { ok: false, exists: false, running: false, exitCode: null, code: res.code, stderr: res.stderr };
    }
    const [runningRaw, exitRaw] = res.stdout.trim().split(/\s+/);
    const exitCode = Number.isInteger(Number(exitRaw)) ? Number(exitRaw) : null;
    return { ok: true, exists: true, running: runningRaw === 'true', exitCode };
  }

  /**
   * Read the tail of a service container's logs. A dev server writes its listen
   * banner and its stack traces here, so this is what makes a preview failure
   * explainable rather than just "it timed out". Never throws.
   *
   * @returns {Promise<{ ok:boolean, logs:string }>}
   */
  async function serviceLogs(name, { tail = 50 } = {}) {
    if (!name) return { ok: false, logs: '' };
    const lines = Number.isInteger(tail) && tail > 0 ? tail : 50;
    const res = await exec(bin, ['logs', '--tail', String(lines), name], { timeoutMs: 10_000 });
    // A dev server logs to BOTH streams; the combined tail is what a human wants.
    const logs = [res.stdout, res.stderr].filter((s) => typeof s === 'string' && s !== '').join('\n');
    return { ok: res.code === 0, logs };
  }

  /**
   * Stop AND remove a service container. `rm -f` does both, and is idempotent —
   * a container that is already gone is the desired end state.
   */
  async function stopService(name) {
    const res = await remove(name);
    return { ok: res.removed === true, stopped: res.removed === true, code: res.code, stderr: res.stderr };
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
    rawExec,
    // Long-running service containers (the Dev_Server behind a Preview).
    startService,
    serviceStatus,
    serviceLogs,
    stopService,
    // Capability flag: a plain docker/OCI CLI backend can enforce total-deny
    // ('none') but NOT per-host egress filtering. A future CNI/firewall-capable
    // or gVisor/Firecracker backend sets this true and enforces NETWORK_FILTERED.
    supportsEgressFiltering: false,
    // Capability flag: this backend CAN run detached, port-publishing containers.
    supportsServices: true,
    // The network modes this instance will launch a one-shot command into.
    permittedNetworks: permitted,
    // Exposed for tests / introspection.
    buildRunArgs,
    buildServiceArgs,
    cgroupFlagsFor,
  });
}
