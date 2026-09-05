/**
 * Storage-split invariant tests (node --test).
 *
 * Proves the core guarantee (Req 9.7, 10.4, Properties 8, 9, 14): given a
 * projectId/ownerId, every control-plane / secret path resolves OUTSIDE every
 * exportable project tree, so a secret value's storage location can never fall
 * inside an exported project tree. Covers project-registry, share-link,
 * connector-binding, and secret locations, and confirms control-plane records
 * are keyed by ownerId (three-axis isolation, Req 7.6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createStorageLayout } from '../src/storage/layout.js';

const BASE = '/var/lib/aab';
const OWNER = 'u1';
const PROJECT = 'p1';

test('exportRoot and controlRoot are siblings; neither contains the other', () => {
  const layout = createStorageLayout(BASE);
  const relDown = path.relative(layout.exportRoot, layout.controlRoot);
  const relUp = path.relative(layout.controlRoot, layout.exportRoot);
  // Each must escape upward (start with '..') to reach the other ⇒ no nesting.
  assert.ok(relDown.startsWith('..'), 'controlRoot must not be under exportRoot');
  assert.ok(relUp.startsWith('..'), 'exportRoot must not be under controlRoot');
});

test('exportable project tree, memory, and skills are INSIDE the export tree', () => {
  const layout = createStorageLayout(BASE);
  const tree = layout.exportableProjectTree(PROJECT);
  assert.ok(layout.isInsideExportTree(tree));
  assert.ok(layout.isInsideExportTree(layout.exportableMemoryPath(PROJECT)));
  assert.ok(layout.isInsideExportTree(layout.exportableSkillsPath(PROJECT)));
});

test('control-plane paths are all OUTSIDE every exportable project tree', () => {
  const layout = createStorageLayout(BASE);

  const controlPaths = {
    'project-registry': layout.controlProjectRegistryPath(OWNER),
    'share-link': layout.controlShareLinkPath(OWNER, 'tok-abc'),
    'connector-binding': layout.controlConnectorBindingPath(OWNER, PROJECT),
    secret: layout.controlSecretPath(OWNER, PROJECT, 'DATABASE_URL'),
  };

  for (const [label, p] of Object.entries(controlPaths)) {
    assert.equal(
      layout.isInsideExportTree(p),
      false,
      `${label} path (${p}) must be outside the export tree`,
    );
    // assertOutsideExportTrees must not throw for a control-plane path.
    assert.doesNotThrow(() => layout.assertOutsideExportTrees(p, label));
  }
});

test('secret path can never fall inside the project export tree, even same ids', () => {
  const layout = createStorageLayout(BASE);
  const tree = layout.exportableProjectTree(PROJECT);
  const secret = layout.controlSecretPath(OWNER, PROJECT, 'STRIPE_SECRET_KEY');
  // The secret must NOT be a descendant of this project's exportable tree.
  const rel = path.relative(tree, secret);
  assert.ok(rel.startsWith('..'), `secret (${secret}) must escape the project tree (${tree})`);
});

test('assertOutsideExportTrees throws for a path inside an export tree', () => {
  const layout = createStorageLayout(BASE);
  const inside = path.join(layout.exportableProjectTree(PROJECT), 'secrets', 'leak.enc');
  assert.throws(() => layout.assertOutsideExportTrees(inside, 'leak'), /storage-split violation/);
});

test('control-plane paths are keyed by ownerId (three-axis isolation)', () => {
  const layout = createStorageLayout(BASE);
  const a = layout.controlSecretPath('ownerA', PROJECT, 'X');
  const b = layout.controlSecretPath('ownerB', PROJECT, 'X');
  assert.notEqual(a, b);
  assert.ok(a.includes(`${path.sep}ownerA${path.sep}`));
  assert.ok(b.includes(`${path.sep}ownerB${path.sep}`));
  // Registry, share-links, and bindings are likewise owner-scoped.
  assert.ok(layout.controlProjectRegistryPath('ownerA').includes(`${path.sep}ownerA${path.sep}`));
  assert.ok(layout.controlShareLinkPath('ownerA', 'tok').includes(`${path.sep}ownerA${path.sep}`));
  assert.ok(layout.controlConnectorBindingPath('ownerA', PROJECT).includes(`${path.sep}ownerA${path.sep}`));
});

test('id path-segment validation rejects traversal and separators', () => {
  const layout = createStorageLayout(BASE);
  assert.throws(() => layout.exportableProjectTree('../escape'), /single safe path segment/);
  assert.throws(() => layout.controlSecretPath(OWNER, PROJECT, '../../etc/passwd'), /single safe path segment/);
  assert.throws(() => layout.controlSecretPath('', PROJECT, 'X'), /non-empty string/);
});
