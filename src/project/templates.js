/**
 * templates.js — the REAL Template set (spec Task 15.1, Req 5.1, 5.4, 5.5, 5.6,
 * 16.1) + the baseline-build / instantiation check.
 *
 * A Template is the starting { relPath: contents } file tree a 'template'
 * Project_Origin seeds a Project with (see src/project/project-origins.js
 * populateTemplate, which consumes an injected templateProvider.forCategory).
 * Task 14 shipped a MINIMAL test fixture (test/support/template-fixture.js);
 * this module is the production Template LIBRARY: exactly one Template per
 * Target_Category value in the closed enum (web, full-stack-web, mobile,
 * multi-target), each shipping a dependency manifest (package.json) so the
 * origin's "populate all template files + the dependency manifest" contract is
 * satisfied.
 *
 * ================= REAL vs SEAM (READ THIS) =====================
 * REAL (what plumby's verifyTool actually runs, offline, here): every Template's
 * package.json declares a `scripts.test` (plus `scripts.build` and
 * `scripts.start`/`dev`) that is a plain `node ...` command exercising the
 * scaffolded source using ONLY the Node standard library. `dependencies` is
 * ALWAYS empty (no external package needs fetching), so the baseline build runs
 * to EXIT 0 with no network install. This is what Property 7 exercises: plumby's
 * verify discovers `scripts.test`, runs it through the permission guard, and
 * must emit `verdict: PASS` hermetically. The baseline `scripts.test` genuinely
 * executes the scaffolded entry files (via node:test / a verify script) — it is
 * NOT a trivial `true`.
 *
 * SEAM / PRODUCTION-ONLY (NOT exercised here, cannot run offline): a real
 * framework build — `npm install` of React / Express / Expo / a bundler, then a
 * framework `build`/`start` over the network — is the production reality a
 * template would grow into. That install REQUIRES network access and therefore
 * CANNOT run in this offline environment and is NOT claimed as exercised. Each
 * template file carries an inline comment distinguishing the offline Node
 * baseline (REAL) from the framework build it stands in for (SEAM).
 *
 * INSTANTIATION SLO: instantiateTemplate() enforces the 300s baseline-build SLO
 * (Req 5.4/5.5) against an INJECTED clock — NOT a real wait (offline). A build
 * that exceeds the budget, or a non-PASS verify verdict, marks the instantiation
 * FAILED with a build-failure error and produces NO Project.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock and the verify seam; structured { ok:true|false, code?, message? }
 * results for expected failures (never throw on a handled failure). The verify
 * seam's production wiring wraps plumby verifyTool through src/engine/plumby.js;
 * this module imports NO plumby package directly (the boundary invariant).
 */

import { Target, Target_Category, isValidTargetCategory } from '../model/enums.js';

/**
 * The 300s baseline-build SLO for instantiating a Template (Req 5.4). A Template
 * whose baseline build (verify) exceeds this budget is a build failure and
 * produces no Project. Measured against the INJECTED clock, never a real wait.
 */
export const BASELINE_BUILD_SLO_MS = 300_000;

