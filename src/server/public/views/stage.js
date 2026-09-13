/**
 * stage.js — THE SHELL. Replaces the region-grid layout renderer.
 *
 * WHAT CHANGED AND WHY
 * The old shell (`views/layout.js`) rendered a grid of named regions and let the
 * backend's layout descriptor decide which region each surface lived in. Every
 * experience was a different arrangement of the same four boxes: header strip,
 * conversation column, preview panel, dock. That is the layout every AI builder
 * ships, and restyling it does not change what it is.
 *
 * The Stage is a different structure, not a different skin:
 *
 *   ┌──────────────────────────────────────────┐
 *   │  HUD (floating chips over the canvas)    │
 *   │                                          │
 *   │            C A N V A S                   │  the running app, full bleed.
 *   │        (the app you are building)        │  it IS the interface.
 *   │                                          │
 *   ├──────────────────────────────────────────┤
 *   │ ▁▁▁ grip                                 │
 *   │ status peek                              │  the SHEET. three detents.
 *   │ [voice] [chip] [chip] [chip]             │  agent lives here, one drag away.
 *   │ compose ................. [mic] [send]   │
 *   └──────────────────────────────────────────┘
 *
 * Three structural consequences:
 *
 *  1. THE APP OWNS THE SCREEN. The preview is not a side panel beside a
 *     transcript; it is the whole canvas. The agent is an overlay on your app,
 *     not a chat window your app is docked into.
 *  2. THE AGENT IS PROGRESSIVE. At `peek` you see one status line plus the
 *     compose row. At `half` you get recent activity. At `full` you get the whole
 *     stream, diffs and confirmations. You only pay attention when you want to.
 *  3. INPUT IS NOT A SHRUNKEN TEXTAREA. A voice affordance and a row of
 *     context-aware one-tap chips sit above the input, because typing a paragraph
 *     on a phone is miserable and most turns are short.
 *
 * The backend layout descriptor no longer decides geometry. It still decides
 * which surfaces are VISIBLE, and the experience id tunes the opening detent and
 * the density — but surfaces are placed by identity into fixed slots, so there is
 * exactly ONE structure with five configurations rather than five layouts.
 * No backend change: no endpoint, frame type, or descriptor is modified.
 *
 * CSP: every node is built with the DOM API. No innerHTML, no inline handlers,
 * no inline <style> (Req 1.4).
 */

export const STAGE_DOM = Object.freeze({
  rootClass: 'stage',
  canvasClass: 'stage__canvas',
  hudClass: 'stage__hud',
  sheetClass: 'sheet',
  gripClass: 'sheet__grip',
  peekClass: 'sheet__peek',
  chipsClass: 'sheet__chips',
  composeClass: 'sheet__compose',
  scrollClass: 'sheet__scroll',
  canvasId: 'stage-canvas',
  hudId: 'stage-hud',
  sheetId: 'stage-sheet',
});

/** The three sheet detents, smallest first. */
export const DETENTS = Object.freeze(['peek', 'half', 'full']);

/**
 * Which slot each surface belongs to. This is the structural decision the old
 * shell delegated to the backend descriptor and the Stage now owns: the preview
 * IS the canvas, the header IS the hud, everything conversational is IN the sheet.
 */
export const SLOT_OF_SURFACE = Object.freeze({
  preview: 'canvas',
  sessionHeader: 'hud',
  compose: 'compose',
  activityStream: 'scroll',
  confirm: 'scroll',
  filePanel: 'scroll',
});

/** Opening detent per experience. The experience tunes, it does not rearrange. */
export const OPENING_DETENT = Object.freeze({
  'kiro-style': 'half',
  'vibe-first': 'half',
  'technical-workbench': 'full',
  'mobile-command-center': 'peek',
  custom: 'half',
});

/** Fallback one-tap suggestions before the session has produced any context. */
export const DEFAULT_CHIPS = Object.freeze(['Undo last change', 'Explain this', 'Deploy']);

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Derive the Stage's render inputs from store state. Pure and DOM-free so it is
 * unit-testable without a document.
 *
 * @param {object} state
 * @returns {{
 *   experience: string, detent: string, visible: Record<string,boolean>,
 *   status: string, chips: string[], running: boolean,
 * }}
 */
