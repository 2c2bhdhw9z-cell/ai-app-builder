/**
 * THE WORKSPACE_EXPERIENCE LAYOUT DESCRIPTORS (spec Task 31, Req 27, Property 20).
 *
 * This module is the platform's OWN, original, clean-room set of layout
 * descriptors — one per Workspace_Experience value (see Workspace_Experience in
 * src/model/enums.js). A layout descriptor is a plain, FROZEN data object that
 * describes ONLY layout/organization: the arrangement, visibility, and sizing
 * of the builder surfaces the Builder Server already renders (Req 27.2):
 *
 *   - activityStream : the reasoning + tool feed (Architecture §1/§5)
 *   - preview        : the running Preview (Architecture §4)
 *   - compose        : the chat/compose area
 *   - filePanel      : the file/tool panels (file tree, tool output)
 *   - sessionHeader  : the Session_Header (mode + experience + session info)
 *
 * NON-MUTATION BY CONSTRUCTION (Req 27.3, Property 20): a descriptor carries NO
 * theme, work_mode, models, skills, connectors, permissions, project, or origin
 * keys — layout/organization ONLY. There is structurally nothing here that
 * could change a Theme, a Work_Mode, source code, agent state, Project data,
 * models, Skills, Connectors, permissions, or Project_Origin. Selecting an
 * experience just re-parametrizes which surfaces are shown and where.
 *
 * NO HARDCODED THEME (Req 27.8, Req 29 / Task 33): descriptors carry NO colors,
 * fonts, or other visual-appearance data. Every experience — including
 * `technical-workbench` — stays fully theme-able via the Theme setting, which
 * is a separate axis built in a later task. Layout here; appearance there.
 *
 * ATTRIBUTION (Req 27.8): the `technical-workbench` descriptor is an ORIGINAL,
 * clean-room IDE-style developer surface built on this platform's own surfaces
 * and components. It uses ONLY the project's own labels/identifiers and embeds
 * NO third party's name, logo, proprietary visual design, or code. It carries a
 * presentational, non-affiliated credit string (WORKBENCH_ATTRIBUTION, e.g.
 * "Inspired by tools like Kiro") as DATA only — an honest acknowledgement that
 * implies NO affiliation with or endorsement by any third party (including
 * AWS/Kiro). Displaying it changes no Project data or other setting.
 */

/**
 * The five surface identifiers a layout descriptor may position. These are the
 * builder surfaces named in Req 27.2 — the platform's OWN surface names, not any
 * third party's. A descriptor's `surfaces` map is keyed by exactly these.
 */
export const LAYOUT_SURFACES = Object.freeze([
  'activityStream',
  'preview',
  'compose',
  'filePanel',
  'sessionHeader',
]);

/**
 * Presentational, non-affiliated "inspired by" credit for the Technical
 * Workbench (Req 27.8). Carried as DATA only. It is an honest acknowledgement of
 * influence and implies NO affiliation with or endorsement by any third party
 * (including AWS or Kiro). Rendering it alters no Project data or other setting.
 */
export const WORKBENCH_ATTRIBUTION = 'Inspired by tools like Kiro';

/** Deep-freeze a plain layout value (objects/arrays) so descriptors are immutable. */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

/**
 * "Kiro-style Workspace" (`kiro-style`) — the documented default layout
 * (DEFAULT_WORKSPACE_EXPERIENCE). A balanced two-column arrangement: the
 * conversational Activity_Stream + compose on the left, the live Preview on the
 * right, with a collapsible file/tool panel and the Session_Header on top.
 */
const kiroStyle = {
  id: 'kiro-style',
  name: 'Kiro-style Workspace',
  description: 'Balanced conversation-and-preview layout with the Activity_Stream and compose alongside the live Preview.',
  regions: ['header', 'left', 'right'],
  surfaces: {
    sessionHeader: { region: 'header', visible: true, order: 0 },
    activityStream: { region: 'left', visible: true, order: 0, size: 'flex' },
    compose: { region: 'left', visible: true, order: 1, size: 'auto' },
    preview: { region: 'right', visible: true, order: 0, size: 'flex' },
    filePanel: { region: 'left', visible: true, order: 2, size: 'auto', collapsible: true, collapsed: true },
  },
};

/**
 * "Vibe-first Workspace" (`vibe-first`) — a conversation-forward layout that
 * foregrounds the chat/compose area and Activity_Stream and tucks the Preview
 * and file/tool panels away, for describe-and-build flow. NOTE: this is a
 * LAYOUT axis only; it is orthogonal to the `vibe` Work_Mode (an interaction
 * flow) — the shared word is intentional but they are different axes.
 */
