/**
 * retention.js — the RetentionService: Project and User_Account deletion (spec
 * Task 12.3, Req 24.2, 24.3, 24.4, 24.5).
 *
 * RETAIN-UNTIL-DELETION (Req 24.5): a Project's persisted file state and its
 * Snapshots are RETAINED for as long as the Project exists — there is NO silent
 * expiry, no TTL, no background reaper that discards state. Persisted state and
 * Snapshots are removed ONLY when the user explicitly deletes the Project, or
 * when the user deletes their User_Account (which cascades to every owned
 * Project). This service is the single choke point that performs those explicit
 * deletions; nothing else in the platform drops a Project's durable state.
 *
 * WHAT deleteProject DOES (Req 24.2, 24.3), in order:
 *   1. release the Project's Sandbox / Isolation_Boundary (sandboxManager.release)
 *      so no live container survives the deletion;
 *   2. delete the Project's persisted FILES (persistenceStore.deleteProjectTree);
 *   3. delete the Project's SNAPSHOTS — the .git repo + out-of-tree registry
 *      (snapshotStore.deleteSnapshots);
 *   4. delete the Project's associated SECRETS (secretStore.deleteProjectSecrets);
 *   5. remove the Project from the registry (projectRegistry.unregister);
 *   6. emit AUDIT_EVENTS.PROJECT_DELETED (scoped to the acting account, routed
 *      through the redactor so no secret material can enter the audit record)
 *      and RETURN a confirmation object listing each step's result.
 * Authorization/ownership is assumed to be enforced by the CALLER (the Builder
 * Server request path) before this runs.
 *
 * WHAT deleteAccount DOES (Req 24.4): it deletes-or-irreversibly-anonymizes
 * EVERY resource category KEYED BY ownerId, so no owned data is left behind:
 *   - Projects           (loop deleteProject over the owner's project ids)
 *   - Skills             (skillStore.deleteAccountData)
 *   - Project_Memory + Global_Memory (memoryStore.deleteAccountData)
 *   - Connectors         (connectorStore.deleteAccountData)
 *   - Secrets            (secretStore.deleteAccountData)
 * The enumeration is DRIVEN BY the fixed ownerId-keyed category list below, so a
 * category cannot be silently skipped: each category present is deleted and each
 * absent optional seam is explicitly recorded as skipped. It then emits
 * AUDIT_EVENTS.ACCOUNT_DELETED and returns a confirmation naming every category.
 *
 * INJECTABLE SEAMS: every resource store is injected, and the non-core ones
 * (connectorStore, memoryStore, skillStore) are OPTIONAL so tests can supply
 * spies/fakes and callers can wire only the subsystems they run. Conventions:
 * a factory returning Object.freeze({...}); structured result objects; the
 * injectable now() clock and audit sink for hermetic, offline tests.
 */

import { AUDIT_EVENTS, toAuditSink } from '../auth/audit.js';

/**
 * The canonical list of ownerId-keyed resource categories a User_Account owns.
 * deleteAccount iterates THIS list so no category is skipped by omission; the
 * completeness test asserts every entry here is handled.
 */
export const OWNER_KEYED_CATEGORIES = Object.freeze([
  'Projects',
  'Skills',
  'Project_Memory',
  'Global_Memory',
  'Connectors',
  'Secrets',
]);

/** Extract an accountId from a user-account-shaped argument (id or { id }). */
function accountIdOf(userAccount) {
  if (typeof userAccount === 'string') return userAccount;
  if (userAccount && typeof userAccount === 'object') {
    if (typeof userAccount.id === 'string') return userAccount.id;
    if (typeof userAccount.accountId === 'string') return userAccount.accountId;
  }
  return null;
}

/**
 * Create a RetentionService.
 *
 * @param {object} args
 * @param {object} args.persistenceStore  PersistenceStore; deleteProjectTree(projectId).
 * @param {object} args.snapshotStore     SnapshotStore; deleteSnapshots(projectId).
 * @param {object} args.sandboxManager    SandboxManager; release(projectId).
 * @param {object} args.secretStore       SecretStore; deleteProjectSecrets(projectId)
 *                                         + deleteAccountData(userAccountId).
 * @param {object} args.projectRegistry   the real ProjectRegistry (src/project/
 *        project-registry.js). Must expose listForOwner(ownerId) -> Project[]
 *        (full records { id, ownerId, ... }, used to enumerate an account's
 *        projects for account deletion) and unregister(projectId, ownerId) ->
 *        boolean (projectId FIRST; drops the registry entry on project deletion).
 * @param {object} [args.connectorStore]  OPTIONAL; deleteAccountData(userAccountId).
 * @param {object} [args.memoryStore]     OPTIONAL; deleteAccountData(userAccountId)
 *        covering BOTH Project_Memory and Global_Memory.
 * @param {object} [args.skillStore]      OPTIONAL; deleteAccountData(userAccountId).
 * @param {object|Function} [args.auditSink]  audit sink (function or { record }).
 * @param {object} [args.redactor]        centralized redactor (src/ops/redaction.js);
 *        every emitted audit record is passed through redactor.redact first.
 * @param {boolean} [args.requireAllCategories=false]  the FAIL-OPEN posture control
 *        (Req 24.4). By DEFAULT (false) deleteAccount is LENIENT: an optional
 *        ownerId-keyed category (Skills / Memory / Connectors) whose store was
 *        not injected is recorded as `skipped` and the deletion still confirms —
 *        an explicit choice for deployments that do not run those subsystems.
 *        When set to TRUE (strict mode), deleteAccount FAILS (throws) if ANY
 *        ownerId-keyed category store is absent, so a "delete everything I own"
 *        request never reports success while a subsystem was forgotten at wiring
 *        time. Choose strict for GDPR-style guarantees.
 * @param {()=>string} [args.now]         injectable ISO-timestamp clock.
 * @returns {object} frozen RetentionService
 */
