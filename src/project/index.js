/**
 * Project subsystem barrel (spec Task 13 — Project lifecycle and creation).
 *
 * The public seam for the ProjectManager (input validation + the 10s "begins
 * creation" SLO + the generation -> verify -> Dev_Server / editable-on-fail
 * pipeline), the control-plane ProjectRegistry (out-of-tree per-owner Project
 * records backing the QuotaManager totalProjects counter and the Builder Server
 * projectResolver), and the Dev_Server process-launch seam — mirroring how
 * src/sandbox/index.js and src/persistence/index.js aggregate their modules.
 *
 * Callers compose these from a StorageLayout (src/storage/layout.js), a
 * SandboxManager, a QuotaManager, the SnapshotStore, and the plumby Builder_Agent
 * + verify seams (through src/engine/plumby.js only — this subsystem never
 * imports the plumby package directly). A real Dev_Server / Preview cannot run
 * offline, so createDevServer is a seam-only default; production swaps a real
 * launcher behind the same interface.
 */

export { createProjectManager, MAX_DESCRIPTION_CHARS } from './project-manager.js';

// The shared verify-seam result parser (Req 20.1): the single 'verdict:
// PASS'/'verdict: FAIL' TEXT-contract parser that BOTH the ProjectManager
// (runGeneration) and the Self-Healing controller import, so no duplicated
// parser can drift out of agreement.
export { normalizeVerifyResult } from './verify-result.js';

// The Self-Healing controller (Task 17.1, Req 20.1-20.11): a bounded,
// observable, cancellation-aware verify-driven loop that, on a plumby verify
// FAIL, feeds the failure back to the Builder_Agent and re-verifies — stopping
// on PASS, at a strict max-attempt cap, or early on a repeated failure signature
// (oscillation), and on give-up leaves the files editable. It REUSES plumby
// verify + the Builder_Agent loop ONLY through injected seams (never imports the
// plumby package) and reuses the SnapshotStore turn-pass policy on a healed PASS.
export {
  createSelfHealingController,
  failureSignatureOf,
  MAX_ATTEMPTS_FLOOR,
  MAX_ATTEMPTS_CEILING,
  HEAL_CONFIG_DEFAULTS,
} from './self-healing.js';

export { createProjectOrigin, TEMPLATE_POPULATE_SLO_MS } from './project-origins.js';

export { createProjectRegistry } from './project-registry.js';

export { createDevServer } from './dev-server.js';

// The iterative-refinement router (Task 16.1, Req 2.1-2.7): routes a follow-up
// turn to edit ONLY files within the existing Project via plumby's edit_file
// exact-string replacement, renders the change as a <=2s diff, and surfaces the
// not-uniquely-located / file-not-found / no-changes-applied error contracts.
export { createRefinementRouter, DIFF_SLO_MS } from './refinement.js';

// The REAL Template library (Task 15.1) + the baseline-build/instantiation SLO
// check. `createTemplateProvider` is the production `templateProvider` the
// Task-14 'template' Project_Origin consumes via `forCategory`.
export {
  createTemplateProvider,
  instantiateTemplate,
  BASELINE_BUILD_SLO_MS,
} from './templates.js';

import { createProjectOrigin as createProjectOriginImpl } from './project-origins.js';
import { createTemplateProvider as createTemplateProviderImpl } from './templates.js';

/**
 * Production assembly of the ProjectOrigin with the REAL Template provider wired
 * in, so a 'template' Project_Origin instantiates the real Task-15 Templates.
 *
 * This is strictly ADDITIVE: it does NOT change the DI shape of
 * createProjectOrigin (it just supplies the real `templateProvider` when a
 * caller does not inject their own). The Task-14 tests inject their own fixture
 * provider through createProjectOrigin directly, so they are unaffected. A
 * production caller composes the ProjectOrigin here to get the real Template set.
 *
 * @param {object} [args] the same args createProjectOrigin accepts. Any explicit
 *        `templateProvider` wins; otherwise the real createTemplateProvider() is used.
 * @returns {object} a frozen ProjectOrigin wired with the real Template provider
 */
export function createProjectOriginWithTemplates(args = {}) {
  return createProjectOriginImpl({
    ...args,
    templateProvider: args.templateProvider ?? createTemplateProviderImpl(),
  });
}
