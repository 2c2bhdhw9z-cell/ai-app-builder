/**
 * Builder Server — Preview surface tests (Task 18.3, Req 4.4, Req 3.1-3.7).
 *
 * These validate that the PreviewController from Task 18.1/18.2 is reachable as
 * a first-class, client-visible surface through the Builder Server, WITHOUT
 * adding a second auth path or a second stream: the EXISTING gate() (authn +
 * authz), the EXISTING per-(account,project) Session, and the EXISTING SSE
 * stream that carries the Activity_Stream are reused. Everything is hermetic:
 * the real node:http server is bound on an ephemeral port (listen 0) and driven
 * with node's built-in fetch, exactly as test/builder-server.test.js does. The
 * AuthService is real (a fake IdP mints a real session token); the
 * PreviewController is an INJECTED fake that records calls and returns
 * deterministic servedPreview/restart results so the wiring — not the
 * controller's own logic (covered by preview-controller.test.js) — is asserted.
 *
 * Coverage:
 *   - authenticated GET /preview returns the served Preview handle;
 *   - UNAUTHENTICATED and unauthorized-project GET /preview both return the
 *     IDENTICAL non-disclosing 401 ACCESS_DENIED (no existence/contents leak);
 *   - POST /preview/restart invokes the controller and surfaces a
 *     persistent-failure after 3 failed attempts;
 *   - a GET /events client receives a preview_status frame CONCURRENTLY with
 *     turn/activity frames on ONE stream (proving Req 4.4);
 *   - with NO previewController injected, GET /preview and POST /preview/restart
 *     are NOT routed (405) and prior behavior is unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';

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
 * A fake agent whose send() emits a deterministic activity frame then resolves.
 * Used only to prove the Activity_Stream and the Preview status share ONE
 * stream (Req 4.4).
 */
function fakeAgentFactory() {
  return ({ onEvent }) => ({
    agent: {
      cwd: '/tmp/project',
      async send(text) {
        onEvent({ type: 'assistant_text', text: `echo: ${text}`, streamed: false });
      },
    },
  });
}

/**
 * A fake PreviewController that records calls and returns deterministic results.
 *
 * @param {object} opts
 * @param {object} [opts.served]  the servedPreview(projectId) handle to return
 * @param {object[]} [opts.restartResults]  successive restart(...) results, one
 *        per call (the last is repeated if calls exceed the array length)
 */
function fakePreviewController({ served, restartResults = [] } = {}) {
  const calls = { servedPreview: [], restart: [] };
  return {
    calls,
    servedPreview(projectId) {
      calls.servedPreview.push(projectId);
      return (
        served ?? {
          snapshotId: 'snap-1',
          url: 'http://preview.local/p',
          status: 'served',
          showingPrior: false,
          buildError: null,
          building: null,
        }
      );
    },
    restart(args) {
      calls.restart.push(args);
      const i = Math.min(calls.restart.length - 1, restartResults.length - 1);
      return restartResults[i] ?? { ok: true, status: 'ready', attempt: calls.restart.length, url: 'http://preview.local/p' };
    },
  };
}

/** Start a server on an ephemeral port; returns base URL + close(). */
async function startServer(opts) {
  const server = createBuilderServer(opts);
  const { port, host } = await server.listen(0, '127.0.0.1');
  const base = `http://${host}:${port}`;
  return { server, base, close: () => server.close() };
}

/** Open an SSE stream. */
async function openEvents(base, projectId, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/events?projectId=${encodeURIComponent(projectId)}`, { headers });
}

/** Read decoded SSE data frames until predicate is satisfied or time runs out. */
async function readFramesUntil(res, predicate, { timeoutMs = 2000 } = {}) {
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
    if (chunk.timeout || chunk.done) break;
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
            /* ignore keepalive */
          }
        }
      }
    }
    if (predicate(frames)) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  return frames;
}

// ----------------------------------------------------------------------- tests

test('authenticated GET /preview returns the served Preview handle', async () => {
  const { authService, token } = await authWithToken();
  const served = {
    snapshotId: 'snap-42',
    url: 'http://preview.local/proj-p1',
    status: 'served',
    showingPrior: false,
    buildError: null,
    building: null,
  };
  const previewController = fakePreviewController({ served });
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory(),
    previewController,
  });
  try {
    const res = await fetch(`${base}/preview?projectId=proj-p1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { preview: served });
    // The controller was consulted for exactly this project.
    assert.deepEqual(previewController.calls.servedPreview, ['proj-p1']);
  } finally {
    await close();
  }
});

