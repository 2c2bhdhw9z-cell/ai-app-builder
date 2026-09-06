/**
 * project-origins.js — the ProjectOrigin module (spec subtask 14.1, Req 6.1-6.3,
 * 6.8, 6.9, 5.2, 5.3).
 *
 * A Project comes into existence from one of four Project_Origins (the closed
 * enum in src/model/enums.js): 'blank', 'template', 'github-import', 'fork'.
 * The ProjectOrigin's SOLE job is to produce that origin's INITIAL project tree
 * — the starting { relPath: contents } file map that seeds the Project BEFORE
 * any agent generation runs. It performs NO agent generation, NO verify, and NO
 * Dev_Server start: those are the ProjectManager.runGeneration pipeline's job,
 * which every origin then converges onto identically (Req 6.9). populate() only
 * decides "what files does a freshly-created <origin> Project start with?".
 *
 * SCOPE OF THIS FEATURE (FEAT-002): only the 'blank' and 'template' branches are
 * implemented here. 'github-import' and 'fork' are FEAT-003; the dispatch keeps
 * an exhaustive switch with clearly-marked NOT-YET-IMPLEMENTED branches and a
 * defense-in-depth 'unsupported origin' guard (ProjectManager already validates
 * the enum at the edge, but populate never trusts that alone).
 *
 * WHAT "minimal runnable" MEANS FOR THE 'blank' ORIGIN (Req 6.2, Property 11):
 * a blank Project applies NO Template, yet it must still be able to START — the
 * Sandbox + Dev_Server seam must have something to run, and a toolchain check
 * (Property 11 via eval/runner.js) must be able to actually execute it. So the
 * blank tree is the SMALLEST GENUINELY-RUNNABLE set:
 *   - package.json  — declares a `start` script (`node index.js`) and a `dev`
 *                     script so the Dev_Server seam has a command to launch;
 *   - index.js      — a single entry file that runs to completion and prints a
 *                     line, so a toolchain run produces real output and exits 0.
 * A mutation that writes NOTHING runnable (e.g. an empty tree, or a package.json
 * with no start script) removes the start command / entry file and flips
 * Property 11 (nothing to run). This is deliberately NOT a Template: no
 * framework, no dependency install, just enough to boot.
 *
 * WHERE populate RUNS RELATIVE TO THE 10s "BEGINS CREATION" WINDOW (Req 6.8,
 * design.md Creation timing): createProject's 10s window covers only "creation
 * BEGINS" (validate -> quota -> register -> acquire). Origin population is a
 * SEPARATE, origin-specific bound (Template <=30s, Req 5.2; import <=120s) and
 * must NOT be folded into the 10s measurement. Therefore ProjectManager invokes
 * populate AFTER createProject has returned its beginsCreationMs — populate is
 * its own step with its own measured `populateMs`, keeping the 10s begins-
 * creation measurement honest. (ProjectManager exposes a populateOrigin() step
 * the create flow calls after createProject; see project-manager.js.)
 *
 * STRUCTURED RESULTS: populate never throws on an expected failure; it returns
 * { ok:true, origin, projectTree, populateMs } on success or
 * { ok:false, code, message, failedArtifact? } on a handled failure, matching
 * the codebase's result-object idiom. Only genuinely programmer-error input
 * (missing required collaborators at construction) throws, via fail().
 *
 * THE PLUMBY BOUNDARY: this module imports NO plumby package (nor the engine
 * boundary) — origin population is pure file-tree assembly + persistence, with
 * no Builder_Agent involvement.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock and every collaborator; structured results for expected rejections.
 */

import { isValidProjectOrigin, Project_Origin } from '../model/enums.js';
import { fail } from '../model/validate.js';

/**
 * The 30s Template-population SLO (Req 5.2). Measured against the injected clock,
 * NOT a real wait — populate exposes `populateMs` so the SLO is observable.
 */
export const TEMPLATE_POPULATE_SLO_MS = 30_000;

