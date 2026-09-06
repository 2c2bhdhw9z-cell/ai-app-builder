/**
 * project-origins.js — the ProjectOrigin module (spec subtask 14.1, Req 6.1-6.3,
 * 6.8, 6.9, 5.2, 5.3).
 *
 * A Project comes into existence from one of four Project_Origins (the closed
 * enum in src/model/enums.js): 'blank', 'template', 'github-import', 'fork'.
 * The ProjectOrigin's SOLE job is to produce that origin's INITIAL project tree
 * — the starting { relPath: contents } file map that seeds the Project BEFORE
 * any agent generation runs. It performs NO agent generation, NO verify, and NO
 * Dev_Server start: those are the ProjectManager.runGeneration pipeline's job,
 * which every origin then converges onto identically (Req 6.9). populate() only
 * decides "what files does a freshly-created <origin> Project start with?".
 *
 * SCOPE: all four Project_Origins are implemented here. FEAT-002 delivered the
 * 'blank' and 'template' branches; FEAT-003 adds 'github-import' and 'fork'. The
 * dispatch keeps an exhaustive switch and a defense-in-depth 'unsupported origin'
 * guard (ProjectManager already validates the enum at the edge, but populate
 * never trusts that alone).
 *
 * SEAMS FOR 'github-import' (Req 6.4-6.6): the ACTUAL external network fetch is a
 * SEAM injected as `cloner`. The environment is OFFLINE for external hosts, so a
 * real github.com clone CANNOT run here; production wiring can be a real
 * git-clone-inside-the-Sandbox, but tests inject a scripted `cloner` and drive
 * every path (success, large-repo progress, invalid ref, timeout) against fakes
 * and an injected clock. The clone is issued as a `bash` command through the
 * SandboxManager exec path (design.md: the clone runs INSIDE the Sandbox so it
 * is classified + confined by the permission classifier), and the injected
 * `cloner` stands in for the confined network fetch that command performs. The
 * <=120s (small repo) / configurable maxCloneMs (large repo, default 600s) clone
 * budgets are SLOs measured against the injected clock, NOT real waits. On ANY
 * failure (invalid/inaccessible ref, or exceeding the applicable max clone time)
 * the import ABORTS with the cause, produces NO projectTree (so ProjectManager
 * persists no partial Project), and reaps the Sandbox in a `finally` via
 * sandboxManager.release(projectId) (idempotent + orphan-reaping, Req 6.5) so no
 * orphaned Sandbox survives. Authorization for the repo ref runs BEFORE the clone.
 *
 * SEAMS FOR 'fork' (Req 6.6-6.8, Property 10): authorization runs FIRST (a
 * nonexistent or unauthorized source Project is rejected creating NOTHING). On
 * success the fork copies the source Project's MOST RECENT Snapshot as its
 * starting state — read via snapshotStore.latestSnapshot + restore — as a DEEP,
 * INDEPENDENT copy: every entry's contents is cloned (Buffers copied, strings are
 * immutable) so mutating the fork's tree/snapshot can NEVER touch the origin's
 * files (Property 10). When the source has no Snapshot yet, we fall back to its
 * most recent persisted tree via persistenceStore.readPersistedTree (consistent
 * with Req 6.7's "most recent Snapshot" intent and the SnapshotStore.resume
 * rule); with neither a snapshot nor a persisted tree available the fork is
 * rejected with a clear cause creating nothing.
 *
 * WHAT "minimal runnable" MEANS FOR THE 'blank' ORIGIN (Req 6.2, Property 11):
 * a blank Project applies NO Template, yet it must still be able to START — the
 * Sandbox + Dev_Server seam must have something to run, and a toolchain check
 * (Property 11 via eval/runner.js) must be able to actually execute it. So the
 * blank tree is the SMALLEST GENUINELY-RUNNABLE set:
 *   - package.json  — declares a `start` script (`node index.js`) and a `dev`
 *                     script so the Dev_Server seam has a command to launch;
 *   - index.js      — a single entry file that runs to completion and prints a
 *                     line, so a toolchain run produces real output and exits 0.
 * A mutation that writes NOTHING runnable (e.g. an empty tree, or a package.json
 * with no start script) removes the start command / entry file and flips
 * Property 11 (nothing to run). This is deliberately NOT a Template: no
 * framework, no dependency install, just enough to boot.
 *
 * WHERE populate RUNS RELATIVE TO THE 10s "BEGINS CREATION" WINDOW (Req 6.8,
 * design.md Creation timing): createProject's 10s window covers only "creation
 * BEGINS" (validate -> quota -> register -> acquire). Origin population is a
 * SEPARATE, origin-specific bound (Template <=30s, Req 5.2; import <=120s) and
 * must NOT be folded into the 10s measurement. Therefore ProjectManager invokes
 * populate AFTER createProject has returned its beginsCreationMs — populate is
 * its own step with its own measured `populateMs`, keeping the 10s begins-
 * creation measurement honest. (ProjectManager exposes a populateOrigin() step
 * the create flow calls after createProject; see project-manager.js.)
 *
 * STRUCTURED RESULTS: populate never throws on an expected failure; it returns
 * { ok:true, origin, projectTree, populateMs } on success or
 * { ok:false, code, message, failedArtifact? } on a handled failure, matching
 * the codebase's result-object idiom. Only genuinely programmer-error input
 * (missing required collaborators at construction) throws, via fail().
 *
 * THE PLUMBY BOUNDARY: this module imports NO plumby package (nor the engine
 * boundary) — origin population is pure file-tree assembly + persistence, with
 * no Builder_Agent involvement.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock and every collaborator; structured results for expected rejections.
 */

