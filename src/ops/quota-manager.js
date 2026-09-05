/**
 * quota-manager.js — the QuotaManager / RateLimiter pre-allocation gate and
 * abuse-detection surface (spec Task 12.1 / 12.2*, Req 23).
 *
 * The QuotaManager is the single gate that decides, BEFORE the Builder Server
 * allocates ANY resource for a request, whether the request is allowed to
 * proceed. It sits strictly AFTER authn + authz and strictly BEFORE any Project
 * Session is created, any Builder_Agent is built, or any Sandbox is acquired —
 * so an over-limit request allocates nothing. It exposes three seams:
 *
 *   checkRate(userAccount, operation)        — per-User_Account Rate_Limits on
 *                                              the four resource-CREATING
 *                                              operations (project creation,
 *                                              builds, deployments, generation
 *                                              turns). Fixed-window counters
 *                                              keyed by (accountId, operation).
 *
 *   checkQuota(userAccount, projectId, res)  — per-account / per-project
 *                                              Resource_Quotas: max concurrent
 *                                              Sandboxes (live boundary count
 *                                              from the SandboxManager) and max
 *                                              total Projects (an injected
 *                                              per-account project counter).
 *
 *   observeUsage(sandboxId, signal)          — abuse detection: on a sustained
 *                                              failed-build / runaway-resource
 *                                              signal, THROTTLE or SUSPEND the
 *                                              offending Sandbox and report the
 *                                              action taken.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO — REUSED SEAMS:
 *
 *   - Per-Sandbox CPU / memory / exec-time limits are NOT defined here. They are
 *     already enforced by the SandboxManager / container backend (Req 8.2) via
 *     the requested cgroup limits and the in-process wall-clock exec timeout.
 *     The QuotaManager REUSES that enforcement and layers only cross-Sandbox and
 *     per-account/per-project accounting on top; it never redefines a
 *     per-Sandbox resource ceiling.
 *
 *   - observeUsage's sustained-failed-build signal is the Self-Healing
 *     failure-signature signal from Task 17, which is NOT YET BUILT. This module
 *     consumes it through a CLEAN injectable signal seam: callers pass a plain
 *     `signal` object ({ failedBuilds, runawayResource, ... }); when Task 17
 *     lands it feeds this exact seam. The dependency is documented here so the
 *     seam is not mistaken for a finished producer.
 *
 * Every rejection NAMES the exceeded limit and emits a security audit event
 * through the injected audit sink (RATE_LIMIT_EXCEEDED / QUOTA_EXCEEDED /
 * ABUSE_MITIGATED) plus, for abuse mitigation, an OPERATIONAL_ERROR operational
 * event. Time-window bookkeeping uses an injectable `now()` clock so tests are
 * deterministic with no real sleeps (Req: hermetic, offline).
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection
 * for the clock, the audit sink, the SandboxManager, the project counter, and
 * an optional suspend action; structured result objects { ok:true|false, ... }.
 */

import { AUDIT_EVENTS, toAuditSink } from '../auth/audit.js';

/** The four resource-CREATING operations that are rate-limited. */
export const RATE_LIMITED_OPERATIONS = Object.freeze([
  'project.create',
  'build',
  'deploy',
  'generation.turn',
]);

/** Resource kinds understood by checkQuota. */
export const QUOTA_RESOURCES = Object.freeze({
  CONCURRENT_SANDBOXES: 'concurrentSandboxes',
  TOTAL_PROJECTS: 'totalProjects',
});

/** Sensible defaults so the manager is usable with no config. */
export const DEFAULT_QUOTA_CONFIG = Object.freeze({
  rate: Object.freeze({
    'project.create': Object.freeze({ max: 20, windowMs: 60_000 }),
    build: Object.freeze({ max: 60, windowMs: 60_000 }),
    deploy: Object.freeze({ max: 20, windowMs: 60_000 }),
    'generation.turn': Object.freeze({ max: 120, windowMs: 60_000 }),
  }),
  quota: Object.freeze({
    maxConcurrentSandboxes: 10,
    maxTotalProjects: 50,
  }),
  abuse: Object.freeze({
    // Sustained failed builds at/above this count trip mitigation.
    maxFailedBuilds: 5,
    // A runaway-resource signal (true) trips mitigation immediately.
    // The action taken when a threshold is breached: 'suspend' releases the
    // offending Sandbox via the SandboxManager; 'throttle' is a softer action a
    // caller-supplied suspend action may implement.
    action: 'suspend',
  }),
});

