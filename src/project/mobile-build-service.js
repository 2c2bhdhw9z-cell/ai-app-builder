/**
 * mobile-build-service.js — the Mobile (Expo/React Native) scaffold + build SEAM
 * (spec Task 26.2, Req 15.1, 15.4, 15.5, 15.6, 15.7, 18.2, 18.3).
 *
 * A mobile Target is scaffolded from an Expo/RN starter within 30s (Req 15.1),
 * then built into a `mobile` Deployment_Artifact on a shared build service. The
 * mobile build is the ONE build with a queue-aware timeout:
 *
 *   - The configurable mobile-build-EXECUTION timeout (default 1800s) is
 *     measured from when the build ACTUALLY STARTS EXECUTING and EXCLUDES any
 *     time the build spent QUEUED on the shared build service (Req 15.4/15.5).
 *   - Queue time and execution time are therefore modeled as TWO SEPARATE
 *     phases on the injected clock: the queue advances the clock (and is
 *     reported as a `queued` status) but is NOT counted against the execution
 *     timeout; only the execution delta is compared to executionTimeoutMs.
 *
 * ================= REAL vs SEAM (READ THIS) =====================
 * REAL (exercised here, offline): the mobile Deployment_Artifact is a REAL
 * createDeploymentArtifact record whose bytes are written to a REAL file on
 * disk (under a control path derived from the injected StorageLayout).
 *
 * SEAM / PRODUCTION-ONLY (cannot run offline): a real Expo scaffold, a real EAS
 * / shared mobile build farm, and a real mobile toolchain (Xcode/Android SDK)
 * CANNOT run in this offline environment. So the scaffold and mobile-build
 * boundaries are INJECTED seams, exactly like src/project/dev-server.js:
 *
 *     scaffoldBoundary({ projectId, timeoutMs, signal })
 *        -> { exitStatus:number, files?, stderr?, ... }  (advances the clock)
 *     mobileBuildBoundary({ projectId, executionTimeoutMs, signal })
 *        -> { missingToolchain?:string,        // a named missing component (Req 15.6)
 *             queuedMs?:number,                 // time spent QUEUED (NOT counted)
 *             executionMs?:number,              // execution delta (COUNTED)
 *             exitStatus:number, artifactPath?, bytes?, stderr?, ... }
 *
 * The default seams launch nothing real; they synthesize a contract and advance
 * the INJECTED clock (`now`). Every SLO/timeout (30s scaffold, 1800s execution)
 * is measured against the injected clock, NEVER a real wall-clock wait.
 *
 * Conventions: a factory createMobileBuildService({...deps}) returning
 * Object.freeze({...}); DI for the clock (`now`, ms) and every collaborator;
 * structured { ok:true|false, code?, message? } results (never throw on a
 * handled path); no-partial-state — a missing toolchain / failed / timed-out
 * build leaves existing files and any prior artifact unchanged and produces no
 * new artifact. Imports no plumby package directly (the boundary invariant).
 */

import fs from 'node:fs';
import path from 'node:path';

import { fail, requireString } from '../model/validate.js';
import { createDeploymentArtifact } from '../model/deployment.js';

/** The 30s Expo/RN mobile scaffold SLO (Req 15.1), measured on the injected clock. */
export const SCAFFOLD_SLO_MS = 30_000;

/**
 * The default configurable mobile-build-EXECUTION timeout (Req 15.4/18.2):
 * 1800s, measured from build-execution START and EXCLUDING queue time. Override
 * per factory via executionTimeoutMs.
 */
export const DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS = 1_800_000;

/**
 * Normalize an OPTIONAL observability/audit sink into a record(event) fn (no-op
 * when absent). Mirrors src/sandbox/database-service.js toRecordSink.
 */
function toRecordSink(sink) {
  if (sink === undefined || sink === null) return () => {};
  if (typeof sink === 'function') return (event) => sink(event);
  if (typeof sink.record === 'function') return (event) => sink.record(event);
  fail('MobileBuildService', 'observability/audit sink must be a function or an object with a record(event) method');
  return () => {};
}

