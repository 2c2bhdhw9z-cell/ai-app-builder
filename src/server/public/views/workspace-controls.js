/*
 * views/workspace-controls.js — the Workspace_Experience selector + the Theme
 *  catalog control (spec Tasks 10.1 & 11.1; design §"Views", Req 8.1, 9.2).
 *
 * Two compact, palette-driven controls that live in the slim top bar of the
 * chat-first shell, next to the Work_Mode switch:
 *
 *   - an EXPERIENCE selector (a <select> of the five Workspace_Experiences) →
 *     controller.select(experience) → POST /workspace-experience (Req 8.1, 8.2).
 *     Selecting one re-arranges the layout ONLY (the store + layout view enforce
 *     that); this control never touches theme/work-mode/project state.
 *   - a THEME catalog control (a <select> of the eight catalog Themes) that
 *     PREVIEWS on change (controller.preview → POST /theme action preview) and a
 *     touch-sized Apply button that COMMITS the previewed theme
 *     (controller.commit → action commit) plus a Cancel that reverts to the
 *     committed palette (controller.cancel) (Req 9.2, 9.3, 9.4, 9.5). This is the
 *     preview-then-commit flow the requirements ask for.
 *
 * The option SETS and the preview/commit/cancel logic all live in the
 * controllers (workspace.js / theme.js); this module builds nodes and forwards
 * intent, reading the store's workspace / theme slices for the current values.
 *
 * CSP hygiene (Req 1.4): every node is built with the DOM API — NO innerHTML, NO
 * inline handlers, NO inline <style>. All colors come from the palette-driven
 * `--color-*` custom properties via styles.css.
 */

import { WORKSPACE_EXPERIENCES, EXPERIENCE_LABELS } from '../workspace.js';
import { THEMES, THEME_LABELS } from '../theme.js';

/** Stable DOM ids/classes so the controls are greppable and styleable. */
export const WORKSPACE_CONTROLS_DOM = Object.freeze({
  rootClass: 'workspace-controls',
  experienceSelect: 'workspace-experience-select',
  themeSelect: 'workspace-theme-select',
  themeCommit: 'workspace-theme-commit',
  themeCancel: 'workspace-theme-cancel',
});

/** Build a labelled <option>. */
function makeOption(doc, value, label) {
  const opt = doc.createElement('option');
  opt.value = value;
  opt.textContent = label ?? value;
  return opt;
}

/**
 * Create and mount the experience + theme controls.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {{ getState: Function, subscribe: Function }} opts.store
 * @param {{ select: Function }} opts.workspace   the workspace controller (Task 10.1)
 * @param {{ preview: Function, commit: Function, cancel: Function }} opts.theme  the theme controller (Task 11.1)
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createWorkspaceControlsView({ doc, store, workspace, theme }) {
  const root = doc.createElement('div');
  root.className = WORKSPACE_CONTROLS_DOM.rootClass;

  // --- Workspace_Experience selector (Req 8.1) ---
  const experienceSelect = doc.createElement('select');
  experienceSelect.id = WORKSPACE_CONTROLS_DOM.experienceSelect;
  experienceSelect.className = 'workspace-controls__experience';
  experienceSelect.setAttribute('aria-label', 'Workspace layout');
  for (const exp of WORKSPACE_EXPERIENCES) {
    experienceSelect.append(makeOption(doc, exp, EXPERIENCE_LABELS[exp] ?? exp));
  }

  // --- Theme catalog control (Req 9.2) + preview/commit/cancel ---
  const themeSelect = doc.createElement('select');
  themeSelect.id = WORKSPACE_CONTROLS_DOM.themeSelect;
  themeSelect.className = 'workspace-controls__theme';
  themeSelect.setAttribute('aria-label', 'Theme');
  for (const t of THEMES) {
    themeSelect.append(makeOption(doc, t, THEME_LABELS[t] ?? t));
  }

  const themeCommit = doc.createElement('button');
  themeCommit.id = WORKSPACE_CONTROLS_DOM.themeCommit;
  themeCommit.className = 'workspace-controls__apply';
  themeCommit.setAttribute('type', 'button');
  themeCommit.textContent = 'Apply theme';
  themeCommit.hidden = true; // shown only while a preview is active

  const themeCancel = doc.createElement('button');
  themeCancel.id = WORKSPACE_CONTROLS_DOM.themeCancel;
  themeCancel.className = 'workspace-controls__cancel';
  themeCancel.setAttribute('type', 'button');
  themeCancel.textContent = 'Cancel';
  themeCancel.hidden = true; // shown only while a preview is active

  root.append(experienceSelect, themeSelect, themeCommit, themeCancel);

  // --- Intent handlers ---
  function onExperienceChange() {
    if (workspace && typeof workspace.select === 'function') {
      void workspace.select(experienceSelect.value);
    }
  }
  function onThemeChange() {
    // Selecting a theme PREVIEWS it (Req 9.3) — non-committing.
    if (theme && typeof theme.preview === 'function') {
      void theme.preview(themeSelect.value);
    }
  }
  function onThemeCommit() {
    // Commit the currently selected/previewed theme (Req 9.4).
    if (theme && typeof theme.commit === 'function') {
      void theme.commit(themeSelect.value);
    }
  }
  function onThemeCancel() {
    // Revert to the last committed palette (Req 9.5) and reset the select to it.
    if (theme && typeof theme.cancel === 'function') theme.cancel();
    render();
  }

  experienceSelect.addEventListener('change', onExperienceChange);
  themeSelect.addEventListener('change', onThemeChange);
  themeCommit.addEventListener('click', onThemeCommit);
  themeCancel.addEventListener('click', onThemeCancel);

  /** Apply the store slices to the controls. Idempotent. */
  function render() {
    const state = store.getState();
    const ws = state.workspace || {};
    const th = state.theme || {};

    // Reflect the current experience selection.
    if (typeof ws.experience === 'string' && experienceSelect.value !== ws.experience) {
      experienceSelect.value = ws.experience;
    }

    // Reflect the theme: the previewed theme while previewing (so the select
    // matches the surface), else the committed theme.
    const shown = typeof th.previewedTheme === 'string' ? th.previewedTheme : th.committedTheme;
    if (typeof shown === 'string' && themeSelect.value !== shown) {
      themeSelect.value = shown;
    }
    // The commit/cancel controls appear only while a preview is uncommitted.
    const previewing = typeof th.previewedTheme === 'string' && th.previewedTheme !== null;
    themeCommit.hidden = !previewing;
    themeCancel.hidden = !previewing;
  }

  const unsubWorkspace = store.subscribe((s) => s.workspace, render);
  const unsubTheme = store.subscribe((s) => s.theme, render);
  render();

  function destroy() {
    unsubWorkspace();
    unsubTheme();
    experienceSelect.removeEventListener('change', onExperienceChange);
    themeSelect.removeEventListener('change', onThemeChange);
    themeCommit.removeEventListener('click', onThemeCommit);
    themeCancel.removeEventListener('click', onThemeCancel);
    root.remove();
  }

  return { el: root, render, destroy };
}
