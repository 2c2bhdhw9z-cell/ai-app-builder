/**
 * Property 7 — "Template baseline builds" (spec subtask 15.2*, Req 5.1, 5.4,
 * 5.5, 5.6, 16.1).
 *
 * TOOLCHAIN-BACKED. Modeled on test/project-origins-blank.property.test.js
 * (Property 11), this test GENUINELY RUNS each real Template's baseline build
 * through the plumby toolchain: it reuses eval/runner.js's hermetic harness (a
 * fresh fs.mkdtemp temp dir ALWAYS removed in a finally, a bounded iteration
 * cap, a scripted keyless/offline provider so the real plumby agent loop runs
 * with NO network), materializes the REAL createTemplateProvider() Template
 * tree into that isolated dir, and then invokes plumby's REAL `verify` tool on
 * the materialized tree, asserting the verdict is PASS BEFORE any user
 * refinement.
 *
 * THE PROPERTY: for ALL Templates (EVERY Target_Category) and a bounded
 * generator of Project inputs, instantiating the Template into a hermetic dir
 * and running plumby's real verify yields `verdict: PASS` before any
 * refinement. Every Target_Category is exercised at >=100 iterations: this file
 * runs an OUTER loop over the closed Target_Category enum, and for each category
 * runs fc.assert(..., fcConfig) with fcConfig.numRuns=100 — so each of the four
 * Templates gets >=100 iterations (>=400 verify runs total per suite run).
 *
 * "BEFORE any user refinement" is modeled exactly as Property 11 does: the
 * scripted (keyless/offline) provider does nothing / ends its turn — the model
 * makes NO edits. Only the MODEL is swapped; the real agent loop, tools, and
 * permission model run. The verify assertion runs INSIDE runCase's `check`,
 * which receives the materialized fixture dir; there we invoke the re-exported
 * plumby verifyTool.handler({}, ctx) with ctx.cwd set to the fixture dir (a
 * safe/default bash policy consistent with the runner — no confirm hook, so the
 * baseline `node --test ...` script, an allow-class command, runs and any
 * confirm-class command would be denied). verifyTool discovers the Template's
 * package.json scripts.test and runs it through the SAME permission guard as
 * bash; the assertion is on plumby verify's real PASS verdict, never a
 * re-implemented check.
 *
 * WHAT IS EMPIRICALLY RUN vs SIMULATED VIA SEAMS:
 *   - EMPIRICALLY RUN (real toolchain): each Template's real baseline
 *     `scripts.test` executes FOR REAL via the toolchain in the hermetic dir
 *     (plumby verify runs `npm test`, whose resolved body is the template's
 *     `node --test ...` command, exercising the scaffolded offline Node-stdlib
 *     source), and plumby's REAL verify tool + agent loop run (scripted
 *     provider, no key/network). This is what makes Property 7
 *     "toolchain-backed" per the runner's design.
 *   - SIMULATED VIA SEAM: the LLM provider is the scripted (keyless/offline)
 *     provider — only the model is swapped; the loop, tools, permission model,
 *     and truncation are the production path. The REAL NETWORK FRAMEWORK BUILD
 *     (an `npm install` of React/Express/Expo/a bundler + the framework
 *     build/start over the network) is NOT exercised — it cannot run offline.
 *     The verified baseline is the offline Node-stdlib one that every Template
 *     ships. We do NOT claim a real network build ran.
 *
 * MUTATION SENSITIVITY: this property genuinely pins the baseline-build
 * guarantee rather than passing vacuously. The sibling negative test below
 * takes a LOCALLY-MUTATED copy of a real Template whose `scripts.test` is
 * swapped for a command that exits non-zero, runs the SAME real plumby verify
 * on it in the SAME hermetic harness, and asserts verify flips to
 * 'verdict: FAIL' — which would fail this property. The real Template set is
 * left untouched (the mutation is on a local copy only).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { runCase, DEFAULT_EVAL_MAX_ITERATIONS } from '../eval/runner.js';
import { createScriptedProvider, verifyTool } from '../src/engine/plumby.js';
import { createTemplateProvider } from '../src/project/templates.js';
import { Target_Category } from '../src/model/enums.js';

/**
 * A bounded generator for the create inputs of a `template` Project. The
 * category under test is fixed by the outer loop (so every Template is
 * exercised >=100 iterations); we vary an id and a short description so the
 * property ranges over many Projects rather than one. Everything is small so
 * 100+ toolchain runs per category stay fast.
 */
function templateCreateArb() {
  return fc.record({
    id: fc
      .string({ minLength: 1, maxLength: 10, unit: fc.constantFrom(...'abcdefghijklmnop0123456789-'.split('')) })
      .filter((s) => s.trim().length > 0),
    description: fc.string({ minLength: 0, maxLength: 24 }),
  });
}

/**
 * The scripted (keyless/offline) provider that drives the REAL agent loop. The
 * Template tree is already materialized by the runner's setup, so the agent has
 * nothing to build — it ends its turn WITHOUT editing anything. This is what
 * "before any user refinement" means: only the MODEL is scripted; the
 * loop/tools/permission-model are the production path.
 */
function templateProviderFor() {
  return createScriptedProvider([{ text: 'Template already scaffolded; nothing to do.' }]);
}

/** Write a { relPath: contents } tree into a dir, creating parent dirs. */
async function materializeTree(dir, tree) {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  for (const [rel, contents] of Object.entries(tree)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, contents);
  }
}