/** The default (seam-only) scaffold boundary: a synthesized Expo/RN success. */
function defaultScaffoldBoundary({ projectId }) {
  return { exitStatus: 0, files: [`mobile/${projectId}/App.js`, `mobile/${projectId}/app.json`], stderr: '' };
}

/** The default (seam-only) mobile build boundary: a synthesized instant success. */
function defaultMobileBuildBoundary({ projectId }) {
  return {
    queuedMs: 0,
    executionMs: 0,
    exitStatus: 0,
    artifactPath: `mobile/${projectId}.ipa`,
    bytes: `mobile-artifact:${projectId}`,
    stderr: '',
  };
}

/**
 * Create a Mobile Build service.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout (src/storage/layout.js) used to
 *        compute a control path the real mobile artifact bytes are written under.
 * @param {(args:{projectId,timeoutMs,signal})=>(object|Promise<object>)} [args.scaffoldBoundary]
 *        the Expo/RN scaffold seam; resolves to { exitStatus, files?, stderr? } and
 *        advances the injected clock. Defaults to a seam-only success synth.
 * @param {(args:{projectId,executionTimeoutMs,signal})=>(object|Promise<object>)} [args.mobileBuildBoundary]
 *        the shared mobile-build-farm seam; resolves to
 *        { missingToolchain?, queuedMs?, executionMs?, exitStatus, artifactPath?, bytes?, stderr? }
 *        and advances the injected clock. Defaults to a seam-only instant success.
 * @param {() => number} [args.now]   injectable ms clock (default Date.now).
 * @param {number} [args.scaffoldTimeoutMs=30000]  the 30s scaffold SLO.
 * @param {number} [args.executionTimeoutMs=1800000]  the configurable execution timeout (Req 15.4).
 * @param {(args:{layout,projectId})=>string} [args.artifactPathFor]  where the real artifact is written.
 * @param {Function|{record:Function}} [args.observability]  OPTIONAL observability sink.
 * @param {Function|{record:Function}} [args.audit]          OPTIONAL audit sink.
 * @returns {object} mobile build service (frozen)
 */
