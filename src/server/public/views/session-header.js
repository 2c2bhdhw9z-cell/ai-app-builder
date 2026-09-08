/*
 * views/session-header.js — the Session_Header view (spec Task 12.1; design
 *  §"Views — views/session-header.js", Req 10.1–10.5, 11.3, 11.4).
 *
 * The slim, clean, ALWAYS-visible top bar of the chat-first shell. It shows:
 *   - the product/brand mark on the left (calm, minimal);
 *   - the active Work_Mode + a touch-sized switch control among the offered
 *     choices (vibe / spec / hybrid) → controller.switchMode(mode) (Req 10.1,
 *     10.3, 10.4, 11.3);
 *   - the current Workspace_Experience and Theme as compact, non-interactive
 *     status text (Req 10.1 header context / design "current experience + theme")
 *     so the header always communicates where the user is.
 *
 * It is ALWAYS visible — including at a 360px phone width — and the Work_Mode
 * stays visible there (Req 11.4); the responsive collapse (labels shortening,
 * wrapping) is expressed in styles.css, not here. New sessions display `vibe`
 * until a differing frame arrives (Req 10.5), which is the store default this
 * view simply reflects.
 *
 * It holds NO business logic: the mode option set, the POST /work-mode call, and
 * the frame application all live in work-mode.js. This module builds nodes and
 * forwards the switch intent, reading the store's workMode / workspace / theme
 * slices for display.
 *
 * CSP hygiene (Req 1.4): every node is built with the DOM API — NO innerHTML, NO
 * inline handlers, NO inline <style>. All colors come from the palette-driven
 * `--color-*` custom properties via styles.css. The pure display decision is
 * factored into `sessionHeaderViewModel` for DOM-free testing.
 */

import { WORK_MODE_OPTIONS, WORK_MODE_LABELS } from '../work-mode.js';
import { EXPERIENCE_LABELS } from '../workspace.js';
import { THEME_LABELS } from '../theme.js';

/** Stable DOM ids/classes so the header is greppable and styleable. */
export const SESSION_HEADER_DOM = Object.freeze({
  rootClass: 'session-header',
  brand: 'session-header-brand',
  modeGroup: 'session-header-modes',
  modeButtonPrefix: 'session-header-mode-',
  experience: 'session-header-experience',
  theme: 'session-header-theme',
  context: 'session-header-context',
});

/** The brand mark shown at the left of the header. Presentation only. */
export const HEADER_BRAND = 'AI App Builder';

/**
 * Pure display decision for the header: the active mode, the offered choices,
 * and the compact experience/theme context labels. Exported so a DOM-free test
 * asserts the displayed mode + choices (Req 10.2) without a browser.
 *
 * @param {{ workMode: { active: string, choices: string[] }, workspace: { experience: (string|null) }, theme: { committedTheme: (string|null), previewedTheme: (string|null) } }} state
 * @returns {{
 *   active: string,
 *   choices: string[],
 *   experience: (string|null),
 *   experienceLabel: (string|null),
 *   theme: (string|null),
 *   themeLabel: (string|null),
 * }}
 */
export function sessionHeaderViewModel(state) {
  const wm = (state && state.workMode) || {};
  const ws = (state && state.workspace) || {};
  const th = (state && state.theme) || {};
  const active = typeof wm.active === 'string' ? wm.active : 'vibe';
  // The offered choices come from the frame (Req 10.2); fall back to the closed
  // Work_Mode set so the switch always renders the three options (Req 10.3).
  const choices =
    Array.isArray(wm.choices) && wm.choices.length > 0 ? wm.choices.slice() : WORK_MODE_OPTIONS.slice();
  const experience = typeof ws.experience === 'string' ? ws.experience : null;
  // Show the previewed theme while previewing so the header reflects the surface
  // the user currently sees, else the committed theme.
  const theme =
    typeof th.previewedTheme === 'string'
      ? th.previewedTheme
      : typeof th.committedTheme === 'string'
        ? th.committedTheme
        : null;
  return {
    active,
    choices,
    experience,
    experienceLabel: experience ? EXPERIENCE_LABELS[experience] ?? experience : null,
    theme,
    themeLabel: theme ? THEME_LABELS[theme] ?? theme : null,
  };
}

