/**
 * Unit tests for Web UI Task 9.3 (node --test).
 *
 * Coverage (design §"Controllers — projects.js" / §"Views", Req 7.1, 7.6, 7.7,
 * 7.8) — exercising the REAL controller/validator and the REAL view-model, no
 * over-mocking:
 *
 *   - Req 7.1: the project-creation form offers EXACTLY the four supported
 *     Target_Category options (web / full-stack-web / mobile / multi-target) and
 *     the four supported Project_Origin options (blank / template / github-import
 *     / fork), matching the backend enums.
 *   - Req 7.6: origin `template` requires a selected Template BEFORE submission —
 *     a submit without one is rejected (no network) and the view shows the
 *     template selector.
 *   - Req 7.7: origin `github-import` requires the source repository reference
 *     BEFORE submission — a submit without one is rejected and the view shows the
 *     repo-reference input.
 *   - Req 7.8: origin `fork` requires an accessible source Project BEFORE
 *     submission — a submit without one is rejected and the view shows the
 *     source-project selector.
 *   - `blank` needs neither category-plus-description extras.
 *
 * The gate is proven two ways: (a) the pure `validateForm` gate returns the
 * matching reject reason and no `body`; and (b) end-to-end through the REAL
 * controller with a recording fetch — a gated submit that fails the origin gate
 * makes ZERO POST /projects calls, and one that passes it makes exactly one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import {
  createProjectsController,
  validateForm,
  originGate,
  TARGET_CATEGORIES,
  PROJECT_ORIGINS,
  FORM_REJECT,
} from '../src/server/public/projects.js';
import { projectsViewModel, PROJECTS_DOM } from '../src/server/public/views/projects.js';

const BEARER = 'tok-9-3';

/** A recording fetch returning a fixed status/body; counts calls. */
function recordingFetch(status, body) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { status, async json() { return body; } };
    },
  };
}

/** Build a controller over a real store + real api client with a recording fetch. */
function makeController(status, body) {
  const store = createStore();
  const { fetchImpl, calls } = recordingFetch(status, body);
  const api = createApiClient({ getToken: () => BEARER, fetchImpl });
  const opened = [];
  const controller = createProjectsController({ store, api, openSession: (p) => opened.push(p) });
  return { store, controller, calls, opened };
}

// ------------------------------------------------------------- Req 7.1 options

test('7.1 the form offers exactly the four supported Target_Category options', () => {
  assert.deepEqual([...TARGET_CATEGORIES], ['web', 'full-stack-web', 'mobile', 'multi-target']);
  // The view-model surfaces the same set for rendering the category select.
  const vm = projectsViewModel({ origin: 'blank' }, createStore().getState());
  assert.deepEqual([...vm.categories], ['web', 'full-stack-web', 'mobile', 'multi-target']);
});

test('7.1 the form offers exactly the four supported Project_Origin options', () => {
  assert.deepEqual([...PROJECT_ORIGINS], ['blank', 'template', 'github-import', 'fork']);
  const vm = projectsViewModel({ origin: 'blank' }, createStore().getState());
  assert.deepEqual([...vm.origins], ['blank', 'template', 'github-import', 'fork']);
});

test('7.1 an unsupported category or origin is rejected by the pure gate', () => {
  assert.equal(validateForm({ targetCategory: 'desktop', origin: 'blank', description: 'x' }).reason, FORM_REJECT.CATEGORY);
  assert.equal(validateForm({ targetCategory: 'web', origin: 'clone', description: 'x' }).reason, FORM_REJECT.ORIGIN);
});

// ------------------------------------------------------ Req 7.6 template gate