/**
 * Create a ProjectOrigin.
 *
 * @param {object} args
 * @param {object} [args.persistenceStore] a PersistenceStore. Optional here:
 *        populate PRODUCES the tree; ProjectManager materializes it via the
 *        PersistenceStore. When injected, template partial-cleanup can use its
 *        deleteProjectTree seam; otherwise cleanup is purely in-memory (populate
 *        returns nothing partial, so there is nothing on disk to leave behind).
 * @param {object} [args.snapshotStore]    a SnapshotStore (reserved for FEAT-003 fork)
 * @param {object} [args.sandboxManager]   a SandboxManager (reserved for FEAT-003 import)
 * @param {object} [args.authorizer]       an Authorizer (reserved for FEAT-003 fork/import)
 * @param {object} [args.templateProvider] provides Template file maps per
 *        Target_Category: `forCategory(targetCategory) -> { relPath: contents }`
 *        including a dependency manifest. REQUIRED to populate a 'template' origin.
 * @param {object} [args.cloner]           a git cloner seam (reserved for FEAT-003 import)
 * @param {() => number} [args.now]        injectable ms clock for the SLOs. Default Date.now.
 * @param {number} [args.maxCloneMs]       import clone budget (reserved for FEAT-003)
 * @returns {object} projectOrigin (frozen)
 */
