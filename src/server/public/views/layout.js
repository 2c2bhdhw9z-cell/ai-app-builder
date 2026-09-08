/*
 * views/layout.js — the Workspace_Experience layout view (spec Task 10.1;
 *  design §"Views — views/layout.js", Req 8.3, 8.4, 11.1; platform Req 27).
 *
 * A GENERIC REGION RENDERER. This view has NO opinion about which surface
 * belongs where: the ACTIVE Workspace_Experience's layout descriptor is the
 * SINGLE SOURCE OF TRUTH (Req 27.2). It builds one container per region named in
 * `descriptor.regions` (in that order) and places each visible surface into the
 * region the descriptor names for it, ordered by the descriptor's `order`. That
 * is what makes the five experiences GENUINELY different arrangements — and what
 * makes a persisted `custom` layout with arbitrary region names just work
 * (Req 27.4) without a code change here.
 *
 * The descriptor shape mirrors src/presentation/layouts.js:
 *   { id, name, regions:[...], orientation?, attribution?, surfaces: { <surface>: {
 *       region, visible, order, size?, collapsible?, collapsed?, emphasis? } } }
 *
 * Arrangement rules (all descriptor-driven):
 *   - REGIONS: `descriptor.regions` in declared order. The first region — or one
 *     literally named 'header' — is the PINNED top bar, so the Session_Header
 *     stays visible at every width, including 360px (Req 11.4). Every other
 *     region is a body region laid out by CSS (grid areas keyed off
 *     data-experience / data-regions / data-region).
 *   - VISIBILITY: `visible:false` renders the surface hidden (e.g. vibe-first's
 *     filePanel) — it stays mounted, so a later descriptor can show it again
 *     without rebuilding it.
 *   - COLLAPSE: `collapsible:true` gives the surface a real, user-operable
 *     toggle; `collapsed:true` renders it collapsed initially. A collapsed
 *     surface is ALWAYS still reachable — the toggle expands it. Collapse state
 *     is LOCAL view state (never a store dispatch), so operating it cannot touch
 *     Project data or any other setting.
 *   - SIZING: `size:'flex'|'auto'` marks how a surface grows inside its region
 *     (CSS reads data-size).
 *   - EMPHASIS: `emphasis:'primary'` (vibe-first's compose) marks the surface so
 *     CSS can foreground it (data-emphasis).
 *   - ATTRIBUTION: the honest, non-affiliated "inspired by" credit is rendered
 *     when the frame or the descriptor carries one (Req 8.4 / Req 27.8).
 *
 * LAYOUT ONLY (Req 8.3 / Req 27.3, design Property 24): re-arranging on a
 * workspace_experience frame MOVES the already-mounted surface elements between
 * region containers — it never rebuilds them and never dispatches anything — so
 * switching experiences preserves all surface state and changes nothing but
 * layout. The region containers themselves are reused across switches too.
 *
 * CSP hygiene (Req 1.4): every node is built with the DOM API — NO innerHTML, NO
 * inline handlers, NO inline <style>. All colors come from the palette-driven
 * `--color-*` custom properties via styles.css. The GEOMETRY of each experience
 * lives in styles.css, driven by the data attributes this view sets, so the SAME
 * shell collapses gracefully to one column on a phone. The pure arrangement
 * decision is factored into `layoutViewModel` so it is DOM-free testable.
 */

/** Stable DOM ids/classes so the shell is greppable and styleable. */
export const LAYOUT_DOM = Object.freeze({
  rootClass: 'shell',
  header: 'shell-header',
  body: 'shell-body',
  // The first two BODY regions of any descriptor are rendered into these two
  // stable slot elements (primary column + secondary panel), so the shell's
  // long-standing ids/classes keep meaning and the containers are reused across
  // experience switches. Any FURTHER region (e.g. the workbench's 'dock') gets
  // its own `shell-region-<name>` container, created on demand.
  main: 'shell-main',
  panel: 'shell-panel',
  attribution: 'shell-attribution',
  regionClass: 'shell__region',
  regionIdPrefix: 'shell-region-',
  surfaceClass: 'shell__surface',
  toggleClass: 'shell__collapse-toggle',
});

/** Human labels for the collapse toggles (client-authored, non-disclosing). */
export const SURFACE_LABELS = Object.freeze({
  sessionHeader: 'Session header',
  activityStream: 'Activity',
  compose: 'Compose',
  preview: 'Preview',
  filePanel: 'Files and tools',
});

