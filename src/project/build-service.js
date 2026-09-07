/**
 * build-service.js — the Build + Deploy SEAM for NON-`mobile` Targets
 * (spec Task 26.1, Req 18.1, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8).
 *
 * A build turns a Project's `web`/`backend`/`shared` Target into a
 * Deployment_Artifact (a real createDeploymentArtifact record + a real
 * on-disk artifact file), and a deploy pushes an existing Deployment_Artifact
 * to a hosting destination and returns the resulting hosting URL. `mobile`
 * builds are NOT handled here — they go through the mobile build service
 * (src/project/mobile-build-service.js) because they have their own
 * queue-aware execution timeout.
 *
 * ================= REAL vs SEAM (READ THIS) =====================
 * REAL (exercised here, offline): the Deployment_Artifact is a REAL
 * createDeploymentArtifact record and its bytes are written to a REAL file on
 * disk (under a control path derived from the injected StorageLayout), so a
 * caller/test asserts on real on-disk state. The confirm-gated deploy is routed
 * through the REAL CommandGuard (src/sandbox/command-guard.js), which composes
 * plumby's REAL pure classifier through the plumby boundary
 * (src/engine/plumby.js) — this module reimplements NO classification.
 *
 * SEAM / PRODUCTION-ONLY (cannot run offline): a real framework build
 * (`npm run build` inside a container), a real container image push, and a real
 * deploy to a live hosting provider CANNOT run in this offline environment (no
 * docker daemon, no image pulls, no external HTTP). So the build and deploy
 * boundaries are INJECTED seams:
 *
 *     buildBoundary({ projectId, target, timeoutMs, signal })
 *        -> { exitStatus:number, artifactPath?:string, bytes?, stderr?, ... }
 *     deployBoundary({ projectId, artifact, destination, timeoutMs, signal })
 *        -> { ok?:boolean, url?:string, exitStatus?:number, stderr?, ... }
 *
 * Each default seam records intent and synthesizes its result + advances the
 * INJECTED clock (`now`), launching nothing real — exactly the fake-service
 * pattern of src/project/dev-server.js. Every SLO/timeout below (300s build,
 * 120s deploy, 60s confirm consent) is measured against the INJECTED ms clock,
 * NEVER a real wall-clock wait.
 *
 * Conventions: a factory createBuildService({...deps}) returning
 * Object.freeze({...}); dependency injection for the clock (`now`, ms) and every
 * collaborator; structured { ok:true|false, code?, message? } results for
 * expected rejections (never throw on a handled path); no-partial-state on a
 * failed deploy (the prior deployed state is snapshotted and left byte-for-byte
 * unchanged). Imports no plumby package directly (the boundary invariant).
 */

import fs from 'node:fs';
import path from 'node:path';

import { fail, requireString } from '../model/validate.js';
import { isValidTarget } from '../model/enums.js';
import { createDeploymentArtifact } from '../model/deployment.js';

/** The 300s non-`mobile` build SLO (Req 18.1/18.3), measured on the injected clock. */
export const BUILD_SLO_MS = 300_000;

/** The 120s deploy SLO (Req 18.4/18.6), measured on the injected clock. */
export const DEPLOY_SLO_MS = 120_000;

/**
 * Normalize an OPTIONAL observability/audit sink into a record(event) fn (no-op
 * when absent). Mirrors src/sandbox/database-service.js toRecordSink.
 */
function toRecordSink(sink) {
  if (sink === undefined || sink === null) return () => {};
  if (typeof sink === 'function') return (event) => sink(event);
  if (typeof sink.record === 'function') return (event) => sink.record(event);
  fail('BuildService', 'observability/audit sink must be a function or an object with a record(event) method');
  return () => {};
}

/**
 * The default (seam-only) build boundary. Records nothing real: it synthesizes a
 * success contract with a per-target artifact path and advances the injected
 * clock by a small nominal delta. A test/production caller injects its own
 * boundary to script exit status / duration.
 */
function defaultBuildBoundary({ projectId, target }) {
  return {
    exitStatus: 0,
    artifactPath: `${target}/${projectId}.artifact`,
    bytes: `artifact:${projectId}:${target}`,
    stderr: '',
  };
}

/**
 * The default (seam-only) deploy boundary. Synthesizes a hosting URL from the
 * project + target and reports success. NEVER a live endpoint here.
 */
function defaultDeployBoundary({ projectId, artifact }) {
  return {
    ok: true,
    exitStatus: 0,
    url: `https://${projectId}-${artifact.targetKind}.hosting.local`,
    stderr: '',
  };
}