test('GET /preview without a projectId query param is 400', async () => {
  const { authService, token } = await authWithToken();
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory(),
    previewController: fakePreviewController(),
  });
  try {
    const res = await fetch(`${base}/preview`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /projectId/);
  } finally {
    await close();
  }
});

test('unauthenticated and unauthorized-project GET /preview both return the identical non-disclosing 401', async () => {
  // Unauthenticated: no token at all.
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const previewController = fakePreviewController();
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory(),
    previewController,
  });
  try {
    const unauth = await fetch(`${base}/preview?projectId=secret-proj`);
    assert.equal(unauth.status, 401);
    const unauthBody = await unauth.json();
    assert.deepEqual(unauthBody, { error: 'access denied' });
    // No project existence/contents disclosure.
    assert.ok(!JSON.stringify(unauthBody).includes('secret-proj'));
    // The controller was never consulted for an unauthenticated request.
    assert.equal(previewController.calls.servedPreview.length, 0);
  } finally {
    await close();
  }

  // Unauthorized-project: a REAL token, but a projectResolver that denies the
  // project. The 401 body must be byte-identical to the unauthenticated case.
  const { authService: authService2, token } = await authWithToken();
  const previewController2 = fakePreviewController();
  const { base: base2, close: close2 } = await startServer({
    authService: authService2,
    agentFactory: fakeAgentFactory(),
    previewController: previewController2,
    // Resolve the project to an OWNER that is not this account -> authz denies.
    projectResolver: () => ({ id: 'secret-proj', ownerId: 'someone-else' }),
  });
  try {
    const forbidden = await fetch(`${base2}/preview?projectId=secret-proj`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(forbidden.status, 401);
    const forbiddenBody = await forbidden.json();
    assert.deepEqual(forbiddenBody, { error: 'access denied' });
    assert.ok(!JSON.stringify(forbiddenBody).includes('secret-proj'));
    // The controller was never consulted for an unauthorized project.
    assert.equal(previewController2.calls.servedPreview.length, 0);
  } finally {
    await close2();
  }
});

test('POST /preview/restart invokes the controller and returns the restart result', async () => {
  const { authService, token } = await authWithToken();
  const previewController = fakePreviewController({
    restartResults: [{ ok: true, status: 'ready', attempt: 1, url: 'http://preview.local/proj-r1' }],
  });
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory(),
    previewController,
  });
  try {
    const res = await fetch(`${base}/preview/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'proj-r1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.restart, { ok: true, status: 'ready', attempt: 1, url: 'http://preview.local/proj-r1' });
    // The controller.restart was invoked with the projectId.
    assert.equal(previewController.calls.restart.length, 1);
    assert.equal(previewController.calls.restart[0].projectId, 'proj-r1');
  } finally {
    await close();
  }
});

test('POST /preview/restart surfaces a persistent-failure after the 3-attempt cap', async () => {
  const { authService, token } = await authWithToken();
  // 3 failed attempts, then a persistent-failure on the 4th call (the cap).
  const previewController = fakePreviewController({
    restartResults: [
      { ok: false, code: 'RESTART_FAILED', message: 'boom', attempt: 1, restartOffered: true },
      { ok: false, code: 'RESTART_FAILED', message: 'boom', attempt: 2, restartOffered: true },
      { ok: false, code: 'RESTART_FAILED', message: 'boom', attempt: 3, restartOffered: false },
      {
        ok: false,
        code: 'PERSISTENT_FAILURE',
        message: 'Dev_Server failed to restart after 3 attempts for project proj-r2; no further automatic restarts',
        attempts: 3,
        restartOffered: false,
      },
    ],
  });
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory(),
    previewController,
  });
  try {
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    let lastBody;
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(`${base}/preview/restart`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ projectId: 'proj-r2' }),
      });
      assert.equal(res.status, 200);
      lastBody = await res.json();
    }
    // The 4th call is the persistent-failure the client is shown.
    assert.equal(lastBody.restart.ok, false);
    assert.equal(lastBody.restart.code, 'PERSISTENT_FAILURE');
    assert.equal(lastBody.restart.restartOffered, false);
    assert.equal(previewController.calls.restart.length, 4);
  } finally {
    await close();
  }
});

test('unauthenticated POST /preview/restart is denied with no disclosure', async () => {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const previewController = fakePreviewController();
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory(),
    previewController,
  });
  try {
    const res = await fetch(`${base}/preview/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'secret-proj' }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'access denied' });
    assert.equal(previewController.calls.restart.length, 0);
  } finally {
    await close();
  }
});

