/**
 * SHARED FILE-COUNT LIMIT HELPER (spec Task 27, Req 11.9).
 *
 * Both Project_Export (Task 27.1) and Lockin_Audit (Task 27.2) apply the SAME
 * configurable maximum file-count to a single operation (default 10,000) and,
 * when a Project exceeds it, MUST report the excess to the user rather than
 * silently truncating the operation. This tiny module centralizes that contract
 * so the two subsystems share one definition of "the limit" and one shape for
 * the over-limit report.
 *
 * It counts the entries of an already-read { relPath: contents } tree map (the
 * PersistenceStore read shape) — the tree the caller has decided to operate on,
 * with .git already excluded per the PersistenceStore/SnapshotStore contract.
 *
 * Node stdlib only; no dependency; no plumby import.
 */

import { requireNumber, fail } from '../model/validate.js';

/** The default configurable maximum file-count for a single operation (Req 11.9). */
export const DEFAULT_FILE_COUNT_LIMIT = 10000;

/**
 * Validate a file-count limit: a positive, finite integer. Used by both the
 * export and the audit factories so an invalid limit is rejected at the edge
 * rather than silently coercing.
 *
 * @param {string} model  the owning factory name (for the error message)
 * @param {number} limit  the configured maximum file-count
 * @returns {number} the validated limit
 */
export function requireFileCountLimit(model, limit) {
  requireNumber(model, 'fileCountLimit', limit);
  if (!Number.isInteger(limit) || limit <= 0) {
    fail(model, `fileCountLimit must be a positive integer, got ${JSON.stringify(limit)}`);
  }
  return limit;
}

/**
 * Count the files in a { relPath: contents } tree map.
 *
 * @param {Object<string, string|Buffer>} tree  the read tree map
 * @returns {number} the number of file entries
 */
export function countTreeFiles(tree) {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) {
    return 0;
  }
  return Object.keys(tree).length;
}

/**
 * Check a tree against the configured file-count limit.
 *
 * Returns a structured verdict so the caller can ABORT with a user-visible
 * excess report (Req 11.9) rather than truncating:
 *   - { ok: true, count }                          within the limit
 *   - { ok: false, count, limit }                  over the limit (report excess)
 *
 * @param {Object<string, string|Buffer>} tree  the read tree map
 * @param {number} limit                         the configured maximum file-count
 * @returns {{ ok: boolean, count: number, limit: number }}
 */
export function checkFileCount(tree, limit) {
  const count = countTreeFiles(tree);
  if (count > limit) {
    return { ok: false, count, limit };
  }
  return { ok: true, count, limit };
}
