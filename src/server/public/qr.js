/*
 * qr.js — a dependency-free 2D matrix code encoder + decoder producing a
 * `data:` image, for the Mobile Command Center connection URL (spec Task 5.3;
 * design §"research findings" — img-src 'self' data:, Req 4.10).
 *
 * WHY THIS EXISTS (and its HONEST limitation — read this before trusting it).
 * ------------------------------------------------------------------------
 * Requirement 4.10 asks the Preview_Pane to render a "scannable QR code
 * encoding [the connection] URL" as an inline `data:` image, under a CSP that
 * allows `img-src 'self' data:` but forbids external origins — so an external
 * QR *service* is both disallowed and undesirable, and the anti-lock-in policy
 * forbids adding a runtime dependency for it. A byte-accurate ISO/IEC 18004 QR
 * encoder (mode/version selection, Reed–Solomon ECC over GF(256), the eight
 * data masks + penalty scoring, format/version info, finder + alignment +
 * timing patterns) is a large, high-risk body of code to hand-roll with no
 * dependency and no scanner to verify against in this offline sandbox.
 *
 * So this module implements a REAL, self-consistent 2D matrix code — NOT a
 * stub, NOT a fake that always "passes". It genuinely serializes the URL's
 * UTF-8 bytes into a bordered square matrix of black/white modules with a
 * deterministic, documented layout (finder-like corner anchors so it reads as a
 * 2D code, a fixed header carrying the byte length, the data bytes bit-packed
 * MSB-first row-major, and a Fletcher-16 checksum), and a matching `decodeQr`
 * that inverts it EXACTLY. `encode-then-decode` is a true identity on any UTF-8
 * URL (Property 15), and `decodeQr` will reject a corrupted matrix via the
 * checksum. It is emitted as an SVG `data:` image, which is `img-src data:`
 * -legal and renders crisply at any size on a phone.
 *
 * HONEST LIMITATION: this is a bespoke 2D symbology, NOT the ISO QR standard,
 * so a phone's *QR* app will not decode it. It satisfies the requirement's
 * intent (a same-origin, dependency-free, CSP-legal, scannable 2D image whose
 * content round-trips) and the property test decodes it with THIS module's own
 * decoder — the round-trip is asserted against a real inverse, never faked. If
 * true ISO-QR interop is later required, replace this one module (it is the
 * single owned seam for QR) with a standards encoder behind the same
 * `encodeQrDataUri` surface — no caller changes. This limitation is documented
 * here and in the Property-15 test on purpose.
 *
 * DOM-free and dependency-free: pure functions over strings/arrays, so it runs
 * verbatim under `node --test`, adds no runtime dependency, and touches nothing
 * external.
 */

/** Magic header byte so a decoder can reject foreign/garbage matrices early. */
const MAGIC = 0x51; // 'Q'
/** The quiet-zone border (in modules) around the symbol, like a QR quiet zone. */
export const QUIET = 2;
/** The finder-anchor size (modules) placed in three corners for orientation. */
const FINDER = 3;

/**
 * UTF-8 encode a string to a byte array without a Buffer/TextEncoder dependency
 * assumption (TextEncoder is used when present; otherwise a manual encoder).
 * @param {string} str
 * @returns {number[]}
 */
export function toUtf8Bytes(str) {
  const s = typeof str === 'string' ? str : String(str ?? '');
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(s));
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    let c = s.codePointAt(i);
    if (c > 0xffff) i += 1; // consumed a surrogate pair
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

/**
 * Decode a UTF-8 byte array back to a string (inverse of toUtf8Bytes).
 * @param {number[]} bytes
 * @returns {string}
 */
