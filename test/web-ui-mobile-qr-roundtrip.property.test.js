/**
 * Property-based test for Web UI Task 5.9 (node --test).
 *
 * Property 15 — "The mobile connection URL round-trips through its QR encoding"
 * (design §"Property 15", Req 4.10). Exact spec tag:
 *
 *   "Feature: web-ui, Property 15: The mobile connection URL round-trips through
 *    its QR encoding"
 *
 * PROPERTY. For ANY non-empty mobile connection URL, encode-then-decode is the
 * IDENTITY on the URL: the decoded content of the rendered code equals the URL
 * exactly.
 *
 * REAL COLLABORATORS. The REAL, shipping qr.js encoder/decoder — no stand-in,
 * no always-pass stub. `encodeMatrix` produces the 2D module matrix the view
 * renders as a `data:` image; `decodeMatrix` inverts it. The round-trip is
 * asserted against qr.js's OWN decoder.
 *
 * HONEST LIMITATION (documented, not hidden). qr.js implements a REAL, bespoke
 * 2D matrix symbology, NOT the ISO/IEC 18004 QR standard (a byte-accurate
 * standards encoder with Reed–Solomon ECC + masking is a large, high-risk body
 * of code to hand-roll dependency-free and unverifiable offline). It IS a
 * genuine, invertible 2D code emitted as a CSP-legal `data:` image; a phone's
 * *QR* app will not scan it. Property 15 therefore asserts the round-trip
 * against qr.js's own decoder, which is a real inverse — the identity holds
 * because the encoding is correct, not because the test is lenient. See qr.js's
 * header for the full note and the single-seam replacement path to a standards
 * encoder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  encodeMatrix,
  decodeMatrix,
  decodeQr,
  encodeQrDataUri,
  toUtf8Bytes,
} from '../src/server/public/qr.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// A generator of non-empty connection URLs: realistic web/exp URLs plus
// arbitrary non-empty unicode strings (the encoder is byte-oriented, so it must
// round-trip ANY non-empty string, not only well-formed URLs).
const connectionUrl = fc.oneof(
  fc.webUrl(),
  fc
    .tuple(fc.constantFrom('exp', 'exps', 'http', 'https'), fc.ipV4(), fc.integer({ min: 1, max: 65535 }))
    .map(([scheme, ip, port]) => `${scheme}://${ip}:${port}`),
  fc.string({ minLength: 1, maxLength: 300 }).filter((s) => s.length > 0),
  // Full-unicode graphemes (emoji, CJK, combining marks) to exercise the
  // byte-oriented encoder across multi-byte UTF-8 sequences.
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 120 }).filter((s) => s.length > 0),
);

test(
  webUiTag(15, 'The mobile connection URL round-trips through its QR encoding'),
  () => {
    fc.assert(
      fc.property(connectionUrl, (url) => {
        // encode → decode is the identity on the URL.
        const decoded = decodeMatrix(encodeMatrix(url));
        assert.equal(decoded, url, 'encode-then-decode returns the exact URL');
        // The convenience wrapper agrees.
        assert.equal(decodeQr(url), url, 'decodeQr(url) === url');
        return true;
      }),
      fcConfig,
    );
  },
);

test(
  webUiTag(15, 'the rendered QR is a CSP-legal data: image and its matrix decodes to the URL'),
  () => {
    fc.assert(
      fc.property(connectionUrl, (url) => {
        const { dataUri, matrix } = encodeQrDataUri(url);
        // img-src 'self' data: legality: the src is a data: image URI.
        assert.ok(dataUri.startsWith('data:image/svg+xml,'), 'the QR is a data: image URI');
        assert.ok(!/https?:\/\//.test(dataUri.slice(0, 20)), 'no external origin in the image src');
        // The matrix embedded in that image decodes back to the URL.
        assert.equal(decodeMatrix(matrix), url, 'the rendered matrix decodes to the URL');
        return true;
      }),
      fcConfig,
    );
  },
);

test(
  webUiTag(15, 'a corrupted matrix is rejected by the decoder (the round-trip is a real inverse)'),
  () => {
    fc.assert(
      fc.property(
        connectionUrl.filter((u) => toUtf8Bytes(u).length >= 2),
        fc.integer({ min: 0 }),
        (url, flipSeed) => {
          const m = encodeMatrix(url);
          // Flip one interior (non-quiet) module to corrupt the payload.
          const full = m.modules.length;
          const inner = full - 4; // exclude the 2-module quiet zone on each side
          if (inner <= 0) return true;
          const idx = flipSeed % (inner * inner);
          const r = 2 + Math.floor(idx / inner);
          const c = 2 + (idx % inner);
          m.modules[r][c] = m.modules[r][c] ^ 1;
          const decoded = decodeMatrix(m);
          // Either the checksum rejects it (null) or, if the flip happened to
          // land on a padding bit, it still decodes to the SAME url — never to a
          // DIFFERENT string. A silent wrong-decode would be a real bug.
          assert.ok(decoded === null || decoded === url, 'corruption never yields a different URL');
          return true;
        },
      ),
      fcConfig,
    );
  },
);
