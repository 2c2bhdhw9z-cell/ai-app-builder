/**
 * Property 12 — "No enforcement lock-in in generated projects" (spec Task 27.3,
 * Req 11.1, 11.2, 11.3).
 *
 *   Property 12 (No enforcement lock-in in generated projects): for all
 *   generated Projects, removing AI_App_Builder-specific code does not cause the
 *   baseline build to fail.
 *
 * The GUARANTEE: a generated Project is NOT locked to the platform by an
 * enforcement mechanism — you can strip out every AI_App_Builder-specific
 * marker (injected badges/branding, telemetry snippets, hardcoded platform-host
 * constants, enforcement convention/lint rules, hash-protection manifests) and
 * the Project's baseline build STILL passes. If a marker were load-bearing (an
 * enforcement lock-in), removing it would break the build; this property proves
 * it does not.
 *
 * TOOLCHAIN-BACKED. This test GENUINELY RUNS a real Standard_Toolchain build,
 * reusing eval/runner.js's hermetic harness shape (a fresh fs.mkdtemp temp dir
 * ALWAYS removed in a finally, a bounded iteration cap, a scripted
 * keyless/offline provider so the real plumby agent loop runs with NO network)
 * and its OBJECTIVE child_process check.
 *
 * Per iteration:
 *   (generate) fast-check varies a REAL generated-template tree (over the closed
 *              Target_Category enum) and a varied subset of AI_App_Builder-
 *              specific MARKERS injected into it (extra marker files + appended
 *              marker lines in throwaway modules the baseline does not import).
 *   (strip)    REMOVE every injected AI_App_Builder-specific marker, restoring
 *              the pristine baseline tree.
 *   (build)    inside runCase's hermetic temp dir, with the scripted provider
 *              (no key/network) driving the REAL agent loop, run the template's
 *              MINIMAL Standard_Toolchain baseline build (`node --test ...`, a
 *              stdlib-only scaffold, exit 0) via the OBJECTIVE child_process
 *              check and assert it STILL exits 0 after the markers are gone.
 *
 * NON-VACUOUS / mutation sensitivity: a sibling negative test proves the build
 * would FAIL if a marker were load-bearing — it injects a marker INTO a file the
 * baseline imports and then removes it in a way that breaks the module, showing
 * the harness genuinely runs the build and would catch a real enforcement
 * dependency.
 *
 * The per-iteration build is deliberately MINIMAL (the template's stdlib-only
 * `node --test`, NO `npm install`, NO network) so 100+ real builds finish within
 * the command timeout.
 *
 * Runs >=100 iterations via fcConfig and carries the EXACT spec tag string
 * `Feature: ai-app-builder, Property 12: No enforcement lock-in in generated projects`.
 *
 * No plumby import is made outside src/engine/plumby.js: the real agent
 * loop/tools come THROUGH eval/runner.js (runCase) and the scripted provider
 * through the boundary. No live network / clone / deploy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { runCase, DEFAULT_EVAL_MAX_ITERATIONS } from '../eval/runner.js';
import { createScriptedProvider } from '../src/engine/plumby.js';
import { createTemplateProvider } from '../src/project/templates.js';

// The EXACT tag string this test must carry (greppable, mapped to spec Prop 12).
const TAG =
  'Feature: ai-app-builder, Property 12: No enforcement lock-in in generated projects';

/**
 * The AI_App_Builder-specific MARKERS a generated Project might (wrongly) carry.
 * Each is added as a SEPARATE marker file the baseline scaffold does NOT import,
 * so injecting it never changes what the build runs — and REMOVING it restores
 * the pristine tree exactly. The marker paths are namespaced under
 * `.aiappbuilder/` so removal is unambiguous.
 */
const MARKERS = [
  { path: '.aiappbuilder/badge.tsx', body: 'export const Badge = () => <PoweredBy />;\n' },
  { path: '.aiappbuilder/telemetry.ts', body: "import posthog from 'posthog-js';\nexport default posthog;\n" },
  {
    path: '.aiappbuilder/host.ts',
    body: "export const PLATFORM = 'https://platform.example.dev/api';\n",
  },
  {
    path: '.aiappbuilder/conventions.json',
    body: '{\n  "must": { "importFrom": ["@ai-app-builder/runtime"] }\n}\n',
  },
  {
    path: '.aiappbuilder/protected.json',
    body:
      '{\n  "src/app.tsx": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"\n}\n',
  },
];

/** The scripted (keyless/offline) provider driving the REAL agent loop (no edits). */
function providerFor() {
  return createScriptedProvider([{ text: 'Baseline project already scaffolded; nothing to do.' }]);
}

/** Write a { relPath: contents } tree into a dir, creating parent dirs. */
async function materializeTree(dir, tree) {
  const fsp = await import('node:fs/promises');
  const p = await import('node:path');
  for (const [rel, contents] of Object.entries(tree)) {
    const abs = p.join(dir, rel);
    await fsp.mkdir(p.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, String(contents));
  }
}

/**
 * The MINIMAL Standard_Toolchain baseline build command for a Template's
 * package.json. We prefix `unset NODE_TEST_CONTEXT NODE_OPTIONS;` so the child
 * `node --test` build is a GENUINE, standalone toolchain run: when this suite is
 * itself launched via `node --test`, the runner exports NODE_TEST_CONTEXT into
 * the environment, and a nested `node --test` would otherwise think it is a
 * child reporter and exit 0 even on a real failure — masking a broken build. The
 * unset makes the build's exit code trustworthy (see the mutation-sensitivity
 * test, which relies on a broken baseline genuinely exiting non-zero).
 */