/**
 * Create and mount the Session_Header view.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {{ getState: Function, subscribe: Function }} opts.store
 * @param {{ switchMode: Function }} opts.controller  the work-mode controller (Task 12.1)
 * @param {{ el: HTMLElement }} [opts.controls]  an optional controls view (the
 *   experience + theme selectors, views/workspace-controls.js) embedded in the
 *   header's right-hand context region so the slim bar carries the layout/theme
 *   pickers alongside the mode switch.
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createSessionHeaderView({ doc, store, controller, controls }) {
  const root = doc.createElement('header');
  root.className = SESSION_HEADER_DOM.rootClass;
  root.setAttribute('aria-label', 'Session');

  // Brand mark (left).
  const brand = doc.createElement('span');
  brand.id = SESSION_HEADER_DOM.brand;
  brand.className = 'session-header__brand';
  brand.textContent = HEADER_BRAND;

  // The Work_Mode switch group (center) — a radiogroup of touch-sized buttons,
  // one per offered choice. The active one is pressed. Rebuilt when the offered
  // choices change (rare) so the control always matches the frame (Req 10.2).
  const modeGroup = doc.createElement('div');
  modeGroup.id = SESSION_HEADER_DOM.modeGroup;
  modeGroup.className = 'session-header__modes';
  modeGroup.setAttribute('role', 'radiogroup');
  modeGroup.setAttribute('aria-label', 'Work mode');

  // The experience + theme context (right).
  const context = doc.createElement('div');
  context.id = SESSION_HEADER_DOM.context;
  context.className = 'session-header__context';

  const experience = doc.createElement('span');
  experience.id = SESSION_HEADER_DOM.experience;
  experience.className = 'session-header__experience';
  experience.hidden = true;

  const theme = doc.createElement('span');
  theme.id = SESSION_HEADER_DOM.theme;
  theme.className = 'session-header__theme';
  theme.hidden = true;

  context.append(experience, theme);
  // Embed the optional experience + theme controls into the header's context
  // region so the slim bar carries the layout/theme pickers next to the mode
  // switch. The controls view owns its own subscriptions/teardown.
  if (controls && controls.el) context.append(controls.el);
  root.append(brand, modeGroup, context);

  /** The current set of rendered mode-button choices, to detect changes. */
  let renderedChoices = [];
  /** Map of mode → button element, so render() can toggle the pressed state. */
  const modeButtons = new Map();

  function onModeClick(mode) {
    return () => {
      if (controller && typeof controller.switchMode === 'function') {
        void controller.switchMode(mode);
      }
    };
  }

  /** (Re)build the mode buttons for a given choice set. */
  function buildModeButtons(choices) {
    // Tear down old listeners/buttons.
    for (const btn of modeButtons.values()) {
      if (btn._onClick) btn.removeEventListener('click', btn._onClick);
    }
    modeButtons.clear();
    modeGroup.replaceChildren();

    for (const mode of choices) {
      const btn = doc.createElement('button');
      btn.id = `${SESSION_HEADER_DOM.modeButtonPrefix}${mode}`;
      btn.className = 'session-header__mode';
      btn.setAttribute('type', 'button');
      btn.setAttribute('role', 'radio');
      btn.setAttribute('data-mode', mode);
      btn.textContent = WORK_MODE_LABELS[mode] ?? mode;
      const handler = onModeClick(mode);
      btn._onClick = handler;
      btn.addEventListener('click', handler);
      modeButtons.set(mode, btn);
      modeGroup.append(btn);
    }
    renderedChoices = choices.slice();
  }

  /** Apply the pure view-model to the DOM. Idempotent. */
  function render() {
    const vm = sessionHeaderViewModel(store.getState());

    // Rebuild the buttons only when the offered choices actually change.
    if (
      vm.choices.length !== renderedChoices.length ||
      vm.choices.some((c, i) => c !== renderedChoices[i])
    ) {
      buildModeButtons(vm.choices);
    }

    // Reflect the active mode as the pressed/checked radio (Req 10.1).
    for (const [mode, btn] of modeButtons) {
      const isActive = mode === vm.active;
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
      if (isActive) btn.setAttribute('data-active', 'true');
      else btn.removeAttribute('data-active');
    }

    // Compact experience + theme context (always visible when known).
    if (vm.experienceLabel) {
      experience.textContent = vm.experienceLabel;
      experience.hidden = false;
    } else {
      experience.textContent = '';
      experience.hidden = true;
    }
    if (vm.themeLabel) {
      theme.textContent = vm.themeLabel;
      theme.hidden = false;
    } else {
      theme.textContent = '';
      theme.hidden = true;
    }
  }

  // Re-render whenever the workMode, workspace, or theme slices change so the
  // header always reflects the active mode + current experience/theme.
  const unsubMode = store.subscribe((s) => s.workMode, render);
  const unsubWorkspace = store.subscribe((s) => s.workspace, render);
  const unsubTheme = store.subscribe((s) => s.theme, render);
  render();

  function destroy() {
    unsubMode();
    unsubWorkspace();
    unsubTheme();
    for (const btn of modeButtons.values()) {
      if (btn._onClick) btn.removeEventListener('click', btn._onClick);
    }
    root.remove();
  }

  return { el: root, render, destroy };
}