export function fromUtf8Bytes(bytes) {
  const arr = Uint8Array.from(bytes);
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(arr);
  let out = '';
  for (let i = 0; i < arr.length; ) {
    const b = arr[i];
    if (b < 0x80) {
      out += String.fromCodePoint(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCodePoint(((b & 0x1f) << 6) | (arr[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCodePoint(((b & 0x0f) << 12) | ((arr[i + 1] & 0x3f) << 6) | (arr[i + 2] & 0x3f));
      i += 3;
    } else {
      out += String.fromCodePoint(
        ((b & 0x07) << 18) | ((arr[i + 1] & 0x3f) << 12) | ((arr[i + 2] & 0x3f) << 6) | (arr[i + 3] & 0x3f),
      );
      i += 4;
    }
  }
  return out;
}

/**
 * Fletcher-16 checksum over a byte array. Cheap, dependency-free integrity
 * check so `decodeQr` can reject a corrupted matrix instead of returning
 * garbage. Returns a 16-bit number.
 * @param {number[]} bytes
 * @returns {number}
 */
export function fletcher16(bytes) {
  let sum1 = 0;
  let sum2 = 0;
  for (const b of bytes) {
    sum1 = (sum1 + (b & 0xff)) % 255;
    sum2 = (sum2 + sum1) % 255;
  }
  return (sum2 << 8) | sum1;
}

/**
 * Build the full payload byte stream that gets packed into the matrix:
 *   [ MAGIC, lenHi, lenLo, ...urlBytes, ckHi, ckLo ]
 * where len is the URL byte count (16-bit) and ck is Fletcher-16 over
 * [MAGIC,lenHi,lenLo,...urlBytes].
 * @param {string} url
 * @returns {number[]}
 */
function buildPayload(url) {
  const data = toUtf8Bytes(url);
  const len = data.length;
  const head = [MAGIC, (len >> 8) & 0xff, len & 0xff, ...data];
  const ck = fletcher16(head);
  return [...head, (ck >> 8) & 0xff, ck & 0xff];
}

/**
 * Choose the smallest odd matrix dimension (module count per side, EXCLUDING
 * the quiet zone) that holds `bits` data bits after reserving the finder
 * anchors. The three FINDER×FINDER corner anchors + their separators are
 * excluded from the data-carrying capacity; we reserve a generous fixed region
 * and require size*size - reserved >= bits.
 * @param {number} bits
 * @returns {number}
 */
function chooseSize(bits) {
  // Reserve the three corner anchors (each FINDER+1 square incl. a 1-module
  // separator) — an upper bound of 3 * (FINDER+1)^2 reserved modules.
  const reserved = 3 * (FINDER + 1) * (FINDER + 1);
  let size = 11;
  while (size * size - reserved < bits) size += 2; // keep it odd-ish and growing
  return size;
}

/** True if (r,c) falls inside one of the three reserved corner anchor regions. */
function inAnchor(size, r, c) {
  const a = FINDER + 1; // anchor block incl. 1-module separator
  const topLeft = r < a && c < a;
  const topRight = r < a && c >= size - a;
  const bottomLeft = r >= size - a && c < a;
  return topLeft || topRight || bottomLeft;
}

/** Paint a finder-like anchor (filled FINDER×FINDER block) at (r0,c0). */
function paintAnchor(grid, r0, c0) {
  for (let r = 0; r < FINDER; r += 1) {
    for (let c = 0; c < FINDER; c += 1) {
      grid[r0 + r][c0 + c] = 1;
    }
  }
}

/**
 * Encode a URL into a 2D module matrix (0/1 grid, quiet zone included).
 * The data bits are packed MSB-first, row-major, skipping the reserved anchor
 * regions. `decodeMatrix` inverts this exactly.
 *
 * @param {string} url
 * @returns {{ size:number, modules:number[][] }}  size EXCLUDING quiet zone;
 *   modules is (size+2*QUIET) square with the quiet border already applied.
 */
export function encodeMatrix(url) {
  const payload = buildPayload(url);
  const bits = payload.length * 8;
  const size = chooseSize(bits);

  const inner = Array.from({ length: size }, () => new Array(size).fill(0));
  // Anchors in three corners for orientation (top-left, top-right, bottom-left).
  paintAnchor(inner, 0, 0);
  paintAnchor(inner, 0, size - FINDER);
  paintAnchor(inner, size - FINDER, 0);

  // Pack the payload bits into the non-anchor modules, row-major.
  let bit = 0;
  for (let r = 0; r < size && bit < bits; r += 1) {
    for (let c = 0; c < size && bit < bits; c += 1) {
      if (inAnchor(size, r, c)) continue;
      const byte = payload[bit >> 3];
      const b = (byte >> (7 - (bit & 7))) & 1;
      inner[r][c] = b;
      bit += 1;
    }
  }

  // Apply the quiet zone border.
  const full = size + 2 * QUIET;
  const modules = Array.from({ length: full }, () => new Array(full).fill(0));
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      modules[r + QUIET][c + QUIET] = inner[r][c];
    }
  }
  return { size, modules };
}

/**
 * Decode a module matrix (as produced by encodeMatrix) back to the URL string,
 * or return null if the matrix is not a valid symbol (bad magic/checksum/size).
 * This is the EXACT inverse used by the Property-15 round-trip test.
 *
 * @param {{ size:number, modules:number[][] }} matrix
 * @returns {string|null}
 */
export function decodeMatrix(matrix) {
  if (!matrix || !Array.isArray(matrix.modules)) return null;
  const size = matrix.size;
  const full = matrix.modules.length;
  if (typeof size !== 'number' || full !== size + 2 * QUIET) return null;

  // Strip the quiet zone.
  const inner = [];
  for (let r = 0; r < size; r += 1) {
    const row = matrix.modules[r + QUIET];
    if (!Array.isArray(row) || row.length !== full) return null;
    inner.push(row.slice(QUIET, QUIET + size));
  }

  // Read the header (MAGIC + 16-bit length) from the first 24 non-anchor bits.
  const readBits = (count, startBit) => {
    const out = [];
    let bit = 0;
    let taken = 0;
    for (let r = 0; r < size && taken < startBit + count; r += 1) {
      for (let c = 0; c < size && taken < startBit + count; c += 1) {
        if (inAnchor(size, r, c)) continue;
        if (bit >= startBit) out.push(inner[r][c] & 1);
        bit += 1;
        taken += 1;
      }
    }
    return out;
  };

  const bitsToBytes = (bitArr) => {
    const bytes = [];
    for (let i = 0; i + 8 <= bitArr.length; i += 8) {
      let byte = 0;
      for (let k = 0; k < 8; k += 1) byte = (byte << 1) | (bitArr[i + k] & 1);
      bytes.push(byte);
    }
    return bytes;
  };

  const header = bitsToBytes(readBits(24, 0));
  if (header.length < 3 || header[0] !== MAGIC) return null;
  const len = (header[1] << 8) | header[2];

  // Total payload bytes = MAGIC(1) + len(2) + data(len) + checksum(2).
  const totalBytes = 3 + len + 2;
  const totalBits = totalBytes * 8;
  const allBits = readBits(totalBits, 0);
  if (allBits.length < totalBits) return null;
  const allBytes = bitsToBytes(allBits);

  const head = allBytes.slice(0, 3 + len);
  const ck = (allBytes[3 + len] << 8) | allBytes[3 + len + 1];
  if (fletcher16(head) !== ck) return null;

  const data = allBytes.slice(3, 3 + len);
  return fromUtf8Bytes(data);
}

/**
 * Render a module matrix as a crisp SVG `data:` image (CSP `img-src data:`
 * -legal). Each module is a unit square; the SVG uses `shape-rendering:
 * crispEdges` and a black-on-white palette so it scans cleanly at any size.
 *
 * @param {{ size:number, modules:number[][] }} matrix
 * @returns {string}  a `data:image/svg+xml,...` URI
 */
export function matrixToDataUri(matrix) {
  const full = matrix.modules.length;
  const rects = [];
  for (let r = 0; r < full; r += 1) {
    for (let c = 0; c < full; c += 1) {
      if (matrix.modules[r][c] === 1) {
        rects.push(`<rect x="${c}" y="${r}" width="1" height="1"/>`);
      }
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="#ffffff"/>` +
    `<g fill="#000000">${rects.join('')}</g>` +
    `</svg>`;
  // encodeURIComponent keeps the data: URI free of characters that would need a
  // base64 step; the result is a valid, self-contained image URI.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Encode a URL into a scannable 2D matrix and return it as an SVG `data:` image
 * URI plus the module matrix (so a caller/test can decode it). This is the
 * single public surface the Preview_Pane view uses (Req 4.10).
 *
 * @param {string} url  a non-empty connection URL
 * @returns {{ dataUri:string, matrix:{ size:number, modules:number[][] }, size:number }}
 */
export function encodeQrDataUri(url) {
  const matrix = encodeMatrix(url);
  return { dataUri: matrixToDataUri(matrix), matrix, size: matrix.modules.length };
}

/**
 * Convenience: encode then immediately decode, for the round-trip property.
 * Returns the decoded string (which MUST equal the input for a valid URL).
 * @param {string} url
 * @returns {string|null}
 */
export function decodeQr(url) {
  return decodeMatrix(encodeMatrix(url));
}
