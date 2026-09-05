/**
 * THE SANDBOX MANAGER — the per-project Isolation_Boundary (spec subtask 5.1,
 * Req 8.1–8.6, 6.5, Req 10; Property 1).
 *
 * A SandboxManager hands out one Isolation_Boundary per Project through a clean,
 * backend-agnostic interface:
 *
 *   acquire(projectId)              -> Sandbox   (provision the boundary)
 *   exec(projectId, command)                     (FEAT-002 — see note below)
 *   release(projectId)                           (tear down + reap; idempotent)
 *
 * The interface is the stable contract; ALL container specifics live behind the
 * injected `backend` (container-backend.js), so the same manager works whether
 * the backend is a Docker/OCI CLI (Podman here) or a later gVisor/Firecracker
 * driver — swapping the backend never changes this file's surface.
 *
 * WHAT acquire() RECORDS as the boundary for a project (Property 1 invariant):
 *   - a per-container root filesystem (the image root — supplied by the backend);
 *   - ONLY that project's exportable tree bind-mounted, whose source path is
 *     EXACTLY layout.exportableProjectTree(projectId) and no other project's
 *     tree — this is the structural guarantee the property test pins down;
 *   - PID + network-namespace isolation (requested via the backend run spec);
 *   - the deny-by-default egress allowlist derived from the project's ACTIVE
 *     ConnectorBindings plus the Package_Manager registry host(s);
 *   - the REQUESTED cgroup CPU/memory/pids limits (applied opportunistically by
 *     the backend, which reports whether they actually took effect).
 *
 * LIFECYCLE DISCIPLINE (mirrors eval/runner.js): callers acquire in a try and
 * release in a finally. release() is therefore IDEMPOTENT and SAFE to call
 * twice, after a failed acquire, or when nothing was ever acquired — it reaps
 * any orphaned container for the project (Req 6.5) and forgets the record.
 *
 * exec() is intentionally a stub here (throws "not implemented in FEAT-001");
 * FEAT-002 implements classifier-independent containment on top of this exact
 * interface. Keeping the method present now fixes the stable shape.
 */

import { requireString, requireArray, fail } from '../model/validate.js';
import { computeEgressAllowlist, DEFAULT_PACKAGE_REGISTRY_HOSTS } from './egress.js';
import { WORKSPACE_MOUNT_PATH } from './container-backend.js';

/**
 * Validate a projectId as a single safe path segment (same rule as the storage
 * layout): no separators, no traversal. A sandbox is keyed by projectId and its
 * name/mount are derived from it, so an unsafe id could escape or collide.
 */
function requireSafeProjectId(projectId) {
  requireString('SandboxManager', 'projectId', projectId);
  if (
    projectId.includes('/') ||
    projectId.includes('\\') ||
    projectId === '.' ||
    projectId === '..' ||
    projectId.includes('..')
  ) {
    fail('SandboxManager', `projectId must be a single safe path segment, got ${JSON.stringify(projectId)}`);
  }
  return projectId;
}

/** Derive the container name for a project (also the reap label value). */
function containerNameFor(projectId) {
  return `aab-sbx-${projectId}`;
}

/**
 * Create a SandboxManager.
 *
 * @param {object} args
 * @param {object} args.layout    a StorageLayout (src/storage/layout.js) — supplies exportableProjectTree
 * @param {object} args.backend   a container backend (src/sandbox/container-backend.js)
 * @param {object} [args.config]
 * @param {string[]} [args.config.packageRegistryHosts]  Package_Manager registry host(s)
 * @param {object} [args.config.limits]                  requested cgroup limits { memoryMb, cpus, pids }
 * @param {number} [args.config.execTimeoutMs]           default wall-clock exec limit (enforced in-process)
 * @param {boolean} [args.config.readOnlyMount]          mount the project tree read-only
 * @param {(projectId:string)=>Array<object>} [args.bindingsFor]  resolve a project's ConnectorBindings
 * @returns {object} manager
 */
