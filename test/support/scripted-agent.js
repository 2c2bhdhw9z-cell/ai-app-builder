/**
 * A test helper that builds a REAL plumby agent driven by the scripted
 * provider. No API key, no network: the scripted provider replays canned turns
 * in order while the loop, tools, permission model, and truncation all run as
 * the production path does.
 *
 * The assembly mirrors plumby/eval/runner.js (the authoritative pattern): the
 * full default toolset plus spawn_subagent, the real system prompt built for
 * the given cwd, the SAME scripted provider reused for any sub-agent, the
 * read-only sub-agent toolset, and a bounded iteration cap. The bash policy is
 * left at its safe default (no confirm hook) so confirm-class commands are
 * denied.
 *
 * Everything reaches plumby through the single boundary module.
 */

import {
  createAgent,
  createScriptedProvider,
  buildSystemPrompt,
  defaultTools,
  spawnSubagentTool,
  subagentTools,
} from '../../src/engine/plumby.js';

/** Default iteration cap for a scripted harness agent: enough to work, bounded. */
export const DEFAULT_SCRIPTED_MAX_ITERATIONS = 10;

/**
 * Build a real plumby agent wired to a scripted provider.
 *
 * @param {object} args
 * @param {Array<object|Function>} args.turns   canned turns for createScriptedProvider
 * @param {string} args.cwd                      the agent's working directory (required)
 * @param {Array<object>} [args.tools]           override the toolset (defaults to defaultTools + spawn_subagent)
 * @param {number} [args.maxIterations]          hard iteration cap
 * @param {(event: object) => void} [args.onEvent]  event seam forwarded to the agent
 * @returns {{ agent: object, provider: object }}
 */
export function createScriptedAgent({
  turns = [],
  cwd,
  tools,
  maxIterations = DEFAULT_SCRIPTED_MAX_ITERATIONS,
  onEvent = () => {},
} = {}) {
  if (!cwd) {
    throw new Error('createScriptedAgent requires a cwd (an isolated working directory)');
  }

  // One scripted provider drives BOTH the main agent and any sub-agent, exactly
  // as the eval runner reuses a single provider instance.
  const provider = createScriptedProvider(turns);

  const agent = createAgent({
    provider,
    cwd,
    system: buildSystemPrompt({ cwd }),
    tools: tools ?? [...defaultTools, spawnSubagentTool],
    subagentProvider: provider,
    subagentTools,
    maxIterations,
    onEvent,
  });

  return { agent, provider };
}