/**
 * The default layout descriptor used before the GET /workspace-experience
 * bootstrap resolves (or when a frame carried none). This is a CLIENT-side
 * mirror of the kiro-style balanced arrangement (the documented default
 * DEFAULT_WORKSPACE_EXPERIENCE) — it carries ONLY layout data (surface
 * placement/visibility/order), never colors/theme/work-mode. The authoritative
 * descriptor always arrives on the workspace_experience frame; this is purely a
 * pre-bootstrap fallback. It is deliberately NOT an import of the backend
 * layouts module (the client is standalone same-origin assets); the shapes match
 * by contract.
 * @type {Readonly<object>}
 */
export const DEFAULT_LAYOUT = Object.freeze({
  id: 'kiro-style',
  name: 'Kiro-style Workspace',
  regions: Object.freeze(['header', 'left', 'right']),
  surfaces: Object.freeze({
    sessionHeader: Object.freeze({ region: 'header', visible: true, order: 0 }),
    activityStream: Object.freeze({ region: 'left', visible: true, order: 0, size: 'flex' }),
    compose: Object.freeze({ region: 'left', visible: true, order: 1, size: 'auto' }),
    filePanel: Object.freeze({
      region: 'left',
      visible: true,
      order: 2,
      size: 'auto',
      collapsible: true,
      collapsed: true,
    }),
    preview: Object.freeze({ region: 'right', visible: true, order: 0, size: 'flex' }),
  }),
});

