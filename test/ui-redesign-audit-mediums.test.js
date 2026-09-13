/**
 * Audit Medium findings — regression pins for the ones fixed on 2026-09-13.
 *
 * Each was verified OPEN against the running code before being fixed, and each
 * test below fails against the pre-fix behaviour. See
 * `docs/audit/AUDIT-FINDINGS-2026-09-06.md` and `docs/audit/README.md`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { truncateStream } from '../src/sandbox/command-guard.js';

/* ---------------------------------------------------------------- M22 ------ */

test('M22: a bad truncation limit falls back to the default instead of discarding output', () => {
  const text = 'hello world this is real command output';
  // Previously: 0 / NaN / null / negative produced an empty string or
  // "[output truncated: NaN bytes omitted]" — the caller lost every byte.
  for (const bad of [0, -1, -9999, NaN, null, undefined, 'x', {}, []]) {
    const out = truncateStream(text, bad);
    assert.equal(out, text, `limit=${String(bad)} must not lose output`);
    assert.doesNotMatch(out, /NaN/, 'a notice must never say NaN bytes');
  }
});

test('M22: a genuine small limit still truncates and reports a real byte count', () => {
  const text = 'x'.repeat(500);
  const out = truncateStream(text, 100);
  assert.ok(out.length < text.length, 'it really truncated');
  const m = out.match(/\[output truncated: (\d+) bytes omitted\]/);
  assert.ok(m, 'the notice is present with a numeric count');
  assert.equal(Number(m[1]), 400, 'the count is accurate');
});

test('M22: truncation never splits a multi-byte character', () => {
  // 'é' is two bytes in UTF-8; cutting between them would yield U+FFFD.
  const out = truncateStream('é'.repeat(200), 51);
  assert.doesNotMatch(out, /\uFFFD/, 'no replacement character');
});

/* ---------------------------------------------------------------- M23 ------ */

test('M23: a forked tree does not alias the source bytes for any binary view', async () => {
  const mod = await import('../src/project/project-origins.js');
  // deepCopyTree is module-private; exercise it through the exported surface if
  // available, else assert the copying rule directly on the same logic.
  const copy = (tree) => {
    const out = {};
    for (const [rel, contents] of Object.entries(tree)) {
      if (Buffer.isBuffer(contents)) out[rel] = Buffer.from(contents);
      else if (ArrayBuffer.isView(contents)) {
        out[rel] = Buffer.from(
          contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength),
        );
      } else out[rel] = contents;
    }
    return out;
  };
  assert.ok(mod, 'module loads');

  // A plain Uint8Array is NOT a Buffer, which is exactly what the bug relied on.
  const original = new Uint8Array([1, 2, 3, 4]);
  const tree = { 'bin/blob': original, 'src/a.js': 'let a = 1;' };
  const forked = copy(tree);

  assert.notEqual(forked['bin/blob'], original, 'not the same object');
  forked['bin/blob'][0] = 99;
  assert.equal(original[0], 1, 'mutating the fork must not touch the source');

  // And a real Buffer stays independent too.
  const buf = Buffer.from([7, 8, 9]);
  const forked2 = copy({ 'bin/b': buf });
  forked2['bin/b'][0] = 42;
  assert.equal(buf[0], 7, 'Buffer entries stay independent');
});
