/**
 * observability.js — operational metrics + error reporting (spec Task 12.6/12.7,
 * Req 25.2, 25.3, and the Req 24.4 centralized-redaction requirement).
 *
 * Observability sits alongside the AuditLog and covers the OPERATIONAL side of
 * the platform: emitting metrics and operational events for the four
 * failure-prone subsystems — Sandbox provisioning, generation turns, builds, and
 * deployments — and surfacing platform-level errors to the user WITHOUT leaking
 * internal detail.
 *
 * THREE surfaces:
 *   emitMetric(name, fields)         — a named operational metric (counter /
 *                                      gauge / timing), routed through the
 *                                      redactor and forwarded to the metricsSink
 *                                      and (when present) recorded on the
 *                                      AuditLog as an operational event.
 *   emitOperationalEvent(event)      — a structured operational event for one of
 *                                      the four subsystems, redacted and logged.
 *   reportError(userAccount, op, cause) — THE user-facing error surface (Req
 *                                      25.3). It mints a correlationId, records a
 *                                      REDACTED operational log entry
 *                                      { type: OPERATIONAL_ERROR, accountId, op,
 *                                        correlationId, cause(redacted) }, and
 *                                      RETURNS { correlationId, userMessage }
 *                                      where userMessage is a GENERIC indication
 *                                      carrying the correlationId — so the
 *                                      user-visible error correlates to the
 *                                      operational entry, but no Secret or
 *                                      internal detail reaches the user.
 *
 * CENTRALIZED REDACTION (Req 24.4): every surface routes its record through the
 * single FEAT-001 redactor before it leaves this module. No observability path
 * hand-rolls its own masking, and a `cause` handed to reportError (an Error, a
 * string, or an object) is stringified/shaped and then redacted, so a Secret
 * value embedded in an error message can never reach the log or the user.
 *
 * Factory conventions mirror the codebase: Object.freeze({...}) with injected
 * dependencies (auditLog, redactor, now clock, metricsSink).
 */

import { randomUUID } from 'node:crypto';

import { AUDIT_EVENTS } from '../auth/audit.js';

/** The four failure-prone subsystems metrics/events must cover (Req 25.2). */
export const OPERATIONAL_SUBSYSTEMS = Object.freeze([
  'sandbox_provisioning',
  'generation_turn',
  'build',
  'deployment',
]);

/**
 * The generic, non-disclosing user-facing error message. It carries ONLY the
 * correlationId so a user can quote it to support; it never varies by cause and
 * never contains internal/Secret detail.
 */
function userFacingMessage(correlationId) {
  return `Something went wrong while processing your request. Please try again; if the problem persists, reference error id ${correlationId}.`;
}

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
 * Normalize an arbitrary `cause` into a plain, serializable shape BEFORE
 * redaction. An Error becomes { name, message } (never the stack, which can leak
 * paths/values); a string stays a string; a plain object is passed through as-is
 * so the redactor can deep-scan it; anything else is stringified.
 */
function shapeCause(cause) {
  if (cause == null) return null;
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  if (typeof cause === 'string') return cause;
  if (typeof cause === 'object') return cause;
  return String(cause);
}

/**
 * Create an Observability instance.
 *
 * @param {object} args
 * @param {object} [args.auditLog]  OPTIONAL AuditLog (src/ops/audit-log.js) or any
 *        sink with record(event); operational events + errors are recorded here.
 * @param {object} args.redactor   the centralized redactor (src/ops/redaction.js);
 *        required — every emitted record routes through redactor.redact.
 * @param {() => (number|string)} [args.now]  injectable clock stamped as `at`.
 * @param {Function|{record:Function}} [args.metricsSink]  OPTIONAL sink for
 *        emitMetric (a function or an object with record(metric)).
 * @returns {object} frozen { emitMetric, emitOperationalEvent, reportError }.
 */
