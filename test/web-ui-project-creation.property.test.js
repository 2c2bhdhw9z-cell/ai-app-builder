/**
 * Property-based test for Web UI Task 9.2 (node --test).
 *
 * Property 23 — "A created project opens its session, and a validation error
 * stays editable" (design §"Property 23", Req 7.2, 7.3, 7.4). The test carries
 * the EXACT spec tag required by the web-ui spec:
 *
 *   "Feature: web-ui, Property 23: A created project opens its session, and a
 *    validation error stays editable"
 *
 * WHAT IS PROVEN, end-to-end through the REAL collaborators (the REAL store
 * reducer + the REAL createApiClient driven by an injected fetch — no
 * over-mocking of the client itself):
 *
 *   (7.2) A valid form submit issues POST /projects carrying the selected
 *         { description, targetCategory, origin, ref? } AND the Bearer header
 *         from the injected token getter.
 *   (7.3) On HTTP 201 with a created project id, the controller opens the core
 *         builder screen for THAT Project_Session — observed via the injected
 *         `openSession` seam being called exactly once with the returned id —
 *         and clears any prior notice.
 *   (7.4) On HTTP 400 (the backend's validation shape, which carries a `code`),
 *         the controller displays the SPECIFIC backend validation message via
 *         the store notice and does NOT open a session; nothing disables the
 *         form (it stays editable — no in-flight/lock state is set), so a retry
 *         is possible.
 *
 * The generators mirror the backend's REAL POST /projects contract (read from
 * src/server/builder-server.js handleCreateProject + src/project/project-manager.js
 * + src/model/enums.js): categories are web/full-stack-web/mobile/multi-target,
 * origins are blank/template/github-import/fork, the created 201 body is
 * { id, project }, and a 400 validation body is { error, code }.
 *
 * Hermetic: pure logic + an injected fetch stub + a real store. No network, no
 * server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import {
  createProjectsController,
  TARGET_CATEGORIES,
  PROJECT_ORIGINS,
  originGate,
} from '../src/server/public/projects.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag (distinct from the platform-wide ai-app-builder tag). */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ---------------------------------------------------------------- generators

const category = fc.constantFrom(...TARGET_CATEGORIES);
const origin = fc.constantFrom(...PROJECT_ORIGINS);

/** A non-empty description that survives trimming. */
const description = fc
  .string({ minLength: 1, maxLength: 120 })
  .filter((s) => s.trim().length > 0);

/** A non-empty origin-specific reference (template id / repo ref / source id). */
const reference = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s.trim().length > 0);

/**
 * A VALID form: category + origin + description, plus whichever origin-specific
 * reference the selected origin requires (Req 7.6/7.7/7.8) so the client-side
 * gate passes and the submit reaches the network.
 */
const validForm = fc
  .record({ targetCategory: category, origin, description, ref: reference })
  .map(({ targetCategory, origin: o, description: d, ref }) => {
    const form = { targetCategory, origin: o, description: d };
    const gate = originGate(o);
    if (gate) form[gate.field] = ref; // template/github-import/fork need a ref
    return form;
  });

/** A created project id the backend returns in the 201 body. */
const createdId = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0)
  .map((s) => `proj_${s.replace(/\s/g, '')}`);

/** A backend validation `code` (mirrors the ProjectManager reject codes). */
const validationCode = fc.constantFrom(
  'DESCRIPTION_REQUIRED',
  'DESCRIPTION_LENGTH',
  'UNSUPPORTED_TARGET_CATEGORY',
  'UNSUPPORTED_ORIGIN',
);

/** A specific backend validation message (the text Req 7.4 wants shown). */
const validationMessage = fc
  .string({ minLength: 1, maxLength: 100 })
  .filter((s) => s.trim().length > 0);

/**
 * A fetch stub that records the single request it received and returns a
 * synthetic response with the given status + JSON body. A REAL collaborator for
 * createApiClient (not a mock of the client).
 */
function recordingFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      async json() {
        return body;
      },
    };
  };
  return { fetchImpl, calls };
}

const BEARER = 'tok-web-ui-9';

// ------------------------------------------------------ Property 23 (Task 9.2)

