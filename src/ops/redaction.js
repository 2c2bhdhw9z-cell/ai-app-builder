/**
 * Centralized secret-redaction filter (Req 24.4, 25.1).
 *
 * THIS is the single filter that EVERY audit / metrics / error / log path in
 * the platform routes through before a record leaves the process or is
 * persisted. Centralizing redaction in one place is the Req 24.4 requirement:
 * no code path may hand-roll its own secret masking. Later features (AuditLog,
 * observability, the Builder Server reportError surface, the deletion service)
 * all obtain a redactor from this module and pass records through `redact`
 * before emitting them.
 *
 * A redactor is built from a set/provider of KNOWN secret VALUES (and,
 * optionally, known secret NAMES). It deep-scans an arbitrary serializable
 * value and replaces every occurrence of a known secret value — including one
 * embedded as a SUBSTRING of a larger string (e.g. a token appearing inside a
 * stderr line) — with a fixed placeholder.
 *
 * Guarantees:
 *   (a) never mutates its input — returns a redacted deep copy;
 *   (b) handles nested objects, arrays, and strings;
 *   (c) redacts values that appear as substrings of larger strings;
 *   (d) skips short/empty candidate values (< MIN_SECRET_LENGTH) so unrelated
 *       bytes are not over-redacted;
 *   (e) is pure / deterministic — same input + same secret set => same output.
 */

/** Fixed placeholder that replaces any occurrence of a known secret value. */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Minimum length for a candidate secret value to participate in substring
 * redaction. Very short values (e.g. "", "a", "12") would over-redact
 * unrelated bytes, so they are skipped.
 */
export const MIN_SECRET_LENGTH = 4;

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the centralized redactor.
 *
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.secretValues] known secret VALUES to redact.
 * @param {Iterable<string>} [opts.secretNames] known secret NAMES; used to
 *   redact object property VALUES whose key matches a known secret name, even
 *   when the value itself is not (yet) in the known-values set.
 * @param {(s: string) => boolean} [opts.isSecretValue] optional extra predicate;
 *   a whole string equal to a candidate returning true is redacted.
 * @returns {{ redact(value:any): any, redactString(s:string): string }}
 */
export function createRedactor(opts = {}) {
  const { secretValues, secretNames, isSecretValue } = opts;

  // Freeze the known-value set at construction so redaction is deterministic.
  const values = [];
  const seen = new Set();
  if (secretValues) {
    for (const v of secretValues) {
      if (typeof v !== 'string') continue;
      if (v.length < MIN_SECRET_LENGTH) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      values.push(v);
    }
  }
  // Longest-first so an overlapping secret redacts the widest match first.
  values.sort((a, b) => b.length - a.length);

  const names = new Set();
  if (secretNames) {
    for (const n of secretNames) {
      if (typeof n === 'string' && n.length > 0) names.add(n);
    }
  }

  const patterns = values.map((v) => new RegExp(escapeRegExp(v), 'g'));

  /** Replace every known-secret substring inside a single string. */
  function redactString(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = s;
    for (const re of patterns) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTION_PLACEHOLDER);
    }
    if (typeof isSecretValue === 'function' && out === s) {
      // Whole-string predicate: only when no substring pattern already matched.
      if (s.length >= MIN_SECRET_LENGTH && isSecretValue(s)) {
        return REDACTION_PLACEHOLDER;
      }
    }
    return out;
  }

  /** Deep, non-mutating redaction of an arbitrary serializable value. */
  function redact(value) {
    return redactValue(value, false);
  }

  function redactValue(value, keyIsSecret) {
    if (typeof value === 'string') {
      if (keyIsSecret && value.length > 0) return REDACTION_PLACEHOLDER;
      return redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, false));
    }
    if (value && typeof value === 'object') {
      // Plain serializable objects only; leave exotic objects as-is by copying
      // enumerable own keys (matches how records are shaped in this codebase).
      const copy = {};
      for (const [k, v] of Object.entries(value)) {
        copy[k] = redactValue(v, names.has(k));
      }
      return copy;
    }
    // number, boolean, null, undefined, bigint, symbol, function: unchanged.
    return value;
  }

  return Object.freeze({ redact, redactString });
}
