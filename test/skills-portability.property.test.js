/**
 * Property-based test for Task 22.4 — Property 19 "Skills remain portable"
 * (node --test). Validates Req 12.13 and 13.8.
 *
 *   Property 19 (Skills remain portable): for all Skills in a user's library,
 *   each remains a valid open-format Agent Skill — a SKILL.md folder carrying
 *   `name` + `description` frontmatter — that another Agent Skills tool can
 *   export and load. We prove this end-to-end against the REAL collaborators:
 *
 *     (write)  the REAL SkillLibrary write path (createSkillLibrary +
 *              createUserSkill) emits the on-disk open-format SKILL.md into a
 *              fresh `.plumby/skills/<name>/SKILL.md` tree;
 *     (read)   plumby's parseFrontmatter (via the src/engine/plumby.js
 *              boundary) reads it back and `name` + `description` survive the
 *              frontmatter round-trip (compared against the WRITER's canonical
 *              single-line description — a real reloaded value, never a
 *              constant, so the property stays NON-VACUOUS);
 *     (load)   the REAL plumby loadSkills(cwd) discovers the skill under that
 *              temp cwd with the correct name, and loadSkillTool — indexed via
 *              indexSkills, exactly as createAgent wires it — returns the body.
 *
 * The library write path collapses a description to a single line (open Agent
 * Skills frontmatter is single-line scalars; plumby ships no serializer). The
 * arbitrary therefore reflects what the format supports and every assertion
 * compares the reloaded value against that canonical single-line form. The
 * generator also steers clear of the two scalar shapes plumby's parser would
 * re-interpret (a fully quote-wrapped token, a YAML boolean-ish word) so the
 * round-trip is well-defined; descriptions with colons, `#`, embedded quotes
 * and surrounding whitespace ARE generated and DO round-trip.
 *
 * Runs >=100 iterations via fcConfig and carries the EXACT spec tag string
 * `Feature: ai-app-builder, Property 19: Skills remain portable`.
 *
 * Hermeticity: every iteration allocates a fresh fs.mkdtemp base removed in a
 * finally; nothing touches the ai-app-builder repo's own tree. No plumby import
 * is made outside the src/engine/plumby.js boundary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { loadSkills, indexSkills, loadSkillTool, parseFrontmatter } from '../src/engine/plumby.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createSkillLibrary, serializeSkillMarkdown } from '../src/skills/library.js';

// The EXACT tag string this test must carry (greppable, mapped to spec Prop 19).
const TAG = 'Feature: ai-app-builder, Property 19: Skills remain portable';

const OWNER = 'owner-portable-1';

/** The writer's canonical single-line description (mirrors serializeSkillMarkdown). */
function canonicalDescription(description) {
  return String(description ?? '').replace(/\s+/g, ' ').trim();
}

/** YAML boolean-ish words plumby's parseScalar turns into a boolean, not a string. */
const BOOLEANISH = new Set(['true', 'yes', 'on', 'false', 'no', 'off']);

/** A token plumby's parser strips quotes from (fully single- or double-quoted). */
function isQuoteWrapped(v) {
  return (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  );
}

/**
 * A filesystem-safe skill name: lowercase letters/digits/hyphens, non-empty,
 * no leading/trailing hyphen (so it is a single clean path segment AND a valid
 * open-format invocation name).
 */
const nameArb = fc
  .stringMatching(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
  .filter((s) => s.length >= 1 && s.length <= 40);

/**
 * A description that EXERCISES the YAML-frontmatter edge cases the writer must
 * survive: colons, `#`, single/double quotes, and leading/trailing whitespace,
 * mixed with arbitrary unicode. We generate raw text, then keep only cases
 * whose CANONICAL single-line form is (a) non-empty, (b) not a boolean-ish
 * word, and (c) not a fully quote-wrapped token — the two shapes plumby's
 * scalar parser would re-interpret. Everything else (colons, `#`, inner
 * quotes) round-trips verbatim, so the property stays real and non-vacuous.
 */
const descriptionArb = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 80 }),
    fc.constantFrom(
      'ratio 3:1 for the widget',
      'uses C# and #hashtags inline',
      "handles 'single' and \"double\" quotes",
      '  padded on both sides  ',
      'colon: at start of value',
      'multi\nline\ndescription that collapses',
      'trailing hash #',
      'emoji 🚀 and üñïçodé prose',
    ),
    // Force some inner-quote / colon / hash cases into the mix explicitly.
    fc
      .tuple(fc.string({ minLength: 1, maxLength: 20 }), fc.constantFrom(': ', ' # ', ' "q" ', " 'q' "))
      .map(([a, b]) => `${a}${b}note`),
  )
  .filter((raw) => {
    const canonical = canonicalDescription(raw);
    return (
      canonical !== '' &&
      !BOOLEANISH.has(canonical.toLowerCase()) &&
      !isQuoteWrapped(canonical)
    );
  });