test('7.6 origin `template` requires a selected Template before submission', async () => {
  // Pure gate: no templateId → rejected with reason `template`, no body.
  const rejected = validateForm({ targetCategory: 'web', origin: 'template', description: 'app' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, FORM_REJECT.TEMPLATE);
  assert.equal(originGate('template').field, 'templateId');

  // End-to-end: a submit without a template makes ZERO network calls.
  const { controller, calls, opened } = makeController(201, { id: 'p1', project: { id: 'p1' } });
  const out = await controller.submit({ targetCategory: 'web', origin: 'template', description: 'app' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, FORM_REJECT.TEMPLATE);
  assert.equal(calls.length, 0, 'no POST /projects without a selected template');
  assert.deepEqual(opened, []);

  // With a template selected, the gate passes and the ref is sent.
  const ok = validateForm({ targetCategory: 'web', origin: 'template', description: 'app', templateId: 'tmpl-react' });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.ref, 'tmpl-react', 'selected template sent as `ref`');

  const c2 = makeController(201, { id: 'p2', project: { id: 'p2' } });
  await c2.controller.submit({ targetCategory: 'web', origin: 'template', description: 'app', templateId: 'tmpl-react' });
  assert.equal(c2.calls.length, 1, 'one POST /projects once a template is selected');
  assert.equal(JSON.parse(c2.calls[0].init.body).ref, 'tmpl-react');
});

test('7.6 the view shows the template selector only for origin `template`', () => {
  const state = createStore().getState();
  assert.equal(projectsViewModel({ origin: 'template' }, state).showTemplate, true);
  assert.equal(projectsViewModel({ origin: 'blank' }, state).showTemplate, false);
  assert.equal(projectsViewModel({ origin: 'fork' }, state).showTemplate, false);
  // The selector has a stable id so the view is greppable/testable.
  assert.equal(PROJECTS_DOM.templateSelect, 'projects-template');
});

// -------------------------------------------- Req 7.7 github-import repo gate

test('7.7 origin `github-import` requires the source repository reference', async () => {
  const rejected = validateForm({ targetCategory: 'web', origin: 'github-import', description: 'app' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, FORM_REJECT.REPO);
  assert.equal(originGate('github-import').field, 'repoRef');

  const { controller, calls } = makeController(201, { id: 'p1', project: { id: 'p1' } });
  const out = await controller.submit({ targetCategory: 'web', origin: 'github-import', description: 'app' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, FORM_REJECT.REPO);
  assert.equal(calls.length, 0, 'no POST /projects without a repo reference');

  const ok = validateForm({ targetCategory: 'web', origin: 'github-import', description: 'app', repoRef: 'octocat/hello' });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.ref, 'octocat/hello', 'source repo reference sent as `ref`');

  const c2 = makeController(201, { id: 'p2', project: { id: 'p2' } });
  await c2.controller.submit({ targetCategory: 'web', origin: 'github-import', description: 'app', repoRef: 'octocat/hello' });
  assert.equal(c2.calls.length, 1);
  assert.equal(JSON.parse(c2.calls[0].init.body).ref, 'octocat/hello');
});

test('7.7 the view shows the repo-reference input only for origin `github-import`', () => {
  const state = createStore().getState();
  assert.equal(projectsViewModel({ origin: 'github-import' }, state).showRepo, true);
  assert.equal(projectsViewModel({ origin: 'blank' }, state).showRepo, false);
  assert.equal(PROJECTS_DOM.repoInput, 'projects-repo');
});

// -------------------------------------------------- Req 7.8 fork source gate

test('7.8 origin `fork` requires an accessible source Project', async () => {
  const rejected = validateForm({ targetCategory: 'web', origin: 'fork', description: 'app' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, FORM_REJECT.SOURCE);
  assert.equal(originGate('fork').field, 'sourceProjectId');

  const { controller, calls } = makeController(201, { id: 'p1', project: { id: 'p1' } });
  const out = await controller.submit({ targetCategory: 'web', origin: 'fork', description: 'app' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, FORM_REJECT.SOURCE);
  assert.equal(calls.length, 0, 'no POST /projects without a source project');

  const ok = validateForm({ targetCategory: 'web', origin: 'fork', description: 'app', sourceProjectId: 'proj-src' });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.ref, 'proj-src', 'source project id sent as `ref`');

  const c2 = makeController(201, { id: 'p2', project: { id: 'p2' } });
  await c2.controller.submit({ targetCategory: 'web', origin: 'fork', description: 'app', sourceProjectId: 'proj-src' });
  assert.equal(c2.calls.length, 1);
  assert.equal(JSON.parse(c2.calls[0].init.body).ref, 'proj-src');
});

test('7.8 the view shows the source-project selector only for origin `fork`', () => {
  const state = createStore().getState();
  assert.equal(projectsViewModel({ origin: 'fork' }, state).showSource, true);
  assert.equal(projectsViewModel({ origin: 'blank' }, state).showSource, false);
  assert.equal(PROJECTS_DOM.sourceSelect, 'projects-source');
});

// ------------------------------------------------------------- blank origin

test('blank origin needs no extra reference and shows no origin-specific control', async () => {
  const ok = validateForm({ targetCategory: 'multi-target', origin: 'blank', description: 'app' });
  assert.equal(ok.ok, true);
  assert.equal(originGate('blank'), null);
  assert.ok(!('ref' in ok.body), 'no ref for a blank project');

  const state = createStore().getState();
  const vm = projectsViewModel({ origin: 'blank' }, state);
  assert.equal(vm.showTemplate, false);
  assert.equal(vm.showRepo, false);
  assert.equal(vm.showSource, false);

  const { controller, calls, opened } = makeController(201, { id: 'pb', project: { id: 'pb' } });
  const out = await controller.submit({ targetCategory: 'multi-target', origin: 'blank', description: 'app' });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(opened, ['pb']);
});