const vibeFirst = {
  id: 'vibe-first',
  name: 'Vibe-first Workspace',
  description: 'Conversation-forward layout foregrounding the chat/compose area and Activity_Stream; Preview and panels tucked away.',
  regions: ['header', 'main', 'aside'],
  surfaces: {
    sessionHeader: { region: 'header', visible: true, order: 0 },
    compose: { region: 'main', visible: true, order: 0, size: 'auto', emphasis: 'primary' },
    activityStream: { region: 'main', visible: true, order: 1, size: 'flex' },
    preview: { region: 'aside', visible: true, order: 0, size: 'auto', collapsible: true, collapsed: true },
    filePanel: { region: 'aside', visible: false, order: 1, size: 'auto', collapsible: true, collapsed: true },
  },
};

/**
 * "Technical Workbench" (`technical-workbench`) — an ORIGINAL, clean-room
 * IDE-style developer surface (Req 27.8): file/tool panels alongside an editor
 * region, the chat/compose area, and the live Activity_Stream — the "developer
 * cockpit" arrangement. Its design is deliberately INSPIRED BY agentic coding
 * assistants such as Kiro but is an original implementation built on this
 * platform's own surfaces; it copies no third party's name, logo, proprietary
 * visual design, or code, and it implies no affiliation/endorsement (incl.
 * AWS/Kiro). It carries the presentational `attribution` credit as DATA only,
 * and stays fully theme-able (no colors/fonts here — layout only, Req 29 later).
 */
const technicalWorkbench = {
  id: 'technical-workbench',
  name: 'Technical Workbench',
  description: 'IDE-style developer surface: file/tool panels alongside the editor, the chat/compose area, and the live Activity_Stream.',
  // Presentational, non-affiliated credit (Req 27.8). Data only; implies no
  // affiliation with or endorsement by any third party (including AWS/Kiro),
  // and rendering it changes no Project data or other setting.
  attribution: WORKBENCH_ATTRIBUTION,
  regions: ['header', 'sidebar', 'editor', 'dock'],
  surfaces: {
    sessionHeader: { region: 'header', visible: true, order: 0 },
    filePanel: { region: 'sidebar', visible: true, order: 0, size: 'auto' },
    preview: { region: 'editor', visible: true, order: 0, size: 'flex' },
    compose: { region: 'dock', visible: true, order: 0, size: 'auto' },
    activityStream: { region: 'dock', visible: true, order: 1, size: 'flex' },
  },
};

/**
 * "Mobile Command Center" (`mobile-command-center`) — a single-column,
 * mobile-oriented layout that stacks the surfaces vertically and surfaces one at
 * a time, reusing the same mobile-oriented rendering the phone surface already
 * needs (it does not create a new runtime).
 */
const mobileCommandCenter = {
  id: 'mobile-command-center',
  name: 'Mobile Command Center',
  description: 'Single-column, mobile-oriented layout that stacks the surfaces vertically for a phone-sized viewport.',
  regions: ['stack'],
  orientation: 'vertical',
  surfaces: {
    sessionHeader: { region: 'stack', visible: true, order: 0, size: 'auto' },
    activityStream: { region: 'stack', visible: true, order: 1, size: 'flex' },
    compose: { region: 'stack', visible: true, order: 2, size: 'auto' },
    preview: { region: 'stack', visible: true, order: 3, size: 'auto', collapsible: true, collapsed: true },
    filePanel: { region: 'stack', visible: true, order: 4, size: 'auto', collapsible: true, collapsed: true },
  },
};

/**
 * The documented starting arrangement for the "Custom Workspace" (`custom`)
 * experience (Req 27.4), used BEFORE the user has arranged their own layout. It
 * mirrors the default `kiro-style` arrangement so a user opting into `custom`
 * begins from a sensible, familiar layout and then rearranges it; the arranged
 * result is persisted per User_Account by the WorkspaceExperienceStore. Layout
 * only — no theme/work_mode/project data.
 */
export const defaultCustomLayout = deepFreeze({
  id: 'custom',
  name: 'Custom Workspace',
  description: 'A user-arrangeable layout composed and saved per User_Account (Req 27.4). Starts from the default arrangement until the user rearranges it.',
  regions: ['header', 'left', 'right'],
  surfaces: {
    sessionHeader: { region: 'header', visible: true, order: 0 },
    activityStream: { region: 'left', visible: true, order: 0, size: 'flex' },
    compose: { region: 'left', visible: true, order: 1, size: 'auto' },
    preview: { region: 'right', visible: true, order: 0, size: 'flex' },
    filePanel: { region: 'right', visible: true, order: 1, size: 'auto', collapsible: true, collapsed: true },
  },
});

/**
 * The frozen map from each Workspace_Experience value to its layout descriptor.
 * `custom` maps to the documented starting arrangement (defaultCustomLayout);
 * once a user arranges and saves their own layout, that persisted layout is used
 * instead by the store. Every value in Workspace_Experience has an entry here.
 */
export const workspaceExperienceLayouts = deepFreeze({
  'kiro-style': kiroStyle,
  'vibe-first': vibeFirst,
  'technical-workbench': technicalWorkbench,
  'mobile-command-center': mobileCommandCenter,
  custom: defaultCustomLayout,
});