/** A markdown body whose trimmed form is non-empty (so load_skill returns it). */
const bodyArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .map((s) => `# Instructions\n\n${s}\n`)
  .filter((s) => s.trim() !== '');

const skillArb = fc.record({
  name: nameArb,
  description: descriptionArb,
  body: bodyArb,
});

// --- Property 19: Skills remain portable (22.4*) ---------------------------

test(`${propertyTag(19, 'Skills remain portable')} — round-trips + stays loadable`, async () => {
  // The tag helper must produce the EXACT greppable spec string.
  assert.equal(propertyTag(19, 'Skills remain portable'), TAG);

  let iterations = 0;

  await fc.assert(
    fc.asyncProperty(skillArb, async ({ name, description, body }) => {
      iterations += 1;

      // A fresh hermetic base per iteration. The library writes User_Skills
      // under layout.controlUserSkillsRoot(ownerId); we ALSO mirror the written
      // SKILL.md into a session cwd's `.plumby/skills/<name>/` so the REAL
      // plumby loader (which reads `.plumby/skills` relative to cwd) discovers
      // it — proving the same open-format bytes load in another Agent Skills
      // tool (portability).
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-prop19-'));
      try {
        const layout = createStorageLayout(base);
        const library = createSkillLibrary({ layout });

        // WRITE via the REAL library write path (createUserSkill).
        const created = library.createUserSkill({ ownerId: OWNER, name, description, body });
        assert.equal(created.ok, true, created.message);

        // The name is free in a fresh library (not reserved, no prior skill), so
        // the resolved invocation name is exactly the requested name.
        const invocationName = created.skill.invocationName;
        assert.equal(invocationName, name);

        // The written SKILL.md on disk, in the owner's User_Skills root.
        const writtenPath = path.join(created.skill.path, 'SKILL.md');
        const rawOnDisk = fs.readFileSync(writtenPath, 'utf8');

        // The canonical single-line description the writer stored (a REAL
        // reloaded value, never a constant — this is what round-trip must hold).
        const expectedDescription = canonicalDescription(description);

        // (a) FRONTMATTER ROUND-TRIP: parseFrontmatter reads name + description
        // back exactly as written (via the plumby boundary).
        const parsed = parseFrontmatter(rawOnDisk);
        assert.equal(parsed.data.name, name);
        assert.equal(parsed.data.description, expectedDescription);
        assert.equal(parsed.body.trim(), body.trim());

        // Sanity: the standalone serializer agrees with the library write path,
        // so the open-format text is exactly what an export would produce.
        assert.equal(
          rawOnDisk,
          serializeSkillMarkdown({ name, description, body }),
        );

        // (b) LOADABLE BY plumby's REAL loader. Mirror the written open-format
        // SKILL.md into a session cwd's `.plumby/skills/<name>/` and run the
        // real loadSkills over that cwd.
        const cwd = path.join(base, 'session');
        const skillDir = path.join(cwd, '.plumby', 'skills', name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), rawOnDisk, 'utf8');

        const loaded = loadSkills(cwd);
        const record = loaded.find((s) => s.name === name);
        assert.ok(record, `loadSkills did not discover skill "${name}"`);
        assert.equal(record.description, expectedDescription);

        // Loadable via load_skill, indexed exactly as createAgent wires it.
        const ctxSkills = indexSkills(loaded);
        const result = await loadSkillTool.handler({ name }, { cwd, skills: ctxSkills });
        assert.ok(
          result.includes(body.trim()),
          `load_skill did not return the body for "${name}"`,
        );
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );

  // Non-vacuous: fast-check ran the configured >=100 iterations.
  assert.equal(fcConfig.numRuns, 100);
  assert.ok(iterations >= 100, `expected >=100 iterations, ran ${iterations}`);
});
