/**
 * SHARED TREE CONTENT CODEC (Part A — lossless binary file support).
 *
 * The PersistenceStore and SnapshotStore both persist a project tree map
 * { relPath: contents } and read it back. Contents may be either a utf8 STRING
 * (text file) or a Buffer (binary file: PDFs, screenshots, videos, etc.). This
 * module centralizes the two symmetric halves of that contract so both stores
 * use identical semantics:
 *
 *   - normalizeContents(value): accept a string as-is, and accept a Buffer or a
 *     Uint8Array (normalized to a Buffer) so binary bytes flow through the write
 *     path untouched. Any other type (number, plain object, null, etc.) is
 *     rejected by the caller via the returned { ok:false } result so the
 *     store's fail() idiom can surface a structured error.
 *
 *   - decodeTreeEntry(buf): given the RAW bytes read back from disk, return a
 *     utf8 String when the bytes are valid utf8 AND re-encoding that string
 *     yields byte-identical bytes (so text round-trips byte-for-byte as a
 *     String), otherwise return the raw Buffer (so arbitrary binary — including
 *     non-utf8 sequences and embedded NUL — round-trips byte-exact as a Buffer).
 *
 * This module is INTERNAL to src/persistence and adds no dependencies (Node
 * stdlib only). The write path in each store still does
 * `Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8')`, so a
 * Buffer is written raw and a string is written utf8; this codec keeps the
 * read-back symmetric with that write.
 */

/**
 * Normalize a tree entry's contents for writing.
 *
 * @param {*} value  the raw contents supplied by a caller
 * @returns {{ ok: true, value: string | Buffer } | { ok: false }}
 *   ok:true with the value to store (string unchanged, Uint8Array coerced to a
 *   Buffer, Buffer unchanged); ok:false when the value is neither a string nor a
 *   Buffer/Uint8Array (the caller rejects it with fail()).
 */
export function normalizeContents(value) {
  if (typeof value === 'string') {
    return { ok: true, value };
  }
  if (Buffer.isBuffer(value)) {
    return { ok: true, value };
  }
  // A Uint8Array (but not a Buffer, handled above) is normalized to a Buffer so
  // downstream code has a single binary representation. Buffer.from(uint8array)
  // copies the bytes, leaving the caller's array untouched.
  if (value instanceof Uint8Array) {
    return { ok: true, value: Buffer.from(value) };
  }
  return { ok: false };
}

/**
 * Decide whether raw bytes read back from disk represent text or binary.
 *
 * Returns a utf8 String when `buf` is valid utf8 AND re-encoding that string
 * yields byte-identical bytes (guarding against lossy decode of invalid
 * sequences, which would otherwise round-trip through U+FFFD replacement
 * characters). Otherwise returns the raw Buffer unchanged, so binary content is
 * preserved byte-for-byte.
 *
 * @param {Buffer} buf  the raw file bytes
 * @returns {string | Buffer}
 */
export function decodeTreeEntry(buf) {
  const asString = buf.toString('utf8');
  // Buffer.from(str, 'utf8') re-encodes; if it equals the original bytes then
  // the bytes were valid, losslessly representable utf8 text and we return the
  // String (byte-for-byte identical to what was written). Otherwise the bytes
  // are binary (or invalid utf8) and we return the raw Buffer to stay lossless.
  if (Buffer.from(asString, 'utf8').equals(buf)) {
    return asString;
  }
  return buf;
}
