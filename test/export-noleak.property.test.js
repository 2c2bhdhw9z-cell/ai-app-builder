/**
 * Property 14 — "Export credential non-leakage" (spec Task 27.5, Req 11.8).
 *
 *   Property 14 (Export credential non-leakage): for all Project_Exports, no
 *   exported file contains a literal Secret or Connector credential VALUE, and
 *   the export includes an env-var TEMPLATE listing every required variable NAME
 *   with no value.
 *
 * We prove this end-to-end against the REAL collaborators, NON-VACUOUSLY:
 *
 *   (generate) fast-check GENERATES a varied set of secrets — distinct NAMEs
 *              and high-entropy VALUEs — plus a varied project source tree that
 *              REFERENCES each generated value as a hardcoded literal (the exact
 *              mistake the export's guardrail secondary-net must scrub).
 *   (store)    each generated secret VALUE is put into a REAL SecretStore, whose
 *              contract keeps values OUT-OF-TREE (controlRoot); the project tree
 *              is materialized on disk with a REAL PersistenceStore.
 *   (non-vacuous PRE-check) BEFORE the export we assert the persisted source
 *              genuinely CONTAINS each literal value — so the property tests real
 *              stripping, never an already-empty tree.
 *   (export)   run the REAL createProjectExport over the real on-disk tree.
 *   (grep)     grep the ENTIRE exported tree (every file + the env template) and
 *              assert NO literal secret/connector VALUE survives anywhere.
 *   (template) assert the env template lists EVERY required NAME as a `NAME=`
 *              line with NO value bytes after `=`.
 *
 * Runs >=100 iterations via fcConfig and carries the EXACT spec tag string
 * `Feature: ai-app-builder, Property 14: Export credential non-leakage`.
 *
 * Hermeticity: every iteration allocates a fresh fs.mkdtemp base removed in a
 * finally; the export writes to its own temp dest which is also removed. No
 * plumby import is made outside the src/engine/plumby.js boundary (this file
 * imports none). No live network / clone / deploy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createPersistenceStore } from '../src/persistence/persistence-store.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import { createProjectExport, ENV_TEMPLATE_FILENAME } from '../src/portability/index.js';

// The EXACT tag string this test must carry (greppable, mapped to spec Prop 14).
const TAG = 'Feature: ai-app-builder, Property 14: Export credential non-leakage';

const OWNER = 'owner-noleak-1';
const PROJECT = 'proj-noleak-1';

/**
 * A valid Secret NAME: uppercase env-var style (letters/digits/underscore),
 * starting with a letter. SecretStore rejects a handful of runtime-critical
 * names (PATH, HOME, NODE_OPTIONS, …); we prefix a stable token so a generated
 * name can never collide with those reserved shadows.
 */
const nameArb = fc
  .stringMatching(/^[A-Z][A-Z0-9_]{2,20}$/)
  .map((s) => `GEN_${s}`);

/**
 * A high-entropy Secret VALUE that is (a) long enough to be an unambiguous
 * needle and (b) contains no characters that would break embedding it as a
 * double-quoted JS string literal. We keep it to a URL/token-safe alphabet.
 */
const valueArb = fc
  .stringMatching(/^[A-Za-z0-9_\-.]{16,48}$/)
  .map((s) => `sk_live_${s}`);

/** 1..4 distinct-named secrets with distinct values. */
const secretsArb = fc
  .uniqueArray(fc.record({ name: nameArb, value: valueArb }), {
    minLength: 1,
    maxLength: 4,
    selector: (s) => s.name,
  })
  .filter((arr) => {
    // Values must also be pairwise distinct so a leak check maps 1:1 to a name.
    const values = arr.map((s) => s.value);
    return new Set(values).size === values.length;
  });

