/**
 * startup-reap.js — the OPTIONAL, NON-BLOCKING startup orphan reap (follow-up to
 * spec Task 5 / Req 6.5).
 *
 * THE PROBLEM. When the platform process dies uncleanly — OOM, SIGKILL, a host
 * restart — the sandbox containers it had launched keep running. Nothing collected
 * them: per-project cleanup happens on `release()`, which never runs if the process
 * that would have called it is gone. So a crash loop leaks containers, and their
 * cgroup allowances, until someone notices.
 *
 * WHY IT WASN'T ALREADY DONE, and what that constrains. Reaping means talking to
 * the container runtime, and the composition root deliberately does NO container
 * I/O at boot: a host with no runtime must still start and answer `/healthz`, so a
 * Sandbox acquire fails with a 503 rather than the whole process failing to come
 * up. Any reap therefore has to satisfy three properties, and this module is built
 * around them:
 *
 *   1. IT MUST NOT BLOCK /healthz. It is started AFTER `listen()` has resolved and
 *      is never awaited on the boot path, so the port is already accepting requests
 *      before the first runtime call is made.
 *   2. IT MUST NOT FAIL BOOT. Every failure — a missing binary, a hung daemon, a
 *      permission error, a misbehaving injected collaborator — resolves to a
 *      structured result. This function never rejects.
 *   3. A MISSING RUNTIME IS A NO-OP, NOT AN ERROR. Availability is probed first,
 *      and an unavailable runtime returns `{ ran:false, reason:'no-container-runtime' }`
 *      without attempting a sweep and without logging an error.
 *
 * WHY IT IS SCOPED TO AN INSTANCE BY DEFAULT. "Containers labelled `aab.sandbox`
 * from a prior process" and "containers labelled `aab.sandbox` belonging to a LIVE
 * sibling instance" are indistinguishable by the owner label alone, so an
 * unscoped sweep on a shared host would destroy a healthy neighbour's running
 * sandboxes mid-turn. Every container we create therefore also carries
 * `aab.instance=<deployment slot>` (see INSTANCE_LABEL), defaulting to the
 * hostname — which is stable across a process restart in the same container/pod
 * and different across hosts. At boot this process has created nothing, so
 * anything already bearing OUR instance id is by definition an orphan of a prior
 * process in this slot. That is the `instance` scope, and it is the default when
 * the reap is enabled.
 *
 * `all` remains available for a single-instance host or a deliberate cleanup, and
 * is documented as unsafe where instances share a runtime.
 *
 * WHAT ONLY A REAL CONTAINER HOST CAN PROVE: that the runtime's label filters
 * select exactly these containers and that `rm -f` collects them. Everything above
 * the runtime CLI — the gating, the scope resolution, the no-runtime no-op, the
 * never-fail-boot guarantee and the argv — is exercised here against fakes.
 *
 * THE PLUMBY BOUNDARY: this module never imports the plumby package.
 */

/**
 * The reap scopes.
 *
 *   'off'      — no reap at all (DEFAULT: the behavior before this existed).
 *   'instance' — reap only containers stamped with THIS deployment slot's instance
 *                id, i.e. orphans of a prior process in this slot. Safe alongside
 *                other live instances.
 *   'all'      — reap every container carrying the owner label, whoever created it.
 *                Only for a host where this is the sole platform instance.
 */
export const STARTUP_REAP_SCOPES = Object.freeze(['off', 'instance', 'all']);

/** Enabling values that mean "yes, with the safe scope". */
const TRUTHY = Object.freeze(['1', 'true', 'yes', 'on', 'enabled']);

/** Values that explicitly mean off. */
const FALSY = Object.freeze(['0', 'false', 'no', 'off', 'disabled', '']);

/**
 * Resolve the startup-reap posture from the environment.
 *
 * An unrecognized value falls back to `off` rather than guessing — the same rule
 * resolveEgressConfig applies, and for the same reason: the fallback for an
 * ambiguous setting must be the one that cannot destroy anything.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{ scope:'off'|'instance'|'all' }}
 */
export function resolveStartupReapConfig(env = process.env) {
  // String() rather than a bare ?? — this runs on the boot path, and a non-string
  // env value (an embedder passing a plain object) must not throw with the socket
  // already open.
  const raw = String(env?.AAB_STARTUP_REAP ?? '').trim().toLowerCase();
  if (FALSY.includes(raw)) return { scope: 'off', recognized: true };
  // A plain boolean opt-in gets the SAFE scope, never the destructive one.
  if (TRUTHY.includes(raw)) return { scope: 'instance', recognized: true };
  if (STARTUP_REAP_SCOPES.includes(raw)) return { scope: raw, recognized: true };
  // Unrecognized: fall back to the posture that cannot destroy anything, and SAY SO
  // — silently disabling a cleanup an operator believes is on is its own defect.
  return { scope: 'off', recognized: false, raw };
}

/**
 * How many owned containers carry an instance id that is NOT ours (and are therefore
 * invisible to an instance-scoped sweep)? Never throws; 0 when it cannot be told.
 */
async function countUnclaimable(backend, instanceId) {
  if (!backend || typeof backend.listOrphans !== 'function') return 0;
  try {
    const all = await backend.listOrphans();
    if (all?.ok !== true) return 0;
    return all.candidates.filter((c) => c.instanceId !== instanceId).length;
  } catch {
    return 0;
  }
}

/**
 * Can this backend actually talk to a container runtime? Never throws: a missing
 * binary, a dead daemon or a backend without a probe all mean "no".
 */
async function runtimeAvailable(backend) {
  if (!backend || typeof backend.isAvailable !== 'function') return false;
  try {
    return (await backend.isAvailable()) === true;
  } catch {
    return false;
  }
}

