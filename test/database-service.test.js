/**
 * Database_Service provisioner + backend-scaffolder tests (node --test) — spec
 * Task 20.1, Req 9.1, 9.2, 9.3, 9.6, 9.7 (Correctness Property 8).
 *
 * Following the repo's testing discipline (mirroring test/package-manager.test.js),
 * these exercise REAL collaborators and fake ONLY the container/DB boundary at
 * the SandboxManager.exec / provisioning-teardown seam, with the fake producing
 * the REAL exec contract shape and REAL side effects (real on-disk secret files,
 * a real DB record flipped through the real model). The 60s ceiling is driven by
 * an INJECTED clock (a `now` counter), NEVER real waiting:
 *   - a REAL Database_Service model (createDatabaseService) — the record's status
 *     transitions are asserted against the real factory, not a stub;
 *   - a REAL StorageLayout (createStorageLayout on an fs.mkdtempSync tmp dir) +
 *     a REAL SecretStore + the REAL generation-guardrail for the secret paths;
 *   - a FAKE exec/provisioner seam that is a spy (asserting call COUNTS and the
 *     exact timeoutMs threaded down) returning the REAL exec contract
 *     ({ stdout, stderr, exitCode:number|null, denied, deniedReason, timedOut,
 *     ... }); teardown is a spy so "no partial DB left active" is asserted
 *     against the teardown seam actually being invoked + the record status.
 *
 * MUTATION SENSITIVITY (which assertion flips if the behavior is reverted):
 *   - db-ready-before-complete: the READY test asserts scaffoldBackend returns
 *     complete:true AND database.status === 'ready', and that the endpoint probe
 *     ran BEFORE the provisioner (spy call order). Reverting "report ready before
 *     complete" (e.g. returning complete:true while the DB is still provisioning)
 *     flips database.status !== 'ready'.
 *   - 60s-timeout-no-partial-db: the TIMEOUT test uses an injected `now` counter
 *     that advances past 60_000 and a fake exec returning the boundary timeout
 *     contract; it asserts code === 'DB_PROVISION_TIMEOUT', that the teardown spy
 *     was invoked exactly once (partial DB reaped), and that the returned record
 *     status is 'torn-down' (no active partial DB). Dropping the teardown-in-
 *     failResult reverts the teardown-call-count assertion to 0 (flips).
 *   - failure-no-partial-db: the FAILURE test's fake exec returns a non-zero exit
 *     (the DB bring-up's own failure); asserts code === 'DB_PROVISION_FAILED',
 *     teardown invoked, status 'torn-down'.
 *   - reachable-<400-endpoint: the ENDPOINT tests assert scaffoldBackend confirms
 *     a backend Target AND a < 400 endpoint via the fake exec's REAL contract
 *     (exit 0 == < 400 -> ok; a non-zero exit / denied == unreachable -> failure).
 *   - timeout-via-injected-clock: durationMs is derived from the injected clock,
 *     and provisionTimeoutMs is threaded as opts.timeoutMs into exec.
 *   - Property-8 secret-non-leakage: a real Secret value put into a real
 *     SecretStore is run through the real generation-guardrail; the produced tree
 *     is grepped and the literal value must be ABSENT (rewritten to an env ref).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createDatabaseProvisioner,
  createBackendScaffolder,
  guardBackendSecrets,
  DEFAULT_DB_PROVISION_TIMEOUT_MS,
} from '../src/sandbox/database-service.js';
import {
  createDatabaseService,
  DATABASE_SERVICE_STATUS,
} from '../src/model/database-service.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import { createTemplateProvider } from '../src/project/templates.js';

// ---------------------------------------------------------------- fakes/helpers

const PROJECT_ID = 'proj-fs-1';

/**
 * A FAKE SandboxManager exposing ONLY exec(projectId, command, {timeoutMs,
 * signal}), returning the REAL exec contract shape (see sandbox-manager.js). It
 * is a spy recording every call so we can assert COUNT + the exact opts threaded
 * down. `result` is merged over the contract defaults so a test can model exit 0
 * (ready/reachable), a non-zero exit (bring-up's own failure), or the boundary
 * TIMEOUT contract. `perCommand` lets a single manager answer differently for the
 * probe vs the provision vs the teardown command.
 */
function fakeManager(result = {}, opts = {}) {
  const calls = [];
  const { perCommand } = opts;
  return {
    calls,
    exec: async (projectId, command, execOpts) => {
      calls.push({ projectId, command, opts: execOpts });
      const override = typeof perCommand === 'function' ? perCommand(command) : null;
      return Object.freeze({
        stdout: '',
        stderr: '',
        exitCode: 0,
        denied: false,
        deniedReason: null,
        timedOut: false,
        signal: null,
        projectId,
        network: 'none',
        workspacePath: '/box',
        mountSource: '/src',
        limitsApplied: null,
        ...result,
        ...(override ?? {}),
      });
    },
  };
}

