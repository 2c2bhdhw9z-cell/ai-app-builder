/**
 * Audit-sink seam (Req 25.1).
 *
 * Session issuance/rotation/expiry and every authorization decision are
 * auditable security events. The full AuditLog is task 12; this module only
 * establishes the SEAM so those code paths already emit events today. An audit
 * sink is any object with a `record(event)` method, OR a bare function
 * `(event) => void`. `createCollectorSink()` is an in-memory collector used by
 * tests and as the trivial default.
 *
 * Events are plain serializable objects: { type, at, ...fields }. Callers must
 * never place secret material (tokens, ciphertext) in an event — only ids and
 * decisions.
 */

/**
 * Security-event type constants emitted across the platform.
 *
 * The session.* / authn.* / authz.* constants are emitted by the auth
 * subsystem. The remaining constants are the Task-12 platform-operations
 * vocabulary shared by the QuotaManager, SecretStore, deletion service, and
 * AuditLog (secret access, confirm-class op, deletion, quota/rate-limit/abuse,
 * operational error). Extending this set must never remove an existing member;
 * the object stays frozen.
 */
export const AUDIT_EVENTS = Object.freeze({
  SESSION_ISSUED: 'session.issued',
  SESSION_ROTATED: 'session.rotated',
  SESSION_EXPIRED: 'session.expired',
  SESSION_REJECTED: 'session.rejected',
  SESSION_REVOKED: 'session.revoked',
  // A valid-signature token presenting a STALE rotation (rot < current) is the
  // canonical signal that a token was copied/replayed. High severity: the whole
  // session family is killed in response.
  SESSION_REUSE_DETECTED: 'session.reuse_detected',
  AUTHZ_DECISION: 'authz.decision',
  AUTHN_SUCCESS: 'authn.success',
  AUTHN_DENIED: 'authn.denied',
  // Task-12 platform-operations events (secrets, confirm-class ops, deletion,
  // quota/rate-limit/abuse, operational errors).
  SECRET_ACCESS: 'secret.access',
  CONFIRM_CLASS_OP: 'command.confirm',
  PROJECT_DELETED: 'project.deleted',
  ACCOUNT_DELETED: 'account.deleted',
  QUOTA_EXCEEDED: 'quota.exceeded',
  RATE_LIMIT_EXCEEDED: 'ratelimit.exceeded',
  ABUSE_MITIGATED: 'abuse.mitigated',
  OPERATIONAL_ERROR: 'operational.error',
});

/**
 * Normalize any accepted sink shape into a single `record(event)` function.
 * Accepts: undefined (no-op), a function, or an object with `.record`.
 */
export function toAuditSink(sink) {
  if (sink === undefined || sink === null) {
    return () => {};
  }
  if (typeof sink === 'function') {
    return (event) => sink(event);
  }
  if (typeof sink.record === 'function') {
    return (event) => sink.record(event);
  }
  throw new TypeError('audit sink must be a function or an object with a record(event) method');
}

/**
 * An in-memory audit collector. `record(event)` appends; `.events` is the log.
 * Trivial stand-in for the full AuditLog (task 12) and the fake used by tests.
 */
export function createCollectorSink() {
  const events = [];
  return {
    events,
    record(event) {
      events.push(event);
    },
    /** Convenience: all recorded events of a given type. */
    ofType(type) {
      return events.filter((e) => e.type === type);
    },
  };
}
