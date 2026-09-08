/*
 * projects.js — the project-creation controller (spec Task 9.1; design
 * §"Controllers — projects.js", Req 7.1–7.8).
 *
 * This is the feature logic that turns a project-creation intent (a chosen
 * Target_Category + Project_Origin, plus any origin-specific reference) into a
 * `POST /projects` call and maps every transport outcome onto a next step:
 *
 *   - 201 (created)   → open the core builder screen for the new Project_Session
 *                       by calling the injected `openSession(projectId)` seam
 *                       (which app.js fills with the real openSession from
 *                       app.js) (Req 7.3).
 *   - 400 (validation)→ display the SPECIFIC backend validation message and keep
 *                       the form editable — no navigation (Req 7.4).
 *   - 429 (rate|quota)→ display the NAMED limit and keep the form editable
 *                       (Req 7.5).
 *   - denied / other  → a generic, non-disclosing notice; the form stays editable.
 *
 * It owns NO DOM: the form view (views/projects.js) reads the pure helpers and
 * store slices this controller exposes/mutates and calls back into `submit()`.
 * Every collaborator — the `store`, the gated `api` client, and the
 * `openSession` seam — is INJECTED, so the whole controller runs under
 * `node --test` with the REAL store reducer and the REAL api client (driven by
 * an injected fetch), never a stand-in double.
 *
 * The backend contract this consumes is FIXED (read from
 * src/server/builder-server.js `handleCreateProject` + src/project/project-manager.js
 * `validateCreateInput`/`createProject` + src/model/enums.js):
 *
 *   POST /projects  body { description, targetCategory, origin, ref? }  (Bearer gated)
 *     201 → { id, project }                      (created project id at `.id`)
 *     400 → { error, code }                      (validation: DESCRIPTION_REQUIRED,
 *                                                  DESCRIPTION_LENGTH,
 *                                                  UNSUPPORTED_TARGET_CATEGORY,
 *                                                  UNSUPPORTED_ORIGIN, …)
 *     429 → { error, limit, operation }          (rate limit) OR
 *           { error, limit, resource }           (resource quota)
 *
 * NOTE on the 400 classification: the backend's validation 400 carries a `code`,
 * so api.js classifies it as `{ kind:'protocol', code, message }` (a 400 WITH a
 * code) rather than `{ kind:'validation' }`. Both kinds carry the backend's
 * human `message`/`error`, and Req 7.4 wants the SPECIFIC validation message
 * shown while keeping the form editable — so this controller treats BOTH
 * `validation` and `protocol` outcomes identically: show the backend message,
 * stay editable. (A login-protocol `code` is never shown; a project validation
 * message IS the backend-authored text the user needs — the code is used for
 * control only, never interpolated into the shown text.)
 *
 * Target_Category / Project_Origin option sets mirror the backend enums exactly
 * (src/model/enums.js Target_Category / Project_Origin), so the form offers
 * exactly what the backend accepts (Req 7.1).
 */

import { ACTIONS } from './store.js';
import { RESULT } from './api.js';

/** The four Target_Category options offered by the form (Req 7.1). Mirrors
 *  src/model/enums.js `Target_Category`. */
export const TARGET_CATEGORIES = Object.freeze([
  'web',
  'full-stack-web',
  'mobile',
  'multi-target',
]);

/** The four Project_Origin options offered by the form (Req 7.1). Mirrors
 *  src/model/enums.js `Project_Origin`. */
export const PROJECT_ORIGINS = Object.freeze([
  'blank',
  'template',
  'github-import',
  'fork',
]);

/**
 * The closed set of rejection reasons the pure `validateForm` gate can return,
 * so the view and tests branch on a stable name rather than a message string.
 * @type {Readonly<Record<string,string>>}
 */
export const FORM_REJECT = Object.freeze({
  CATEGORY: 'category', // unsupported/absent Target_Category
  ORIGIN: 'origin', // unsupported/absent Project_Origin
  DESCRIPTION: 'description', // missing description
  TEMPLATE: 'template', // origin 'template' without a selected template (Req 7.6)
  REPO: 'repo', // origin 'github-import' without a repo reference (Req 7.7)
  SOURCE: 'source', // origin 'fork' without a source Project (Req 7.8)
});

/**
 * Client-authored, non-disclosing notice messages. The backend-authored 400
 * validation message is shown VERBATIM (it is the specific text Req 7.4 wants);
 * these strings cover the client-side gate rejections and the generic failure.
 * Exported so the view and tests reference the same text.
 */
export const PROJECT_MESSAGES = Object.freeze({
  CATEGORY: 'Choose a target category.',
  ORIGIN: 'Choose a project origin.',
  DESCRIPTION: 'Describe the project to create.',
  TEMPLATE: 'Select a template to start from.',
  REPO: 'Enter the source repository reference.',
  SOURCE: 'Select a source project to fork.',
  RATE_LIMITED: 'A usage limit was reached.',
  REAUTH: 'Your session expired. Please sign in again.',
  ERROR: 'Something went wrong creating the project. Please try again.',
});

