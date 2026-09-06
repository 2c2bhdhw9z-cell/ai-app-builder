/**
 * Production entry-point tests (boot-readiness, Task 21).
 *
 * These prove the three boot-readiness gaps are closed and are written to FAIL
 * if any change is reverted:
 *
 *   1. GET /healthz — a REAL unauthenticated request against a REAL server bound
 *      on an ephemeral loopback port returns 200 + {status:'ok'}. Removing the
 *      /healthz route flips this (auth-gated fallthrough would be 401/405).
 *   2. PORT/HOST wiring — resolveBindConfig honors an INJECTED env (and its
 *      defaults are 0.0.0.0:8080, reachable from outside a container). Ignoring
 *      PORT/HOST flips these.
 *   3. listen() threading — startPlatformServer resolves host/port from the
 *      injected env and calls the server's REAL listen() with them, binding the
 *      configured host. Bound on 127.0.0.1 to stay sandbox-safe while still
 *      proving the value is threaded through.
 *
 * Hermetic: no external network, no API key. The provider is a REAL plumby
 * scripted provider (so createBuilderServer's provider check runs for real),
 * and the server is the REAL createBuilderServer — no fakes standing in for a
 * collaborator's contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createScriptedProvider } from '../src/engine/plumby.js';
import {
  resolveBindConfig,
  startPlatformServer,
  DEFAULT_PORT,
  DEFAULT_HOST,
} from '../src/server/start.js';

/** A minimal fail-closed IdP verifier so AuthService can be constructed. */
const denyingIdp = {
  async verifyIdToken() {
    throw new Error('no idp');
  },
};

/** A real Builder Server on an ephemeral loopback port; returns base + close. */
async function startRealServer() {
  const api = createBuilderServer({
    authService: createAuthService({ idpVerifier: denyingIdp }),
    provider: createScriptedProvider([]),
  });
  const { port, host } = await api.listen(0, '127.0.0.1');
  return { api, base: `http://${host}:${port}`, close: () => api.close() };
}

// ---------------------------------------------------------------- /healthz

test('GET /healthz returns 200 with a minimal body and needs no auth', async () => {
  const { base, close } = await startRealServer();
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ok' });
    // Discloses nothing sensitive: only the fixed status field.
    assert.deepEqual(Object.keys(body), ['status']);
  } finally {
    await close();
  }
});

test('GET /healthz does not require an authorization header (unauthenticated 200)', async () => {
  const { base, close } = await startRealServer();
  try {
    // No Authorization header at all — a deploy/uptime probe has no credentials.
    const res = await fetch(`${base}/healthz`, { headers: {} });
    assert.equal(res.status, 200);
    assert.notEqual(res.status, 401);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------ resolveBindConfig

test('resolveBindConfig defaults to 0.0.0.0 and DEFAULT_PORT when env is empty', () => {
  const cfg = resolveBindConfig({});
  assert.equal(cfg.host, DEFAULT_HOST);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, DEFAULT_PORT);
});

test('resolveBindConfig honors injected PORT and HOST', () => {
  const cfg = resolveBindConfig({ PORT: '9137', HOST: '10.0.0.5' });
  assert.equal(cfg.port, 9137);
  assert.equal(cfg.host, '10.0.0.5');
});

test('resolveBindConfig falls back to the default for a non-numeric or out-of-range PORT', () => {
  assert.equal(resolveBindConfig({ PORT: 'nope' }).port, DEFAULT_PORT);
  assert.equal(resolveBindConfig({ PORT: '70000' }).port, DEFAULT_PORT);
  assert.equal(resolveBindConfig({ PORT: '' }).port, DEFAULT_PORT);
});

// --------------------------------------------- startPlatformServer listen wiring

test('startPlatformServer threads the resolved host/port into listen()', async () => {
  const listenCalls = [];
  const logs = [];

  // Spy factory that wraps a REAL Builder Server so listen() runs for real but
  // we can observe the exact host/port it was called with.
  const createServer = (opts) => {
    const api = createBuilderServer(opts);
    const realListen = api.listen;
    return {
      ...api,
      listen: (port, host) => {
        listenCalls.push({ port, host });
        return realListen(port, host);
      },
    };
  };

  // Inject env with a loopback host (sandbox-safe) and an ephemeral port, but
  // prove the injected values are the ones threaded into listen().
  const env = { PORT: '0', HOST: '127.0.0.1' };
  const { api, address } = await startPlatformServer({
    env,
    createServer,
    logger: { log: (m) => logs.push(m) },
  });

  try {
    assert.equal(listenCalls.length, 1);
    // The resolved host from the injected env reached listen() — a mutation that
    // ignores HOST (e.g. hardcoding the loopback default) would break this once
    // a non-default host is injected; the port 0 asks the OS for an ephemeral
    // port, and the bound address is reported back.
    assert.equal(listenCalls[0].host, '127.0.0.1');
    assert.equal(listenCalls[0].port, 0);
    assert.equal(address.host, '127.0.0.1');
    assert.ok(Number.isInteger(address.port) && address.port > 0);

    // The bound address is logged on startup.
    assert.equal(logs.length, 1);
    assert.match(logs[0], /listening on http:\/\/127\.0\.0\.1:\d+/);

    // The composed server is really reachable and health-checkable.
    const res = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    await api.close();
  }
});

test('startPlatformServer binds a non-default injected HOST (proves HOST is threaded, not hardcoded)', async () => {
  // 127.0.0.2 is loopback (sandbox-safe) but NOT the createBuilderServer default
  // of 127.0.0.1, so a wiring that ignored HOST could not produce this bind.
  const env = { PORT: '0', HOST: '127.0.0.2' };
  const { api, address } = await startPlatformServer({
    env,
    logger: { log: () => {} },
  });
  try {
    assert.equal(address.host, '127.0.0.2');
    const res = await fetch(`http://127.0.0.2:${address.port}/healthz`);
    assert.equal(res.status, 200);
  } finally {
    await api.close();
  }
});