/** Build a dependency-manifest (package.json) TEXT for a template. */
function manifest({ name, scripts, extra = {} }) {
  const pkg = {
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts,
    // Kept EMPTY on purpose: the baseline build must run offline with no network
    // install (see the REAL vs SEAM note at the top of this file). A real
    // framework build would add dependencies here — that is a production SEAM.
    dependencies: {},
    ...extra,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * The Target subtrees a Template scaffolds, keyed by Target_Category. The
 * multi-target Template scaffolds EXACTLY the four Targets in Target-enum order
 * (Req 5.6, 16.1); the single-shape categories map to their most-relevant
 * Target(s).
 */
const TARGETS_BY_CATEGORY = Object.freeze({
  web: Object.freeze(['web']),
  'full-stack-web': Object.freeze(['web', 'backend']),
  mobile: Object.freeze(['mobile']),
  // EXACTLY the four Targets, in Target-enum order. Derived from the enum below
  // so a Target enum drift is caught structurally.
  'multi-target': Object.freeze([...Target]),
});

// ------------------------------------------------------------------ web
//
// A minimal but real static/JS web starter. REAL baseline: `node build.js`
// renders index.html from the app module and `node --test` asserts the rendered
// markup, all with Node stdlib only. SEAM: a real bundler (vite/webpack) +
// framework install/build over the network — not runnable offline.
function webTemplate() {
  return {
    'package.json': manifest({
      name: 'web-app',
      scripts: {
        // REAL offline baseline (what plumby verify runs): build then test.
        build: 'node build.js',
        test: 'node --test test/app.test.js',
        start: 'node build.js',
        dev: 'node build.js',
      },
    }),
    // The app entry: a pure function producing the page markup. In production
    // this would be a framework component (SEAM); the REAL offline baseline is
    // this stdlib-only render function.
    'src/app.js':
      "// REAL: a stdlib-only render function (the offline baseline).\n" +
      "// SEAM: production replaces this with a real framework component whose\n" +
      "// build needs a network install (not runnable offline).\n" +
      "export function render(title = 'web-app') {\n" +
      "  return `<!doctype html><html><head><title>${title}</title></head>` +\n" +
      "    `<body><main id=\"app\">${title} is running</main></body></html>`;\n" +
      "}\n",
    // The build script: renders index.html from the app module (REAL, offline).
    'build.js':
      "// REAL: offline build — writes index.html from the app module using only\n" +
      "// the Node stdlib. SEAM: production runs a real bundler here.\n" +
      "import { writeFileSync } from 'node:fs';\n" +
      "import { render } from './src/app.js';\n" +
      "const html = render('web-app');\n" +
      "writeFileSync(new URL('./index.html', import.meta.url), html);\n" +
      "console.log('web build ok');\n",
    // The baseline test: boots the app module in-process and asserts the markup.
    'test/app.test.js':
      "import test from 'node:test';\n" +
      "import assert from 'node:assert/strict';\n" +
      "import { render } from '../src/app.js';\n" +
      "test('web app renders its entry markup', () => {\n" +
      "  const html = render('web-app');\n" +
      "  assert.match(html, /<title>web-app<\\/title>/);\n" +
      "  assert.match(html, /web-app is running/);\n" +
      "});\n",
    'public/index.html':
      '<!doctype html><title>web-app</title><meta charset="utf-8">\n',
  };
}

// --------------------------------------------------------- full-stack-web
//
// A client entry AND a backend entry. REAL baseline: the test boots the backend
// http handler IN-PROCESS (node:http, stdlib only) and asserts a < 400 response,
// and asserts the client entry renders. SEAM: a real Express/React install +
// build over the network — not runnable offline.
function fullStackWebTemplate() {
  return {
    'package.json': manifest({
      name: 'full-stack-web-app',
      scripts: {
        build: 'node build.js',
        // REAL offline baseline: boots the backend handler in-process, asserts
        // a < 400 response, and asserts the client entry renders.
        test: 'node --test test/server.test.js test/client.test.js',
        start: 'node server.js',
        dev: 'node server.js',
      },
    }),
    // Backend entry: a stdlib node:http handler (REAL). SEAM: production swaps a
    // real framework (e.g. Express) whose install needs the network.
    'server.js':
      "// REAL: a stdlib-only node:http server (the offline baseline).\n" +
      "// SEAM: production replaces this with a real framework server whose\n" +
      "// install/build needs a network fetch (not runnable offline).\n" +
      "import http from 'node:http';\n" +
      "export function handler(req, res) {\n" +
      "  res.statusCode = 200;\n" +
      "  res.setHeader('content-type', 'application/json');\n" +
      "  res.end(JSON.stringify({ ok: true, service: 'full-stack-web-app' }));\n" +
      "}\n" +
      "export function createServer() {\n" +
      "  return http.createServer(handler);\n" +
      "}\n" +
      "if (import.meta.url === `file://${process.argv[1]}`) {\n" +
      "  const port = Number(process.env.PORT) || 3000;\n" +
      "  createServer().listen(port, () => console.log(`server on ${port}`));\n" +
      "}\n",
    // Client entry: a pure render function (REAL). SEAM: production uses a real
    // UI framework component + bundler.
    'client/app.js':
      "// REAL: a stdlib-only client render function (the offline baseline).\n" +
      "// SEAM: production replaces this with a real framework component.\n" +
      "export function render() {\n" +
      "  return '<main id=\"app\">full-stack-web-app client</main>';\n" +
      "}\n",
    // Baseline backend test: boots the handler in-process, asserts a < 400.
    'test/server.test.js':
      "import test from 'node:test';\n" +
      "import assert from 'node:assert/strict';\n" +
      "import { createServer } from '../server.js';\n" +
      "test('backend handler answers with a < 400 status', async () => {\n" +
      "  const server = createServer();\n" +
      "  await new Promise((resolve) => server.listen(0, resolve));\n" +
      "  const { port } = server.address();\n" +
      "  try {\n" +
      "    const res = await fetch(`http://127.0.0.1:${port}/`);\n" +
      "    assert.ok(res.status < 400, `expected < 400, got ${res.status}`);\n" +
      "    const body = await res.json();\n" +
      "    assert.equal(body.ok, true);\n" +
      "  } finally {\n" +
      "    await new Promise((resolve) => server.close(resolve));\n" +
      "  }\n" +
      "});\n",
    // Baseline client test: asserts the client entry renders.
    'test/client.test.js':
      "import test from 'node:test';\n" +
      "import assert from 'node:assert/strict';\n" +
      "import { render } from '../client/app.js';\n" +
      "test('client entry renders its root markup', () => {\n" +
      "  assert.match(render(), /full-stack-web-app client/);\n" +
      "});\n",
    'build.js':
      "// REAL: offline build — verifies both entries load. SEAM: production runs\n" +
      "// a real client bundler + server build here (needs a network install).\n" +
      "import { createServer } from './server.js';\n" +
      "import { render } from './client/app.js';\n" +
      "if (typeof createServer !== 'function' || typeof render !== 'function') {\n" +
      "  throw new Error('full-stack-web build: entries failed to load');\n" +
      "}\n" +
      "console.log('full-stack-web build ok');\n",
  };
}

// --------------------------------------------------------------- mobile
//
// An Expo/React-Native-shaped starter (App.js + app config). REAL baseline: the
// test asserts the App entry renders-to-string via a stdlib-only shim. SEAM: the
// real Expo/React-Native toolchain build needs a network install and is NOT
// runnable offline.
function mobileTemplate() {
  return {
    'package.json': manifest({
      name: 'mobile-app',
      scripts: {
        build: 'node build.js',
        // REAL offline baseline: renders the App entry to a string via a
        // stdlib-only shim and asserts the output.
        test: 'node --test test/app.test.js',
        start: 'node build.js',
        dev: 'node build.js',
      },
      extra: {
        // Expo-shaped app config lives in the manifest for the SEAM toolchain.
        expo: { name: 'mobile-app', slug: 'mobile-app' },
      },
    }),
    // App entry, Expo/React-Native shaped. REAL: a plain function returning a
    // render tree the offline shim can stringify. SEAM: production imports
    // react-native / expo (network install) and renders on-device.
    'App.js':
      "// REAL: an Expo/React-Native-SHAPED entry whose render tree the offline\n" +
      "// shim (renderToString) can stringify with the Node stdlib only.\n" +
      "// SEAM: the real Expo/React-Native toolchain build needs a network\n" +
      "// install and is NOT runnable offline.\n" +
      "export default function App() {\n" +
      "  return { type: 'View', props: { testID: 'root' }, children: ['mobile-app running'] };\n" +
      "}\n",
    // A stdlib-only render-to-string shim standing in for the RN renderer (SEAM).
    'src/render.js':
      "// REAL: a stdlib-only shim that stringifies the render tree (offline\n" +
      "// baseline). SEAM: production uses the real React-Native renderer.\n" +
      "export function renderToString(node) {\n" +
      "  if (node == null || typeof node !== 'object') return String(node ?? '');\n" +
      "  const children = (node.children ?? []).map(renderToString).join('');\n" +
      "  return `<${node.type}>${children}</${node.type}>`;\n" +
      "}\n",
    'app.json':
      '{\n  "expo": {\n    "name": "mobile-app",\n    "slug": "mobile-app"\n  }\n}\n',
    // Baseline test: renders the App entry to a string via the shim.
    'test/app.test.js':
      "import test from 'node:test';\n" +
      "import assert from 'node:assert/strict';\n" +
      "import App from '../App.js';\n" +
      "import { renderToString } from '../src/render.js';\n" +
      "test('mobile App entry renders to string via the offline shim', () => {\n" +
      "  const out = renderToString(App());\n" +
      "  assert.match(out, /mobile-app running/);\n" +
      "  assert.match(out, /<View>/);\n" +
      "});\n",
    'build.js':
      "// REAL: offline build — asserts the App entry renders. SEAM: production\n" +
      "// runs the real Expo build here (needs a network install).\n" +
      "import App from './App.js';\n" +
      "import { renderToString } from './src/render.js';\n" +
      "if (!/mobile-app running/.test(renderToString(App()))) {\n" +
      "  throw new Error('mobile build: App entry failed to render');\n" +
      "}\n" +
      "console.log('mobile build ok');\n",
  };
}

// ---------------------------------------------------------- multi-target
//
// Scaffolds EXACTLY FOUR Targets — web, backend, mobile, shared — as four
// subtrees within the SINGLE Project (Req 5.6, 16.1). REAL baseline: the test
// exercises all four subtrees (each Target's entry runs, and 'shared' is
// importable by web/backend/mobile) offline with the Node stdlib. SEAM: each
// Target's real framework build needs a network install (not runnable offline).
function multiTargetTemplate() {
  return {
    'package.json': manifest({
      name: 'multi-target-app',
      scripts: {
        build: 'node build.js',
        // REAL offline baseline: exercises ALL FOUR subtrees and asserts shared
        // is importable by web/backend/mobile.
        test: 'node --test test/targets.test.js',
        start: 'node build.js',
        dev: 'node build.js',
      },
    }),
    // shared: a common module imported by the other three Targets (REAL).
    'shared/index.js':
      "// REAL: the 'shared' Target — a common module imported by web, backend,\n" +
      "// and mobile (the offline baseline). SEAM: production may publish this as\n" +
      "// a workspace package.\n" +
      "export const APP_NAME = 'multi-target-app';\n" +
      "export function greeting(target) {\n" +
      "  return `${APP_NAME}:${target}`;\n" +
      "}\n",
    // web Target entry, consuming shared.
    'web/index.js':
      "// REAL: the 'web' Target entry, consuming shared (offline baseline).\n" +
      "// SEAM: production replaces with a real web framework build.\n" +
      "import { greeting } from '../shared/index.js';\n" +
      "export function main() {\n" +
      "  return greeting('web');\n" +
      "}\n",
    // backend Target entry, consuming shared.
    'backend/index.js':
      "// REAL: the 'backend' Target entry, consuming shared (offline baseline).\n" +
      "// SEAM: production replaces with a real backend framework build.\n" +
      "import { greeting } from '../shared/index.js';\n" +
      "export function main() {\n" +
      "  return greeting('backend');\n" +
      "}\n",
    // mobile Target entry, consuming shared.
    'mobile/index.js':
      "// REAL: the 'mobile' Target entry, consuming shared (offline baseline).\n" +
      "// SEAM: production replaces with a real Expo/React-Native build.\n" +
      "import { greeting } from '../shared/index.js';\n" +
      "export function main() {\n" +
      "  return greeting('mobile');\n" +
      "}\n",
    // Baseline test: exercises ALL FOUR subtrees and asserts shared is importable
    // by web/backend/mobile.
    'test/targets.test.js':
      "import test from 'node:test';\n" +
      "import assert from 'node:assert/strict';\n" +
      "import { APP_NAME, greeting } from '../shared/index.js';\n" +
      "import { main as web } from '../web/index.js';\n" +
      "import { main as backend } from '../backend/index.js';\n" +
      "import { main as mobile } from '../mobile/index.js';\n" +
      "test('shared Target is importable and exposes the app name', () => {\n" +
      "  assert.equal(APP_NAME, 'multi-target-app');\n" +
      "  assert.equal(greeting('x'), 'multi-target-app:x');\n" +
      "});\n" +
      "test('web/backend/mobile Targets each run and consume shared', () => {\n" +
      "  assert.equal(web(), 'multi-target-app:web');\n" +
      "  assert.equal(backend(), 'multi-target-app:backend');\n" +
      "  assert.equal(mobile(), 'multi-target-app:mobile');\n" +
      "});\n",
    'build.js':
      "// REAL: offline build — runs every Target entry. SEAM: production builds\n" +
      "// each Target with its real framework toolchain (needs a network install).\n" +
      "import { main as web } from './web/index.js';\n" +
      "import { main as backend } from './backend/index.js';\n" +
      "import { main as mobile } from './mobile/index.js';\n" +
      "for (const [name, run] of [['web', web], ['backend', backend], ['mobile', mobile]]) {\n" +
      "  const out = run();\n" +
      "  if (!out.startsWith('multi-target-app:')) {\n" +
      "    throw new Error(`multi-target build: ${name} Target failed`);\n" +
      "  }\n" +
      "}\n" +
      "console.log('multi-target build ok');\n",
  };
}

/** The Template builders, keyed by Target_Category. */
const TEMPLATE_BUILDERS = Object.freeze({
  web: webTemplate,
  'full-stack-web': fullStackWebTemplate,
  mobile: mobileTemplate,
  'multi-target': multiTargetTemplate,
});

/**
 * Create the REAL template provider.
 *
 * Implements the SAME DI seam the Task-14 'template' origin consumes:
 * `forCategory(targetCategory) -> { relPath: contents }` where every map
 * includes a dependency manifest (package.json). Exactly one Template per
 * Target_Category enum value. A fresh shallow copy is returned per call so
 * callers cannot mutate shared template state.
 *
 * @returns {object} frozen provider { forCategory, templateTargets, categories }
 */
export function createTemplateProvider() {
  // Build every Template once, iterating the CLOSED Target_Category enum so a
  // spec drift (a category with no builder) is caught at construction.
  const templates = {};
  for (const category of Target_Category) {
    const build = TEMPLATE_BUILDERS[category];
    if (typeof build !== 'function') {
      throw new Error(
        `no Template defined for Target_Category ${JSON.stringify(category)} — ` +
          `the Template set must cover every value in the closed enum`,
      );
    }
    templates[category] = build();
  }

  return Object.freeze({
    /**
     * Return the Template file map for a Target_Category, as a fresh shallow
     * copy (callers cannot mutate the shared template). Throws for an unknown
     * category, matching the fixture provider's contract.
     *
     * @param {string} category a Target_Category value
     * @returns {{ [relPath: string]: string }}
     */
    forCategory(category) {
      if (!isValidTargetCategory(category)) {
        throw new Error(`no template for Target_Category ${JSON.stringify(category)}`);
      }
      // Fresh shallow copy per call — contents are immutable strings.
      return { ...templates[category] };
    },

    /**
     * The Target(s) a Template scaffolds for a Target_Category. For
     * 'multi-target' this is EXACTLY the four Targets [web, backend, mobile,
     * shared] (Req 5.6, 16.1).
     *
     * @param {string} category a Target_Category value
     * @returns {string[]} a fresh array of Target values
     */
    templateTargets(category) {
      if (!isValidTargetCategory(category)) {
        throw new Error(`no template targets for Target_Category ${JSON.stringify(category)}`);
      }
      return [...TARGETS_BY_CATEGORY[category]];
    },

    /** The Target_Category values this provider covers (a fresh array). */
    categories() {
      return [...Target_Category];
    },
  });
}

/**
 * Instantiate a Template: resolve its file tree, run the injected `verify` seam
 * to get the baseline-build verdict, and enforce the 300s baseline-build SLO
 * against the INJECTED clock (Req 5.4, 5.5).
 *
 * A build that exceeds `buildTimeoutMs` (BASELINE_BUILD_TIMEOUT), or a non-PASS
 * verify verdict (BASELINE_BUILD_FAILED), marks the instantiation FAILED with a
 * build-failure error and produces NO Project (no projectTree). Success returns
 * { ok:true, targetCategory, projectTree, verifyResult, buildMs }.
 *
 * The SLO is a MEASURED budget against the clock, NOT a real wait (offline).
 *
 * @param {object} args
 * @param {string} args.targetCategory  a Target_Category value
 * @param {(args:{ targetCategory:string, projectTree:object }) => (string | Promise<string>)} args.verify
 *        the baseline-build verify seam. Production wraps plumby verifyTool
 *        (through src/engine/plumby.js), which returns TEXT beginning
 *        'verdict: PASS' / 'verdict: FAIL'. Tests inject a scripted verify.
 * @param {object} [args.provider]      an optional templateProvider to resolve
 *        the Template with; defaults to a fresh createTemplateProvider().
 * @param {() => number} [args.now]     injectable ms clock for the SLO. Default Date.now.
 * @param {number} [args.buildTimeoutMs] the baseline-build SLO. Default 300000 (300s).
 * @returns {Promise<{ ok:true, targetCategory, projectTree, verifyResult, buildMs }
 *          | { ok:false, code, message, targetCategory? }>}
 */
export async function instantiateTemplate({
  targetCategory,
  verify,
  provider,
  now = () => Date.now(),
  buildTimeoutMs = BASELINE_BUILD_SLO_MS,
} = {}) {
  if (!isValidTargetCategory(targetCategory)) {
    return {
      ok: false,
      code: 'UNKNOWN_TARGET_CATEGORY',
      message: `unknown Target_Category ${JSON.stringify(targetCategory)}`,
    };
  }
  if (typeof verify !== 'function') {
    return {
      ok: false,
      code: 'BASELINE_BUILD_FAILED',
      message: 'a verify seam function is required to instantiate a Template',
      targetCategory,
    };
  }

  const templateProvider = provider ?? createTemplateProvider();

  let projectTree;
  try {
    projectTree = templateProvider.forCategory(targetCategory);
  } catch (err) {
    return {
      ok: false,
      code: 'BASELINE_BUILD_FAILED',
      message: `could not resolve Template for ${JSON.stringify(targetCategory)}: ${err?.message ?? String(err)}`,
      targetCategory,
    };
  }

  const startedAt = now();
  let verifyResult;
  try {
    verifyResult = await verify({ targetCategory, projectTree });
  } catch (err) {
    return {
      ok: false,
      code: 'BASELINE_BUILD_FAILED',
      message: `baseline build (verify) threw for ${JSON.stringify(targetCategory)}: ${err?.message ?? String(err)}`,
      targetCategory,
    };
  }
  const buildMs = now() - startedAt;

  // Enforce the 300s baseline-build SLO against the injected clock. An
  // over-budget build is a FAILED instantiation producing no Project.
  if (buildMs > buildTimeoutMs) {
    return {
      ok: false,
      code: 'BASELINE_BUILD_TIMEOUT',
      message:
        `baseline build for ${JSON.stringify(targetCategory)} exceeded the ` +
        `${buildTimeoutMs}ms SLO (took ${buildMs}ms)`,
      targetCategory,
      buildMs,
    };
  }

  // The baseline build must PASS. plumby verify returns TEXT beginning
  // 'verdict: PASS' / 'verdict: FAIL'; a non-PASS verdict is a build failure.
  if (!isPassVerdict(verifyResult)) {
    return {
      ok: false,
      code: 'BASELINE_BUILD_FAILED',
      message: `baseline build for ${JSON.stringify(targetCategory)} did not PASS`,
      targetCategory,
      buildMs,
    };
  }

  return { ok: true, targetCategory, projectTree, verifyResult, buildMs };
}

/**
 * True when the verify seam's result is a PASS. Accepts plumby verify TEXT
 * (first line 'verdict: PASS' / 'verdict: FAIL') or a structured
 * { verdict: 'PASS' } object, so tests can inject either shape.
 */
function isPassVerdict(verifyResult) {
  if (verifyResult && typeof verifyResult === 'object' && typeof verifyResult.verdict === 'string') {
    return verifyResult.verdict.toUpperCase() === 'PASS';
  }
  if (typeof verifyResult !== 'string') return false;
  const firstLine = verifyResult.split('\n', 1)[0] ?? '';
  const match = /^verdict:\s*(PASS|FAIL)\b/i.exec(firstLine.trim());
  return match ? match[1].toUpperCase() === 'PASS' : false;
}
