/**
 * multi-target.js — the Multi-Target coordinator (spec Task 26.3, Req 16.2,
 * 16.3, 16.4, 16.5, 16.6, 16.7, 16.8).
 *
 * A `multi-target` Project maintains EXACTLY four Targets — `web`, `mobile`,
 * `backend`, and `shared` (Req 16.1) — from the CLOSED Target enum in
 * src/model/enums.js (this module derives the set from that enum; it never keeps
 * a parallel hardcoded list). The coordinator owns three cross-Target concerns:
 *
 *   1. shared-code PROPAGATION (Req 16.2/16.3): a completed `shared`
 *      modification is made available to `web`/`mobile`/`backend` within 5s.
 *      Propagation is ALL-OR-NOTHING: if ANY target fails to receive the update
 *      (or the whole propagation blows the 5s budget), the LAST successfully
 *      propagated `shared` version is retained in ALL targets (any partial
 *      propagation is rolled back so there is never a torn state) and each
 *      failed Target is NAMED.
 *   2. the multi-target Preview SELECTOR (Req 16.4/16.5): this REUSES the
 *      existing PreviewController.selectTarget (src/project/preview-controller.js)
 *      — `web` default with an explicit `defaultUsed` indication, the single
 *      selected Target when explicit, and an INVALID_TARGET rejection for an
 *      out-of-enum Target. It builds NO second selector.
 *   3. per-Target BUILD coordination (Req 16.6/16.7/16.8): compose the FEAT-002
 *      build service (src/project/build-service.js) — one Deployment_Artifact
 *      per REQUESTED Target and none for unrequested, a failed Target build still
 *      completes the others while naming the failed one and preserving prior
 *      artifacts, and an invalid requested Target rejects the WHOLE request
 *      naming it without modifying any existing artifact.
 *
 * ================= REAL vs SEAM (READ THIS) =====================
 * REAL (exercised here, offline): the four-Target set is the REAL closed Target
 * enum; the Preview selection is the REAL PreviewController; the build artifacts
 * are REAL createDeploymentArtifact records produced by the REAL FEAT-002 build
 * service (which writes REAL on-disk artifact files).
 *
 * SEAM / PRODUCTION-ONLY (cannot run offline): actually propagating `shared`
 * code into three running Targets (recompiling/republishing each) cannot happen
 * offline. So propagation is an INJECTED `propagateBoundary` seam, exactly like
 * the build/deploy/dev-server seams:
 *
 *     propagateBoundary({ projectId, target, version, signal })
 *        -> { ok:boolean, ... }   (advances the injected clock)
 *
 * The default seam launches nothing real; it synthesizes a success and advances
 * the INJECTED clock (`now`). The 5s propagation SLO (PROPAGATION_SLO_MS) is
 * measured against the injected clock, NEVER a real wall-clock wait.
 *
 * Conventions: a factory createMultiTargetCoordinator({...deps}) returning
 * Object.freeze({...}); dependency injection for the clock (`now`, ms) and every
 * collaborator; structured { ok:true|false, code?, message? } results for
 * expected rejections (never throw on a handled path); no-partial-state (a
 * failed propagation retains the last-good version in all targets). Imports no
 * plumby package directly (the boundary invariant).
 */

import { fail, requireString, requireArray } from '../model/validate.js';
import { Target, isValidTarget } from '../model/enums.js';

/** The <=5s shared-code propagation SLO (Req 16.2), measured on the injected clock. */
export const PROPAGATION_SLO_MS = 5_000;

/**
 * The three Targets a completed `shared` modification is propagated TO (Req 16.2)
 * — derived from the closed Target enum by excluding `shared` itself. Order
 * follows enum order so the four-Target set and this subset never drift.
 */
const PROPAGATION_TARGETS = Target.filter((t) => t !== 'shared');

/**
 * Normalize an OPTIONAL observability/audit sink into a record(event) fn (no-op
 * when absent). Mirrors src/project/build-service.js toRecordSink.
 */
function toRecordSink(sink) {
  if (sink === undefined || sink === null) return () => {};
  if (typeof sink === 'function') return (event) => sink(event);
  if (typeof sink.record === 'function') return (event) => sink.record(event);
  fail('MultiTargetCoordinator', 'observability/audit sink must be a function or an object with a record(event) method');
  return () => {};
}