export function stageViewModel(state) {
  const s = state && typeof state === 'object' ? state : {};
  const ws = s.workspace && typeof s.workspace === 'object' ? s.workspace : {};
  const experience = str(ws.experience) || 'kiro-style';

  const layout = ws.layout && typeof ws.layout === 'object' ? ws.layout : {};
  const surfaces = layout.surfaces && typeof layout.surfaces === 'object' ? layout.surfaces : {};
  const visible = {};
  for (const name of Object.keys(SLOT_OF_SURFACE)) {
    const entry = surfaces[name];
    // Absent from the descriptor => visible. The descriptor hides, it never has
    // to enumerate everything.
    visible[name] = !entry || entry.visible !== false;
  }

  // The sheet detent is client-only UI state, never a backend concern.
  const ui = s.stage && typeof s.stage === 'object' ? s.stage : {};
  const detent = DETENTS.includes(ui.detent) ? ui.detent : OPENING_DETENT[experience] || 'half';

  const session = s.session && typeof s.session === 'object' ? s.session : {};
  const running = session.submitInFlight === true;

  const preview = s.preview && typeof s.preview === 'object' ? s.preview : {};
  const previewStatus = str(preview.status);
  const status = running
    ? 'Working…'
    : previewStatus === 'ready'
      ? 'Preview ready'
      : previewStatus
        ? previewStatus.replace(/_/g, ' ')
        : 'Idle';

  const chips = Array.isArray(ui.chips) && ui.chips.length > 0 ? ui.chips.slice(0, 4) : [...DEFAULT_CHIPS];

  return { experience, detent, visible, status, chips, running };
}

/**
 * Create the Stage view.
 *
 * @param {object} deps
 * @param {Document} deps.doc
 * @param {{ getState: Function, subscribe?: Function, dispatch?: Function }} deps.store
 * @param {Record<string, { el: HTMLElement }>} [deps.surfaces]
 *   the mounted feature views, keyed by surface name (preview, compose, ...).
 * @param {(text: string) => void} [deps.onChip]  invoked when a chip is tapped.
 * @returns {{ el: HTMLElement, destroy: Function, setDetent: Function }}
 */