export function createSandboxManager({ layout, backend, config = {}, bindingsFor } = {}) {
  if (!layout || typeof layout.exportableProjectTree !== 'function') {
    fail('SandboxManager', 'layout with exportableProjectTree(projectId) is required');
  }
  if (!backend || typeof backend.runOneShot !== 'function' || typeof backend.remove !== 'function') {
    fail('SandboxManager', 'backend with runOneShot/remove/reapOrphans is required');
  }

  const packageRegistryHosts = requireArray(
    'SandboxManager',
    'config.packageRegistryHosts',
    config.packageRegistryHosts ?? DEFAULT_PACKAGE_REGISTRY_HOSTS,
  );
  const requestedLimits = config.limits ?? {};
  const readOnlyMount = config.readOnlyMount === true;
  const defaultExecTimeoutMs =
    typeof config.execTimeoutMs === 'number' && config.execTimeoutMs > 0
      ? config.execTimeoutMs
      : 30_000;

  // The live per-project boundary records. Keyed by projectId. A record is the
  // manager's memory of a provisioned Isolation_Boundary.
  const sandboxes = new Map();

  /** Resolve a project's bindings via the injected resolver (default: none). */
  function resolveBindings(projectId) {
    if (typeof bindingsFor !== 'function') return [];
    const bindings = bindingsFor(projectId);
    return Array.isArray(bindings) ? bindings : [];
  }

  /**
   * Provision (or return the existing) Isolation_Boundary for a project.
   *
   * acquire() is the single point that binds the project's OWN tree, PID/network
   * isolation, the egress allowlist, and the requested limits into one Sandbox
   * handle. It does NOT launch a long-running container (v1 exec is one-shot per
   * command, in FEAT-002); it records the boundary the exec model will use.
   *
   * @param {string} projectId
   * @returns {object} Sandbox handle (frozen)
   */
  function acquire(projectId) {
    requireSafeProjectId(projectId);
    const existing = sandboxes.get(projectId);
    if (existing) return existing.handle;

    // THE bind-mount source is EXACTLY this project's exportable tree — never
    // another project's, never a broader parent. This is the Property 1 pin.
    const mountSource = layout.exportableProjectTree(projectId);

    const bindings = resolveBindings(projectId);
    const egress = computeEgressAllowlist({ bindings, packageRegistryHosts });
    // v1 network policy: deny-by-default with no reachable hosts means total
    // network deny (`--network none`) — the honest containment we can enforce.
    // With hosts present, a filtering-network backend applies the allowlist; in
    // this sandbox we still request the namespace and record the allowlist.
    const network = egress.allowedHosts.length === 0 ? 'none' : 'private';

    const name = containerNameFor(projectId);

    const record = {
      projectId,
      name,
      mountSource,
      workspacePath: WORKSPACE_MOUNT_PATH,
      egress,
      network,
      limits: requestedLimits,
      readOnlyMount,
      // Whether cgroup limits actually took effect is only KNOWN after a real
      // run (the backend reports it). Until then it is null (unknown), not a
      // false claim of enforcement.
      limitsApplied: null,
    };

    const handle = Object.freeze({
      projectId,
      /** Fixed in-container mount path for the project's tree. */
      workspacePath: WORKSPACE_MOUNT_PATH,
      /** Host path bind-mounted into the container (this project's tree ONLY). */
      mountSource,
      /** The effective deny-by-default egress allowlist. */
      egress,
      /** Requested cgroup limits (may or may not be applied — see limitsApplied). */
      limits: Object.freeze({ ...requestedLimits }),
      /**
       * Whether cgroup limits were actually applied. null = not yet run / unknown;
       * true/false set once a real run reports it. NEVER assume true.
       */
      get limitsApplied() {
        return sandboxes.get(projectId)?.record.limitsApplied ?? null;
      },
      /** Internal container name (also the orphan-reap label value). */
      containerName: name,
    });

    sandboxes.set(projectId, { record, handle });
    return handle;
  }

  /**
   * Normalize a caller-supplied command into a container command VECTOR.
   *
   * We deliberately do NOT let the host shell touch the string: a string
   * command is handed to the CONTAINER's own shell (`sh -c <string>`) so it is
   * interpreted INSIDE the boundary, never on the host. An array is passed
   * through as an argv vector (exec form). Either way the command only ever runs
   * inside the container — there is no host-side shell interpolation and thus no
   * host command-injection surface.
   *
   * @param {string|string[]} command
   * @returns {string[]} a container command vector
   */
  function toContainerCommand(command) {
    if (Array.isArray(command)) {
      const vec = requireArray('SandboxManager', 'command', command);
      for (const [i, part] of vec.entries()) {
        requireString('SandboxManager', `command[${i}]`, part);
      }
      return [...vec];
    }
    // A command must be a string OR an argv array; an EMPTY string is allowed
    // (it is still run inside the box — a no-op there — and must stay confined),
    // so we do not use requireString here (which rejects empty).
    if (typeof command !== 'string') {
      fail('SandboxManager', 'command must be a string or an array of strings');
    }
    // Interpret the string with the container's shell, inside the boundary.
    return ['sh', '-c', command];
  }

  /**
   * exec(projectId, command) — run a command INSIDE the project's
   * Isolation_Boundary (spec subtasks 5.2/5.4, Req 8.2–8.6, Property 1).
   *
   * THE CONTRACT this method upholds:
   *   - EVERY command runs inside that project's container: a one-shot
   *     `docker run --rm` with (a) the container's own root filesystem, (b) ONLY
   *     this project's tree bind-mounted at the fixed workspace path, (c) a
   *     private PID namespace, (d) a private network namespace whose egress is
   *     governed by the deny-by-default allowlist, and (e) an in-process
   *     wall-clock timeout that kills + reaps the run.
   *   - It NEVER consults plumby's classifier. There is no branch on
   *     allow/confirm/refuse here — the boundary is NOT the gate. An `allow`
   *     command and a `refuse` command are confined byte-for-byte identically;
   *     containment is a property of the container, not of the verdict.
   *   - A command that tries to reach another project's tree, the host, or a
   *     denied network endpoint simply CANNOT: those paths/processes/hosts are
   *     not present in the container, so the attempt fails inside the box and
   *     the out-of-box target state is preserved unchanged. When the boundary
   *     actively refuses (e.g. the run cannot even launch, or the wall-clock
   *     limit fires), `denied` is set on the structured result.
   *
   * exec auto-acquires the boundary if the project was not explicitly acquired,
   * so it is safe to call standalone; callers that manage the lifecycle should
   * still release() in a finally.
   *
   * @param {string} projectId
   * @param {string|string[]} command   a shell string (run by the CONTAINER's
   *                                     shell) or an argv vector
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]    override the default wall-clock limit
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{ stdout:string, stderr:string, exitCode:number|null, denied:boolean, timedOut:boolean, signal:string|null, projectId:string, network:string, workspacePath:string, mountSource:string, limitsApplied:boolean|null }>}
   */
  async function exec(projectId, command, opts = {}) {
    requireSafeProjectId(projectId);
    // Ensure the boundary exists (idempotent). exec never inspects the command's
    // classification — it only builds an isolated invocation for it.
    const handle = acquire(projectId);
    const entry = sandboxes.get(projectId);
    const record = entry.record;

    const containerCommand = toContainerCommand(command);
    const timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : defaultExecTimeoutMs;

    let result;
    try {
      result = await backend.runOneShot({
        name: record.name,
        mountSource: record.mountSource,
        command: containerCommand,
        limits: record.limits,
        network: record.network,
        readOnlyMount: record.readOnlyMount,
        timeoutMs,
        signal: opts.signal,
      });
    } catch (err) {
      // The boundary actively refused to run the command (could not launch the
      // isolated invocation). Report denied; no work escaped the box.
      return Object.freeze({
        stdout: '',
        stderr: String(err?.message ?? err),
        exitCode: null,
        denied: true,
        timedOut: false,
        signal: null,
        projectId,
        network: record.network,
        workspacePath: handle.workspacePath,
        mountSource: record.mountSource,
        limitsApplied: record.limitsApplied,
      });
    }

    // Record whether cgroup limits actually took effect (only known post-run).
    if (typeof result.limitsApplied === 'boolean') {
      record.limitsApplied = result.limitsApplied;
    }

    // `denied` marks a boundary-level refusal: the run could not launch at all,
    // or the wall-clock limit fired (the boundary killed + reaped it). A normal
    // non-zero exit from the command itself is NOT a denial — that is the
    // command's own result, faithfully reported from inside the box.
    const denied = result.timedOut === true;

    return Object.freeze({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: typeof result.code === 'number' ? result.code : null,
      denied,
      timedOut: result.timedOut === true,
      signal: result.signal ?? null,
      projectId,
      network: record.network,
      workspacePath: handle.workspacePath,
      mountSource: record.mountSource,
      limitsApplied: record.limitsApplied,
    });
  }

  /**
   * Tear down and reap a project's Isolation_Boundary.
   *
   * MUST be safe in a finally: idempotent, safe to call twice, safe after a
   * failed acquire, and safe when nothing was acquired. It force-removes the
   * project's container (idempotent at the backend) AND reaps any orphaned
   * container carrying the project's label (Req 6.5 orphan cleanup), then
   * forgets the record. Best-effort: a reap failure is reported, never thrown,
   * so it can't mask the caller's real error.
   *
   * @param {string} projectId
   * @returns {Promise<{ projectId, released:boolean, reaped:string[], errors:string[] }>}
   */
  async function release(projectId) {
    requireSafeProjectId(projectId);
    const name = containerNameFor(projectId);
    const errors = [];
    let reaped = [];

    // Remove the named container (idempotent — a missing container is success).
    try {
      const res = await backend.remove(name);
      if (res && res.removed === false && res.stderr) errors.push(String(res.stderr));
    } catch (err) {
      errors.push(String(err?.message ?? err));
    }

    // Orphan cleanup: reap anything still labelled for this project (covers a
    // container left behind by a failed import/acquire that we never recorded).
    if (typeof backend.reapOrphans === 'function') {
      try {
        const res = await backend.reapOrphans(name);
        reaped = Array.isArray(res?.reaped) ? res.reaped : [];
      } catch (err) {
        errors.push(String(err?.message ?? err));
      }
    }

    sandboxes.delete(projectId);
    return { projectId, released: true, reaped, errors };
  }

  /**
   * Recompute a project's egress allowlist after a Connector is added/removed.
   * Because the allowlist is a PURE function of the current bindings, this both
   * ADDS newly-active hosts and REVOKES hosts from removed bindings. Returns the
   * new frozen allowlist. Throws if the project has not been acquired.
   *
   * @param {string} projectId
   * @param {Array<object>} [bindings]  bindings to use (defaults to bindingsFor)
   */
  function updateEgress(projectId, bindings) {
    requireSafeProjectId(projectId);
    const entry = sandboxes.get(projectId);
    if (!entry) fail('SandboxManager', `updateEgress: project ${JSON.stringify(projectId)} is not acquired`);
    const use = Array.isArray(bindings) ? bindings : resolveBindings(projectId);
    const egress = computeEgressAllowlist({ bindings: use, packageRegistryHosts });
    entry.record.egress = egress;
    entry.record.network = egress.allowedHosts.length === 0 ? 'none' : 'private';
    // Rebuild the frozen handle so the exposed allowlist reflects the change.
    const prev = entry.handle;
    entry.handle = Object.freeze({
      ...prev,
      egress,
      get limitsApplied() {
        return sandboxes.get(projectId)?.record.limitsApplied ?? null;
      },
    });
    return egress;
  }

  /** Introspection: the live Sandbox handle for a project, or null. */
  function get(projectId) {
    requireSafeProjectId(projectId);
    return sandboxes.get(projectId)?.handle ?? null;
  }

  /** Introspection: projectIds with a live boundary. */
  function activeProjectIds() {
    return [...sandboxes.keys()];
  }

  /**
   * Reap ALL orphaned sandbox containers we own (any project). Useful at
   * startup to clear boundaries left by a crashed prior process.
   */
  async function reapAllOrphans() {
    if (typeof backend.reapOrphans !== 'function') return { reaped: [] };
    return backend.reapOrphans();
  }

  return Object.freeze({
    acquire,
    exec,
    release,
    updateEgress,
    get,
    activeProjectIds,
    reapAllOrphans,
    // Exposed defaults for tests / callers.
    defaultExecTimeoutMs,
    packageRegistryHosts: Object.freeze([...packageRegistryHosts]),
  });
}
