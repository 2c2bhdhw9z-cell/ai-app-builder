/*
 * views/layout.js — the Workspace_Experience layout view (spec Task 10.1;
 *  design §"Views — views/layout.js", Req 8.3, 8.4, 11.1).
 *
 * This is the CHAT-FIRST shell: a calm, single main column with a persistent
 * slim top header (the Session_Header), the conversation/activity feed and the
 * compose box front-and-centre, and the Preview as a SECONDARY panel that can
 * slide in beside (desktop) or below/behind (phone) the main column — not a
 * rigid two-column "pills" bar. It arranges the builder surfaces the client
 * already mounts (sessionHeader / activityStream / compose / preview / filePanel)
 * per the ACTIVE Workspace_Experience's layout descriptor, and re-arranges when
 * a workspace_experience frame changes the descriptor — LAYOUT ONLY (Req 8.3).
 * The surface NODES themselves (the mounted feature views) are unchanged when
 * the layout switches; only their placement/visibility/order changes.
 *
 * The descriptor shape mirrors src/presentation/layouts.js:
 *   { id, name, regions:[...], orientation?, surfaces: { <surface>: {
 *       region, visible, order, size?, collapsible?, collapsed?, emphasis? } } }
 *
 * The mapping to the chat-first shell is deliberately simple and responsive:
 *   - sessionHeader is ALWAYS pinned to the top bar, full width, at 360px too
 *     (Req 11.4), regardless of which region the descriptor nominally puts it in.
 *   - every OTHER visible surface is placed into the main column or the
 *     secondary (preview) panel based on the surface, ordered by the descriptor's
 *     `order`. The Preview surface is the secondary panel; everything else
 *     (compose, activityStream, filePanel) flows in the main conversation column.
 *   - the single-column mobile-command-center descriptor (orientation:'vertical',
 *     one 'stack' region) collapses the secondary panel INTO the main column so
 *     the whole shell is one touch-operable column at 360px (Req 11.1, 11.2).
 *   - an `attribution` credit on the frame is rendered in the shell (Req 8.4).
 *
 * CSP hygiene (Req 1.4): every node is built with the DOM API — NO innerHTML, NO
 * inline handlers, NO inline <style>. All colors come from the palette-driven
 * `--color-*` custom properties via styles.css. Responsiveness is expressed in
 * styles.css (CSS), driven by a `data-experience` / `data-orientation` attribute
 * this view sets, so the SAME layout collapses gracefully to one column on a
 * phone. The pure arrangement decision (which surface goes where, in what order,
 * shown or hidden) is factored into `layoutViewModel` so it is unit-testable
 * without a DOM.
 */

/** Stable DOM ids/classes so the shell is greppable and styleable. */
export const LAYOUT_DOM = Object.freeze({
  rootClass: 'shell',
  header: 'shell-header',
  body: 'shell-body',
  main: 'shell-main',
  panel: 'shell-panel',
  attribution: 'shell-attribution',
});

/**
 * The surfaces that live in the SECONDARY (preview) panel on a two-region shell.
 * Everything else flows in the main conversation column. Kept as data so the
 * arrangement rule is a single source of truth.
 * @type {ReadonlySet<string>}
 */
const SECONDARY_SURFACES = new Set(['preview']);

/**
 * The default layout descriptor used before the GET /workspace-experience
 * bootstrap resolves (or when a frame carried none). This is a CLIENT-side
 * mirror of the kiro-style balanced arrangement (the documented default
 * DEFAULT_WORKSPACE_EXPERIENCE) — it carries ONLY layout data (surface
 * placement/visibility/order), never colors/theme/work-mode. The authoritative
 * descriptor always arrives on the workspace_experience frame; this is purely a
 * pre-bootstrap fallback so the shell renders a sensible chat-first arrangement
 * immediately. It is deliberately NOT an import of the backend layouts module
 * (the client is standalone same-origin assets); the shapes match by contract.
 * @type {Readonly<object>}
 */
export const DEFAULT_LAYOUT = Object.freeze({
  id: 'kiro-style',
  name: 'Kiro-style Workspace',
  regions: ['header', 'main', 'panel'],
  surfaces: Object.freeze({
    sessionHeader: Object.freeze({ region: 'header', visible: true, order: 0 }),
    activityStream: Object.freeze({ region: 'main', visible: true, order: 0, size: 'flex' }),
    compose: Object.freeze({ region: 'main', visible: true, order: 1, size: 'auto' }),
    preview: Object.freeze({ region: 'panel', visible: true, order: 0, size: 'flex' }),
    filePanel: Object.freeze({ region: 'main', visible: true, order: 2, size: 'auto', collapsible: true, collapsed: true }),
  }),
});

/**
 * Pure arrangement decision: given the workspace slice, decide the shell's
 * placement. Exported so a DOM-free test asserts the layout-only arrangement
 * (which surfaces go to the main column vs. the secondary panel, in what order,
 * whether the shell is single-column, and the attribution) without a browser.
 *
 * @param {{ workspace: { experience: (string|null), layout: (object|null), attribution: (string|null) } }} state
 * @returns {{
 *   experience: string,
 *   orientation: 'vertical'|'horizontal',
 *   singleColumn: boolean,
 *   main: string[],          // ordered surface ids for the main column (excl. header)
 *   panel: string[],         // ordered surface ids for the secondary panel
 *   header: boolean,         // whether the session header is shown (always true)
 *   attribution: (string|null),
 * }}
 */