export function createStageView({ doc, store, surfaces = {}, onChip } = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createStageView requires a document');
  }

  const root = doc.createElement('div');
  root.className = STAGE_DOM.rootClass;

  // ---- the canvas: the running app, full bleed. The hero. ----
  const canvas = doc.createElement('div');
  canvas.className = STAGE_DOM.canvasClass;
  canvas.id = STAGE_DOM.canvasId;
  root.appendChild(canvas);

  // ---- the hud: small floating chips over the canvas ----
  const hud = doc.createElement('div');
  hud.className = STAGE_DOM.hudClass;
  hud.id = STAGE_DOM.hudId;
  root.appendChild(hud);

  // ---- the sheet ----
  const sheet = doc.createElement('section');
  sheet.className = STAGE_DOM.sheetClass;
  sheet.id = STAGE_DOM.sheetId;
  sheet.setAttribute('aria-label', 'Agent');

  // The grip is a real button, so the sheet is operable without a drag gesture
  // (keyboard, screen reader, and anyone who just wants to tap).
  const grip = doc.createElement('button');
  grip.className = STAGE_DOM.gripClass;
  grip.type = 'button';
  grip.setAttribute('aria-label', 'Expand or collapse the agent panel');
  grip.setAttribute('aria-expanded', 'false');
  sheet.appendChild(grip);

  const peek = doc.createElement('p');
  peek.className = STAGE_DOM.peekClass;
  sheet.appendChild(peek);

  // The scroll region holds everything conversational. Above the compose row in
  // the DOM so the compose row stays pinned at the bottom in thumb reach.
  const scroll = doc.createElement('div');
  scroll.className = STAGE_DOM.scrollClass;
  sheet.appendChild(scroll);

  const chipsRow = doc.createElement('div');
  chipsRow.className = STAGE_DOM.chipsClass;
  chipsRow.setAttribute('role', 'group');
  chipsRow.setAttribute('aria-label', 'Suggested actions');
  sheet.appendChild(chipsRow);

  const compose = doc.createElement('div');
  compose.className = STAGE_DOM.composeClass;
  sheet.appendChild(compose);

  root.appendChild(sheet);

  const slots = { canvas, hud, scroll, compose };

  // ---- place the mounted surfaces into their slots, by identity ----
  for (const [name, slot] of Object.entries(SLOT_OF_SURFACE)) {
    const view = surfaces[name];
    const el = view && view.el ? view.el : null;
    if (!el) continue;
    el.setAttribute('data-surface', name);
    slots[slot].appendChild(el);
  }

  /** Cycle to the next detent, wrapping at the top. */
  function cycleDetent() {
    const current = sheet.getAttribute('data-detent') || 'half';
    const next = DETENTS[(DETENTS.indexOf(current) + 1) % DETENTS.length];
    setDetent(next);
  }

  function setDetent(detent) {
    const value = DETENTS.includes(detent) ? detent : 'half';
    sheet.setAttribute('data-detent', value);
    grip.setAttribute('aria-expanded', value === 'peek' ? 'false' : 'true');
    if (store && typeof store.dispatch === 'function') {
      // Client-only UI state. Deliberately not sent anywhere.
      store.dispatch({ type: 'stage/detent', detent: value });
    }
  }

  grip.addEventListener('click', cycleDetent);

  // A real vertical drag on the grip, with a click fallback above. Pointer
  // events cover touch and mouse in one path.
  let dragFrom = null;
  function onPointerDown(event) {
    dragFrom = typeof event.clientY === 'number' ? event.clientY : null;
  }
  function onPointerUp(event) {
    if (dragFrom === null) return;
    const dy = (typeof event.clientY === 'number' ? event.clientY : dragFrom) - dragFrom;
    dragFrom = null;
    if (Math.abs(dy) < 24) return; // a tap; the click handler owns it
    const current = sheet.getAttribute('data-detent') || 'half';
    const index = DETENTS.indexOf(current);
    // Drag UP grows the sheet, drag DOWN shrinks it.
    const next = dy < 0 ? Math.min(index + 1, DETENTS.length - 1) : Math.max(index - 1, 0);
    setDetent(DETENTS[next]);
  }
  grip.addEventListener('pointerdown', onPointerDown);
  grip.addEventListener('pointerup', onPointerUp);

  let chipButtons = [];
  function renderChips(labels) {
    const same =
      chipButtons.length === labels.length &&
      chipButtons.every((b, i) => b.textContent === labels[i]);
    if (same) return;
    for (const b of chipButtons) b.remove();
    chipButtons = labels.map((label) => {
      const b = doc.createElement('button');
      b.className = 'sheet__chip';
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        if (typeof onChip === 'function') onChip(label);
      });
      chipsRow.appendChild(b);
      return b;
    });
  }

  // The voice affordance leads the chip row: it is the primary input on a phone.
  const voice = doc.createElement('button');
  voice.className = 'sheet__chip sheet__chip--voice';
  voice.type = 'button';
  voice.textContent = 'Hold to talk';
  voice.setAttribute('aria-label', 'Hold to talk');
  chipsRow.appendChild(voice);

  function render() {
    const vm = stageViewModel(store && typeof store.getState === 'function' ? store.getState() : {});
    root.setAttribute('data-experience', vm.experience);
    root.setAttribute('data-running', vm.running ? 'true' : 'false');
    if (sheet.getAttribute('data-detent') === null) {
      sheet.setAttribute('data-detent', vm.detent);
      grip.setAttribute('aria-expanded', vm.detent === 'peek' ? 'false' : 'true');
    }
    peek.textContent = vm.status;
    renderChips(vm.chips);
    for (const [name, slot] of Object.entries(SLOT_OF_SURFACE)) {
      const view = surfaces[name];
      if (!view || !view.el) continue;
      view.el.hidden = vm.visible[name] === false;
      void slot;
    }
  }

  render();

  let unsubscribe = null;
  if (store && typeof store.subscribe === 'function') {
    unsubscribe = store.subscribe((s) => s, render);
  }

  return {
    el: root,
    setDetent,
    destroy() {
      if (typeof unsubscribe === 'function') unsubscribe();
      grip.removeEventListener('click', cycleDetent);
      grip.removeEventListener('pointerdown', onPointerDown);
      grip.removeEventListener('pointerup', onPointerUp);
      root.remove();
    },
  };
}
