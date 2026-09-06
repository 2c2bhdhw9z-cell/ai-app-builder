/**
 * template-fixture.js — a MINIMAL per-Target_Category Template FIXTURE provider,
 * for TESTING the 'template' Project_Origin (spec subtask 14.1, Req 6.3).
 *
 * THIS IS A TASK-14 TEST FIXTURE, NOT the real Template set. The full Template
 * library (the polished per-category starters) plus the baseline-build Property 7
 * are Task 15 — explicitly out of scope for Task 14. This provider returns ONE
 * tiny template per Target_Category, each shipping:
 *   - a dependency manifest (package.json) so the ProjectOrigin's "populate all
 *     template files + the dependency manifest" contract is exercised, and
 *   - one entry/source file, so the populated tree is non-trivial.
 *
 * It implements the same DI seam production will use — `forCategory(category)`
 * returning a { relPath: contents } map — so the real Task-15 provider can be
 * swapped in behind the identical interface later.
 *
 * Kept deliberately small and clearly labeled: do NOT grow this into the real
 * Template set.
 */

/** Build the minimal package.json manifest text for a fixture template. */
function manifest(name) {
  const pkg = {
    name,
    version: '0.0.0',
    private: true,
    scripts: { start: 'node index.js', dev: 'node index.js' },
    dependencies: {},
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * The minimal fixture templates, keyed by Target_Category. Each is a small
 * { relPath: contents } map including a dependency manifest.
 */
const FIXTURES = {
  web: {
    'package.json': manifest('web-template'),
    'index.js': "console.log('web template');\n",
    'public/index.html': '<!doctype html><title>web template</title>\n',
  },
  'full-stack-web': {
    'package.json': manifest('full-stack-web-template'),
    'server.js': "console.log('full-stack-web template server');\n",
    'client/index.js': "console.log('full-stack-web template client');\n",
  },
  mobile: {
    'package.json': manifest('mobile-template'),
    'App.js': "console.log('mobile template');\n",
  },
  'multi-target': {
    'package.json': manifest('multi-target-template'),
    'index.js': "console.log('multi-target template');\n",
    'mobile/App.js': "console.log('multi-target mobile');\n",
  },
};

/**
 * Create the fixture template provider.
 *
 * @param {object} [opts]
 * @param {(category: string) => (object | undefined)} [opts.overrides]
 *        optional hook so a test can force a specific/failing template for a
 *        category (used to exercise the partial-cleanup / failed-artifact path).
 * @returns {{ forCategory: (category: string) => object }}
 */
export function createTemplateFixtureProvider({ overrides } = {}) {
  return {
    forCategory(category) {
      if (typeof overrides === 'function') {
        const custom = overrides(category);
        if (custom !== undefined) return custom;
      }
      const template = FIXTURES[category];
      if (!template) {
        throw new Error(`no fixture template for Target_Category ${JSON.stringify(category)}`);
      }
      // Return a shallow copy so callers cannot mutate the shared fixture.
      return { ...template };
    },
  };
}
