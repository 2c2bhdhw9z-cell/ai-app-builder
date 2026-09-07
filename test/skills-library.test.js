/**
 * SkillLibrary smoke tests (node --test) — spec Task 22.3, Req 13.1–13.9.
 *
 * These use the REAL Skill model + REAL on-disk StorageLayout on an
 * fs.mkdtemp temp dir. Exhaustive CRUD-edge coverage lands in FEAT-006; this
 * file proves the core CRUD + namespacing paths are real and pass, and that a
 * stored User_Skill round-trips as an open-format SKILL.md loadable by plumby's
 * REAL loader (Property 19 spirit, Req 13.9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageLayout } from '../src/storage/layout.js';
import { createSkillLibrary } from '../src/skills/library.js';
import { VENDORED_LOCKIN_SKILLS } from '../src/skills/vendor.js';
import { loadSkills } from '../src/engine/plumby.js';

const OWNER = 'owner-1';

function freshLibrary() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-lib-'));
  const layout = createStorageLayout(base);
  const lib = createSkillLibrary({ layout, now: () => new Date('2026-01-01T00:00:00.000Z') });
  return { base, layout, lib };
}

test('ships curated Stocked_Skills in the reserved base namespace', () => {
  const { lib } = freshLibrary();
  const stocked = lib.stockedSkills();
  assert.ok(stocked.length >= 2, 'at least two stocked skills ship');
  for (const s of stocked) {
    assert.equal(s.kind, 'stocked');
    assert.ok(s.name && s.description, 'each stocked skill has name + description');
    assert.ok(lib.isReserved(s.invocationName), 'stocked names are reserved');
  }
  // The vendored lock-in names are also reserved.
  for (const name of VENDORED_LOCKIN_SKILLS) {
    assert.ok(lib.isReserved(name), `${name} is reserved`);
  }
});

test('createUserSkill adds an open-format SKILL.md under a per-owner root', () => {
  const { layout, lib } = freshLibrary();
  const res = lib.createUserSkill({ ownerId: OWNER, name: 'my-workflow', description: 'Do the thing', body: '# Body\n' });
  assert.equal(res.ok, true);
  assert.equal(res.skill.invocationName, 'my-workflow');

  const root = layout.controlUserSkillsRoot(OWNER);
  // Load the owner's skills root through plumby's REAL loader by pointing a cwd
  // whose `.plumby/skills` is that root.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-cwd-'));
  fs.mkdirSync(path.join(cwd, '.plumby'), { recursive: true });
  fs.symlinkSync(root, path.join(cwd, '.plumby', 'skills'));
  const loaded = loadSkills(cwd);
  assert.ok(loaded.some((s) => s.name === 'my-workflow' && s.description === 'Do the thing'));
});

test('importSkill rejects a SKILL.md missing description, naming the field, adding nothing', () => {
  const { lib } = freshLibrary();
  const md = ['---', 'name: imported', '---', '', 'body'].join('\n');
  const res = lib.importSkill({ ownerId: OWNER, skillMarkdown: md });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing_description');
  assert.match(res.message, /description/);
  assert.equal(lib.readUserSkills(OWNER).length, 0, 'nothing was added');
});

test('importSkill rejects missing name, naming the field', () => {
  const { lib } = freshLibrary();
  const res = lib.importSkill({ ownerId: OWNER, description: 'no name here' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing_name');
  assert.match(res.message, /name/);
});

test('a User_Skill colliding with a reserved name is placed under user/<name> and still added', () => {
  const { lib } = freshLibrary();
  const reservedName = lib.stockedSkills()[0].invocationName;
  const res = lib.createUserSkill({ ownerId: OWNER, name: reservedName, description: 'my override attempt', body: 'x' });
  assert.equal(res.ok, true);
  assert.equal(res.skill.invocationName, `user/${reservedName}`);
  // The reserved skill is unchanged (still reserved; user copy is namespaced).
  assert.ok(lib.isReserved(reservedName));
});

test('intra-user-namespace duplicate is rejected and leaves the existing skill unchanged', () => {
  const { lib } = freshLibrary();
  const reservedName = lib.stockedSkills()[0].invocationName;
  const first = lib.createUserSkill({ ownerId: OWNER, name: reservedName, description: 'first', body: 'one' });
  assert.equal(first.ok, true);
  assert.equal(first.skill.invocationName, `user/${reservedName}`);

  const dup = lib.createUserSkill({ ownerId: OWNER, name: reservedName, description: 'second', body: 'two' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'naming_collision');

  const still = lib.readUserSkills(OWNER).find((s) => s.invocationName === `user/${reservedName}`);
  assert.equal(still.description, 'first', 'existing skill unchanged');
  assert.equal(still.body.trim(), 'one');
});

test('edit/delete affect only the owner skill and reject reserved names; deleteAccountData clears the owner', () => {
  const { lib } = freshLibrary();
  lib.createUserSkill({ ownerId: OWNER, name: 'w', description: 'orig', body: 'a' });

  const edited = lib.editUserSkill({ ownerId: OWNER, invocationName: 'w', description: 'updated' });
  assert.equal(edited.ok, true);
  assert.equal(lib.readUserSkills(OWNER)[0].description, 'updated');

  const reservedName = lib.stockedSkills()[0].invocationName;
  assert.equal(lib.editUserSkill({ ownerId: OWNER, invocationName: reservedName, description: 'x' }).code, 'reserved_skill');
  assert.equal(lib.deleteUserSkill({ ownerId: OWNER, invocationName: reservedName }).code, 'reserved_skill');
  // stocked skill untouched
  assert.ok(lib.stockedSkills().some((s) => s.invocationName === reservedName));

  assert.equal(lib.deleteUserSkill({ ownerId: OWNER, invocationName: 'w' }).ok, true);
  assert.equal(lib.readUserSkills(OWNER).length, 0);

  lib.createUserSkill({ ownerId: OWNER, name: 'again', description: 'd', body: 'b' });
  assert.equal(lib.deleteAccountData(OWNER).ok, true);
  assert.equal(lib.readUserSkills(OWNER).length, 0);
});

test('cross-user reuse of the same name is fine (namespaced by ownerId)', () => {
  const { lib } = freshLibrary();
  assert.equal(lib.createUserSkill({ ownerId: 'a', name: 'shared', description: 'da', body: '' }).skill.invocationName, 'shared');
  assert.equal(lib.createUserSkill({ ownerId: 'b', name: 'shared', description: 'db', body: '' }).skill.invocationName, 'shared');
});
