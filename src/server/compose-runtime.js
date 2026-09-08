/**
 * compose-runtime.js — the PROJECT-RUNTIME composition root (final wiring pass).
 *
 * THE GAP THIS CLOSES: every collaborator the Builder Server needs to run a real
 * create -> build -> preview flow was BUILT and unit-tested, but no code path in
 * src/ ever constructed one for production. `startPlatformServer` injected only
 * { authService, provider, observability }, so in the live process:
 *
 *   - POST /projects was NOT ROUTED AT ALL (it is gated on an injected
 *     projectManager), so a Project could not be created over HTTP;
 *   - /preview, /preview/restart, /theme and /workspace-experience were likewise
 *     unrouted;
 *   - no QuotaManager gated the turn or create paths, so Rate_Limits and
 *     Resource_Quotas were UNENFORCED in the only composition that matters;
 *   - no projectResolver was injected, so the server's gate fell back to
 *     `resource = { id: projectId, ownerId: account.id }` — SELF-OWNED BY
 *     CONSTRUCTION. Any authenticated account could open a Session on ANY
 *     projectId string. ProjectRegistry.resolver() was written for exactly this
 *     seam (see its docstring) and was never connected;
 *   - no sandboxManager or layout was injected, so the agent's working directory
 *     resolution fell all the way through to `process.cwd()` — a live turn would
 *     have run the Builder_Agent, with file-write tools, in the SERVER'S OWN
 *     SOURCE TREE rather than in a Project sandbox.
 *
 * This module is that missing production wiring and nothing more. It composes the
 * EXISTING factories through their EXISTING seams, in the style of
 * src/ops/compose.js: one `compose*` factory taking a single destructured options
 * object, every clock/collaborator/backend injected, duck-typed requirements
 * validated up front, `Object.freeze` on the result, and a `serverOptions()`
 * bundle designed to be spread straight into createBuilderServer.
 *
 * PER-OWNER STORES (a correctness trap this avoids). SnapshotStore,
 * PersistenceStore and SecretStore each pin an `ownerId` AT CONSTRUCTION, and the
 * layout derives their paths from it — `controlSnapshotRegistryPath(ownerId,
 * projectId)`, `controlSecretPath(ownerId, projectId, name)`. ProjectManager and
 * SandboxManager, however, are single instances serving every account. Handing
 * them one store pinned to a placeholder owner would write every account's
 * snapshot metadata and secrets into ONE owner directory, collapsing the
 * per-owner storage-path isolation axis (Req 7.6). So instead this composes a
 * per-owner INSTANCE CACHE behind an owner-agnostic facade that resolves each
 * call's owner from the ProjectRegistry (projectId -> ownerId) and delegates to
 * that owner's store. An unregistered projectId resolves to no owner and is
 * refused rather than written somewhere arbitrary.
 *
 * SEAMS THAT REMAIN SEAMS. The DevServer (src/project/dev-server.js) is
 * deliberately inert — it records intent and synthesizes a placeholder URL,
 * launching nothing. Wiring it makes the Preview LIFECYCLE reachable (status
 * frames, restart accounting, publish-on-commit) but does NOT serve a real
 * preview; that needs a real dev-server implementation behind the same seam. The
 * container backend IS the real docker CLI path, but it cannot be exercised in a
 * hermetic test, so `createBackend` is injected. Neither is faked as working.
 *
 * Node stdlib only; adds no runtime dependency.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { PROVIDERS } from '../engine/plumby.js';
import { DEFAULT_MAX_SANDBOXES } from '../sandbox/sandbox-manager.js';
import { createStorageLayout } from '../storage/layout.js';
import { createProjectRegistry } from '../project/project-registry.js';
import { createProjectManager } from '../project/project-manager.js';
import { createDevServer } from '../project/dev-server.js';
import { createContainerDevServer } from '../project/container-dev-server.js';
import { createBuildService } from '../project/build-service.js';
import { createContainerBuild } from '../project/container-build.js';
import { createSelfHostedDeploy } from '../project/self-hosted-deploy.js';
import { createPreviewController } from '../project/preview-controller.js';
import { createProjectOriginWithTemplates } from '../project/index.js';
import { createSandboxManager } from '../sandbox/sandbox-manager.js';
import { createContainerBackend } from '../sandbox/container-backend.js';
import { createFilteringContainerBackend } from '../sandbox/filtering-container-backend.js';
import { DEFAULT_PACKAGE_REGISTRY_HOSTS } from '../sandbox/egress.js';
import { createCommandGuard } from '../sandbox/command-guard.js';
import { createQuotaManager } from '../ops/quota-manager.js';
import { createSecretStore } from '../secrets/secret-store.js';
import { createSnapshotStore } from '../persistence/snapshot-store.js';
import { createPersistenceStore } from '../persistence/persistence-store.js';
import { createThemeStore } from '../presentation/theme-store.js';
import { createWorkspaceExperienceStore } from '../presentation/workspace-experience-store.js';
import { createProviderResolver } from './provider-resolver.js';
import {
  createConnectorService,
  createConnectorBindingStore,
  createConnectorsSteeringWriter,
  defaultConnectorCatalog,
} from '../connectors/index.js';
import { createSkillLibrary } from '../skills/library.js';
import { createMemoryStore } from '../memory/store.js';
import { createProjectExport, createLockinAudit } from '../portability/index.js';
import { createAuthorizer, createShareLinkStore, createShareLinkService } from '../auth/index.js';

/**
 * Where the platform keeps its export trees + control plane, when AAB_DATA_DIR is
 * unset.
 *
 * DELIBERATELY OUTSIDE THE SERVER'S OWN TREE. An earlier default of `.data`
 * resolved to `<server cwd>/.data`, which put every Project's sandbox mount — the
 * agent's writable working directory — INSIDE the server's source checkout. That
 * is the very hazard this composition exists to remove (see the header note about
 * cwd falling through to process.cwd()), so the default must not reintroduce a
 * milder version of it. A real deployment should set AAB_DATA_DIR to a mounted
 * volume; see docs/DEPLOY.md.
 */
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.ai-app-builder', 'data');

/**
 * Non-provider environment variables whose VALUES are platform credentials.
 * Provider API-key names are DERIVED from plumby's own provider table (see
 * platformSecretEnvNames) rather than hand-listed, because a hand-copied list
 * silently drifts — it had already missed GOOGLE_API_KEY, which plumby accepts as
 * a Gemini alias.
 */
const PLATFORM_SECRET_ENV_NAMES_BASE = Object.freeze([
  'OIDC_CLIENT_SECRET',
  'OIDC_STATE_SIGNING_KEY',
]);

/**
 * Every environment variable whose VALUE is a platform credential and must
 * therefore be redactable everywhere the AuditLog / Observability / CommandGuard
 * write. Provider key names come from plumby's PROVIDERS table through the engine
 * boundary, so adding a provider upstream cannot leave its key unredacted here.
 *
 * WHY THIS EXISTS: composePlatformOps builds the ONE central redactor from a
 * seeded secret set, and the entry point previously called it with NO
 * secretProvider — so redaction was a documented no-op in the only composition
 * that ships. A redactor can only redact values it was constructed with.
 *
 * SCOPE, stated precisely: this covers the PLATFORM's own credentials, which are
 * known at boot. It does NOT cover per-project Connector secrets — those are read
 * from the per-owner SecretStore at exec time, long after the redactor is built,
 * so a Connector credential appearing in captured stderr is NOT redacted by this.
 * Feeding those in dynamically needs a provider seam on the redactor and is a
 * documented follow-up, not something this pass claims.
 */
export const PLATFORM_SECRET_ENV_NAMES = Object.freeze([
  ...new Set([
    ...Object.values(PROVIDERS ?? {}).flatMap((p) => (Array.isArray(p?.keys) ? p.keys : [])),
    ...PLATFORM_SECRET_ENV_NAMES_BASE,
  ]),
]);