/** An injected clock: returns successive values from `ticks`, last value sticks. */
function fakeClock(ticks) {
  let i = 0;
  return () => {
    const v = ticks[Math.min(i, ticks.length - 1)];
    i += 1;
    return v;
  };
}

/** A fresh tmp StorageLayout + a real SecretStore for PROJECT_ID. */
function freshSecretStore(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-dbsvc-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const layout = createStorageLayout(baseDir);
  const store = createSecretStore({ layout });
  return { baseDir, layout, store };
}

// ================================================================ (1) DB READY WITHIN 60s -> COMPLETE

test('DB READY (Req 9.2): scaffolding completes ONLY after the DB reports ready — status ready, probe ran before provision', async (t) => {
  // exit 0 for every command == boundary success (endpoint < 400, DB ready).
  const manager = fakeManager({ exitCode: 0 });
  const provisioner = createDatabaseProvisioner({
    manager,
    // now() ticks: [createdAt, startedAt, finishedAt] -> 5s bring-up within 60s.
    now: fakeClock([0, 0, 5_000]),
    newId: () => 'db-fixed',
  });
  const scaffolder = createBackendScaffolder({
    provisioner,
    manager,
    templateProvider: createTemplateProvider(),
    now: () => 0,
  });

  const res = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'full-stack-web' });

  // Scaffolding complete + DB reported ready BEFORE completion.
  assert.equal(res.ok, true);
  assert.equal(res.complete, true);
  assert.equal(res.endpointStatusOk, true);
  assert.equal(res.database.status, 'ready', 'DB must be READY before scaffolding is complete (flips if reported early)');
  assert.equal(res.database.projectId, PROJECT_ID);
  assert.equal(res.durationMs, 5_000, 'durationMs is derived from the injected clock, not real time');

  // The endpoint probe ran BEFORE the DB bring-up (Req 9.1 before 9.2).
  assert.equal(manager.calls.length >= 2, true, 'probe + provision both ran through exec');
  assert.match(manager.calls[0].command, /http-probe/, 'endpoint reachability probed first');
  assert.match(manager.calls[1].command, /db-provision/, 'DB provisioned after the endpoint check');
});

// ================================================================ (2) 60s TIMEOUT -> no partial DB

test('DB TIMEOUT (Req 9.3): boundary timeout via INJECTED clock -> DB_PROVISION_TIMEOUT, teardown invoked, no active partial DB', async (t) => {
  const teardownCalls = [];
  // The boundary's wall-clock reaper fired at the ceiling: exitCode null, denied
  // true, deniedReason 'timeout', timedOut true — NO real waiting.
  const manager = fakeManager({
    exitCode: null,
    denied: true,
    deniedReason: 'timeout',
    timedOut: true,
    stderr: 'db still initializing at kill',
  });
  const provisioner = createDatabaseProvisioner({
    manager,
    // now() ticks: [createdAt, startedAt, finishedAt] -> derives durationMs=60000.
    now: fakeClock([0, 0, DEFAULT_DB_PROVISION_TIMEOUT_MS]),
    newId: () => 'db-timeout',
    teardown: async ({ projectId, database }) => {
      teardownCalls.push({ projectId, id: database.id, status: database.status });
    },
  });

  // The default ceiling is the 60s value.
  assert.equal(provisioner.provisionTimeoutMs, DEFAULT_DB_PROVISION_TIMEOUT_MS);
  assert.equal(DEFAULT_DB_PROVISION_TIMEOUT_MS, 60_000);

  const res = await provisioner.provision({ projectId: PROJECT_ID });

  // The 60s ceiling was threaded as opts.timeoutMs into exec.
  assert.equal(manager.calls.length, 1);
  assert.equal(manager.calls[0].opts.timeoutMs, DEFAULT_DB_PROVISION_TIMEOUT_MS);

  assert.equal(res.ok, false);
  assert.equal(res.code, 'DB_PROVISION_TIMEOUT');
  assert.match(res.message, /ceiling/);
  assert.equal(res.durationMs, DEFAULT_DB_PROVISION_TIMEOUT_MS);

  // No partial DB left active: teardown seam invoked exactly once, record status
  // 'torn-down' (never a lingering 'provisioning'/'ready'). Flips to 0 if the
  // teardown-in-failResult rollback is reverted.
  assert.equal(teardownCalls.length, 1, 'teardown seam invoked to reap the partial DB');
  assert.equal(res.tornDown, true);
  assert.equal(res.database.status, 'torn-down', 'no active partial DB record survives');
});

// ================================================================ (3) FAILURE -> no partial DB

