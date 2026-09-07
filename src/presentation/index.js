/**
 * Presentation subsystem barrel (spec Task 31, Req 27, Property 20).
 *
 * The public seam for the pure-presentation layer: the Workspace_Experience
 * store (per-User_Account, control-plane persistence of the selected layout and
 * the `custom` arrangement) and the platform's OWN, original, clean-room layout
 * descriptors (one per experience). Selecting a Workspace_Experience applies
 * layout/organization ONLY and never mutates Project data or any other setting
 * (Req 27.2/27.3, Property 20). Mirrors src/memory/index.js and
 * src/server/index.js barrels so callers import from one seam.
 */

export { createWorkspaceExperienceStore } from './workspace-experience-store.js';
export { createWorkModeSession } from './work-mode-session.js';
export { createThemeStore } from './theme-store.js';
export {
  workspaceExperienceLayouts,
  defaultCustomLayout,
  WORKBENCH_ATTRIBUTION,
  LAYOUT_SURFACES,
} from './layouts.js';