/** The default (seam-only) propagation boundary: a synthesized instant success. */
function defaultPropagateBoundary() {
  return { ok: true };
}

/**
 * Create a Multi-Target coordinator.
 *
 * @param {object} args
 * @param {object} args.buildService  a Build service (src/project/build-service.js)
 *        with build({projectId,target}) -> { ok, artifact?, ... }. REQUIRED — the
 *        coordinator produces per-Target artifacts by composing this service.
 * @param {object} [args.mobileBuildService]  OPTIONAL mobile build service
 *        (src/project/mobile-build-service.js) with buildMobile({projectId}) ->
 *        { ok, artifact?, ... }. When present, a requested `mobile` Target is
 *        built through it; otherwise `mobile` is routed through buildService too
 *        (the build seam decides how to handle it).
 * @param {object} [args.previewController]  a PreviewController
 *        (src/project/preview-controller.js) whose selectTarget(...) implements
 *        the multi-target Preview selector. REQUIRED for selectPreviewTarget —
 *        the coordinator delegates rather than reimplementing a second selector.
 * @param {(args:{projectId,target,version,signal})=>(object|Promise<object>)} [args.propagateBoundary]
 *        the shared-code propagation seam; resolves to { ok:boolean, ... } and
 *        advances the injected clock. Defaults to a seam-only instant success.
 * @param {() => number} [args.now]   injectable ms clock (default Date.now).
 * @param {number} [args.propagationTimeoutMs=5000]  the 5s propagation SLO.
 * @param {Function|{record:Function}} [args.observability]  OPTIONAL observability sink.
 * @param {Function|{record:Function}} [args.audit]          OPTIONAL audit sink.
 * @returns {object} multi-target coordinator (frozen)
 */