test('a /events client receives a preview_status frame CONCURRENTLY with turn/activity frames on one stream (Req 4.4)', async () => {
  const { authService, token } = await authWithToken();
  const previewController = fakePreviewController({
    served: {
      snapshotId: 'snap-live',
      url: 'http://preview.local/proj-c1',
      status: 'served',
      showingPrior: false,
      buildError: null,
      building: null,
    },
  });
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory(),
    previewController,
  });
  try {
    // Connect the SSE stream first — its reconnection frames carry the CURRENT
    // preview_status (Req 4.4: preview status is present on the SAME stream).
    const events = await openEvents(base, 'proj-c1', token);
    assert.equal(events.status, 200);

    // Drive a turn so an Activity_Stream frame flows on the SAME stream, then
    // wait until BOTH a preview_status AND an activity/turn frame have arrived.
    const framesP = readFramesUntil(
      events,
      (f) => f.some((x) => x.type === 'preview_status') && f.some((x) => x.type === 'assistant_text'),
      { timeoutMs: 2000 },
    );

    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const msg = await fetch(`${base}/message`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-c1', text: 'go' }),
    });
    assert.equal(msg.status, 202);

    const frames = await framesP;
    const preview = frames.find((f) => f.type === 'preview_status');
    assert.ok(preview, 'preview_status frame present on the stream');
    // The served status maps onto the client-facing lifecycle vocabulary and
    // carries only SAFE fields.
    assert.equal(preview.status, 'ready');
    assert.equal(preview.snapshotId, 'snap-live');
    assert.equal(preview.url, 'http://preview.local/proj-c1');
    // The Activity_Stream frame is on the SAME stream — concurrency proven.
    assert.ok(
      frames.some((f) => f.type === 'assistant_text' && f.text === 'echo: go'),
      'activity frame on the same stream',
    );
  } finally {
    await close();
  }
});

test('POST /preview/restart broadcasts the resulting lifecycle status on the session SSE stream', async () => {
  const { authService, token } = await authWithToken();
  const previewController = fakePreviewController({
    restartResults: [{ ok: true, status: 'ready', attempt: 1, url: 'http://preview.local/proj-c2' }],
  });
  const { base, close } = await startServer({
    authService,
    agentFactory: fakeAgentFactory(),
    previewController,
  });
  try {
    const events = await openEvents(base, 'proj-c2', token);
    assert.equal(events.status, 200);
    // Collect frames; a restart broadcast should push a preview_status ready.
    const framesP = readFramesUntil(
      events,
      (f) => f.filter((x) => x.type === 'preview_status').length >= 2,
      { timeoutMs: 2000 },
    );

    // Give the SSE reconnection frames a beat, then trigger the restart.
    await new Promise((r) => setTimeout(r, 20));
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const res = await fetch(`${base}/preview/restart`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectId: 'proj-c2' }),
    });
    assert.equal(res.status, 200);

    const frames = await framesP;
    const readyFrames = frames.filter((f) => f.type === 'preview_status' && f.status === 'ready');
    assert.ok(readyFrames.length >= 1, 'a ready preview_status was broadcast after restart');
  } finally {
    await close();
  }
});

test('with NO previewController injected, GET /preview and POST /preview/restart are NOT routed and prior behavior is unchanged', async () => {
  const { authService, token } = await authWithToken();
  const { base, close } = await startServer({ authService, agentFactory: fakeAgentFactory() });
  try {
    const auth = { authorization: `Bearer ${token}` };
    // Not routed -> the server's catch-all 405.
    const preview = await fetch(`${base}/preview?projectId=p`, { headers: auth });
    assert.equal(preview.status, 405);

    const restart = await fetch(`${base}/preview/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'p' }),
    });
    assert.equal(restart.status, 405);

    // Prior behavior unchanged: /events still opens an SSE stream and its
    // reconnection frames do NOT include a preview_status frame.
    const events = await openEvents(base, 'p', token);
    assert.equal(events.status, 200);
    const frames = await readFramesUntil(events, (f) => f.some((x) => x.type === 'turn_state'), {
      timeoutMs: 800,
    });
    assert.ok(frames.some((f) => f.type === 'turn_state'), 'turn_state reconnection frame present');
    assert.ok(!frames.some((f) => f.type === 'preview_status'), 'no preview_status when uninjected');
  } finally {
    await close();
  }
});
