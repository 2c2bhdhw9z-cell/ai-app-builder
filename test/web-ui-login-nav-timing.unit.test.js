/**
 * Unit test for Web UI Task 8.8 — login navigation timing (Req 6.1).
 *
 * Req 6.1: activating the login control begins the Login_Flow by navigating the
 * browser to `GET /auth/login` within 500ms of activation. This module owns no
 * DOM: the auth controller (createAuthController) navigates through an INJECTED
 * `navigate` seam, so we assert the navigation happens SYNCHRONOUSLY with the
 * activation — and, with a fake clock, that no time elapses between activating
 * the control and the navigation (0ms ≤ 500ms).
 *
 * REAL COLLABORATORS. The REAL auth controller over the REAL store, Token_Store,
 * and api client; only the clock (fake), timers (no-op), and navigation (a spy
 * that timestamps against the fake clock) are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTokenStore } from '../src/server/public/token-store.js';
import { createAuthController, LOGIN_PATH } from '../src/server/public/auth.js';
import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';

/** The 500ms navigation budget from Req 6.1. */
const NAV_BUDGET_MS = 500;

/**
 * Build the controller with a FAKE clock the test controls, a navigate spy that
 * records both the target URL and the fake-clock time at which it was called,
 * and no-op timers. Returns handles to drive and inspect it.
 */
function makeSetup() {
  let clockMs = Date.parse('2024-06-01T00:00:00.000Z');
  const now = () => clockMs;
  const advance = (ms) => {
    clockMs += ms;
  };

  const navCalls = [];
  const store = createStore();
  const tokenStore = createTokenStore({ now, storage: null });
  const api = createApiClient({
    getToken: () => tokenStore.getToken(),
    fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
  });
  const auth = createAuthController({
    store,
    api,
    tokenStore,
    navigate: (url) => navCalls.push({ url, at: clockMs }),
    now,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  return { auth, navCalls, advance, activatedAt: () => clockMs };
}

test('Req 6.1: login() navigates to GET /auth/login synchronously (0ms, well within 500ms)', () => {
  const { auth, navCalls, activatedAt } = makeSetup();
  const tActivate = activatedAt();

  auth.login();

  // Navigation happened DURING the login() call — synchronously, before control
  // returned — so exactly one nav was recorded and no fake-clock time elapsed.
  assert.equal(navCalls.length, 1, 'login() navigated exactly once, synchronously');
  assert.equal(navCalls[0].url, LOGIN_PATH, 'login() navigates to GET /auth/login');
  const elapsed = navCalls[0].at - tActivate;
  assert.equal(elapsed, 0, 'navigation occurred with no clock advance (synchronous)');
  assert.ok(elapsed <= NAV_BUDGET_MS, `navigation within the ${NAV_BUDGET_MS}ms budget`);
});

test('Req 6.1: navigation does not wait on any timer — no clock advance is needed', () => {
  const { auth, navCalls, advance } = makeSetup();

  // Deliberately do NOT advance the clock or fire any timer before checking.
  auth.login();
  assert.equal(navCalls.length, 1, 'navigation fired without advancing the clock');

  // Advancing time afterwards must not produce a second/duplicate navigation.
  advance(10_000);
  assert.equal(navCalls.length, 1, 'no delayed/duplicate navigation appears later');
});

test('Req 6.1: restart() (the protocol-fault control) also navigates within budget', () => {
  const { auth, navCalls, activatedAt } = makeSetup();
  const tActivate = activatedAt();

  auth.restart();

  assert.equal(navCalls.length, 1, 'restart() navigated exactly once');
  assert.equal(navCalls[0].url, LOGIN_PATH, 'restart() navigates to GET /auth/login');
  assert.ok(navCalls[0].at - tActivate <= NAV_BUDGET_MS, 'restart navigation within budget');
});