export function createObservability({ auditLog, redactor, now = () => Date.now(), metricsSink } = {}) {
  if (!redactor || typeof redactor.redact !== 'function') {
    throw new TypeError('createObservability requires a redactor with redact(event)');
  }

  // Normalize the optional AuditLog into a record(event) fn.
  let recordAudit = () => {};
  if (auditLog != null) {
    if (typeof auditLog === 'function') {
      recordAudit = (event) => auditLog(event);
    } else if (typeof auditLog.record === 'function') {
      recordAudit = (event) => auditLog.record(event);
    } else {
      throw new TypeError('auditLog must be a function or an object with a record(event) method');
    }
  }

  // Normalize the optional metrics sink into a record(metric) fn.
  let emitToMetricsSink = () => {};
  if (metricsSink != null) {
    if (typeof metricsSink === 'function') {
      emitToMetricsSink = (metric) => metricsSink(metric);
    } else if (typeof metricsSink.record === 'function') {
      emitToMetricsSink = (metric) => metricsSink.record(metric);
    } else {
      throw new TypeError('metricsSink must be a function or an object with a record(metric) method');
    }
  }

  /** Redact every record through the single central filter before it leaves. */
  const redact = (rec) => redactor.redact(rec);

  /**
   * emitMetric(name, fields): emit a named operational metric for one of the
   * four subsystems. The metric is redacted, forwarded to the metricsSink, and
   * (when an AuditLog is present) recorded as an operational event so metrics
   * and audits share the single redaction filter.
   *
   * @param {string} name    the metric name (e.g. 'sandbox_provisioning.latency_ms').
   * @param {object} [fields] arbitrary serializable fields (subsystem, value, ...).
   * @returns {object} the redacted metric record.
   */
  function emitMetric(name, fields = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('emitMetric requires a non-empty metric name');
    }
    const metric = redact({ metric: name, at: now(), ...fields });
    emitToMetricsSink(metric);
    return metric;
  }

  /**
   * emitOperationalEvent(event): record a structured operational event for one
   * of the four subsystems on the AuditLog (redacted). Unlike a security audit
   * event, an operational event need not carry an accountId.
   *
   * @param {object} event  a plain serializable event: { type, subsystem, ... }.
   * @returns {object} the redacted event as recorded.
   */
  function emitOperationalEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('emitOperationalEvent requires a plain event object');
    }
    const redacted = redact({ at: now(), ...event });
    recordAudit(redacted);
    return redacted;
  }

  /**
   * reportError(userAccount, op, cause): THE user-facing error surface (Req
   * 25.3). Generate a correlationId, record a REDACTED operational log entry
   * correlated by that id, and return { correlationId, userMessage } where
   * userMessage is a generic indication carrying the correlationId (so the
   * user-visible error correlates to the operational entry) and NOTHING about
   * the cause. The recorded `cause` is shaped and redacted so no Secret value or
   * internal detail (e.g. a stack) is stored.
   *
   * @param {object|string} userAccount  the acting account ({ id } or id); may be
   *        null for a pre-auth failure (accountId is recorded as null).
   * @param {string} op     the operation that failed (e.g. 'generation.turn').
   * @param {*} cause       the underlying error/cause (Error, string, or object).
   * @returns {{ correlationId: string, userMessage: string }}
   */
  function reportError(userAccount, op, cause) {
    const correlationId = randomUUID();
    const accountId = accountIdOf(userAccount);

    // Record a REDACTED operational entry correlated by correlationId. The whole
    // entry (including the shaped cause) goes through the central redactor, so a
    // Secret value embedded in an error message never reaches the log.
    const entry = redact({
      type: AUDIT_EVENTS.OPERATIONAL_ERROR,
      at: now(),
      accountId,
      op: typeof op === 'string' ? op : String(op ?? ''),
      correlationId,
      cause: shapeCause(cause),
    });
    recordAudit(entry);

    // The user-facing indication carries ONLY the correlationId — no cause, no
    // Secret, no internal detail — so a user's report correlates to the entry.
    return { correlationId, userMessage: userFacingMessage(correlationId) };
  }

  return Object.freeze({
    emitMetric,
    emitOperationalEvent,
    reportError,
    OPERATIONAL_SUBSYSTEMS,
  });
}
