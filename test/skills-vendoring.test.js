/**
 * EXHAUSTIVE vendoring + progressive-disclosure edge suite (spec Task 22.5 /
 * FEAT-006, Req 12.1, 12.3, 12.4, 12.10, 12.15).
 *
 * This suite exercises REAL collaborators only — the real createSkillVendor
 * copy step against the REAL sibling agent-skills-lockin checkout, and plumby's
 * REAL loadSkills / buildSkillsBlock / loadSkillTool seams via the plumby
 * boundary (src/engine/plumby.js). It fakes NOTHING here; there is no exec
 * boundary involved in vendoring or progressive disclosure.
 *
 * The smoke suite (test/skills-session.test.js) proves the wiring is real
 * against the checked-in vendored tree. This suite adds the edges NOT covered
 * there:
 *   - the REAL vendor step run against the REAL upstream checkout, then loaded
 *     by the REAL plumby loader, with NO network / NO clone (only fs copies),
 *     and idempotent on re-run;
 *   - each plumby-inherited progressive-disclosure cap AS WIRED: >500-char
 *     description clip, 16 KiB listing cap + notice, 64 KiB body cap + notice,
 *     missing-name → dir name, duplicate → first wins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSkillVendor,
  VENDORED_LOCKIN_SKILLS,
  SKILLS_DIR,
  DEFAULT_UPSTREAM_ROOT,
} from '../src/skills/vendor.js';
import {
  loadSkills,
  buildSkillsBlock,
  indexSkills,
  loadSkillTool,
} from '../src/engine/plumby.js';

/** The REAL sibling upstream checkout (source of truth), resolved off this file. */
const UPSTREAM_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agent-skills-lockin',
);

/** Make a temp session cwd; return { cwd, skillsRoot } where skillsRoot=<cwd>/.plumby/skills. */
function freshSessionCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-vendor-'));
  const skillsRoot = path.join(cwd, SKILLS_DIR);
  fs.mkdirSync(skillsRoot, { recursive: true });
  return { cwd, skillsRoot };
}

/** Write a single skill folder with a SKILL.md into <skillsRoot>/<dir>/. */
function writeSkill(skillsRoot, dir, markdown) {
  const skillDir = path.join(skillsRoot, dir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), markdown, 'utf8');
  return skillDir;
}

// --- VENDORING against the REAL upstream, loaded by the REAL plumby loader ---