/**
 * Run the startup orphan reap. Resolves — NEVER rejects — with a structured result.
 *
 * @param {object} args
 * @param {'off'|'instance'|'all'} [args.scope='off']
 * @param {string} [args.instanceId]  this deployment slot's identity
 * @param {object} args.sandboxManager  supplies reapAllOrphans({instanceId})
 * @param {object} args.backend         supplies isAvailable() for the no-op probe
 * @param {{log:Function}} [args.logger]
 * @returns {Promise<{ ran:boolean, scope:string, reason:string, reaped:string[] }>}
 */
export async function runStartupReap({
  scope = 'off',
  instanceId,
  sandboxManager,
  backend,
  logger = console,
  recognized = true,
  raw,
} = {}) {
  const log = (message) => {
    try {
      logger?.log?.(message);
    } catch {
      // A logger that throws must not turn a cleanup into a boot failure.
    }
  };

  try {
    if (recognized === false) {
      log(
        `ai-app-builder startup reap DISABLED: AAB_STARTUP_REAP=${JSON.stringify(raw)} is not one of ` +
          `[${STARTUP_REAP_SCOPES.join(', ')}]. No containers will be reaped.`,
      );
      return { ran: false, scope: 'off', reason: 'unrecognized-value', reaped: [] };
    }
    if (scope === 'off') return { ran: false, scope, reason: 'disabled', reaped: [] };
    if (!STARTUP_REAP_SCOPES.includes(scope)) {
      return { ran: false, scope, reason: 'unknown-scope', reaped: [] };
    }
    if (!sandboxManager || typeof sandboxManager.reapAllOrphans !== 'function') {
      return { ran: false, scope, reason: 'no-reaper', reaped: [] };
    }
    // An instance-scoped sweep without an instance id would silently become an
    // `all` sweep, which is exactly the destructive behavior the scope exists to
    // avoid. Refuse instead.
    if (scope === 'instance' && (typeof instanceId !== 'string' || instanceId.trim() === '')) {
      log('ai-app-builder startup reap SKIPPED: instance scope requires an instance id');
      return { ran: false, scope, reason: 'no-instance-id', reaped: [] };
    }
    // THE GATE THAT CATCHES A MIS-WIRED COMPOSITION. An instance-scoped sweep filters
    // on a label the BACKEND must apply. If the composed backend does not stamp it —
    // as happened when the filtering backend silently dropped the option — the sweep
    // matches nothing and reports a clean host, which is indistinguishable from
    // success. Refuse instead: "nothing was stamped" must not look like "nothing was
    // orphaned".
    if (scope === 'instance' && backend && backend.instanceId !== instanceId) {
      log(
        'ai-app-builder startup reap SKIPPED: the container backend does not stamp this instance id ' +
          `(backend=${JSON.stringify(backend.instanceId ?? null)}, expected=${JSON.stringify(instanceId)}), ` +
          'so an instance-scoped sweep would match nothing and look like a clean host',
      );
      return { ran: false, scope, reason: 'backend-not-stamping', reaped: [] };
    }

    // PROPERTY 3: a host with no container runtime is a NO-OP, not an error. This
    // probe is why the reap can be enabled unconditionally in a deployment that
    // sometimes runs without a runtime.
    if (!(await runtimeAvailable(backend))) {
      log('ai-app-builder startup reap skipped: no container runtime available');
      return { ran: false, scope, reason: 'no-container-runtime', reaped: [] };
    }

    const result = await sandboxManager.reapAllOrphans(scope === 'instance' ? { instanceId } : {});
    const reaped = Array.isArray(result?.reaped) ? result.reaped : [];
    const failed = Array.isArray(result?.failed) ? result.failed : [];
    if (result && result.code !== undefined && result.code !== 0) {
      // The runtime answered, but the listing failed. Report it; do not throw.
      log(`ai-app-builder startup reap could not list containers: ${String(result.stderr ?? '').trim()}`);
      return { ran: true, scope, reason: 'list-failed', reaped, failed };
    }

    // THE DIAGNOSTIC FOR AN UNCLAIMABLE ORPHAN. An instance-scoped sweep cannot see
    // containers stamped with a DIFFERENT id — a slot that was recreated rather than
    // restarted in place (a rescheduled pod, `compose up` recreating the container),
    // or a container from a version before the instance label existed. Those leak,
    // and "no orphans" would read exactly like a clean host. Count them so the
    // operator gets the one signal that says to run `all` by hand.
    const unclaimable = scope === 'instance' ? await countUnclaimable(backend, instanceId) : 0;

    if (reaped.length === 0) {
      log(`ai-app-builder startup reap (${scope}): no orphaned sandbox containers`);
    } else {
      log(`ai-app-builder startup reap (${scope}): removed ${reaped.length} orphaned sandbox container(s)`);
    }
    if (failed.length > 0) {
      log(`ai-app-builder startup reap (${scope}): ${failed.length} container(s) could NOT be removed`);
    }
    if (unclaimable > 0) {
      log(
        `ai-app-builder startup reap (${scope}): ${unclaimable} sandbox container(s) carry a DIFFERENT instance id ` +
          'and were left alone. If this instance was recreated rather than restarted in place, or these predate ' +
          'the instance label, they can only be cleared with AAB_STARTUP_REAP=all (which also affects any other ' +
          'live instance sharing this runtime).',
      );
    }
    return { ran: true, scope, reason: 'ok', reaped, failed, unclaimable };
  } catch (err) {
    // PROPERTY 2: nothing here may fail boot.
    log(`ai-app-builder startup reap failed (ignored): ${err?.message ?? err}`);
    return { ran: false, scope, reason: 'error', reaped: [], error: err?.message ?? String(err) };
  }
}