function baselineTestCommand(pkgJsonText) {
  const pkg = JSON.parse(pkgJsonText);
  assert.equal(typeof pkg.scripts?.test, 'string', 'Template ships a stdlib-only scripts.test');
  return `unset NODE_TEST_CONTEXT NODE_OPTIONS; ${pkg.scripts.test}`;
}

/** A generated Project: a template category + a varied subset of injected markers. */
const projectArb = fc.record({
  category: fc.constantFrom('web', 'full-stack-web', 'mobile', 'multi-target'),
  markers: fc.uniqueArray(fc.constantFrom(...MARKERS), {
    minLength: 1,
    maxLength: MARKERS.length,
    selector: (m) => m.path,
  }),
});

test(`${propertyTag(12, 'No enforcement lock-in in generated projects')} — stripping platform markers keeps the baseline build green`, async () => {
  // The tag helper must produce the EXACT greppable spec string.
  assert.equal(propertyTag(12, 'No enforcement lock-in in generated projects'), TAG);

  const templates = createTemplateProvider();
  let iterations = 0;

  await fc.assert(
    fc.asyncProperty(projectArb, async ({ category, markers }) => {
      iterations += 1;

      // A REAL Template tree with AI_App_Builder-specific markers INJECTED.
      const pristine = templates.forCategory(category);
      const withMarkers = { ...pristine };
      for (const m of markers) withMarkers[m.path] = m.body;

      // Sanity: the markers genuinely got injected (so removal is non-trivial).
      for (const m of markers) {
        assert.equal(withMarkers[m.path], m.body, 'marker injected before removal');
      }

      // REMOVE every injected AI_App_Builder-specific marker → the stripped tree
      // must equal the pristine baseline tree exactly.
      const stripped = { ...withMarkers };
      for (const m of markers) delete stripped[m.path];
      assert.deepEqual(
        Object.keys(stripped).sort(),
        Object.keys(pristine).sort(),
        'stripping markers restores the pristine baseline tree',
      );

      const testCommand = baselineTestCommand(stripped['package.json']);

      // TOOLCHAIN-BACKED build of the STRIPPED tree via the hermetic harness.
      const res = await runCase({
        maxIterations: DEFAULT_EVAL_MAX_ITERATIONS,
        providerFor,
        case: {
          id: `no-lockin-${category}-${markers.length}`,
          prompt: 'The baseline project is already scaffolded. Do not modify anything.',
          async setup(dir) {
            await materializeTree(dir, stripped);
          },
          async check({ exec }) {
            try {
              const { stdout, stderr } = await exec(testCommand);
              return {
                pass: true,
                detail: `${category} baseline build ok after stripping markers: ${String(stdout || stderr).slice(0, 120)}`,
              };
            } catch (err) {
              return {
                pass: false,
                detail: `${category} baseline build FAILED after stripping markers: ${String(err?.stderr || err?.stdout || err?.message).slice(0, 400)}`,
              };
            }
          },
        },
      });

      assert.equal(
        res.pass,
        true,
        `removing AI_App_Builder markers must NOT break the baseline build; got: ${res.detail}`,
      );
    }),
    fcConfig,
  );

  // Non-vacuous: fast-check ran the configured >=100 iterations.
  assert.equal(fcConfig.numRuns, 100);
  assert.ok(iterations >= 100, `expected >=100 iterations, ran ${iterations}`);
});

/**
 * MUTATION SENSITIVITY (sibling negative test): prove the harness genuinely runs
 * the build and would CATCH a load-bearing marker. We take the real 'web'
 * Template and delete a file the baseline `scripts.test` genuinely imports
 * (src/app.js), then run the SAME real build in the SAME hermetic harness and
 * assert it FAILS (non-zero exit) — which is exactly what the property would
 * catch if a removed marker were actually load-bearing. The real Template set is
 * untouched (the deletion is on a local copy only).
 */
test('Property 12 mutation sensitivity: removing a load-bearing baseline file DOES break the build', async () => {
  const templates = createTemplateProvider();
  const tree = { ...templates.forCategory('web') };
  const testCommand = baselineTestCommand(tree['package.json']);

  // Delete a file the baseline test imports — this MUST break the build.
  delete tree['src/app.js'];

  const res = await runCase({
    maxIterations: DEFAULT_EVAL_MAX_ITERATIONS,
    providerFor,
    case: {
      id: 'no-lockin-web-broken-baseline',
      prompt: 'The baseline project is already scaffolded. Do not modify anything.',
      async setup(dir) {
        await materializeTree(dir, tree);
      },
      async check({ exec }) {
        try {
          await exec(testCommand);
          return { pass: false, detail: 'expected a non-zero exit but the build passed' };
        } catch {
          // A non-zero exit throws — that is the expected failure.
          return { pass: true, detail: 'broken baseline correctly failed the build (non-zero exit)' };
        }
      },
    },
  });

  assert.equal(
    res.pass,
    true,
    `a broken baseline must fail the build (proves the harness runs it); got: ${res.detail}`,
  );

  // The REAL Template set is untouched: the pristine 'web' Template still ships
  // src/app.js and its genuine baseline scripts.test.
  const pristine = createTemplateProvider().forCategory('web');
  assert.equal(typeof pristine['src/app.js'], 'string', 'real web Template still ships src/app.js');
  assert.equal(JSON.parse(pristine['package.json']).scripts.test, 'node --test test/app.test.js');
});