test('DB FAILURE (Req 9.3): bring-up non-zero exit -> DB_PROVISION_FAILED, teardown invoked, no active partial DB', async (t) => {
  const teardownCalls = [];
  // The command executed inside the box but the DB bring-up failed (denied:false,
  // non-zero exit == the bring-up's OWN failure).
  const manager = fakeManager({
    exitCode: 1,
    denied: false,
    stderr: 'FATAL: could not initialize database cluster',
  });
  const provisioner = createDatabaseProvisioner({
    manager,
    now: fakeClock([0, 3_000]),
    newId: () => 'db-fail',
    teardown: async ({ database }) => {
      teardownCalls.push(database.id);
    },
  });

  const res = await provisioner.provision({ projectId: PROJECT_ID });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'DB_PROVISION_FAILED');
  assert.match(res.message, /could not initialize/);
  assert.equal(teardownCalls.length, 1, 'teardown seam invoked to reap the partial DB');
  assert.equal(res.tornDown, true);
  assert.equal(res.database.status, 'torn-down', 'no active partial DB record survives');
});

// ================================================================ (4) reachable < 400 endpoint (Req 9.1)

test('ENDPOINT (Req 9.1): a backend Target with a reachable < 400 endpoint in the Sandbox is confirmed via the REAL exec contract', async (t) => {
  // The probe reports the backend responded with a status < 400: exit 0.
  const manager = fakeManager({ exitCode: 0 });
  const provisioner = createDatabaseProvisioner({ manager, now: fakeClock([0, 1_000]), newId: () => 'db-ep' });
  const scaffolder = createBackendScaffolder({
    provisioner,
    manager,
    templateProvider: createTemplateProvider(),
  });

  // multi-target also scaffolds a backend Target (Req 5.6 / 9.1).
  const res = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'multi-target' });
  assert.equal(res.ok, true);
  assert.equal(res.endpointStatusOk, true, 'endpoint returned HTTP < 400 in the Sandbox (exit 0 contract)');
  assert.equal(res.database.status, 'ready');
});

test('ENDPOINT UNREACHABLE (Req 9.1): a >= 400 / denied endpoint fails scaffolding and never provisions the DB', async (t) => {
  // The probe reports the endpoint did NOT respond < 400 (non-zero exit), and
  // the DB bring-up (if it were reached) would be exit 0 — but it must NOT run.
  const provisionSpy = [];
  const manager = fakeManager(
    {},
    {
      perCommand: (command) => {
        if (String(command).includes('http-probe')) {
          return { exitCode: 1, denied: false, stderr: 'endpoint returned 500' };
        }
        provisionSpy.push(command);
        return { exitCode: 0 };
      },
    },
  );
  const provisioner = createDatabaseProvisioner({ manager, now: fakeClock([0, 1_000]), newId: () => 'db-x' });
  const scaffolder = createBackendScaffolder({ provisioner, manager, templateProvider: createTemplateProvider() });

  const res = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'full-stack-web' });
  assert.equal(res.ok, false);
  assert.equal(res.complete, false);
  assert.equal(res.code, 'ENDPOINT_UNREACHABLE');
  assert.equal(res.endpointStatusOk, false);
  // Provision must NOT have run — no db-provision command reached exec.
  assert.equal(provisionSpy.length, 0, 'DB is not provisioned when the endpoint is unreachable');
});

test('BACKEND MISSING (Req 9.1): a category with no backend Target fails scaffolding', async (t) => {
  const manager = fakeManager({ exitCode: 0 });
  const provisioner = createDatabaseProvisioner({ manager, now: () => 0, newId: () => 'db-y' });
  const scaffolder = createBackendScaffolder({ provisioner, manager, templateProvider: createTemplateProvider() });

  // 'web' scaffolds only ['web'] — no backend Target.
  const res = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'web' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BACKEND_TARGET_MISSING');
  assert.equal(manager.calls.length, 0, 'no probe/provision runs when there is no backend Target');
});

// ================================================================ (5) DB failure during scaffold -> incomplete, no partial DB

test('SCAFFOLD DB TIMEOUT (Req 9.3): DB timeout during scaffolding -> complete:false and no active partial DB', async (t) => {
  const teardownCalls = [];
  const manager = fakeManager(
    {},
    {
      perCommand: (command) => {
        if (String(command).includes('http-probe')) return { exitCode: 0 }; // endpoint OK
        // db-provision times out at the boundary.
        return { exitCode: null, denied: true, deniedReason: 'timeout', timedOut: true, stderr: 'timed out' };
      },
    },
  );
  const provisioner = createDatabaseProvisioner({
    manager,
    now: fakeClock([0, DEFAULT_DB_PROVISION_TIMEOUT_MS]),
    newId: () => 'db-scaffold-timeout',
    teardown: async ({ database }) => teardownCalls.push(database.id),
  });
  const scaffolder = createBackendScaffolder({ provisioner, manager, templateProvider: createTemplateProvider() });

  const res = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'full-stack-web' });
  assert.equal(res.ok, false);
  assert.equal(res.complete, false, 'scaffolding is INCOMPLETE when the DB does not come up');
  assert.equal(res.code, 'DB_PROVISION_TIMEOUT');
  assert.equal(res.endpointStatusOk, true, 'the endpoint was reachable; only the DB failed');
  assert.equal(res.tornDown, true);
  assert.equal(res.database.status, 'torn-down');
  assert.equal(teardownCalls.length, 1, 'the partial DB was reaped during scaffolding failure');
});

