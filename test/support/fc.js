/**
 * Shared fast-check configuration for the property-based tests.
 *
 * Property tests run at least 100 iterations and are tagged with a stable,
 * greppable string so the suite maps back to the spec's numbered properties.
 */

/** Pass to fc.assert(prop, fcConfig). numRuns >= 100 per the spec. */
export const fcConfig = Object.freeze({ numRuns: 100 });

/**
 * The canonical tag for a property test.
 *
 * @param {number} n       the spec property number
 * @param {string} title   the property's title
 * @returns {string} e.g. "Feature: ai-app-builder, Property 7: idempotent scaffold"
 */
export function propertyTag(n, title) {
  return `Feature: ai-app-builder, Property ${n}: ${title}`;
}