/** A non-empty string, else null. */
function str(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Pure arrangement decision: given the workspace slice, decide the shell's
 * regions and which surfaces land in each, in what order, shown/hidden/collapsed
 * — the descriptor's arrangement, nothing else. Exported so a DOM-free test
 * asserts the layout-only arrangement (and that the five experiences really are
 * different) without a browser.
 *
 * @param {{ workspace: { experience: (string|null), layout: (object|null), attribution: (string|null) } }} state
 * @returns {{
 *   experience: string,
 *   orientation: 'vertical'|'horizontal',
 *   singleColumn: boolean,
 *   regionNames: string[],        // every region, in declared order
 *   headerRegion: (string|null),  // the pinned top-bar region (if any)
 *   bodyRegions: string[],        // the non-header regions, in declared order
 *   regions: Array<{ name: string, role: string, size: 'flex'|'auto',
 *                    surfaces: Array<{ name: string, order: number, size: 'flex'|'auto',
 *                                      visible: boolean, collapsible: boolean,
 *                                      collapsed: boolean, emphasis: (string|null) }> }>,
 *   placements: Record<string, { region: string, order: number, visible: boolean,
 *                               collapsible: boolean, collapsed: boolean,
 *                               size: 'flex'|'auto', emphasis: (string|null) }>,
 *   hidden: string[],             // surfaces the descriptor marks visible:false
 *   main: string[],               // ordered surfaces of the PRIMARY body region (legacy view)
 *   panel: string[],              // ordered surfaces of the SECONDARY body region (legacy view)
 *   header: boolean,
 *   attribution: (string|null),
 * }}
 */
export function layoutViewModel(state) {
  const ws = (state && state.workspace) || {};
  const descriptor = ws.layout && typeof ws.layout === 'object' ? ws.layout : DEFAULT_LAYOUT;
  const experience = str(ws.experience) || str(descriptor.id) || 'kiro-style';
  const orientation = descriptor.orientation === 'vertical' ? 'vertical' : 'horizontal';

  const surfaces =
    descriptor.surfaces && typeof descriptor.surfaces === 'object' ? descriptor.surfaces : {};

  // ---- the descriptor's regions, in declared order --------------------------
  const declared = Array.isArray(descriptor.regions)
    ? descriptor.regions.filter((r) => typeof r === 'string' && r !== '')
    : [];
  // A surface may name a region the descriptor forgot to declare; keep it
  // renderable by appending that region (the descriptor stays the only source of
  // truth — we never re-home a surface into some other region).
  const regionNames = declared.slice();
  for (const def of Object.values(surfaces)) {
    const region = def && str(def.region);
    if (region && !regionNames.includes(region)) regionNames.push(region);
  }

  // The pinned top bar. Two shapes, both descriptor-driven:
  //   - a region literally named 'header' IS the top bar (kiro-style, vibe-first,
  //     technical-workbench, custom): everything the descriptor puts there is
  //     rendered in the bar;
  //   - otherwise, when the Session_Header sits in the FIRST declared region
  //     together with other surfaces (the mobile command center's single
  //     'stack'), the Session_Header alone is PINNED to the bar and that region
  //     stays a body region for the rest. Either way the Session_Header — and so
  //     the active Work_Mode — is visible at every width, including 360px
  //     (Req 11.4, Req 28.4).
  const headerSurfaceRegion = surfaces.sessionHeader ? str(surfaces.sessionHeader.region) : null;
  const countIn = (regionName) =>
    Object.values(surfaces).filter((def) => def && str(def.region) === regionName).length;
  let headerRegion = regionNames.includes('header') ? 'header' : null;
  let pinnedSurfaces = [];
  if (headerRegion === null && headerSurfaceRegion !== null && headerSurfaceRegion === regionNames[0]) {
    // The first region holds the Session_Header: if that is ALL it holds, the
    // whole region is the top bar (whatever the user named it); if it also holds
    // other surfaces, only the Session_Header is pinned and the region keeps its
    // remaining surfaces in the body.
    if (countIn(headerSurfaceRegion) === 1) headerRegion = headerSurfaceRegion;
    else pinnedSurfaces = ['sessionHeader'];
  }
  const bodyRegions = regionNames.filter((r) => r !== headerRegion);

  // ---- placements: every surface the descriptor positions -------------------
  /** @type {Record<string, any>} */
  const placements = {};
  const hidden = [];
  for (const [name, def] of Object.entries(surfaces)) {
    if (!def || typeof def !== 'object') continue;
    const region = str(def.region) || regionNames[0] || 'main';
    const visible = def.visible !== false;
    const placement = {
      region,
      order: typeof def.order === 'number' ? def.order : 0,
      visible,
      collapsible: def.collapsible === true,
      collapsed: def.collapsible === true && def.collapsed === true,
      size: def.size === 'flex' ? 'flex' : 'auto',
      emphasis: str(def.emphasis),
    };
    placements[name] = placement;
    if (!visible) hidden.push(name);
  }

  // ---- one entry per region, its surfaces sorted by `order` ----------------
  // A surface pinned to the top bar is rendered there, not in its region's flow.
  const regions = regionNames.map((name) => {
    const inRegion = Object.entries(placements)
      .filter(([surface, p]) => p.region === name && !pinnedSurfaces.includes(surface))
      .map(([surface, p]) => ({ name: surface, ...p }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    const size = inRegion.some((s) => s.visible && s.size === 'flex') ? 'flex' : 'auto';
    let role = 'aux';
    if (name === headerRegion) role = 'header';
    else if (name === bodyRegions[0]) role = 'primary';
    else if (name === bodyRegions[1]) role = 'secondary';
    return { name, role, size, surfaces: inRegion };
  });

  // A single-column shell: the vertical/one-body-region descriptors (the mobile
  // command center) render as ONE touch column (Req 11.1).
  const singleColumn = orientation === 'vertical' || bodyRegions.length <= 1;

  // Legacy projection kept for the shell's two-slot contract (and the existing
  // mobile integration test): the visible surfaces of the primary body region vs
  // the secondary one. On a single-column shell everything is in the primary
  // column and nothing is left in a side panel.
  const visibleOf = (regionName) =>
    (regions.find((r) => r.name === regionName) || { surfaces: [] }).surfaces
      .filter((s) => s.visible && s.name !== 'sessionHeader')
      .map((s) => s.name);
  const main = [];
  for (const regionName of singleColumn ? bodyRegions : bodyRegions.slice(0, 1)) {
    main.push(...visibleOf(regionName));
  }
  const panel = singleColumn || bodyRegions.length < 2 ? [] : visibleOf(bodyRegions[1]);

  // The credit rides on the workspace slice (the frame carried it); the
  // descriptor's own `attribution` is the fallback so the Technical Workbench
  // always shows its honest, non-affiliated acknowledgement (Req 8.4, 27.8).
  const attribution = str(ws.attribution) || str(descriptor.attribution);

  return {
    experience,
    orientation,
    singleColumn,
    regionNames,
    headerRegion,
    pinnedSurfaces,
    bodyRegions,
    regions,
    placements,
    hidden,
    main,
    panel,
    header: true,
    attribution,
  };
}

/**
 * Create and mount the layout shell.
 *
 * The caller supplies the mounted surface views by name; this view OWNS their
 * placement (moving their `el` between region containers) but NEVER rebuilds
 * them, so switching experiences is a pure re-arrangement (Req 8.3 / 27.3). A
 * surface not supplied is simply skipped.
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

  // The pinned top bar region — ALWAYS visible, full-width, at 360px too
  // (Req 11.4). Which surface lives here is the descriptor's call.
  const header = doc.createElement('header');
  header.id = LAYOUT_DOM.header;
  header.className = `${LAYOUT_DOM.regionClass} shell__header`;

  // The body holds every non-header region container.
  const body = doc.createElement('div');
  body.id = LAYOUT_DOM.body;
  body.className = 'shell__body';

  // The two stable body slots (primary column + secondary panel) are created up
  // front and REUSED for whichever regions the active descriptor declares first
  // and second; further regions get their own container on demand. Reusing the
  // containers means an experience switch moves surfaces between elements that
  // already exist — no rebuild anywhere in the shell.
  const primarySlot = doc.createElement('div');
  primarySlot.id = LAYOUT_DOM.main;
  primarySlot.className = `${LAYOUT_DOM.regionClass} shell__main`;

  const secondarySlot = doc.createElement('aside');
  secondarySlot.id = LAYOUT_DOM.panel;
  secondarySlot.className = `${LAYOUT_DOM.regionClass} shell__panel`;

  body.append(primarySlot, secondarySlot);

  // The attribution credit line (Req 8.4 / 27.8), shown iff there is one.
  const attribution = doc.createElement('p');
  attribution.id = LAYOUT_DOM.attribution;
  attribution.className = 'shell__attribution';
  attribution.hidden = true;

  root.append(header, body, attribution);

  /** region name -> container element (extra regions beyond the two slots). */
  const extraRegions = new Map();
  /** surface name -> its persistent wrapper (created once, moved thereafter). */
  const wrappers = new Map();
  /** surface name -> user-operated collapse state (local view state only). */
  const userCollapsed = new Map();
  /** container element -> the surface sequence it currently holds (churn guard). */
  const arrangement = new Map();

  /** Resolve (creating on demand) the container element for a region. */
  function containerFor(regionVm) {
    if (regionVm.role === 'header') return header;
    if (regionVm.role === 'primary') return primarySlot;
    if (regionVm.role === 'secondary') return secondarySlot;
    let el = extraRegions.get(regionVm.name);
    if (!el) {
      el = doc.createElement('div');
      el.id = `${LAYOUT_DOM.regionIdPrefix}${regionVm.name}`;
      el.className = LAYOUT_DOM.regionClass;
      extraRegions.set(regionVm.name, el);
      body.append(el);
    }
    return el;
  }

  /**
   * The persistent wrapper for a surface: it carries the layout metadata (size,
   * emphasis, collapse) and the collapse toggle, and it is what gets MOVED
   * between regions. The surface's own element is appended once and never
   * re-parented away, so surface identity and state survive every switch.
   */
  function wrapperFor(name) {
    let entry = wrappers.get(name);
    if (entry) return entry;
    const view = surfaces[name];
    if (!view || !view.el) return null;

    const el = doc.createElement('div');
    el.className = LAYOUT_DOM.surfaceClass;
    el.setAttribute('data-surface', name);

    const toggle = doc.createElement('button');
    toggle.className = LAYOUT_DOM.toggleClass;
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('data-toggle', name);
    toggle.hidden = true;

    entry = { el, toggle, surfaceEl: view.el };
    // Toggling is LOCAL: it flips this view's collapse state and re-renders. It
    // dispatches nothing, so a collapse can never touch another slice.
    toggle.addEventListener('click', () => {
      const collapsed = el.getAttribute('data-collapsed') === 'true';
      userCollapsed.set(name, !collapsed);
      render();
    });

    el.append(toggle, view.el);
    wrappers.set(name, entry);
    return entry;
  }

  /** Label for a collapse toggle: "Expand Preview" / "Collapse Preview". */
  function toggleLabel(name, collapsed) {
    const label = SURFACE_LABELS[name] || name;
    return `${collapsed ? 'Expand' : 'Collapse'} ${label}`;
  }

  /** Apply the pure arrangement to the DOM. Idempotent full re-arrangement. */
  function render() {
    const vm = layoutViewModel(store.getState());

    // Expose the arrangement as data attributes so styles.css drives the real
    // geometry (grid areas per experience) with no inline style (Req 1.4), and
    // so the SAME shell collapses to one column on a phone.
    root.setAttribute('data-experience', vm.experience);
    root.setAttribute('data-orientation', vm.orientation);
    root.setAttribute('data-single-column', vm.singleColumn ? 'true' : 'false');
    root.setAttribute('data-regions', vm.regionNames.join(' '));
    body.setAttribute('data-regions', vm.bodyRegions.join(' '));

    /** Apply a surface's layout metadata (sizing / visibility / collapse). */
    function applySurface(surface) {
      const entry = wrapperFor(surface.name);
      if (!entry) return null;
      const collapsible = surface.collapsible;
      const collapsed = collapsible
        ? (userCollapsed.has(surface.name)
            ? userCollapsed.get(surface.name) === true
            : surface.collapsed)
        : false;

      entry.el.setAttribute('data-size', surface.size);
      entry.el.setAttribute('data-order', String(surface.order));
      entry.el.setAttribute('data-collapsible', collapsible ? 'true' : 'false');
      entry.el.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
      if (surface.emphasis) entry.el.setAttribute('data-emphasis', surface.emphasis);
      else entry.el.removeAttribute('data-emphasis');
      // visible:false hides the surface but keeps it mounted (Req 27.2).
      entry.el.hidden = !surface.visible;

      // A collapsible surface always keeps a user-operable toggle, so a collapsed
      // surface stays reachable.
      entry.toggle.hidden = !collapsible;
      if (collapsible) {
        entry.toggle.textContent = toggleLabel(surface.name, collapsed);
        entry.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      }
      // Collapsed hides the surface BODY only — the toggle stays visible.
      entry.surfaceEl.hidden = collapsed;
      return entry;
    }

    /**
     * Fill a container with the given surfaces, in order. Appending an attached
     * wrapper MOVES it (a node lives in one parent) — that IS the layout-only
     * re-arrangement. When the container already holds exactly this sequence,
     * nothing is touched at all, so a re-render is not DOM churn.
     */
    function fill(container, surfaceList) {
      const entries = [];
      for (const surface of surfaceList) {
        const entry = applySurface(surface);
        if (entry) entries.push({ name: surface.name, entry });
      }
      const key = entries.map((e) => e.name).join(',');
      if (arrangement.get(container) === key) return;
      for (const { entry } of entries) container.append(entry.el);
      arrangement.set(container, key);
    }

    const usedContainers = new Set();
    let bodyIndex = 0;

    // Whatever the descriptor pins to the top bar goes there first (Req 11.4).
    if (vm.pinnedSurfaces.length > 0) {
      usedContainers.add(header);
      // The bar is the shell's own 'header' slot here (the descriptor named no
      // header region — it pinned a surface into the first body region).
      header.setAttribute('data-region', 'header');
      header.setAttribute('data-role', 'header');
      header.hidden = false;
      fill(
        header,
        vm.pinnedSurfaces.map((name) => ({ name, ...vm.placements[name] })),
      );
    }

    for (const regionVm of vm.regions) {
      const container = containerFor(regionVm);
      usedContainers.add(container);
      container.setAttribute('data-region', regionVm.name);
      container.setAttribute('data-role', regionVm.role);
      container.setAttribute('data-size', regionVm.size);
      // The DECLARED order of the region, mirrored as a data attribute so CSS can
      // set `order` on the body regions. That keeps an arbitrary (persisted
      // `custom`, Req 27.4) region order correct in the one-column fallback even
      // though the containers are reused slots in the DOM.
      if (regionVm.role !== 'header') container.setAttribute('data-index', String(bodyIndex++));
      container.hidden = false;

      fill(container, regionVm.surfaces);
    }

    // Any container the ACTIVE descriptor does not use loses its layout role and
    // is hidden (it stays in the DOM so a switch back reuses it). The pinned top
    // bar is the exception: it is never hidden — a descriptor that keeps its
    // Session_Header inside a body region (the mobile stack) leaves the bar
    // EMPTY, and styles.css drops an empty bar out of the flow, so the header can
    // never be the thing that disappears (Req 11.4).
    for (const container of [primarySlot, secondarySlot, ...extraRegions.values()]) {
      if (usedContainers.has(container)) continue;
      container.removeAttribute('data-region');
      container.removeAttribute('data-index');
      container.setAttribute('data-role', 'unused');
      container.hidden = true;
      arrangement.set(container, '');
    }
    if (!usedContainers.has(header)) {
      header.setAttribute('data-role', 'header');
      header.hidden = false;
      arrangement.set(header, '');
    }

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
  // nothing else (theme/work-mode/session/project) is touched.
  const unsub = store.subscribe((s) => s.workspace, render);
  render();

  function destroy() {
    unsub();
    root.remove();
  }

  return { el: root, render, destroy };
}
