/**
 * Builder Server Workspace_Experience surface tests (Task 31.4, Req 27).
 *
 * Exercises the REAL builder-server harness (ephemeral port + node's global
 * fetch, the REAL gate/auth) with a REAL WorkspaceExperienceStore built on a
 * REAL StorageLayout over an fs.mkdtemp temp dir. No mocks of the store, no real
 * browser — the SSE surface is driven as a SEAM via fetch only.
 *
 * It proves: unauthenticated GET/POST get the generic non-disclosing 401; an
 * authenticated POST with a valid experience returns 200, persists, and a
 * connected /events client receives a LAYOUT-ONLY workspace_experience frame
 * with NO turn_start/turn_done and WITHOUT the agent ever being sent to (no loop
 * turn, session.running never set); an out-of-enum value returns 400 unsupported
 * with the current experience left in effect; with NO store injected the route
 * is not enabled (405, strict additivity); and technical-workbench broadcasts
 * the presentational 'Inspired by tools like Kiro' credit as DATA on a
 * layout-only descriptor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createWorkspaceExperienceStore } from '../src/presentation/index.js';
import { WORKBENCH_ATTRIBUTION } from '../src/presentation/index.js';

// ---------------------------------------------------------------- test harness

/** A fake IdP verifier: any idToken maps to a stable subject. */
function fakeIdp(subject = 'user-1') {
  return {
    async verifyIdToken(idToken) {
      if (!idToken) throw new Error('no token');
      return { provider: 'github', subject: `${subject}:${idToken}` };
    },
  };
}

/** Construct an AuthService and mint a real session token for one account. */
async function authWithToken(idToken = 'tok') {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { account } = await authService.authenticate({ idToken });
  const session = authService.scopeSession(account);
  return { authService, account, token: session.token };
}

/**
 * A fake agent whose send() RECORDS that it was called and THROWS — a
 * Workspace_Experience POST must NEVER enqueue a loop turn, so send() must never
 * fire. `sends` is a shared counter the test asserts stays at 0.
 */
function noTurnAgentFactory(state) {
  return ({ onEvent }) => ({
    agent: {
      cwd: '/tmp/project',
      async send() {
        state.sends += 1;
        throw new Error('agent.send must never be called by a workspace-experience POST');
      },
    },
  });
}

/** Start a server on an ephemeral port; returns base URL + close(). */
async function startServer(opts) {
  const server = createBuilderServer(opts);
  const { port, host } = await server.listen(0, '127.0.0.1');
  const base = `http://${host}:${port}`;
  return { server, base, close: () => server.close() };
}

