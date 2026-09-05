/**
 * Envelope Encryption_At_Rest tests (node --test) — spec Task 12.4 / 12.5*,
 * Req 24.1.
 *
 * The SecretStore's pluggable `codec` seam is filled with the REAL
 * envelope-encryption codec (createEnvelopeCodec over the local KMS seam), with
 * NO change to any SecretStore call site. These tests prove:
 *
 *   (a) ROUND-TRIP: put(value) then get() returns the original value unchanged,
 *       through the envelope codec composed at construction;
 *   (b) NOT-RECOVERABLE-WITHOUT-THE-KEY: the RAW bytes on disk (the .enc file)
 *       do NOT contain the plaintext value, and decoding them with a DIFFERENT
 *       master key fails (never yields the plaintext);
 *   (c) TAMPER-EVIDENT: flipping a ciphertext byte makes decode fail the
 *       AES-GCM auth tag.
 *
 * MUTATION-STYLE ASSERTION (verification check A): swapping the SecretStore's
 * codec back to identityCodec would make the assertion in (b) — "raw stored
 * bytes do not contain the plaintext value" — FAIL, because identityCodec stores
 * the plaintext UTF-8 bytes verbatim.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createStorageLayout } from '../src/storage/layout.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import { createEnvelopeCodec, createLocalKms } from '../src/secrets/index.js';

const OWNER = 'owner-1';
const PROJECT = 'proj-1';

/** A layout rooted at a fresh temp dir, so real file I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-enc-'));
  return { base, layout: createStorageLayout(base) };
}

/** Compose a SecretStore whose codec is the real envelope codec + local KMS. */
function encryptedStore(layout, kms) {
  const codec = createEnvelopeCodec({ kms });
  return createSecretStore({ layout, ownerId: OWNER, codec });
}

test('envelope codec round-trips the value through the SecretStore (no call-site change)', () => {
  const { base, layout } = tempLayout();
  try {
    const kms = createLocalKms();
    const store = encryptedStore(layout, kms);

    const value = 'postgres://user:p@ss w0rd@db.internal:5432/app?ssl=1';
    const { path: p } = store.put(PROJECT, 'DATABASE_URL', value);

    // Same on-disk path + out-of-tree invariant as the identity codec.
    assert.equal(p, layout.controlSecretPath(OWNER, PROJECT, 'DATABASE_URL'));
    assert.equal(layout.isInsideExportTree(p), false);

    // Round-trips exactly.
    assert.equal(store.get(PROJECT, 'DATABASE_URL'), value);
    // list() still returns names only.
    assert.deepEqual(store.list(PROJECT), ['DATABASE_URL']);
    // envForProject decrypts for runtime injection.
    assert.deepEqual(store.envForProject(PROJECT), { DATABASE_URL: value });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('raw stored .enc bytes do NOT contain the plaintext and are unrecoverable without the master key', () => {
  const { base, layout } = tempLayout();
  try {
    const kms = createLocalKms();
    const store = encryptedStore(layout, kms);

    const value = 'sk-live-super-secret-token-value-42';
    const { path: p } = store.put(PROJECT, 'API_KEY', value);

    // (b) The raw on-disk bytes must NOT contain the plaintext. This assertion
    //     is exactly what mutation-check A flips: identityCodec stores the
    //     plaintext verbatim, so this would then FAIL.
    const raw = fs.readFileSync(p);
    assert.equal(raw.includes(Buffer.from(value, 'utf8')), false, 'plaintext must not appear in the stored bytes');
    assert.ok(!raw.toString('utf8').includes(value), 'plaintext must not appear as a utf8 substring');
    assert.ok(!raw.toString('latin1').includes(value), 'plaintext must not appear as a latin1 substring');

    // A DIFFERENT master key cannot recover the value: unwrapping the data key
    // fails the KMS auth tag, so decode throws (never yields the plaintext).
    const otherKms = createLocalKms(); // fresh random master key
    const otherStore = encryptedStore(layout, otherKms);
    assert.throws(() => otherStore.get(PROJECT, 'API_KEY'), 'wrong master key must not decrypt');

    // The correct master key still recovers it.
    assert.equal(store.get(PROJECT, 'API_KEY'), value);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a tampered ciphertext byte fails the AES-GCM auth tag on decode', () => {
  const { base, layout } = tempLayout();
  try {
    const kms = createLocalKms();
    const store = encryptedStore(layout, kms);

    const value = 'another-very-secret-value-1234567890';
    const { path: p } = store.put(PROJECT, 'TOKEN', value);

    // The stored blob is JSON with base64 fields. Flip a byte inside the
    // base64 ciphertext so the underlying ciphertext bytes change.
    const blob = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ct = Buffer.from(blob.ciphertext, 'base64');
    ct[0] = ct[0] ^ 0xff;
    blob.ciphertext = ct.toString('base64');
    fs.writeFileSync(p, Buffer.from(JSON.stringify(blob), 'utf8'));

    // Decode must fail the auth tag (never silently return wrong plaintext).
    assert.throws(() => store.get(PROJECT, 'TOKEN'), 'tampered ciphertext must fail the auth tag');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a supplied 32-byte master key makes the KMS deterministic across stores', () => {
  const { base, layout } = tempLayout();
  try {
    const masterKey = Buffer.alloc(32, 7); // fixed key
    const store = encryptedStore(layout, createLocalKms({ masterKey }));
    const value = 'shared-master-key-value';
    store.put(PROJECT, 'SHARED', value);

    // A second store with the SAME master key can read what the first wrote.
    const store2 = encryptedStore(layout, createLocalKms({ masterKey }));
    assert.equal(store2.get(PROJECT, 'SHARED'), value);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('createLocalKms rejects a non-32-byte master key', () => {
  assert.throws(() => createLocalKms({ masterKey: Buffer.alloc(16) }), /32 bytes/);
});

test('deleteProjectSecrets and deleteAccountData remove out-of-tree secrets idempotently', () => {
  const { base, layout } = tempLayout();
  try {
    const store = encryptedStore(layout, createLocalKms());
    store.put(PROJECT, 'A', 'val-a');
    store.put(PROJECT, 'B', 'val-b');
    store.put('proj-2', 'C', 'val-c');

    const res = store.deleteProjectSecrets(PROJECT);
    assert.equal(res.ok, true);
    assert.deepEqual(res.removed, ['A', 'B']);
    assert.deepEqual(store.list(PROJECT), []);
    // Other project untouched.
    assert.deepEqual(store.list('proj-2'), ['C']);
    // Idempotent.
    assert.deepEqual(store.deleteProjectSecrets(PROJECT).removed, []);

    // deleteAccountData removes ALL secrets for the owner.
    const acct = store.deleteAccountData(OWNER);
    assert.equal(acct.ok, true);
    assert.deepEqual(store.list('proj-2'), []);
    // Idempotent.
    assert.doesNotThrow(() => store.deleteAccountData(OWNER));
    // Mismatched owner id is a caller error (never a silent no-op).
    assert.throws(() => store.deleteAccountData('someone-else'), /does not match/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