test('vendor step against the REAL upstream: both lock-in skills discoverable at session start via plumby loadSkills, no runtime fetch', () => {
  // The default upstream root IS the sibling agent-skills-lockin checkout.
  assert.equal(DEFAULT_UPSTREAM_ROOT, UPSTREAM_ROOT);
  assert.ok(fs.existsSync(UPSTREAM_ROOT), 'sibling agent-skills-lockin checkout must be present');

  const { cwd, skillsRoot } = freshSessionCwd();
  try {
    const vendor = createSkillVendor({ now: () => new Date('2026-02-02T00:00:00.000Z') });
    const result = vendor.vendorInto(skillsRoot);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.vendored.length, VENDORED_LOCKIN_SKILLS.length);

    // Load through plumby's REAL loader over the temp cwd. The loader reads
    // <cwd>/.plumby/skills, which the vendor step just populated by fs copy.
    const loaded = loadSkills(cwd);
    const names = loaded.map((s) => s.name).sort();
    assert.deepEqual(names, [...VENDORED_LOCKIN_SKILLS].sort());

    // Both carry their frontmatter name + a non-empty description at session start.
    for (const name of VENDORED_LOCKIN_SKILLS) {
      const rec = loaded.find((s) => s.name === name);
      assert.ok(rec, `plumby loadSkills discovered "${name}"`);
      assert.ok(rec.description.length > 0, `${name} has a description`);
    }

    // NO network / NO clone: assert the vendor SOURCE MODULE performs only fs
    // copies and contains no fetch/clone/child_process call. This is a
    // code-path assertion complementing the behavioral one above.
    const vendorSrc = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'skills', 'vendor.js'),
      'utf8',
    );
    // Strip comments so a doc-comment mentioning "no runtime fetch" is not a
    // false positive; assert against CODE only.
    const vendorCode = vendorSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(vendorCode, /\bfetch\s*\(/, 'vendor step must not call fetch()');
    assert.doesNotMatch(vendorCode, /node:child_process|['"]child_process['"]|execSync\s*\(|spawn\s*\(/, 'vendor step must not shell out');
    assert.doesNotMatch(vendorCode, /simple-git|isomorphic-git/, 'vendor step must not clone');
    assert.doesNotMatch(vendorCode, /from\s+['"]node:https?['"]|from\s+['"]node:net['"]/, 'vendor step must not import network modules');
    assert.match(vendorCode, /cpSync/, 'vendor step copies via node:fs cpSync');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('vendor step is idempotent: a re-run resyncs the same result from upstream', () => {
  const { cwd, skillsRoot } = freshSessionCwd();
  try {
    const vendor = createSkillVendor();
    const first = vendor.vendorInto(skillsRoot);
    assert.equal(first.ok, true, first.message);
    const firstNames = first.vendored.map((v) => v.name).sort();

    // A stray file inside a vendored folder is cleared by the idempotent
    // remove-then-copy, proving the re-run genuinely resyncs from upstream.
    const strayDir = path.join(skillsRoot, VENDORED_LOCKIN_SKILLS[0]);
    fs.writeFileSync(path.join(strayDir, 'STRAY.txt'), 'delete me', 'utf8');

    const second = vendor.vendorInto(skillsRoot);
    assert.equal(second.ok, true, second.message);
    assert.deepEqual(second.vendored.map((v) => v.name).sort(), firstNames);
    assert.equal(
      fs.existsSync(path.join(strayDir, 'STRAY.txt')),
      false,
      're-run must clear the destination and copy fresh from upstream',
    );

    // Same skills still discoverable by the REAL loader after the re-run.
    const loaded = loadSkills(cwd).map((s) => s.name).sort();
    assert.deepEqual(loaded, [...VENDORED_LOCKIN_SKILLS].sort());
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// --- PROGRESSIVE DISCLOSURE edges via the REAL plumby seams (as wired) -------

test('progressive disclosure: a >500-char description is clipped in the listing block (Req 12.3)', () => {
  const { cwd, skillsRoot } = freshSessionCwd();
  try {
    const longDesc = 'X'.repeat(900); // well past the 500-char cap
    writeSkill(
      skillsRoot,
      'verbose',
      ['---', 'name: verbose', `description: ${longDesc}`, '---', '', '# Body'].join('\n'),
    );

    const records = loadSkills(cwd);
    const block = buildSkillsBlock(records);
    assert.match(block, /## Available skills/);

    // The line for `verbose` must be present but the description clipped well
    // below the 900 chars we wrote (plumby clips to <=500 chars with an ellipsis).
    const line = block.split('\n').find((l) => l.startsWith('- verbose:'));
    assert.ok(line, 'listing block has a line for the verbose skill');
    const shown = line.slice('- verbose: '.length);
    assert.ok(shown.length <= 501, `description clipped (was ${shown.length} chars)`);
    assert.ok(shown.length < longDesc.length, 'the full 900-char description is not shown verbatim');
    assert.match(shown, /…$/, 'clipped description ends with an ellipsis');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('progressive disclosure: many skills overflow the 16 KiB listing cap with a visible truncation notice (Req 12.3)', () => {
  const { cwd, skillsRoot } = freshSessionCwd();
  try {
    // Each skill contributes ~500 chars of description; enough of them push the
    // whole block past the 16 KiB listing budget so plumby truncates loudly.
    const desc = 'D'.repeat(480);
    for (let i = 0; i < 120; i += 1) {
      const name = `skill-${String(i).padStart(3, '0')}`;
      writeSkill(
        skillsRoot,
        name,
        ['---', `name: ${name}`, `description: ${desc}`, '---', '', '# Body'].join('\n'),
      );
    }

    const records = loadSkills(cwd);
    const block = buildSkillsBlock(records);
    // 16 KiB cap = 16 * 1024 chars. Allow a small slack for the appended notice.
    assert.ok(
      block.length <= 16 * 1024 + 200,
      `listing block capped near 16 KiB (was ${block.length} chars)`,
    );
    assert.match(block, /\[truncated:.*skill listing/i, 'a visible truncation notice is present');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('progressive disclosure: a >64 KiB SKILL.md body loads truncated with a notice via loadSkillTool (Req 12.4)', async () => {
  const { cwd, skillsRoot } = freshSessionCwd();
  try {
    const hugeBody = `# Huge\n\n${'B'.repeat(80 * 1024)}`; // > 64 KiB body
    writeSkill(
      skillsRoot,
      'huge',
      ['---', 'name: huge', 'description: a very large body', '---', '', hugeBody].join('\n'),
    );

    const records = loadSkills(cwd);
    const skills = indexSkills(records);
    const out = await loadSkillTool.handler({ name: 'huge' }, { skills, cwd });

    // The body is capped near 64 KiB and carries a loud truncation notice.
    assert.match(out, /^# Skill: huge/);
    assert.match(out, /\[truncated:.*skill body exceeded/i, 'a body-cap truncation notice is present');
    assert.ok(
      Buffer.byteLength(out, 'utf8') < 80 * 1024,
      `the full 80 KiB body is not returned (got ${Buffer.byteLength(out, 'utf8')} bytes)`,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('progressive disclosure: a SKILL.md with no frontmatter name gets its directory name (Req 12.10)', () => {
  const { cwd, skillsRoot } = freshSessionCwd();
  try {
    // No `name` in frontmatter — only a description. plumby falls back to the dir.
    writeSkill(
      skillsRoot,
      'no-name-here',
      ['---', 'description: named by its directory', '---', '', '# Body'].join('\n'),
    );

    const records = loadSkills(cwd);
    const rec = records.find((s) => s.name === 'no-name-here');
    assert.ok(rec, 'the skill is discovered under its directory name');
    assert.equal(rec.description, 'named by its directory');

    // And it is loadable by that fallback name through the real tool index.
    const skills = indexSkills(records);
    assert.ok(skills.has('no-name-here'), 'indexed under the directory-name fallback');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('progressive disclosure: two dirs resolving to the same invocation name keep the first discovered (Req 12.10)', async () => {
  const { cwd, skillsRoot } = freshSessionCwd();
  try {
    // plumby sorts directories by name, so `a-dup` is discovered before `z-dup`.
    // Both declare the SAME frontmatter name `dup` — first-discovered wins.
    writeSkill(
      skillsRoot,
      'a-dup',
      ['---', 'name: dup', 'description: the FIRST one', '---', '', 'FIRST BODY'].join('\n'),
    );
    writeSkill(
      skillsRoot,
      'z-dup',
      ['---', 'name: dup', 'description: the SECOND one', '---', '', 'SECOND BODY'].join('\n'),
    );

    const records = loadSkills(cwd);
    const dupRecords = records.filter((s) => s.name === 'dup');
    assert.equal(dupRecords.length, 1, 'only one record survives for the duplicate name');
    assert.equal(dupRecords[0].description, 'the FIRST one', 'the first-discovered record wins');

    // The tool loads the FIRST body, confirming first-wins end to end.
    const skills = indexSkills(records);
    const body = await loadSkillTool.handler({ name: 'dup' }, { skills, cwd });
    assert.match(body, /FIRST BODY/);
    assert.doesNotMatch(body, /SECOND BODY/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
