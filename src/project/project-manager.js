/**
 * project-manager.js — the ProjectManager (spec subtasks 13.1 + 13.2, Req 1.1,
 * 1.3, 1.4-1.7, 5.7).
 *
 * The ProjectManager is the ORCHESTRATION layer for a Project's lifecycle. It
 * ties together the already-merged pieces — the SandboxManager (acquire), the
 * QuotaManager (totalProjects Resource_Quota), the plumby Builder_Agent + verify
 * (through src/engine/plumby.js only), the SnapshotStore turn-pass policy, and
 * the Project record + closed enums — into three responsibilities:
 *
 *   validateCreateInput(input)     — reject bad create input at the edge BEFORE
 *                                    any Project is created or any Sandbox is
 *                                    allocated (Req 1.4-1.6, 5.7).
 *
 *   createProject(input)           — the "begins creation within 10s" path
 *                                    (Req 1.1): validate -> (quota) -> build +
 *                                    register the Project record -> acquire its
 *                                    Sandbox -> return handles + a measured
 *                                    beginsCreationMs from the injected clock.
 *
 *   populateOrigin(args)           — materialize a Project's ORIGIN starting tree
 *                                    (Task 14, Req 6.1-6.3/6.8/6.9): run the
 *                                    injected ProjectOrigin.populate for the
 *                                    origin, persist the resulting tree into the
 *                                    Project's exportable tree, and roll back the
 *                                    Sandbox + registry on failure. ALL four
 *                                    origins converge here and then onto the SAME
 *                                    runGeneration pipeline (no forked lifecycle).
 *
 *   runGeneration(args)            — the generation -> verify -> Dev_Server-start
 *                                    / editable-on-fail pipeline (Req 1.3, 1.7).
 *
 * WHERE THIS SITS RELATIVE TO THE GATE: the Builder-Server gate ordering
 * (authn/authz -> QuotaManager.checkRate/checkQuota -> allocation) is REUSED, not
 * duplicated. The ProjectManager runs BEHIND that gate, so createProject does NOT
 * re-run rate limiting; it DOES enforce the totalProjects Resource_Quota (a
 * per-account ceiling the create route's rate check does not cover) via the
 * injected QuotaManager using registry.countForOwner as the projectCounter.
 *
 * THE PLUMBY BOUNDARY: this module NEVER imports the plumby package. The
 * Builder_Agent is built ONLY via the injected `agentFactory` (whose production
 * wiring uses src/engine/plumby.js createAgent), and verification runs ONLY via
 * the injected `verify` seam (whose production wiring wraps plumby verifyTool
 * through src/engine/plumby.js). Both are DI seams so tests drive scripted fakes.
 *
 * OFFLINE-ENVIRONMENT SEAMS: a real Sandbox provisioning latency, a real
 * Dev_Server process, and a real Preview cannot run offline. The 10s "begins
 * creation" SLO (Req 1.1) and the <=60s Dev_Server-start SLO (Req 1.3) are
 * therefore MEASURED against an injected clock, not real waits, and the
 * Dev_Server is an injected seam (src/project/dev-server.js) that launches
 * nothing. Source generation streams AFTER the 10s window (createProject only
 * begins creation); runGeneration delegates the actual turn to the Builder_Agent.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * clocks and every collaborator; structured { ok:true|false, code?, message? }
 * results for expected rejections (the create surface never throws on bad input).
 */

import { randomUUID } from 'node:crypto';

import { fail } from '../model/validate.js';
import { isValidTargetCategory, isValidProjectOrigin, Target_Category, Project_Origin } from '../model/enums.js';
import { createProject as createProjectRecord } from '../model/project.js';
import { createVerifyResult, VERIFY_VERDICTS } from '../model/deployment.js';

/** The maximum accepted Project description length, after trimming (Req 5.7). */
export const MAX_DESCRIPTION_CHARS = 5000;

/** Default Builder model provider/model when a caller does not specify one. */
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet';

