/**
 * THE LOCK-IN SKILL VENDORING STEP (spec Task 22.1, Req 12.1, 12.2, 12.13,
 * 12.14, 12.15).
 *
 * The two lock-in skills — `vendor-lockin-guard` (the Guard_Skill) and
 * `devendor-project` (the Devendor_Skill) — live UPSTREAM in the
 * agent-skills-lockin repository, which stays the source of truth and remains
 * independently usable. For the Builder_Agent to discover them at session
 * start with NO runtime fetch or clone (Req 12.1), their SKILL.md folders must
 * already sit in the skills directory that plumby's loader reads.
 *
 * plumby's loadSkills(cwd) reads `<cwd>/.plumby/skills/<name>/SKILL.md`
 * (SKILLS_DIR = path.join('.plumby','skills') in plumby's project_context.js).
 * ai-app-builder OWNS the session cwd / skills tree, so this step COPIES the
 * upstream folders into that tree at build/release time. This does NOT modify
 * the plumby package: we only write into a directory ai-app-builder owns, using
 * a hardcoded relative-path constant that mirrors plumby's SKILLS_DIR — the
 * same technique src/connectors/steering.js uses for `.plumby/steering`, so the
 * plumby boundary (src/engine/plumby.js) stays the only plumby-importing file.
 *
 * "Keep in sync" (Req 12.14) means the copy is repeatable and idempotent: each
 * run removes the destination folder and re-copies from upstream, so re-running
 * resyncs cleanly. There is no fork — agent-skills-lockin is never modified.
 *
 * The copy uses ONLY the local filesystem (node:fs cpSync). There is no network
 * anywhere in this code path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter } from '../engine/plumby.js';

/**
 * The skills directory plumby's loader reads, relative to a session cwd.
 * Mirrors plumby's SKILLS_DIR (project_context.js). Kept as a local constant so
 * the vendor step needs no plumby import for the path (the boundary stays
 * clean, exactly as steering.js does for `.plumby/steering`).
 */
export const SKILLS_DIR = path.join('.plumby', 'skills');

/**
 * The upstream folder names of the two lock-in skills, in a stable order. These
 * are BOTH the upstream directory names and the vendored destination names, and
 * (per Req 12.13) the `name` frontmatter field each SKILL.md must carry.
 */
export const VENDORED_LOCKIN_SKILLS = Object.freeze([
  'vendor-lockin-guard',
  'devendor-project',
]);

/**
 * The default upstream checkout: the sibling agent-skills-lockin repo. Injectable
 * via createSkillVendor({ upstreamRoot }) so tests can point at an on-disk
 * fixture. Resolved relative to this module so it does not depend on the
 * process cwd.
 */
export const DEFAULT_UPSTREAM_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'agent-skills-lockin',
);

const MODEL = 'SkillVendor';

/** Count files (not directories) beneath a copied skill folder, recursively. */
function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      n += countFiles(full);
    } else if (entry.isFile()) {
      n += 1;
    }
  }
  return n;
}

/**
 * Create the lock-in skill vendor.
 *
 * @param {object} [args]
 * @param {string} [args.upstreamRoot]  directory holding the upstream skill
 *   folders (defaults to the sibling agent-skills-lockin checkout). Injectable
 *   for tests.
 * @param {() => Date} [args.now]  injected clock, for structured-result stamps.
 * @returns {object} vendor (frozen)
 */
export function createSkillVendor({ upstreamRoot = DEFAULT_UPSTREAM_ROOT, now = () => new Date() } = {}) {
  const root = upstreamRoot;

  /**
   * vendorInto(skillsRoot): copy every lock-in skill folder from upstream into
   * `<skillsRoot>/<name>/`, recursively (SKILL.md plus references/scripts/tests
   * subdirs), preserving the open Agent Skills format. Idempotent: each
   * destination folder is removed then re-copied, so a re-run syncs cleanly from
   * upstream.
   *
   * Fails closed with a structured { ok:false, code, message } if an upstream
   * folder is missing, has no SKILL.md, or its SKILL.md lacks a `name` /
   * `description` — and leaves no partial destination behind for the offending
   * skill (its folder is removed before the failure returns).
   *
   * @param {string} skillsRoot  the `.plumby/skills` root ai-app-builder owns.
   * @returns {{ok:true, vendored:Array<{name,from,to,files}>, at:string}
   *          | {ok:false, code:string, message:string}}
   */
  function vendorInto(skillsRoot) {
    if (typeof skillsRoot !== 'string' || skillsRoot.trim() === '') {
      return {
        ok: false,
        code: 'invalid_skills_root',
        message: `${MODEL}: skillsRoot must be a non-empty string`,
      };
    }

    const vendored = [];

    for (const name of VENDORED_LOCKIN_SKILLS) {
      const from = path.join(root, name);
      const to = path.join(skillsRoot, name);

      // Upstream folder must exist and be a directory.
      let fromStat;
      try {
        fromStat = fs.statSync(from);
      } catch {
        return {
          ok: false,
          code: 'upstream_missing',
          message: `${MODEL}: upstream skill folder not found: ${from}`,
        };
      }
      if (!fromStat.isDirectory()) {
        return {
          ok: false,
          code: 'upstream_not_a_directory',
          message: `${MODEL}: upstream skill path is not a directory: ${from}`,
        };
      }

      // Upstream folder must carry a SKILL.md.
      const upstreamSkillMd = path.join(from, 'SKILL.md');
      if (!fs.existsSync(upstreamSkillMd) || !fs.statSync(upstreamSkillMd).isFile()) {
        return {
          ok: false,
          code: 'upstream_no_skill_md',
          message: `${MODEL}: upstream skill folder has no SKILL.md: ${from}`,
        };
      }

      // Idempotent sync: clear the destination, then copy fresh from upstream.
      fs.rmSync(to, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });

      // Validate the COPIED SKILL.md via plumby's parser (through the boundary):
      // it must carry `name` and `description` to remain a valid open-format
      // Agent Skill (Req 12.2, 12.13). On failure, remove the partial copy.
      const copiedSkillMd = path.join(to, 'SKILL.md');
      const parsed = parseFrontmatter(fs.readFileSync(copiedSkillMd, 'utf8'));
      const frontName = parsed.data && parsed.data.name;
      const frontDesc = parsed.data && parsed.data.description;
      if (typeof frontName !== 'string' || frontName.trim() === '') {
        fs.rmSync(to, { recursive: true, force: true });
        return {
          ok: false,
          code: 'missing_name',
          message: `${MODEL}: copied SKILL.md for "${name}" is missing a frontmatter name`,
        };
      }
      if (typeof frontDesc !== 'string' || frontDesc.trim() === '') {
        fs.rmSync(to, { recursive: true, force: true });
        return {
          ok: false,
          code: 'missing_description',
          message: `${MODEL}: copied SKILL.md for "${name}" is missing a frontmatter description`,
        };
      }

      vendored.push({ name, from, to, files: countFiles(to) });
    }

    return { ok: true, vendored, at: now().toISOString() };
  }

  return Object.freeze({
    upstreamRoot: root,
    vendorInto,
  });
}
