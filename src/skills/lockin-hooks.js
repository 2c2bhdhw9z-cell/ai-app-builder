/**
 * THE LOCK-IN BEHAVIORAL HOOKS (spec Task 22.2, Req 12.5, 12.6, 12.7, 12.8,
 * 12.9, 12.11, 12.12).
 *
 * The two vendored lock-in skills are LOADED, not always-on: the Builder_Agent
 * pulls a skill's body on demand when the situation calls for it. This module
 * defines the deterministic hooks that name WHICH skill to load and routes
 * destructive lock-in-removal operations through the existing guard:
 *
 *   - skillForRequest(intent) → 'devendor-project' (the Devendor_Skill) when the
 *     user asks to de-couple / escape / remove lock-in / own their code / stop
 *     phoning home / feels trapped (Req 12.5). The agent then applies the
 *     Devendor_Skill's phased methodology.
 *   - skillForEvaluation(kind) → 'vendor-lockin-guard' (the Guard_Skill) when the
 *     agent is evaluating a dependency / SDK / template / Connector (Req 12.6).
 *   - routeDestructiveOperation(projectId, command, opts) DELEGATES to the
 *     injected CommandGuard.run — the guard already composes plumby's PURE
 *     classifier (via the plumby boundary), so this module NEVER re-classifies
 *     (Req 12.7, 12.8, 12.9). The guard's verdicts stand:
 *       - unrecoverable ops (git filter-branch / filter-repo) are REFUSE and are
 *         refused even with a granting confirm seam (executed:false — Req 12.11);
 *       - recoverable-with-consent ops (force-push, remote-delete, credential
 *         rotation, db-migration, DNS-change) are CONFIRM and only run on an
 *         explicit grant — a declined confirmation returns the guard's
 *         state-unchanged executed:false result, leaving the project in its
 *         pre-operation state (Req 12.12).
 *
 * DNS-change (Req 12.11) is already classified by plumby's CONFIRM_RULES
 * (aws route53 change-resource-record-sets, cloudflare dns record edits,
 * nsupdate, gcloud dns record-sets, az network dns record-set) — verified in
 * plumby/src/core/permissions.js — so it is gated purely by the existing
 * classifier verdict with NO new rule and NO plumby edit.
 *
 * The selectors are PURE and deterministic; the router is a thin, no-partial-
 * state delegation. Nothing here imports the plumby package directly — the
 * default classifier arrives via the plumby boundary, and the CommandGuard is
 * injected by the caller.
 */

import { classifyCommand as defaultClassify } from '../engine/plumby.js';

/**
 * De-couple / escape intents that call for the Devendor_Skill (Req 12.5). Each
 * is a phrase fragment matched case-insensitively as a substring of the intent
 * text, so natural spellings like "help me escape this platform" or "I feel
 * trapped" resolve to the same skill.
 */
const DEVENDOR_INTENTS = Object.freeze([
  'de-couple',
  'decouple',
  'de couple',
  'escape',
  'remove lock-in',
  'remove lockin',
  'remove lock in',
  'own my code',
  'own the code',
  'stop phoning home',
  'phoning home',
  'trapped',
  'get out',
  'exit strategy',
  'migrate off',
  'move off',
]);

/** The evaluation kinds that call for the Guard_Skill (Req 12.6). */
const GUARD_EVALUATION_KINDS = Object.freeze(['dependency', 'sdk', 'template', 'connector']);

/** The vendored skill names (mirror VENDORED_LOCKIN_SKILLS in src/skills/vendor.js). */
export const DEVENDOR_SKILL_NAME = 'devendor-project';
export const GUARD_SKILL_NAME = 'vendor-lockin-guard';

/**
 * Create the lock-in behavioral hooks.
 *
 * @param {object} args
 * @param {object} args.commandGuard  a CommandGuard (src/sandbox/command-guard.js)
 *   with a run(projectId, command, opts) method. Required — destructive ops route
 *   through it.
 * @param {(cmd:string)=>object} [args.classify]  the PURE classifier; defaults
 *   to plumby's classifyCommand via the boundary. Present for parity/testing —
 *   routeDestructiveOperation delegates to the guard and does NOT re-classify.
 * @returns {object} hooks (frozen)
 */
export function createLockinHooks({ commandGuard, classify = defaultClassify } = {}) {
  if (!commandGuard || typeof commandGuard.run !== 'function') {
    throw new Error('createLockinHooks requires a commandGuard with a run(projectId, command, opts) method');
  }

  /**
   * skillForRequest(intent): the skill the agent should load_skill when the user
   * expresses a de-couple/escape/remove-lock-in intent (Req 12.5). Returns the
   * Devendor_Skill name on a match, else null (no skill to load). PURE.
   *
   * @param {string} intent  the user's request text / classified intent
   * @returns {'devendor-project'|null}
   */
  function skillForRequest(intent) {
    if (typeof intent !== 'string' || intent.trim() === '') return null;
    const hay = intent.toLowerCase();
    for (const phrase of DEVENDOR_INTENTS) {
      if (hay.includes(phrase)) return DEVENDOR_SKILL_NAME;
    }
    return null;
  }

  /**
   * skillForEvaluation(kind): the skill the agent should load_skill when it is
   * evaluating a dependency / SDK / template / Connector for lock-in risk (Req
   * 12.6). Returns the Guard_Skill name for a recognised kind, else null. PURE.
   *
   * @param {string} kind  one of dependency|sdk|template|connector (case-insensitive)
   * @returns {'vendor-lockin-guard'|null}
   */
  function skillForEvaluation(kind) {
    if (typeof kind !== 'string') return null;
    const k = kind.trim().toLowerCase();
    return GUARD_EVALUATION_KINDS.includes(k) ? GUARD_SKILL_NAME : null;
  }

  /**
   * routeDestructiveOperation(projectId, command, opts): route a destructive
   * lock-in-removal operation through the REAL CommandGuard, which composes
   * plumby's classifier. This module does NOT re-classify — the guard owns the
   * verdict (Req 12.7, 12.8, 12.9):
   *
   *   - unrecoverable (e.g. git filter-branch/filter-repo) → guard returns
   *     outcome:'refuse', executed:false even with a granting confirm seam
   *     (Req 12.11);
   *   - recoverable-with-consent (force-push, remote-delete, credential-rotation,
   *     db-migration, dns-change) → guard emits a confirm_request and only
   *     executes on an explicit grant; a declined/timed-out confirmation returns
   *     executed:false with pre-operation state preserved (Req 12.12).
   *
   * The guard's frozen structured result is returned verbatim — no partial state,
   * no relabelling.
   *
   * @param {string} projectId
   * @param {string|string[]} command
   * @param {object} [opts]  forwarded to guard.run (onConfirmRequest, subAgent, signal, ...)
   * @returns {Promise<object>} the guard's frozen result
   */
  function routeDestructiveOperation(projectId, command, opts = {}) {
    return commandGuard.run(projectId, command, opts);
  }

  return Object.freeze({
    skillForRequest,
    skillForEvaluation,
    routeDestructiveOperation,
    classify,
  });
}