/**
 * Which origins require an extra reference BEFORE submission, and which store
 * field the view collects it into. This is the single source of truth for the
 * origin-specific gates (Req 7.6, 7.7, 7.8) so the view and the validator agree.
 *   - template     → a selected Template id (Req 7.6)
 *   - github-import→ a source repository reference (Req 7.7)
 *   - fork         → an accessible source Project id (Req 7.8)
 * `blank` requires nothing beyond category + description.
 * @type {Readonly<Record<string,{ field: string, reject: string }>>}
 */
export const ORIGIN_GATE = Object.freeze({
  template: { field: 'templateId', reject: FORM_REJECT.TEMPLATE },
  'github-import': { field: 'repoRef', reject: FORM_REJECT.REPO },
  fork: { field: 'sourceProjectId', reject: FORM_REJECT.SOURCE },
});

/** True iff `value` is one of the four supported Target_Category options. */
export function isSupportedCategory(value) {
  return TARGET_CATEGORIES.includes(value);
}

/** True iff `value` is one of the four supported Project_Origin options. */
export function isSupportedOrigin(value) {
  return PROJECT_ORIGINS.includes(value);
}

/**
 * Does the selected origin require an extra reference before submission
 * (Req 7.6/7.7/7.8)? Returns the gate descriptor (`{ field, reject }`) or null
 * for `blank`. Exported so the view knows which extra control to render.
 *
 * @param {string} origin
 * @returns {{ field: string, reject: string } | null}
 */
export function originGate(origin) {
  return ORIGIN_GATE[origin] ?? null;
}

/**
 * Pure form validation (Req 7.1, 7.6, 7.7, 7.8). Given the form's current field
 * values, decide whether the form may be submitted and, if so, produce the
 * EXACT `POST /projects` body. Exported so the unit tests (Task 9.3) drive the
 * REAL origin-gate logic and the view reuses the identical rule for its
 * enabled/disabled affordance.
 *
 * The origin-specific gate is the crux: for `template`/`github-import`/`fork`
 * the corresponding reference (templateId / repoRef / sourceProjectId) MUST be
 * present (non-empty after trim) BEFORE a submit is allowed; `blank` needs none.
 * The reference is sent as the backend's `ref` field (a single string the
 * ProjectManager threads to the ProjectOrigin as `originRef`).
 *
 * @param {object} form
 * @param {string} form.targetCategory
 * @param {string} form.origin
 * @param {string} [form.description]
 * @param {string} [form.templateId]        required when origin === 'template'
 * @param {string} [form.repoRef]           required when origin === 'github-import'
 * @param {string} [form.sourceProjectId]   required when origin === 'fork'
 * @returns {{ ok: true, body: { description: string, targetCategory: string, origin: string, ref?: string } }
 *          | { ok: false, reason: string }}
 */
export function validateForm(form = {}) {
  const targetCategory = typeof form.targetCategory === 'string' ? form.targetCategory : '';
  const origin = typeof form.origin === 'string' ? form.origin : '';
  const description = typeof form.description === 'string' ? form.description.trim() : '';

  if (!isSupportedCategory(targetCategory)) {
    return { ok: false, reason: FORM_REJECT.CATEGORY };
  }
  if (!isSupportedOrigin(origin)) {
    return { ok: false, reason: FORM_REJECT.ORIGIN };
  }
  if (description === '') {
    // The backend requires a description (DESCRIPTION_REQUIRED); gate client-side
    // so a blank submit never reaches the network needlessly.
    return { ok: false, reason: FORM_REJECT.DESCRIPTION };
  }

  const body = { description, targetCategory, origin };

  // Origin-specific gate (Req 7.6/7.7/7.8): the required reference must be present.
  const gate = originGate(origin);
  if (gate) {
    const ref = typeof form[gate.field] === 'string' ? form[gate.field].trim() : '';
    if (ref === '') {
      return { ok: false, reason: gate.reject };
    }
    body.ref = ref;
  }

  return { ok: true, body };
}

/**
 * Map a pure-gate reject reason to its client-authored notice message.
 * @param {string} reason  a FORM_REJECT value
 * @returns {string}
 */
export function messageForReject(reason) {
  switch (reason) {
    case FORM_REJECT.CATEGORY:
      return PROJECT_MESSAGES.CATEGORY;
    case FORM_REJECT.ORIGIN:
      return PROJECT_MESSAGES.ORIGIN;
    case FORM_REJECT.DESCRIPTION:
      return PROJECT_MESSAGES.DESCRIPTION;
    case FORM_REJECT.TEMPLATE:
      return PROJECT_MESSAGES.TEMPLATE;
    case FORM_REJECT.REPO:
      return PROJECT_MESSAGES.REPO;
    case FORM_REJECT.SOURCE:
      return PROJECT_MESSAGES.SOURCE;
    default:
      return PROJECT_MESSAGES.ERROR;
  }
}

