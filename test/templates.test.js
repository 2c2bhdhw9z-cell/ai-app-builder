/**
 * templates.test.js — unit tests for the REAL Template set + the baseline-build
 * instantiation SLO (spec Task 15.1, Req 5.1, 5.4, 5.5, 5.6, 16.1).
 *
 * Covers:
 *   (a) forCategory returns a Template WITH a dependency manifest for EVERY
 *       Target_Category (iterating the closed enum);
 *   (b) the multi-target Template yields EXACTLY the four Targets
 *       [web, backend, mobile, shared] (mutation-sensitive);
 *   (c) instantiateTemplate returns ok:true with a PASS verify per category;
 *   (d) instantiateTemplate marks the instantiation FAILED with a build-failure
 *       error on the 300s timeout AND on a non-PASS verify verdict;
 *   (e) the Task-14 'template' Project_Origin populateTemplate succeeds
 *       end-to-end when given the REAL createTemplateProvider() for every
 *       category, producing all template files + the dependency manifest.
 *
 * The baseline build itself is exercised for real (offline, Node stdlib) by the
 * toolchain-backed Property 7 test (FEAT-003); here the verify seam is scripted.
 * HERMETIC + OFFLINE: no plumby import, no real agent, injected clocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTemplateProvider,
  instantiateTemplate,
  BASELINE_BUILD_SLO_MS,
} from '../src/project/templates.js';
import { createProjectOrigin } from '../src/project/project-origins.js';
import { Target, Target_Category } from '../src/model/enums.js';
import { createProject as createProjectRecord } from '../src/model/project.js';

const OWNER = 'acct-1';

/** An injected ms clock that advances by `step` on each read. */
function steppingClock({ start = 1000, step = 5 } = {}) {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

/**
 * A manually-advanced ms clock: reads return the current value; tests call
 * advance(ms) to move the injected wall-clock forward (no real waits).
 */
function manualClock({ start = 0 } = {}) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** A minimal Project record for the template origin. */
function projectRecord({ targetCategory = 'web', id = 'proj-1' } = {}) {
  const iso = '2020-01-01T00:00:00.000Z';
  return createProjectRecord({
    id,
    ownerId: OWNER,
    description: 'a project',
    targetCategory,
    origin: 'template',
    sandboxId: id,
    targets: [],
    snapshots: [],
    connectors: [],
    provider: 'anthropic',
    model: 'claude-sonnet',
    createdAt: iso,
    updatedAt: iso,
  });
}

// ------------------------------------------------------ (a) manifest per category

test('forCategory returns a Template WITH a dependency manifest for EVERY Target_Category', () => {
  const provider = createTemplateProvider();
  for (const category of Target_Category) {
    const tmpl = provider.forCategory(category);
    assert.ok(tmpl && typeof tmpl === 'object', `${category} yields a template map`);
    assert.ok(typeof tmpl['package.json'] === 'string', `${category} ships a package.json manifest`);
    // The manifest declares a scripts.test (what plumby verify runs) and empty
    // dependencies (offline baseline needs no network install).
    const pkg = JSON.parse(tmpl['package.json']);
    assert.ok(typeof pkg.scripts?.test === 'string' && pkg.scripts.test.length > 0, `${category} declares scripts.test`);
    assert.ok(typeof pkg.scripts?.build === 'string', `${category} declares scripts.build`);
    assert.ok(typeof pkg.scripts?.start === 'string' || typeof pkg.scripts?.dev === 'string', `${category} declares start/dev`);
    assert.deepEqual(pkg.dependencies ?? {}, {}, `${category} dependencies are empty (offline baseline)`);
    // Every artifact is a persistable string/Buffer (the origin's contract).
    for (const [relPath, contents] of Object.entries(tmpl)) {
      assert.ok(
        typeof contents === 'string' || Buffer.isBuffer(contents),
        `${category}:${relPath} contents are a string/Buffer`,
      );
    }
  }
});

test('forCategory covers EXACTLY the closed Target_Category enum and throws for an unknown category', () => {
  const provider = createTemplateProvider();
  assert.deepEqual(provider.categories().sort(), [...Target_Category].sort());
  assert.throws(() => provider.forCategory('desktop'), /no template for Target_Category/);
});

test('forCategory returns a FRESH copy per call so callers cannot mutate shared template state', () => {
  const provider = createTemplateProvider();
  const first = provider.forCategory('web');
  first['package.json'] = 'MUTATED';
  first['injected.js'] = 'x';
  const second = provider.forCategory('web');
  assert.notEqual(second['package.json'], 'MUTATED', 'mutation did not leak into shared state');
  assert.equal(second['injected.js'], undefined, 'added key did not leak into shared state');
});

// -------------------------------------------- (b) multi-target EXACTLY four Targets

test('multi-target Template yields EXACTLY the four Targets [web, backend, mobile, shared] (Req 5.6, 16.1)', () => {
  const provider = createTemplateProvider();
  const targets = provider.templateTargets('multi-target');
  // Mutation sensitivity: this is EXACTLY the four Targets in Target-enum order.
  assert.deepEqual(targets, ['web', 'backend', 'mobile', 'shared']);
  assert.equal(targets.length, 4, 'exactly four Targets — a != 4 result fails here');
  // And they are exactly the closed Target enum values.
  assert.deepEqual([...targets].sort(), [...Target].sort());
});

test('multi-target Template scaffolds a subtree for each of the four Targets', () => {
  const provider = createTemplateProvider();
  const tmpl = provider.forCategory('multi-target');
  // Each Target has its own entry subtree; a template dropping one to yield != 4
  // subtrees would fail these presence assertions.
  assert.ok(tmpl['web/index.js'], 'web subtree');
  assert.ok(tmpl['backend/index.js'], 'backend subtree');
  assert.ok(tmpl['mobile/index.js'], 'mobile subtree');
  assert.ok(tmpl['shared/index.js'], 'shared subtree');
  assert.ok(tmpl['package.json'], 'root manifest');
});

test('templateTargets returns the appropriate Target set for each category and throws for an unknown one', () => {
  const provider = createTemplateProvider();
  assert.deepEqual(provider.templateTargets('web'), ['web']);
  assert.deepEqual(provider.templateTargets('full-stack-web'), ['web', 'backend']);
  assert.deepEqual(provider.templateTargets('mobile'), ['mobile']);
  assert.deepEqual(provider.templateTargets('multi-target'), ['web', 'backend', 'mobile', 'shared']);
  assert.throws(() => provider.templateTargets('desktop'), /no template targets/);
});

// -------------------------------------- (c) instantiateTemplate PASS per category

test('instantiateTemplate returns ok:true with a PASS verify for EVERY Target_Category', async () => {
  const provider = createTemplateProvider();
  for (const targetCategory of Target_Category) {
    const result = await instantiateTemplate({
      targetCategory,
      provider,
      verify: () => 'verdict: PASS\nexit code: 0 (10ms)\n',
      now: steppingClock({ step: 100 }), // ~100ms build, well within 300s
    });
    assert.equal(result.ok, true, `${targetCategory} instantiates`);
    assert.equal(result.targetCategory, targetCategory);
    assert.ok(result.projectTree['package.json'], `${targetCategory} produced a tree with a manifest`);
    assert.equal(typeof result.buildMs, 'number');
    assert.ok(result.buildMs < BASELINE_BUILD_SLO_MS, 'buildMs within the 300s SLO');
  }
});

test('instantiateTemplate accepts a structured { verdict: PASS } verify result', async () => {
  const result = await instantiateTemplate({
    targetCategory: 'web',
    verify: () => ({ verdict: 'PASS' }),
    now: steppingClock(),
  });
  assert.equal(result.ok, true);
});

// -------------------------- (d) instantiateTemplate timeout + FAIL build-failures

test('instantiateTemplate marks the instantiation FAILED with a build-failure error when the clock advances past 300s (timeout)', async () => {
  const clock = manualClock({ start: 0 });
  const result = await instantiateTemplate({
    targetCategory: 'web',
    // The verify seam advances the injected clock past the 300s SLO.
    verify: () => {
      clock.advance(BASELINE_BUILD_SLO_MS + 1);
      return 'verdict: PASS';
    },
    now: clock,
  });
  assert.equal(result.ok, false, 'over-budget build is a FAILED instantiation');
  assert.equal(result.code, 'BASELINE_BUILD_TIMEOUT');
  assert.match(result.message, /300000ms SLO/);
  assert.equal(result.projectTree, undefined, 'no Project produced on timeout');
});

test('instantiateTemplate marks the instantiation FAILED when the injected verify returns verdict: FAIL', async () => {
  const result = await instantiateTemplate({
    targetCategory: 'multi-target',
    verify: () => 'verdict: FAIL\nexit code: 1\nfailure lines:\nassert failed\n',
    now: steppingClock(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BASELINE_BUILD_FAILED');
  assert.equal(result.projectTree, undefined, 'no Project produced on a FAIL verdict');
});

test('instantiateTemplate returns a structured failure (never throws) for an unknown category and a missing verify', async () => {
  const unknown = await instantiateTemplate({ targetCategory: 'desktop', verify: () => 'verdict: PASS' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_TARGET_CATEGORY');

  const noVerify = await instantiateTemplate({ targetCategory: 'web' });
  assert.equal(noVerify.ok, false);
  assert.equal(noVerify.code, 'BASELINE_BUILD_FAILED');
});

test('instantiateTemplate treats a verify that THROWS as a build failure (no Project)', async () => {
  const result = await instantiateTemplate({
    targetCategory: 'web',
    verify: () => {
      throw new Error('verify blew up');
    },
    now: steppingClock(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BASELINE_BUILD_FAILED');
  assert.match(result.message, /verify blew up/);
});

// --------------- (e) end-to-end populateTemplate with the REAL provider ---------

test("the Task-14 'template' Project_Origin populateTemplate succeeds end-to-end with the REAL provider for EVERY category", async () => {
  const templateProvider = createTemplateProvider();
  const origin = createProjectOrigin({ templateProvider, now: steppingClock() });

  for (const targetCategory of Target_Category) {
    const expected = templateProvider.forCategory(targetCategory);
    const result = await origin.populate({
      project: projectRecord({ targetCategory }),
      origin: 'template',
      targetCategory,
    });
    assert.equal(result.ok, true, `${targetCategory} populates with the real provider`);
    assert.equal(result.origin, 'template');
    // ALL template files populated, including the dependency manifest.
    assert.deepEqual(
      Object.keys(result.projectTree).sort(),
      Object.keys(expected).sort(),
      `all ${targetCategory} real template files populated`,
    );
    assert.ok(result.projectTree['package.json'], `${targetCategory} dependency manifest populated`);
    assert.equal(typeof result.populateMs, 'number');
  }
});