export function createMultiTargetCoordinator({
  buildService,
  mobileBuildService,
  previewController,
  propagateBoundary = defaultPropagateBoundary,
  now = Date.now,
  propagationTimeoutMs = PROPAGATION_SLO_MS,
  observability,
  audit,
} = {}) {
  const model = 'MultiTargetCoordinator';
  if (!buildService || typeof buildService.build !== 'function') {
    fail(model, 'a buildService with build({projectId,target}) is required');
  }
  if (mobileBuildService !== undefined && (mobileBuildService === null || typeof mobileBuildService.buildMobile !== 'function')) {
    fail(model, 'mobileBuildService, when present, must have buildMobile({projectId})');
  }
  if (previewController !== undefined && (previewController === null || typeof previewController.selectTarget !== 'function')) {
    fail(model, 'previewController, when present, must have selectTarget({...})');
  }
  if (typeof propagateBoundary !== 'function') {
    fail(model, 'propagateBoundary must be a function');
  }
  if (typeof now !== 'function') {
    fail(model, 'now must be a function returning milliseconds');
  }
  if (typeof propagationTimeoutMs !== 'number' || !Number.isFinite(propagationTimeoutMs) || propagationTimeoutMs <= 0) {
    fail(model, 'propagationTimeoutMs must be a positive number');
  }

  const emitObservability = toRecordSink(observability);
  const emitAudit = toRecordSink(audit);

  /**
   * Per-project shared-propagation state. Tracks the LAST GOOD `shared` version
   * (the last one successfully propagated to ALL of web/mobile/backend) plus,
   * per propagation target, the version that target currently HAS. On a failed
   * propagation, every target is rolled back to lastGood so there is no torn
   * state. key = projectId.
   *
   * Shape: { lastGood: version|null, received: Map<target, version> }
   */
  const sharedState = new Map();

  function sharedStateFor(projectId) {
    let s = sharedState.get(projectId);
    if (!s) {
      s = { lastGood: null, received: new Map(PROPAGATION_TARGETS.map((t) => [t, null])) };
      sharedState.set(projectId, s);
    }
    return s;
  }

  /**
   * targets() — the EXACT four Targets of a multi-target Project (Req 16.1),
   * derived from the closed Target enum in enum order. Returns a fresh copy so a
   * caller cannot mutate the coordinator's view.
   *
   * @returns {string[]} exactly ['web','backend','mobile','shared'] (enum order)
   */
  function targets() {
    return Target.slice();
  }

  /**
   * propagateShared({ projectId, version, signal }) — make a completed `shared`
   * modification available to `web`/`mobile`/`backend` within 5s (Req 16.2), or
   * retain the last good version everywhere and name each failed Target (Req 16.3).
   *
   * ALL-OR-NOTHING: we snapshot the last-good version, attempt to propagate the
   * new version to each of the three propagation targets via the injected seam
   * (each advances the injected clock), and only COMMIT the new version as
   * last-good in ALL targets when every target succeeded AND the total
   * propagation stayed within the 5s SLO. On ANY target failing, or the total
   * exceeding 5s, we ROLL BACK every propagation target to the last-good version
   * (no torn state) and return the failed Target names.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.version   an identifier for the new `shared` version
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} a frozen structured result
   */
  async function propagateShared(params = {}) {
    const { projectId, version, signal } = params;
    requireString(model, 'projectId', projectId);
    requireString(model, 'version', version);

    const s = sharedStateFor(projectId);
    const lastGood = s.lastGood; // snapshot BEFORE any change (may be null)

    const startedAt = now();
    const failedTargets = [];

    for (const target of PROPAGATION_TARGETS) {
      let result;
      try {
        result = await propagateBoundary({ projectId, target, version, signal });
      } catch (err) {
        failedTargets.push(target);
        continue;
      }
      if (result && result.ok === true) {
        // Provisionally record receipt; rolled back below if the whole op fails.
        s.received.set(target, version);
      } else {
        failedTargets.push(target);
      }
    }

    const propagationMs = Math.max(0, now() - startedAt);
    const overBudget = propagationMs > propagationTimeoutMs;

    if (failedTargets.length === 0 && !overBudget) {
      // COMMIT: the new version is now last-good in all targets.
      s.lastGood = version;
      for (const target of PROPAGATION_TARGETS) s.received.set(target, version);
      emitAudit({ type: 'multitarget.propagate.succeeded', projectId, version, propagationMs });
      emitObservability({ type: 'multitarget.propagate', projectId, ok: true, code: 'PROPAGATED', propagationMs });
      return Object.freeze({
        ok: true,
        version,
        propagationMs,
        message: `shared version ${version} propagated to ${PROPAGATION_TARGETS.join(', ')}`,
      });
    }

    // FAILURE (a failed target and/or over budget) — ALL-OR-NOTHING rollback:
    // retain the LAST GOOD version in ALL targets so there is never a torn state.
    for (const target of PROPAGATION_TARGETS) s.received.set(target, lastGood);
    // If we blew the budget but every target technically "received", still name
    // every propagation target as failed-to-receive-within-budget so the caller
    // sees which targets are affected.
    const named = failedTargets.length > 0 ? failedTargets.slice() : PROPAGATION_TARGETS.slice();

    emitObservability({ type: 'multitarget.propagate', projectId, ok: false, code: 'PROPAGATION_FAILED', propagationMs, failedTargets: named });
    return Object.freeze({
      ok: false,
      code: 'PROPAGATION_FAILED',
      failedTargets: Object.freeze(named),
      // Echo the retained (last-good) version so a caller/test can assert the
      // retained version equals the PRIOR good, not the new one.
      retainedVersion: lastGood,
      version,
      propagationMs,
      overBudget,
      message:
        overBudget && failedTargets.length === 0
          ? `shared propagation exceeded the ${propagationTimeoutMs}ms SLO (took ${propagationMs}ms); retained last good version in all Targets`
          : `shared propagation failed for Target(s): ${named.join(', ')}; retained last good version in all Targets`,
    });
  }

  /**
   * receivedSharedVersion(projectId, target) — introspection: the `shared`
   * version a given propagation target currently HAS (proof that a failed
   * propagation retained the last-good version everywhere).
   */
  function receivedSharedVersion(projectId, target) {
    requireString(model, 'projectId', projectId);
    if (!PROPAGATION_TARGETS.includes(target)) {
      fail(model, `receivedSharedVersion target must be one of [${PROPAGATION_TARGETS.join(', ')}]`);
    }
    const s = sharedState.get(projectId);
    return s ? s.received.get(target) ?? null : null;
  }

  /** Introspection: the last successfully propagated `shared` version, or null. */
  function lastGoodSharedVersion(projectId) {
    requireString(model, 'projectId', projectId);
    const s = sharedState.get(projectId);
    return s ? s.lastGood : null;
  }

  /**
   * selectPreviewTarget({ projectId, target?, targetCategory? }) — the
   * multi-target Preview selector (Req 16.4/16.5). DELEGATES to the composed
   * PreviewController.selectTarget: `web` default with defaultUsed:true when none
   * selected, the single selected Target when explicit, and an INVALID_TARGET
   * rejection for an out-of-enum Target. This module reimplements NO selector.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} [params.target]         the explicitly selected Target (optional)
   * @param {string} [params.targetCategory] the Project's Target_Category (optional)
   * @returns {object} the PreviewController.selectTarget result (delegated)
   */
  function selectPreviewTarget(params = {}) {
    const { projectId, target, targetCategory } = params;
    requireString(model, 'projectId', projectId);
    if (!previewController || typeof previewController.selectTarget !== 'function') {
      fail(model, 'a previewController with selectTarget(...) is required to select a Preview Target');
    }
    return previewController.selectTarget({ projectId, targetCategory, target });
  }

  /**
   * buildTargets({ projectId, targets, signal }) — build EXACTLY the requested
   * Targets (Req 16.6/16.7/16.8).
   *
   * Order:
   *   (1) VALIDATE every requested Target FIRST. An invalid Target rejects the
   *       WHOLE request with INVALID_TARGET naming it, modifying NO existing
   *       artifact (Req 16.8) — no build is attempted for any Target.
   *   (2) For each REQUESTED Target (and ONLY requested — none for unrequested,
   *       Req 16.6), invoke the build seam: `mobile` through the mobile build
   *       service when provided, else through the build service. Produce exactly
   *       one artifact per SUCCESSFUL Target.
   *   (3) A FAILED Target build still completes the remaining requested Targets
   *       (Req 16.7), produces NO artifact for the failed one, collects it into
   *       failedTargets NAMING it, and PRESERVES previously produced artifacts
   *       (the build service keeps its own prior artifacts; we never delete them).
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string[]} params.targets   the explicitly requested Targets
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} a frozen structured result
   */
  async function buildTargets(params = {}) {
    const { projectId, targets: requested, signal } = params;
    requireString(model, 'projectId', projectId);
    requireArray(model, 'targets', requested);

    // (1) VALIDATE every requested Target FIRST — reject the WHOLE request on the
    // first invalid Target, naming it, modifying NO existing artifact (Req 16.8).
    for (const target of requested) {
      if (!isValidTarget(target)) {
        emitObservability({ type: 'multitarget.build', projectId, ok: false, code: 'INVALID_TARGET', target });
        return Object.freeze({
          ok: false,
          code: 'INVALID_TARGET',
          target,
          message: `invalid Target ${JSON.stringify(target)}: must be one of [${Target.join(', ')}]`,
        });
      }
    }

    // (2)/(3) Build each requested Target; a failure does NOT stop the others.
    const artifacts = {};
    const failedTargets = [];

    for (const target of requested) {
      let res;
      try {
        if (target === 'mobile' && mobileBuildService) {
          res = await mobileBuildService.buildMobile({ projectId, signal });
        } else {
          res = await buildService.build({ projectId, target, signal });
        }
      } catch (err) {
        failedTargets.push(target);
        continue;
      }
      if (res && res.ok === true && res.artifact) {
        artifacts[target] = res.artifact;
      } else {
        // No artifact produced for a failed Target; name it. Prior artifacts of
        // other Targets are untouched (each build seam preserves its own).
        failedTargets.push(target);
      }
    }

    const ok = failedTargets.length === 0;
    if (ok) {
      emitAudit({ type: 'multitarget.build.succeeded', projectId, targets: requested.slice() });
    }
    emitObservability({
      type: 'multitarget.build',
      projectId,
      ok,
      code: ok ? 'BUILT' : 'PARTIAL',
      built: Object.keys(artifacts),
      failedTargets: failedTargets.slice(),
    });
    return Object.freeze({
      ok,
      artifacts: Object.freeze({ ...artifacts }),
      failedTargets: Object.freeze(failedTargets.slice()),
      message: ok
        ? `built ${Object.keys(artifacts).join(', ') || 'no Targets'}`
        : `built ${Object.keys(artifacts).join(', ') || 'no Targets'}; failed Target(s): ${failedTargets.join(', ')}`,
    });
  }

  return Object.freeze({
    targets,
    propagateShared,
    receivedSharedVersion,
    lastGoodSharedVersion,
    selectPreviewTarget,
    buildTargets,
    propagationTimeoutMs,
  });
}
