/**
 * Builder Server Work_Mode surface tests (Task 32.4, Req 28.1-28.7).
 *
 * Exercises the REAL builder-server harness (ephemeral port + node's global
 * fetch, the REAL gate/auth from createAuthService + a real minted session
 * token) and the REAL confirm resolver (session.onConfirmRequest + POST
 * /confirm). No mocks of the confirm surface, no real browser — the SSE surface
 * is driven purely as a SEAM via fetch. The confirm ceiling is driven by an
 * injected clock / a small confirmTimeoutMs and by resolving through the REAL
 * resolver, NEVER by sleeping toward 60s.
 *
 * State preservation (case 5) uses REAL non-mode state: a real
 * WorkspaceExperienceStore over an fs.mkdtemp StorageLayout with a persisted
 * experience document, snapshotted BYTE-FOR-BYTE before/after a confirmed
 * switch.
 *
 * Covers the six Task 32.4 cases, each FAILING if the fix is reverted:
 *   (1) all three modes offered at creation (GET /work-mode choices);
 *   (2) vibe default when unselected;
 *   (3) the Session_Header ALWAYS shows the active mode (reconnection frame),
 *       reflecting the current mode after a confirmed switch;
 *   (4) an UNCONFIRMED switch is NOT applied (and a denied confirm leaves it);
 *   (5) a CONFIRMED switch changes ONLY the mode and PRESERVES real state;
 *   (6) out-of-enum rejected leaving the current mode in effect, no confirm.
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
 * A fake agent whose send() RECORDS that it was called and THROWS — a Work_Mode
 * POST must NEVER enqueue a loop turn, so send() must never fire. `sends` is a
 * shared counter the test asserts stays at 0.
 */
function noTurnAgentFactory(state) {
  return ({ onEvent }) => ({
    agent: {
      cwd: '/tmp/project',
      async send() {
        state.sends += 1;
        throw new Error('agent.send must never be called by a work-mode POST');
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
 * read loop (a timeout-race pump can miss buffered frames). Returns
 * { frames, stop() } — the caller stops it when done. Keeping the stream open
 * matters for confirm tests: cancelling drops the last SSE client, which
 * fail-closes any pending confirm before POST /confirm can resolve it.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wmode-srv-'));
  const layout = createStorageLayout(dir);
  const store = createWorkspaceExperienceStore({ layout });
  return { dir, layout, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Perform a REAL confirm round-trip for a Work_Mode switch: open an /events
 * stream, POST /work-mode {mode}, read the confirm_request requestId off the
 * OPEN SSE stream, then POST /confirm with that requestId + approved. Returns
 * the POST /work-mode response body (JSON) once it settles.
 */
async function switchWithConfirm({ base, token, projectId, mode, approved, reader }) {
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const before = reader.frames.length;
  // Fire the switch; the handler awaits the confirm, so DO NOT await this yet.
  const switchP = fetch(`${base}/work-mode`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ projectId, mode }),
  });
  // Read the confirm_request requestId off the still-open stream.
  const got = await waitFor(reader.frames, (f) =>
    f.slice(before).some((x) => x.type === 'confirm_request' && x.category === 'work_mode_switch'),
  );
  assert.ok(got, 'a work_mode_switch confirm_request was broadcast');
  const cr = reader.frames
    .slice(before)
    .find((x) => x.type === 'confirm_request' && x.category === 'work_mode_switch');
  assert.ok(typeof cr.requestId === 'string' && cr.requestId.length > 0, 'confirm has requestId');

  const confirmed = await fetch(`${base}/confirm`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ projectId, requestId: cr.requestId, approved }),
  });
  assert.equal(confirmed.status, 200);

  const switchRes = await switchP;
  assert.equal(switchRes.status, 200);
  return { body: await switchRes.json(), requestId: cr.requestId };
}

