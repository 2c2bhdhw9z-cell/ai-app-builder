/**
 * filtering-container-backend.js — a container backend that can HONESTLY enforce
 * per-host egress, so `AAB_SANDBOX_EGRESS=registry` becomes usable instead of
 * fail-closed-and-useless (follow-up to spec Task 5, Req 8.4, 17.1).
 *
 * WHAT WAS BROKEN. `createContainerBackend` advertises `supportsEgressFiltering:
 * false` and refuses any network mode but `none`, which is the honest thing for it
 * to do — it cannot install per-host firewall rules. But it left the platform with
 * no usable posture: `none` means `npm install` cannot work, and `registry` means
 * every command in every sandbox is denied before launch. This backend is the
 * filtering-capable path behind the SAME `createContainerBackend` seam, so the
 * SandboxManager's acquire/exec/release contract does not change at all.
 *
 * HOW IT ENFORCES (see src/sandbox/egress-proxy.js for the full reasoning):
 *
 *   - a docker network created `--internal` — no route out, applied by the RUNTIME,
 *     not asserted by us. That is deny-by-default as a property of the network
 *     rather than a promise in a comment;
 *   - one allowlisting proxy container attached to that internal network AND a
 *     normal one, making it the ONLY path out. It matches on hostname and never
 *     terminates TLS, so package integrity stays end-to-end;
 *   - the sandbox container joins the internal network ONLY, with the proxy
 *     variables injected.
 *
 * A package script that ignores the proxy variables does not get a bypass: on an
 * internal network there is no route and no external DNS to find one with.
 *
 * IT DELEGATES RATHER THAN DUPLICATES. Every argv/cgroup/degrade/label decision
 * stays in container-backend.js. This module only (a) ensures the network and proxy
 * exist, and (b) TRANSLATES a `filtered` request into "join the internal network,
 * with these proxy variables added" before handing it to the base backend. The
 * base instance is constructed permitting exactly ONE extra network — its own
 * internal one — so a bug here cannot turn into "attached to the default bridge
 * with full egress".
 *
 * STILL FAIL-CLOSED:
 *   - an EMPTY allowlist is refused at construction: a filtering backend with
 *     nothing to allow is a misconfiguration, and silently allowing everything (or
 *     nothing, confusingly) is worse than refusing to start;
 *   - if the network or the proxy cannot be brought up, exec is DENIED rather than
 *     run with whatever networking happens to be available;
 *   - a network mode that is neither `none` nor `filtered` is refused.
 *
 * WHAT ONLY A REAL CONTAINER HOST CAN PROVE: that `--internal` severs the route,
 * that the embedded DNS still resolves the proxy container's name on it, and that a
 * real `npm install` completes through the proxy while an off-allowlist host stays
 * unreachable. Everything above the runtime CLI — the emitted argv, the ordering
 * and idempotence of setup, the translation, the injected variables, and every
 * fail-closed path — is exercised here with the CLI faked, and the proxy's own
 * allow/deny behavior is proven by running it for real.
 *
 * THE PLUMBY BOUNDARY: this module never imports the plumby package.
 */

import {
  createContainerBackend,
  DEFAULT_IMAGE,
  NETWORK_DENY_ALL,
  NETWORK_FILTERED,
  OWNER_LABEL,
} from './container-backend.js';
import {
  ALLOWLIST_LABEL,
  DEFAULT_PROXY_PORT,
  allowlistFingerprint,
  proxyCommand,
  proxyContainerEnv,
  proxyEnvFor,
  sanitizeProxyAllowlist,
} from './egress-proxy.js';
import { fail } from '../model/validate.js';

/**
 * Prefix for the PER-PROJECT internal (no-route-out) networks. One network per
 * project, so sandboxes cannot reach each other — see networkFor.
 */
export const DEFAULT_EGRESS_NETWORK_PREFIX = 'aab-egress';

/** Default name of the allowlisting proxy container. */
export const DEFAULT_PROXY_CONTAINER = 'aab-egress-proxy';

/** Message used when the egress plane could not be established. */
export const EGRESS_PLANE_UNAVAILABLE =
  'egress filtering is configured but its enforcement plane could not be established ' +
  '(the internal network and/or the allowlisting proxy failed to start), so the command ' +
  'is DENIED rather than run with unfiltered network access (fail-closed).';

