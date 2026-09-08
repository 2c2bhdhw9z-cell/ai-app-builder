/*
 * views/projects.js — the project-creation form view (spec Task 9.1; design
 * §"Views" / §"Controllers — projects.js", Req 7.1, 7.4, 7.5, 7.6, 7.7, 7.8,
 * 11.3).
 *
 * A thin DOM renderer over the projects controller (projects.js) and the store
 * (Task 2.1). It renders a form offering:
 *   - a Target_Category select (web / full-stack-web / mobile / multi-target) — Req 7.1
 *   - a Project_Origin select (blank / template / github-import / fork)       — Req 7.1
 *   - a project description input
 *   - an ORIGIN-SPECIFIC reference control that appears only for the origins
 *     that need one (Req 7.6/7.7/7.8):
 *        template      → a template selector  (7.6)
 *        github-import → a source-repo reference input (7.7)
 *        fork          → a source-project selector (7.8)
 *   - a submit control (touch-sized, Req 11.3)
 *   - a notice line that shows the specific 400 validation message (Req 7.4) or
 *     the named 429 limit (Req 7.5) while KEEPING the form editable (nothing in
 *     this view disables the fields on a validation/limit outcome).
 *
 * It holds NO business logic: the option sets, the origin-gate decision, the
 * validation, the `POST /projects` call, and the 201/400/429 mapping all live in
 * projects.js; on a 201 the controller opens the core builder screen via the
 * injected openSession seam. This module only builds nodes and forwards intent.
 *
 * CSP hygiene (Req 1.4): nodes are built with the DOM API only — NO innerHTML,
 * NO inline event-handler attributes, NO inline <style>. Listeners are attached
 * with addEventListener; all colors come from the palette-driven `--color-*`
 * custom properties via styles.css, never inline.
 *
 * Structure to stay unit-testable without a DOM: the PURE parts — the option
 * sets, which origin needs which extra control, and the notice text projection —
 * are exported as pure helpers (`projectsViewModel`) so a `node --test` asserts
 * the view's decisions without a browser; the DOM-touching `createProjectsView`
 * is kept deliberately thin over those helpers.
 */

import { ACTIONS } from '../store.js';
import {
  TARGET_CATEGORIES,
  PROJECT_ORIGINS,
  originGate,
} from '../projects.js';

/** Stable DOM ids/classes so the view is greppable and styleable. */
export const PROJECTS_DOM = Object.freeze({
  rootClass: 'projects',
  form: 'projects-form',
  category: 'projects-category',
  origin: 'projects-origin',
  description: 'projects-description',
  // The origin-specific reference control (only one is present at a time).
  templateSelect: 'projects-template',
  repoInput: 'projects-repo',
  sourceSelect: 'projects-source',
  submit: 'projects-submit',
  notice: 'projects-notice',
});

/**
 * A human label for each origin's extra reference control, used for the field's
 * accessible label. Kept here (the view) since it is presentation, not logic.
 * @type {Readonly<Record<string,string>>}
 */
export const ORIGIN_FIELD_LABEL = Object.freeze({
  template: 'Template',
  'github-import': 'Source repository',
  fork: 'Source project',
});

/**
 * Pure view-model: given the current form field values + the store slice,
 * decide what the view should show. Exported so a DOM-free test asserts the
 * decisions (which extra control to render, the notice text) directly.
 *
 * @param {object} form   the current form field values
 * @param {{ session: { notice: any } }} state
 * @returns {{
 *   categories: readonly string[],
 *   origins: readonly string[],
 *   origin: string,
 *   gate: { field: string, reject: string } | null,
 *   showTemplate: boolean,
 *   showRepo: boolean,
 *   showSource: boolean,
 *   notice: { kind: string, message: string, limit: (string|null) } | null,
 *   noticeText: string,
 * }}
 */
export function projectsViewModel(form, state) {
  const origin = typeof form?.origin === 'string' ? form.origin : '';
  const gate = originGate(origin);
  const session = state?.session ?? {};
  const notice = session.notice ?? null;
  // A named rate-limit notice appends the backend-named limit so the user sees
  // WHICH limit was hit (Req 7.5) without any other backend detail. A 400
  // validation notice shows the backend's specific message verbatim (Req 7.4).
  let noticeText = '';
  if (notice) {
    noticeText = notice.message ?? '';
    if (notice.kind === 'rateLimited' && typeof notice.limit === 'string' && notice.limit) {
      noticeText = `${noticeText} (${notice.limit})`.trim();
    }
  }
  return {
    categories: TARGET_CATEGORIES,
    origins: PROJECT_ORIGINS,
    origin,
    gate,
    showTemplate: origin === 'template',
    showRepo: origin === 'github-import',
    showSource: origin === 'fork',
    notice,
    noticeText,
  };
}

/** Build an <option> element. */
function makeOption(doc, value, label) {
  const opt = doc.createElement('option');
  opt.value = value;
  opt.textContent = label ?? value;
  return opt;
}