export function layoutViewModel(state) {
  const ws = (state && state.workspace) || {};
  const descriptor = ws.layout && typeof ws.layout === 'object' ? ws.layout : DEFAULT_LAYOUT;
  const experience = typeof ws.experience === 'string' ? ws.experience : descriptor.id || 'kiro-style';
  const orientation = descriptor.orientation === 'vertical' ? 'vertical' : 'horizontal';
  // A single-column shell (mobile-command-center, or any vertical/one-region
  // descriptor) folds the secondary panel into the main column (Req 11.1).
  const singleColumn = orientation === 'vertical' || experience === 'mobile-command-center';

  const surfaces = descriptor.surfaces && typeof descriptor.surfaces === 'object' ? descriptor.surfaces : {};

  // Collect visible non-header surfaces with their order, then sort ascending.
  const visible = [];
  for (const [name, def] of Object.entries(surfaces)) {
    if (name === 'sessionHeader') continue; // header is pinned to the top bar
    if (!def || def.visible === false) continue;
    visible.push({ name, order: typeof def.order === 'number' ? def.order : 0 });
  }
  visible.sort((a, b) => a.order - b.order);

  const main = [];
  const panel = [];
  for (const { name } of visible) {
    if (!singleColumn && SECONDARY_SURFACES.has(name)) panel.push(name);
    else main.push(name);
  }

  // Attribution rides on the workspace slice (frame carried it); shown iff
  // non-empty (Req 8.4).
  const attribution =
    typeof ws.attribution === 'string' && ws.attribution !== '' ? ws.attribution : null;

  return {
    experience,
    orientation,
    singleColumn,
    main,
    panel,
    header: true,
    attribution,
  };
}

/**
 * Create and mount the chat-first layout shell.
 *
 * The caller supplies the mounted surface views by name; this view OWNS their
 * placement (moving their `el` between the main column and the secondary panel)
 * but never rebuilds them, so switching experiences is a pure re-arrangement
 * (Req 8.3). A surface not supplied is simply skipped.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {{ getState: Function, subscribe: Function }} opts.store
 * @param {Record<string, { el: HTMLElement }>} opts.surfaces
 *   the mounted surface views keyed by surface id: `sessionHeader`,
 *   `activityStream`, `compose`, `preview`, `filePanel`.
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createLayoutView({ doc, store, surfaces = {} }) {
  const root = doc.createElement('section');
  root.className = LAYOUT_DOM.rootClass;
  root.setAttribute('aria-label', 'Builder workspace');

  // The pinned top bar (Session_Header) — ALWAYS visible, full-width, at 360px
  // too (Req 11.4). The header surface's el is placed here once.
  const header = doc.createElement('header');
  header.id = LAYOUT_DOM.header;
  header.className = 'shell__header';
  if (surfaces.sessionHeader && surfaces.sessionHeader.el) {
    header.append(surfaces.sessionHeader.el);
  }

  // The body holds the main conversation column and the secondary preview panel.
  const body = doc.createElement('div');
  body.id = LAYOUT_DOM.body;
  body.className = 'shell__body';

  const main = doc.createElement('div');
  main.id = LAYOUT_DOM.main;
  main.className = 'shell__main';
  main.setAttribute('aria-label', 'Conversation');

  const panel = doc.createElement('aside');
  panel.id = LAYOUT_DOM.panel;
  panel.className = 'shell__panel';
  panel.setAttribute('aria-label', 'Preview');

  body.append(main, panel);

  // The attribution credit line (Req 8.4), shown iff the frame carried one.
  const attribution = doc.createElement('p');
  attribution.id = LAYOUT_DOM.attribution;
  attribution.className = 'shell__attribution';
  attribution.hidden = true;

  root.append(header, body, attribution);

  /**
   * Place a surface's element into `parent` in the given order slot. Because a
   * node can only live in one parent, appending it moves it — which is exactly
   * the layout-only re-arrangement we want (the view is never rebuilt).
   */
  function place(parent, name) {
    const view = surfaces[name];
    if (view && view.el) parent.append(view.el);
  }

  /** Apply the pure arrangement to the DOM. Idempotent full re-arrangement. */
  function render() {
    const vm = layoutViewModel(store.getState());

    // Expose the experience + orientation as data attributes so styles.css can
    // drive the responsive collapse without any inline style (Req 1.4). The
    // SAME layout collapses to one column on a phone via CSS media queries.
    root.setAttribute('data-experience', vm.experience);
    root.setAttribute('data-orientation', vm.orientation);
    root.setAttribute('data-single-column', vm.singleColumn ? 'true' : 'false');

    // Re-arrange the main column in descriptor order.
    for (const name of vm.main) place(main, name);
    // Re-arrange the secondary panel; hide it entirely when single-column so the
    // shell is one touch-operable column (Req 11.1) with no empty aside.
    for (const name of vm.panel) place(panel, name);
    panel.hidden = vm.singleColumn || vm.panel.length === 0;

    if (vm.attribution) {
      attribution.textContent = vm.attribution;
      attribution.hidden = false;
    } else {
      attribution.textContent = '';
      attribution.hidden = true;
    }
  }

  // Re-arrange whenever the workspace layout slice changes (Req 8.3). Selecting
  // an experience changes only this slice, so the surfaces re-arrange and
  // nothing else (theme/work-mode/session) is touched.
  const unsub = store.subscribe((s) => s.workspace, render);
  render();

  function destroy() {
    unsub();
    root.remove();
  }

  return { el: root, render, destroy };
}