import { isValidProjectOrigin, Project_Origin } from '../model/enums.js';
import { fail } from '../model/validate.js';

/**
 * The 30s Template-population SLO (Req 5.2). Measured against the injected clock,
 * NOT a real wait — populate exposes `populateMs` so the SLO is observable.
 */
export const TEMPLATE_POPULATE_SLO_MS = 30_000;

/**
 * The 120s small-repo (<=100 MB) github-import clone SLO (Req 6.4). Measured
 * against the injected clock, NOT a real wait — populate exposes `cloneMs`.
 */
export const IMPORT_SMALL_REPO_SLO_MS = 120_000;

/** The <=100 MB "small repo" size threshold (Req 6.4 vs 6.5). */
export const IMPORT_SMALL_REPO_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The DEFAULT configurable maximum clone time for the large-repo (>100 MB) import
 * path (Req 6.5). A factory `maxCloneMs` option overrides it. Measured against
 * the injected clock, NOT a real wait.
 */
export const IMPORT_MAX_CLONE_SLO_MS = 600_000;

/**
 * Create a ProjectOrigin.
 *
 * @param {object} args
 * @param {object} [args.persistenceStore] a PersistenceStore. Optional here:
 *        populate PRODUCES the tree; ProjectManager materializes it via the
 *        PersistenceStore. When injected, template partial-cleanup can use its
 *        deleteProjectTree seam; otherwise cleanup is purely in-memory (populate
 *        returns nothing partial, so there is nothing on disk to leave behind).
 * @param {object} [args.snapshotStore]    a SnapshotStore; REQUIRED to populate a
 *        'fork' origin (latestSnapshot + restore read the source's most-recent tree).
 * @param {object} [args.sandboxManager]   a SandboxManager; used by 'github-import'
 *        to run the clone as a confined bash command (exec) and to reap the
 *        Sandbox in a finally (release) on the import failure path (Req 6.5).
 * @param {object} [args.authorizer]       an Authorizer (createAuthorizer().resolveAccess);
 *        REQUIRED to populate 'github-import' (repo access) and 'fork' (source Project access).
 * @param {object} [args.projectRegistry]  a ProjectRegistry (get/resolver) used by
 *        'fork' to resolve the referenced source Project record for authorization.
 * @param {object} [args.templateProvider] provides Template file maps per
 *        Target_Category: `forCategory(targetCategory) -> { relPath: contents }`
 *        including a dependency manifest. REQUIRED to populate a 'template' origin.
 * @param {object} [args.cloner]           the git-clone SEAM for 'github-import':
 *        `clone({ ref, projectId, sandboxManager, exec, maxCloneMs, onProgress, signal })`
 *        -> Promise<{ ok:true, projectTree, sizeBytes? } | { ok:false, code?, message }>.
 *        The ACTUAL external network fetch is injected here; offline tests script it.
 * @param {() => number} [args.now]        injectable ms clock for the SLOs. Default Date.now.
 * @param {number} [args.maxCloneMs]       the configurable maximum clone time for
 *        the large-repo (>100 MB) import path (Req 6.5). Default 600000 (600s).
 * @returns {object} projectOrigin (frozen)
 */