export function createProjectOrigin({
  persistenceStore,
  snapshotStore,
  sandboxManager,
  authorizer,
  templateProvider,
  cloner,
  now = () => Date.now(),
  maxCloneMs,
} = {}) {
  const model = 'ProjectOrigin';
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');

  /**
   * populate({ project, sandbox, origin, targetCategory, ref }) — produce the
   * ORIGIN's initial project tree. Performs NO agent generation.
   *
   * @param {object} args
   * @param {object} [args.project]         the created Project record (id/ownerId)
   * @param {object} [args.sandbox]         the acquired Sandbox handle (import uses it)
   * @param {string} args.origin            the Project_Origin (must be in the enum)
   * @param {string} args.targetCategory    the Target_Category (template selects by it)
   * @param {string} [args.ref]             origin ref (import url / fork source id)
   * @returns {{ ok:true, origin, projectTree, populateMs }
   *          | { ok:false, code, message, failedArtifact? }}
   */
  function populate({ project, sandbox, origin, targetCategory, ref } = {}) {
    // Defense in depth: ProjectManager already validated the enum, but populate
    // never trusts that alone (Req 6.1 — origin is a closed set).
    if (!isValidProjectOrigin(origin)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_ORIGIN',
        message:
          `unsupported Project_Origin ${JSON.stringify(origin)}: ` +
          `must be one of [${Project_Origin.join(', ')}]`,
      };
    }

    const startedAt = now();

    switch (origin) {
      case 'blank':
        return finish(startedAt, populateBlank());
      case 'template':
        return finish(startedAt, populateTemplate({ project, targetCategory }));
      case 'github-import':
      case 'fork':
        // NOT YET IMPLEMENTED — FEAT-003 adds github-import and fork using the
        // reserved cloner/sandboxManager/snapshotStore/authorizer collaborators.
        return {
          ok: false,
          code: 'ORIGIN_NOT_IMPLEMENTED',
          message: `Project_Origin '${origin}' is not implemented yet (FEAT-003)`,
        };
      default:
        // Unreachable given the enum guard above; kept exhaustive by design.
        return {
          ok: false,
          code: 'UNSUPPORTED_ORIGIN',
          message: `unhandled Project_Origin ${JSON.stringify(origin)}`,
        };
    }
  }

  /** Stamp a successful branch result with the measured populateMs. */
  function finish(startedAt, branchResult) {
    if (branchResult.ok === false) return branchResult;
    return {
      ok: true,
      origin: branchResult.origin,
      projectTree: branchResult.projectTree,
      populateMs: now() - startedAt,
    };
  }

  /**
   * The 'blank' branch (Req 6.2, Property 11): produce ONLY the minimal
   * genuinely-runnable files, with NO Template applied. See the module doc for
   * exactly what "minimal runnable" means and why a mutation that writes nothing
   * runnable flips Property 11.
   */
  function populateBlank() {
    const packageJson = {
      name: 'blank-app',
      version: '0.0.0',
      private: true,
      // A `start`/`dev` command gives the Dev_Server seam something to launch and
      // lets a toolchain check (Property 11) actually run the project.
      scripts: {
        start: 'node index.js',
        dev: 'node index.js',
      },
    };
    const projectTree = {
      'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
      // A single entry file that runs to completion and prints a line, so a
      // toolchain run produces real output and exits 0.
      'index.js': "console.log('blank app running');\n",
    };
    return { ok: true, origin: 'blank', projectTree };
  }

  /**
   * The 'template' branch (Req 6.3, 5.2, 5.3): copy the Template matching the
   * Target_Category from the injected templateProvider and populate ALL of its
   * files plus the dependency manifest.
   *
   * FAILURE / PARTIAL-CLEANUP (Req 5.3): populate assembles the tree IN MEMORY
   * first and only returns { ok:true, projectTree } when the WHOLE template is
   * assembled successfully — so a mid-assembly failure returns { ok:false, ...,
   * failedArtifact } and NO projectTree, meaning ProjectManager never persists a
   * partial tree (nothing half-written lands on disk). When a persistenceStore
   * is injected AND some earlier populate already materialized a tree for this
   * project, we also best-effort delete that on-disk tree so no partial artifact
   * survives. The failed artifact is named in the result.
   */
  function populateTemplate({ project, targetCategory }) {
    if (!templateProvider || typeof templateProvider.forCategory !== 'function') {
      return {
        ok: false,
        code: 'TEMPLATE_PROVIDER_MISSING',
        message: 'a templateProvider with forCategory(targetCategory) is required to populate a template origin',
      };
    }

    let template;
    try {
      template = templateProvider.forCategory(targetCategory);
    } catch (err) {
      return {
        ok: false,
        code: 'TEMPLATE_WRITE_FAILED',
        message: `template provider failed for Target_Category ${JSON.stringify(targetCategory)}: ${err?.message ?? String(err)}`,
        failedArtifact: `templateProvider.forCategory(${JSON.stringify(targetCategory)})`,
      };
    }

    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      return {
        ok: false,
        code: 'TEMPLATE_WRITE_FAILED',
        message: `no template available for Target_Category ${JSON.stringify(targetCategory)}`,
        failedArtifact: `template:${targetCategory}`,
      };
    }

    // Assemble the tree in memory, validating each artifact as we go. A template
    // artifact whose contents are not a string/Buffer would be un-persistable, so
    // we treat it as a write failure NAMING the offending artifact (Req 5.3) and
    // abort BEFORE producing any projectTree, leaving nothing partial.
    const projectTree = {};
    let sawManifest = false;
    for (const [relPath, contents] of Object.entries(template)) {
      if (typeof relPath !== 'string' || relPath.trim() === '') {
        return abortTemplate({ project, failedArtifact: String(relPath), message: `template artifact path must be a non-empty string, got ${JSON.stringify(relPath)}` });
      }
      const isPersistable = typeof contents === 'string' || Buffer.isBuffer(contents);
      if (!isPersistable) {
        return abortTemplate({ project, failedArtifact: relPath, message: `template artifact ${JSON.stringify(relPath)} must be a string or Buffer` });
      }
      if (isDependencyManifest(relPath)) sawManifest = true;
      projectTree[relPath] = contents;
    }

    // A Template MUST ship a dependency manifest (Req 6.3): the origin populates
    // "all template files + the dependency manifest". Its absence is a template
    // failure naming the missing artifact.
    if (!sawManifest) {
      return abortTemplate({ project, failedArtifact: 'package.json', message: `template for Target_Category ${JSON.stringify(targetCategory)} is missing a dependency manifest` });
    }

    return { ok: true, origin: 'template', projectTree };
  }

  /**
   * Abort a template population: best-effort remove any already-materialized
   * on-disk tree (only possible when a persistenceStore is injected AND an
   * earlier step persisted something), then return the structured failure naming
   * the failed artifact. Because populateTemplate assembles in memory and returns
   * NO projectTree on failure, ProjectManager persists nothing partial; this
   * cleanup covers the belt-and-braces case of a prior partial materialization.
   */
  function abortTemplate({ project, failedArtifact, message }) {
    if (
      persistenceStore &&
      typeof persistenceStore.deleteProjectTree === 'function' &&
      project &&
      typeof project.id === 'string'
    ) {
      try {
        persistenceStore.deleteProjectTree(project.id);
      } catch {
        /* best-effort partial cleanup — must not mask the original failure */
      }
    }
    return { ok: false, code: 'TEMPLATE_WRITE_FAILED', message, failedArtifact };
  }

  return Object.freeze({ populate, TEMPLATE_POPULATE_SLO_MS });
}

/** True when `relPath` is a recognized dependency manifest for a Template. */
function isDependencyManifest(relPath) {
  const base = relPath.split('/').pop();
  return (
    base === 'package.json' ||
    base === 'requirements.txt' ||
    base === 'pyproject.toml' ||
    base === 'go.mod' ||
    base === 'Cargo.toml' ||
    base === 'pom.xml' ||
    base === 'build.gradle'
  );
}