/**
 * Create the project-creation controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function, subscribe?: Function }} deps.store
 *   the REAL observable store (createStore()).
 * @param {{ request: Function }} deps.api
 *   the REAL gated api client (createApiClient()).
 * @param {(projectId: string) => any} [deps.openSession]
 *   the session-open seam. app.js passes a closure over the real openSession()
 *   from app.js so a 201 opens the core builder screen for the new session
 *   (Req 7.3). In a test this is a spy so the "opens its session" property is
 *   observable without a browser. Absent → the 201 outcome still resolves
 *   `{ ok:true }` but opens nothing (degenerate).
 * @returns {{
 *   categories: readonly string[],
 *   origins: readonly string[],
 *   originGate: typeof originGate,
 *   validate: typeof validateForm,
 *   submit: (form: object) => Promise<{ ok: boolean, reason?: string, projectId?: string, result?: object }>,
 * }}
 */
export function createProjectsController({ store, api, openSession } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createProjectsController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createProjectsController requires an api client with request()');
  }
  const openSessionSeam = typeof openSession === 'function' ? openSession : null;

  /**
   * Validate and (if valid) create a project.
   *
   * Flow:
   *   1. Validate (Req 7.1/7.6/7.7/7.8): on reject, DO NOT call POST /projects,
   *      set the matching client notice, and keep the form editable (return a
   *      reason). The origin-specific gates are enforced HERE before any network.
   *   2. On valid submit: POST /projects with { description, targetCategory,
   *      origin, ref? } (api.js attaches the Bearer). No in-flight store gate is
   *      needed — project creation is a one-shot form, not a per-session turn.
   *   3. Map the transport result:
   *        ok(201)      → read the created project id (`data.id`); open the core
   *                       builder screen for that Project_Session; clear notice
   *                       (Req 7.3).
   *        validation   → show the SPECIFIC backend message; keep editable (7.4).
   *        protocol     → (a 400 WITH a code — the backend's validation shape)
   *                       treated as validation: show the backend message; keep
   *                       editable (7.4).
   *        rateLimited  → show the NAMED limit; keep editable (7.5).
   *        denied(401)  → generic re-auth notice, NO project detail; keep editable.
   *        other/error  → generic error notice; keep editable.
   *
   * @param {object} form  the current form field values (see validateForm)
   * @returns {Promise<{ ok: boolean, reason?: string, projectId?: string, result?: object }>}
   */
  async function submit(form) {
    // (1) Client-side validation + origin gates.
    const verdict = validateForm(form);
    if (!verdict.ok) {
      store.dispatch({
        type: ACTIONS.NOTICE_SET,
        kind: 'validation',
        message: messageForReject(verdict.reason),
      });
      // No network call; the form stays editable (nothing disables it).
      return { ok: false, reason: verdict.reason };
    }

    // (2) Create. api.js attaches the Bearer to this gated call (Req 7.2).
    const result = await api.request('POST', '/projects', { body: verdict.body });

    // (3) Map the outcome.
    switch (result.kind) {
      case RESULT.OK: {
        // 201 { id, project }: the created project id is `data.id` (Req 7.3).
        const projectId =
          result.data && typeof result.data.id === 'string' ? result.data.id : null;
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        if (projectId && openSessionSeam) {
          // Open the core builder screen for the new Project_Session.
          openSessionSeam(projectId);
        }
        return { ok: true, projectId, result };
      }

      case RESULT.VALIDATION:
      case RESULT.PROTOCOL: {
        // Req 7.4: display the SPECIFIC backend validation message and keep the
        // form editable. Both a bare 400 and a 400-with-code carry the backend's
        // human message (api.js reads `message` or `error` into result.message);
        // we show that specific text. The `code`, if any, is control-only and
        // never interpolated into the shown message.
        const message =
          typeof result.message === 'string' && result.message.length > 0
            ? result.message
            : PROJECT_MESSAGES.ERROR;
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'validation', message });
        return { ok: false, reason: 'validation', result };
      }

      case RESULT.RATE_LIMITED: {
        // Req 7.5: display the NAMED limit and keep the form editable.
        const named =
          typeof result.limit === 'string' && result.limit.length > 0 ? result.limit : null;
        store.dispatch({
          type: ACTIONS.NOTICE_SET,
          kind: 'rateLimited',
          message: PROJECT_MESSAGES.RATE_LIMITED,
          limit: named,
        });
        return { ok: false, reason: 'rateLimited', result };
      }

      case RESULT.DENIED:
        // 401: re-auth prompt, NO project-specific detail (api.js discarded the
        // body). The form stays editable.
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: PROJECT_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };

      default:
        // timeout / error: a generic, non-disclosing error notice; keep editable.
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: PROJECT_MESSAGES.ERROR });
        return { ok: false, reason: 'error', result };
    }
  }

  return {
    categories: TARGET_CATEGORIES,
    origins: PROJECT_ORIGINS,
    originGate,
    validate: validateForm,
    submit,
  };
}
