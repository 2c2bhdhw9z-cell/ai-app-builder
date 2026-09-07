/**
 * Property 15 — "Audit soundness on clean projects" (spec Task 27.6, Req 11.9).
 *
 *   Property 15 (Audit soundness on clean projects): for all generated Projects
 *   with no lock-in signals, a Lockin_Audit reports no signals (no false
 *   positives on clean output).
 *
 * We prove this against the REAL in-process detector, NON-VACUOUSLY:
 *
 *   (generate) fast-check GENERATES genuinely VARIED clean projects — a REAL
 *              generated-template tree (from the real createTemplateProvider,
 *              varying over the closed Target_Category enum) UNIONED with a
 *              varied set of clean source files that deliberately TRIP the
 *              classic detect-lockin.sh false positives:
 *                - the word "badge" in prose / comments (never a JSX construct);
 *                - a physics `amplitude` variable (never a telemetry SDK import);
 *                - a structural `importFrom` key whose value is a real dependency
 *                  (never the vendor);
 *                - benign https URLs that are NOT collector/beacon endpoints.
 *              These are the exact traps a naive detector would flag — so a
 *              CLEAN verdict here genuinely exercises the FP-avoidance logic.
 *   (audit)    run the REAL createLockinAudit over the varied clean tree.
 *   (assert)   the audit is ok, clean === true, findings empty.
 *
 * NON-NO-OP (positive control): Property 15 would pass vacuously if the detector
 * simply never fired. A sibling test in THIS file plants each real signal
 * (telemetry import, collector endpoint, hash manifest, injected-UI JSX,
 * enforcement importFrom-with-vendor, platform host) into an otherwise-clean
 * tree and asserts the SAME audit instance fires — proving the clean verdict is
 * earned, not a no-op. (The FEAT-003 suite test/lockin-audit.test.js carries the
 * canonical per-signal positive control with line-number evidence as well.)
 *
 * Runs >=100 iterations via fcConfig and carries the EXACT spec tag string
 * `Feature: ai-app-builder, Property 15: Audit soundness on clean projects`.
 *
 * Hermeticity: the detector is pure in-process over a { relPath: contents } map
 * (no I/O), so no temp dir is needed; the clock is injected. No plumby import is
 * made outside the src/engine/plumby.js boundary (this file imports none).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createTemplateProvider } from '../src/project/templates.js';
import { createLockinAudit } from '../src/portability/index.js';

// The EXACT tag string this test must carry (greppable, mapped to spec Prop 15).
const TAG = 'Feature: ai-app-builder, Property 15: Audit soundness on clean projects';

const PROJECT = 'proj-clean-1';

/** The platform-host / vendor config the audit uses (matches the FEAT-003 control). */
const PLATFORM_HOSTS = ['platform.example.dev'];
// The vendor pattern includes `acme` so the enforcement + platform-host
// detectors are ACTIVELY looking for it — the clean snippets below mention the
// vendor only in prose/comments (an FP trap the detector must NOT flag), which
// only genuinely exercises FP-avoidance when the pattern is armed for it.
const VENDOR_PATTERN = 'aiappbuilder|ai-app-builder|acme';

/**
 * Clean source snippets that TRIP the classic detect-lockin.sh false positives
 * but must NOT be flagged. fast-check picks a varied subset each iteration so
 * the property ranges over genuinely different clean trees, not one fixture.
 */
const CLEAN_SNIPPETS = [
  // FP trap: the word "badge" in prose + a lowercase string, never a JSX construct.
  {
    file: 'src/achievements.ts',
    body:
      '// Users earn a badge for each achievement. Badges appear on the profile.\n' +
      "export const label = 'badge';\n" +
      "export const congrats = 'You unlocked a new badge!';\n",
  },
  // FP trap: a physics `amplitude` variable (never a telemetry SDK import).
  {
    file: 'src/wave.ts',
    body:
      'export function wave(t) {\n' +
      '  const amplitude = 2.5;\n' +
      '  const frequency = 0.1;\n' +
      '  return amplitude * Math.sin(frequency * t);\n' +
      '}\n',
  },
  // FP trap: a structural importFrom rule whose value is a REAL dependency,
  // with the vendor name appearing only in an unrelated comment key.
  {
    file: 'conventions.json',
    body:
      '{\n' +
      '  "//": "a convention rule that mandates a real dependency, not a vendor.",\n' +
      '  "name": "keep-store-adapter-shape",\n' +
      '  "must": { "importFrom": ["@tanstack/react-query"] }\n' +
      '}\n',
  },
  // FP trap: benign https URLs that are NOT collector/beacon endpoints and are
  // documentation/homepage links, not outbound tracking hosts.
  {
    file: 'README.md',
    body:
      '# My App\n\n' +
      'See the docs at https://developer.mozilla.org/en-US/docs and\n' +
      'the spec at https://nodejs.org/api/test.html for details.\n',
  },
  // A clean stdlib-only module that boots a loopback server (not phoning home).
  {
    file: 'src/server.ts',
    body:
      "import http from 'node:http';\n" +
      "const server = http.createServer((req, res) => res.end('ok'));\n" +
      "server.listen(3000, '127.0.0.1');\n" +
      "// health check at http://localhost:3000/health\n",
  },
  // A plain component whose NAME merely mentions feedback in prose, not JSX.
  {
    file: 'src/notes.ts',
    body:
      '// We collect user feedback through a support form (no tracking).\n' +
      'export const feedbackFormUrl = null;\n',
  },
];