test(`${propertyTag(14, 'Export credential non-leakage')} — no literal value leaks; template lists every NAME with no value`, async () => {
  // The tag helper must produce the EXACT greppable spec string.
  assert.equal(propertyTag(14, 'Export credential non-leakage'), TAG);

  let iterations = 0;

  await fc.assert(
    fc.asyncProperty(secretsArb, async (secrets) => {
      iterations += 1;

      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-prop14-'));
      let exportDest;
      try {
        const layout = createStorageLayout(base);

        // Build a project source tree that HARDCODES each generated secret value
        // as a literal — the mistake the export must scrub. Spread them across
        // several files so the grep covers the whole tree.
        const tree = {
          'package.json': '{\n  "name": "leaky-app",\n  "dependencies": {}\n}\n',
        };
        secrets.forEach((s, i) => {
          tree[`src/config${i}.js`] =
            `// hardcoded credential (a mistake the export must scrub)\n` +
            `export const ${s.name.toLowerCase()} = "${s.value}";\n`;
        });

        // Materialize the tree on disk with the REAL PersistenceStore.
        const persistence = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
        const persisted = persistence.persist(PROJECT, tree);
        assert.equal(persisted.ok, true, 'persist should succeed');

        // Store each generated VALUE in the REAL SecretStore (values out-of-tree).
        // put() returns { projectId, name, path } (no `ok` field); assert the
        // out-of-tree path landed under the control plane, not inside the tree.
        const secretStore = createSecretStore({ layout, ownerId: OWNER });
        for (const s of secrets) {
          const put = secretStore.put(PROJECT, s.name, s.value);
          assert.equal(put.name, s.name, `secret ${s.name} stored`);
          assert.equal(
            layout.isInsideExportTree(put.path),
            false,
            `secret ${s.name} value must live OUT of the export tree`,
          );
        }

        // NON-VACUOUS PRE-CHECK: the persisted source genuinely contains each
        // literal value before the export runs (so we are testing real
        // stripping, not an empty/clean tree).
        const sourceRoot = layout.exportableProjectTree(PROJECT);
        const sourceBytes = readDirTree(sourceRoot);
        for (const s of secrets) {
          const present = Object.values(sourceBytes).some((buf) =>
            buf.toString('utf8').includes(s.value),
          );
          assert.ok(present, `pre-export source must contain the literal value for ${s.name}`);
        }

        // Run the REAL export over the real on-disk tree. SecretStore supplies
        // the { NAME: value } needle map and the NAME list for the template.
        const exporter = createProjectExport({ layout });
        const result = exporter.export(PROJECT, {
          secretEnv: secretStore.envForProject(PROJECT),
          secretNames: secretStore.list(PROJECT),
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        exportDest = result.destDir;

        // GREP THE ENTIRE EXPORTED TREE: no literal secret VALUE survives.
        const exported = readDirTree(result.destDir);
        for (const [rel, buf] of Object.entries(exported)) {
          const body = buf.toString('utf8');
          for (const s of secrets) {
            assert.ok(
              !body.includes(s.value),
              `literal secret value for ${s.name} leaked into exported file ${rel}`,
            );
          }
        }

        // The env TEMPLATE lists EVERY required NAME as `NAME=` with NO value.
        const tmpl = fs.readFileSync(path.join(result.destDir, ENV_TEMPLATE_FILENAME), 'utf8');
        const lines = tmpl.split('\n');
        for (const s of secrets) {
          assert.ok(
            lines.includes(`${s.name}=`),
            `env template must list ${s.name} as a NAME= line with no value`,
          );
        }
        // Every non-comment, non-blank template line is NAME= with NO value bytes.
        for (const raw of lines) {
          const l = raw.trim();
          if (l === '' || l.startsWith('#')) continue;
          assert.match(
            l,
            /^[A-Za-z_][A-Za-z0-9_]*=$/,
            `template line must be NAME= with no value: ${JSON.stringify(l)}`,
          );
        }
        // And no value bytes leaked into the template itself.
        for (const s of secrets) {
          assert.ok(!tmpl.includes(s.value), `env template must not carry the value for ${s.name}`);
        }
      } finally {
        if (exportDest) fs.rmSync(exportDest, { recursive: true, force: true });
        fs.rmSync(base, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );

  // Non-vacuous: fast-check ran the configured >=100 iterations.
  assert.equal(fcConfig.numRuns, 100);
  assert.ok(iterations >= 100, `expected >=100 iterations, ran ${iterations}`);
});

/** Recursively read a directory into a { relPath: Buffer } map (excluding .git). */
function readDirTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        out[rel] = fs.readFileSync(full);
      }
    }
  };
  walk(root);
  return out;
}
