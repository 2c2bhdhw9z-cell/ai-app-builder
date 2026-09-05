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

/** Security-event type constants emitted by the auth subsystem. */
export const AUDIT_EVENTS = Object.freeze({
  SESSION_ISSUED: 'session.issued',
  SESSION_ROTATED: 'session.rotated',
  SESSION_EXPIRED: 'session.expired',
  SESSION_REJECTED: 'session.rejected',
  AUTHZ_DECISION: 'authz.decision',
  AUTHN_SUCCESS: 'authn.success',
  AUTHN_DENIED: 'authn.denied',
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