export function createProjectOrigin({
  persistenceStore,
  snapshotStore,
  sandboxManager,
  authorizer,
  projectRegistry,
  templateProvider,
  cloner,
  now = () => Date.now(),
  maxCloneMs = IMPORT_MAX_CLONE_SLO_MS,
} = {}) {
  const model = 'ProjectOrigin';
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');
  if (typeof maxCloneMs !== 'number' || !Number.isFinite(maxCloneMs) || maxCloneMs <= 0) {
    fail(model, 'maxCloneMs must be a positive finite number of ms');
  }

  /**
   * populate({ project, sandbox, origin, targetCategory, ref, userAccount,
   * grants, onProgress, signal }) — produce the ORIGIN's initial project tree.
   * Performs NO agent generation.
   *
   * ASYNC: populate returns a Promise. The 'blank'/'template' branches resolve
   * synchronously (no I/O), while 'github-import' awaits the injected clone SEAM
   * and 'fork' reads the source's snapshot; making populate uniformly async keeps
   * a single call shape for ProjectManager across all four origins.
   *
   * @param {object} args
   * @param {object} [args.project]         the created Project record (id/ownerId)
   * @param {object} [args.sandbox]         the acquired Sandbox handle (import uses it)
   * @param {string} args.origin            the Project_Origin (must be in the enum)
   * @param {string} args.targetCategory    the Target_Category (template selects by it)
   * @param {string} [args.ref]             origin ref (import url / fork source id)
   * @param {object} [args.userAccount]     the REQUESTING account (import/fork authorization)
   * @param {Array<object>} [args.grants]   optional Share_Link grants for authorization
   * @param {object} [args.repoResource]    for github-import: the control-plane repo
   *        record { id, ownerId } the repo authorization is resolved against
   *        (owner-or-grant). Absent ⇒ resolved from the ref alone, so an import is
   *        denied unless a matching grant is supplied.
   * @param {(progress:object)=>void} [args.onProgress]  large-repo clone progress sink
   * @param {AbortSignal} [args.signal]     optional abort signal for the clone
   * @returns {Promise<{ ok:true, origin, projectTree, populateMs, cloneMs? }
   *          | { ok:false, code, message, failedArtifact? }>}
   */
  async function populate({
    project,
    sandbox,
    origin,
    targetCategory,
    ref,
    userAccount,
    grants,
    repoResource,
    onProgress,
    signal,
  } = {}) {
    // Defense in depth: ProjectManager already validated the enum, but populate
    // never trusts that alone (Req 6.1 — origin is a closed set).
    if (!isValidProjectOrigin(origin)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_ORIGIN',
        message:
          `unsupported Project_Origin ${JSON.stringify(origin)}: ` +
          `must be one of [${Project_Origin.join(', ')}]`,
      };
    }

    const startedAt = now();

    switch (origin) {
      case 'blank':
        return finish(startedAt, populateBlank());
      case 'template':
        return finish(startedAt, populateTemplate({ project, targetCategory }));
      case 'github-import':
        return finish(
          startedAt,
          await populateGithubImport({ project, sandbox, ref, userAccount, grants, repoResource, onProgress, signal }),
        );
      case 'fork':
        return finish(startedAt, await populateFork({ project, ref, userAccount, grants }));
      default:
        // Unreachable given the enum guard above; kept exhaustive by design.
        return {
          ok: false,
          code: 'UNSUPPORTED_ORIGIN',
          message: `unhandled Project_Origin ${JSON.stringify(origin)}`,
        };
    }
  }

  /** Stamp a successful branch result with the measured populateMs. */
  function finish(startedAt, branchResult) {
    if (branchResult.ok === false) return branchResult;
    return {
      ok: true,
      origin: branchResult.origin,
      projectTree: branchResult.projectTree,
      populateMs: now() - startedAt,
      // The origin-specific clone SLO measurement, when the branch reported one
      // (github-import). Absent for branches that do not clone.
      ...(typeof branchResult.cloneMs === 'number' ? { cloneMs: branchResult.cloneMs } : {}),
    };
  }

  /**
   * The 'blank' branch (Req 6.2, Property 11): produce ONLY the minimal
   * genuinely-runnable files, with NO Template applied. See the module doc for
   * exactly what "minimal runnable" means and why a mutation that writes nothing
   * runnable flips Property 11.
   */
  function populateBlank() {
    const packageJson = {
      name: 'blank-app',
      version: '0.0.0',
      private: true,
      // A `start`/`dev` command gives the Dev_Server seam something to launch and
      // lets a toolchain check (Property 11) actually run the project.
      scripts: {
        start: 'node index.js',
        dev: 'node index.js',
      },
    };
    const projectTree = {
      'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
      // A single entry file that runs to completion and prints a line, so a
      // toolchain run produces real output and exits 0.
      'index.js': "console.log('blank app running');\n",
    };
    return { ok: true, origin: 'blank', projectTree };
  }

  /**
   * The 'template' branch (Req 6.3, 5.2, 5.3): copy the Template matching the
   * Target_Category from the injected templateProvider and populate ALL of its
   * files plus the dependency manifest.
   *
   * FAILURE / PARTIAL-CLEANUP (Req 5.3): populate assembles the tree IN MEMORY
   * first and only returns { ok:true, projectTree } when the WHOLE template is
   * assembled successfully — so a mid-assembly failure returns { ok:false, ...,
   * failedArtifact } and NO projectTree, meaning ProjectManager never persists a
   * partial tree (nothing half-written lands on disk). When a persistenceStore
   * is injected AND some earlier populate already materialized a tree for this
   * project, we also best-effort delete that on-disk tree so no partial artifact
   * survives. The failed artifact is named in the result.
   */
  function populateTemplate({ project, targetCategory }) {
    if (!templateProvider || typeof templateProvider.forCategory !== 'function') {
      return {
        ok: false,
        code: 'TEMPLATE_PROVIDER_MISSING',
        message: 'a templateProvider with forCategory(targetCategory) is required to populate a template origin',
      };
    }

    let template;
    try {
      template = templateProvider.forCategory(targetCategory);
    } catch (err) {
      return {
        ok: false,
        code: 'TEMPLATE_WRITE_FAILED',
        message: `template provider failed for Target_Category ${JSON.stringify(targetCategory)}: ${err?.message ?? String(err)}`,
        failedArtifact: `templateProvider.forCategory(${JSON.stringify(targetCategory)})`,
      };
    }

    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      return {
        ok: false,
        code: 'TEMPLATE_WRITE_FAILED',
        message: `no template available for Target_Category ${JSON.stringify(targetCategory)}`,
        failedArtifact: `template:${targetCategory}`,
      };
    }

    // Assemble the tree in memory, validating each artifact as we go. A template
    // artifact whose contents are not a string/Buffer would be un-persistable, so
    // we treat it as a write failure NAMING the offending artifact (Req 5.3) and
    // abort BEFORE producing any projectTree, leaving nothing partial.
    const projectTree = {};
    let sawManifest = false;
    for (const [relPath, contents] of Object.entries(template)) {
      if (typeof relPath !== 'string' || relPath.trim() === '') {
        return abortTemplate({ project, failedArtifact: String(relPath), message: `template artifact path must be a non-empty string, got ${JSON.stringify(relPath)}` });
      }
      const isPersistable = typeof contents === 'string' || Buffer.isBuffer(contents);
      if (!isPersistable) {
        return abortTemplate({ project, failedArtifact: relPath, message: `template artifact ${JSON.stringify(relPath)} must be a string or Buffer` });
      }
      if (isDependencyManifest(relPath)) sawManifest = true;
      projectTree[relPath] = contents;
    }

    // A Template MUST ship a dependency manifest (Req 6.3): the origin populates
    // "all template files + the dependency manifest". Its absence is a template
    // failure naming the missing artifact.
    if (!sawManifest) {
      return abortTemplate({ project, failedArtifact: 'package.json', message: `template for Target_Category ${JSON.stringify(targetCategory)} is missing a dependency manifest` });
    }

    return { ok: true, origin: 'template', projectTree };
  }

  /**
   * Abort a template population: best-effort remove any already-materialized
   * on-disk tree (only possible when a persistenceStore is injected AND an
   * earlier step persisted something), then return the structured failure naming
   * the failed artifact. Because populateTemplate assembles in memory and returns
   * NO projectTree on failure, ProjectManager persists nothing partial; this
   * cleanup covers the belt-and-braces case of a prior partial materialization.
   */
  function abortTemplate({ project, failedArtifact, message }) {
    if (
      persistenceStore &&
      typeof persistenceStore.deleteProjectTree === 'function' &&
      project &&
      typeof project.id === 'string'
    ) {
      try {
        persistenceStore.deleteProjectTree(project.id);
      } catch {
        /* best-effort partial cleanup — must not mask the original failure */
      }
    }
    return { ok: false, code: 'TEMPLATE_WRITE_FAILED', message, failedArtifact };
  }

  /**
   * The 'github-import' branch (Req 6.4-6.6). Import a repository the user is
   * authorized to access as the Project's starting file state.
   *
   * ORDER (allocate nothing, leave nothing orphaned on any failure):
   *   1. AUTHORIZE the repo ref BEFORE cloning (Req 6.4: "a repository the user
   *      is authorized to access"). resolveAccess({ kind:'repo', resource }) is
   *      an owner-or-grant read resolution against the requesting userAccount. A
   *      denial returns { ok:false, code:'IMPORT_UNAUTHORIZED' } creating nothing
   *      — we never even attempt the clone.
   *   2. CLONE via the injected `cloner` SEAM. The clone is modelled as a `bash`
   *      command run INSIDE the Sandbox through sandboxManager.exec so it is
   *      classified + confined (design.md); the cloner receives the exec seam +
   *      the applicable clone budget and performs the confined network fetch. The
   *      external fetch is the SEAM injected offline. Small repos (<=100 MB) must
   *      complete within the 120s SLO; large repos (>100 MB) report ongoing
   *      progress via `onProgress` and are bounded by the configurable maxCloneMs
   *      (default 600s). Both budgets are measured against the injected clock.
   *   3. On success, use the cloned contents as the projectTree and return
   *      { ok:true, projectTree, cloneMs }.
   *   4. On ANY failure (invalid/inaccessible ref, clone error, or clone
   *      exceeding the applicable max clone time), ABORT with the cause, produce
   *      NO projectTree, and — CRITICALLY — reap the Sandbox in a `finally` via
   *      sandboxManager.release(projectId) (idempotent + orphan-reaping, Req 6.5)
   *      so no orphaned Sandbox survives. Return { ok:false, code:'IMPORT_FAILED',
   *      message:<cause> }.
   */
  async function populateGithubImport({ project, sandbox, ref, userAccount, grants, repoResource, onProgress, signal }) {
    if (typeof ref !== 'string' || ref.trim() === '') {
      return { ok: false, code: 'IMPORT_FAILED', message: 'a repository ref (originRef) is required to import' };
    }
    if (!authorizer || typeof authorizer.resolveAccess !== 'function') {
      return {
        ok: false,
        code: 'IMPORT_FAILED',
        message: 'an authorizer with resolveAccess is required to import a repository',
      };
    }
    if (!cloner || typeof cloner.clone !== 'function') {
      return {
        ok: false,
        code: 'IMPORT_FAILED',
        message: 'a cloner seam with clone(...) is required to import a repository',
      };
    }

    // 1) Authorize the repo ref BEFORE any clone (Req 6.4). The repo resource is
    //    a control-plane record describing the repo's access ({ id, ownerId }):
    //    the caller supplies it via `repoResource` (resolved from the connected
    //    GitHub identity / repo owner). resolveAccess is an owner-or-grant read
    //    resolution against the REQUESTING userAccount. A denial creates nothing
    //    and never triggers the fetch. We do NOT fabricate requester ownership:
    //    with no repoResource and no matching grant the import is denied.
    const resource =
      repoResource && typeof repoResource === 'object'
        ? repoResource
        : { id: ref };
    const decision = authorizer.resolveAccess(userAccount, { kind: 'repo', resource, grants });
    if (!decision || decision.ok !== true) {
      return {
        ok: false,
        code: 'IMPORT_UNAUTHORIZED',
        message: `not authorized to import repository ${JSON.stringify(ref)}`,
      };
    }

    const projectId = project?.id;
    const startedClone = now();
    let released = false;

    // The confined exec seam handed to the cloner: the clone runs as a bash
    // command INSIDE the project's Sandbox so it passes the permission classifier
    // and is network-confined by the boundary. The ACTUAL network fetch the
    // command performs is what the injected cloner stands in for offline.
    const exec =
      sandboxManager && typeof sandboxManager.exec === 'function' && typeof projectId === 'string'
        ? (command, opts) => sandboxManager.exec(projectId, command, opts)
        : undefined;

    try {
      const cloneResult = await cloner.clone({
        ref,
        projectId,
        sandbox,
        exec,
        maxCloneMs,
        smallRepoSloMs: IMPORT_SMALL_REPO_SLO_MS,
        smallRepoMaxBytes: IMPORT_SMALL_REPO_MAX_BYTES,
        now,
        onProgress: typeof onProgress === 'function' ? onProgress : () => {},
        signal,
      });

      if (!cloneResult || cloneResult.ok !== true) {
        return {
          ok: false,
          code: 'IMPORT_FAILED',
          message: cloneResult?.message ?? `failed to clone repository ${JSON.stringify(ref)}`,
        };
      }

      const tree = cloneResult.projectTree;
      if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
        return {
          ok: false,
          code: 'IMPORT_FAILED',
          message: `clone of ${JSON.stringify(ref)} produced no file tree`,
        };
      }

      // Enforce the applicable clone-time budget against the injected clock. The
      // small-repo (<=100 MB) budget is 120s; a large repo (>100 MB) is bounded
      // by the configurable maxCloneMs. The cloner may also enforce these, but we
      // double-check here so an over-budget clone can never yield a Project.
      const cloneMs = now() - startedClone;
      const sizeBytes = typeof cloneResult.sizeBytes === 'number' ? cloneResult.sizeBytes : undefined;
      const isLarge = typeof sizeBytes === 'number' && sizeBytes > IMPORT_SMALL_REPO_MAX_BYTES;
      const budgetMs = isLarge ? maxCloneMs : IMPORT_SMALL_REPO_SLO_MS;
      if (cloneMs > budgetMs) {
        return {
          ok: false,
          code: 'IMPORT_FAILED',
          message:
            `clone of ${JSON.stringify(ref)} exceeded the ` +
            `${isLarge ? `configurable max clone time (${budgetMs}ms)` : `120s import SLO (${budgetMs}ms)`}`,
        };
      }

      // Deep, independent copy of the cloned tree (the cloner may hand back a map
      // that shares Buffers with its own state).
      return { ok: true, origin: 'github-import', projectTree: deepCopyTree(tree), cloneMs };
    } catch (err) {
      return {
        ok: false,
        code: 'IMPORT_FAILED',
        message: `failed to import repository ${JSON.stringify(ref)}: ${err?.message ?? String(err)}`,
      };
    } finally {
      // Req 6.5: reap the import Sandbox in a finally so a failed (or even a
      // successful) import never leaves an orphaned container. release() is
      // idempotent + orphan-reaping and best-effort here so it cannot mask a
      // real failure. NOTE: on SUCCESS the ProjectManager still owns the
      // project's Sandbox lifecycle for runGeneration; the import clone is a
      // one-shot inside that boundary, so releasing here (and re-acquiring in
      // runGeneration, which auto-acquires) keeps the failure path clean without
      // stranding a container. Callers that must keep the same boundary across
      // import + generation can pass a sandboxManager whose release is a no-op.
      if (sandboxManager && typeof sandboxManager.release === 'function' && typeof projectId === 'string' && !released) {
        released = true;
        try {
          await sandboxManager.release(projectId);
        } catch {
          /* best-effort orphan reap — must not mask the import outcome */
        }
      }
    }
  }

  /**
   * The 'fork' branch (Req 6.6-6.8, Property 10). Fork an existing Project the
   * user is authorized to access, copying its MOST RECENT Snapshot as the new
   * Project's independent starting state.
   *
   * ORDER (create nothing on rejection):
   *   1. Resolve the referenced source Project record (via the injected
   *      projectRegistry) and AUTHORIZE FIRST (Req 6.7/6.8). A nonexistent source
   *      is { ok:false, code:'FORK_NOT_FOUND' }; an unauthorized one is
   *      { ok:false, code:'FORK_UNAUTHORIZED' } — either way NOTHING is created.
   *   2. Read the source's MOST RECENT Snapshot tree (snapshotStore.latestSnapshot
   *      + restore). If the source has no Snapshot yet, fall back to its most
   *      recent PERSISTED tree (persistenceStore.readPersistedTree) — consistent
   *      with the SnapshotStore.resume rule and Req 6.7. With neither available
   *      the fork is rejected ({ ok:false, code:'FORK_EMPTY' }) creating nothing.
   *   3. Return that tree as the fork's projectTree, as a DEEP, INDEPENDENT copy
   *      (Property 10): every entry's contents is cloned so mutating the fork can
   *      never touch the origin's files. ProjectManager materializes it into the
   *      FORK's OWN exportable tree (FEAT-002 step), fully separate from the origin.
   */
  async function populateFork({ project, ref, userAccount, grants }) {
    if (typeof ref !== 'string' || ref.trim() === '') {
      return { ok: false, code: 'FORK_NOT_FOUND', message: 'a source Project id (originRef) is required to fork' };
    }
    if (!authorizer || typeof authorizer.resolveAccess !== 'function') {
      return {
        ok: false,
        code: 'FORK_UNAUTHORIZED',
        message: 'an authorizer with resolveAccess is required to fork a Project',
      };
    }
    if (!snapshotStore || typeof snapshotStore.latestSnapshot !== 'function') {
      return {
        ok: false,
        code: 'FORK_EMPTY',
        message: 'a snapshotStore with latestSnapshot/restore is required to fork a Project',
      };
    }

    // 1) Resolve the source Project record for authorization. Prefer get() (full
    //    record with ownerId); fall back to resolver() ({ id, ownerId }).
    let source = null;
    if (projectRegistry && typeof projectRegistry.get === 'function') {
      source = projectRegistry.get(ref);
    } else if (projectRegistry && typeof projectRegistry.resolver === 'function') {
      source = projectRegistry.resolver(ref);
    }
    if (!source) {
      // Non-disclosure: a nonexistent source is reported as NOT_FOUND without
      // revealing anything about other tenants' resources.
      return { ok: false, code: 'FORK_NOT_FOUND', message: `source Project ${JSON.stringify(ref)} does not exist` };
    }

    // Authorize FIRST against the resolved source Project record (owner-or-grant
    // read). An unauthorized fork creates nothing.
    const decision = authorizer.resolveAccess(userAccount, { kind: 'project', resource: source, grants });
    if (!decision || decision.ok !== true) {
      return { ok: false, code: 'FORK_UNAUTHORIZED', message: `not authorized to fork Project ${JSON.stringify(ref)}` };
    }

    const sourceId = source.id ?? ref;

    // 2) Copy the source's MOST RECENT Snapshot as the starting state.
    const latest = snapshotStore.latestSnapshot(sourceId);
    if (latest && typeof snapshotStore.restore === 'function') {
      const restored = snapshotStore.restore(sourceId, latest.id);
      if (restored && restored.ok === true && restored.projectTree) {
        // Property 10: deep, independent copy — the fork shares NO Buffers/objects
        // with the origin's tree, so mutating the fork never touches the origin.
        return { ok: true, origin: 'fork', projectTree: deepCopyTree(restored.projectTree) };
      }
      // The snapshot exists in the registry but could not be restored — treat as
      // an import failure with the cause rather than silently falling back.
      return {
        ok: false,
        code: 'FORK_EMPTY',
        message: `could not read the most recent Snapshot of source Project ${JSON.stringify(ref)}`,
      };
    }

    // No Snapshot yet: fall back to the source's most recent PERSISTED tree
    // (mirrors SnapshotStore.resume's "no snapshot yet" rule, Req 6.7).
    if (persistenceStore && typeof persistenceStore.readPersistedTree === 'function') {
      const persisted = persistenceStore.readPersistedTree(sourceId);
      if (persisted && Object.keys(persisted).length > 0) {
        return { ok: true, origin: 'fork', projectTree: deepCopyTree(persisted) };
      }
    }

    return {
      ok: false,
      code: 'FORK_EMPTY',
      message: `source Project ${JSON.stringify(ref)} has no Snapshot or persisted file state to fork`,
    };
  }

  return Object.freeze({
    populate,
    TEMPLATE_POPULATE_SLO_MS,
    IMPORT_SMALL_REPO_SLO_MS,
    IMPORT_MAX_CLONE_SLO_MS,
    maxCloneMs,
  });
}

/**
 * Deep, independent copy of a { relPath: contents } tree (Property 10). String
 * contents are immutable so they can be shared; Buffer contents are COPIED so a
 * mutation of the fork/import tree can never write through to the source's bytes.
 * Any other content shape is left as-is (validated downstream by the stores).
 */
function deepCopyTree(tree) {
  const out = {};
  for (const [rel, contents] of Object.entries(tree)) {
    out[rel] = Buffer.isBuffer(contents) ? Buffer.from(contents) : contents;
  }
  return out;
}

/** True when `relPath` is a recognized dependency manifest for a Template. */
function isDependencyManifest(relPath) {
  const base = relPath.split('/').pop();
  return (
    base === 'package.json' ||
    base === 'requirements.txt' ||
    base === 'pyproject.toml' ||
    base === 'go.mod' ||
    base === 'Cargo.toml' ||
    base === 'pom.xml' ||
    base === 'build.gradle'
  );
}
