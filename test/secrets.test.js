/**
 * SecretStore + Sandbox env injection + generation guardrail tests (node --test).
 *
 * Covers spec subtasks 7.1 and 7.2* (Property 8, Secret non-leakage), Req 9.6,
 * 9.7, 10.4, 11.4, 11.5:
 *
 *   (a) put/get/remove round-trip stores the VALUE at layout.controlSecretPath
 *       and the file is OUTSIDE every export tree (isInsideExportTree === false);
 *   (b) list() returns NAMES only, never values;
 *   (c) envForProject builds the in-memory { NAME: value } map and writes no
 *       value under exportableProjectTree;
 *   (d) the container run seam (buildRunArgs) emits name-only `-e NAME`
 *       references and does NOT embed the literal value in argv; the SandboxManager
 *       passes secret env through to the backend as the child env, not argv;
 *   (e) the generation guardrail rewrites literal secrets / platform hosts into
 *       env-var references and reports each; clean content is unchanged;
 *   Property 8: for many generated secrets, committing a guardrail-processed tree
 *       to disk and grepping it finds the literal value in NO committed file, and
 *       the out-of-tree store file is not part of the committed tree. >=100 runs.
 *
 * The pluggable encryption `codec` seam defaults to an identity/opaque passthrough
 * (real envelope encryption is DEFERRED to Task 12.4 and slots in via that seam).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createSecretStore, identityCodec, RESERVED_ENV_NAMES } from '../src/secrets/secret-store.js';
import { scanAndSubstitute, PLATFORM_HOST_ENV_NAME } from '../src/secrets/index.js';
import { buildRunArgs } from '../src/sandbox/container-backend.js';
import { createSandboxManager } from '../src/sandbox/sandbox-manager.js';

const OWNER = 'owner-1';
const PROJECT = 'proj-1';

/** A layout rooted at a fresh temp dir, so real file I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-secrets-'));
  return { base, layout: createStorageLayout(base) };
}

// --- 7.1 SecretStore ------------------------------------------------------

test('put/get/remove round-trips the VALUE stored OUTSIDE every export tree', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSecretStore({ layout, ownerId: OWNER });
    const { path: p } = store.put(PROJECT, 'DATABASE_URL', 'postgres://secret@db/app');

    // The value lands exactly at controlSecretPath, which is out-of-tree.
    assert.equal(p, layout.controlSecretPath(OWNER, PROJECT, 'DATABASE_URL'));
    assert.equal(layout.isInsideExportTree(p), false, 'secret value must be out-of-tree');
    assert.ok(fs.existsSync(p), 'value file should exist on disk');

    assert.equal(store.get(PROJECT, 'DATABASE_URL'), 'postgres://secret@db/app');
    assert.equal(store.has(PROJECT, 'DATABASE_URL'), true);

    store.remove(PROJECT, 'DATABASE_URL');
    assert.equal(store.get(PROJECT, 'DATABASE_URL'), null);
    assert.equal(store.has(PROJECT, 'DATABASE_URL'), false);
    // remove is idempotent.
    assert.doesNotThrow(() => store.remove(PROJECT, 'DATABASE_URL'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('default codec is the identity/opaque passthrough (Task 12.4 seam)', () => {
  // The on-disk bytes are exactly the UTF-8 value (no encryption in this pass).
  assert.deepEqual(identityCodec.encode('abc'), Buffer.from('abc', 'utf8'));
  assert.equal(identityCodec.decode(Buffer.from('abc', 'utf8')), 'abc');

  const { base, layout } = tempLayout();
  try {
    const store = createSecretStore({ layout, ownerId: OWNER });
    const { path: p } = store.put(PROJECT, 'TOKEN', 'plain-value');
    assert.equal(fs.readFileSync(p, 'utf8'), 'plain-value');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a custom codec slots in without changing callers (envelope-encryption seam)', () => {
  const { base, layout } = tempLayout();
  try {
    // A trivial reversible "codec" standing in for Task 12.4 envelope encryption.
    const codec = {
      encode: (v) => Buffer.from(Buffer.from(v, 'utf8').toString('base64'), 'utf8'),
      decode: (b) => Buffer.from(Buffer.from(b).toString('utf8'), 'base64').toString('utf8'),
    };
    const store = createSecretStore({ layout, ownerId: OWNER, codec });
    const { path: p } = store.put(PROJECT, 'API_KEY', 'sk-live-123');
    // On disk it is transformed, not plaintext.
    assert.notEqual(fs.readFileSync(p, 'utf8'), 'sk-live-123');
    // But get() round-trips through the codec unchanged.
    assert.equal(store.get(PROJECT, 'API_KEY'), 'sk-live-123');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('list returns NAMES only, never values', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSecretStore({ layout, ownerId: OWNER });
    store.put(PROJECT, 'ALPHA', 'value-alpha');
    store.put(PROJECT, 'BETA', 'value-beta');

    const names = store.list(PROJECT);
    assert.deepEqual(names, ['ALPHA', 'BETA']);
    // No value string appears anywhere in the listing.
    const joined = JSON.stringify(names);
    assert.ok(!joined.includes('value-alpha'));
    assert.ok(!joined.includes('value-beta'));
    // An empty project lists nothing.
    assert.deepEqual(store.list('empty-proj'), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('put rejects unsafe / non-env-var names', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSecretStore({ layout, ownerId: OWNER });
    assert.throws(() => store.put(PROJECT, '../escape', 'x'));
    assert.throws(() => store.put(PROJECT, 'has-dash', 'x'));
    assert.throws(() => store.put(PROJECT, '1LEADING', 'x'));
    assert.throws(() => store.put(PROJECT, 'has space', 'x'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('put rejects reserved / dangerous env-var names but accepts ordinary ones', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSecretStore({ layout, ownerId: OWNER });

    // A secret named after a runtime-critical variable would silently shadow it
    // in the container env (secrets merge OVER process.env), so put() rejects it.
    assert.throws(() => store.put(PROJECT, 'PATH', '/evil'), /reserved/);
    assert.throws(() => store.put(PROJECT, 'NODE_OPTIONS', '--require /evil.js'), /reserved/);
    // Every declared reserved name is rejected.
    for (const reserved of RESERVED_ENV_NAMES) {
      assert.throws(() => store.put(PROJECT, reserved, 'x'), /reserved/, `${reserved} must be rejected`);
    }
    // The reserved set is frozen so it cannot be tampered with at runtime.
    assert.ok(Object.isFrozen(RESERVED_ENV_NAMES));

    // Ordinary env-var names still work.
    assert.doesNotThrow(() => store.put(PROJECT, 'DATABASE_URL', 'postgres://x'));
    assert.doesNotThrow(() => store.put(PROJECT, 'API_KEY', 'sk-123'));
    assert.equal(store.get(PROJECT, 'API_KEY'), 'sk-123');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('envForProject builds the in-memory { NAME:value } map; no value under the export tree', () => {
  const { base, layout } = tempLayout();
  try {
    const store = createSecretStore({ layout, ownerId: OWNER });
    store.put(PROJECT, 'DB', 'db-secret');
    store.put(PROJECT, 'KEY', 'key-secret');

    const env = store.envForProject(PROJECT);
    assert.deepEqual(env, { DB: 'db-secret', KEY: 'key-secret' });

    // Nothing was written under the exportable project tree.
    const tree = layout.exportableProjectTree(PROJECT);
    const treeExists = fs.existsSync(tree);
    if (treeExists) {
      const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else {
            const body = fs.readFileSync(full, 'utf8');
            assert.ok(!body.includes('db-secret'), `${full} leaked a secret`);
            assert.ok(!body.includes('key-secret'), `${full} leaked a secret`);
          }
        }
      };
      walk(tree);
    } else {
      assert.ok(true, 'no export tree was created by env materialization');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 7.1 container run seam (env injection) -------------------------------

test('buildRunArgs emits name-only `-e NAME` references and NEVER the literal value', () => {
  const args = buildRunArgs({
    name: 'aab-sbx-p1',
    mountSource: '/host/tree',
    network: 'none',
    command: ['sh', '-c', 'node app.js'],
    env: { DATABASE_URL: 'postgres://leak@db/app', API_KEY: 'sk-live-do-not-leak' },
  });
  const joined = args.join(' ');
  // Name-only references present.
  assert.ok(args.includes('-e'));
  assert.ok(args.includes('DATABASE_URL'));
  assert.ok(args.includes('API_KEY'));
  // The `-e NAME=value` form is NEVER used, and no literal value is in argv.
  assert.ok(!joined.includes('DATABASE_URL='), 'must not use -e NAME=value form');
  assert.ok(!joined.includes('postgres://leak@db/app'), 'value must not appear in argv');
  assert.ok(!joined.includes('sk-live-do-not-leak'), 'value must not appear in argv');
});

test('buildRunArgs without env is unchanged (no -e flags)', () => {
  const args = buildRunArgs({ name: 'n', mountSource: '/t', command: ['true'] });
  assert.ok(!args.includes('-e'));
});

test('SandboxManager.exec injects secret env via the child env, not argv', async () => {
  const { base, layout } = tempLayout();
  try {
    // Recording fake backend: captures the run spec passed to runOneShot and,
    // like the real backend, resolves values from a childEnv (never from argv).
    const seen = { runArgs: null, env: null };
    const fakeBackend = {
      async runOneShot(spec) {
        seen.env = spec.env;
        // Mirror the real backend: names -> `-e NAME`, values -> child env.
        seen.runArgs = buildRunArgs({
          name: spec.name,
          mountSource: spec.mountSource,
          network: spec.network,
          command: spec.command,
          env: spec.env,
        });
        return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      },
      async remove() {
        return { removed: true };
      },
      async reapOrphans() {
        return { reaped: [] };
      },
    };

    const store = createSecretStore({ layout, ownerId: OWNER });
    store.put(PROJECT, 'SECRET_TOKEN', 'top-secret-value');

    const manager = createSandboxManager({ layout, backend: fakeBackend, secretStore: store });
    const res = await manager.exec(PROJECT, 'node app.js');

    // Denial contract unchanged: ran in-box, exit 0, not denied.
    assert.equal(res.denied, false);
    assert.equal(res.exitCode, 0);

    // The env map reached the backend, and the value is NOT in the argv.
    assert.deepEqual(seen.env, { SECRET_TOKEN: 'top-secret-value' });
    const joined = seen.runArgs.join(' ');
    assert.ok(seen.runArgs.includes('SECRET_TOKEN'), 'name-only reference present');
    assert.ok(!joined.includes('top-secret-value'), 'value must not be in argv');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('SandboxManager.exec without a secret provider injects no env (additive)', async () => {
  const { base, layout } = tempLayout();
  try {
    let seenEnv = 'unset';
    const fakeBackend = {
      async runOneShot(spec) {
        seenEnv = spec.env;
        return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
      },
      async remove() {
        return { removed: true };
      },
      async reapOrphans() {
        return { reaped: [] };
      },
    };
    const manager = createSandboxManager({ layout, backend: fakeBackend });
    const res = await manager.exec(PROJECT, 'true');
    assert.equal(res.denied, false);
    assert.equal(seenEnv, undefined, 'no secret provider => no env injected');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// --- 7.1 generation guardrail ---------------------------------------------

test('generation guardrail rewrites literal secret + platform host, reports each', () => {
  const secretValue = 'sk-live-abc123';
  const host = 'api.internal-platform.example';
  const content = [
    `const key = "${secretValue}";`,
    `const url = "https://${host}/v1/things";`,
    `fetch("https://${host}/v1/other", { headers: { auth: "${secretValue}" } });`,
  ].join('\n');

  const { content: out, report } = scanAndSubstitute({
    content,
    secrets: { API_KEY: secretValue },
    platformHosts: [host],
  });

  // No literal value or host remains.
  assert.ok(!out.includes(secretValue), 'secret literal must be gone');
  assert.ok(!out.includes(host), 'platform host literal must be gone');
  // Replaced with env-var references.
  assert.ok(out.includes('process.env.API_KEY'));
  assert.ok(out.includes(`process.env.${PLATFORM_HOST_ENV_NAME}`));

  // Report records each kind with occurrence counts.
  const secretEntry = report.find((r) => r.kind === 'secret');
  const hostEntry = report.find((r) => r.kind === 'platform-host');
  assert.equal(secretEntry.name, 'API_KEY');
  assert.equal(secretEntry.occurrences, 2);
  assert.equal(hostEntry.name, PLATFORM_HOST_ENV_NAME);
  assert.equal(hostEntry.occurrences, 2);
});

test('generation guardrail leaves clean content unchanged with an empty report', () => {
  const content = 'const x = process.env.SAFE;\nconsole.log("hello world");\n';
  const { content: out, report } = scanAndSubstitute({
    content,
    secrets: { SAFE: 'never-appears-literally' },
    platformHosts: ['unused.example'],
  });
  assert.equal(out, content);
  assert.deepEqual(report, []);
});

test('generation guardrail processes a files map', () => {
  const { files, report } = scanAndSubstitute({
    files: {
      'a.js': 'const t = "secret-token";',
      'b.js': 'const clean = 1;',
    },
    secrets: { TOKEN: 'secret-token' },
  });
  assert.ok(files['a.js'].includes('process.env.TOKEN'));
  assert.ok(!files['a.js'].includes('secret-token'));
  assert.equal(files['b.js'], 'const clean = 1;');
  assert.equal(report.length, 1);
  assert.equal(report[0].file, 'a.js');
});

// --- 7.2* Property 8: Secret non-leakage ----------------------------------

test(propertyTag(8, 'Secret non-leakage'), async () => {
  // A credential-shaped generator: a distinctive, unguessable prefix plus varied
  // body characters (letters, digits, and tricky symbols incl. quotes/backslashes
  // that could break naive escaping). The prefix guarantees the value is a real
  // credential rather than a 1-char substring that coincidentally appears in code
  // boilerplate (e.g. "c" inside `const`) — the property under test is that a
  // genuine secret VALUE never survives into a committed file, and the guardrail's
  // literal-substitution is exact, so any distinctive value is what matters.
  const secretGen = fc
    .string({
      minLength: 1,
      maxLength: 60,
      unit: fc.constantFrom(...'ABCDEFabcdef0123456789-_./:@!#$%^&*()"\\'.split('')),
    })
    .map((body) => `sk_live_${body}`);

  await fc.assert(
    fc.asyncProperty(secretGen, async (secretValue) => {
        const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'aab-prop8-'));
        try {
          const layout = createStorageLayout(base);
          const store = createSecretStore({ layout, ownerId: OWNER });

          // 1) Put the secret in the store (VALUE lands out-of-tree).
          const secretName = 'PROP8_SECRET';
          const { path: storePath } = store.put(PROJECT, secretName, secretValue);
          assert.equal(layout.isInsideExportTree(storePath), false);

          // 2) Representative generated source that references the secret BY NAME
          //    but ALSO (adversarially) contains the literal value, so the
          //    guardrail secondary net must strip it before we commit.
          const generated = {
            'index.js':
              `const token = "${secretValue}";\n` +
              `export function auth() { return process.env.${secretName}; }\n`,
            'config.js': `export const cfg = { token: "${secretValue}" };\n`,
          };
          const { files } = scanAndSubstitute({
            files: generated,
            secrets: { [secretName]: secretValue },
            platformHosts: [],
          });

          // 3) COMMIT the resulting project tree to disk (the exportable tree).
          const tree = layout.exportableProjectTree(PROJECT);
          fs.mkdirSync(tree, { recursive: true });
          for (const [rel, body] of Object.entries(files)) {
            fs.writeFileSync(path.join(tree, rel), body);
          }

          // 4) GREP the entire committed tree: the literal value must be in NO file.
          const walk = (dir) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, ent.name);
              if (ent.isDirectory()) walk(full);
              else {
                const body = fs.readFileSync(full, 'utf8');
                assert.ok(
                  !body.includes(secretValue),
                  `committed file ${full} leaked the secret value`,
                );
              }
            }
          };
          walk(tree);

          // 5) The out-of-tree store file is NOT part of the committed tree.
          assert.equal(layout.isInsideExportTree(storePath), false);
          assert.equal(store.get(PROJECT, secretName), secretValue);
        } finally {
          await fsp.rm(base, { recursive: true, force: true });
        }
      },
    ),
    fcConfig,
  );
});