/**
 * Create a Build + Deploy service for non-`mobile` Targets.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout (src/storage/layout.js) used to
 *        compute a control-plane path the real artifact bytes are written under.
 *        Required so artifacts land as REAL on-disk files a caller can assert on.
 * @param {(args:{projectId,target,timeoutMs,signal})=>(object|Promise<object>)} [args.buildBoundary]
 *        the build boundary seam. Must resolve to { exitStatus, artifactPath?, bytes?, stderr? }
 *        and advance the injected clock. Defaults to a seam-only success synth.
 * @param {(args:{projectId,artifact,destination,timeoutMs,signal})=>(object|Promise<object>)} [args.deployBoundary]
 *        the deploy boundary seam. Must resolve to { ok?, url?, exitStatus?, stderr? }
 *        and advance the injected clock. Defaults to a seam-only success synth.
 * @param {object} [args.commandGuard]  a CommandGuard (src/sandbox/command-guard.js)
 *        with run(projectId, command, {timeoutMs, onConfirmRequest, signal}). Required
 *        for a confirm-gated deploy; without it, a deploy that supplies a `command`
 *        cannot be gated and is rejected.
 * @param {() => number} [args.now]   injectable ms clock (default Date.now).
 * @param {number} [args.buildTimeoutMs=300000]  the build SLO threaded to the boundary.
 * @param {number} [args.deployTimeoutMs=120000]  the deploy SLO threaded to the boundary.
 * @param {(args:{layout,projectId,target})=>string} [args.artifactPathFor]  where the
 *        real artifact bytes are written (default: under the control-plane snapshot area).
 * @param {Function|{record:Function}} [args.observability]  OPTIONAL observability sink.
 * @param {Function|{record:Function}} [args.audit]          OPTIONAL audit sink.
 * @returns {object} build service (frozen)
 */