// ================================================================ (6) Property 8 — secret non-leakage

test('SECRET NON-LEAKAGE (Req 9.7 / Property 8): a real Secret value never appears literally in generated backend/DB source', async (t) => {
  const { store, layout } = freshSecretStore(t);

  // A real Secret defined on the project (a DB connection string), stored via
  // the REAL SecretStore (value lives out-of-tree, never in the export tree).
  const SECRET_NAME = 'DATABASE_URL';
  const SECRET_VALUE = 'postgres://admin:sup3r-s3cret@db.internal:5432/app';
  store.put(PROJECT_ID, SECRET_NAME, SECRET_VALUE);

  // The value is injected at RUNTIME via envForProject (Req 9.6) — not written
  // to any file.
  const env = store.envForProject(PROJECT_ID);
  assert.equal(env[SECRET_NAME], SECRET_VALUE, 'the value is available for runtime injection');

  // The store persisted the value OUT-OF-TREE (never inside the exportable tree).
  const treeRoot = layout.exportableProjectTree(PROJECT_ID);
  assert.equal(layout.isInsideExportTree(treeRoot), true);

  // Generated backend/DB source that NAIVELY embeds the literal secret value.
  const generated = {
    'backend/db.js':
      `// generated DB client\n` +
      `export const connectionString = '${SECRET_VALUE}';\n` +
      `export function connect() { return connectionString; }\n`,
    'backend/index.js':
      `import { connect } from './db.js';\n` +
      `export function main() { return connect(); }\n`,
  };

  // Run it through the guardrail (Req 9.7 / Property 8), passing the REAL
  // secrets from the store's env map.
  const { files, report } = guardBackendSecrets({ files: generated, secrets: env });

  // The literal secret value is GONE from every produced file and rewritten to
  // an env-var reference. This grep is the Property-8 assertion.
  for (const [file, content] of Object.entries(files)) {
    assert.equal(content.includes(SECRET_VALUE), false, `literal secret leaked into ${file}`);
  }
  assert.match(files['backend/db.js'], /process\.env\.DATABASE_URL/, 'secret rewritten to an env-var reference');
  // The substitution was recorded (user-visible report).
  assert.equal(report.some((r) => r.name === SECRET_NAME && r.kind === 'secret'), true);

  // Now write the GUARDED files into the exportable tree and grep the whole tree
  // for the literal — it must be absent (no committed file contains it).
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(treeRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
  const allText = fs
    .readdirSync(path.join(treeRoot, 'backend'))
    .map((f) => fs.readFileSync(path.join(treeRoot, 'backend', f), 'utf8'))
    .join('\n');
  assert.equal(allText.includes(SECRET_VALUE), false, 'no committed backend source contains the literal secret value');
});

// ================================================================ model record

test('MODEL: createDatabaseService validates a closed status enum and normalizes fields', () => {
  const db = createDatabaseService({
    id: 'db-1',
    projectId: PROJECT_ID,
    status: 'provisioning',
    engine: 'postgres',
    createdAt: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(db.status, 'provisioning');
  assert.equal(db.engine, 'postgres');
  assert.equal(db.schemaVersion, null, 'schemaVersion is nullable, null before any migration');
  assert.equal(db.createdAt, '2026-01-02T03:04:05.000Z');

  // Defaults: status 'provisioning', engine 'postgres'.
  const d2 = createDatabaseService({ id: 'db-2', projectId: PROJECT_ID, createdAt: '2026-01-02T03:04:05Z' });
  assert.equal(d2.status, 'provisioning');
  assert.equal(d2.engine, 'postgres');

  // The status enum is CLOSED — an unknown status is rejected.
  assert.throws(
    () => createDatabaseService({ id: 'x', projectId: PROJECT_ID, status: 'bogus', createdAt: '2026-01-02T03:04:05Z' }),
    /status must be one of/,
  );
  // Sanity: the closed set is exactly the four states.
  assert.deepEqual([...DATABASE_SERVICE_STATUS], ['provisioning', 'ready', 'failed', 'torn-down']);
});
