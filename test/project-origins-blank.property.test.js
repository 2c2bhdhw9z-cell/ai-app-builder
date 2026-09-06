/**
 * Property 11 — "Blank origin still runs" (spec subtask 14.3*, Req 6.2).
 *
 * TOOLCHAIN-BACKED. Unlike the seam-only property tests, this one GENUINELY
 * RUNS the blank origin's generated project through a real toolchain: it reuses
 * eval/runner.js's hermetic harness (a fresh fs.mkdtemp temp dir ALWAYS removed
 * in a finally, a bounded iteration cap, a scripted keyless/offline provider so
 * the real plumby agent loop runs with NO network) and then executes an
 * OBJECTIVE check that actually boots the project.
 *
 * THE PROPERTY: for ALL blank Projects (over bounded generators), the Sandbox +
 * Dev_Server "start" succeeds using ONLY the minimal generated files. We model
 * "the Sandbox + Dev_Server start the project" by running the blank tree's own
 * start command (`node index.js`, the same command package.json's `start`/`dev`
 * scripts name) inside the isolated fixture dir through the runner's `exec`
 * (child_process, NOT the permission guard — a check is the harness's own
 * assertion). A successful boot exits 0 and prints the entry file's line.
 *
 * WHAT IS EMPIRICALLY RUN vs SIMULATED VIA SEAMS:
 *   - EMPIRICALLY RUN (real toolchain): the blank project's start command is
 *     executed for real via node's child_process inside the hermetic temp dir,
 *     and the REAL plumby agent loop runs (scripted provider, no key/network) —
 *     this is what makes the property "toolchain-backed" per the runner's design.
 *   - SIMULATED VIA SEAM: the LLM provider is the scripted (keyless/offline)
 *     provider — only the model is swapped; the loop, tools, permission model,
 *     and truncation are the production path. The "Sandbox + Dev_Server" are
 *     represented by running the project's own start command in the fixture dir
 *     (the Dev_Server's job is to launch that command); we do not spin a real
 *     container here (offline), consistent with how the platform seams the
 *     container/Dev_Server/wall-clock effects elsewhere.
 *
 * MUTATION SENSITIVITY: the assertion depends on the blank origin producing a
 * genuinely-runnable tree (a package.json naming a `node index.js` start command
 * PLUS the index.js entry file it runs). A mutation that writes NOTHING runnable
 * — an empty tree, or a package.json with no start script / no entry file —
 * removes the thing to run: `node index.js` then exits non-zero ("Cannot find
 * module") and the objective check fails, FLIPPING this property. See
 * `blankTreeIsRunnable` and the assert on `res.pass` below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { runCase, DEFAULT_EVAL_MAX_ITERATIONS } from '../eval/runner.js';
import { createScriptedProvider } from '../src/engine/plumby.js';
import { createProjectOrigin } from '../src/project/project-origins.js';
import { Project_Origin, Target_Category } from '../src/model/enums.js';

/**
 * A bounded generator for the create inputs of a `blank` Project. The blank
 * origin ignores targetCategory (it applies NO Template), but we vary it — plus
 * a description and id — so the property ranges over many blank Projects rather
 * than one. Everything is small so 100+ toolchain runs stay fast.
 */
const blankCreateArb = fc.record({
  id: fc
    .string({ minLength: 1, maxLength: 10, unit: fc.constantFrom(...'abcdefghijklmnop0123456789-'.split('')) })
    .filter((s) => s.trim().length > 0),
  targetCategory: fc.constantFrom(...Target_Category),
  description: fc.string({ minLength: 0, maxLength: 24 }),
});

/** Does a produced tree carry a runnable start command AND its entry file? */
function blankTreeIsRunnable(tree) {
  if (!tree || typeof tree !== 'object') return false;
  const pkgText = tree['package.json'];
  if (typeof pkgText !== 'string') return false;
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return false;
  }
  const start = pkg?.scripts?.start;
  if (typeof start !== 'string' || start.trim() === '') return false;
  // The start command must reference the entry file we ship, and that file must
  // be present — otherwise there is nothing runnable (the mutation case).
  return typeof tree['index.js'] === 'string' && tree['index.js'].length > 0 && start.includes('index.js');
}