export function createBuildService({
  layout,
  buildBoundary = defaultBuildBoundary,
  deployBoundary = defaultDeployBoundary,
  commandGuard,
  now = Date.now,
  buildTimeoutMs = BUILD_SLO_MS,
  deployTimeoutMs = DEPLOY_SLO_MS,
  artifactPathFor,
  observability,
  audit,
} = {}) {
  if (!layout || typeof layout.exportableProjectTree !== 'function') {
    fail('BuildService', 'a StorageLayout (with exportableProjectTree) is required');
  }
  if (typeof buildBoundary !== 'function') {
    fail('BuildService', 'buildBoundary must be a function');
  }
  if (typeof deployBoundary !== 'function') {
    fail('BuildService', 'deployBoundary must be a function');
  }
  if (typeof now !== 'function') {
    fail('BuildService', 'now must be a function returning milliseconds');
  }
  if (typeof buildTimeoutMs !== 'number' || !Number.isFinite(buildTimeoutMs) || buildTimeoutMs <= 0) {
    fail('BuildService', 'buildTimeoutMs must be a positive number');
  }
  if (typeof deployTimeoutMs !== 'number' || !Number.isFinite(deployTimeoutMs) || deployTimeoutMs <= 0) {
    fail('BuildService', 'deployTimeoutMs must be a positive number');
  }

  const emitObservability = toRecordSink(observability);
  const emitAudit = toRecordSink(audit);

  /**
   * Where a Target's real artifact bytes are written. Default: an out-of-tree
   * control path under the StorageLayout's control root, so build outputs are
   * kept off the exportable tree (they are platform build products, not source).
   */
  const artifactPathResolver =
    typeof artifactPathFor === 'function'
      ? artifactPathFor
      : ({ projectId, target }) =>
          path.join(layout.controlRoot, 'build-artifacts', projectId, `${target}.artifact`);

  /**
   * The current deployed state per project+target, so a failed deploy can be
   * proven to leave the PRIOR deployed URL byte-for-byte unchanged (Req 18.6).
   * key = `${projectId}::${targetKind}` -> { url, deployedAt }.
   */
  const deployedState = new Map();
  /** The most-recently produced artifact per project+target (Req 18.8 lookup). */
  const artifacts = new Map();

  function stateKey(projectId, targetKind) {
    return `${projectId}::${targetKind}`;
  }

  /**
   * Interpret a build/deploy boundary result. exitStatus 0 == success; any other
   * numeric exit is the command's own failure. A thrown boundary is a failure.
   */
  function classifyExit(result) {
    const exitStatus =
      typeof result?.exitStatus === 'number' ? result.exitStatus : (result?.ok === true ? 0 : 1);
    const stderr = String(result?.stderr ?? '');
    const stdout = String(result?.stdout ?? '');
    return { exitStatus, ok: exitStatus === 0, message: stderr || stdout || '' };
  }

  /**
   * build — produce a Deployment_Artifact for a NON-`mobile` Target within 300s
   * (Req 18.1). On exit 0 within budget, a REAL createDeploymentArtifact record
   * is produced and its bytes are written to a REAL file on disk. On a non-zero
   * exit -> BUILD_FAILED and NO artifact (Req 18.5); on over-budget ->
   * BUILD_TIMEOUT and NO artifact (Req 18.3).
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.target   one of `web`/`backend`/`shared` (NOT `mobile`)
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} a frozen structured result
   */
  async function build(params = {}) {
    const { projectId, target, signal } = params;
    requireString('BuildService', 'projectId', projectId);
    requireString('BuildService', 'target', target);

    // Reject an invalid Target, and reject `mobile` here — mobile builds have a
    // separate queue-aware execution timeout (the mobile build service).
    if (!isValidTarget(target)) {
      return Object.freeze({
        ok: false,
        code: 'INVALID_TARGET',
        target,
        message: `Target ${JSON.stringify(target)} is not one of web/backend/mobile/shared`,
      });
    }
    if (target === 'mobile') {
      return Object.freeze({
        ok: false,
        code: 'MOBILE_NOT_SUPPORTED_HERE',
        target,
        message: 'mobile builds go through the mobile build service (createMobileBuildService)',
      });
    }

    const startedAt = now();
    let result;
    try {
      result = await buildBoundary({ projectId, target, timeoutMs: buildTimeoutMs, signal });
    } catch (err) {
      const buildMs = Math.max(0, now() - startedAt);
      emitObservability({ type: 'build', projectId, target, ok: false, code: 'BUILD_FAILED', buildMs });
      return Object.freeze({
        ok: false,
        code: 'BUILD_FAILED',
        target,
        buildMs,
        message: `build boundary threw: ${err?.message ?? String(err)}`,
      });
    }
    const buildMs = Math.max(0, now() - startedAt);
    const verdict = classifyExit(result);

    // Over-budget on the INJECTED clock -> BUILD_TIMEOUT, no artifact (Req 18.3).
    if (buildMs > buildTimeoutMs) {
      emitObservability({ type: 'build', projectId, target, ok: false, code: 'BUILD_TIMEOUT', buildMs });
      return Object.freeze({
        ok: false,
        code: 'BUILD_TIMEOUT',
        target,
        buildMs,
        message: `build exceeded the ${buildTimeoutMs}ms build SLO (took ${buildMs}ms)`,
      });
    }

    // Non-zero exit -> BUILD_FAILED, no artifact, report the error output (Req 18.5).
    if (!verdict.ok) {
      emitObservability({ type: 'build', projectId, target, ok: false, code: 'BUILD_FAILED', buildMs });
      return Object.freeze({
        ok: false,
        code: 'BUILD_FAILED',
        target,
        buildMs,
        exitStatus: verdict.exitStatus,
        message: verdict.message || `build exited ${verdict.exitStatus}`,
      });
    }

    // SUCCESS — produce a REAL Deployment_Artifact and write its bytes to disk.
    const diskPath = artifactPathResolver({ layout, projectId, target });
    const bytes =
      result?.bytes !== undefined && result?.bytes !== null
        ? String(result.bytes)
        : `artifact:${projectId}:${target}`;
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs.writeFileSync(diskPath, bytes, 'utf8');

    const artifact = createDeploymentArtifact({
      targetKind: target,
      path: diskPath,
      exitStatus: 0,
    });
    artifacts.set(stateKey(projectId, target), Object.freeze({ ...artifact }));

    emitAudit({ type: 'build.succeeded', projectId, target, buildMs });
    emitObservability({ type: 'build', projectId, target, ok: true, code: 'BUILT', buildMs });
    return Object.freeze({
      ok: true,
      artifact: Object.freeze({ ...artifact }),
      artifactPath: diskPath,
      buildMs,
      message: 'Deployment_Artifact produced',
    });
  }

  /**
   * Look up a previously produced artifact for a project+target, or null. Used
   * to reject deploying a nonexistent artifact BEFORE any deploy work (Req 18.8).
   */
  function findArtifact({ projectId, artifact }) {
    // A caller may pass the artifact record directly. It is considered to exist
    // only if we produced it (tracked in `artifacts`) AND its bytes are still on
    // disk — 'nonexistent' means no artifact record/file for the project+target.
    if (!artifact || typeof artifact !== 'object') return null;
    const key = stateKey(projectId, artifact.targetKind);
    const tracked = artifacts.get(key);
    if (!tracked) return null;
    const diskPath = artifact.path ?? tracked.path;
    if (typeof diskPath !== 'string' || !fs.existsSync(diskPath)) return null;
    return tracked;
  }

  /**
   * deploy — push an existing Deployment_Artifact to a hosting destination and
   * return the resulting hosting URL within 120s (Req 18.4). A confirm-classified
   * deploy command is routed through the CommandGuard so consent is required
   * within 60s (Req 18.7). Deploying a nonexistent artifact is rejected FIRST,
   * before any guard/deploy work (Req 18.8). On failure/timeout the cause is
   * reported and the PRIOR deployed state is left byte-for-byte unchanged (Req 18.6).
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {object} params.artifact       a Deployment_Artifact record (from build())
   * @param {string} params.destination    the hosting destination descriptor
   * @param {string|string[]} [params.command]  the deploy command to gate through the
   *        CommandGuard/plumby classifier (a `confirm`-class command needs consent).
   * @param {(req:object)=>(Promise<boolean>|boolean)} [params.onConfirmRequest]  consent seam.
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} a frozen structured result
   */
  async function deploy(params = {}) {
    const { projectId, artifact, destination, command, onConfirmRequest, signal } = params;
    requireString('BuildService', 'projectId', projectId);

    // (0) Reject a nonexistent artifact BEFORE any guard/deploy work (Req 18.8).
    const existing = findArtifact({ projectId, artifact });
    if (!existing) {
      return Object.freeze({
        ok: false,
        code: 'NO_ARTIFACT',
        message: 'no Deployment_Artifact is available to deploy for this project + target',
      });
    }
    const targetKind = existing.targetKind;
    const key = stateKey(projectId, targetKind);

    // SNAPSHOT the prior deployed state so any non-success leaves it unchanged.
    const priorState = deployedState.get(key) ?? null;

    // (1) CONFIRM GATE — if a deploy command is supplied, route it through the
    // CommandGuard so plumby's classifier decides allow/confirm/refuse. A
    // confirm-class command requires consent within 60s; refuse or a declined
    // confirm does NOT deploy and leaves the prior state unchanged.
    if (command !== undefined) {
      if (!commandGuard || typeof commandGuard.run !== 'function') {
        fail('BuildService', 'a commandGuard with run(projectId, command, opts) is required to gate a deploy command');
      }
      let guardResult;
      try {
        guardResult = await commandGuard.run(projectId, command, {
          timeoutMs: deployTimeoutMs,
          onConfirmRequest,
          signal,
        });
      } catch (err) {
        return failDeploy({
          projectId,
          targetKind,
          priorState,
          code: 'DEPLOY_FAILED',
          message: `deploy guard threw: ${err?.message ?? String(err)}`,
        });
      }
      const outcome = guardResult?.outcome ?? 'refuse';
      const executed = guardResult?.executed === true;
      // A boundary-level refusal (launch-failure / timeout) surfaces on the
      // guard result as `denied === true` on a command that DID reach exec
      // (`executed === true`) — DISTINCT from a non-zero in-box exit, and DISTINCT
      // from a declined/timed-out confirm (which is `executed:false, denied:true`
      // and is handled by the confirm branch below). Even an allow-class command
      // that reached the boundary can be denied there, so such a denial must NOT
      // be treated as a permitted gate.
      const boundaryDenied = guardResult?.denied === true && executed;
      // The guard EXECUTES an allow-class command (or a granted confirm) via the
      // boundary's exec. But our deploy work is done by the deployBoundary seam,
      // not by exec here; the guard's role is purely the classify/consent gate.
      // So we require the gate to have PERMITTED the command:
      //   - allow: permitted (executed true AND not boundary-denied).
      //   - confirm + confirmed: permitted (consent granted within 60s AND not
      //     boundary-denied).
      //   - confirm + denied/timeout: NOT permitted -> do not deploy.
      //   - refuse / failed-closed: NOT permitted -> do not deploy.
      //   - boundary-denied (launch-failure/timeout): NOT permitted -> do not deploy.
      const permitted =
        !boundaryDenied &&
        ((outcome === 'allow' && executed) ||
          (outcome === 'confirm' && guardResult?.confirmed === true));
      if (!permitted) {
        let code;
        let message;
        if (boundaryDenied) {
          // The gate command was denied at the Isolation_Boundary (launch-failure
          // / timeout), not by the classifier. Do not proceed to deploy.
          code = 'DEPLOY_DENIED';
          message =
            guardResult?.deniedReason ??
            guardResult?.reason ??
            'deploy command was denied at the isolation boundary';
        } else if (outcome === 'confirm') {
          code = 'DEPLOY_CONFIRM_DENIED';
          message = guardResult?.reason ?? 'deploy confirmation was not granted within the consent ceiling';
        } else {
          code = 'DEPLOY_REFUSED';
          message = guardResult?.reason ?? 'deploy command was refused by the permission classifier';
        }
        return failDeploy({
          projectId,
          targetKind,
          priorState,
          code,
          outcome,
          message,
        });
      }
    }

    // (2) DEPLOY — run the deploy boundary seam and measure deployMs on the
    // injected clock. On success within 120s, record the new deployed URL.
    const startedAt = now();
    let result;
    try {
      result = await deployBoundary({
        projectId,
        artifact: existing,
        destination,
        timeoutMs: deployTimeoutMs,
        signal,
      });
    } catch (err) {
      const deployMs = Math.max(0, now() - startedAt);
      return failDeploy({
        projectId,
        targetKind,
        priorState,
        code: 'DEPLOY_FAILED',
        deployMs,
        message: `deploy boundary threw: ${err?.message ?? String(err)}`,
      });
    }
    const deployMs = Math.max(0, now() - startedAt);
    const verdict = classifyExit(result);

    // Over-budget -> DEPLOY_TIMEOUT, prior state unchanged (Req 18.6).
    if (deployMs > deployTimeoutMs) {
      return failDeploy({
        projectId,
        targetKind,
        priorState,
        code: 'DEPLOY_TIMEOUT',
        deployMs,
        message: `deploy exceeded the ${deployTimeoutMs}ms deploy SLO (took ${deployMs}ms)`,
      });
    }

    // Failure (non-zero exit / no url) -> DEPLOY_FAILED, prior state unchanged.
    const url = typeof result?.url === 'string' ? result.url : null;
    if (!verdict.ok || !url) {
      return failDeploy({
        projectId,
        targetKind,
        priorState,
        code: 'DEPLOY_FAILED',
        deployMs,
        message: verdict.message || (url ? `deploy exited ${verdict.exitStatus}` : 'deploy produced no hosting URL'),
      });
    }

    // SUCCESS — record the new deployed URL as the project+target's current state.
    const deployedAt = new Date(now()).toISOString();
    const record = Object.freeze({ url, deployedAt });
    deployedState.set(key, record);

    emitAudit({ type: 'deploy.succeeded', projectId, target: targetKind, url, deployMs });
    emitObservability({ type: 'deploy', projectId, target: targetKind, ok: true, code: 'DEPLOYED', deployMs });
    return Object.freeze({
      ok: true,
      url,
      deployMs,
      target: targetKind,
      message: 'Deployment_Artifact deployed',
    });
  }

  /**
   * Report a deploy FAILURE/TIMEOUT/DENIAL: leave the PRIOR deployed state
   * byte-for-byte unchanged (do not touch deployedState) and return the cause.
   */
  function failDeploy({ projectId, targetKind, priorState, code, deployMs, outcome, message }) {
    emitObservability({ type: 'deploy', projectId, target: targetKind, ok: false, code, deployMs: deployMs ?? 0 });
    return Object.freeze({
      ok: false,
      code,
      target: targetKind,
      outcome: outcome ?? null,
      deployMs: deployMs ?? 0,
      // Echo the prior deployed URL so a caller/test can assert it is unchanged.
      priorUrl: priorState?.url ?? null,
      message,
    });
  }

  /** Introspection: the currently deployed URL for a project+target, or null. */
  function deployedUrl(projectId, target) {
    requireString('BuildService', 'projectId', projectId);
    const record = deployedState.get(stateKey(projectId, target));
    return record ? record.url : null;
  }

  /** Introspection: the currently produced artifact for a project+target, or null. */
  function artifactFor(projectId, target) {
    requireString('BuildService', 'projectId', projectId);
    return artifacts.get(stateKey(projectId, target)) ?? null;
  }

  return Object.freeze({
    build,
    deploy,
    deployedUrl,
    artifactFor,
    buildTimeoutMs,
    deployTimeoutMs,
  });
}
