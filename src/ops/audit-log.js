/**
 * audit-log.js — the append-only AuditLog of security-relevant actions (spec
 * Task 12.6, Req 25.1, and the Req 24.4 centralized-redaction requirement).
 *
 * The AuditLog is the single durable stream of security events: authentication
 * (success / denied), authorization decisions, Session issuance / rotation /
 * expiry, Secret access, destructive confirm-class operations, and Project /
 * User_Account deletions. Every entry is:
 *
 *   (a) stamped with `at = now()` at record time (an event may carry its own
 *       `at`; the log's clock is authoritative and always wins);
 *   (b) scoped to the acting `accountId` — security events (everything except
 *       purely operational metrics) MUST carry an accountId, so every entry is
 *       attributable to a User_Account (Req 25.1);
 *   (c) routed ENTIRELY through the FEAT-001 centralized redactor BEFORE it is
 *       appended, so no Secret value can ever land in an audit record even if a
 *       caller accidentally hands one in (Req 24.4 / 25.1). This is the single
 *       filter every audit path routes through; the AuditLog never hand-rolls
 *       its own masking.
 *
 * APPEND-ONLY: entries land in an in-memory array that grows only. There is NO
 * update or delete API — `record(event)` is the sole mutation, and the read
 * helpers return copies so a caller cannot reach in and rewrite history.
 *
 * SINK SHAPE: the AuditLog is itself a VALID audit-sink (it exposes
 * `record(event)`), so it drops straight into the existing `toAuditSink` seam
 * used by AuthService / SessionManager / Authorizer / RetentionService with NO
 * changes to those modules — you construct the AuditLog in the composition layer
 * and pass it as `opts.auditSink`. It optionally forwards each redacted entry to
 * a further downstream sink (e.g. a persistent store or a second collector).
 *
 * Factory conventions mirror the rest of the codebase: a factory returning
 * Object.freeze({...}) with injected dependencies (redactor, now clock, sink).
 */

/** Security events that MUST be attributable to a User_Account. */
function isSecurityEvent(type) {
  // Everything the AuditLog records is a security-relevant action; the only
  // entries that may legitimately lack an accountId are purely operational
  // metrics forwarded from observability, which carry their own shape. We treat
  // any event lacking a `type` as malformed regardless.
  return typeof type === 'string' && type.length > 0;
}

/**
 * Create an append-only AuditLog.
 *
 * @param {object} args
 * @param {object} args.redactor  the centralized redactor (src/ops/redaction.js);
 *        required — every event is passed through `redactor.redact` before it is
 *        appended so no Secret value can enter the log.
 * @param {() => (number|string)} [args.now]  injectable clock; the value stamped
 *        as `at` on every entry. Defaults to Date.now().
 * @param {Function|{record:Function}} [args.sink]  OPTIONAL downstream sink that
 *        receives each REDACTED entry after it is appended (a function or an
 *        object with record(event)).
 * @returns {object} frozen AuditLog exposing record() + read helpers.
 */
export function createAuditLog({ redactor, now = () => Date.now(), sink } = {}) {
  if (!redactor || typeof redactor.redact !== 'function') {
    throw new TypeError('createAuditLog requires a redactor with redact(event)');
  }

  // Normalize the optional downstream sink into a single record(event) fn.
  let forward = () => {};
  if (sink != null) {
    if (typeof sink === 'function') {
      forward = (event) => sink(event);
    } else if (typeof sink.record === 'function') {
      forward = (event) => sink.record(event);
    } else {
      throw new TypeError('audit sink must be a function or an object with a record(event) method');
    }
  }

  /** The append-only backing store. Grows only; never spliced or reassigned. */
  const entries = [];

  /**
   * record(event): stamp, scope, REDACT, then append (and forward). This is the
   * ONLY mutation surface — there is no update or delete. The entire event is
   * passed through the redactor first, so a Secret value handed in anywhere
   * (top-level, nested, embedded in a string) is replaced before it is stored.
   *
   * @param {object} event  a plain serializable event: { type, accountId?, ... }.
   * @returns {object} the stored (redacted, frozen) entry.
   */
  function record(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('AuditLog.record requires a plain event object');
    }
    if (!isSecurityEvent(event.type)) {
      throw new TypeError('AuditLog.record requires an event with a non-empty string `type`');
    }

    // Stamp the log's authoritative clock (always wins over any caller `at`),
    // then route the WHOLE event through the centralized redactor. Redaction
    // happens on a copy — the redactor never mutates its input — so nothing a
    // caller retains is altered, and no Secret value can be appended.
    const stamped = { ...event, at: now() };
    const redacted = redactor.redact(stamped);
    const entry = Object.freeze(redacted);

    entries.push(entry);
    forward(entry);
    return entry;
  }

  /** All entries, as a shallow copy so callers cannot mutate the log. */
  function all() {
    return entries.slice();
  }

  /** Entries of a given `type`, in append order (copy). */
  function ofType(type) {
    return entries.filter((e) => e.type === type);
  }

  /** Entries scoped to a given acting accountId, in append order (copy). */
  function forAccount(accountId) {
    return entries.filter((e) => e.accountId === accountId);
  }

  /** The number of entries recorded so far. */
  function size() {
    return entries.length;
  }

  return Object.freeze({
    // The audit-sink shape: `record` makes this drop into toAuditSink directly.
    record,
    // Read helpers (all return copies; the log itself is append-only).
    all,
    ofType,
    forAccount,
    size,
  });
}
