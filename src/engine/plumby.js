/**
 * THE PLUMBY BOUNDARY.
 *
 * This is the ONE and ONLY module in ai-app-builder that is allowed to import
 * from the plumby package. Every other file in src/, test/, and eval/ must
 * consume plumby through this module — never with a direct `from 'plumby/...'`
 * import. That single seam keeps the three-repo separation intact: plumby is a
 * dependency we consume, never a codebase we fork, copy, or reach into.
 *
 * plumby is declared in package.json as `"plumby": "file:../plumby"`, so npm
 * links it into node_modules under the alias `plumby`. plumby's package.json
 * ships no root export map (its "files" list is just bin/src/README), so we
 * import the concrete source subpaths `plumby/src/...`. These subpaths were
 * verified to resolve from this repo before this module was written.
 *
 * We re-export EXACTLY the verified seams below and reimplement none of them.
 */

// Core agent + system prompt.
export { createAgent } from 'plumby/src/core/agent.js';
export { buildSystemPrompt } from 'plumby/src/core/prompt.js';

// The scripted (fake) provider that replays canned turns — the hermetic test seam.
export { createScriptedProvider } from 'plumby/src/providers/scripted.js';

// The permission model: the command classifier and its rule tables.
export {
  classifyCommand,
  REFUSE_RULES,
  CONFIRM_RULES,
} from 'plumby/src/core/permissions.js';

// Individual tools we surface directly.
export { verifyTool } from 'plumby/src/tools/verify.js';
export { loadSkillTool } from 'plumby/src/tools/load_skill.js';

// Skill discovery: the surface loader and the core indexer.
export { loadSkills } from 'plumby/src/cli/project_context.js';
export { indexSkills } from 'plumby/src/core/skills.js';

// Web surface helpers: event projection and diff computation.
export { toViewEvent } from 'plumby/src/web/events.js';
export { computeDiff } from 'plumby/src/web/diff.js';

// Tool bundles: the default toolset, the spawn_subagent tool, and the
// read-only sub-agent toolset.
export {
  defaultTools,
  spawnSubagentTool,
  subagentTools,
} from 'plumby/src/tools/index.js';
