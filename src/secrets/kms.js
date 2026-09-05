/**
 * kms.js — the injectable master-key / KMS keystore SEAM (spec Task 12.4, Req 24.1).
 *
 * Envelope encryption needs a MASTER KEY that wraps (encrypts) each per-secret
 * DATA KEY. Where that master key lives, and how the wrap/unwrap happens, is a
 * pluggable SEAM so the platform can swap the backing keystore WITHOUT touching
 * any call site:
 *
 *   wrapDataKey(dataKey: Buffer)   -> wrappedBytes: Buffer
 *   unwrapDataKey(wrappedBytes)    -> dataKey: Buffer
 *   keyId                          -> a stable identifier for the master key
 *
 * THIS MODULE IS THE LOCAL / OFFLINE IMPLEMENTATION of that seam. It holds the
 * master key IN PROCESS (a random 32-byte key when none is supplied) and wraps
 * the data key with node:crypto AES-256-GCM. It is fully verifiable offline with
 * node:crypto only — no network, no cloud dependency — which is exactly what the
 * sandbox/CI environment allows.
 *
 * THE CLOUD-KMS CASE (deferred behind the SAME interface): a real cloud KMS
 * (e.g. AWS KMS, GCP KMS, Vault transit) implements the identical
 * wrapDataKey/unwrapDataKey/keyId contract, except the wrap/unwrap is an API
 * call to the KMS and the platform NEVER holds the master key material itself.
 * Because the envelope codec (src/secrets/envelope-codec.js) depends only on
 * this interface, slotting the cloud implementation in requires NO change to the
 * codec, the SecretStore, or any caller — the master key simply moves out of
 * process and behind the KMS boundary.
 *
 * Conventions: a factory returning Object.freeze({...}); the wrapped blob is an
 * OPAQUE, self-describing byte framing (iv || tag || ciphertext) so unwrap needs
 * only the master key, not out-of-band parameters.
 */

import crypto from 'node:crypto';

/** AES-256-GCM: 32-byte key, 12-byte IV (GCM standard), 16-byte auth tag. */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = 'aes-256-gcm';

/**
 * Derive a short, stable, NON-SECRET identifier for a master key so wrapped
 * blobs / audit records can name WHICH key was used without ever exposing key
 * material. It is a truncated SHA-256 of the key bytes — one-way, so it leaks
 * nothing about the key itself.
 */
function deriveKeyId(masterKey) {
  return 'local-' + crypto.createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
}

/**
 * Create the LOCAL KMS seam implementation.
 *
 * @param {object} [args]
 * @param {Buffer} [args.masterKey]  a 32-byte AES-256 master key. When omitted a
 *        cryptographically-random 32-byte key is generated (suitable for tests
 *        and single-process/offline use; a real deployment injects a durable
 *        key or swaps in the cloud-KMS implementation of this seam).
 * @returns {{ wrapDataKey(dataKey:Buffer):Buffer, unwrapDataKey(wrapped:Buffer):Buffer, keyId:string }}
 */
export function createLocalKms({ masterKey } = {}) {
  let key;
  if (masterKey === undefined || masterKey === null) {
    key = crypto.randomBytes(KEY_BYTES);
  } else {
    if (!Buffer.isBuffer(masterKey) && !(masterKey instanceof Uint8Array)) {
      throw new TypeError('createLocalKms: masterKey must be a Buffer/Uint8Array of 32 bytes');
    }
    key = Buffer.from(masterKey);
    if (key.length !== KEY_BYTES) {
      throw new TypeError(`createLocalKms: masterKey must be exactly ${KEY_BYTES} bytes (AES-256), got ${key.length}`);
    }
  }

  const keyId = deriveKeyId(key);

  /**
   * wrapDataKey(dataKey): AES-256-GCM encrypt the data key under the master key
   * with a fresh random IV, returning the opaque framing iv || tag || ciphertext.
   * The auth tag makes tampering with a wrapped key detectable on unwrap.
   */
  function wrapDataKey(dataKey) {
    if (!Buffer.isBuffer(dataKey) && !(dataKey instanceof Uint8Array)) {
      throw new TypeError('wrapDataKey: dataKey must be a Buffer/Uint8Array');
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(dataKey)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]);
  }

  /**
   * unwrapDataKey(wrapped): reverse wrapDataKey. Parses the iv || tag ||
   * ciphertext framing, verifies the auth tag against the master key, and
   * returns the recovered data key. Throws if the master key is wrong or the
   * wrapped bytes were tampered with (GCM auth-tag failure).
   */
  function unwrapDataKey(wrapped) {
    const buf = Buffer.from(wrapped);
    if (buf.length < IV_BYTES + TAG_BYTES) {
      throw new Error('unwrapDataKey: wrapped data key is too short to be valid');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  return Object.freeze({ wrapDataKey, unwrapDataKey, keyId });
}
