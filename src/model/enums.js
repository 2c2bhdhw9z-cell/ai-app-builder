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

/**
 * The five Workspace_Experiences (Req 27.1), identified by name:
 * "Kiro-style Workspace" (`kiro-style`), "Vibe-first Workspace" (`vibe-first`),
 * "Technical Workbench" (`technical-workbench`), "Mobile Command Center"
 * (`mobile-command-center`), and "Custom Workspace" (`custom`). A
 * Workspace_Experience is pure presentation — a SAVED LAYOUT (arrangement,
 * visibility, sizing of the builder surfaces) — so selecting one changes only
 * surface layout/organization and never any Project data or other setting
 * (Req 27.2/27.3, Property 20). The values are exactly those in the spec, in
 * that order — do not add, remove, or reorder them without a spec change.
 */
export const Workspace_Experience = Object.freeze([
  'kiro-style',
  'vibe-first',
  'technical-workbench',
  'mobile-command-center',
  'custom',
]);

/**
 * The default Workspace_Experience applied to a user who has made no selection
 * (Req 27.6). `kiro-style` is the documented default (the first, named
 * "Kiro-style Workspace"); it is applied without altering any Project data or
 * other setting. Exported so the store and any caller share one source of
 * truth for the default.
 */
export const DEFAULT_WORKSPACE_EXPERIENCE = 'kiro-style';

/**
 * The three Work_Modes (Req 28.1), identified by name: `vibe`
 * (describe-and-build), `spec` (plan/requirements-first then build), and
 * `hybrid` (a blend of the two). A Work_Mode is pure interaction FLOW — it
 * shapes only how the Builder Server frames the NEXT turn's prompt/flow and
 * never rewrites history or mutates the tree, so selecting one changes the
 * collaboration style and never any Project data or other setting (Req 28.6).
 * The values are exactly those in the spec, in that order — do not add,
 * remove, or reorder them without a spec change.
 */
export const Work_Mode = Object.freeze(['vibe', 'spec', 'hybrid']);

/**
 * The default Work_Mode applied to a new Session when the user makes no
 * selection (Req 28.3). `vibe` is the documented default (the first,
 * describe-and-build mode). Exported so the per-Session module and any caller
 * share one source of truth for the default.
 */
export const DEFAULT_WORK_MODE = 'vibe';

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

/** True when `value` is a legal Workspace_Experience (Req 27.1/27.7). */
export function isValidWorkspaceExperience(value) {
  return Workspace_Experience.includes(value);
}

/** True when `value` is a legal Work_Mode (Req 28.1/28.7). */
export function isValidWorkMode(value) {
  return Work_Mode.includes(value);
}
