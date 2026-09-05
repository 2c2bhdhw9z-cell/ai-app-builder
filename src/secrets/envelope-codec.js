/**
 * envelope-codec.js — real Encryption_At_Rest for the SecretStore (spec Task
 * 12.4, Req 24.1). This is the codec that REPLACES the SecretStore's default
 * identityCodec: createSecretStore already accepts a pluggable `codec`
 * { encode(value)->bytes, decode(bytes)->value }, so this slots in with NO
 * change to any SecretStore call site.
 *
 * ENVELOPE ENCRYPTION (the standard pattern):
 *   encode(value):
 *     1. generate a random per-secret 32-byte DATA KEY;
 *     2. AES-256-GCM encrypt the utf8 value under the data key with a fresh
 *        random IV, capturing the auth tag;
 *     3. WRAP the data key with the master key via the injected KMS seam
 *        (kms.wrapDataKey) — the plaintext data key is never persisted;
 *     4. serialize an OPAQUE self-describing blob { v, kid, iv, tag,
 *        wrappedDataKey, ciphertext } (JSON with base64 fields).
 *   decode(bytes):
 *     1. parse the blob;
 *     2. UNWRAP the data key via kms.unwrapDataKey (needs the master key);
 *     3. AES-256-GCM decrypt the ciphertext under the data key, VERIFYING the
 *        auth tag; return the utf8 value.
 *
 * SECURITY PROPERTY (Req 24.1, Property under Task 12.5*): the plaintext value
 * is NOT recoverable from the stored bytes without the master key. The stored
 * blob contains only ciphertext + a WRAPPED data key; recovering the value
 * requires unwrapping the data key, which requires the master key held behind
 * the KMS seam. Tampering with any byte of the ciphertext (or the wrapped data
 * key) is detected by the AES-GCM auth tag and makes decode throw.
 *
 * The master key lives behind the KMS seam (src/secrets/kms.js), so swapping the
 * local KMS for a cloud KMS changes nothing here.
 */

import crypto from 'node:crypto';

/** AES-256-GCM parameters for the per-secret value encryption. */
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGO = 'aes-256-gcm';

/** The envelope blob format version, so the framing can evolve compatibly. */
const ENVELOPE_VERSION = 1;

/**
 * Create the envelope-encryption codec.
 *
 * @param {object} args
 * @param {object} args.kms  a KMS seam (src/secrets/kms.js createLocalKms or a
 *        cloud implementation) exposing wrapDataKey(dataKey)->wrappedBytes,
 *        unwrapDataKey(wrappedBytes)->dataKey, and keyId.
 * @returns {{ encode(value:string):Buffer, decode(bytes:Buffer):string }}
 */
export function createEnvelopeCodec({ kms } = {}) {
  if (
    !kms ||
    typeof kms.wrapDataKey !== 'function' ||
    typeof kms.unwrapDataKey !== 'function'
  ) {
    throw new TypeError('createEnvelopeCodec: kms with wrapDataKey/unwrapDataKey is required');
  }

  /**
   * encode(value) -> opaque bytes. Real envelope encryption: per-secret data
   * key, AES-256-GCM value encryption, KMS-wrapped data key, serialized blob.
   */
  function encode(value) {
    const plaintext = Buffer.from(String(value), 'utf8');

    // 1) Fresh per-secret data key + IV.
    const dataKey = crypto.randomBytes(DATA_KEY_BYTES);
    const iv = crypto.randomBytes(IV_BYTES);

    // 2) Encrypt the value under the data key (AES-256-GCM => confidentiality +
    //    integrity via the auth tag).
    const cipher = crypto.createCipheriv(ALGO, dataKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    // 3) Wrap the data key with the master key (behind the KMS seam). The
    //    plaintext data key is NEVER serialized.
    const wrappedDataKey = Buffer.from(kms.wrapDataKey(dataKey));

    // 4) Serialize an opaque, self-describing blob. base64 keeps binary fields
    //    JSON-safe; kid names the wrapping key without exposing key material.
    const blob = {
      v: ENVELOPE_VERSION,
      kid: typeof kms.keyId === 'string' ? kms.keyId : null,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      wrappedDataKey: wrappedDataKey.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    return Buffer.from(JSON.stringify(blob), 'utf8');
  }

  /**
   * decode(bytes) -> value. Reverses encode(): unwrap the data key, decrypt +
   * verify the auth tag. Throws on a bad master key or any tampering.
   */
  function decode(bytes) {
    let blob;
    try {
      blob = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (err) {
      throw new Error(`envelope decode: stored bytes are not a valid envelope blob: ${err?.message ?? err}`);
    }
    if (!blob || typeof blob !== 'object' || blob.v !== ENVELOPE_VERSION) {
      throw new Error('envelope decode: unrecognized or unsupported envelope version');
    }

    const iv = Buffer.from(String(blob.iv ?? ''), 'base64');
    const tag = Buffer.from(String(blob.tag ?? ''), 'base64');
    const wrappedDataKey = Buffer.from(String(blob.wrappedDataKey ?? ''), 'base64');
    const ciphertext = Buffer.from(String(blob.ciphertext ?? ''), 'base64');

    // Unwrap the data key via the KMS seam (requires the master key). A wrong
    // master key / tampered wrapped key fails the KMS auth tag here.
    const dataKey = Buffer.from(kms.unwrapDataKey(wrappedDataKey));

    const decipher = crypto.createDecipheriv(ALGO, dataKey, iv);
    decipher.setAuthTag(tag);
    // A tampered ciphertext fails the GCM auth tag in decipher.final().
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  return Object.freeze({ encode, decode });
}
