/**
 * Property-based test for Web UI Task 10.3 (node --test).
 *
 * Property 25 — "Selecting a Workspace_Experience or Work_Mode posts the
 * selected value" (design §"Property 25", Req 8.2, 10.4). Exact spec tag:
 *
 *   "Feature: web-ui, Property 25: Selecting a Workspace_Experience or Work_Mode
 *    posts the selected value"
 *
 * WHAT IS PROVEN, end-to-end through the REAL collaborators (the REAL store, the
 * REAL createApiClient driven by an injected recording fetch, and the REAL
 * workspace / work-mode controllers — no over-mocking of the client):
 *
 *   (8.2)  For ANY of the five Workspace_Experiences, `workspace.select(exp)`
 *          issues exactly one POST /workspace-experience whose body `experience`
 *          equals the selected value, carrying the Bearer.
 *   (10.4) For ANY of the three Work_Modes, `workMode.switchMode(mode)` (with an
 *          open Session) issues exactly one POST /work-mode whose body `mode`
 *          equals the selected value and `projectId` the open session, carrying
 *          the Bearer.
 *
 * The generators enumerate the CLOSED enums (Workspace_Experience / Work_Mode)
 * from the controllers themselves, so the posted value space is exactly the
 * backend-accepted space (src/model/enums.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore, ACTIONS } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createWorkspaceController, WORKSPACE_EXPERIENCES } from '../src/server/public/workspace.js';
import { createWorkModeController, WORK_MODE_OPTIONS } from '../src/server/public/work-mode.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

const BEARER = 'tok-web-ui-10';

/** A recording fetch that returns a fixed status + JSON body. REAL collaborator
 *  for createApiClient (not a mock of the client). */
function recordingFetch(status, bodyFor) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = typeof bodyFor === 'function' ? bodyFor({ url, init }) : bodyFor;
    return {
      status,
      async json() {
        return body;
      },
    };
  };
  return { fetchImpl, calls };
}

// ------------------------------------------------------ Property 25 (Task 10.3)

test(
  webUiTag(25, 'Selecting a Workspace_Experience or Work_Mode posts the selected value'),
  async () => {
    // Part A (Req 8.2): selecting each Workspace_Experience posts it.
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...WORKSPACE_EXPERIENCES), async (exp) => {
        const store = createStore();
        // A 200 workspace_experience frame echoing the selected experience.
        const { fetchImpl, calls } = recordingFetch(200, ({ init }) => {
          const sent = JSON.parse(init.body);
          return { type: 'workspace_experience', experience: sent.experience, layout: { id: sent.experience } };
        });
        const api = createApiClient({ getToken: () => BEARER, fetchImpl });
        const workspace = createWorkspaceController({ store, api });

        const out = await workspace.select(exp);

        assert.equal(calls.length, 1, 'exactly one POST /workspace-experience');
        const { url, init } = calls[0];
        assert.ok(String(url).endsWith('/workspace-experience'), 'posts to /workspace-experience');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.authorization, `Bearer ${BEARER}`, 'carries the Bearer (Req 8.2)');
        const sent = JSON.parse(init.body);
        assert.equal(sent.experience, exp, 'posts the SELECTED experience value');
        assert.equal(out.ok, true, 'a supported selection succeeds');
        return true;
      }),
      fcConfig,
    );

    // Part B (Req 10.4): switching to each Work_Mode posts it (open session).
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...WORK_MODE_OPTIONS), async (mode) => {
        const store = createStore();
        store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-25' });
        const { fetchImpl, calls } = recordingFetch(200, ({ init }) => {
          const sent = JSON.parse(init.body);
          return { type: 'work_mode', mode: sent.mode, choices: [...WORK_MODE_OPTIONS], applied: true };
        });
        const api = createApiClient({ getToken: () => BEARER, fetchImpl });
        const workMode = createWorkModeController({ store, api });

        const out = await workMode.switchMode(mode);

        assert.equal(calls.length, 1, 'exactly one POST /work-mode');
        const { url, init } = calls[0];
        assert.ok(String(url).endsWith('/work-mode'), 'posts to /work-mode');
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.authorization, `Bearer ${BEARER}`, 'carries the Bearer (Req 10.4)');
        const sent = JSON.parse(init.body);
        assert.equal(sent.mode, mode, 'posts the SELECTED mode value');
        assert.equal(sent.projectId, 'proj-25', 'carries the open session projectId');
        assert.equal(out.ok, true, 'a supported switch resolves ok');
        return true;
      }),
      fcConfig,
    );
  },
);

// -------------------------------------------- Mutation / test-quality guard

test('Property 25 guard: the posted value is the SELECTED one, not a constant', async () => {
  const store = createStore();
  const { fetchImpl, calls } = recordingFetch(200, ({ init }) => {
    const sent = JSON.parse(init.body);
    return { type: 'workspace_experience', experience: sent.experience, layout: {} };
  });
  const api = createApiClient({ getToken: () => BEARER, fetchImpl });
  const workspace = createWorkspaceController({ store, api });
  await workspace.select('technical-workbench');
  assert.equal(JSON.parse(calls[0].init.body).experience, 'technical-workbench');
  assert.notEqual(JSON.parse(calls[0].init.body).experience, 'kiro-style', 'not a hardcoded constant');
});
