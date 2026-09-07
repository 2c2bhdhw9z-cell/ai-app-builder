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

/**
 * The Theme catalog (Req 29.1), identified by id. A Theme is a named visual
 * appearance: a `light` or `dark` base mode PLUS a color palette that recolors
 * the surface. The catalog is the base `light` and `dark` themes PLUS the six
 * named color themes from Req 29's Definitions ("Pastel Pasture", "Out There",
 * "Paranormal Purple", "Morning Dew", "Summer Sunset", "Peach Popsicle").
 *
 * This set is CLOSED but EXTENSIBLE ONLY BY A SPEC CHANGE — additional named
 * themes are added by appending members to this frozen list (and to
 * THEME_CATALOG), never by open-ended user input. An out-of-catalog value is
 * rejected at the edges via isValidTheme. Do not add, remove, or reorder values
 * without a spec change.
 */
export const Theme = Object.freeze([
  'light',
  'dark',
  'pastel-pasture',
  'out-there',
  'paranormal-purple',
  'morning-dew',
  'summer-sunset',
  'peach-popsicle',
]);

/**
 * THE THEME CATALOG (Req 29.1): a frozen map keyed by each Theme id to a frozen
 * descriptor `{ id, displayName, base, palette }` where `base` is `'light'` or
 * `'dark'` and `palette` carries IDENTICAL keys across every theme so a client
 * can render any theme uniformly:
 *
 *   { background, surface, accent, button, badge,
 *     statusInfo, statusSuccess, statusWarning, statusError }
 *
 * All values are real hex colors. `light` and `dark` are the neutral bases; the
 * six named themes carry distinctive palettes with a documented base mode. Each
 * entry and its palette are deep-frozen. Extended ONLY by a spec change.
 */
export const THEME_CATALOG = Object.freeze({
  light: Object.freeze({
    id: 'light',
    displayName: 'Light',
    base: 'light',
    palette: Object.freeze({
      background: '#ffffff',
      surface: '#f5f6f8',
      accent: '#2563eb',
      button: '#2563eb',
      badge: '#e2e8f0',
      statusInfo: '#2563eb',
      statusSuccess: '#16a34a',
      statusWarning: '#d97706',
      statusError: '#dc2626',
    }),
  }),
  dark: Object.freeze({
    id: 'dark',
    displayName: 'Dark',
    base: 'dark',
    palette: Object.freeze({
      background: '#0b0f19',
      surface: '#161b26',
      accent: '#60a5fa',
      button: '#3b82f6',
      badge: '#1f2937',
      statusInfo: '#60a5fa',
      statusSuccess: '#4ade80',
      statusWarning: '#fbbf24',
      statusError: '#f87171',
    }),
  }),
  'pastel-pasture': Object.freeze({
    id: 'pastel-pasture',
    displayName: 'Pastel Pasture',
    base: 'light',
    palette: Object.freeze({
      background: '#f4faf1',
      surface: '#e6f3e1',
      accent: '#6bbf59',
      button: '#7cc47a',
      badge: '#cfe8c5',
      statusInfo: '#5b9bd5',
      statusSuccess: '#4f9d69',
      statusWarning: '#e0b64c',
      statusError: '#d97a7a',
    }),
  }),
  'out-there': Object.freeze({
    id: 'out-there',
    displayName: 'Out There',
    base: 'dark',
    palette: Object.freeze({
      background: '#050418',
      surface: '#140f33',
      accent: '#00e5ff',
      button: '#7c3aed',
      badge: '#241a4d',
      statusInfo: '#22d3ee',
      statusSuccess: '#34d399',
      statusWarning: '#facc15',
      statusError: '#fb7185',
    }),
  }),
  'paranormal-purple': Object.freeze({
    id: 'paranormal-purple',
    displayName: 'Paranormal Purple',
    base: 'dark',
    palette: Object.freeze({
      background: '#160d24',
      surface: '#241537',
      accent: '#b06cf0',
      button: '#9333ea',
      badge: '#3a2352',
      statusInfo: '#a78bfa',
      statusSuccess: '#4ade80',
      statusWarning: '#fbbf24',
      statusError: '#f472b6',
    }),
  }),
  'morning-dew': Object.freeze({
    id: 'morning-dew',
    displayName: 'Morning Dew',
    base: 'light',
    palette: Object.freeze({
      background: '#f0fbfb',
      surface: '#dff3f4',
      accent: '#14b8a6',
      button: '#2dd4bf',
      badge: '#c2ebe9',
      statusInfo: '#0ea5e9',
      statusSuccess: '#10b981',
      statusWarning: '#f59e0b',
      statusError: '#ef4444',
    }),
  }),
  'summer-sunset': Object.freeze({
    id: 'summer-sunset',
    displayName: 'Summer Sunset',
    base: 'light',
    palette: Object.freeze({
      background: '#fff6ee',
      surface: '#ffe8d6',
      accent: '#f97316',
      button: '#fb7185',
      badge: '#ffd3b6',
      statusInfo: '#f59e0b',
      statusSuccess: '#65a30d',
      statusWarning: '#ea580c',
      statusError: '#dc2626',
    }),
  }),
  'peach-popsicle': Object.freeze({
    id: 'peach-popsicle',
    displayName: 'Peach Popsicle',
    base: 'light',
    palette: Object.freeze({
      background: '#fff5f2',
      surface: '#ffe3dc',
      accent: '#ff8a7a',
      button: '#ff9f8a',
      badge: '#ffcabf',
      statusInfo: '#f472b6',
      statusSuccess: '#5eb98a',
      statusWarning: '#f5a524',
      statusError: '#e5484d',
    }),
  }),
});

/**
 * The default Theme applied when a user first enters a Workspace_Experience for
 * which they have committed no Theme (Req 29.3). Keyed by ALL FIVE
 * Workspace_Experience values; each maps to a valid Theme id. Entering an
 * experience with no committed Theme applies THAT experience's default; the
 * user may then commit a different Theme for that experience. Exported so the
 * ThemeStore and any caller share one source of truth (cross-ref Req
 * 29.1-29.3/29.5).
 */
export const DEFAULT_THEME_BY_EXPERIENCE = Object.freeze({
  'kiro-style': 'light',
  'vibe-first': 'summer-sunset',
  'technical-workbench': 'dark',
  'mobile-command-center': 'morning-dew',
  custom: 'light',
});

/** The documented global Theme fallback for an unknown experience (Req 29.3). */
export const DEFAULT_THEME = 'light';

/**
 * defaultThemeFor(experience): the default Theme id for a Workspace_Experience
 * (Req 29.3), or the documented global fallback (`light`) for an experience not
 * in the map. Never throws.
 */
export function defaultThemeFor(experience) {
  return DEFAULT_THEME_BY_EXPERIENCE[experience] ?? DEFAULT_THEME;
}

/**
 * themeCatalogEntry(id): the frozen `{ id, displayName, base, palette }`
 * descriptor for a Theme id, or `null` for an unknown id — so callers read the
 * palette without reaching into the frozen catalog map directly.
 */
export function themeCatalogEntry(id) {
  return THEME_CATALOG[id] ?? null;
}

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

/** True when `value` is a legal Theme id (Req 29.1/29.8). */
export function isValidTheme(value) {
  return Theme.includes(value);
}