/**
 * The scripted (keyless/offline) provider that drives the REAL agent loop. The
 * blank tree is already materialized by the runner's setup, so the agent has
 * nothing to build — it simply ends its turn. Only the MODEL is scripted; the
 * loop/tools/permission-model are the production path.
 */
function blankProviderFor() {
  return createScriptedProvider([{ text: 'Blank project already scaffolded; nothing to do.' }]);
}

// EXACT spec tag (rendered by propertyTag below, kept greppable here verbatim):
//   Feature: ai-app-builder, Property 11: Blank origin still runs
test(propertyTag(11, 'Blank origin still runs'), async () => {
  // A single ProjectOrigin instance produces each blank tree; the clock is
  // irrelevant to the blank branch (no SLO wait), so the default is fine.
  const origin = createProjectOrigin();

  await fc.assert(
    fc.asyncProperty(blankCreateArb, async (input) => {
      // Produce the blank origin's initial tree (the REAL 'blank' branch). No
      // Template is applied — this is the minimal genuinely-runnable set.
      const populated = await origin.populate({
        project: { id: input.id, ownerId: 'prop11-owner', origin: 'blank' },
        origin: 'blank',
        targetCategory: input.targetCategory,
      });
      assert.equal(populated.ok, true, 'blank populate ok');
      assert.equal(populated.origin, 'blank');
      const tree = populated.projectTree;

      // Sanity: the blank tree really is the minimal runnable set (mutation
      // sensitivity — see the module doc). If a mutation made it non-runnable,
      // the toolchain check below would also fail.
      assert.ok(blankTreeIsRunnable(tree), 'blank tree is genuinely runnable');
      assert.deepEqual(Object.keys(tree).sort(), ['index.js', 'package.json'], 'ONLY the minimal generated files');

      // Run it through the hermetic toolchain harness: setup writes ONLY the
      // blank tree into the isolated temp dir, the real agent loop runs against
      // the scripted provider, and the objective check BOOTS the project by
      // running its own start command (what the Dev_Server would launch). A
      // successful boot exits 0 and prints the entry line.
      const res = await runCase({
        maxIterations: DEFAULT_EVAL_MAX_ITERATIONS,
        providerFor: blankProviderFor,
        case: {
          id: `blank-${input.id}`,
          prompt: 'The blank project is already scaffolded. Do not modify anything.',
          async setup(dir) {
            const fs = await import('node:fs/promises');
            const path = await import('node:path');
            for (const [rel, contents] of Object.entries(tree)) {
              const abs = path.join(dir, rel);
              await fs.mkdir(path.dirname(abs), { recursive: true });
              await fs.writeFile(abs, contents);
            }
          },
          async check({ dir, exec }) {
            // Assert ONLY the minimal generated files exist in the booted
            // project (no Template footprint). `ls -A` lists all entries.
            const listing = await exec('ls -A');
            const entries = listing.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
            if (entries.join(',') !== 'index.js,package.json') {
              return { pass: false, detail: `unexpected files present: ${entries.join(', ')}` };
            }
            // BOOT the project exactly as the Dev_Server start command would:
            // run the package.json `start` script's command. Success == exit 0
            // AND the entry file's output line is printed.
            const boot = await exec('node index.js');
            const ok = /blank app running/.test(boot.stdout);
            return {
              pass: ok,
              detail: ok ? 'blank project booted' : `boot produced no expected output: ${JSON.stringify(boot.stdout)}`,
            };
          },
        },
      });

      // The toolchain-backed boot must pass for EVERY blank Project. A
      // non-runnable mutation flips exactly this assertion.
      assert.equal(res.pass, true, `blank Project must boot; got: ${res.detail}`);
    }),
    fcConfig,
  );
});

// A tiny guard so the exact enum the property ranges over cannot silently drift.
test('Property 11 support: the blank origin is a member of the closed Project_Origin enum', () => {
  assert.ok(Project_Origin.includes('blank'));
});