/**
 * Sandbox egress postures.
 *
 * - 'none' (DEFAULT): empty allowlist, so the SandboxManager asks for network
 *   `none` and the container runs with no network at all. Commands RUN; anything
 *   needing the network (npm install) cannot.
 * - 'registry': allow the package-registry hosts. This produces the
 *   NETWORK_FILTERED mode, which the CLI container backend CANNOT enforce
 *   (`supportsEgressFiltering: false`) and therefore FAILS CLOSED on — every exec
 *   is refused. Only select this with a backend that can install per-host rules.
 *
 * WHY THE DEFAULT MATTERS: the SandboxManager's own default packageRegistryHosts
 * is ['registry.npmjs.org'], which makes the allowlist non-empty, which selects
 * `filtered`, which the real backend refuses. Composing with no egress config
 * therefore produced a sandbox in which EVERY command was denied before launch —
 * fail-closed, but totally non-functional, and invisible behind a test fake that
 * accepted `filtered`. The composition now states the posture explicitly.
 */
export const SANDBOX_EGRESS_MODES = Object.freeze(['none', 'registry']);

/**
 * THE PREVIEW POSTURE (AAB_PREVIEW_NETWORK).
 *
 * A Preview is only real if a dev server is actually listening and the host can
 * reach it. That needs a PUBLISHED PORT, and a published port needs a routable
 * container network — `--network none` gives the container only a loopback
 * interface, so a published port has no DNAT target and can never answer (see
 * PUBLISH_REQUIRES_ROUTABLE_NETWORK).
 *
 * That collides with deny-by-default egress, and the collision is REAL, not
 * cosmetic: the code a Preview runs is generated, untrusted code, so attaching it
 * to a routable network grants exactly the egress the sandbox posture withholds.
 * We refuse to make that trade silently. So:
 *
 * - UNSET (default): the Dev_Server stays the INERT seam. Identical behavior to
 *   before — the Preview lifecycle is wired, no container is launched, and the URL
 *   is honestly reported as a placeholder that serves nothing. Nothing regresses,
 *   and no egress is opened behind the operator's back.
 * - SET to a container network name: previews are REAL. The dev server is launched
 *   detached inside the project's Isolation_Boundary and published on
 *   AAB_PREVIEW_HOST_IP (loopback by default). The operator chooses the network
 *   and therefore chooses how much egress the previewed app gets; a network that
 *   restricts egress while permitting inbound is the containing choice.
 */
export function resolvePreviewConfig(env = process.env) {
  const network = (env.AAB_PREVIEW_NETWORK ?? '').trim();
  if (network === '') return { enabled: false, network: null };
  return {
    enabled: true,
    network,
    hostIp: (env.AAB_PREVIEW_HOST_IP ?? '').trim() || '127.0.0.1',
    // Range-validated HERE rather than left to fail every start() later: an
    // out-of-range port is a boot-time configuration error, and the rest of this
    // preview config fails loudly at composition too.
    ...(tcpPort(env.AAB_PREVIEW_CONTAINER_PORT) !== undefined
      ? { containerPort: tcpPort(env.AAB_PREVIEW_CONTAINER_PORT) }
      : {}),
    ...(previewPortRange(env) ? { portRange: previewPortRange(env) } : {}),
  };
}

/**
 * Resolve THIS platform instance's identity — the "deployment slot" every container
 * we create is stamped with (see INSTANCE_LABEL).
 *
 * It must be STABLE across a process restart in the same slot (so a restarted
 * process recognizes the containers its crashed predecessor left behind) and
 * DISTINCT between concurrently-running instances (so a startup reap cannot destroy
 * a live sibling's sandboxes). The hostname satisfies both in the deployments that
 * matter: a supervisor restarting the process inside the same container/pod keeps
 * it, and two pods have different ones. `AAB_INSTANCE_ID` overrides it for a
 * deployment where the hostname is not the right slot key.
 *
 * Sanitized to the character set a container label value can carry without
 * quoting, and truncated, so it can never distort the argv it lands in.
 */
export function resolveInstanceId(env = process.env) {
  const raw = (env.AAB_INSTANCE_ID ?? '').trim() || os.hostname() || '';
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+/, '').slice(0, 64);
  return cleaned !== '' ? cleaned : 'aab-instance';
}

/** Parse a legal TCP port, or undefined when unset/invalid/out of range. */
function tcpPort(raw) {
  const n = positiveInt(raw);
  return n !== undefined && n <= 65_535 ? n : undefined;
}

/**
 * Parse `AAB_PREVIEW_PORT_RANGE` as `from-to`. An unparseable or inverted range
 * yields undefined so the module default applies, rather than a guess.
 */
function previewPortRange(env) {
  const raw = (env.AAB_PREVIEW_PORT_RANGE ?? '').trim();
  if (raw === '') return undefined;
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(raw);
  if (!match) return undefined;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return undefined;
  if (from < 1 || to > 65_535 || from > to) return undefined;
  return { from, to };
}

/**
 * Build the live secret set to seed the central redactor, from the environment.
 * Returns the { secretValues, secretNames } shape composePlatformOps accepts.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 */
export function platformSecretSet(env = process.env) {
  const secretValues = [];
  const secretNames = [];
  for (const name of PLATFORM_SECRET_ENV_NAMES) {
    const value = env[name];
    secretNames.push(name);
    if (typeof value === 'string' && value.trim() !== '') secretValues.push(value);
  }
  return { secretValues, secretNames };
}

/**
 * Resolve the data directory. Absolute paths are honored; a relative value is
 * resolved against the process cwd so the on-disk location is unambiguous.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 */
export function resolveDataDir(env = process.env) {
  const raw = (env.AAB_DATA_DIR ?? '').trim();
  return raw !== '' ? path.resolve(raw) : DEFAULT_DATA_DIR;
}

/**
 * The public base URL a minted Share_Link is rendered against (Req 15.5). When
 * set, POST /settings/share returns an ABSOLUTE `${base}/<token>` URL a user can
 * copy and open from outside the deploy; when unset the builder-server falls
 * back to a relative `/share/<token>` path (its documented default), so this is
 * genuinely optional. Read from AAB_SHARE_BASE_URL, else the platform's public
 * base URL (PUBLIC_BASE_URL) when the operator has set one. A blank value is
 * treated as unset (returns undefined) so nothing is threaded and the relative
 * fallback applies.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {string|undefined}
 */
export function resolveShareLinkBaseUrl(env = process.env) {
  const raw = (env.AAB_SHARE_BASE_URL ?? env.PUBLIC_BASE_URL ?? '').trim();
  return raw !== '' ? raw.replace(/\/+$/, '') : undefined;
}

/**
 * Resolve the public base URL a PUBLISHED (self-hosted deployed) site is rendered
 * against. Same shape and precedence as resolveShareLinkBaseUrl: when set, a deploy
 * returns an ABSOLUTE URL a user can open from outside the deploy; when unset the
 * publisher returns a relative `/live/...` path, which is genuinely usable from the
 * Web UI's own origin. A blank value is treated as unset.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {string|undefined}
 */
export function resolvePublishedBaseUrl(env = process.env) {
  const raw = (env.AAB_PUBLISHED_BASE_URL ?? env.PUBLIC_BASE_URL ?? '').trim();
  return raw !== '' ? raw.replace(/\/+$/, '') : undefined;
}

/**
 * Resolve the key a published site's URL capability signature is derived from.
 *
 * The signature is what makes `/live/<projectId>/<target>/<signature>/` a capability
 * rather than an enumerable path, so the key must be a real secret. Set
 * `AAB_PUBLISHED_SIGNING_KEY` (>= 32 characters) for a URL that survives a restart
 * and is identical across replicas. With none set — or one too short to be a
 * credential — a random per-process key is generated: publishing still works, but
 * every previously issued deploy URL stops resolving after a restart. Reported so a
 * deployment can see which posture it got, exactly like the OIDC state key.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{ key:string, source:'configured'|'ephemeral' }}
 */
export function resolvePublishedSigningKey(env = process.env) {
  const raw = (env.AAB_PUBLISHED_SIGNING_KEY ?? '').trim();
  if (raw.length >= 32) return { key: raw, source: 'configured' };
  return { key: crypto.randomBytes(32).toString('base64'), source: 'ephemeral' };
}

