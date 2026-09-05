/**
 * Closed enums for the ai-app-builder data model.
 *
 * Every set here is CLOSED: the listed values are the only legal ones. Each is
 * a frozen array so a value set can never be mutated at runtime, and each ships
 * a small `isValidX` predicate for validation at the edges (API input, storage
 * reads). These mirror the spec's data models exactly — do not add, remove, or
 * reorder values without a spec change.
 */

/** A project's high-level shape. */
export const Target_Category = Object.freeze([
  'web',
  'full-stack-web',
  'mobile',
  'multi-target',
]);

/** A concrete build target within a project. */
export const Target = Object.freeze(['web', 'backend', 'mobile', 'shared']);

/** How a project came into existence. */
export const Project_Origin = Object.freeze([
  'blank',
  'template',
  'github-import',
  'fork',
]);

/** The kind of external service a connector integrates. */
export const Connector_Category = Object.freeze([
  'database',
  'auth',
  'payments',
  'hosting-deploy',
  'storage',
  'ai-model',
]);

/** How project memory is maintained. */
export const Memory_Mode = Object.freeze(['auto', 'manual', 'off']);

/**
 * The outcomes of the plumby command classifier (see classifyCommand). Held
 * here so the platform can reason about classifier results against a closed,
 * frozen set without importing plumby internals for the value list.
 */
export const Classifier_Outcome = Object.freeze(['allow', 'confirm', 'refuse']);

/** True when `value` is a legal Target_Category. */
export function isValidTargetCategory(value) {
  return Target_Category.includes(value);
}

/** True when `value` is a legal Target. */
export function isValidTarget(value) {
  return Target.includes(value);
}

/** True when `value` is a legal Project_Origin. */
export function isValidProjectOrigin(value) {
  return Project_Origin.includes(value);
}

/** True when `value` is a legal Connector_Category. */
export function isValidConnectorCategory(value) {
  return Connector_Category.includes(value);
}

/** True when `value` is a legal Memory_Mode. */
export function isValidMemoryMode(value) {
  return Memory_Mode.includes(value);
}

/** True when `value` is a legal classifier outcome. */
export function isValidClassifierOutcome(value) {
  return Classifier_Outcome.includes(value);
}
