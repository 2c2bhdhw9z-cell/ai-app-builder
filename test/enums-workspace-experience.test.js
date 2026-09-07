/**
 * Workspace_Experience enum tests (Task 31.4, Req 27.1/27.6/27.7).
 *
 * Exercises the REAL closed enum from src/model/enums.js — no mocks. The enum
 * is CLOSED: exactly the five values, in order, frozen. These assertions are
 * mutation-sensitive: adding, removing, renaming, or reordering a value flips
 * the deepStrictEqual, and the isValid predicate cases pin acceptance to
 * exactly those five names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Workspace_Experience,
  isValidWorkspaceExperience,
  DEFAULT_WORKSPACE_EXPERIENCE,
} from '../src/model/enums.js';

test('Workspace_Experience is frozen and equals exactly the five values IN ORDER', () => {
  // Mutation-sensitive: this exact array flips if a value is added, removed,
  // renamed, or reordered.
  assert.deepStrictEqual(Workspace_Experience, [
    'kiro-style',
    'vibe-first',
    'technical-workbench',
    'mobile-command-center',
    'custom',
  ]);
  assert.equal(Workspace_Experience.length, 5);
  assert.ok(Object.isFrozen(Workspace_Experience), 'enum must be frozen');

  // A frozen array cannot be mutated (closed set at runtime).
  assert.throws(() => {
    Workspace_Experience.push('ide');
  });
  assert.equal(Workspace_Experience.length, 5, 'still exactly five after a rejected push');
});

test('isValidWorkspaceExperience is true for each of the five values', () => {
  for (const value of ['kiro-style', 'vibe-first', 'technical-workbench', 'mobile-command-center', 'custom']) {
    assert.equal(isValidWorkspaceExperience(value), true, `${value} must be valid`);
  }
  // And true for every declared enum member, so this can never drift from the enum.
  for (const value of Workspace_Experience) {
    assert.equal(isValidWorkspaceExperience(value), true);
  }
});

test('isValidWorkspaceExperience is false for out-of-enum inputs', () => {
  const rejected = ['kiro', 'VIBE-FIRST', '', 'ide', 'Kiro-style', 'default', ' custom'];
  for (const value of rejected) {
    assert.equal(isValidWorkspaceExperience(value), false, `${JSON.stringify(value)} must be rejected`);
  }
  // Non-string types are rejected too.
  for (const value of [null, undefined, 123, {}, [], true]) {
    assert.equal(isValidWorkspaceExperience(value), false, `${JSON.stringify(value)} must be rejected`);
  }
});

test('DEFAULT_WORKSPACE_EXPERIENCE is one of the five values', () => {
  assert.equal(isValidWorkspaceExperience(DEFAULT_WORKSPACE_EXPERIENCE), true);
  assert.ok(Workspace_Experience.includes(DEFAULT_WORKSPACE_EXPERIENCE));
  // The documented default (Req 27.6) is the Kiro-style Workspace.
  assert.equal(DEFAULT_WORKSPACE_EXPERIENCE, 'kiro-style');
});