export function createMobileBuildService({
  layout,
  scaffoldBoundary = defaultScaffoldBoundary,
  mobileBuildBoundary = defaultMobileBuildBoundary,
  now = Date.now,
  scaffoldTimeoutMs = SCAFFOLD_SLO_MS,
  executionTimeoutMs = DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS,
  artifactPathFor,
  observability,
  audit,
} = {}) {
  if (!layout || typeof layout.exportableProjectTree !== 'function') {
    fail('MobileBuildService', 'a StorageLayout (with exportableProjectTree) is required');
  }
  if (typeof scaffoldBoundary !== 'function') {
    fail('MobileBuildService', 'scaffoldBoundary must be a function');
  }
  if (typeof mobileBuildBoundary !== 'function') {
    fail('MobileBuildService', 'mobileBuildBoundary must be a function');
  }
  if (typeof now !== 'function') {
    fail('MobileBuildService', 'now must be a function returning milliseconds');
  }
  if (typeof scaffoldTimeoutMs !== 'number' || !Number.isFinite(scaffoldTimeoutMs) || scaffoldTimeoutMs <= 0) {
    fail('MobileBuildService', 'scaffoldTimeoutMs must be a positive number');
  }
  if (typeof executionTimeoutMs !== 'number' || !Number.isFinite(executionTimeoutMs) || executionTimeoutMs <= 0) {
    fail('MobileBuildService', 'executionTimeoutMs must be a positive number');
  }

  const emitObservability = toRecordSink(observability);
  const emitAudit = toRecordSink(audit);

  const artifactPathResolver =
    typeof artifactPathFor === 'function'
      ? artifactPathFor
      : ({ projectId }) => path.join(layout.controlRoot, 'build-artifacts', projectId, 'mobile.artifact');

  /** The most-recently produced mobile artifact per project (prior-state proof). */
  const artifacts = new Map();

  function classifyExit(result) {
    const exitStatus = typeof result?.exitStatus === 'number' ? result.exitStatus : 1;
    const stderr = String(result?.stderr ?? '');
    const stdout = String(result?.stdout ?? '');
    return { exitStatus, ok: exitStatus === 0, message: stderr || stdout || '' };
  }

  /**
   * scaffoldMobile — scaffold the Expo/RN `mobile` Target within 30s (Req 15.1).
   * Success requires exit 0 AND scaffoldMs <= 30s; a non-zero exit or an
   * over-budget scaffold is a failure and claims NO success.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} a frozen structured result
   */
  async function scaffoldMobile(params = {}) {
    const { projectId, signal } = params;
    requireString('MobileBuildService', 'projectId', projectId);

    const startedAt = now();
    let result;
    try {
      result = await scaffoldBoundary({ projectId, timeoutMs: scaffoldTimeoutMs, signal });
    } catch (err) {
      const scaffoldMs = Math.max(0, now() - startedAt);
      return Object.freeze({
        ok: false,
        code: 'SCAFFOLD_FAILED',
        scaffoldMs,
        message: `mobile scaffold boundary threw: ${err?.message ?? String(err)}`,
      });
    }
    const scaffoldMs = Math.max(0, now() - startedAt);
    const verdict = classifyExit(result);

    if (scaffoldMs > scaffoldTimeoutMs) {
      emitObservability({ type: 'mobile.scaffold', projectId, ok: false, code: 'SCAFFOLD_TIMEOUT', scaffoldMs });
      return Object.freeze({
        ok: false,
        code: 'SCAFFOLD_TIMEOUT',
        scaffoldMs,
        message: `mobile scaffold exceeded the ${scaffoldTimeoutMs}ms scaffold SLO (took ${scaffoldMs}ms)`,
      });
    }
    if (!verdict.ok) {
      emitObservability({ type: 'mobile.scaffold', projectId, ok: false, code: 'SCAFFOLD_FAILED', scaffoldMs });
      return Object.freeze({
        ok: false,
        code: 'SCAFFOLD_FAILED',
        scaffoldMs,
        exitStatus: verdict.exitStatus,
        message: verdict.message || `mobile scaffold exited ${verdict.exitStatus}`,
      });
    }

    emitAudit({ type: 'mobile.scaffold.succeeded', projectId, scaffoldMs });
    emitObservability({ type: 'mobile.scaffold', projectId, ok: true, code: 'SCAFFOLDED', scaffoldMs });
    return Object.freeze({
      ok: true,
      scaffoldMs,
      files: Array.isArray(result?.files) ? result.files.slice() : [],
      message: 'Expo/RN mobile Target scaffolded',
    });
  }

  /**
   * buildMobile — produce the `mobile` Deployment_Artifact bounded by the
   * configurable EXECUTION timeout, EXCLUDING queue time (Req 15.4/15.5/15.6/15.7).
   *
   * Order: (a) TOOLCHAIN check — a missing component is named, no success, no
   * artifact, prior state unchanged (Req 15.6). (b) QUEUE phase — reported
   * separately and NOT counted against the execution timeout (Req 15.5).
   * (c) EXECUTION phase — measured from execution start only; over the timeout
   * or a non-zero exit -> failure, no artifact (Req 15.7); otherwise a REAL
   * mobile artifact is produced and written to disk.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {(status:object)=>void} [params.onStatus]  optional callback that
   *        receives { status:'queued', queuedMs } while queued (Req 15.5).
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} a frozen structured result
   */
  async function buildMobile(params = {}) {
    const { projectId, onStatus, signal } = params;
    requireString('MobileBuildService', 'projectId', projectId);

    const priorArtifact = artifacts.get(projectId) ?? null;

    let result;
    try {
      result = await mobileBuildBoundary({ projectId, executionTimeoutMs, signal });
    } catch (err) {
      return Object.freeze({
        ok: false,
        code: 'BUILD_FAILED',
        executionMs: 0,
        queuedMs: 0,
        priorArtifactPath: priorArtifact?.path ?? null,
        message: `mobile build boundary threw: ${err?.message ?? String(err)}`,
      });
    }

    // (a) TOOLCHAIN CHECK — a named missing component fails FIRST, no success,
    // no artifact, existing files + any prior artifact unchanged (Req 15.6).
    const missing = result?.missingToolchain;
    if (typeof missing === 'string' && missing.trim() !== '') {
      emitObservability({ type: 'mobile.build', projectId, ok: false, code: 'MISSING_TOOLCHAIN', component: missing });
      return Object.freeze({
        ok: false,
        code: 'MISSING_TOOLCHAIN',
        component: missing,
        // Prior artifact left untouched — echoed so a test can assert unchanged.
        priorArtifactPath: priorArtifact?.path ?? null,
        message: `required mobile toolchain component unavailable: ${missing}`,
      });
    }

    // (b) QUEUE PHASE — reported separately, NOT counted against the execution
    // timeout. The boundary advanced the clock by queuedMs; we surface it and
    // notify via onStatus, but only executionMs is compared to the timeout.
    const queuedMs = typeof result?.queuedMs === 'number' && result.queuedMs > 0 ? result.queuedMs : 0;
    if (queuedMs > 0 && typeof onStatus === 'function') {
      onStatus(Object.freeze({ status: 'queued', queuedMs }));
    }
    if (queuedMs > 0) {
      emitObservability({ type: 'mobile.build', projectId, ok: true, status: 'queued', queuedMs });
    }

    // (c) EXECUTION PHASE — the execution delta ONLY (queue time excluded).
    const executionMs = typeof result?.executionMs === 'number' ? Math.max(0, result.executionMs) : 0;
    const verdict = classifyExit(result);

    // Over the configured execution timeout -> BUILD_TIMEOUT, no artifact (Req 15.7).
    if (executionMs > executionTimeoutMs) {
      emitObservability({ type: 'mobile.build', projectId, ok: false, code: 'BUILD_TIMEOUT', executionMs, queuedMs });
      return Object.freeze({
        ok: false,
        code: 'BUILD_TIMEOUT',
        executionMs,
        queuedMs,
        priorArtifactPath: priorArtifact?.path ?? null,
        message: `mobile build execution exceeded the ${executionTimeoutMs}ms execution timeout (took ${executionMs}ms, excluding ${queuedMs}ms queued)`,
      });
    }

    // Non-zero exit -> BUILD_FAILED, no artifact (Req 15.7).
    if (!verdict.ok) {
      emitObservability({ type: 'mobile.build', projectId, ok: false, code: 'BUILD_FAILED', executionMs, queuedMs });
      return Object.freeze({
        ok: false,
        code: 'BUILD_FAILED',
        executionMs,
        queuedMs,
        exitStatus: verdict.exitStatus,
        priorArtifactPath: priorArtifact?.path ?? null,
        message: verdict.message || `mobile build exited ${verdict.exitStatus}`,
      });
    }

    // SUCCESS — produce a REAL mobile Deployment_Artifact and write it to disk.
    const diskPath = artifactPathResolver({ layout, projectId });
    const bytes =
      result?.bytes !== undefined && result?.bytes !== null
        ? String(result.bytes)
        : `mobile-artifact:${projectId}`;
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs.writeFileSync(diskPath, bytes, 'utf8');

    const artifact = createDeploymentArtifact({
      targetKind: 'mobile',
      path: diskPath,
      exitStatus: 0,
    });
    artifacts.set(projectId, Object.freeze({ ...artifact }));

    emitAudit({ type: 'mobile.build.succeeded', projectId, executionMs, queuedMs });
    emitObservability({ type: 'mobile.build', projectId, ok: true, code: 'BUILT', executionMs, queuedMs });
    return Object.freeze({
      ok: true,
      artifact: Object.freeze({ ...artifact }),
      artifactPath: diskPath,
      executionMs,
      queuedMs,
      message: 'mobile Deployment_Artifact produced',
    });
  }

  /** Introspection: the currently produced mobile artifact for a project, or null. */
  function artifactFor(projectId) {
    requireString('MobileBuildService', 'projectId', projectId);
    return artifacts.get(projectId) ?? null;
  }

  return Object.freeze({
    scaffoldMobile,
    buildMobile,
    artifactFor,
    scaffoldTimeoutMs,
    executionTimeoutMs,
  });
}