/** Read an accountId from a user-account-shaped argument. */
function accountIdOf(userAccount) {
  if (typeof userAccount === 'string') return userAccount;
  if (userAccount && typeof userAccount === 'object') {
    if (typeof userAccount.id === 'string') return userAccount.id;
    if (typeof userAccount.accountId === 'string') return userAccount.accountId;
  }
  return null;
}

/**
 * Create a QuotaManager.
 *
 * @param {object} [args]
 * @param {object} [args.config]           per-operation Rate_Limits + Resource_Quotas
 *        + abuse thresholds. Missing keys fall back to DEFAULT_QUOTA_CONFIG.
 * @param {object} [args.sandboxManager]   a SandboxManager; activeProjectIds()
 *        gives the live concurrent-Sandbox count and release(projectId) is the
 *        default suspend action for abuse mitigation.
 * @param {(accountId:string)=>number} [args.projectCounter]  returns the current
 *        total Project count for an account (per-account totalProjects quota).
 * @param {number} [args.concurrencyCount]  alternative fixed concurrent-sandbox
 *        count (takes precedence over sandboxManager.activeProjectIds when a
 *        function; used mainly by tests/callers without a live manager).
 * @param {(args:{sandboxId:string,projectId:string,action:string})=>any} [args.suspendAction]
 *        optional explicit mitigation action; when absent, mitigation calls
 *        sandboxManager.release(projectId).
 * @param {object|Function} [args.auditSink]  audit sink (function or { record }).
 * @param {object|Function} [args.operationalSink]  optional separate operational
 *        event sink; defaults to the audit sink.
 * @param {()=>number} [args.now]          injectable clock (ms). Default Date.now.
 * @returns {object} frozen QuotaManager
 */
