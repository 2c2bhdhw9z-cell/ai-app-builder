/**
 * Builder Server quota-gate integration tests (Task 12, Req 23).
 *
 * These prove the ORDERING invariant of the pre-allocation gate:
 *
 *   security headers -> route -> gate() (authn+authz) -> quotaManager gate ->
 *   session/agent/sandbox allocation -> turn.
 *
 * An over-limit POST /message must return the naming 429 and allocate NOTHING:
 * no Project Session created, no Builder_Agent built, and (critically) the
 * SandboxManager's acquire() never called. And because the quota gate sits
 * strictly AFTER gate(), an UNAUTHENTICATED over-limit request must still get
 * the generic access-denied — no limit disclosure before auth passes.
 *
 * Hermetic: ephemeral port, node fetch, a fake AuthService (real token), a spy
 * SandboxManager, and a spy agentFactory. No docker, no network, no API key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createQuotaManager } from '../src/ops/index.js';

/** A fake IdP verifier: any idToken maps to a stable subject. */
function fakeIdp(subject = 'user-1') {
  return {
    async verifyIdToken(idToken) {
      if (!idToken) throw new Error('no token');
      return { provider: 'github', subject: `${subject}:${idToken}` };
    },
  };
}

async function authWithToken(idToken = 'tok') {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { account } = await authService.authenticate({ idToken });
  const session = authService.scopeSession(account);
  return { authService, account, token: session.token };
}

async function startServer(opts) {
  const server = createBuilderServer(opts);
  const { port, host } = await server.listen(0, '127.0.0.1');
  return { server, base: `http://${host}:${port}`, close: () => server.close() };
}

test('over-Rate_Limit POST /message returns 429 naming the limit and allocates nothing', async () => {
  const { authService, token } = await authWithToken();

  // Spy SandboxManager: acquire must NEVER be called for an over-limit request.
  let acquireCalls = 0;
  const sandboxManager = {
    acquire: (projectId) => {
      acquireCalls += 1;
      return { projectId, mountSource: '/tmp/p' };
    },
    activeProjectIds: () => [],
  };

  // Spy agentFactory: must NEVER build an agent for an over-limit request.
  let agentBuilds = 0;
  const agentFactory = ({ onEvent }) => {
    agentBuilds += 1;
    return { agent: { async send(text) { onEvent({ type: 'assistant_text', text }); } } };
  };

  // A QuotaManager whose generation.turn budget is exhausted (max:0).
  const quotaManager = createQuotaManager({
    config: { rate: { 'generation.turn': { max: 0, windowMs: 60_000 } } },
  });

  const server = createBuilderServer({ authService, agentFactory, sandboxManager, quotaManager });
  const { port, host } = await server.listen(0, '127.0.0.1');
  const base = `http://${host}:${port}`;
  try {
    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'proj-q1', text: 'build me a thing' }),
    });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.limit, 'Rate_Limit');
    assert.equal(body.operation, 'generation.turn');
    assert.match(body.error, /Rate_Limit/);

    // Nothing was allocated: no sandbox acquire, no agent build, no pending state.
    assert.equal(acquireCalls, 0, 'sandboxManager.acquire NOT called on over-limit');
    assert.equal(agentBuilds, 0, 'no Builder_Agent built on over-limit');
    assert.equal(server.pendingCount(), 0, 'no pending session state');
  } finally {
    await server.close();
  }
});

test('over-Resource_Quota (concurrent sandboxes) POST /message returns 429 naming the quota and allocates nothing', async () => {
  const { authService, token } = await authWithToken();

  let acquireCalls = 0;
  const sandboxManager = {
    acquire: () => {
      acquireCalls += 1;
      return { mountSource: '/tmp/p' };
    },
    // Already at the concurrency ceiling.
    activeProjectIds: () => ['a', 'b', 'c'],
  };
  let agentBuilds = 0;
  const agentFactory = () => {
    agentBuilds += 1;
    return { agent: { async send() {} } };
  };

  const quotaManager = createQuotaManager({
    config: {
      rate: { 'generation.turn': { max: 100, windowMs: 60_000 } },
      quota: { maxConcurrentSandboxes: 3 },
    },
    sandboxManager,
  });

  const { base, close } = await startServer({ authService, agentFactory, sandboxManager, quotaManager });
  try {
    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'proj-q2', text: 'go' }),
    });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.limit, 'Resource_Quota');
    assert.equal(body.resource, 'concurrentSandboxes');
    assert.match(body.error, /Resource_Quota/);

    assert.equal(acquireCalls, 0, 'sandboxManager.acquire NOT called on over-quota');
    assert.equal(agentBuilds, 0, 'no Builder_Agent built on over-quota');
  } finally {
    await close();
  }
});

test('the quota gate runs strictly AFTER authn/authz: an unauthenticated over-limit request gets the generic access-denied, no limit disclosure', async () => {
  const authService = createAuthService({ idpVerifier: fakeIdp() });

  let acquireCalls = 0;
  const sandboxManager = { acquire: () => { acquireCalls += 1; return {}; }, activeProjectIds: () => [] };

  // A gate that would reject EVERY request if it ran — so if the response leaks a
  // limit, the gate wrongly ran before auth.
  const quotaManager = createQuotaManager({
    config: { rate: { 'generation.turn': { max: 0, windowMs: 60_000 } } },
  });

  const { base, close } = await startServer({ authService, sandboxManager, quotaManager });
  try {
    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'secret-proj', text: 'hi' }),
    });
    // Auth fails first: generic access-denied, NOT a 429 quota message.
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'access denied' });
    // No limit vocabulary and no project disclosure in the response.
    const asText = JSON.stringify(body);
    assert.ok(!asText.includes('Rate_Limit'), 'no Rate_Limit disclosure before auth');
    assert.ok(!asText.includes('Resource_Quota'), 'no Resource_Quota disclosure before auth');
    assert.ok(!asText.includes('secret-proj'), 'no project disclosure');
    assert.equal(acquireCalls, 0, 'nothing allocated for an unauthenticated request');
  } finally {
    await close();
  }
});

test('a within-limit authenticated POST /message still proceeds normally with a quotaManager present', async () => {
  const { authService, token } = await authWithToken();

  let agentBuilds = 0;
  const agentFactory = ({ onEvent }) => {
    agentBuilds += 1;
    return { agent: { async send(text) { onEvent({ type: 'assistant_text', text: `echo: ${text}` }); } } };
  };
  const quotaManager = createQuotaManager({
    config: {
      rate: { 'generation.turn': { max: 100, windowMs: 60_000 } },
      quota: { maxConcurrentSandboxes: 100 },
    },
    // No sandboxManager -> concurrency count is 0, well under the ceiling.
  });

  const { base, close } = await startServer({ authService, agentFactory, quotaManager });
  try {
    const res = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'proj-ok', text: 'do it' }),
    });
    assert.equal(res.status, 202, 'within-limit turn is accepted');
    assert.deepEqual(await res.json(), { accepted: true });
    // Give the lazy agent build a tick.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(agentBuilds, 1, 'agent built for a within-limit turn');
  } finally {
    await close();
  }
});
