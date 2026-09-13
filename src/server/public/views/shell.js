/**
 * shell.js — the INTERIM shell.
 *
 * ┌─ READ THIS BEFORE EXTENDING ────────────────────────────────────────────┐
 * │ This is deliberately minimal and deliberately temporary. It is NOT the   │
 * │ designed interface.                                                     │
 * │                                                                         │
 * │ The real interface is three SURFACES over one shared project — Vibe,     │
 * │ IDE, and Preview — selected by a mode router. See                        │
 * │ `.kiro/specs/ui-redesign/PLAN.md` §3 and task 1.1 in that spec's         │
 * │ tasks.md. Do not grow this file into a layout system; replace it.        │
 * │                                                                         │
 * │ Two earlier shells were deleted rather than evolved, because both        │
 * │ encoded the wrong model:                                                │
 * │   - `views/layout.js`  a grid of named regions fed by backend layout     │
 * │                        descriptors. Five "experiences" were five         │
 * │                        rearrangements of the same four boxes.            │
 * │   - `views/stage.js`   a full-bleed canvas with the agent in a bottom    │
 * │                        sheet. Better, but still ONE screen with the      │
 * │                        preview pinned beside the agent, which is exactly │
 * │                        what the rewrite is meant to stop doing.          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * What this file is FOR: keeping the client mountable and the suite honest while the
 * real surfaces are built. It stacks the existing feature views in one column and
 * carries the invariants inherited from three deleted tests — no horizontal overflow
 * at 360px, touch-sized controls, palette-driven colour, CSP cleanliness. Those
 * invariants must move to the real surfaces, not be dropped with this file.
 *
 * CSP: every node is built with the DOM API. No inline handlers, no inline style.
 */

export const SHELL_DOM = Object.freeze({
  rootClass: 'shell',
  mainClass: 'shell__main',
  stackClass: 'shell__stack',
  slotClass: 'shell__slot',
  rootId: 'shell-root',
});

/**
 * The surfaces this interim shell stacks, in render order. Identity-keyed: the
 * backend layout descriptor no longer decides placement.
 */
export const STACK_ORDER = Object.freeze([
  'sessionHeader',
  'activityStream',
  'confirm',
  'compose',
  'preview',
  'filePanel',
]);

/**
 * Which surfaces the descriptor has hidden. Pure and DOM-free.
 *
 * A descriptor may HIDE a surface; it never has to enumerate them all, so anything
 * unmentioned is visible.
 *
 * @param {object} state
 * @returns {{ visible: Record<string, boolean> }}
 */
export function shellViewModel(state) {
  const s = state && typeof state === 'object' ? state : {};
  const ws = s.workspace && typeof s.workspace === 'object' ? s.workspace : {};
  const layout = ws.layout && typeof ws.layout === 'object' ? ws.layout : {};
  const surfaces = layout.surfaces && typeof layout.surfaces === 'object' ? layout.surfaces : {};
  const visible = {};
  for (const name of STACK_ORDER) {
    const entry = surfaces[name];
    visible[name] = !entry || entry.visible !== false;
  }
  return { visible };
}

/**
 * Create the interim shell view.
 *
 * @param {object} deps
 * @param {Document} deps.doc
 * @param {{ getState: Function, subscribe?: Function }} deps.store
 * @param {Record<string, { el: HTMLElement }>} [deps.surfaces]
 * @returns {{ el: HTMLElement, destroy: Function }}
 */
export function createShellView({ doc, store, surfaces = {} } = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createShellView requires a document');
  }

  const root = doc.createElement('div');
  root.className = SHELL_DOM.rootClass;
  root.id = SHELL_DOM.rootId;

  const main = doc.createElement('div');
  main.className = SHELL_DOM.mainClass;
  root.appendChild(main);

  const stack = doc.createElement('div');
  stack.className = SHELL_DOM.stackClass;
  main.appendChild(stack);

  const mounted = [];
  for (const name of STACK_ORDER) {
    const view = surfaces[name];
    const el = view && view.el ? view.el : null;
    if (!el) continue;
    const slot = doc.createElement('div');
    slot.className = SHELL_DOM.slotClass;
    slot.setAttribute('data-surface', name);
    slot.appendChild(el);
    stack.appendChild(slot);
    mounted.push({ name, slot });
  }

  function render() {
    const { visible } = shellViewModel(
      store && typeof store.getState === 'function' ? store.getState() : {},
    );
    for (const { name, slot } of mounted) slot.hidden = visible[name] === false;
  }

  render();

  let unsubscribe = null;
  if (store && typeof store.subscribe === 'function') {
    unsubscribe = store.subscribe((s) => s, render);
  }

  return {
    el: root,
    destroy() {
      if (typeof unsubscribe === 'function') unsubscribe();
      root.remove();
    },
  };
}