/**
 * Create a ProjectManager.
 *
 * @param {object} args
 * @param {object} args.registry        a ProjectRegistry (register/get/countForOwner/resolver)
 * @param {object} args.sandboxManager  a SandboxManager (acquire/release/activeProjectIds)
 * @param {object} [args.quotaManager]  an OPTIONAL QuotaManager; when present the
 *        totalProjects Resource_Quota is enforced (rate limiting is the gate's job)
 * @param {object} [args.authService]   OPTIONAL AuthService (reserved; the gate authorizes)
 * @param {object} [args.snapshotStore] OPTIONAL SnapshotStore; onTurnComplete reused on PASS
 * @param {object} [args.projectOrigin] OPTIONAL ProjectOrigin (src/project/project-origins.js)
 *        with populate({...}); when injected, populateOrigin materializes the
 *        origin's starting tree. Its ABSENCE keeps existing (no-origin) behavior
 *        unchanged — origin population is strictly additive (FEAT-002).
 * @param {object} [args.persistenceStore] OPTIONAL PersistenceStore; when injected
 *        with a projectOrigin, populateOrigin persists the origin tree durably
 *        (persist + flush) into layout.exportableProjectTree(projectId).
 * @param {object} args.devServer       the Dev_Server seam (start/stop) — see dev-server.js
 * @param {Function} args.agentFactory  builds the Builder_Agent for a turn (plumby via engine boundary)
 * @param {Function} args.verify        the verify seam; returns plumby-verify TEXT
 *        ('verdict: PASS'/'verdict: FAIL' ...) OR a VerifyResult-shaped object
 * @param {() => number} [args.now]     injectable ms clock for the SLOs. Default Date.now.
 * @param {string} [args.defaultProvider]
 * @param {string} [args.defaultModel]
 * @param {() => string} [args.idFactory]  injectable id generator. Default randomUUID.
 * @returns {object} manager (frozen)
 */
