#!/usr/bin/env node
/**
 * scripts/vendor-skills.js — the build/release-time vendoring entry point
 * (spec Task 22.1, Req 12.15).
 *
 * Runs the lock-in skill vendoring step: COPIES the `vendor-lockin-guard` and
 * `devendor-project` SKILL.md folders from the local sibling agent-skills-lockin
 * checkout into an ai-app-builder-owned `.plumby/skills` tree so they are
 * discoverable by plumby's loadSkills(cwd) at Builder_Agent session start with
 * NO runtime fetch or clone. This is a plain local filesystem copy; there is no
 * network anywhere in this path.
 *
 * Usage:
 *   node scripts/vendor-skills.js [skillsRoot]
 *
 *   skillsRoot   the `.plumby/skills` directory to vendor into. Defaults to
 *                the repo-owned checked-in tree `vendored-skills/.plumby/skills`
 *                (also settable via the VENDOR_SKILLS_ROOT env var). The upstream
 *                source defaults to the sibling agent-skills-lockin checkout and
 *                can be overridden with VENDOR_UPSTREAM_ROOT for testing.
 *
 * Exits 0 on success (printing the structured result), non-zero on failure.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSkillVendor, SKILLS_DIR, DEFAULT_UPSTREAM_ROOT } from '../src/skills/vendor.js';

/** The ai-app-builder repo root (this file lives at <repo>/scripts/). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The default checked-in destination: a repo-owned `vendored-skills/` tree whose
 * `.plumby/skills` subpath matches what plumby's loader reads relative to a cwd.
 * Pointing a Builder_Agent session at `<repo>/vendored-skills` as its cwd makes
 * the vendored skills discoverable with no runtime fetch.
 */
const DEFAULT_SKILLS_ROOT = path.join(REPO_ROOT, 'vendored-skills', SKILLS_DIR);

function resolveSkillsRoot() {
  const fromArg = process.argv[2];
  const fromEnv = process.env.VENDOR_SKILLS_ROOT;
  const chosen = (fromArg && fromArg.trim()) || (fromEnv && fromEnv.trim()) || DEFAULT_SKILLS_ROOT;
  return path.resolve(chosen);
}

function resolveUpstreamRoot() {
  const fromEnv = process.env.VENDOR_UPSTREAM_ROOT;
  return fromEnv && fromEnv.trim() ? path.resolve(fromEnv.trim()) : DEFAULT_UPSTREAM_ROOT;
}

function main() {
  const skillsRoot = resolveSkillsRoot();
  const upstreamRoot = resolveUpstreamRoot();

  const vendor = createSkillVendor({ upstreamRoot });
  const result = vendor.vendorInto(skillsRoot);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ upstreamRoot, skillsRoot, ...result }, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();