export function createRetentionService(args = {}) {
  const {
    persistenceStore,
    snapshotStore,
    sandboxManager,
    secretStore,
    projectRegistry,
    connectorStore,
    memoryStore,
    skillStore,
    auditSink,
    redactor,
    requireAllCategories = false,
    now = () => new Date().toISOString(),
  } = args;

  if (!persistenceStore || typeof persistenceStore.deleteProjectTree !== 'function') {
    throw new TypeError('createRetentionService: persistenceStore with deleteProjectTree(projectId) is required');
  }
  if (!snapshotStore || typeof snapshotStore.deleteSnapshots !== 'function') {
    throw new TypeError('createRetentionService: snapshotStore with deleteSnapshots(projectId) is required');
  }
  if (!sandboxManager || typeof sandboxManager.release !== 'function') {
    throw new TypeError('createRetentionService: sandboxManager with release(projectId) is required');
  }
  if (!secretStore || typeof secretStore.deleteProjectSecrets !== 'function' || typeof secretStore.deleteAccountData !== 'function') {
    throw new TypeError('createRetentionService: secretStore with deleteProjectSecrets/deleteAccountData is required');
  }
  if (
    !projectRegistry ||
    typeof projectRegistry.listForOwner !== 'function' ||
    typeof projectRegistry.unregister !== 'function'
  ) {
    throw new TypeError('createRetentionService: projectRegistry with listForOwner(ownerId) + unregister(projectId, ownerId) is required');
  }

  const emitAudit = toAuditSink(auditSink);
  const redact = redactor && typeof redactor.redact === 'function' ? (e) => redactor.redact(e) : (e) => e;

  /** Emit an audit event, ALWAYS routed through the centralized redactor. */
  function audit(event) {
    emitAudit(redact(event));
  }

  /**
   * deleteProject(userAccount, projectId): tear down a Project's Sandbox, delete
   * its files, snapshots, and secrets, drop it from the registry, then emit
   * PROJECT_DELETED and return a confirmation. Idempotent at each step (every
   * underlying surface is idempotent), so re-deleting a project is safe.
   */
  async function deleteProject(userAccount, projectId) {
    const accountId = accountIdOf(userAccount);
    if (!accountId) throw new TypeError('deleteProject: a userAccount ({ id } or id) is required');
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new TypeError('deleteProject: projectId must be a non-empty string');
    }

    // 1) Release the Sandbox (async; idempotent + best-effort in the manager).
    const sandbox = await sandboxManager.release(projectId);
    // 2) Delete persisted files.
    const files = persistenceStore.deleteProjectTree(projectId);
    // 3) Delete Snapshots (.git repo + out-of-tree registry).
    const snapshots = snapshotStore.deleteSnapshots(projectId);
    // 4) Delete associated Secrets.
    const secrets = secretStore.deleteProjectSecrets(projectId);
    // 5) Remove from the registry (real API: projectId FIRST, ownerId second;
    // returns a boolean recording whether a record was actually removed).
    const registry = projectRegistry.unregister(projectId, accountId);

    // 6) Emit the deletion audit event (redacted) and confirm.
    audit({
      type: AUDIT_EVENTS.PROJECT_DELETED,
      at: now(),
      accountId,
      projectId,
    });

    return {
      ok: true,
      deleted: 'Project',
      accountId,
      projectId,
      steps: { sandbox, files, snapshots, secrets, registry },
      confirmed: true,
    };
  }

  /**
   * deleteAccount(userAccount): delete-or-irreversibly-anonymize EVERY
   * ownerId-keyed resource category, then emit ACCOUNT_DELETED and confirm. The
   * returned `categories` map records, per OWNER_KEYED_CATEGORIES entry, what
   * happened (deleted vs skipped-because-no-seam), so the completeness test can
   * assert no category was silently dropped.
   *
   * The emitted ACCOUNT_DELETED audit event carries the REAL per-category
   * outcome map ({ Projects:'deleted', Skills:'skipped', ... }) — NOT the static
   * category list — so the audit trail never overstates completeness when a
   * lenient deletion skipped an un-wired category.
   *
   * FAIL-OPEN vs STRICT (requireAllCategories): by default a category whose
   * store was not injected is recorded `skipped` and the deletion still confirms
   * (an explicit lenient choice for deployments not running that subsystem). In
   * strict mode deleteAccount THROWS if any ownerId-keyed category store is
   * absent, so a GDPR-style "delete everything I own" never confirms success
   * while data in a forgotten subsystem remains.
   */
  async function deleteAccount(userAccount) {
    const accountId = accountIdOf(userAccount);
    if (!accountId) throw new TypeError('deleteAccount: a userAccount ({ id } or id) is required');

    const categories = {};

    // --- Projects: loop deleteProject over every owned project id. ---------
    // The real registry's listForOwner(ownerId) returns full Project RECORDS
    // ({ id, ownerId, ... }), NOT ids, so map to r.id.
    const projects = projectRegistry.listForOwner(accountId) ?? [];
    const projectIds = projects.map((r) => r.id);
    const projectResults = [];
    for (const pid of projectIds) {
      projectResults.push(await deleteProject(userAccount, pid));
    }
    categories.Projects = { handled: true, count: projectResults.length, results: projectResults };

    // --- Skills ------------------------------------------------------------
    categories.Skills = deleteCategory(skillStore, accountId, 'Skills');

    // --- Project_Memory + Global_Memory (one store covers both) ------------
    const memoryResult = deleteCategory(memoryStore, accountId, 'Memory');
    categories.Project_Memory = memoryResult;
    categories.Global_Memory = memoryResult;

    // --- Connectors --------------------------------------------------------
    categories.Connectors = deleteCategory(connectorStore, accountId, 'Connectors');

    // --- Secrets (secretStore is required, always handled) -----------------
    categories.Secrets = { handled: true, result: secretStore.deleteAccountData(accountId) };

    // Guard: every canonical ownerId-keyed category MUST have an entry, so a
    // future edit that forgets one is caught here (and by the completeness test).
    for (const cat of OWNER_KEYED_CATEGORIES) {
      if (!(cat in categories)) {
        throw new Error(`deleteAccount: ownerId-keyed category ${JSON.stringify(cat)} was not handled`);
      }
    }

    // STRICT MODE (requireAllCategories): fail LOUDLY — never confirm — when any
    // ownerId-keyed category's store was absent, so a "delete everything I own"
    // request cannot report success while a subsystem was forgotten at wiring
    // time. The lenient default (below) is the explicit choice for deployments
    // that do not run every optional subsystem.
    if (requireAllCategories) {
      const skipped = OWNER_KEYED_CATEGORIES.filter((cat) => categories[cat] && categories[cat].handled !== true);
      if (skipped.length > 0) {
        throw new Error(
          `deleteAccount: strict mode (requireAllCategories) requires every ownerId-keyed category store to be present; missing: ${skipped.join(', ')}`,
        );
      }
    }

    // Build the REAL per-category handled/skipped outcome for the audit trail —
    // NOT the static OWNER_KEYED_CATEGORIES list. The audit record must reflect
    // what actually happened (deleted vs skipped) so it never overstates
    // completeness when a lenient deletion skipped an un-wired category.
    const categoryOutcomes = {};
    for (const cat of OWNER_KEYED_CATEGORIES) {
      const entry = categories[cat] ?? {};
      categoryOutcomes[cat] = entry.handled === true ? 'deleted' : 'skipped';
    }

    audit({
      type: AUDIT_EVENTS.ACCOUNT_DELETED,
      at: now(),
      accountId,
      // Per-category REAL outcome (deleted|skipped). `categoryList` keeps the
      // canonical enumeration available for consumers that want the full set.
      categories: categoryOutcomes,
      categoryList: OWNER_KEYED_CATEGORIES,
    });

    return {
      ok: true,
      deleted: 'User_Account',
      accountId,
      categories,
      confirmed: true,
    };
  }

  /**
   * Delete an optional ownerId-keyed category via its store's
   * deleteAccountData(accountId). When the seam is not injected, record it as
   * skipped (the subsystem is not wired in this deployment) rather than silently
   * ignoring it — the confirmation still names the category so completeness is
   * auditable.
   */
  function deleteCategory(store, accountId, label) {
    if (store && typeof store.deleteAccountData === 'function') {
      return { handled: true, result: store.deleteAccountData(accountId) };
    }
    return { handled: false, skipped: `no ${label} store injected` };
  }

  return Object.freeze({
    deleteProject,
    deleteAccount,
    OWNER_KEYED_CATEGORIES,
  });
}