/**
 * A generated CLEAN project: a real Template tree UNIONED with a non-empty,
 * varied subset of the clean-but-tricky snippets. Distinct file paths (snippets
 * do not collide with template paths).
 */
const cleanProjectArb = fc.record({
  category: fc.constantFrom('web', 'full-stack-web', 'mobile', 'multi-target'),
  snippets: fc.uniqueArray(fc.constantFrom(...CLEAN_SNIPPETS), {
    minLength: 1,
    maxLength: CLEAN_SNIPPETS.length,
    selector: (s) => s.file,
  }),
  // A varied clean app name woven into a source comment (extra variation).
  appName: fc
    .stringMatching(/^[a-z][a-z0-9-]{2,20}$/)
    .map((s) => `app-${s}`),
});

test(`${propertyTag(15, 'Audit soundness on clean projects')} — varied clean projects report NO signals`, () => {
  // The tag helper must produce the EXACT greppable spec string.
  assert.equal(propertyTag(15, 'Audit soundness on clean projects'), TAG);

  const provider = createTemplateProvider();
  const audit = createLockinAudit({
    now: stepClock(1),
    platformHosts: PLATFORM_HOSTS,
    vendorPattern: VENDOR_PATTERN,
  });

  let iterations = 0;

  fc.assert(
    fc.property(cleanProjectArb, ({ category, snippets, appName }) => {
      iterations += 1;

      // A REAL generated-template tree (fresh shallow copy per forCategory).
      const tree = { ...provider.forCategory(category) };

      // Union the varied clean-but-tricky snippets (distinct paths).
      for (const s of snippets) {
        tree[s.file] = s.body;
      }
      // A varied clean comment carrying the app name (never a signal construct).
      tree['src/meta.ts'] = `// project ${appName} — generated, no telemetry.\nexport const NAME = '${appName}';\n`;

      const result = audit.audit(PROJECT, { tree, platformGenerated: true });

      assert.equal(result.ok, true, `audit ok for ${category}`);
      assert.equal(
        result.clean,
        true,
        `clean project (${category}) must report NO signals, got ${JSON.stringify(result.findings)}`,
      );
      assert.equal(result.findings.length, 0, 'no findings on a clean project');
    }),
    fcConfig,
  );

  // Non-vacuous: fast-check ran the configured >=100 iterations.
  assert.equal(fcConfig.numRuns, 100);
  assert.ok(iterations >= 100, `expected >=100 iterations, ran ${iterations}`);
});

/**
 * POSITIVE CONTROL (proves Property 15 is not a no-op pass): the SAME audit
 * instance/config MUST fire on each real lock-in signal planted into an
 * otherwise-clean tree. If the detector were a no-op, this test would fail —
 * so the clean verdict above is genuinely earned.
 */
test('Property 15 positive control: the same audit config DETECTS each real signal (not a no-op)', () => {
  const audit = createLockinAudit({
    now: stepClock(1),
    platformHosts: PLATFORM_HOSTS,
    vendorPattern: VENDOR_PATTERN,
  });

  const cases = [
    { signal: 'telemetry', file: 'src/t.ts', body: "import posthog from 'posthog-js';\n" },
    { signal: 'collector', file: 'src/c.ts', body: "fetch('https://metrics.acme.io/collect');\n" },
    {
      signal: 'platform-host',
      file: 'src/h.ts',
      body: "export const api = 'https://platform.example.dev/api';\n",
    },
    {
      signal: 'hash-manifest',
      file: 'p.json',
      body:
        '{\n  "src/app.tsx": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"\n}\n',
    },
    { signal: 'injected-ui', file: 'ui/Foo.tsx', body: '<PoweredBy />\n' },
    {
      signal: 'enforcement',
      file: 'rules.json',
      body: '{\n  "must": {\n    "importFrom": [\n      "@ai-app-builder/runtime"\n    ]\n  }\n}\n',
    },
  ];

  for (const c of cases) {
    const result = audit.audit(PROJECT, { tree: { [c.file]: c.body }, platformGenerated: true });
    assert.equal(result.ok, true, `${c.signal}: audit ok`);
    assert.equal(result.clean, false, `${c.signal}: must NOT be clean`);
    assert.ok(
      result.findings.some((f) => f.signal === c.signal),
      `${c.signal}: the detector must fire (positive control) — got ${JSON.stringify(result.findings)}`,
    );
  }
});

/** A monotonic injected clock: each call advances by `stepMs` (no real wait). */
function stepClock(stepMs = 0) {
  let t = 0;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}