/**
 * Create a filtering-capable container backend.
 *
 * @param {object} args
 * @param {string[]} args.allowedHosts  the hosts a sandbox may reach. REQUIRED and
 *        must be non-empty — a filtering backend with nothing to allow is a
 *        misconfiguration, not a stricter posture.
 * @param {string} [args.bin]           runtime binary (default 'docker')
 * @param {string} [args.image]         image for sandbox one-shot runs
 * @param {string} [args.proxyImage]    image for the proxy container (default: `image`;
 *        the proxy is stdlib-only Node, so the sandbox image already suffices)
 * @param {Function} [args.exec]        injectable CLI runner (tests)
 * @param {string} [args.networkName]   the internal network's name
 * @param {string} [args.proxyName]     the proxy container's name
 * @param {number} [args.proxyPort]
 * @param {string} [args.egressNetwork] the EGRESS-CAPABLE network the proxy is also
 *        attached to (default 'bridge'), i.e. the only place real egress exists
 * @param {(opts:object)=>object} [args.createBase]  base-backend factory (tests)
 * @returns {object} backend (frozen), same shape as createContainerBackend
 */
export function createFilteringContainerBackend({
  allowedHosts,
  bin = 'docker',
  image = DEFAULT_IMAGE,
  proxyImage,
  exec,
  networkPrefix = DEFAULT_EGRESS_NETWORK_PREFIX,
  proxyName = DEFAULT_PROXY_CONTAINER,
  proxyPort = DEFAULT_PROXY_PORT,
  connectPorts,
  egressNetwork = 'bridge',
  proxyLimits = { memoryMb: 256, cpus: 1, pids: 256 },
  readyAttempts = 40,
  readyIntervalMs = 250,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  createBase = createContainerBackend,
} = {}) {
  const model = 'FilteringContainerBackend';

  // FAIL CLOSED at construction: refuse to exist with nothing to allow, so a
  // dropped/empty configuration surfaces as a boot error rather than as a sandbox
  // that mysteriously denies (or worse, permits) everything.
  const hosts = sanitizeProxyAllowlist(allowedHosts ?? []);
  if (hosts.length === 0) {
    fail(
      model,
      'allowedHosts must contain at least one usable host: a filtering backend with an ' +
        'empty allowlist cannot enforce anything meaningful. Use the plain backend with ' +
        "network 'none' for a total-deny posture.",
    );
  }
  for (const name of [networkPrefix, proxyName]) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
      fail(model, `invalid container/network name ${JSON.stringify(name)}`);
    }
  }

  /**
   * The per-project internal networks this backend has created. The base backend
   * is permitted to launch into total-deny plus EXACTLY these — nothing else — so a
   * mistranslation cannot silently attach a sandbox to a general-purpose network.
   */
  const ownNetworks = new Set();

  const base = createBase({
    bin,
    image,
    ...(exec ? { exec } : {}),
    isNetworkPermitted: (network) => network === NETWORK_DENY_ALL || ownNetworks.has(network),
  });

  /** The fingerprint of the policy the proxy must be running with. */
  const fingerprint = allowlistFingerprint(hosts);

  /** The env a sandbox needs to route through the proxy. Computed once. */
  const sandboxProxyEnv = proxyEnvFor({ proxyHost: proxyName, proxyPort });

  /**
   * ONE INTERNAL NETWORK PER PROJECT, not one shared by all of them.
   *
   * A single shared internal network would put every project's sandbox in one L2
   * domain: containers on a user-defined network reach each other on all ports and
   * the runtime's embedded DNS resolves peer container names, so project A could
   * reach project B's container. `--network none` gave no peers at all, and
   * egress.js states as an invariant that no lateral peer access is ever produced —
   * so sharing the network would have quietly widened the Isolation_Boundary while
   * narrowing egress. A network per project keeps peers unreachable; the single
   * proxy is attached to each one, so it stays the only path out.
   */
  function networkFor(labelValue) {
    const suffix = String(labelValue ?? '').replace(/^aab-sbx-/, '');
    const name = `${networkPrefix}-${suffix}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(name)) {
      fail(model, `cannot derive a valid network name from labelValue ${JSON.stringify(labelValue)}`);
    }
    return name;
  }

  /** Shared proxy setup, at most one in flight. */
  let proxyPromise = null;
  /** Has that promise SETTLED? An in-flight build is joined, not revalidated. */
  let proxySettled = false;
  /** Per-project network setup, keyed by network name; at most one in flight each. */
  const networkPromises = new Map();

  /**
   * Bring up (idempotently) the allowlisting proxy.
   *
   * The proxy is ADOPTED only when it is running AND its allowlist fingerprint
   * matches the current configuration. Adopting on the name alone meant an
   * allowlist change — including a removal, i.e. a REVOCATION — never took effect,
   * and any container of that name became the component every sandbox's traffic was
   * pointed at.
   */
  async function ensureProxy() {
    if (proxyPromise !== null) {
      // An IN-FLIGHT build is joined, never revalidated — that is what collapses N
      // concurrent execs into one setup.
      if (!proxySettled) return proxyPromise;

      const cached = await proxyPromise;
      if (cached.ok === true) {
        // A CACHED success is not proof the proxy is still there. Without this
        // check, a proxy that died or was reaped left every later filtered exec
        // launching into an internal network with no path out, forever.
        const status = await serviceStatusOf(proxyName);
        if (status.exists === true && status.running === true) return cached;
        // It is gone. Rebuild it — and force every project's network to be
        // re-attached, because the attachment belonged to the OLD container.
        networkPromises.clear();
        ownNetworks.clear();
      }
      proxyPromise = null;
      proxySettled = false;
    }

    // A REJECTION must not be cached: awaiting a rejected cached promise would
    // re-throw forever, so one transient failure would deny every command for the
    // process lifetime. Convert to a structured result, and clear on failure.
    proxyPromise = establishProxy()
      .catch((err) => ({
        ok: false,
        created: [],
        reason: `egress proxy setup failed: ${err?.message ?? String(err)}`,
      }))
      .then((res) => {
        proxySettled = true;
        return res;
      });
    const res = await proxyPromise;
    if (res.ok !== true) {
      proxyPromise = null;
      proxySettled = false;
    }
    return res;
  }

  async function establishProxy() {
    const created = [];
    const status = await serviceStatusOf(proxyName);

    if (status.exists === true && status.running === true) {
      const running = await proxyFingerprintOf(proxyName);
      if (running === fingerprint) return { ok: true, created, adopted: true };
      // Policy drift: the running proxy enforces a DIFFERENT allowlist. Replace it,
      // so a revocation actually revokes.
      await base.stopService(proxyName);
    } else if (status.exists === true) {
      // A stale, exited proxy still holds the name — remove it before recreating.
      await base.remove(proxyName);
    }

    const started = await base.startService({
      name: proxyName,
      // Labelled like everything else we own, so the orphan reaper collects it.
      labelValue: proxyName,
      labels: { [ALLOWLIST_LABEL]: fingerprint },
      command: proxyCommand(),
      env: proxyContainerEnv({ allowedHosts: hosts, proxyPort, ...(connectPorts ? { connectPorts } : {}) }),
      // The proxy starts on the EGRESS-CAPABLE network — it is the only component
      // that is supposed to have one.
      network: egressNetwork,
      // The one long-lived component every project's traffic funnels through must
      // not be the only container without resource limits.
      ...(proxyLimits ? { limits: proxyLimits } : {}),
      ...(proxyImage || image ? { image: proxyImage ?? image } : {}),
      timeoutMs: 60_000,
    });
    if (started?.ok !== true) {
      return {
        ok: false,
        created,
        reason: `could not start the egress proxy ${proxyName}: ${(started?.stderr ?? '').trim() || `exit ${started?.code ?? 'n/a'}`}`,
      };
    }
    created.push(`proxy:${proxyName}`);

    // WAIT FOR IT TO BE LISTENING. `startService` returns when the runtime accepted
    // the detached run, NOT when the Node process inside has bound its socket — so
    // without this the first install after a cold plane could fail with a connection
    // error rather than a policy decision.
    const ready = await waitForProxyListening();
    if (ready !== true) {
      await base.stopService(proxyName);
      return { ok: false, created, reason: `the egress proxy ${proxyName} did not start listening` };
    }
    return { ok: true, created, adopted: false };
  }

  /** Poll the proxy's logs for its listen banner, bounded by attempts and the clock. */
  async function waitForProxyListening() {
    for (let attempt = 0; attempt < readyAttempts; attempt += 1) {
      const logs = await serviceLogsOf(proxyName);
      if (/proxy listening/.test(logs)) return true;
      const status = await serviceStatusOf(proxyName);
      if (status.exists === true && status.running === false) return false;
      await sleep(readyIntervalMs);
    }
    return false;
  }

  /**
   * Bring up (idempotently) one project's internal network, with the proxy attached.
   *
   * The network is VERIFIED INTERNAL, not merely created with `--internal`:
   * `network create` is a no-op when the name is taken, and the flag is discarded
   * along with the error, so a pre-existing ROUTABLE network of the same name would
   * otherwise become the sandbox network and restore full egress with no signal
   * anywhere. Adoption therefore inspects the existing network's `Internal` flag and
   * refuses the plane when it is not true.
   */
  async function ensureNetwork(networkName) {
    if (!networkPromises.has(networkName)) {
      networkPromises.set(
        networkName,
        establishNetwork(networkName).catch((err) => ({
          ok: false,
          reason: `egress network setup failed: ${err?.message ?? String(err)}`,
        })),
      );
    }
    const res = await networkPromises.get(networkName);
    if (res.ok !== true) networkPromises.delete(networkName);
    return res;
  }

  async function establishNetwork(networkName) {
    const created = [];
    const netRes = await runCli(
      ['network', 'create', '--internal', '--label', `${OWNER_LABEL}=${proxyName}`, networkName],
      30_000,
    );
    if (netRes.code === 0) {
      created.push(`network:${networkName}`);
    } else {
      // Either it already exists, or creation genuinely failed. Do not decide from
      // the stderr WORDING (which differs between docker and podman, and podman is a
      // documented configuration) — inspect the network instead.
      const internal = await networkIsInternal(networkName);
      if (internal === null) {
        return { ok: false, reason: `could not create internal network ${networkName}: ${netRes.stderr.trim()}` };
      }
      if (internal !== true) {
        return {
          ok: false,
          reason:
            `network ${networkName} already exists but is NOT internal, so it would not contain ` +
            'egress. Refusing to use it (fail-closed): remove it, or point AAB at a different name.',
        };
      }
    }

    // The proxy already exists: ensureEgressPlane establishes it before any network,
    // precisely so it can be attached here.
    const attach = await runCli(['network', 'connect', networkName, proxyName], 30_000);
    if (attach.code !== 0 && !/already exists|already connected|endpoint with name/i.test(`${attach.stderr}${attach.stdout}`)) {
      // Do not leave a half-built plane behind claiming success, and do not leave
      // the network we just created orphaned either.
      if (created.length > 0) await removeNetwork(networkName);
      return { ok: false, reason: `could not attach ${proxyName} to ${networkName}: ${attach.stderr.trim()}` };
    }

    // Only NOW is this network one a sandbox may be launched into.
    ownNetworks.add(networkName);
    return { ok: true, created };
  }

  /**
   * Ensure the whole enforcement plane for one project, revalidating that the proxy
   * is still alive. A cached success is not proof: a proxy that has died or been
   * reaped would otherwise leave filtered execs launching into an internal network
   * with no path out, forever.
   */
  async function ensureEgressPlane(labelValue) {
    const networkName = networkFor(labelValue);
    // THE PROXY FIRST, and revalidated on every call: it is the shared resource, it
    // must exist before a network can be attached to it, and a cached success is not
    // proof it is still alive. If it was rebuilt, ensureProxy has already dropped
    // every network's cached attachment so each one is re-established below.
    const proxy = await ensureProxy();
    if (proxy.ok !== true) return { ok: false, networkName, reason: proxy.reason };

    const net = await ensureNetwork(networkName);
    if (net.ok !== true) return { ok: false, networkName, reason: net.reason };
    return { ok: true, networkName };
  }

  /** Read the allowlist fingerprint a running proxy was started with. */
  async function proxyFingerprintOf(name) {
    try {
      const res = await base.rawExec(['inspect', '--format', `{{index .Config.Labels "${ALLOWLIST_LABEL}"}}`, name], {
        timeoutMs: 10_000,
      });
      return res.code === 0 ? res.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  /** true / false / null when the network cannot be inspected at all. */
  async function networkIsInternal(name) {
    try {
      const res = await base.rawExec(['network', 'inspect', '--format', '{{.Internal}}', name], { timeoutMs: 10_000 });
      if (res.code !== 0) return null;
      return res.stdout.trim() === 'true';
    } catch {
      return null;
    }
  }

  async function removeNetwork(name) {
    try {
      await base.rawExec(['network', 'rm', name], { timeoutMs: 15_000 });
    } catch {
      // Best effort; the network carries our owner label for later cleanup.
    }
    ownNetworks.delete(name);
    networkPromises.delete(name);
  }

  /** Run a raw runtime CLI command through the base backend's injected runner. */
  async function runCli(args, timeoutMs) {
    return base.rawExec(args, { timeoutMs });
  }

  /** base.serviceLogs, never throwing. */
  async function serviceLogsOf(name) {
    try {
      const res = await base.serviceLogs(name);
      return typeof res?.logs === 'string' ? res.logs : '';
    } catch {
      return '';
    }
  }

  /** base.serviceStatus, never throwing. */
  async function serviceStatusOf(name) {
    try {
      return await base.serviceStatus(name);
    } catch {
      return { ok: false, exists: false, running: false, exitCode: null };
    }
  }

  /**
   * Run a one-shot command, translating a FILTERED request into the enforced
   * internal-network + proxy posture.
   *
   * `none` passes straight through to the base backend unchanged, so the
   * total-deny posture behaves identically whichever backend is composed.
   */
  async function runOneShot(spec = {}) {
    const { network = NETWORK_DENY_ALL } = spec;

    // Anything that is not a filtering request goes straight to the base backend,
    // which enforces total-deny and refuses whatever it cannot enforce. So the
    // `none` posture behaves identically whichever backend is composed.
    if (network !== NETWORK_FILTERED) return base.runOneShot(spec);

    const plane = await ensureEgressPlane(spec.labelValue ?? spec.name);
    if (plane.ok !== true) {
      // FAIL CLOSED: no enforcement plane means no network, not "some network".
      throw new Error(`${EGRESS_PLANE_UNAVAILABLE} ${plane.reason ?? ''}`.trim());
    }

    // The translation. The caller's env (secrets) is preserved, and the proxy
    // variables are applied ON TOP: they are the enforcement configuration, so a
    // project-named secret called `HTTPS_PROXY` or `NO_PROXY` must not be able to
    // redirect or disable the egress control.
    return base.runOneShot({
      ...spec,
      network: plane.networkName,
      env: { ...(spec.env ?? {}), ...sandboxProxyEnv },
    });
  }

  return Object.freeze({
    bin,
    image,
    isAvailable: base.isAvailable,
    canLaunch: base.canLaunch,
    runOneShot,
    remove: base.remove,
    reapOrphans: base.reapOrphans,
    startService: base.startService,
    serviceStatus: base.serviceStatus,
    serviceLogs: base.serviceLogs,
    stopService: base.stopService,
    // THE CAPABILITY THIS BACKEND EXISTS FOR.
    supportsEgressFiltering: true,
    supportsServices: true,
    rawExec: base.rawExec,
    // Introspection for composition + tests.
    allowedHosts: Object.freeze([...hosts]),
    allowlistFingerprint: fingerprint,
    networkPrefix,
    networkFor,
    proxyName,
    proxyPort,
    egressNetwork,
    ownerLabel: OWNER_LABEL,
    ensureEgressPlane,
    sandboxProxyEnv: Object.freeze({ ...sandboxProxyEnv }),
    buildRunArgs: base.buildRunArgs,
    cgroupFlagsFor: base.cgroupFlagsFor,
  });
}