/** Open an SSE stream; returns the Response. */
async function openEvents(base, projectId, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/events?projectId=${encodeURIComponent(projectId)}`, { headers });
}

/**
 * Read decoded SSE frames from a Response body using a CONTINUOUS background
 * read loop (per FEAT-003 findings, a timeout-race pump can miss buffered
 * frames). Returns { frames, stop() } — the caller stops it when done.
 */
function startFrameReader(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let stopped = false;

  (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                frames.push(JSON.parse(line.slice(6)));
              } catch {
                /* ignore non-JSON keepalive */
              }
            }
          }
        }
      }
    } catch {
      /* reader cancelled */
    }
  })();

  return {
    frames,
    async stop() {
      stopped = true;
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Wait until predicate(frames) is true or timeout; returns whether satisfied. */
async function waitFor(frames, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(frames)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate(frames);
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wxp-srv-'));
  const layout = createStorageLayout(dir);
  const store = createWorkspaceExperienceStore({ layout });
  return { dir, layout, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ----------------------------------------------------------------------- tests

test('(a) unauthenticated GET/POST /workspace-experience get the generic access-denied', async () => {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { store, cleanup } = mkStore();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    workspaceExperienceStore: store,
  });
  try {
    const getRes = await fetch(`${base}/workspace-experience`);
    assert.equal(getRes.status, 401);
    assert.deepEqual(await getRes.json(), { error: 'access denied' });

    const postRes = await fetch(`${base}/workspace-experience`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ experience: 'vibe-first' }),
    });
    assert.equal(postRes.status, 401);
    assert.deepEqual(await postRes.json(), { error: 'access denied' });

    // A bogus bearer token is denied indistinguishably.
    const bogus = await fetch(`${base}/workspace-experience`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-real' },
      body: JSON.stringify({ experience: 'vibe-first' }),
    });
    assert.equal(bogus.status, 401);
  } finally {
    await close();
    cleanup();
  }
});

test('(b) authenticated POST valid -> 200, persists, broadcasts a layout-only frame with NO turn', async () => {
  const { authService, account, token } = await authWithToken();
  const { store, cleanup } = mkStore();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    workspaceExperienceStore: store,
  });
  try {
    // A live /events client for this account (any projectId — presentation is per-account).
    const events = await openEvents(base, 'proj-b', token);
    assert.equal(events.status, 200);
    const reader = startFrameReader(events);
    // Let the reconnection frames flush.
    await new Promise((r) => setTimeout(r, 30));

    const postRes = await fetch(`${base}/workspace-experience`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ experience: 'vibe-first' }),
    });
    assert.equal(postRes.status, 200);
    const bodyFrame = await postRes.json();
    assert.equal(bodyFrame.type, 'workspace_experience');
    assert.equal(bodyFrame.experience, 'vibe-first');
    assert.ok(bodyFrame.layout && bodyFrame.layout.surfaces, 'response carries a layout descriptor');
    // Layout-only: no non-layout fields leaked onto the frame.
    for (const key of ['theme', 'workMode', 'project', 'models', 'skills', 'connectors', 'permissions', 'origin']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(bodyFrame, key), `frame must not carry ${key}`);
    }

    // Persisted per account.
    assert.equal(store.get(account.id), 'vibe-first');

    // The connected client received the layout-only broadcast frame.
    const gotFrame = await waitFor(
      reader.frames,
      (f) => f.some((x) => x.type === 'workspace_experience' && x.experience === 'vibe-first'),
    );
    assert.ok(gotFrame, 'a workspace_experience frame was broadcast to the live client');

    // NO loop turn: agent.send never fired, and no turn frames were broadcast.
    assert.equal(state.sends, 0, 'agent.send must never be called');
    assert.ok(!reader.frames.some((f) => f.type === 'turn_start'), 'no turn_start');
    assert.ok(!reader.frames.some((f) => f.type === 'turn_done'), 'no turn_done');
    assert.ok(
      !reader.frames.some((f) => f.type === 'turn_state' && f.running === true),
      'session.running never set',
    );

    await reader.stop();
  } finally {
    await close();
    cleanup();
  }
});

test('(c) authenticated POST out-of-enum -> 400 unsupported, current left in effect', async () => {
  const { authService, account, token } = await authWithToken();
  const { store, cleanup } = mkStore();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    workspaceExperienceStore: store,
  });
  try {
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    // Establish a valid current experience.
    const ok = await fetch(`${base}/workspace-experience`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ experience: 'mobile-command-center' }),
    });
    assert.equal(ok.status, 200);

    // Now an out-of-enum value.
    const bad = await fetch(`${base}/workspace-experience`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ experience: 'ide' }),
    });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.code, 'unsupported_experience');
    // The response reports the STILL-CURRENT experience so a client can confirm nothing changed.
    assert.ok(body.current && body.current.type === 'workspace_experience');
    assert.equal(body.current.experience, 'mobile-command-center');

    // On disk the current experience is unchanged.
    assert.equal(store.get(account.id), 'mobile-command-center');
    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

test('(d) with NO store injected the /workspace-experience route is not enabled (405 — strict additivity)', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  // NOTE: no workspaceExperienceStore injected.
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
  });
  try {
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const getRes = await fetch(`${base}/workspace-experience`, { headers: auth });
    assert.equal(getRes.status, 405, 'GET route not enabled without the store');

    const postRes = await fetch(`${base}/workspace-experience`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ experience: 'vibe-first' }),
    });
    assert.equal(postRes.status, 405, 'POST route not enabled without the store');
  } finally {
    await close();
  }
});

test('(e) technical-workbench broadcasts the presentational credit as DATA on a layout-only descriptor', async () => {
  const { authService, token } = await authWithToken();
  const { store, cleanup } = mkStore();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    workspaceExperienceStore: store,
  });
  try {
    const events = await openEvents(base, 'proj-e', token);
    const reader = startFrameReader(events);
    await new Promise((r) => setTimeout(r, 30));

    const postRes = await fetch(`${base}/workspace-experience`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ experience: 'technical-workbench' }),
    });
    assert.equal(postRes.status, 200);
    const frame = await postRes.json();
    assert.equal(frame.experience, 'technical-workbench');
    // The presentational, non-affiliated credit is surfaced as DATA.
    assert.equal(frame.attribution, WORKBENCH_ATTRIBUTION);
    assert.equal(frame.attribution, 'Inspired by tools like Kiro');
    // Still layout-only: no theme/work-mode/project fields.
    for (const key of ['theme', 'workMode', 'project', 'models', 'permissions']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(frame, key), `frame must not carry ${key}`);
    }
    assert.ok(frame.layout && frame.layout.surfaces, 'layout descriptor present');

    // The broadcast frame carried the same credit as data.
    const gotFrame = await waitFor(
      reader.frames,
      (f) => f.some((x) => x.type === 'workspace_experience' && x.experience === 'technical-workbench'),
    );
    assert.ok(gotFrame, 'workspace_experience frame broadcast');
    const broadcast = reader.frames.find(
      (x) => x.type === 'workspace_experience' && x.experience === 'technical-workbench',
    );
    assert.equal(broadcast.attribution, 'Inspired by tools like Kiro');

    // No loop turn.
    assert.equal(state.sends, 0);
    assert.ok(!reader.frames.some((f) => f.type === 'turn_start'));

    await reader.stop();
  } finally {
    await close();
    cleanup();
  }
});