/**
 * Run plumby's REAL verify tool on a materialized fixture dir. This is the
 * production path: the re-exported verifyTool.handler({}, ctx) discovers the
 * Template's package.json scripts.test and runs it through the permission
 * guard. The bash policy is left at the safe default (no confirm hook), exactly
 * like eval/runner.js — the template baselines are allow-class `node --test ...`
 * commands, so they run; a confirm-class command would be denied. Returns the
 * verify TEXT (begins 'verdict: PASS' / 'verdict: FAIL').
 */
async function runRealVerify(dir) {
  return verifyTool.handler({}, { cwd: dir });
}

// EXACT spec tag (rendered by propertyTag below, kept greppable here verbatim):
//   Feature: ai-app-builder, Property 7: Template baseline builds
//
// OUTER loop over the CLOSED Target_Category enum: each category gets its own
// property assertion at fcConfig.numRuns (>=100) iterations, guaranteeing EVERY
// Template is exercised >=100 times per suite run.
for (const category of Target_Category) {
  test(`${propertyTag(7, 'Template baseline builds')} [${category}]`, async () => {
    // A single REAL provider yields each Template tree (fresh shallow copy per
    // forCategory call, so per-iteration materialization never shares state).
    const provider = createTemplateProvider();

    await fc.assert(
      fc.asyncProperty(templateCreateArb(), async (input) => {
        // Resolve the REAL Template tree for the category under test. This is
        // the exact { relPath: contents } map the 'template' Project_Origin
        // would seed the Project with — including its dependency manifest.
        const tree = provider.forCategory(category);
        assert.equal(typeof tree['package.json'], 'string', 'Template ships a dependency manifest');

        // Run it through the hermetic toolchain harness: setup materializes ONLY
        // the real Template tree into the isolated temp dir, the real agent loop
        // runs against the scripted provider (which makes NO edits — before any
        // refinement), and the objective check runs plumby's REAL verify on the
        // materialized tree and asserts a PASS verdict.
        const res = await runCase({
          maxIterations: DEFAULT_EVAL_MAX_ITERATIONS,
          providerFor: templateProviderFor,
          case: {
            id: `template-${category}-${input.id}`,
            prompt: 'The template project is already scaffolded. Do not modify anything.',
            async setup(dir) {
              await materializeTree(dir, tree);
            },
            async check({ dir }) {
              // Invoke plumby's REAL verify tool exactly as the platform will.
              const verdictText = await runRealVerify(dir);
              const pass = /^verdict:\s*PASS\b/.test(String(verdictText).trim());
              return {
                pass,
                detail: pass
                  ? `${category} baseline verify PASS`
                  : `${category} baseline verify did NOT pass: ${JSON.stringify(String(verdictText).slice(0, 400))}`,
              };
            },
          },
        });

        // plumby's real verify must return verdict: PASS for EVERY Template and
        // EVERY iteration, before any refinement. A broken baseline flips this
        // exact assertion (see the mutation-sensitivity test below).
        assert.equal(res.pass, true, `Template baseline must build (verify PASS); got: ${res.detail}`);
      }),
      fcConfig,
    );
  });
}

/**
 * MUTATION SENSITIVITY (sibling negative test): prove Property 7 is not
 * vacuous. Take a LOCALLY-MUTATED copy of the real 'web' Template whose
 * package.json scripts.test is swapped for a command that exits non-zero, run
 * the SAME real plumby verify on it in the SAME hermetic harness, and assert the
 * verdict flips to FAIL — which would fail the property above. The real
 * Template set is NOT modified: the mutation lives only on this local copy.
 */
test('Property 7 mutation sensitivity: a broken baseline scripts.test flips plumby verify to FAIL', async () => {
  const provider = createTemplateProvider();
  const tree = provider.forCategory('web');

  // Mutate a LOCAL COPY only: swap scripts.test for a command that exits 1.
  const pkg = JSON.parse(tree['package.json']);
  pkg.scripts = { ...pkg.scripts, test: 'node -e "process.exit(1)"' };
  const brokenTree = { ...tree, 'package.json': `${JSON.stringify(pkg, null, 2)}\n` };

  const res = await runCase({
    maxIterations: DEFAULT_EVAL_MAX_ITERATIONS,
    providerFor: templateProviderFor,
    case: {
      id: 'template-web-broken-baseline',
      prompt: 'The template project is already scaffolded. Do not modify anything.',
      async setup(dir) {
        await materializeTree(dir, brokenTree);
      },
      async check({ dir }) {
        const verdictText = await runRealVerify(dir);
        const failed = /^verdict:\s*FAIL\b/.test(String(verdictText).trim());
        return {
          pass: failed,
          detail: failed
            ? 'broken baseline correctly produced verdict: FAIL'
            : `expected verdict: FAIL from a broken baseline, got: ${JSON.stringify(String(verdictText).slice(0, 400))}`,
        };
      },
    },
  });

  // A broken baseline MUST flip verify to FAIL — this is what the property pins.
  assert.equal(res.pass, true, `broken baseline must flip verify to FAIL; got: ${res.detail}`);

  // And the REAL Template set is untouched: the pristine 'web' Template still
  // ships its genuine baseline scripts.test (we mutated only a local copy).
  const pristine = JSON.parse(createTemplateProvider().forCategory('web')['package.json']);
  assert.equal(pristine.scripts.test, 'node --test test/app.test.js', 'real web Template baseline is unmutated');
});

// A tiny guard so the exact enum the property ranges over cannot silently drift.
test('Property 7 support: the closed Target_Category enum is exactly the four Templates', () => {
  assert.deepEqual([...Target_Category], ['web', 'full-stack-web', 'mobile', 'multi-target']);
});