/**
 * Create and mount the project-creation form view.
 *
 * @param {object} opts
 * @param {Document} opts.doc                 the document to build nodes in
 * @param {{ getState: Function, dispatch: Function, subscribe: Function }} opts.store
 * @param {{ submit: Function }} opts.controller   the projects controller (Task 9.1)
 * @param {object} [opts.options]              optional pre-populated option lists
 * @param {Array<{ id: string, label?: string }>} [opts.options.templates]
 *        available Templates for the origin 'template' selector (Req 7.6)
 * @param {Array<{ id: string, label?: string }>} [opts.options.sourceProjects]
 *        accessible source Projects for the origin 'fork' selector (Req 7.8)
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createProjectsView({ doc, store, controller, options = {} }) {
  const templates = Array.isArray(options.templates) ? options.templates : [];
  const sourceProjects = Array.isArray(options.sourceProjects) ? options.sourceProjects : [];

  const root = doc.createElement('section');
  root.className = PROJECTS_DOM.rootClass;
  root.setAttribute('aria-label', 'Create a project');

  const form = doc.createElement('form');
  form.id = PROJECTS_DOM.form;
  form.className = 'projects__form';
  form.setAttribute('novalidate', '');

  // --- Target_Category select (Req 7.1) ---
  const category = doc.createElement('select');
  category.id = PROJECTS_DOM.category;
  category.className = 'projects__category';
  category.setAttribute('name', 'targetCategory');
  category.setAttribute('aria-label', 'Target category');
  for (const c of TARGET_CATEGORIES) category.append(makeOption(doc, c));

  // --- Project_Origin select (Req 7.1) ---
  const origin = doc.createElement('select');
  origin.id = PROJECTS_DOM.origin;
  origin.className = 'projects__origin';
  origin.setAttribute('name', 'origin');
  origin.setAttribute('aria-label', 'Project origin');
  for (const o of PROJECT_ORIGINS) origin.append(makeOption(doc, o));

  // --- Description ---
  const description = doc.createElement('input');
  description.id = PROJECTS_DOM.description;
  description.className = 'projects__description';
  description.setAttribute('type', 'text');
  description.setAttribute('name', 'description');
  description.setAttribute('aria-label', 'Project description');
  description.setAttribute('placeholder', 'Describe the app to build\u2026');

  // --- Origin-specific reference controls (Req 7.6/7.7/7.8). All three are
  // built once and shown/hidden by render() based on the selected origin, so the
  // required reference is collected BEFORE submission for the origin that needs it.

  // template → a Template selector (Req 7.6)
  const templateSelect = doc.createElement('select');
  templateSelect.id = PROJECTS_DOM.templateSelect;
  templateSelect.className = 'projects__template';
  templateSelect.setAttribute('name', 'templateId');
  templateSelect.setAttribute('aria-label', ORIGIN_FIELD_LABEL.template);
  // A leading empty option so nothing is pre-selected (the gate requires a pick).
  templateSelect.append(makeOption(doc, '', 'Select a template\u2026'));
  for (const t of templates) templateSelect.append(makeOption(doc, t.id, t.label ?? t.id));

  // github-import → a source-repo reference input (Req 7.7)
  const repoInput = doc.createElement('input');
  repoInput.id = PROJECTS_DOM.repoInput;
  repoInput.className = 'projects__repo';
  repoInput.setAttribute('type', 'text');
  repoInput.setAttribute('name', 'repoRef');
  repoInput.setAttribute('aria-label', ORIGIN_FIELD_LABEL['github-import']);
  repoInput.setAttribute('placeholder', 'owner/repo or repository URL');

  // fork → a source-Project selector (Req 7.8)
  const sourceSelect = doc.createElement('select');
  sourceSelect.id = PROJECTS_DOM.sourceSelect;
  sourceSelect.className = 'projects__source';
  sourceSelect.setAttribute('name', 'sourceProjectId');
  sourceSelect.setAttribute('aria-label', ORIGIN_FIELD_LABEL.fork);
  sourceSelect.append(makeOption(doc, '', 'Select a source project\u2026'));
  for (const p of sourceProjects) sourceSelect.append(makeOption(doc, p.id, p.label ?? p.id));

  const submit = doc.createElement('button');
  submit.id = PROJECTS_DOM.submit;
  submit.className = 'projects__submit';
  submit.setAttribute('type', 'submit');
  submit.textContent = 'Create project';

  const notice = doc.createElement('p');
  notice.id = PROJECTS_DOM.notice;
  notice.className = 'projects__notice';
  notice.setAttribute('role', 'alert');
  notice.hidden = true;

  form.append(
    category,
    origin,
    description,
    templateSelect,
    repoInput,
    sourceSelect,
    submit,
  );
  root.append(form, notice);

  /** Read the current form values into the shape the controller expects. */
  function readForm() {
    return {
      targetCategory: category.value,
      origin: origin.value,
      description: description.value,
      templateId: templateSelect.value,
      repoRef: repoInput.value,
      sourceProjectId: sourceSelect.value,
    };
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    await controller.submit(readForm());
  }

  // Changing the origin re-renders so the correct origin-specific control shows.
  function onOriginChange() {
    render();
  }

  form.addEventListener('submit', onSubmit);
  origin.addEventListener('change', onOriginChange);

  /** Apply the pure view-model to the DOM. Idempotent. */
  function render() {
    const vm = projectsViewModel(readForm(), store.getState());
    // Show exactly the origin-specific control the selected origin needs
    // (Req 7.6/7.7/7.8); hide the others so the required reference is the one
    // collected before submission.
    templateSelect.hidden = !vm.showTemplate;
    repoInput.hidden = !vm.showRepo;
    sourceSelect.hidden = !vm.showSource;

    if (vm.noticeText) {
      // Show the specific 400 validation message (7.4) or the named 429 limit
      // (7.5). The form fields are NEVER disabled here, so it stays editable.
      notice.textContent = vm.noticeText;
      notice.hidden = false;
    } else {
      notice.textContent = '';
      notice.hidden = true;
    }
  }

  // Re-render whenever the session slice changes (the notice lives there).
  const unsubscribe = store.subscribe((s) => s.session, render);
  render();

  function destroy() {
    unsubscribe();
    form.removeEventListener('submit', onSubmit);
    origin.removeEventListener('change', onOriginChange);
    root.remove();
  }

  return { el: root, render, destroy };
}
