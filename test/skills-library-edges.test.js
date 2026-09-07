/**
 * EXHAUSTIVE Skill Library CRUD edge suite (spec Task 22.5 / FEAT-006,
 * Req 13.5, 13.6, 13.7).
 *
 * REAL collaborators only: the REAL Skill model (src/model/skill.js) and the
 * REAL on-disk StorageLayout (src/storage/layout.js) on an fs.mkdtemp temp dir,
 * plus plumby's REAL loader via the boundary to prove the resolved skill is
 * what a session would actually load. No fakes.
 *
 * The smoke suite (test/skills-library.test.js) proves the happy CRUD +
 * namespacing paths. This suite adds the EDGES it does not, and MUTATION-CHECKS
 * the two namespacing invariants: (i) a User_Skill can NEVER overwrite a
 * reserved base-namespace skill, and (ii) an intra-user-namespace duplicate is
 * rejected leaving the existing skill untouched. Each mutation-check is written
 * so it FAILS if the corresponding protection in library.js is removed — the
 * comment on each states exactly which line reverting it would break.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageLayout } from '../src/storage/layout.js';
import { createSkillLibrary } from '../src/skills/library.js';
import { VENDORED_LOCKIN_SKILLS } from '../src/skills/vendor.js';
import { loadSkills, indexSkills, loadSkillTool } from '../src/engine/plumby.js';

const OWNER = 'owner-edge';

function freshLibrary() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-lib-edge-'));
  const layout = createStorageLayout(base);
  const lib = createSkillLibrary({ layout, now: () => new Date('2026-03-03T00:00:00.000Z') });
  return { base, layout, lib };
}

/**
 * Materialize the Skills `list(ownerId)` returns into a plumby-loadable session
 * cwd (`<cwd>/.plumby/skills/<invocationName-dir>/SKILL.md`), then resolve one
 * by its invocationName through the REAL loader. This proves what a session
 * would actually see, not just the in-memory records.
 */
