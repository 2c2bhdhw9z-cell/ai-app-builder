/**
 * Builder Server tests (Task 10.2*), validating Req 7.1, 7.2, 8.10.
 *
 * Everything here is hermetic: no external network, no docker, no API key. The
 * server is bound on an ephemeral port (listen 0) and driven with node's global
 * fetch, exactly as plumby's own web tests exercise their server. The
 * AuthService is constructed with a FAKE idpVerifier so we can mint a REAL
 * session token for the authenticated cases, and the Builder_Agent is provided
 * by an INJECTED fake agentFactory so a turn's frames are deterministic. The
 * confirm test wires a REAL CommandGuard (createCommandGuard) with a fake
 * manager.exec and drives a confirm-class command through it, so the server's
 * onConfirmRequest seam fires through the guard's genuine contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createCommandGuard } from '../src/sandbox/index.js';
import { createScriptedProvider } from '../src/engine/plumby.js';

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
 * A fake agent whose send() emits a couple of deterministic events and then
 * resolves. `hold` (a promise) lets a test keep a turn in-flight to exercise
 * the one-turn-per-session and mid-turn-reconnection paths. `onSend` is an
 * optional hook so a test can drive extra behaviour (e.g. a CommandGuard call).
 */
function fakeAgentFactory({ hold, onSend } = {}) {
  return ({ onEvent, onConfirmRequest, commandGuard, projectId }) => {
    const agent = {
      cwd: '/tmp/project',
      async send(text) {
        onEvent({ type: 'assistant_text', text: `echo: ${text}`, streamed: false });
        if (onSend) {
          await onSend({ text, onConfirmRequest, commandGuard, projectId, onEvent });
        }
        if (hold) await hold;
      },
    };
    return { agent };
  };
}

/** Start a server on an ephemeral port; returns base URL + close(). */
async function startServer(opts) {
  const server = createBuilderServer(opts);
  const { port, host } = await server.listen(0, '127.0.0.1');
  const base = `http://${host}:${port}`;
  return { server, base, close: () => server.close() };
}

