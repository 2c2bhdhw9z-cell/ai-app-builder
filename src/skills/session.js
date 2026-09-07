/**
 * THE BUILDER_AGENT SKILL SESSION WIRING (spec Task 22.2, Req 12.3, 12.4,
 * 12.10).
 *
 * The vendored lock-in skills (FEAT-002) already sit in an ai-app-builder-owned
 * `.plumby/skills` tree. This module WIRES them into a real Builder_Agent
 * session using plumby's progressive-disclosure seams — REUSED verbatim through
 * the plumby boundary (src/engine/plumby.js) — so that:
 *
 *   - at session start the model is shown ONLY each skill's `name` +
 *     `description` (via buildSkillsBlock, which already enforces the 500-char
 *     description clip and the 16 KiB listing cap + truncation notice — Req
 *     12.3). We do NOT reimplement those caps here.
 *   - the load_skill tool can fetch a body by EXACT name on demand (the ≤64 KiB
 *     body cap + notice, the unknown-name error listing available names, the
 *     empty-body error, and the outside-tree refusal all live in plumby's
 *     loadSkillTool and are reused by threading ctx.skills + ctx.cwd — Req 12.4,
 *     12.10). We do NOT reimplement those rules here.
 *   - duplicate invocation names resolve first-discovered-wins and a missing
 *     frontmatter `name` falls back to the directory name — both handled inside
 *     plumby's loadSkills / indexSkills (Req 12.10).
 *
 * plumby's loadSkills(cwd) reads `<cwd>/.plumby/skills/<name>/SKILL.md`, so the
 * cwd passed to it must be the directory whose `.plumby/skills` is the vendored
 * root (for the checked-in vendored tree that cwd is `<repo>/vendored-skills`).
 * This is the same shape test/support/scripted-agent.js uses to wire an agent:
 * a `skills` array of records into createAgent + the listing block into
 * buildSystemPrompt({ extra }).
 *
 * This module does NO disk I/O of its own beyond delegating to the injected
 * loadSkills; it never touches the plumby package directly.
 */

import {
  loadSkills as defaultLoadSkills,
  buildSkillsBlock as defaultBuildSkillsBlock,
  indexSkills as defaultIndexSkills,
} from '../engine/plumby.js';

/**
 * Create a skill session bound to a vendored skills root.
 *
 * @param {object} args
 * @param {string} args.cwd  the working directory whose `.plumby/skills` is the
 *   vendored skills root (loadSkills reads `<cwd>/.plumby/skills`). Required.
 * @param {typeof defaultLoadSkills} [args.loadSkills]  injectable for tests;
 *   defaults to plumby's loader via the boundary.
 * @param {typeof defaultBuildSkillsBlock} [args.buildSkillsBlock]  injectable;
 *   defaults to plumby's listing renderer via the boundary.
 * @param {typeof defaultIndexSkills} [args.indexSkills]  injectable; defaults to
 *   plumby's indexer via the boundary.
 * @returns {object} session (frozen)
 */
export function createSkillSession({
  cwd,
  loadSkills = defaultLoadSkills,
  buildSkillsBlock = defaultBuildSkillsBlock,
  indexSkills = defaultIndexSkills,
} = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('createSkillSession requires a cwd (the vendored skills root)');
  }
  if (typeof loadSkills !== 'function') {
    throw new Error('createSkillSession requires a loadSkills function');
  }

  /**
   * discover(): read the skill records (name + description + paths, bodies NOT
   * loaded) from `<cwd>/.plumby/skills`. Delegates entirely to plumby's
   * loadSkills — the missing-name→dir-name and first-wins-on-duplicate rules
   * live there (Req 12.10).
   *
   * @returns {Array<object>} skill records
   */
  function discover() {
    return loadSkills(cwd);
  }

  /**
   * listingBlock(records?): the startup system-prompt block exposing ONLY
   * name + description. Delegates to plumby's buildSkillsBlock, which enforces
   * the 500-char description clip and the 16 KiB listing cap + truncation
   * notice (Req 12.3). Returns null when there are no skills (caller emits
   * nothing).
   *
   * @param {Array<object>} [records]  defaults to a fresh discover()
   * @returns {string|null}
   */
  function listingBlock(records = discover()) {
    return buildSkillsBlock(records);
  }

  /**
   * indexed(records?): the name→record Map the load_skill tool uses for O(1)
   * lookup. Delegates to plumby's indexSkills (first-wins-on-duplicate — Req
   * 12.10).
   *
   * @param {Array<object>} [records]  defaults to a fresh discover()
   * @returns {Map<string, object>}
   */
  function indexed(records = discover()) {
    return indexSkills(records);
  }

  return Object.freeze({
    cwd,
    discover,
    listingBlock,
    indexed,
  });
}

/**
 * buildBuilderAgentSkillArgs(cwd, deps?) — the one-call wiring helper.
 *
 * Returns the two pieces a real plumby agent needs to expose the vendored
 * skills with progressive disclosure:
 *   - `skills`: the discovered records, passed to createAgent({ skills }) which
 *     indexes them (via indexSkills) for the load_skill tool.
 *   - `systemExtra`: the listing block wrapped in a string[] ready for
 *     buildSystemPrompt({ cwd, extra: systemExtra }). Empty when there are no
 *     skills so the prompt emits nothing rather than a bare heading.
 *
 * Usage mirrors test/support/scripted-agent.js:
 *   const { skills, systemExtra } = buildBuilderAgentSkillArgs(cwd);
 *   createAgent({ skills, system: buildSystemPrompt({ cwd, extra: systemExtra }), ... });
 *
 * @param {string} cwd  the vendored skills root cwd (loadSkills reads
 *   `<cwd>/.plumby/skills`).
 * @param {object} [deps]  injectable loadSkills/buildSkillsBlock/indexSkills for tests.
 * @returns {{ skills: Array<object>, systemExtra: string[] }}
 */
export function buildBuilderAgentSkillArgs(cwd, deps = {}) {
  const session = createSkillSession({ cwd, ...deps });
  const skills = session.discover();
  const block = session.listingBlock(skills);
  const systemExtra = block ? [block] : [];
  return { skills, systemExtra };
}