function loadResolvedBody(base, lib, ownerId, invocationName) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-lib-cwd-'));
  const skillsRoot = path.join(cwd, '.plumby', 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });
  const skills = lib.list(ownerId);
  skills.forEach((s, i) => {
    // Use a unique, filesystem-safe dir per skill; the invocation name lives in
    // the frontmatter, which is what plumby's loader reads for the name.
    const dir = path.join(skillsRoot, `s${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const md = [
      '---',
      `name: ${s.invocationName}`,
      `description: ${String(s.description).replace(/\s+/g, ' ').trim()}`,
      '---',
      '',
      s.body,
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
  });
  const records = loadSkills(cwd);
  const idx = indexSkills(records);
  return { cwd, records, idx, has: idx.has(invocationName), record: idx.get(invocationName) };
}

// --- (a) import missing-field rejection, naming the field, nothing added ----

test('importSkill (structured) missing name → rejected naming "name", nothing added (Req 13.5)', () => {
  const { lib } = freshLibrary();
  const res = lib.importSkill({ ownerId: OWNER, description: 'has a description but no name', body: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing_name');
  assert.match(res.message, /name/);
  assert.equal(lib.readUserSkills(OWNER).length, 0, 'nothing added when name is missing');
});

test('importSkill (structured) missing description → rejected naming "description", nothing added (Req 13.5)', () => {
  const { lib } = freshLibrary();
  const res = lib.importSkill({ ownerId: OWNER, name: 'has-name', body: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing_description');
  assert.match(res.message, /description/);
  assert.equal(lib.readUserSkills(OWNER).length, 0, 'nothing added when description is missing');
});

test('importSkill (SKILL.md text) missing name → rejected naming "name", nothing added (Req 13.5)', () => {
  const { lib } = freshLibrary();
  const md = ['---', 'description: only a description', '---', '', 'body'].join('\n');
  const res = lib.importSkill({ ownerId: OWNER, skillMarkdown: md });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing_name');
  assert.match(res.message, /name/);
  assert.equal(lib.readUserSkills(OWNER).length, 0, 'nothing added');
});

// --- (b) a colliding User_Skill is placed under user/<name> AND still added --

test('a User_Skill colliding with a reserved base-namespace name is placed under user/<name> and IS still added (Req 13.6)', () => {
  const { lib } = freshLibrary();
  const reservedName = VENDORED_LOCKIN_SKILLS[0]; // vendor-lockin-guard
  assert.ok(lib.isReserved(reservedName));

  const res = lib.importSkill({
    ownerId: OWNER,
    name: reservedName,
    description: 'my own take',
    body: 'user body',
  });
  assert.equal(res.ok, true, res.message);
  // Both: it WAS added, AND its invocationName is namespaced.
  assert.equal(res.skill.invocationName, `user/${reservedName}`);
  const stored = lib.readUserSkills(OWNER);
  assert.equal(stored.length, 1, 'the colliding skill was still added');
  assert.equal(stored[0].invocationName, `user/${reservedName}`);
});

test('a User_Skill colliding with the owner\'s own base-level skill is placed under user/<name> and still added (Req 13.6)', () => {
  const { lib } = freshLibrary();
  // First a free base-level name for this owner.
  const first = lib.createUserSkill({ ownerId: OWNER, name: 'my-thing', description: 'first', body: 'a' });
  assert.equal(first.ok, true);
  assert.equal(first.skill.invocationName, 'my-thing');

  // Now the SAME name again collides with the owner's own base-level skill →
  // namespaced under user/my-thing and still added.
  const second = lib.createUserSkill({ ownerId: OWNER, name: 'my-thing', description: 'second', body: 'b' });
  assert.equal(second.ok, true, second.message);
  assert.equal(second.skill.invocationName, 'user/my-thing');
  assert.equal(lib.readUserSkills(OWNER).length, 2, 'both skills exist');
});

// --- (c) MUTATION-CHECK: a User_Skill can NEVER overwrite a reserved skill ---

test('MUTATION-CHECK: a User_Skill cannot overwrite a reserved base-namespace skill — the reserved name still resolves to the RESERVED skill (Req 13.7)', () => {
  const { base, lib } = freshLibrary();
  const stocked = lib.stockedSkills();
  assert.ok(stocked.length >= 1, 'at least one stocked skill ships');
  const reserved = stocked[0]; // a REAL reserved base-namespace skill
  const reservedName = reserved.invocationName;
  assert.ok(lib.isReserved(reservedName));

  // Attempt to overwrite it with a user skill of the SAME name and a marker body.
  const attempt = lib.createUserSkill({
    ownerId: OWNER,
    name: reservedName,
    description: 'HIJACK ATTEMPT',
    body: 'HIJACKED-USER-BODY',
  });
  assert.equal(attempt.ok, true, attempt.message);
  // The user skill lands in the user namespace, never the base name.
  assert.equal(attempt.skill.invocationName, `user/${reservedName}`);

  // Resolve the reserved name through the REAL plumby loader over the Skills the
  // library exposes: it STILL resolves to the reserved skill's body, not the
  // user's. This is the mutation check — if the `isReserved(requestedName)`
  // guard in resolveInvocationName() were removed, the user skill would take the
  // base name `reservedName` and this assertion would fail.
  const resolved = loadResolvedBody(base, lib, OWNER, reservedName);
  try {
    assert.ok(resolved.has, `the reserved name "${reservedName}" still resolves`);
    assert.equal(
      resolved.record.description,
      reserved.description,
      'the reserved name maps to the RESERVED skill, not the user hijack',
    );
    assert.doesNotMatch(resolved.record.description, /HIJACK ATTEMPT/);
    // And the user's namespaced copy still exists in parallel, untouched.
    const userCopy = lib.readUserSkills(OWNER).find((s) => s.invocationName === `user/${reservedName}`);
    assert.ok(userCopy, 'the user copy exists under user/<name>');
    assert.equal(userCopy.body.trim(), 'HIJACKED-USER-BODY');
  } finally {
    fs.rmSync(resolved.cwd, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('MUTATION-CHECK corollary: resolveInvocationName never returns a bare reserved name for a colliding request (Req 13.7)', () => {
  const { lib } = freshLibrary();
  // Reserved names: every stocked + every vendored-lockin name.
  const names = [...lib.stockedSkills().map((s) => s.invocationName), ...VENDORED_LOCKIN_SKILLS];
  for (const reservedName of names) {
    const resolved = lib.resolveInvocationName(OWNER, reservedName);
    assert.equal(resolved.ok, true, resolved.message);
    assert.notEqual(
      resolved.invocationName,
      reservedName,
      `resolveInvocationName must never hand out the reserved base name "${reservedName}"`,
    );
    assert.equal(resolved.invocationName, `user/${reservedName}`);
  }
});

// --- (d) MUTATION-CHECK: intra-user-namespace duplicate rejected, unchanged --

test('MUTATION-CHECK: an intra-user-namespace duplicate is rejected AND leaves the existing skill unchanged (Req 13.6)', () => {
  const { lib } = freshLibrary();
  const reservedName = VENDORED_LOCKIN_SKILLS[0];

  // First collision → placed under user/<name> with the ORIGINAL content.
  const first = lib.createUserSkill({
    ownerId: OWNER,
    name: reservedName,
    description: 'ORIGINAL description',
    body: 'ORIGINAL body',
  });
  assert.equal(first.ok, true);
  assert.equal(first.skill.invocationName, `user/${reservedName}`);

  // Second attempt with the SAME name now collides with the EXISTING
  // user/<name> → REJECTED (intra-user-namespace duplicate). If the
  // `userInvocationNames.has(namespaced)` rejection in resolveInvocationName()
  // were removed, this would instead overwrite/re-add and the assertions below
  // (rejection + unchanged content) would fail.
  const dup = lib.createUserSkill({
    ownerId: OWNER,
    name: reservedName,
    description: 'REPLACEMENT description',
    body: 'REPLACEMENT body',
  });
  assert.equal(dup.ok, false, 'the intra-user-namespace duplicate is rejected');
  assert.equal(dup.code, 'naming_collision');

  // The existing skill's description AND body are untouched.
  const still = lib.readUserSkills(OWNER).filter((s) => s.invocationName === `user/${reservedName}`);
  assert.equal(still.length, 1, 'exactly one user/<name> skill still exists');
  assert.equal(still[0].description, 'ORIGINAL description', 'description unchanged');
  assert.equal(still[0].body.trim(), 'ORIGINAL body', 'body unchanged');
});

test('MUTATION-CHECK: a plain intra-user-namespace duplicate (user/<name> already present) is rejected, existing unchanged (Req 13.6)', () => {
  const { lib } = freshLibrary();

  // Create a user/thing directly by colliding twice on a self-owned base name.
  assert.equal(lib.createUserSkill({ ownerId: OWNER, name: 'thing', description: 'base', body: 'base-body' }).ok, true);
  const nsRes = lib.createUserSkill({ ownerId: OWNER, name: 'thing', description: 'first-ns', body: 'ns-body-1' });
  assert.equal(nsRes.ok, true);
  assert.equal(nsRes.skill.invocationName, 'user/thing');

  // Third attempt: user/thing already exists → rejected, both existing skills unchanged.
  const dup = lib.createUserSkill({ ownerId: OWNER, name: 'thing', description: 'second-ns', body: 'ns-body-2' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'naming_collision');

  const nsExisting = lib.readUserSkills(OWNER).find((s) => s.invocationName === 'user/thing');
  assert.equal(nsExisting.description, 'first-ns', 'the namespaced skill description is unchanged');
  assert.equal(nsExisting.body.trim(), 'ns-body-1', 'the namespaced skill body is unchanged');
});