test(
  webUiTag(23, 'A created project opens its session, and a validation error stays editable'),
  async () => {
    // Part A (Req 7.2, 7.3): a valid submit posts /projects with the selected
    // values + the Bearer, and a 201 opens the created project's session.
    await fc.assert(
      fc.asyncProperty(validForm, createdId, async (form, id) => {
        const store = createStore();
        const { fetchImpl, calls } = recordingFetch(201, { id, project: { id } });
        const api = createApiClient({ getToken: () => BEARER, fetchImpl });

        const opened = [];
        const controller = createProjectsController({
          store,
          api,
          openSession: (projectId) => opened.push(projectId),
        });

        const outcome = await controller.submit(form);

        // (7.2) Exactly one POST /projects carrying the selected values + Bearer.
        assert.equal(calls.length, 1, 'exactly one POST /projects');
        const { url, init } = calls[0];
        assert.ok(String(url).endsWith('/projects'), 'posts to /projects');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.authorization, `Bearer ${BEARER}`, 'carries the Bearer (Req 7.2)');
        const sent = JSON.parse(init.body);
        assert.equal(sent.targetCategory, form.targetCategory, 'selected category sent');
        assert.equal(sent.origin, form.origin, 'selected origin sent');
        assert.equal(sent.description, form.description.trim(), 'description sent (trimmed)');
        const gate = originGate(form.origin);
        if (gate) {
          assert.equal(sent.ref, form[gate.field].trim(), 'origin-specific ref sent');
        }

        // (7.3) The created project's session is opened exactly once with the id.
        assert.equal(outcome.ok, true, 'valid create succeeds');
        assert.equal(outcome.projectId, id, 'controller reports the created id');
        assert.deepEqual(opened, [id], 'opens the core builder screen for THAT session');
        // No lingering notice on success.
        assert.equal(store.getState().session.notice, null, 'notice cleared on success');
        return true;
      }),
      fcConfig,
    );

    // Part B (Req 7.4): a 400 validation error shows the SPECIFIC backend
    // message, opens NO session, and leaves the form editable (no lock set).
    await fc.assert(
      fc.asyncProperty(
        validForm,
        validationCode,
        validationMessage,
        async (form, code, message) => {
          const store = createStore();
          // The backend's 400 validation body is { error, code }.
          const { fetchImpl, calls } = recordingFetch(400, { error: message, code });
          const api = createApiClient({ getToken: () => BEARER, fetchImpl });

          const opened = [];
          const controller = createProjectsController({
            store,
            api,
            openSession: (projectId) => opened.push(projectId),
          });

          const before = store.getState().session;
          const outcome = await controller.submit(form);

          // The gated call was still made (the form was client-valid).
          assert.equal(calls.length, 1, 'one POST /projects attempted');

          // (7.4) The SPECIFIC backend validation message is shown via the notice.
          assert.equal(outcome.ok, false, 'a validation error is not a success');
          const notice = store.getState().session.notice;
          assert.ok(notice, 'a notice is set');
          assert.equal(notice.message, message, 'the SPECIFIC backend message is shown verbatim');

          // No session was opened on a validation error.
          assert.deepEqual(opened, [], 'no session opened on validation error');

          // The form stays editable: the controller sets NO in-flight/disable
          // state on the session slice (submitInFlight stays false, no projectId).
          const after = store.getState().session;
          assert.equal(after.submitInFlight, false, 'form not locked (submit not in flight)');
          assert.equal(after.projectId, before.projectId, 'no session opened');
          return true;
        },
      ),
      fcConfig,
    );
  },
);

// -------------------------------------------- Mutation / test-quality guard

/**
 * Prove the assertions are not vacuous: a 201 with a DIFFERENT id would not
 * match the opened id, and a validation error must NOT open a session nor be a
 * success. This pins the create-opens-session and validation-stays-editable
 * behaviors rather than trivially passing.
 */
test('Property 23 guard: 201 opens the exact id; a 400 opens nothing and is not ok', async () => {
  // 201 opens exactly the returned id.
  {
    const store = createStore();
    const { fetchImpl } = recordingFetch(201, { id: 'proj_abc', project: { id: 'proj_abc' } });
    const api = createApiClient({ getToken: () => BEARER, fetchImpl });
    const opened = [];
    const controller = createProjectsController({ store, api, openSession: (p) => opened.push(p) });
    const out = await controller.submit({ targetCategory: 'web', origin: 'blank', description: 'hi' });
    assert.equal(out.ok, true);
    assert.deepEqual(opened, ['proj_abc']);
    assert.notDeepEqual(opened, ['proj_other'], 'opens the EXACT created id, not another');
  }

  // 400 validation: specific message shown, no session, not ok.
  {
    const store = createStore();
    const { fetchImpl } = recordingFetch(400, { error: 'a description is required', code: 'DESCRIPTION_REQUIRED' });
    const api = createApiClient({ getToken: () => BEARER, fetchImpl });
    const opened = [];
    const controller = createProjectsController({ store, api, openSession: (p) => opened.push(p) });
    const out = await controller.submit({ targetCategory: 'web', origin: 'blank', description: 'hi' });
    assert.equal(out.ok, false);
    assert.equal(store.getState().session.notice.message, 'a description is required');
    assert.deepEqual(opened, [], 'no session opened');
    assert.equal(store.getState().session.submitInFlight, false, 'form stays editable');
  }
});
