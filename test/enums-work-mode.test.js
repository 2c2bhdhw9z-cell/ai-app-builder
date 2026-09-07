/**
 * Work_Mode enum tests (Task 32.4, Req 28.1/28.3/28.7).
 *
 * Exercises the REAL closed enum from src/model/enums.js — no mocks. The enum
 * is CLOSED: exactly the three values, in order, frozen. These assertions are
 * mutation-sensitive: adding, removing, renaming, or reordering a value flips
 * the deepStrictEqual, and the isValid predicate cases pin acceptance to
 * exactly those three names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Work_Mode,
  isValidWorkMode,
  DEFAULT_WORK_MODE,
} from '../src/model/enums.js';

test('Work_Mode is frozen and equals exactly the three values IN ORDER', () => {
  // Mutation-sensitive: this exact array flips if a value is added, removed,
  // renamed, or reordered.
  assert.deepStrictEqual(Work_Mode, ['vibe', 'spec', 'hybrid']);
  assert.equal(Work_Mode.length, 3);
  assert.ok(Object.isFrozen(Work_Mode), 'enum must be frozen');

  // A frozen array cannot be mutated (closed set at runtime).
  assert.throws(() => {
    Work_Mode.push('plan');
  });
  assert.equal(Work_Mode.length, 3, 'still exactly three after a rejected push');
});

test('isValidWorkMode is true for each of the three values', () => {
  for (const value of ['vibe', 'spec', 'hybrid']) {
    assert.equal(isValidWorkMode(value), true, `${value} must be valid`);
  }
  // And true for every declared enum member, so this can never drift from the enum.
  for (const value of Work_Mode) {
    assert.equal(isValidWorkMode(value), true);
  }
});

test('isValidWorkMode is false for out-of-enum inputs', () => {
  const rejected = ['Vibe', 'SPEC', '', 'plan', ' hybrid', 'HYBRID', 'vibe-first'];
  for (const value of rejected) {
    assert.equal(isValidWorkMode(value), false, `${JSON.stringify(value)} must be rejected`);
  }
  // Non-string types are rejected too.
  for (const value of [null, undefined, 123, {}, [], true]) {
    assert.equal(isValidWorkMode(value), false, `${JSON.stringify(value)} must be rejected`);
  }
});

test('DEFAULT_WORK_MODE is vibe and is one of the three values', () => {
  assert.equal(isValidWorkMode(DEFAULT_WORK_MODE), true);
  assert.ok(Work_Mode.includes(DEFAULT_WORK_MODE));
  // The documented default (Req 28.3) is the describe-and-build 'vibe' mode.
  assert.equal(DEFAULT_WORK_MODE, 'vibe');
});
