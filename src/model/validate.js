/**
 * Small shared validation helpers for the data-model record factories.
 *
 * Records are plain serializable objects (no classes). Each factory validates
 * required fields and enum membership at the edge, then returns a normalized
 * plain object. Invalid input is rejected with a clear, specific Error so bad
 * data never reaches storage.
 */

/** Throw a TypeError describing which field of which model was invalid. */
export function fail(model, message) {
  throw new TypeError(`${model}: ${message}`);
}

/** Require a non-empty string. Trims and returns it. */
export function requireString(model, field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(model, `${field} must be a non-empty string`);
  }
  return value;
}

/** Require a string (may be empty), useful for human-readable bodies/text. */
export function requireStringAllowEmpty(model, field, value) {
  if (typeof value !== 'string') {
    fail(model, `${field} must be a string`);
  }
  return value;
}

/**
 * Require a PARSEABLE ISO-8601 date string and return it normalized to the
 * canonical ISO form (`new Date(x).toISOString()`), so a record can never store
 * a date the authorizer will silently fail to parse (audit H8). Rejects empty
 * strings, non-strings, and anything Date.parse cannot read (NaN). This is the
 * one validator that guarantees `Date.parse(record.field)` is finite downstream.
 */
export function requireIsoDate(model, field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(model, `${field} must be a non-empty ISO-8601 date string`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    fail(model, `${field} must be a parseable ISO-8601 date, got ${JSON.stringify(value)}`);
  }
  return new Date(ms).toISOString();
}

/** Optional string: undefined passes through, otherwise must be a string. */
export function optionalString(model, field, value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    fail(model, `${field}, when present, must be a string`);
  }
  return value;
}

/** Require a finite number. */
export function requireNumber(model, field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(model, `${field} must be a finite number`);
  }
  return value;
}

/** Require a boolean. */
export function requireBoolean(model, field, value) {
  if (typeof value !== 'boolean') {
    fail(model, `${field} must be a boolean`);
  }
  return value;
}

/** Require an array. */
export function requireArray(model, field, value) {
  if (!Array.isArray(value)) {
    fail(model, `${field} must be an array`);
  }
  return value;
}

/**
 * Require `value` to be a member of a closed enum, validated with the enum's
 * own `isValidX` predicate. `legal` is the frozen enum array (for the message).
 */
export function requireEnum(model, field, value, predicate, legal) {
  if (!predicate(value)) {
    fail(
      model,
      `${field} must be one of [${legal.join(', ')}], got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Require `value` to be one of an inline literal set (for closed enums the
 * design defines locally, not exported from enums.js).
 */
export function requireOneOf(model, field, value, legal) {
  if (!legal.includes(value)) {
    fail(
      model,
      `${field} must be one of [${legal.join(', ')}], got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
