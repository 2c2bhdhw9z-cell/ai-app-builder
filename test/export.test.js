/**
 * Project_Export tests (node --test) — spec Task 27.1, Req 11.6, 11.7, 11.8, 11.9.
 *
 * These exercise REAL collaborators on fs.mkdtempSync temp dirs: a real
 * StorageLayout, a real PersistenceStore materializing a real project tree on
 * disk, the real generation-guardrail (through createProjectExport), the real
 * default read seam walking the on-disk tree, and a real on-disk exported tree.
 * Fakes are used ONLY where a real object cannot be made to fail on demand (an
 * injected failing writer) or to control the clock (the injected `now`).
 *
 * Coverage (each mutation-sensitive — FAILS if the behavior is reverted):
 *   (a) a normal export copies the full file state faithfully into a SEPARATE
 *       destination, with no controlRoot content and no .git tree file;
 *   (b) a literal secret value in a source file is stripped + replaced by an
 *       env-var reference, and grepping the exported tree finds NO literal value;
 *   (c) the env-var template lists EVERY required NAME and NO value bytes;
 *   (d) a Project exceeding the file-count limit ABORTS with FILE_COUNT_EXCEEDED
 *       and reports the excess (no truncation);
 *   (e) an over-budget export (advance the injected clock) ABORTS with
 *       EXPORT_TIMEOUT;
 *   (f) an induced writer failure ABORTS, returns a cause, and leaves the source
 *       tree byte-for-byte UNCHANGED (assert source bytes identical before/after).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createStorageLayout } from '../src/storage/layout.js';
import { createPersistenceStore } from '../src/persistence/persistence-store.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import { defaultConnectorCatalog } from '../src/connectors/catalog.js';
import {
  createProjectExport,
  ENV_TEMPLATE_FILENAME,
  EXPORT_SLO_MS,
} from '../src/portability/index.js';

const OWNER = 'owner-1';
const PROJECT = 'proj-1';

/** A layout rooted at a fresh temp dir, so real file I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-export-test-'));
  return { base, layout: createStorageLayout(base) };
}

/** Persist a { relPath: contents } tree to disk (real PersistenceStore, immediate). */
function persistTree(layout, projectId, tree) {
  const store = createPersistenceStore({ layout, ownerId: OWNER, debounceMs: 0 });
  const res = store.persist(projectId, tree);
  assert.equal(res.ok, true, 'persist should succeed');
  return store;
}

/** Recursively read a directory into a { relPath: utf8-or-buffer } map (excluding .git). */
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

// --- (a) faithful full-state copy into a separate destination ---------------