export function createProjectManager({
  registry,
  sandboxManager,
  quotaManager,
  authService,
  snapshotStore,
  projectOrigin,
  persistenceStore,
  devServer,
  agentFactory,
  verify,
  now = () => Date.now(),
  defaultProvider = DEFAULT_PROVIDER,
  defaultModel = DEFAULT_MODEL,
  idFactory = () => randomUUID(),
} = {}) {
  const model = 'ProjectManager';
  if (!registry || typeof registry.register !== 'function' || typeof registry.countForOwner !== 'function') {
    fail(model, 'registry with register/countForOwner is required');
  }
  if (!sandboxManager || typeof sandboxManager.acquire !== 'function') {
    fail(model, 'sandboxManager with acquire(projectId) is required');
  }
  if (!devServer || typeof devServer.start !== 'function') {
    fail(model, 'devServer with start(...) is required');
  }
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');
  if (typeof idFactory !== 'function') fail(model, 'idFactory must be a function');

  /**
   * validateCreateInput({ description, targetCategory, origin }) — reject bad
   * create input at the edge with a SPECIFIC message (Req 1.4-1.6, 5.7).
   * Returns { ok:true, description } (the trimmed description) on success, or a
   * structured { ok:false, code, message } on rejection. It performs NO registry
   * write and NO Sandbox allocation — validation runs strictly before any
   * Project is created.
   *
   * @returns {{ ok:true, description:string } | { ok:false, code:string, message:string }}
   */
  function validateCreateInput({ description, targetCategory, origin } = {}) {
    // Description: required, 1..MAX_DESCRIPTION_CHARS after trimming whitespace.
    if (typeof description !== 'string' || description.trim() === '') {
      return { ok: false, code: 'DESCRIPTION_REQUIRED', message: 'a description is required' };
    }
    const trimmed = description.trim();
    if (trimmed.length > MAX_DESCRIPTION_CHARS) {
      return {
        ok: false,
        code: 'DESCRIPTION_LENGTH',
        message: 'description must be between 1 and 5,000 characters after trimming whitespace',
      };
    }

    // Target_Category: must be a member of the closed enum.
    if (!isValidTargetCategory(targetCategory)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_TARGET_CATEGORY',
        message:
          `unsupported Target_Category ${JSON.stringify(targetCategory)}: ` +
          `must be one of [${Target_Category.join(', ')}]`,
      };
    }

    // Project_Origin: must be a member of the closed enum. Origin POPULATION
    // (producing the origin's starting tree for blank/template/github-import/
    // fork) is implemented in the ProjectOrigin module and driven by
    // populateOrigin below (Task 14); this edge check only rejects an origin
    // outside the closed enum before any Project is created.
    if (!isValidProjectOrigin(origin)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_ORIGIN',
        message:
          `unsupported Project_Origin ${JSON.stringify(origin)}: ` +
          `must be one of [${Project_Origin.join(', ')}]`,
      };
    }

    return { ok: true, description: trimmed };
  }

  /**
   * createProject({ accountId, description, targetCategory, origin, ref? }) — the
   * "begins creation within 10s" path (Req 1.1).
   *
   * Order (allocate NOTHING on any rejection):
   *   1. validateCreateInput first — a validation rejection creates no Project
   *      and acquires no Sandbox.
   *   2. If a QuotaManager is injected, enforce the Resource_Quotas BEFORE any
   *      allocation, in the same order the /message path uses (quota -> acquire):
   *        (a) totalProjects  — checkQuota(account, null, 'totalProjects') using
   *            registry.countForOwner as the projectCounter (a per-account
   *            ceiling); and
   *        (b) concurrentSandboxes — checkQuota(account, projectId,
   *            'concurrentSandboxes') because createProject ACQUIRES a Sandbox,
   *            so a create must count against the same concurrent-boundary
   *            ceiling /message enforces (review finding 1). Both refuse
   *            over-quota with the named limit and NO allocation / NO registry
   *            write. (Rate limiting is the Builder-Server gate's job; not re-run.)
   *   3. Build the Project record (createProject from the model) with a generated
   *      id, ownerId=accountId, the validated fields, the sandboxId, empty
   *      targets/snapshots/connectors, provider/model, createdAt/updatedAt=now.
   *   4. Register it in the registry.
   *   5. Acquire its Sandbox so it becomes available for streaming. If acquire
   *      throws AFTER registration, ROLL BACK the registry entry so a failed
   *      create leaves NO partial Project (review finding 5, "no partial
   *      Project").
   *   6. Return { ok:true, project, sandbox, beganAt, beginsCreationMs } — the
   *      elapsed "begins creation" time is measured from the injected clock so
   *      the 10s SLO is observable/testable.
   *
   * Source generation streams AFTERWARD (see runGeneration) and is NOT part of
   * the 10s window — createProject only BEGINS creation.
   *
   * @returns {{ ok:true, project, sandbox, beganAt:number, beginsCreationMs:number }
   *          | { ok:false, code, message, ... }}
   */
  function createProject({ accountId, description, targetCategory, origin, ref } = {}) {
    const startedAt = now();

    if (typeof accountId !== 'string' || accountId.trim() === '') {
      return { ok: false, code: 'ACCOUNT_REQUIRED', message: 'an accountId is required' };
    }

    // 1) Validate at the edge — NO allocation on rejection.
    const validated = validateCreateInput({ description, targetCategory, origin });
    if (!validated.ok) return validated;

    // The projectId is minted BEFORE the quota checks so the concurrentSandboxes
    // gate can name the boundary it would create; it is also the sandboxId.
    const id = idFactory();

    // 2) Enforce the Resource_Quotas BEFORE any allocation, in the same order the
    //    /message path uses: totalProjects, then concurrentSandboxes. Rate
    //    limiting is the Builder-Server gate's job and is not re-run here.
    if (quotaManager && typeof quotaManager.checkQuota === 'function') {
      // (a) Per-account total-Projects ceiling.
      const totalQuota = quotaManager.checkQuota({ id: accountId }, null, 'totalProjects');
      if (totalQuota && totalQuota.ok === false) {
        return quotaRejection(totalQuota);
      }
      // (b) Concurrent-Sandbox ceiling — createProject acquires a Sandbox, so a
      //     create must count against the same boundary /message enforces.
      const concurrentQuota = quotaManager.checkQuota({ id: accountId }, id, 'concurrentSandboxes');
      if (concurrentQuota && concurrentQuota.ok === false) {
        return quotaRejection(concurrentQuota);
      }
    }

    // 3) Build the Project record. The sandboxId is the projectId (the
    //    SandboxManager keys the per-project boundary by projectId).
    const createdAt = new Date(startedAt).toISOString();
    const project = createProjectRecord({
      id,
      ownerId: accountId,
      description: validated.description,
      targetCategory,
      origin,
      originRef: typeof ref === 'string' ? ref : undefined,
      targets: [],
      sandboxId: id,
      snapshots: [],
      connectors: [],
      provider: defaultProvider,
      model: defaultModel,
      createdAt,
      updatedAt: createdAt,
    });

    // 4) Register (persists out-of-tree, round-tripping through createProject).
    const registered = registry.register(project);

    // 5) Allocate the Sandbox so the project is available for streaming. If
    //    acquire throws AFTER registration, ROLL BACK the registry entry so a
    //    failed create leaves NO partial Project (review finding 5). The record
    //    is only durable once its Sandbox is acquired.
    let sandbox;
    try {
      sandbox = sandboxManager.acquire(id);
    } catch (err) {
      rollbackRegistration(id, accountId);
      return {
        ok: false,
        code: 'SANDBOX_ACQUIRE_FAILED',
        message: `sandbox acquisition failed after registration; rolled back: ${err?.message ?? String(err)}`,
      };
    }

    // 6) Measure the "begins creation" elapsed time for the SLO.
    const beganAt = now();
    const beginsCreationMs = beganAt - startedAt;

    return { ok: true, project: registered, sandbox, beganAt, beginsCreationMs };
  }

  /** Map a QuotaManager rejection to the createProject rejection shape. */
  function quotaRejection(quota) {
    return {
      ok: false,
      code: 'QUOTA_EXCEEDED',
      message: quota.message ?? 'resource quota exceeded',
      limit: quota.limit,
      resource: quota.resource,
      max: quota.max,
      current: quota.current,
    };
  }

  /**
   * Compensating action: remove a just-registered Project when a later creation
   * step fails, so no orphaned registry entry survives (review finding 5).
   * Best-effort — a rollback failure must not mask the original error.
   */
  function rollbackRegistration(projectId, ownerId) {
    if (typeof registry.unregister === 'function') {
      try {
        registry.unregister(projectId, ownerId);
      } catch {
        /* best-effort rollback */
      }
    }
  }

  /**
   * populateOrigin({ project, sandbox, ref }) — materialize a created Project's
   * ORIGIN starting tree (Task 14, Req 6.1-6.3, 6.8, 6.9). This runs AFTER
   * createProject has returned (so the 10s "begins creation" measurement stays
   * honest — origin population is a SEPARATE, origin-specific bound, e.g. the
   * Template 30s SLO of Req 5.2), and BEFORE runGeneration. All four origins
   * converge here and then onto the SAME runGeneration pipeline — the lifecycle
   * is never forked per origin (Req 6.9).
   *
   * Order:
   *   1. Ask the injected ProjectOrigin to populate the origin's initial tree
   *      (blank/template now; github-import/fork in FEAT-003). populate performs
   *      NO agent generation — it only produces the starting { relPath: contents }.
   *   2. On a populate failure AFTER the Sandbox was acquired, ROLL BACK exactly
   *      as the SANDBOX_ACQUIRE_FAILED path does: reap the Sandbox
   *      (sandboxManager.release) and unregister the Project, so a failed create
   *      leaves NO partial Project and NO orphaned Sandbox.
   *   3. On success, materialize the tree into the Project's exportable tree via
   *      the injected PersistenceStore (persist + flush so it is durable) and
   *      return the populated tree + the origin's measured populateMs.
   *
   * REQUIREMENTS: an origin collaborator must be injected. It is OPTIONAL on the
   * manager (existing no-origin flows are unaffected); calling populateOrigin
   * without one is a structured ORIGIN_UNAVAILABLE rejection, not a throw.
   *
   * @param {object} args
   * @param {object} args.project  the created Project record (from createProject)
   * @param {object} [args.sandbox] the acquired Sandbox handle
   * @param {string} [args.ref]     origin ref (import url / fork source id)
   * @param {object} [args.userAccount] the REQUESTING account, threaded through
   *        to the ProjectOrigin for github-import / fork authorization (Req 6.4,
   *        6.7). Absent for origins that need no authorization (blank/template).
   * @param {Array<object>} [args.grants]  optional Share_Link grants for authorization
   * @param {object} [args.repoResource]   github-import repo record { id, ownerId }
   *        the repo authorization is resolved against (threaded to the ProjectOrigin)
   * @param {(progress:object)=>void} [args.onProgress]  large-repo import progress sink
   * @param {AbortSignal} [args.signal]     optional abort signal for the import clone
   * @returns {Promise<{ ok:true, project, projectTree, populateMs, origin }
   *          | { ok:false, code, message, failedArtifact? }>}
   */
  async function populateOrigin({ project, sandbox, ref, userAccount, grants, repoResource, onProgress, signal } = {}) {
    if (!project || typeof project.id !== 'string') {
      return { ok: false, code: 'PROJECT_REQUIRED', message: 'a project record is required' };
    }
    if (!projectOrigin || typeof projectOrigin.populate !== 'function') {
      return { ok: false, code: 'ORIGIN_UNAVAILABLE', message: 'no projectOrigin was injected' };
    }

    const populated = await projectOrigin.populate({
      project,
      sandbox,
      origin: project.origin,
      targetCategory: project.targetCategory,
      ref: ref ?? project.originRef,
      userAccount,
      grants,
      repoResource,
      onProgress,
      signal,
    });

    // On any populate failure AFTER acquire, roll back the Sandbox + registry so
    // a failed create leaves no partial Project and no orphaned Sandbox (mirrors
    // the SANDBOX_ACQUIRE_FAILED rollback).
    if (!populated || populated.ok === false) {
      rollbackAfterAcquire(project.id, project.ownerId);
      return {
        ok: false,
        code: populated?.code ?? 'ORIGIN_POPULATION_FAILED',
        message: populated?.message ?? 'origin population failed',
        ...(populated?.failedArtifact !== undefined ? { failedArtifact: populated.failedArtifact } : {}),
      };
    }

    // Materialize the origin's starting tree into the Project's exportable tree,
    // durably (persist + flush). If the persistence write itself fails, roll back
    // as well so no orphaned Sandbox / partial Project survives.
    if (persistenceStore && typeof persistenceStore.persist === 'function') {
      persistenceStore.persist(project.id, populated.projectTree);
      const flushed = typeof persistenceStore.flush === 'function'
        ? persistenceStore.flush(project.id)
        : { ok: true };
      if (flushed && flushed.ok === false) {
        rollbackAfterAcquire(project.id, project.ownerId);
        return {
          ok: false,
          code: 'ORIGIN_PERSIST_FAILED',
          message: `failed to persist origin tree for project ${project.id}: ${flushed.error?.message ?? 'persistence failure'}`,
        };
      }
    }

    return {
      ok: true,
      project,
      projectTree: populated.projectTree,
      populateMs: populated.populateMs,
      origin: populated.origin,
    };
  }

  /**
   * Compensating action for a failure AFTER the Sandbox was acquired: reap the
   * Sandbox (release is idempotent + orphan-reaping, safe in a finally) and roll
   * back the registry entry. Best-effort — neither step must mask the original
   * error. Mirrors the createProject SANDBOX_ACQUIRE_FAILED rollback.
   */
  function rollbackAfterAcquire(projectId, ownerId) {
    if (sandboxManager && typeof sandboxManager.release === 'function') {
      try {
        sandboxManager.release(projectId);
      } catch {
        /* best-effort sandbox reap */
      }
    }
    rollbackRegistration(projectId, ownerId);
  }

  /**
   * Normalize a verify seam result into a VerifyResult record (createVerifyResult,
   * VERIFY_VERDICTS). The plumby verify contract is TEXT beginning with
   * 'verdict: PASS' or 'verdict: FAIL'; we parse that. A caller may instead pass
   * an already-structured VerifyResult-shaped object, which we accept directly.
   *
   * @param {string|object} raw
   * @returns {object} VerifyResult
   */
  function normalizeVerifyResult(raw) {
    // Already a structured result (has a verdict): validate through the model.
    if (raw && typeof raw === 'object' && typeof raw.verdict === 'string') {
      return createVerifyResult({
        verdict: raw.verdict,
        exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : (raw.verdict === 'PASS' ? 0 : 1),
        failureLines: typeof raw.failureLines === 'string' ? raw.failureLines : '',
        outputTail: typeof raw.outputTail === 'string' ? raw.outputTail : '',
      });
    }

    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    // The contract: the text BEGINS with 'verdict: PASS' or 'verdict: FAIL'.
    const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
    const pass = /^verdict:\s*PASS\b/i.test(firstLine);
    const fail_ = /^verdict:\s*FAIL\b/i.test(firstLine);
    const verdict = pass ? VERIFY_VERDICTS[0] : fail_ ? VERIFY_VERDICTS[1] : VERIFY_VERDICTS[1];

    // Best-effort exit-code parse ("exit code: <n>"), default 0 on PASS / 1 on FAIL.
    let exitCode = verdict === 'PASS' ? 0 : 1;
    const m = /exit code:\s*(-?\d+)/i.exec(text);
    if (m) exitCode = Number.parseInt(m[1], 10);

    // On FAIL, capture the output tail (everything after the verdict line) so the
    // caller can report the failure without reinterpreting it.
    const outputTail = verdict === 'FAIL' ? text : '';
    const failureLines = verdict === 'FAIL' ? firstLine : '';

    return createVerifyResult({ verdict, exitCode, failureLines, outputTail });
  }

  /**
   * runGeneration({ project, sandbox, message, projectTree?, signal? }) — the
   * generation -> verify -> Dev_Server pipeline (spec subtask 13.2, Req 1.3/1.7).
   *
   *   1. Delegate a turn to the Builder_Agent (built via the injected agentFactory,
   *      which reaches plumby ONLY through src/engine/plumby.js). Generation is
   *      NOT part of the 10s create window.
   *   2. On generation completion, run the injected `verify` seam (production:
   *      plumby verifyTool through the engine boundary) and normalize its result
   *      to a VerifyResult (parsing the 'verdict: PASS'/'verdict: FAIL' contract).
   *   3. On PASS: start the Dev_Server seam (the <=60s "Preview available" bound
   *      is an SLO measured against the injected clock, not a real wait) and,
   *      when a SnapshotStore is injected, REUSE snapshotStore.onTurnComplete so
   *      the existing turn-pass snapshot policy commits — snapshot logic is NOT
   *      reinvented here.
   *   4. On FAIL: report the captured error output (failureLines/outputTail), do
   *      NOT start the Dev_Server, and leave the project files editable (make no
   *      destructive change to the tree).
   *
   * @returns {Promise<{ ok:true, verdict:'PASS', verifyResult, devServer, snapshot?, startedAt, elapsedMs }
   *          | { ok:false, verdict:'FAIL', verifyResult, failureLines, outputTail, editable:true }
   *          | { ok:false, code:string, message:string }>}
   */
  async function runGeneration({ project, sandbox, message, projectTree, signal } = {}) {
    if (!project || typeof project.id !== 'string') {
      return { ok: false, code: 'PROJECT_REQUIRED', message: 'a project record is required' };
    }
    if (typeof agentFactory !== 'function') {
      return { ok: false, code: 'AGENT_UNAVAILABLE', message: 'no agentFactory was injected' };
    }
    if (typeof verify !== 'function') {
      return { ok: false, code: 'VERIFY_UNAVAILABLE', message: 'no verify seam was injected' };
    }

    // 1) Delegate the turn to the Builder_Agent.
    const built = agentFactory({ projectId: project.id, sandbox, project });
    const agent = built && built.agent ? built.agent : built;
    if (!agent || typeof agent.send !== 'function') {
      return { ok: false, code: 'AGENT_UNAVAILABLE', message: 'agentFactory did not yield an agent with send()' };
    }
    try {
      await agent.send(typeof message === 'string' ? message : '', { signal });
    } catch (err) {
      return { ok: false, code: 'GENERATION_FAILED', message: err?.message ?? String(err) };
    }

    // 2) Verify + normalize to a VerifyResult.
    let verifyResult;
    try {
      const raw = await verify({ projectId: project.id, sandbox, project });
      verifyResult = normalizeVerifyResult(raw);
    } catch (err) {
      return { ok: false, code: 'VERIFY_FAILED', message: err?.message ?? String(err) };
    }

    // 4) FAIL: report the captured error, DO NOT start the Dev_Server, leave the
    //    files editable (no destructive tree change performed here).
    if (verifyResult.verdict === VERIFY_VERDICTS[1]) {
      return {
        ok: false,
        verdict: 'FAIL',
        verifyResult,
        failureLines: verifyResult.failureLines,
        outputTail: verifyResult.outputTail,
        editable: true,
      };
    }

    // 3) PASS: reuse the SnapshotStore turn-pass policy (when injected), then
    //    start the Dev_Server seam and measure the start SLO.
    let snapshot;
    if (snapshotStore && typeof snapshotStore.onTurnComplete === 'function' && projectTree !== undefined) {
      snapshot = snapshotStore.onTurnComplete({ projectId: project.id, projectTree, verifyResult });
    }

    const startedAt = now();
    const started = devServer.start({
      projectId: project.id,
      sandbox,
      targetCategory: project.targetCategory,
    });
    const elapsedMs = now() - startedAt;

    return {
      ok: true,
      verdict: 'PASS',
      verifyResult,
      devServer: started,
      ...(snapshot !== undefined ? { snapshot } : {}),
      startedAt,
      elapsedMs,
    };
  }

  return Object.freeze({
    validateCreateInput,
    createProject,
    populateOrigin,
    runGeneration,
    normalizeVerifyResult,
    MAX_DESCRIPTION_CHARS,
  });
}
