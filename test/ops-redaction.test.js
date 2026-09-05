/**
 * Centralized secret-redaction filter tests (node --test), spec Task 12 / Req 24.4.
 *
 * The createRedactor factory is THE single filter every audit / metrics / error
 * log path routes through. These tests cover:
 *   (a) a known secret value redacted when it appears standalone;
 *   (b) redacted as a nested object value;
 *   (c) redacted as an array element;
 *   (d) redacted as a SUBSTRING of a larger stderr-like string;
 *   (e) the input object is NOT mutated (deep copy returned);
 *   (f) empty / short candidate values are NOT over-redacted;
 *   (g) a non-secret string passes through unchanged;
 *   (h) redaction by known secret NAME (object key);
 *   (i) determinism / purity.
 *
 * Mutation guard: if createRedactor().redact is neutered to a no-op passthrough,
 * the substring-redaction assertion below FAILS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor, REDACTION_PLACEHOLDER } from '../src/ops/index.js';

const SECRET = 'sk-live-9f8a7b6c5d4e3f21';

test('redacts a known secret value appearing standalone', () => {
  const r = createRedactor({ secretValues: [SECRET] });
  assert.equal(r.redactString(SECRET), REDACTION_PLACEHOLDER);
  assert.equal(r.redact(SECRET), REDACTION_PLACEHOLDER);
});

test('redacts a known secret value nested in an object', () => {
  const r = createRedactor({ secretValues: [SECRET] });
  const input = { level: 'error', ctx: { token: SECRET, user: 'alice' } };
  const out = r.redact(input);
  assert.equal(out.ctx.token, REDACTION_PLACEHOLDER);
  assert.equal(out.ctx.user, 'alice');
  assert.equal(out.level, 'error');
});

test('redacts a known secret value as an array element', () => {
  const r = createRedactor({ secretValues: [SECRET] });
  const out = r.redact({ args: ['--token', SECRET, '--verbose'] });
  assert.deepEqual(out.args, ['--token', REDACTION_PLACEHOLDER, '--verbose']);
});

test('redacts a known secret value embedded as a SUBSTRING of a larger string', () => {
  const r = createRedactor({ secretValues: [SECRET] });
  const stderr = `curl: auth failed using Authorization: Bearer ${SECRET} (401)`;
  const out = r.redact({ stderr });
  assert.equal(out.stderr, `curl: auth failed using Authorization: Bearer ${REDACTION_PLACEHOLDER} (401)`);
  assert.ok(!out.stderr.includes(SECRET), 'plaintext secret must not survive');
});

test('does not mutate its input (returns a deep copy)', () => {
  const r = createRedactor({ secretValues: [SECRET] });
  const input = { ctx: { token: SECRET }, args: [SECRET] };
  const snapshot = JSON.stringify(input);
  const out = r.redact(input);
  assert.equal(JSON.stringify(input), snapshot, 'input must be unchanged');
  assert.notEqual(out.ctx, input.ctx, 'nested object must be a copy');
  assert.notEqual(out.args, input.args, 'nested array must be a copy');
});

test('does not over-redact empty or short candidate values', () => {
  const r = createRedactor({ secretValues: ['', 'a', '12', 'abc'] });
  const line = 'a 12 abc value with a and 12 scattered about';
  assert.equal(r.redactString(line), line, 'short candidates are skipped');
  assert.equal(r.redactString(''), '');
});

test('a non-secret string passes through unchanged', () => {
  const r = createRedactor({ secretValues: [SECRET] });
  const clean = 'build succeeded in 4.2s with 0 warnings';
  assert.equal(r.redactString(clean), clean);
  assert.deepEqual(r.redact({ msg: clean, n: 3, ok: true, none: null }), {
    msg: clean,
    n: 3,
    ok: true,
    none: null,
  });
});

test('redacts a value by known secret NAME (object key)', () => {
  const r = createRedactor({ secretNames: ['STRIPE_KEY'] });
  const out = r.redact({ env: { STRIPE_KEY: 'anything-goes-here', PUBLIC: 'ok' } });
  assert.equal(out.env.STRIPE_KEY, REDACTION_PLACEHOLDER);
  assert.equal(out.env.PUBLIC, 'ok');
});

test('is deterministic / pure for the same input and secret set', () => {
  const r = createRedactor({ secretValues: [SECRET] });
  const input = { stderr: `token=${SECRET}`, items: [SECRET, 'safe'] };
  assert.deepEqual(r.redact(input), r.redact(input));
});