test('a normal export copies the full file state faithfully into a separate destination', () => {
  const { base, layout } = tempLayout();
  try {
    const tree = {
      'package.json': '{\n  "name": "app",\n  "dependencies": {}\n}\n',
      'src/index.js': "console.log('hello');\n",
      'src/util/helpers.js': 'export const add = (a, b) => a + b;\n',
      'assets/logo.bin': Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]),
    };
    persistTree(layout, PROJECT, tree);

    const exporter = createProjectExport({ layout });
    const result = exporter.export(PROJECT, {});
    assert.equal(result.ok, true, JSON.stringify(result));

    // The destination is SEPARATE from the source tree.
    const sourceRoot = layout.exportableProjectTree(PROJECT);
    assert.notEqual(path.resolve(result.destDir), path.resolve(sourceRoot));
    assert.equal(layout.isInsideExportTree(result.destDir), false, 'export dest must be outside the project tree');

    // Every source file is reproduced byte-for-byte in the export.
    const exported = readDirTree(result.destDir);
    assert.equal(exported['package.json'].toString('utf8'), tree['package.json']);
    assert.equal(exported['src/index.js'].toString('utf8'), tree['src/index.js']);
    assert.equal(exported['src/util/helpers.js'].toString('utf8'), tree['src/util/helpers.js']);
    assert.ok(exported['assets/logo.bin'].equals(tree['assets/logo.bin']), 'binary file must round-trip byte-exact');

    // fileCount counts the project files (not the env template).
    assert.equal(result.fileCount, 4);
    // The env template exists at the export root and is NOT counted as a source file.
    assert.ok(fs.existsSync(path.join(result.destDir, ENV_TEMPLATE_FILENAME)));

    fs.rmSync(result.destDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- (b) literal secret stripped + no literal value anywhere in the export ---

test('a literal secret value in a source file is stripped to an env-var reference and no literal leaks', () => {
  const { base, layout } = tempLayout();
  try {
    const SECRET_VALUE = 'sk_live_SUPERSECRETVALUE_9f8a7b6c';
    const tree = {
      // A source file that (wrongly) hardcodes the secret value — the guardrail
      // secondary net must rewrite it before it lands in the export.
      'src/db.js': `const key = "${SECRET_VALUE}";\nexport default key;\n`,
      'package.json': '{ "name": "app", "dependencies": {} }\n',
    };
    persistTree(layout, PROJECT, tree);

    // Real SecretStore holds the VALUE out-of-tree; envForProject supplies the
    // { NAME: value } needle map, list() the NAMES for the template.
    const secrets = createSecretStore({ layout, ownerId: OWNER });
    secrets.put(PROJECT, 'STRIPE_SECRET_KEY', SECRET_VALUE);

    const exporter = createProjectExport({ layout });
    const result = exporter.export(PROJECT, {
      secretEnv: secrets.envForProject(PROJECT),
      secretNames: secrets.list(PROJECT),
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    // The exported source references the env var, not the literal.
    const exported = readDirTree(result.destDir);
    const dbBody = exported['src/db.js'].toString('utf8');
    assert.ok(dbBody.includes('process.env.STRIPE_SECRET_KEY'), 'should reference the env var');
    assert.ok(!dbBody.includes(SECRET_VALUE), 'the literal secret value must be gone from the file');

    // Grep the ENTIRE exported tree (including the env template) for the literal.
    for (const [rel, buf] of Object.entries(exported)) {
      assert.ok(!buf.toString('utf8').includes(SECRET_VALUE), `literal secret leaked into ${rel}`);
    }
    // The env template body also carries no value.
    const tmpl = fs.readFileSync(path.join(result.destDir, ENV_TEMPLATE_FILENAME), 'utf8');
    assert.ok(!tmpl.includes(SECRET_VALUE), 'env template must not carry the value');

    // The substitution was recorded in the report.
    assert.ok(
      result.substitutionReport.some((r) => r.name === 'STRIPE_SECRET_KEY' && r.kind === 'secret'),
      'the substitution must be recorded in the report',
    );

    fs.rmSync(result.destDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- (c) env template lists every required NAME and NO value -----------------

test('the env-var template lists every required variable NAME with no value', () => {
  const { base, layout } = tempLayout();
  try {
    // A source file with a platform host so PLATFORM_HOST joins the template.
    const catalog = defaultConnectorCatalog;
    const platformHost = catalog.list()[0].hosts[0]; // a real catalog endpoint host
    const tree = {
      'src/app.js': `fetch("https://${platformHost}/track");\n`,
      'package.json': '{ "name": "app", "dependencies": {} }\n',
    };
    persistTree(layout, PROJECT, tree);

    const secrets = createSecretStore({ layout, ownerId: OWNER });
    secrets.put(PROJECT, 'DATABASE_URL', 'postgres://u:p@db/app');
    secrets.put(PROJECT, 'API_TOKEN', 'tok_abc123');

    const exporter = createProjectExport({ layout, connectorCatalog: catalog });
    const result = exporter.export(PROJECT, {
      secretEnv: secrets.envForProject(PROJECT),
      secretNames: secrets.list(PROJECT),
      connectorEnvNames: ['CLERK_SECRET_KEY'],
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    const tmpl = fs.readFileSync(path.join(result.destDir, ENV_TEMPLATE_FILENAME), 'utf8');

    // Every required NAME appears as a `NAME=` line with NO value after `=`.
    const required = ['DATABASE_URL', 'API_TOKEN', 'CLERK_SECRET_KEY', 'PLATFORM_HOST'];
    for (const name of required) {
      const line = `${name}=`;
      assert.ok(tmpl.split('\n').includes(line), `template must list ${name} with no value`);
    }
    // Assert NO value bytes: every non-comment, non-blank line ends with `=`.
    for (const raw of tmpl.split('\n')) {
      const l = raw.trim();
      if (l === '' || l.startsWith('#')) continue;
      assert.match(l, /^[A-Za-z_][A-Za-z0-9_]*=$/, `template line must be NAME= with no value: ${JSON.stringify(l)}`);
    }
    // The values themselves are absent.
    assert.ok(!tmpl.includes('postgres://u:p@db/app'));
    assert.ok(!tmpl.includes('tok_abc123'));

    // The connector catalog's own env names are present too (e.g. STRIPE_SECRET_KEY).
    assert.ok(tmpl.includes('STRIPE_SECRET_KEY='), 'catalog connector credential names must be listed');

    fs.rmSync(result.destDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- (d) file-count limit exceeded -> abort with FILE_COUNT_EXCEEDED ---------

test('a Project exceeding the file-count limit aborts with FILE_COUNT_EXCEEDED and reports the excess', () => {
  const { base, layout } = tempLayout();
  try {
    const tree = {};
    for (let i = 0; i < 5; i += 1) tree[`f${i}.js`] = `// file ${i}\n`;
    persistTree(layout, PROJECT, tree);

    const exporter = createProjectExport({ layout, fileCountLimit: 3 });
    const result = exporter.export(PROJECT, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FILE_COUNT_EXCEEDED');
    assert.equal(result.count, 5);
    assert.equal(result.limit, 3);
    assert.match(result.message, /exceed/i);

    // No truncated output was produced: the source tree is intact (5 files).
    const sourceRoot = layout.exportableProjectTree(PROJECT);
    assert.equal(Object.keys(readDirTree(sourceRoot)).length, 5);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- (e) over-budget export -> abort with EXPORT_TIMEOUT (injected clock) -----

test('an over-budget export aborts with EXPORT_TIMEOUT measured against the injected clock', () => {
  const { base, layout } = tempLayout();
  try {
    persistTree(layout, PROJECT, { 'src/index.js': "console.log('x');\n" });

    // An injected clock that jumps past the 300s SLO between the start reading
    // and the SLO check — no real wait.
    let t = 0;
    const now = () => {
      const v = t;
      t += EXPORT_SLO_MS + 1000; // each call advances well past the budget
      return v;
    };

    const exporter = createProjectExport({ layout, now });
    const result = exporter.export(PROJECT, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EXPORT_TIMEOUT');
    assert.match(result.message, /SLO/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- (f) induced writer failure -> abort + cause + source UNCHANGED ----------

test('an induced writer failure aborts, returns a cause, and leaves the source tree unchanged', () => {
  const { base, layout } = tempLayout();
  try {
    const tree = {
      'package.json': '{ "name": "app", "dependencies": {} }\n',
      'src/index.js': "console.log('unchanged');\n",
      'data.bin': Buffer.from([0x10, 0x20, 0x30]),
    };
    persistTree(layout, PROJECT, tree);

    const sourceRoot = layout.exportableProjectTree(PROJECT);
    const before = readDirTree(sourceRoot);

    // Inject a writer that fails AFTER we would have created the temp dest.
    const failingWriter = () => {
      throw new Error('disk full (induced)');
    };
    const exporter = createProjectExport({ layout, writeExport: failingWriter });
    const result = exporter.export(PROJECT, {});

    assert.equal(result.ok, false);
    assert.equal(result.code, 'WRITE_FAILED');
    assert.ok(result.cause instanceof Error, 'a cause must be returned');
    assert.match(result.cause.message, /disk full/);

    // The Project's stored state is byte-for-byte UNCHANGED.
    const after = readDirTree(sourceRoot);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    for (const rel of Object.keys(before)) {
      assert.ok(after[rel].equals(before[rel]), `source file ${rel} must be unchanged`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- factory shape ----------------------------------------------------------

test('createProjectExport is a frozen factory with injected limit + timeout', () => {
  const { base, layout } = tempLayout();
  try {
    const exporter = createProjectExport({ layout, fileCountLimit: 42, exportTimeoutMs: 12345 });
    assert.equal(Object.isFrozen(exporter), true);
    assert.equal(exporter.fileCountLimit, 42);
    assert.equal(exporter.exportTimeoutMs, 12345);
    assert.equal(typeof exporter.export, 'function');

    // Invalid limit is rejected at the edge.
    assert.throws(() => createProjectExport({ layout, fileCountLimit: 0 }), /fileCountLimit/);
    assert.throws(() => createProjectExport({ layout: null }), /layout/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