export function createQuotaManager(args = {}) {
  const {
    config = {},
    sandboxManager,
    projectCounter,
    concurrencyCount,
    suspendAction,
    auditSink,
    operationalSink,
    now = () => Date.now(),
  } = args;

  const rateConfig = { ...DEFAULT_QUOTA_CONFIG.rate, ...(config.rate ?? {}) };
  const quotaConfig = { ...DEFAULT_QUOTA_CONFIG.quota, ...(config.quota ?? {}) };
  const abuseConfig = { ...DEFAULT_QUOTA_CONFIG.abuse, ...(config.abuse ?? {}) };

  const emitAudit = toAuditSink(auditSink);
  const emitOperational = operationalSink === undefined ? emitAudit : toAuditSink(operationalSink);

  /**
   * Fixed-window counters keyed by `${accountId}::${operation}`. Each entry is
   * { windowStart, count }. A window rolls over once `now() - windowStart`
   * reaches the operation's windowMs; the injectable clock makes this
   * deterministic in tests (no real sleeps).
   */
  const windows = new Map();

  function rateKey(accountId, operation) {
    return `${accountId}::${operation}`;
  }

  /**
   * checkRate(userAccount, operation) — enforce the per-User_Account Rate_Limit
   * for a resource-creating operation. Returns { ok:true } while within the
   * window budget; on the (N+1)th call in the window returns a structured
   * rejection NAMING the exceeded Rate_Limit and emits RATE_LIMIT_EXCEEDED.
   *
   * Only the four resource-creating operations (RATE_LIMITED_OPERATIONS) are
   * rate-limited; any other operation passes through as { ok:true } (there is no
   * Rate_Limit to enforce on it).
   *
   * @param {object|string} userAccount  the authenticated account ({ id } or id)
   * @param {string} operation
   * @returns {{ ok:true } | { ok:false, limit:'Rate_Limit', operation:string, max:number, windowMs:number, message:string }}
   */
  function checkRate(userAccount, operation) {
    const accountId = accountIdOf(userAccount);
    if (!accountId) {
      // No identity: nothing to key a per-account limit on. The Builder Server
      // only ever calls this AFTER authn, so this is a defensive pass-through.
      return { ok: true };
    }
    const limit = rateConfig[operation];
    if (!limit || typeof limit.max !== 'number' || typeof limit.windowMs !== 'number') {
      // Not a rate-limited operation (or no configured limit): allow.
      return { ok: true };
    }

    const key = rateKey(accountId, operation);
    const nowMs = now();
    let entry = windows.get(key);
    if (!entry || nowMs - entry.windowStart >= limit.windowMs) {
      // Start (or roll over to) a fresh window.
      entry = { windowStart: nowMs, count: 0 };
      windows.set(key, entry);
    }

    if (entry.count >= limit.max) {
      const message =
        `Rate_Limit exceeded for operation '${operation}': ` +
        `at most ${limit.max} per ${limit.windowMs}ms per account`;
      emitAudit({
        type: AUDIT_EVENTS.RATE_LIMIT_EXCEEDED,
        at: nowMs,
        accountId,
        operation,
        limit: 'Rate_Limit',
        max: limit.max,
        windowMs: limit.windowMs,
      });
      return { ok: false, limit: 'Rate_Limit', operation, max: limit.max, windowMs: limit.windowMs, message };
    }

    entry.count += 1;
    return { ok: true };
  }

  /** Resolve the current live concurrent-Sandbox count. */
  function currentConcurrentSandboxes() {
    if (typeof concurrencyCount === 'function') {
      const n = concurrencyCount();
      return typeof n === 'number' ? n : 0;
    }
    if (typeof concurrencyCount === 'number') return concurrencyCount;
    if (sandboxManager && typeof sandboxManager.activeProjectIds === 'function') {
      const ids = sandboxManager.activeProjectIds();
      return Array.isArray(ids) ? ids.length : 0;
    }
    return 0;
  }

  /**
   * checkQuota(userAccount, projectId, resource) — enforce a Resource_Quota.
   *
   *   'concurrentSandboxes' — compare the current live boundary count (from
   *       sandboxManager.activeProjectIds().length, or an injected concurrency
   *       counter) against config.quota.maxConcurrentSandboxes. This is a
   *       CROSS-Sandbox ceiling; it does NOT touch per-Sandbox CPU/memory/exec
   *       limits, which the SandboxManager already enforces (Req 8.2).
   *
   *   'totalProjects'       — compare projectCounter(accountId) against
   *       config.quota.maxTotalProjects.
   *
   * On exceed, returns a structured rejection NAMING the exceeded quota and
   * emits QUOTA_EXCEEDED; otherwise { ok:true }.
   *
   * @param {object|string} userAccount
   * @param {string|null} projectId
   * @param {string} resource  one of QUOTA_RESOURCES
   * @returns {{ ok:true } | { ok:false, limit:'Resource_Quota', resource:string, max:number, current:number, message:string }}
   */
  function checkQuota(userAccount, projectId, resource) {
    const accountId = accountIdOf(userAccount);
    const nowMs = now();

    if (resource === QUOTA_RESOURCES.CONCURRENT_SANDBOXES) {
      const max = quotaConfig.maxConcurrentSandboxes;
      const current = currentConcurrentSandboxes();
      if (typeof max === 'number' && current >= max) {
        const message =
          `Resource_Quota exceeded: max concurrent Sandboxes (${max}) reached ` +
          `(current ${current})`;
        emitAudit({
          type: AUDIT_EVENTS.QUOTA_EXCEEDED,
          at: nowMs,
          accountId,
          projectId: projectId ?? null,
          limit: 'Resource_Quota',
          resource,
          max,
          current,
        });
        return { ok: false, limit: 'Resource_Quota', resource, max, current, message };
      }
      return { ok: true };
    }

    if (resource === QUOTA_RESOURCES.TOTAL_PROJECTS) {
      const max = quotaConfig.maxTotalProjects;
      const current = typeof projectCounter === 'function' ? projectCounter(accountId) : 0;
      if (typeof max === 'number' && typeof current === 'number' && current >= max) {
        const message =
          `Resource_Quota exceeded: max total Projects (${max}) reached ` +
          `(current ${current})`;
        emitAudit({
          type: AUDIT_EVENTS.QUOTA_EXCEEDED,
          at: nowMs,
          accountId,
          projectId: projectId ?? null,
          limit: 'Resource_Quota',
          resource,
          max,
          current,
        });
        return { ok: false, limit: 'Resource_Quota', resource, max, current, message };
      }
      return { ok: true };
    }

    // Unknown resource kind: nothing to enforce here. Per-Sandbox CPU/memory/
    // exec-time ceilings intentionally are NOT handled by this manager — see the
    // module header; they live in the SandboxManager / container backend.
    return { ok: true };
  }

  /**
   * observeUsage(sandboxId, signal) — abuse detection on the injectable signal
   * seam. The signal is the Self-Healing failure-signature signal from Task 17
   * (NOT yet built — see the module header); consume it here and DOCUMENT the
   * dependency rather than fabricating a producer.
   *
   * On a sustained failed-build breach (signal.failedBuilds >= threshold) or a
   * runaway-resource breach (signal.runawayResource === true), take a mitigation
   * action against the SandboxManager — SUSPEND (default: sandboxManager.release
   * of the offending Sandbox's project) or a caller-supplied throttle/suspend
   * action — and RETURN + REPORT the action taken, emitting ABUSE_MITIGATED plus
   * an OPERATIONAL_ERROR operational event. Below threshold, do nothing.
   *
   * @param {string} sandboxId  the offending Sandbox / project id
   * @param {{ failedBuilds?:number, runawayResource?:boolean, projectId?:string, reason?:string }} [signal]
   * @returns {{ mitigated:false } | { mitigated:true, action:string, sandboxId:string, projectId:string, reason:string }}
   */
  function observeUsage(sandboxId, signal = {}) {
    const failedBuilds = typeof signal.failedBuilds === 'number' ? signal.failedBuilds : 0;
    const runaway = signal.runawayResource === true;
    const maxFailedBuilds = abuseConfig.maxFailedBuilds;

    const sustainedFailure = typeof maxFailedBuilds === 'number' && failedBuilds >= maxFailedBuilds;
    if (!sustainedFailure && !runaway) {
      return { mitigated: false };
    }

    // The offending Sandbox is keyed by projectId in the SandboxManager; a
    // caller may pass an explicit projectId on the signal, else sandboxId is it.
    const projectId = typeof signal.projectId === 'string' ? signal.projectId : sandboxId;
    const action = abuseConfig.action === 'throttle' ? 'throttle' : 'suspend';
    const reason = runaway
      ? (signal.reason ?? 'runaway-resource')
      : (signal.reason ?? 'sustained-failed-build');

    const nowMs = now();

    // Take the mitigation action against the SandboxManager interface. An
    // injected suspendAction wins; otherwise SUSPEND == release the boundary.
    let actionError = null;
    try {
      if (typeof suspendAction === 'function') {
        suspendAction({ sandboxId, projectId, action });
      } else if (sandboxManager && typeof sandboxManager.release === 'function') {
        // release() is idempotent + safe; it tears down and reaps the boundary.
        void sandboxManager.release(projectId);
      }
    } catch (err) {
      actionError = String(err?.message ?? err);
    }

    emitAudit({
      type: AUDIT_EVENTS.ABUSE_MITIGATED,
      at: nowMs,
      sandboxId,
      projectId,
      action,
      reason,
      failedBuilds,
      runawayResource: runaway,
    });
    emitOperational({
      type: AUDIT_EVENTS.OPERATIONAL_ERROR,
      at: nowMs,
      kind: 'abuse-mitigation',
      sandboxId,
      projectId,
      action,
      reason,
      ...(actionError ? { actionError } : {}),
    });

    return { mitigated: true, action, sandboxId, projectId, reason };
  }

  return Object.freeze({
    checkRate,
    checkQuota,
    observeUsage,
    // Exposed for tests / callers.
    RATE_LIMITED_OPERATIONS,
    QUOTA_RESOURCES,
    config: Object.freeze({
      rate: Object.freeze({ ...rateConfig }),
      quota: Object.freeze({ ...quotaConfig }),
      abuse: Object.freeze({ ...abuseConfig }),
    }),
  });
}