/** Open an SSE stream and collect frames; returns a reader with helpers. */
async function openEvents(base, projectId, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/events?projectId=${encodeURIComponent(projectId)}`, { headers });
  return res;
}

/**
 * Read decoded SSE frames from a Response body until `predicate(frames)` is
 * satisfied or a byte budget/time is exhausted. Returns the parsed data frames.
 */
async function readFramesUntil(res, predicate, { timeoutMs = 2000, keepOpen = false } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), deadline - Date.now())),
    ]);
    if (chunk.timeout) break;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
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
    if (predicate(frames)) break;
  }
  // Leaving the stream open matters for confirm tests: cancelling drops the last
  // SSE client, which fail-closes any pending confirm before POST /confirm can
  // resolve it. keepOpen returns the live reader so the caller cancels later.
  if (keepOpen) return { frames, reader };
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  return frames;
}

// ----------------------------------------------------------------------- tests

test('unauthenticated GET /events and POST /message are denied with no disclosure', async () => {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory() });
  try {
    const eventsRes = await fetch(`${base}/events?projectId=secret-proj`);
    assert.equal(eventsRes.status, 401);
    const eventsBody = await eventsRes.json();
    assert.deepEqual(eventsBody, { error: 'access denied' });
    // No project existence/contents disclosure anywhere in the response.
    assert.ok(!JSON.stringify(eventsBody).includes('secret-proj'));

    const msgRes = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'secret-proj', text: 'hi' }),
    });
    assert.equal(msgRes.status, 401);
    const msgBody = await msgRes.json();
    assert.deepEqual(msgBody, { error: 'access denied' });
    assert.ok(!JSON.stringify(msgBody).includes('secret-proj'));

    // A bogus bearer token is also denied, indistinguishably.
    const bogus = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify({ projectId: 'secret-proj', text: 'hi' }),
    });
    assert.equal(bogus.status, 401);
    assert.deepEqual(await bogus.json(), { error: 'access denied' });
  } finally {
    await close();
  }
});

test('authenticated POST /message returns 202 and the turn frames stream over SSE', async () => {
  const { authService, token } = await authWithToken();
  const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory() });
  try {
    // Open the SSE stream first so we catch the turn frames.
    const events = await openEvents(base, 'proj-1', token);
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type'), /text\/event-stream/);

    const framesP = readFramesUntil(events, (f) => f.some((x) => x.type === 'turn_done'));

    const msgRes = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'proj-1', text: 'build me a thing' }),
    });
    assert.equal(msgRes.status, 202);
    // The turn does NOT stream over the POST body — only an accept ack.
    assert.deepEqual(await msgRes.json(), { accepted: true });

    const frames = await framesP;
    assert.ok(frames.some((f) => f.type === 'turn_start'), 'turn_start streamed');
    assert.ok(
      frames.some((f) => f.type === 'assistant_text' && f.text === 'echo: build me a thing'),
      'agent frame streamed via toViewEvent',
    );
    assert.ok(frames.some((f) => f.type === 'turn_done' && f.ok === true), 'turn_done streamed');
  } finally {
    await close();
  }
});

test('security headers are present on every response', async () => {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory() });
  try {
    const res = await fetch(`${base}/events?projectId=p`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally {
    await close();
  }
});

test('a second POST /message while a turn runs is refused with 409 and does not start a second turn', async () => {
  const { authService, token } = await authWithToken();
  let sends = 0;
  let releaseHold;
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });
  const agentFactory = ({ onEvent }) => ({
    agent: {
      cwd: '/tmp/p',
      async send(text) {
        sends += 1;
        onEvent({ type: 'assistant_text', text: `echo: ${text}`, streamed: false });
        await hold;
      },
    },
  });
  const { base, close } = await startServer({ authService, agentFactory });
  try {
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const first = await fetch(`${base}/message`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-2', text: 'one' }),
    });
    assert.equal(first.status, 202);

    // Give the background turn a tick to set running.
    await new Promise((r) => setTimeout(r, 20));

    const second = await fetch(`${base}/message`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-2', text: 'two' }),
    });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.match(body.error, /already running/i);

    // Only ONE turn was ever started.
    assert.equal(sends, 1);
  } finally {
    releaseHold();
    await close();
  }
});

test('a client connecting to /events mid-turn receives turn_state running:true and turn_start', async () => {
  const { authService, token } = await authWithToken();
  let releaseHold;
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory({ hold }),
  });
  try {
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    // Start a turn WITHOUT any SSE client connected yet.
    const started = await fetch(`${base}/message`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-3', text: 'go' }),
    });
    assert.equal(started.status, 202);
    await new Promise((r) => setTimeout(r, 20));

    // Now connect mid-turn: reconnection frames must reflect the running turn.
    const events = await openEvents(base, 'proj-3', token);
    const frames = await readFramesUntil(
      events,
      (f) => f.some((x) => x.type === 'turn_start'),
      { timeoutMs: 1000 },
    );
    assert.ok(
      frames.some((f) => f.type === 'turn_state' && f.running === true),
      'turn_state running:true on reconnect',
    );
    assert.ok(frames.some((f) => f.type === 'turn_start'), 'turn_start on reconnect');
  } finally {
    releaseHold();
    await close();
  }
});

test('confirm resolution: approved:true lets the guarded command proceed via the real CommandGuard seam', async () => {
  const { authService, token } = await authWithToken();

  // A real CommandGuard over a fake manager.exec. A confirm-class command
  // (git push --force) exercises the guard's confirm branch.
  let execCalls = 0;
  const manager = {
    async exec() {
      execCalls += 1;
      return { executed: true, denied: false, exitCode: 0, stdout: 'pushed', stderr: '' };
    },
  };
  const commandGuard = createCommandGuard({ manager });

  // Capture the guard's structured result so we can assert it proceeded.
  let guardResult = null;
  const onSend = async ({ commandGuard: guard, onConfirmRequest, projectId }) => {
    guardResult = await guard.run(projectId, 'git push --force', { onConfirmRequest });
  };

  const { base, close } = await startServer({
    authService,
    commandGuard,
    agentFactory: fakeAgentFactory({ onSend }),
  });
  try {
    const events = await openEvents(base, 'proj-4', token);
    // Collect frames including the confirm_request; keep the stream open so the
    // pending confirm is not fail-closed by a client disconnect.
    const confirmFramesP = readFramesUntil(
      events,
      (f) => f.some((x) => x.type === 'confirm_request'),
      { keepOpen: true },
    );

    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const msg = await fetch(`${base}/message`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-4', text: 'push it' }),
    });
    assert.equal(msg.status, 202);

    const { frames, reader } = await confirmFramesP;
    const cr = frames.find((f) => f.type === 'confirm_request');
    assert.ok(cr, 'confirm_request streamed');
    assert.ok(typeof cr.requestId === 'string' && cr.requestId.length > 0, 'confirm has requestId');

    // Approve it.
    const confirmed = await fetch(`${base}/confirm`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-4', requestId: cr.requestId, approved: true }),
    });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(await confirmed.json(), { ok: true });

    // The turn's guarded command must have proceeded.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(execCalls, 1, 'guarded command executed after approval');
    assert.ok(guardResult && guardResult.executed === true, 'guard result executed');
    assert.equal(guardResult.confirmed, true);
    await reader.cancel().catch(() => {});
  } finally {
    await close();
  }
});

test('confirm resolution: approved:false denies fail-closed via the real CommandGuard seam', async () => {
  const { authService, token } = await authWithToken();

  let execCalls = 0;
  const manager = {
    async exec() {
      execCalls += 1;
      return { executed: true, denied: false, exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const commandGuard = createCommandGuard({ manager });

  let guardResult = null;
  const onSend = async ({ commandGuard: guard, onConfirmRequest, projectId }) => {
    guardResult = await guard.run(projectId, 'git push --force', { onConfirmRequest });
  };

  const { base, close } = await startServer({
    authService,
    commandGuard,
    agentFactory: fakeAgentFactory({ onSend }),
  });
  try {
    const events = await openEvents(base, 'proj-5', token);
    const confirmFramesP = readFramesUntil(
      events,
      (f) => f.some((x) => x.type === 'confirm_request'),
      { keepOpen: true },
    );

    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const msg = await fetch(`${base}/message`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-5', text: 'push it' }),
    });
    assert.equal(msg.status, 202);

    const { frames, reader } = await confirmFramesP;
    const cr = frames.find((f) => f.type === 'confirm_request');
    assert.ok(cr, 'confirm_request streamed');

    // Deny it.
    const denied = await fetch(`${base}/confirm`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-5', requestId: cr.requestId, approved: false }),
    });
    assert.equal(denied.status, 200);

    await new Promise((r) => setTimeout(r, 50));
    // The guarded command must NOT have run — state unchanged (fail-closed).
    assert.equal(execCalls, 0, 'guarded command did not execute after denial');
    assert.ok(guardResult && guardResult.executed === false, 'guard result not executed');
    assert.ok(guardResult.denied === true, 'guard result denied');
    await reader.cancel().catch(() => {});
  } finally {
    await close();
  }
});

test('POST /confirm for an unknown requestId is 404', async () => {
  const { authService, token } = await authWithToken();
  const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory() });
  try {
    // Create a session first via an SSE connection so it exists.
    await openEvents(base, 'proj-6', token);
    const res = await fetch(`${base}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'proj-6', requestId: 'nope', approved: true }),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('POST /confirm without auth is denied with no disclosure', async () => {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory() });
  try {
    const res = await fetch(`${base}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'secret', requestId: 'x', approved: true }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'access denied' });
  } finally {
    await close();
  }
});

// -------------------------------------------------- audit H13: default agent path

test('H13: constructing with neither agentFactory nor provider fails fast', () => {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  assert.throws(
    () => createBuilderServer({ authService }),
    /requires either an agentFactory or a provider/,
    'the default agent path needs a provider; failing at construction, not mid-request',
  );
});

test('H13: with a REAL provider the DEFAULT agent factory builds a real plumby agent and /message works', async () => {
  const { authService, token } = await authWithToken();
  // A REAL plumby provider (scripted) through the boundary — NOT an injected
  // agentFactory. Pre-fix, defaultAgentFactory called createAgent with no
  // provider, which threw, so the default /message path always 500'd. This
  // exercises the REAL defaultAgentFactory -> real createAgent -> real loop.
  const provider = createScriptedProvider([{ text: 'built it' }]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-bs-h13-'));
  const { base, close } = await startServer({
    authService,
    provider,
    // Resolve the project cwd to a real temp dir so the agent has a workspace.
    layout: { exportableProjectTree: () => cwd },
  });
  try {
    const events = await openEvents(base, 'proj-h13', token);
    assert.equal(events.status, 200);
    const framesP = readFramesUntil(events, (f) => f.some((x) => x.type === 'turn_done'));

    const msgRes = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'proj-h13', text: 'make an app' }),
    });
    // The real default path no longer 500s: it accepts and streams the turn.
    assert.equal(msgRes.status, 202);

    const frames = await framesP;
    assert.ok(frames.some((f) => f.type === 'turn_start'), 'turn_start streamed');
    assert.ok(frames.some((f) => f.type === 'turn_done' && f.ok === true), 'turn completed OK via the real agent');
    assert.ok(
      frames.some((f) => f.type === 'assistant_text' && /built it/.test(f.text ?? '')),
      'the real scripted provider drove the loop to a text frame',
    );
  } finally {
    await close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