/** GET /work-mode as an authenticated client; returns the parsed frame. */
async function getWorkMode(base, token, projectId) {
  const res = await fetch(`${base}/work-mode?projectId=${encodeURIComponent(projectId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

// ----------------------------------------------------------------------- tests

test('(1) all three modes are offered at creation via GET /work-mode', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  const { base, close } = await startServer({ authService, agentFactory: noTurnAgentFactory(state) });
  try {
    const { status, body } = await getWorkMode(base, token, 'proj-1');
    assert.equal(status, 200);
    assert.equal(body.type, 'work_mode');
    // Mutation-sensitive: exactly the three creation choices in order.
    assert.deepStrictEqual(body.choices, ['vibe', 'spec', 'hybrid']);
    assert.equal(state.sends, 0);
  } finally {
    await close();
  }
});

test('(2) a fresh Session defaults to vibe when unselected', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  const { base, close } = await startServer({ authService, agentFactory: noTurnAgentFactory(state) });
  try {
    // Via GET.
    const { body } = await getWorkMode(base, token, 'proj-2');
    assert.equal(body.mode, 'vibe');

    // Via the /events reconnection frame.
    const events = await openEvents(base, 'proj-2', token);
    const reader = startFrameReader(events);
    const gotHeader = await waitFor(reader.frames, (f) =>
      f.some((x) => x.type === 'session_header'),
    );
    assert.ok(gotHeader, 'a session_header reconnection frame was pushed');
    const header = reader.frames.find((x) => x.type === 'session_header');
    assert.equal(header.workMode, 'vibe');
    const wm = reader.frames.find((x) => x.type === 'work_mode');
    assert.equal(wm.mode, 'vibe');
    await reader.stop();
  } finally {
    await close();
  }
});

test('(3) the Session_Header always shows the active mode, reflecting the current mode after a confirmed switch', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  const { base, close } = await startServer({ authService, agentFactory: noTurnAgentFactory(state) });
  try {
    // A first /events client sees the default header immediately (always present).
    const events = await openEvents(base, 'proj-3', token);
    const reader = startFrameReader(events);
    await waitFor(reader.frames, (f) => f.some((x) => x.type === 'session_header'));
    assert.equal(reader.frames.find((x) => x.type === 'session_header').workMode, 'vibe');

    // Confirm a switch to 'spec'.
    const { body } = await switchWithConfirm({
      base,
      token,
      projectId: 'proj-3',
      mode: 'spec',
      approved: true,
      reader,
    });
    assert.equal(body.applied, true);
    assert.equal(body.mode, 'spec');

    // The header broadcast reflects the new active mode.
    const gotSpecHeader = await waitFor(reader.frames, (f) =>
      f.some((x) => x.type === 'session_header' && x.workMode === 'spec'),
    );
    assert.ok(gotSpecHeader, 'session_header broadcast now carries spec');

    // A LATER (re)connecting client ALWAYS learns the active mode is now spec.
    const events2 = await openEvents(base, 'proj-3', token);
    const reader2 = startFrameReader(events2);
    const gotReconnect = await waitFor(reader2.frames, (f) =>
      f.some((x) => x.type === 'session_header'),
    );
    assert.ok(gotReconnect, 'reconnecting client gets a session_header');
    assert.equal(reader2.frames.find((x) => x.type === 'session_header').workMode, 'spec');

    assert.equal(state.sends, 0);
    await reader.stop();
    await reader2.stop();
  } finally {
    await close();
  }
});

test('(4) an unconfirmed switch is NOT applied; a denied confirm leaves the mode', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  // Small confirm ceiling so the no-answer path never sleeps toward 60s; here we
  // resolve through the REAL resolver, so it is not exercised, but the seam is
  // driven deterministically.
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    confirmTimeoutMs: 500,
  });
  try {
    const events = await openEvents(base, 'proj-4', token);
    const reader = startFrameReader(events);
    await waitFor(reader.frames, (f) => f.some((x) => x.type === 'session_header'));

    // Fire a switch request but do NOT confirm it yet — assert the mode stays
    // 'vibe' while only a confirm_request has been broadcast.
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const switchP = fetch(`${base}/work-mode`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-4', mode: 'spec' }),
    });
    const gotReq = await waitFor(reader.frames, (f) =>
      f.some((x) => x.type === 'confirm_request' && x.category === 'work_mode_switch'),
    );
    assert.ok(gotReq, 'confirm_request broadcast for the pending switch');
    // BEFORE any confirm arrives, the active mode is still vibe (mutation check:
    // flips if a switch were applied without confirmation).
    const midway = await getWorkMode(base, token, 'proj-4');
    assert.equal(midway.body.mode, 'vibe', 'mode must NOT change before confirmation');

    // Now DENY the confirm.
    const cr = reader.frames.find(
      (x) => x.type === 'confirm_request' && x.category === 'work_mode_switch',
    );
    const denied = await fetch(`${base}/confirm`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-4', requestId: cr.requestId, approved: false }),
    });
    assert.equal(denied.status, 200);
    const switchRes = await switchP;
    const switchBody = await switchRes.json();
    assert.equal(switchBody.applied, false, 'a denied switch is not applied');
    assert.equal(switchBody.mode, 'vibe');

    // Still vibe after the denial.
    const after = await getWorkMode(base, token, 'proj-4');
    assert.equal(after.body.mode, 'vibe', 'denied confirm leaves the mode vibe');
    assert.equal(state.sends, 0);
    await reader.stop();
  } finally {
    await close();
  }
});

test('(5) a confirmed switch changes ONLY the mode and preserves real non-mode state byte-for-byte', async () => {
  const { authService, account, token } = await authWithToken();
  const { store, layout, cleanup } = mkStore();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    workspaceExperienceStore: store,
  });
  try {
    // Populate REAL non-mode state: persist a Workspace_Experience selection for
    // this account so a meaningful control-plane document exists on disk.
    const sel = store.select(account.id, 'technical-workbench');
    assert.equal(sel.ok, true);
    const settingsPath = layout.controlPresentationSettingsPath(account.id);
    const before = fs.readFileSync(settingsPath); // Buffer — byte-for-byte snapshot.
    assert.ok(before.length > 0, 'a real presentation document is on disk');

    // Open a stream and confirm a switch vibe -> hybrid.
    const events = await openEvents(base, 'proj-5', token);
    const reader = startFrameReader(events);
    await waitFor(reader.frames, (f) => f.some((x) => x.type === 'session_header'));

    const pre = await getWorkMode(base, token, 'proj-5');
    assert.equal(pre.body.mode, 'vibe');

    const { body } = await switchWithConfirm({
      base,
      token,
      projectId: 'proj-5',
      mode: 'hybrid',
      approved: true,
      reader,
    });
    assert.equal(body.applied, true);
    assert.equal(body.mode, 'hybrid');

    // The mode DID change (non-vacuous): the switch is real.
    const post = await getWorkMode(base, token, 'proj-5');
    assert.equal(post.body.mode, 'hybrid', 'mode changed after confirmation');

    // ALL real non-mode state is byte-for-byte unchanged.
    const after = fs.readFileSync(settingsPath);
    assert.ok(before.equals(after), 'presentation document is byte-for-byte unchanged');
    // The persisted experience is still exactly what it was.
    assert.equal(store.get(account.id), 'technical-workbench');

    assert.equal(state.sends, 0);
    await reader.stop();
  } finally {
    await close();
    cleanup();
  }
});

test('(6) an out-of-enum switch is rejected 400 leaving the current mode; no confirm minted', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  const { base, close } = await startServer({ authService, agentFactory: noTurnAgentFactory(state) });
  try {
    const events = await openEvents(base, 'proj-6', token);
    const reader = startFrameReader(events);
    await waitFor(reader.frames, (f) => f.some((x) => x.type === 'session_header'));

    // First apply a real, confirmed switch to 'spec' so the "current mode" is a
    // non-default value the rejection must preserve.
    const first = await switchWithConfirm({
      base,
      token,
      projectId: 'proj-6',
      mode: 'spec',
      approved: true,
      reader,
    });
    assert.equal(first.body.mode, 'spec');
    const framesBefore = reader.frames.length;

    // Now an out-of-enum mode.
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const bad = await fetch(`${base}/work-mode`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-6', mode: 'plan' }),
    });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.code, 'unsupported_work_mode');
    // The response reports the STILL-CURRENT mode so a client can confirm nothing changed.
    assert.ok(body.current && body.current.type === 'work_mode');
    assert.equal(body.current.mode, 'spec');

    // No confirm_request was minted for the bad mode (mutation check).
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      !reader.frames.slice(framesBefore).some((x) => x.type === 'confirm_request'),
      'out-of-enum mode mints NO confirm_request',
    );

    // The current mode is still spec.
    const after = await getWorkMode(base, token, 'proj-6');
    assert.equal(after.body.mode, 'spec', 'out-of-enum rejection leaves the current mode');
    assert.equal(state.sends, 0);
    await reader.stop();
  } finally {
    await close();
  }
});