/** Parse a positive-integer env override, or undefined when unset/invalid. */
function positiveInt(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * How long a Sandbox boundary may sit unused before it is reclaimed.
 *
 * THIS IS WHAT GIVES THE CONCURRENCY COUNT A DOWNWARD EDGE. See
 * `trackSandboxUsage` for the full reasoning; in short, nothing releases a
 * boundary on the success path, so without reclamation the "concurrent sandboxes"
 * count only ever grows and the quota that reads it eventually refuses everything
 * until the process restarts.
 */
export const DEFAULT_SANDBOX_IDLE_MS = 15 * 60 * 1000;

/**
 * The composed global concurrent-Sandbox ceiling.
 *
 * Chosen to sit WELL BELOW the SandboxManager's own capacity
 * (DEFAULT_MAX_SANDBOXES = 256) on purpose. Setting the ceiling equal to that
 * capacity is a trap: the quota denies at `current >= max` BEFORE the acquire
 * that would have triggered LRU eviction at `size > maxSandboxes`, so eviction
 * can never run from a request path and the count sticks at the ceiling forever.
 * With the ceiling below capacity, LRU is never the binding mechanism — idle
 * reclamation is — and the ceiling is both enforceable and survivable.
 */
export const DEFAULT_MAX_CONCURRENT_SANDBOXES = Math.floor(DEFAULT_MAX_SANDBOXES / 4);

/**
 * Resolve the Resource_Quota config from the environment.
 *
 * WHY THE CEILING DIFFERS FROM THE MODULE DEFAULT. The quota is enforced against
 * `sandboxManager.activeProjectIds().length`, and that set is a cache of SANDBOX
 * BOUNDARY HANDLES, not a count of running containers: a handle is created on
 * project create and on the first turn (resolving the agent cwd), and nothing
 * releases it on the success path. The module's default ceiling of 10 against a
 * monotonically growing set wedges the whole platform once ten Projects have been
 * touched — every later create AND every turn 429s until a restart. The fix is a
 * downward edge (idle reclamation, see trackSandboxUsage) plus a ceiling below the
 * manager's capacity so LRU eviction is never what has to save us.
 *
 * maxConcurrentSandboxesPerAccount stays UNSET by default — the concrete value is
 * a deferred product decision (see quota-manager.js), and inventing one here would
 * be policy, not wiring. Setting it enables the Req 23 anti-starvation ceiling,
 * without which one account can consume the whole global allowance.
 */
export function resolveQuotaConfig(env = process.env) {
  const maxConcurrent = positiveInt(env.AAB_MAX_CONCURRENT_SANDBOXES) ?? DEFAULT_MAX_CONCURRENT_SANDBOXES;
  const perAccount = positiveInt(env.AAB_MAX_CONCURRENT_SANDBOXES_PER_ACCOUNT);
  const maxProjects = positiveInt(env.AAB_MAX_TOTAL_PROJECTS);
  return {
    quota: {
      maxConcurrentSandboxes: maxConcurrent,
      ...(perAccount !== undefined ? { maxConcurrentSandboxesPerAccount: perAccount } : {}),
      ...(maxProjects !== undefined ? { maxTotalProjects: maxProjects } : {}),
    },
  };
}

/**
 * Resolve the sandbox egress posture (see SANDBOX_EGRESS_MODES). An unrecognized
 * value falls back to the restrictive 'none' rather than guessing.
 */
export function resolveEgressConfig(env = process.env) {
  const mode = (env.AAB_SANDBOX_EGRESS ?? '').trim().toLowerCase();
  const selected = SANDBOX_EGRESS_MODES.includes(mode) ? mode : 'none';
  // Extra hosts the operator deliberately adds to the sandbox allowlist (e.g. a
  // private registry mirror, or a connector endpoint a build genuinely needs).
  // Only meaningful in 'registry' mode; in 'none' there is no network to allow on.
  const extra = (env.AAB_SANDBOX_EGRESS_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return {
    mode: selected,
    // 'none' => empty allowlist => the SandboxManager asks for network `none`.
    // 'registry' => leave the manager's own default hosts in place (filtered).
    ...(selected === 'none' ? { packageRegistryHosts: [] } : {}),
    ...(selected !== 'none' && extra.length > 0 ? { extraHosts: extra } : {}),
  };
}

/**
 * Compose the project runtime.
 *
 * @param {object} args
 * @param {object} args.composed  the composePlatformOps result (audit/observability/redactor
 *        + the *Options() bundles). REQUIRED: every choke point here routes through it.
 * @param {Record<string,string|undefined>} [args.env=process.env]
 * @param {() => number} [args.now]  injectable ms clock. SCOPE, precisely: it
 *        drives the collaborators composed HERE — quota windows, preview/project
 *        SLOs and idle-sandbox reclamation. It does NOT reach createBuilderServer
 *        (the caller passes that separately) nor the ISO-timestamp clocks inside
 *        the Snapshot/Persistence stores, which still read real time.
 * @param {(opts:object)=>object} [args.createBackend]  container-backend factory.
 *        Defaults to the REAL docker-CLI backend; injected in tests, which cannot
 *        run a container.
 * @param {(baseDir:string)=>object} [args.createLayout]  StorageLayout factory.
 * @returns {object} frozen runtime composition
 */
export function composeProjectRuntime({
  composed,
  env = process.env,
  now = () => Date.now(),
  createBackend = createContainerBackend,
  createFilteringBackend = createFilteringContainerBackend,
  createLayout = createStorageLayout,
} = {}) {
  if (!composed || !composed.auditLog || typeof composed.commandGuardOptions !== 'function') {
    throw new TypeError(
      'composeProjectRuntime requires the composePlatformOps result as `composed` ' +
        '(so audit/observability/redaction route through the SAME wired instances)',
    );
  }
  if (typeof now !== 'function') {
    throw new TypeError('composeProjectRuntime: now must be a function returning ms');
  }

  const dataDir = resolveDataDir(env);
  const layout = createLayout(dataDir);

  // The registry is the projectId -> ownerId authority, so it is built first: the
  // auth gate, the quota counters and every per-owner store dispatch depend on it.
  const registry = createProjectRegistry({ layout });

  /**
   * Resolve a projectId's owning account, or null when it is not registered.
   *
   * A registry read touches the filesystem, so it can THROW (corrupt or
   * unreadable control plane). That must not propagate: the same function backs
   * the server's projectResolver, and an escaping error would surface as a 500
   * whose message contains the absolute control-plane path. Failing to resolve is
   * therefore treated as "no owner" — which denies at the gate and refuses at the
   * per-owner facades, the correct fail-closed direction.
   */
  function ownerOf(projectId) {
    if (typeof projectId !== 'string' || projectId === '') return null;
    try {
      const resolved = registry.resolver(projectId);
      return resolved && typeof resolved.ownerId === 'string' ? resolved.ownerId : null;
    } catch (err) {
      // Deny, but NOT silently: a corrupt/unreadable control plane would otherwise
      // be indistinguishable from "no such project" — identical 401s to the
      // operator, and a misleading "not in the ProjectRegistry" from the per-owner
      // facades for a project that IS registered. The message is redacted through
      // the central redactor by the AuditLog before it is recorded.
      composed.auditLog.record({
        type: 'PROJECT_REGISTRY_UNREADABLE',
        at: now(),
        projectId,
        reason: err?.message ?? String(err),
      });
      return null;
    }
  }

  /** The server's projectResolver seam: deny (null) rather than throw. */
  function projectResolver(projectId) {
    const ownerId = ownerOf(projectId);
    return ownerId ? { id: projectId, ownerId } : null;
  }

  /**
   * A per-owner instance cache. `create(ownerId)` is called at most once per
   * owner; the returned `forProject(projectId)` resolves the owner from the
   * registry and returns THAT owner's instance, or null when the project is
   * unregistered (so nothing is ever written under a placeholder owner).
   */
  function perOwner(create) {
    const cache = new Map();
    function forOwner(ownerId) {
      let instance = cache.get(ownerId);
      if (!instance) {
        instance = create(ownerId);
        cache.set(ownerId, instance);
      }
      return instance;
    }
    return {
      forOwner,
      forProject(projectId) {
        const ownerId = ownerOf(projectId);
        return ownerId ? forOwner(ownerId) : null;
      },
      ownerCount: () => cache.size,
    };
  }

  const secretStores = perOwner((ownerId) =>
    createSecretStore({ layout, ownerId, ...composed.secretStoreOptions() }),
  );
  const persistenceStores = perOwner((ownerId) => createPersistenceStore({ layout, ownerId }));
  // Per-account ConnectorBindingStore instances (owner-pinned paths), backing
  // both the ConnectorService per account and the bound-connector listing on
  // GET /settings/connectors. See the WEB UI SETTINGS SURFACES section below.
  const connectorBindingStores = perOwner((ownerId) => createConnectorBindingStore({ layout, ownerId }));
  // The owner's SnapshotStore is paired with THAT owner's PersistenceStore, so
  // resume() can fall back to the most recent persisted tree for a project that
  // has no snapshot yet (Req 19.6) instead of finding nothing.
  const snapshotStores = perOwner((ownerId) =>
    createSnapshotStore({ layout, ownerId, persistenceStore: persistenceStores.forOwner(ownerId) }),
  );

  /**
   * SecretStore facade for the SandboxManager, which only needs
   * envForProject(projectId) to inject a project's secret env at exec time. An
   * unregistered project yields NO secret env rather than another owner's.
   */
  const secretStore = Object.freeze({
    envForProject(projectId) {
      const store = secretStores.forProject(projectId);
      return store ? store.envForProject(projectId) : {};
    },
  });

  /** Fail loudly rather than silently writing a registered project's data nowhere. */
  function requireStore(store, projectId, what) {
    if (!store) {
      throw new Error(
        `${what}: project ${JSON.stringify(projectId)} is not in the ProjectRegistry, ` +
          'so its owning account cannot be resolved and no per-owner store can be selected',
      );
    }
    return store;
  }

  /**
   * Build an owner-dispatching facade over a per-owner store.
   *
   * Methods are forwarded GENERICALLY with their arguments untouched, keyed on the
   * projectId in the first positional argument. Hand-copying each signature was
   * the alternative and it is a standing drift hazard — every one of these stores
   * takes `(projectId, ...rest)`, so forwarding preserves the real contract even
   * if a method gains a parameter later.
   *
   * `softMethods` answer without an owner (there is genuinely nothing to report
   * for an unregistered project); every other method REFUSES rather than writing a
   * registered account's data under a placeholder owner.
   */
  function ownerDispatchingFacade({ stores, label, methods, softMethods = {}, objectArgMethods = [] }) {
    const facade = {};
    for (const name of methods) {
      facade[name] = (projectId, ...rest) => {
        const store = stores.forProject(projectId);
        if (!store && Object.hasOwn(softMethods, name)) return softMethods[name];
        return requireStore(store, projectId, label)[name](projectId, ...rest);
      };
    }
    // onTurnComplete-style methods take a single { projectId, ... } object.
    for (const name of objectArgMethods) {
      facade[name] = (args = {}) => {
        // Report the ACTUAL fault. Resolving the owner first would blame a missing
        // registry entry ("project undefined is not in the ProjectRegistry") for a
        // call whose real problem is that no projectId was passed at all. With a
        // valid projectId the owner resolves and the store raises its OWN
        // validation error for the rest of the payload, unchanged.
        if (typeof args?.projectId !== 'string' || args.projectId === '') {
          throw new TypeError(`${label}: projectId is required to select the owning account's store`);
        }
        return requireStore(stores.forProject(args.projectId), args.projectId, label)[name](args);
      };
    }
    return Object.freeze(facade);
  }

  const snapshotStore = ownerDispatchingFacade({
    stores: snapshotStores,
    label: 'SnapshotStore',
    methods: ['commitSnapshot', 'commitExplicit', 'restore', 'resume', 'listSnapshots', 'latestSnapshot', 'deleteSnapshots'],
    objectArgMethods: ['onTurnComplete'],
  });

  const persistenceStore = ownerDispatchingFacade({
    stores: persistenceStores,
    label: 'PersistenceStore',
    methods: ['persist', 'persistPartial', 'persistNow', 'flush', 'hasPending', 'readPersistedTree', 'deleteProjectTree'],
    // An unregistered project has no pending write, which is a true answer.
    softMethods: { hasPending: false },
  });

  // The REAL container runtime path. Construction does not shell out, so a host
  // with no docker still boots and answers /healthz; a Sandbox acquire then fails
  // with the existing SANDBOX_ACQUIRE_FAILED 503 rather than a silent success.
  //
  // ORPHAN REAPING, and why it is not here: container-runtime I/O must not sit on
  // the boot path, because /healthz has to answer on a host with no runtime. The
  // startup reap therefore lives in src/server/start.js, where it is kicked off
  // AFTER listen() resolves and is never awaited — see src/server/startup-reap.js
  // for the three properties it guarantees (never blocks /healthz, never fails
  // boot, a missing runtime is a no-op). Construction here still does no I/O.
  // Per-project orphan cleanup continues to happen on release().
  const containerBin = (env.CONTAINER_BIN ?? '').trim() || undefined;
  const containerImage = (env.SANDBOX_IMAGE ?? '').trim() || undefined;

  // The egress posture is stated EXPLICITLY rather than inherited: the manager's
  // own default allowlist selects a network mode the plain CLI backend refuses,
  // which denies every command in every sandbox. See SANDBOX_EGRESS_MODES.
  const egress = resolveEgressConfig(env);

  /**
   * WHICH BACKEND ENFORCES THE POSTURE.
   *
   * 'none' -> the plain CLI backend. It enforces total-deny (`--network none`)
   * genuinely, and refuses anything it cannot enforce.
   *
   * 'registry' -> the FILTERING backend, which can actually honor a populated
   * allowlist: an `--internal` network with no route out, plus one allowlisting
   * proxy that is the only path out. Before this existed, 'registry' selected a
   * mode the plain backend refused, so choosing it denied EVERY command — the
   * posture was unusable, which is why `npm install` could not work in any posture.
   *
   * Construction still does no I/O (the network/proxy come up lazily on the first
   * filtered exec), so a host with no runtime still boots and answers /healthz.
   */
  const egressAllowedHosts = [...DEFAULT_PACKAGE_REGISTRY_HOSTS, ...(egress.extraHosts ?? [])];
  // Stamped on every container we create, so an orphan of a CRASHED PRIOR PROCESS
  // in this slot is distinguishable from a LIVE SIBLING instance's container. See
  // resolveInstanceId and src/server/startup-reap.js.
  const instanceId = resolveInstanceId(env);
  const backend =
    egress.mode === 'registry'
      ? createFilteringBackend({
          allowedHosts: egressAllowedHosts,
          instanceId,
          ...(containerBin ? { bin: containerBin } : {}),
          ...(containerImage ? { image: containerImage } : {}),
        })
      : createBackend({
          instanceId,
          ...(containerBin ? { bin: containerBin } : {}),
          ...(containerImage ? { image: containerImage } : {}),
        });

  const baseSandboxManager = createSandboxManager({
    layout,
    backend,
    secretStore,
    config: {
      ...(egress.packageRegistryHosts ? { packageRegistryHosts: egress.packageRegistryHosts } : {}),
      ...(egress.mode === 'registry' ? { packageRegistryHosts: egressAllowedHosts } : {}),
    },
  });

  /**
   * Give the live-Sandbox set a DOWNWARD EDGE by reclaiming idle boundaries.
   *
   * THE PROBLEM THIS SOLVES. `sandboxManager.acquire(projectId)` creates a
   * long-lived boundary record, and nothing releases it on any success path: a
   * create acquires one, and so does the first turn (the server resolves the
   * agent's cwd through acquire). The concurrent-Sandbox Resource_Quota is
   * enforced against the size of that set, so the count only ever grows — and
   * once it reaches the ceiling, EVERY create and EVERY turn is refused until the
   * process restarts. The SandboxManager's LRU eviction cannot rescue it either,
   * because the quota denies at `current >= max` before the acquire that would
   * trigger eviction at `size > maxSandboxes`.
   *
   * THE FIX, at the composition level (no built module changes). Boundaries are
   * cheap bookkeeping — the container backend is one-shot per exec, so an idle
   * boundary holds a mount path, not a running container. So track last use and
   * release boundaries idle beyond `idleMs`. The count now falls on its own, the
   * ceiling becomes survivable (recovery is time-bounded, not restart-only), and
   * every bit of it is driven by the INJECTED clock, so tests advance time instead
   * of waiting.
   *
   * KNOWN LIMITATION, stated rather than hidden: at exactly the ceiling, a turn on
   * a project that ALREADY holds a boundary is also refused, because the quota
   * seam takes no per-project context (`concurrencyCount()` receives no projectId)
   * and so cannot exclude the requester. Idle reclamation clears that within
   * idleMs instead of requiring a restart. Fixing it properly means a per-project
   * exclusion in the QuotaManager/Builder Server, which is beyond a wiring pass.
   */
  function trackSandboxUsage(manager, idleMs) {
    /** projectId -> last-use ms, on the injected clock. */
    const lastUsedAt = new Map();

    /**
     * Boundaries reclaimed but whose async teardown has not landed yet.
     *
     * REQUIRED FOR CORRECTNESS, not bookkeeping neatness: `release()` is async, so
     * a reclaimed projectId is still in `manager.activeProjectIds()` for a while.
     * Without this set, the next in-use scan would find no last-use entry for it,
     * hit the defensive "never seen, assume in use" branch, and RESURRECT it as
     * in-use — making the count oscillate and the ceiling stick.
     */
    const reclaiming = new Set();

    /**
     * projectId -> count of exec() runs currently in flight.
     *
     * Reclamation must never tear down a boundary that is running a command. The
     * SandboxManager's own LRU eviction explicitly skips boundaries with in-flight
     * work; a purely time-based sweep has no such signal, so the wrapper counts its
     * own. Without this, lowering AAB_SANDBOX_IDLE_MS below a command's wall-clock
     * time would force-remove containers mid-run.
     */
    const inFlight = new Map();

    function touch(projectId) {
      if (typeof projectId === 'string' && projectId !== '') {
        // Using a boundary again cancels its pending reclamation.
        reclaiming.delete(projectId);
        lastUsedAt.set(projectId, now());
      }
      return projectId;
    }

    /**
     * The boundaries actually IN USE — acquired or exec'd within idleMs.
     *
     * This, not the raw boundary set, is what "concurrent sandboxes" means for a
     * quota, and it is what makes the count fall SYNCHRONOUSLY: `release()` is
     * async (it removes and reaps containers before dropping its entry), so a
     * sweep cannot shrink `activeProjectIds()` in time for the synchronous quota
     * check that triggered it. Excluding idle boundaries from the count is exact
     * and immediate; the release that follows is cleanup.
     */
    function activeProjectIdsInUse() {
      const cutoff = now() - idleMs;
      return manager.activeProjectIds().filter((projectId) => {
        // Already reclaimed; its teardown is simply still in flight.
        if (reclaiming.has(projectId)) return false;
        const at = lastUsedAt.get(projectId);
        if (at === undefined) {
          // A boundary we never saw acquired (defensive): start its clock now
          // rather than treating something possibly in use as idle.
          lastUsedAt.set(projectId, now());
          return true;
        }
        return at > cutoff;
      });
    }

    /** Release every boundary unused for longer than idleMs. Returns the count. */
    function reclaimIdle() {
      const cutoff = now() - idleMs;
      let reclaimed = 0;
      // Forget boundaries the BASE manager dropped on its own (exec auto-release,
      // LRU eviction) — those bypass this wrapper's release(), so their entries
      // would otherwise accumulate for the process lifetime.
      const live = new Set(manager.activeProjectIds());
      for (const projectId of lastUsedAt.keys()) {
        if (!live.has(projectId)) lastUsedAt.delete(projectId);
      }

      for (const projectId of manager.activeProjectIds()) {
        if (reclaiming.has(projectId)) continue; // teardown already in flight
        // Never tear down a boundary with a command in flight — the manager's own
        // eviction refuses to, and so must this.
        if ((inFlight.get(projectId) ?? 0) > 0) continue;
        const at = lastUsedAt.get(projectId);
        if (at === undefined) {
          lastUsedAt.set(projectId, now());
          continue;
        }
        if (at <= cutoff) {
          lastUsedAt.delete(projectId);
          reclaiming.add(projectId);
          reclaimed += 1;
          // Fire-and-forget: release() is async and its container teardown must
          // not block the request that triggered the sweep. The boundary is
          // already out of the in-use count, so the count falls immediately.
          Promise.resolve()
            .then(() => {
              // CANCELLATION GUARD. The commonest trigger for this whole sweep is
              // the first turn after an idle period: POST /message runs the quota
              // check (which schedules this release) and THEN acquires the boundary
              // for the agent's cwd. Without this guard the release lands after
              // that re-acquire, deletes the fresh record, and reaps the project's
              // containers BY LABEL — killing the command the turn just launched.
              // touch() is the only thing that re-adds a last-use entry, so its
              // presence means "re-acquired since we scheduled this": stand down.
              if (lastUsedAt.has(projectId)) return null;
              return manager.release(projectId);
            })
            .then((result) => {
              // release() reports non-throwing teardown/reap failures in `errors`.
              if (result && Array.isArray(result.errors) && result.errors.length > 0) {
                composed.auditLog.record({
                  type: 'SANDBOX_RECLAIM_INCOMPLETE',
                  at: now(),
                  projectId,
                  reason: result.errors.join('; '),
                });
              }
            })
            .catch((err) => {
              // Never silent: a container that fails to tear down would otherwise
              // accumulate with no signal, in a composition where every other
              // anomaly reaches the audit log.
              composed.auditLog.record({
                type: 'SANDBOX_RECLAIM_FAILED',
                at: now(),
                projectId,
                reason: err?.message ?? String(err),
              });
            })
            .finally(() => reclaiming.delete(projectId));
        }
      }
      return reclaimed;
    }

    return Object.freeze({
      ...manager,
      acquire(projectId) {
        touch(projectId);
        return manager.acquire(projectId);
      },
      async exec(projectId, ...rest) {
        touch(projectId);
        inFlight.set(projectId, (inFlight.get(projectId) ?? 0) + 1);
        try {
          return await manager.exec(projectId, ...rest);
        } finally {
          const remaining = (inFlight.get(projectId) ?? 1) - 1;
          if (remaining > 0) inFlight.set(projectId, remaining);
          else inFlight.delete(projectId);
          // A long command counts as use at COMPLETION too, so a run that spans
          // the idle window does not leave the boundary instantly reclaimable.
          touch(projectId);
        }
      },
      release(projectId) {
        lastUsedAt.delete(projectId);
        reclaiming.delete(projectId);
        return manager.release(projectId);
      },
      reclaimIdle,
      activeProjectIdsInUse,
      idleMs,
    });
  }

  const sandboxIdleMs = positiveInt(env.AAB_SANDBOX_IDLE_MS) ?? DEFAULT_SANDBOX_IDLE_MS;
  const sandboxManager = trackSandboxUsage(baseSandboxManager, sandboxIdleMs);

  // Rate_Limits and Resource_Quotas, counted from the REAL registry and the REAL
  // set of live sandboxes rather than from constants.
  const quotaManager = createQuotaManager({
    config: resolveQuotaConfig(env),
    sandboxManager,
    projectCounter: (accountId) => registry.countForOwner(accountId),
    // Sweep idle boundaries BEFORE counting, so the count reflects sandboxes
    // actually in use rather than every project ever touched since boot. This is
    // the downward edge that keeps the ceiling from becoming permanent.
    concurrencyCount: () => {
      sandboxManager.reclaimIdle();
      return sandboxManager.activeProjectIdsInUse().length;
    },
    accountConcurrencyCount: (accountId) =>
      sandboxManager.activeProjectIdsInUse().filter((projectId) => ownerOf(projectId) === accountId).length,
    auditSink: composed.auditLog,
    now,
  });

  // Command execution choke point: confirm-class decisions land on the wired
  // AuditLog with the command redacted through the central redactor.
  const commandGuard = createCommandGuard({
    manager: sandboxManager,
    ...composed.commandGuardOptions(),
  });

  /**
   * The Dev_Server behind the Preview. REAL (a detached, port-publishing container
   * inside the project's Isolation_Boundary) when the operator has named a preview
   * network; otherwise the inert seam, unchanged. See resolvePreviewConfig.
   *
   * `previewController` is referenced by the onExit callback before it exists —
   * that is fine and deliberate: the callback only ever runs later, when a started
   * Dev_Server dies, and routing that through notifyExit is what preserves the
   * served preview and offers a restart (Req 3.6).
   */
  const preview = resolvePreviewConfig(env);
  // If the operator explicitly asked for real previews, do NOT quietly fall back
  // to the inert seam — that is how you end up serving placeholder URLs while
  // believing previews work. Refuse to compose instead.
  if (preview.enabled && typeof backend.startService !== 'function') {
    throw new TypeError(
      'AAB_PREVIEW_NETWORK is set, but the composed container backend cannot run ' +
        'long-running service containers (no startService). A real Preview needs one; ' +
        'refusing to fall back to the inert Dev_Server seam silently.',
    );
  }
  let previewController;
  const devServer = preview.enabled
    ? createContainerDevServer({
        backend,
        network: preview.network,
        hostIp: preview.hostIp,
        ...(preview.containerPort !== undefined ? { containerPort: preview.containerPort } : {}),
        ...(preview.portRange ? { portRange: preview.portRange } : {}),
        ...(containerImage ? { image: containerImage } : {}),
        now,
        onExit: (projectId, info) => {
          previewController?.notifyExit({ projectId, error: info?.error });
        },
      })
    : createDevServer();
  previewController = createPreviewController({ devServer, sandboxManager, now });

  const projectOrigin = createProjectOriginWithTemplates({
    persistenceStore,
    snapshotStore,
    sandboxManager,
    projectRegistry: registry,
    now,
  });

  const projectManager = createProjectManager({
    registry,
    sandboxManager,
    quotaManager,
    snapshotStore,
    projectOrigin,
    persistenceStore,
    previewController,
    devServer,
    now,
  });

  const themeStore = createThemeStore({ layout });
  const workspaceExperienceStore = createWorkspaceExperienceStore({ layout });

  // ==========================================================================
  // WEB UI SETTINGS SURFACES (Req 12-15). The /settings/* routes already exist
  // on createBuilderServer, each gated behind an injected backing service, but
  // the production composition never constructed one — so in a real deploy every
  // /settings/* route fell through to 405 (unreachable), exactly like POST
  // /projects did before the runtime was wired. This section is that missing
  // production wiring for the settings surfaces, and nothing more. Each service
  // is composed through its EXISTING seams, matching how the settings tests
  // construct them with real collaborators.
  //
  // TWO SHAPES, chosen per service by reading its constructor — never guessed:
  //
  //   - PER-ACCOUNT, STATELESS-BY-LAYOUT: SkillLibrary and MemoryStore take the
  //     owning account as a METHOD argument (readUserSkills(ownerId),
  //     createUserSkill({ ownerId }), globalStore(accountId), projectStore(...))
  //     and derive every on-disk path from the layout at call time. They pin no
  //     owner at construction, so ONE instance serves every account — composed
  //     exactly like themeStore / workspaceExperienceStore above.
  //
  //   - PER-ACCOUNT, OWNER-PINNED: ConnectorService + ConnectorBindingStore pin
  //     an ownerId AT CONSTRUCTION (their secret/binding paths are
  //     controlConnectorBindingPath(ownerId, projectId), like the SecretStore).
  //     A single instance pinned to a placeholder owner would collapse every
  //     account's connector credentials + bindings into ONE owner directory —
  //     the same per-owner isolation trap the SecretStore facade above avoids.
  //     So these are a per-account INSTANCE CACHE behind the exact object shape
  //     the route expects (connectorService.addConnector / .catalog;
  //     connectorBindingStore.list), each call resolving its account.
  //
  //   - PER-PROJECT: ProjectExport + LockinAudit read a project's exportable
  //     tree keyed by projectId ALONE (layout.exportableProjectTree(projectId));
  //     no owner is in the path, so ONE instance over the layout is correct.
  //     ShareLinkService needs a per-owner store (controlShareLinkPath keys on
  //     ownerId), so it is dispatched per-owner like the owner-pinned group.
  //
  // The ACCOUNT the settings routes operate on is the authenticated account. The
  // per-account routes pass the authenticated account id AS the projectId when
  // the client sends none (the connectors/memory screens are account-level), and
  // otherwise a real projectId. So a per-account facade resolves the owning
  // account from its argument: a REGISTERED projectId -> its owner via ownerOf;
  // anything else -> the argument IS the account id (the route's own default).
  // This never widens access — the route has already authn/authz-gated the
  // request; the facade only selects which per-owner instance to write through.

  /**
   * Resolve the owning ACCOUNT for a per-account settings call whose argument is
   * "a projectId or, when the client sent none, the account id itself" (the
   * builder-server's own contract for the per-account routes). A registered
   * project resolves to its real owner; any other value is treated as the
   * account id it already is. Returns null only for a blank/absent argument.
   */
  function accountOf(projectIdOrAccountId) {
    if (typeof projectIdOrAccountId !== 'string' || projectIdOrAccountId === '') return null;
    return ownerOf(projectIdOrAccountId) ?? projectIdOrAccountId;
  }

  // ---- providerResolver: PROCESS-WIDE (Req 12) -----------------------------
  // Not per-owner: it selects the BUILDER's own model provider/model for this
  // deployment, a single process-wide choice. Composed exactly as the settings
  // test does — over plumby's canonical PROVIDERS / describeProviders seams
  // through the engine boundary (provider-resolver.js already imports them), so
  // GET /settings/provider reflects the SAME provider set + env-order default
  // this deployment's default agent path uses (start.js resolveProvider(env)).
  const providerResolver = createProviderResolver({ env, now });

  // ---- connectors: PER-ACCOUNT, OWNER-PINNED (Req 13) ----------------------
  // The steering writer is layout-stateless (like themeStore), shared across
  // owners. The SecretStore + BindingStore pin an owner, so build one
  // ConnectorService per account, cached, each over that account's own stores.
  const connectorSteeringWriter = createConnectorsSteeringWriter({ layout });
  const connectorServices = perOwner((ownerId) =>
    createConnectorService({
      secretStore: secretStores.forOwner(ownerId),
      bindingStore: connectorBindingStores.forOwner(ownerId),
      steeringWriter: connectorSteeringWriter,
      catalog: defaultConnectorCatalog,
      // The capture seam is supplied PER-CALL by the /settings/connectors route
      // from the POST body; the service-level default is never reached, but the
      // constructor requires a function, so provide an honest no-op that reports
      // a structured failure if it ever were called without a per-call override.
      capture: () => ({ ok: false, reason: 'failed' }),
      // deployTo (Req 10.8) routes through the SAME wired CommandGuard the rest
      // of the runtime uses, so a hosting-deploy connector is gated identically.
      commandGuard,
      now,
    }),
  );

  /**
   * The single `connectorService` object the /settings/connectors route expects
   * (it calls addConnector({ projectId, ... }) and reads `.catalog`). Each call
   * resolves its account from the projectId-or-accountId argument and delegates
   * to that account's cached ConnectorService — so a connector credential lands
   * in the requesting account's own owner directory, never a shared placeholder.
   * The catalog is owner-independent, exposed directly.
   */
  const connectorService = Object.freeze({
    catalog: defaultConnectorCatalog,
    addConnector(params = {}) {
      const accountId = accountOf(params?.projectId);
      if (accountId === null) {
        return Object.freeze({
          ok: false,
          code: 'invalid_project',
          message: 'a projectId (or account scope) is required to select the owning account',
        });
      }
      return connectorServices.forOwner(accountId).addConnector(params);
    },
    removeConnector(params = {}) {
      const accountId = accountOf(params?.projectId);
      if (accountId === null) {
        return Object.freeze({ ok: false, code: 'invalid_project', message: 'a projectId is required' });
      }
      return connectorServices.forOwner(accountId).removeConnector(params);
    },
  });

  /**
   * The `connectorBindingStore` the route uses ONLY to surface the bound-connector
   * list on GET /settings/connectors (name-only). Same per-account dispatch: it
   * lists the requesting account's own bindings. An absent/blank argument yields
   * an empty list (the route already treats a no-projectId GET as []).
   */
  const connectorBindingStore = Object.freeze({
    list(projectIdOrAccountId) {
      const accountId = accountOf(projectIdOrAccountId);
      if (accountId === null) return Object.freeze([]);
      return connectorBindingStores.forOwner(accountId).list(projectIdOrAccountId);
    },
  });

  // ---- skills + memory: PER-ACCOUNT, STATELESS-BY-LAYOUT (Req 14) ----------
  // Both take the owning account as a method argument and derive their paths
  // from the layout, pinning no owner at construction — so ONE instance each,
  // exactly like themeStore. The cap/env behaviour of the MemoryStore reads the
  // same env this composition is given.
  const skillLibrary = createSkillLibrary({ layout });
  const memoryStore = createMemoryStore({ layout, env });

  // ---- export + lockin-audit: PER-PROJECT over the layout (Req 15.3/15.4) --
  // Both read a project's exportable tree keyed by projectId alone (no owner in
  // the path), so ONE instance over the layout serves every project. The export
  // is passed the connector catalog so its env-var template names the connector
  // credential NAMEs too (names only, never values). The default readTree walks
  // the on-disk exportable tree with the PersistenceStore text/binary contract —
  // the SAME tree the runtime already persists/restores.
  const projectExporter = createProjectExport({
    layout,
    now,
    connectorCatalog: defaultConnectorCatalog,
  });
  const lockinAudit = createLockinAudit({ layout, now });

  // ---- share links: PER-OWNER dispatch (Req 15.5) --------------------------
  // The ShareLinkStore pins an owner (controlShareLinkPath keys on ownerId), so
  // a link is stored under the PROJECT's owner. The ShareLinkService is composed
  // per-owner over that owner's store, reusing the runtime's REAL authorizer and
  // projectResolver (share() authorizes the requester against the resolved
  // project through the same authorizer the rest of auth uses). The route calls
  // only share(requester, projectId); the facade resolves the project's owner
  // and delegates to that owner's service, so a link is persisted in the owning
  // account's own directory. A projectId that resolves to no owner is handled by
  // the service itself: it is composed for the requesting account and share()
  // then denies-discloses-nothing when projectResolver returns null.
  const shareAuthorizer = createAuthorizer();
  const shareLinkServices = perOwner((ownerId) =>
    createShareLinkService({
      store: createShareLinkStore({ layout, ownerId }),
      authorizer: shareAuthorizer,
      projectResolver,
      now,
      auditSink: composed.auditLog,
    }),
  );
  const shareLinkService = Object.freeze({
    share(requester, projectId) {
      // Store the link under the PROJECT's owner when it is registered; otherwise
      // fall back to the requester's own account so the service can still run its
      // deny-disclose-nothing path (projectResolver(null) -> generic deny) rather
      // than throwing. Either way the service re-authorizes the requester.
      const ownerId = ownerOf(projectId) ?? (requester && requester.id);
      if (typeof ownerId !== 'string' || ownerId === '') {
        return { ok: false, code: 'denied', message: 'access denied' };
      }
      return shareLinkServices.forOwner(ownerId).share(requester, projectId);
    },
  });
  const shareLinkBaseUrl = resolveShareLinkBaseUrl(env);

  // ==========================================================================
  // BUILD / DEPLOY — THE REAL ENGINE (Req 15.1/15.2, 18.1-18.8)
  //
  // This used to be deliberately UNWIRED: `build-service.js` implemented the
  // build/deploy LIFECYCLE for real but both of its work boundaries were inert
  // seams that synthesized a result and launched nothing, so injecting a
  // `projectLifecycle` over them would have returned a fabricated success. Both
  // boundaries now have REAL implementations behind the SAME seams:
  //
  //   buildBoundary  -> src/project/container-build.js — resolves the project's own
  //     build script and runs `npm run <script>` INSIDE the project's
  //     Isolation_Boundary through the existing SandboxManager.exec seam, then
  //     packages the detected build output into the artifact bytes build-service
  //     writes to disk. A project with no build script / no output / uninstalled
  //     dependencies is REFUSED with a named reason, never faked.
  //   deployBoundary -> src/project/self-hosted-deploy.js — publishes the artifact
  //     to a control-plane location THIS platform serves and returns that URL. No
  //     hosting vendor, no credentials, no new dependency (anti-lock-in); an
  //     external provider stays a future adapter behind this same seam.
  //
  // PER-OWNER, and why it matters here more than almost anywhere else. A
  // BuildService keeps per-project artifact + deployed-URL state AND writes real
  // artifact bytes to disk. Its default artifact path is keyed by projectId alone,
  // so ONE shared instance would put every account's build products in one
  // directory tree, collapsing the per-owner storage-path isolation axis (Req 7.6)
  // that every store above preserves. So BuildServices are a per-owner instance
  // cache whose artifact path is layout.controlBuildArtifactPath(ownerId, ...), and
  // the publisher resolves each project's owner through the SAME registry before
  // choosing layout.controlPublishedSitePath(ownerId, ...).
  const containerBuild = createContainerBuild({
    layout,
    // The Isolation_Boundary, WITH the idle-reclamation wrapper — a build is real
    // work on a project's tree and must count as use of its boundary.
    sandboxManager,
    now,
    // Build logs are surfaced as failure causes, so they go through the SAME
    // central redactor every other wired sink uses.
    redact: (text) => composed.redactor.redact(text),
  });

  const publishedSigningKey = resolvePublishedSigningKey(env);
  const publishedBaseUrl = resolvePublishedBaseUrl(env);
  const selfHostedDeploy = createSelfHostedDeploy({
    layout,
    // Published output is per-owner on disk; the registry is the owner authority.
    ownerOf,
    signingKey: publishedSigningKey.key,
    ...(publishedBaseUrl !== undefined ? { baseUrl: publishedBaseUrl } : {}),
    now,
  });

  const buildServices = perOwner((ownerId) =>
    createBuildService({
      layout,
      buildBoundary: containerBuild.build,
      deployBoundary: selfHostedDeploy.deploy,
      // A deploy that supplies a COMMAND is gated by the same wired CommandGuard
      // the rest of the runtime uses. The self-hosted publish runs no command at
      // all (it writes files), so there is nothing for the classifier to gate —
      // the guard is wired for the provider adapters that will run one.
      commandGuard,
      now,
      artifactPathFor: ({ projectId, target }) => layout.controlBuildArtifactPath(ownerId, projectId, target),
      audit: composed.auditLog,
    }),
  );

  /**
   * Which Target a /settings/build or /settings/deploy request builds.
   *
   * The routes carry only a projectId, so the Target comes from the PROJECT's own
   * registry record, in this order:
   *
   *   1. its DECLARED `targets`, preferring the servable ones (web, then shared,
   *      then backend). This is the authoritative statement when a project has one;
   *   2. otherwise its `targetCategory`, because ProjectManager creates a Project
   *      with `targets: []` and the category is then the only thing the Project
   *      actually says about its shape: `web`/`full-stack-web`/`multi-target` all
   *      have `web` as their servable Target.
   *
   * Nothing is guessed beyond that: a project we cannot resolve, and a `mobile`
   * project (whose build has its own queue-aware service and is not driven by this
   * route), are refused with a reason rather than built as something else.
   */
  function lifecycleTargetFor(projectId) {
    let record = null;
    try {
      record = registry.get(projectId);
    } catch {
      record = null;
    }
    if (!record) {
      return {
        ok: false,
        outcome: 'unavailable',
        summary: 'this project is not in the ProjectRegistry, so no build Target can be resolved',
      };
    }
    const declared = Array.isArray(record.targets) ? record.targets : [];
    const fromDeclared = ['web', 'shared', 'backend'].find((candidate) => declared.includes(candidate));
    if (fromDeclared) return { ok: true, target: fromDeclared };

    if (declared.length === 0 && record.targetCategory !== 'mobile') {
      const fromCategory = { web: 'web', 'full-stack-web': 'web', 'multi-target': 'web' }[record.targetCategory];
      if (fromCategory) return { ok: true, target: fromCategory };
    }
    return {
      ok: false,
      outcome: 'unsupported',
      summary:
        record.targetCategory === 'mobile' || declared.includes('mobile')
          ? 'a mobile Target is built by the mobile build service, which this route does not drive'
          : `this project declares no buildable Target (declared: ${declared.join(', ') || 'none'}, ` +
            `category: ${record.targetCategory})`,
    };
  }

  /**
   * Reduce any internal cause to the bounded, single-line, REDACTED summary the
   * route is allowed to surface. Never forwards a raw multi-line cause (which could
   * carry a build log, a path or a secret a build script echoed).
   */
  function safeSummary(text) {
    const oneLine = composed.redactor.redact(String(text ?? '')).replace(/\s+/g, ' ').trim();
    return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
  }

  /**
   * Can the engine operate at all right now? Checked AT REQUEST TIME, not at boot:
   * a host with no container runtime must still boot and answer /healthz (the same
   * rule the SandboxManager composition follows), so an unusable backend becomes an
   * honest structured refusal on the build request rather than a boot failure — and
   * never a fabricated success.
   */
  function engineUnavailable() {
    if (typeof backend.runOneShot !== 'function') {
      return {
        outcome: 'unavailable',
        summary:
          'the composed container backend cannot run commands, so no build can be performed; ' +
          'a build runs only inside a project Isolation_Boundary',
      };
    }
    return null;
  }

  /**
   * The `projectLifecycle` the /settings/build + /settings/deploy routes consume.
   * A THIN adapter: it maps the BuildService's richer structured results onto the
   * exact { outcome, summary?, url? } shape the routes surface, and nothing else.
   *
   * HONEST BY CONSTRUCTION: a refusal maps to a NON-SUCCESS outcome carrying a safe
   * reason. There is no path through this adapter that reports success for work that
   * did not happen.
   */
  const projectLifecycle = Object.freeze({
    async build({ projectId } = {}) {
      const unavailable = engineUnavailable();
      if (unavailable) return unavailable;
      const service = buildServices.forProject(projectId);
      if (!service) {
        return {
          outcome: 'unavailable',
          summary: 'this project is not in the ProjectRegistry, so no owner-scoped build service can be selected',
        };
      }
      const resolved = lifecycleTargetFor(projectId);
      if (resolved.ok !== true) return { outcome: resolved.outcome, summary: resolved.summary };

      const result = await service.build({ projectId, target: resolved.target });
      if (result.ok === true) {
        return {
          outcome: 'succeeded',
          summary: `built the ${resolved.target} Target in ${result.buildMs}ms; Deployment_Artifact recorded`,
        };
      }
      return { outcome: 'failed', summary: safeSummary(`${result.code}: ${result.message}`) };
    },

    async deploy({ projectId, service: destination } = {}) {
      const unavailable = engineUnavailable();
      if (unavailable) return unavailable;
      const service = buildServices.forProject(projectId);
      if (!service) {
        return {
          outcome: 'unavailable',
          summary: 'this project is not in the ProjectRegistry, so no owner-scoped build service can be selected',
        };
      }
      const resolved = lifecycleTargetFor(projectId);
      if (resolved.ok !== true) return { outcome: resolved.outcome, summary: resolved.summary };

      // Deploying without a build is refused BEFORE any deploy work, by the
      // BuildService itself (Req 18.8). Surfacing it here makes the reason
      // actionable instead of a bare code.
      const artifact = service.artifactFor(projectId, resolved.target);
      if (!artifact) {
        return {
          outcome: 'failed',
          summary: `no Deployment_Artifact exists for the ${resolved.target} Target — run a build first`,
        };
      }
      const result = await service.deploy({
        projectId,
        artifact,
        destination: typeof destination === 'string' && destination !== '' ? destination : 'self-hosted',
      });
      if (result.ok === true) {
        return {
          outcome: 'deployed',
          summary: `published the ${resolved.target} Target to this platform in ${result.deployMs}ms`,
          url: result.url,
        };
      }
      return { outcome: 'failed', summary: safeSummary(`${result.code}: ${result.message}`) };
    },
  });

  /**
   * The bundle to spread into createBuilderServer:
   *   createBuilderServer({ authService, provider, ...runtime.serverOptions() })
   *
   * `projectResolver` is registry.resolver — the seam the ProjectRegistry
   * docstring was written for. With it, a Project owned by another account (or a
   * projectId that does not exist) yields the SAME non-disclosing access-denied
   * as an unauthenticated request, instead of being treated as self-owned.
   */
  function serverOptions() {
    return {
      layout,
      sandboxManager,
      commandGuard,
      projectResolver,
      quotaManager,
      projectManager,
      previewController,
      themeStore,
      workspaceExperienceStore,
      // Web UI settings surfaces (Req 12-15). Spread straight into
      // createBuilderServer by start.js with no change required there. Each
      // option name matches the createBuilderServer contract exactly.
      providerResolver,
      connectorService,
      connectorBindingStore,
      skillLibrary,
      memoryStore,
      projectExporter,
      lockinAudit,
      shareLinkService,
      // Build/deploy is now REAL and therefore routed: POST /settings/build and
      // /settings/deploy are reachable instead of 405. An engine that genuinely
      // cannot operate refuses at REQUEST time with a structured reason.
      projectLifecycle,
      // The read side of a self-hosted deploy: GET /live/<project>/<target>/<sig>/…
      publishedSites: selfHostedDeploy,
      ...(shareLinkBaseUrl !== undefined ? { shareLinkBaseUrl } : {}),
    };
  }

  return Object.freeze({
    dataDir,
    layout,
    registry,
    backend,
    sandboxManager,
    secretStore,
    snapshotStore,
    persistenceStore,
    quotaManager,
    commandGuard,
    devServer,
    previewController,
    projectOrigin,
    projectManager,
    themeStore,
    workspaceExperienceStore,
    // Web UI settings surfaces (Req 12-15), exposed so a deployment / the wiring
    // tests can observe WHAT was composed (and that build/deploy is deliberately
    // absent) rather than inferring it from a route probe.
    providerResolver,
    connectorService,
    connectorBindingStore,
    skillLibrary,
    memoryStore,
    projectExporter,
    lockinAudit,
    shareLinkService,
    shareLinkBaseUrl,
    // The REAL build/deploy engine (Req 15.1/15.2, 18.x), exposed so a deployment /
    // the wiring tests can observe WHAT was composed rather than probing a route.
    projectLifecycle,
    containerBuild,
    selfHostedDeploy,
    buildServiceFor: (ownerId) => buildServices.forOwner(ownerId),
    /**
     * Do deploy URLs survive a restart? 'configured' when AAB_PUBLISHED_SIGNING_KEY
     * supplied the capability key; 'ephemeral' when a per-process key was generated,
     * in which case previously issued deploy URLs stop resolving after a restart.
     */
    publishedUrlMode: publishedSigningKey.source,
    publishedBaseUrl,
    serverOptions,
    egressMode: egress.mode,
    /**
     * Is the Preview REAL (a launched dev-server container) or the inert seam?
     * Exposed so a deployment can assert which one it got instead of discovering
     * it from a preview URL that serves nothing.
     */
    previewMode: preview.enabled ? 'container' : 'inert',
    previewNetwork: preview.network,
    /** This deployment slot's identity, stamped on every container we create. */
    instanceId,
    /**
     * Owner-SCOPED store access, for the surfaces that operate on an account
     * rather than on one project — notably RetentionService (Req 24 account/project
     * deletion), which deletes an owner's data and only then unregisters, at which
     * point the projectId-keyed facades can no longer resolve an owner. Not wired
     * to a route in this pass; exposed so it can be, without reaching around the
     * per-owner isolation this composition establishes.
     */
    storesForOwner(ownerId) {
      // These are WRITE-capable handles keyed by an ownerId that becomes a path
      // component, so reject a missing/blank one. NOTE: this does NOT verify the
      // owner exists in the registry — an unknown ownerId yields usable handles
      // over an empty owner. Path traversal is impossible regardless: the layout
      // refuses any ownerId that is not a single safe path segment.
      if (typeof ownerId !== 'string' || ownerId.trim() === '') {
        throw new TypeError('storesForOwner: ownerId must be a non-empty string');
      }
      return Object.freeze({
        secretStore: secretStores.forOwner(ownerId),
        snapshotStore: snapshotStores.forOwner(ownerId),
        persistenceStore: persistenceStores.forOwner(ownerId),
      });
    },
    // Introspection for the composition tests (per-owner dispatch correctness).
    _ownerOf: ownerOf,
    _ownerCounts: () => ({
      secrets: secretStores.ownerCount(),
      snapshots: snapshotStores.ownerCount(),
      persistence: persistenceStores.ownerCount(),
    }),
  });
}
