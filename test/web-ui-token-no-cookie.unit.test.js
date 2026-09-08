/**
 * Unit test for Web UI Task 8.8 — the Token_Store's storage sink (Req 16.3).
 *
 * Req 16.3: the client never persists the Bearer_Token to a cross-origin-
 * readable sink. Concretely, the Token_Store must write ONLY to its injected
 * in-memory / sessionStorage backend and NEVER to `document.cookie` (which is
 * attached to every same-origin request and readable by the server).
 *
 * These tests install a `document.cookie` SPY (a getter/setter on a fake
 * `globalThis.document`) and assert that neither set() nor clear() ever assigns
 * `document.cookie`, across three backend configurations:
 *   - storage: null       → purely in-memory, nothing persisted anywhere;
 *   - an injected fake Storage → the record is written ONLY there;
 *   - default (no storage dep) with a fake document present → still no cookie.
 *
 * REAL COLLABORATOR. The REAL createTokenStore, with only the clock and storage
 * backend injected. No production code is stubbed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTokenStore, STORAGE_KEY } from '../src/server/public/token-store.js';

const NOW = Date.parse('2024-06-01T00:00:00.000Z');
const now = () => NOW;

/** A valid, future record the store will accept. */
function validRecord() {
  return { token: 'secret-token', accountId: 'acct-1', expiresAt: new Date(NOW + 3_600_000).toISOString() };
}

/** A minimal in-memory Storage double that records exactly what was written. */
function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _snapshot: () => new Map(map),
    _has: (k) => map.has(k),
  };
}

/**
 * Install a `document.cookie` spy on globalThis for the duration of `fn`, then
 * restore whatever was there before. The spy's SETTER records every assignment
 * (so any write to document.cookie is caught); its GETTER returns ''.
 * Returns the recorded list of assigned cookie values.
 */
function withCookieSpy(fn) {
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const prevDocument = globalThis.document;
  const cookieWrites = [];
  const fakeDocument = {};
  Object.defineProperty(fakeDocument, 'cookie', {
    configurable: true,
    get() {
      return '';
    },
    set(v) {
      cookieWrites.push(v);
    },
  });
  globalThis.document = fakeDocument;
  try {
    fn(cookieWrites);
  } finally {
    if (hadDocument) globalThis.document = prevDocument;
    else delete globalThis.document;
  }
  return cookieWrites;
}

test('Req 16.3: with storage:null the Token_Store works purely in-memory and never touches document.cookie', () => {
  const cookieWrites = withCookieSpy(() => {
    const ts = createTokenStore({ now, storage: null });
    assert.equal(ts.set(validRecord()), true, 'a valid record is stored');
    // The token is readable in-memory by same-origin JS…
    assert.equal(ts.getToken(), 'secret-token');
    assert.equal(ts.hasToken(), true);
    ts.clear();
    assert.equal(ts.hasToken(), false, 'clear() empties the in-memory record');
  });
  assert.deepEqual(cookieWrites, [], 'no assignment to document.cookie occurred (set or clear)');
});

test('Req 16.3: an injected fake Storage receives the record and document.cookie is never written', () => {
  const storage = memStorage();
  const cookieWrites = withCookieSpy(() => {
    const ts = createTokenStore({ now, storage });
    assert.equal(ts.set(validRecord()), true);
    // Written ONLY to the injected backend, under the known key.
    assert.equal(storage._has(STORAGE_KEY), true, 'the injected Storage holds the record');
    const persisted = JSON.parse(storage.getItem(STORAGE_KEY));
    assert.deepEqual(Object.keys(persisted).sort(), ['accountId', 'expiresAt', 'token']);
    assert.equal(persisted.token, 'secret-token');

    ts.clear();
    assert.equal(storage._has(STORAGE_KEY), false, 'clear() removes the record from the injected Storage');
  });
  assert.deepEqual(cookieWrites, [], 'the token never reached document.cookie');
});

test('Req 16.3: the record lives ONLY in the injected backend — no other global sink is written', () => {
  const storage = memStorage();
  const hadLocal = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const prevLocal = globalThis.localStorage;
  const localWrites = [];
  globalThis.localStorage = {
    getItem: () => null,
    setItem: (k, v) => localWrites.push([k, v]),
    removeItem: () => {},
  };
  try {
    withCookieSpy(() => {
      const ts = createTokenStore({ now, storage });
      ts.set(validRecord());
      ts.clear();
    });
  } finally {
    if (hadLocal) globalThis.localStorage = prevLocal;
    else delete globalThis.localStorage;
  }
  assert.deepEqual(localWrites, [], 'the Token_Store never writes to localStorage');
  // Sanity: the injected backend WAS the sole sink used (and is now cleared).
  assert.equal(storage._has(STORAGE_KEY), false);
});

test('Req 16.3: even with a default backend and a fake document present, set()/clear() never assign document.cookie', () => {
  // Do not pass `storage`, so the store consults globalThis.sessionStorage.
  // Provide a fake sessionStorage so the default branch has somewhere to write;
  // the point of this test is that the write goes THERE and never to cookie.
  const session = memStorage();
  const hadSession = Object.prototype.hasOwnProperty.call(globalThis, 'sessionStorage');
  const prevSession = globalThis.sessionStorage;
  globalThis.sessionStorage = session;
  let cookieWrites;
  try {
    cookieWrites = withCookieSpy(() => {
      const ts = createTokenStore({ now }); // no storage dep → default sessionStorage
      assert.equal(ts.set(validRecord()), true);
      assert.equal(session._has(STORAGE_KEY), true, 'default backend received the record');
      ts.clear();
      assert.equal(session._has(STORAGE_KEY), false);
    });
  } finally {
    if (hadSession) globalThis.sessionStorage = prevSession;
    else delete globalThis.sessionStorage;
  }
  assert.deepEqual(cookieWrites, [], 'no document.cookie assignment via the default backend path');
});

test('Req 16.3 guard: the cookie spy actually catches an assignment', () => {
  const writes = withCookieSpy(() => {
    // Simulate what a NON-compliant implementation would do.
    globalThis.document.cookie = 'aab_token_record=leak';
  });
  assert.deepEqual(writes, ['aab_token_record=leak'], 'the spy records a real cookie assignment');
});
