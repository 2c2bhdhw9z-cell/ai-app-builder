/**
 * Full-stack DB provisioning + migration INTEGRATION tests (node --test) — spec
 * Task 20.3 (the optional `*` tests), Req 9.2, 9.3, 9.4, 9.5.
 *
 * Where test/database-service.test.js and test/schema-migration.test.js exercise
 * the provisioner/scaffolder/migrator at the UNIT level, this file wires the
 * WHOLE full-stack lifecycle together with REAL collaborators and asserts the
 * cross-component TIMING SLOs + failure/rollback guarantees end-to-end, exactly
 * as test/project-origins.integration.test.js does for the origins pipeline:
 *
 *   REAL, wired together (no stubs of the objects under test):
 *     - a REAL StorageLayout (createStorageLayout on an fs.mkdtempSync temp dir);
 *     - a REAL SecretStore (createSecretStore) + the REAL generation-guardrail
 *       (guardBackendSecrets/scanAndSubstitute) for Property 8 non-leakage;
 *     - a REAL CommandGuard (createCommandGuard) driven by the REAL plumby
 *       classifier (classifyCommand via THE plumby boundary at
 *       src/engine/plumby.js — NOT stubbed) so a migration genuinely classifies
 *       `db-migration` -> confirm and is gated, while a plain command is `allow`;
 *     - the REAL FEAT-002 provisioner + scaffolder and the REAL FEAT-003 migrator
 *       (createDatabaseProvisioner/createBackendScaffolder/createSchemaMigrator);
 *     - a REAL Database_Service model (createDatabaseService) whose status /
 *       schemaVersion transitions are asserted against the real factory.
 *
 *   FAKE only at the ONE seam the real objects can't reach offline — the
 *   container/DB boundary at SandboxManager.exec / the provisioner-teardown seam.
 *   The fake is a single shared spy that (a) records every call so we can assert
 *   ORDER + the exact timeoutMs threaded down, (b) returns the REAL exec contract
 *   shape ({ stdout, stderr, exitCode:number|null, denied, deniedReason,
 *   timedOut, ... }), and (c) advances a SINGLE INJECTED `now` counter by a
 *   scripted per-command duration and carries REAL side effects (flips an
 *   in-memory "live DB" registry + an "applied schema" record). NO real DB, NO
 *   real backend, NO real network, NO real wall-clock waiting — every SLO is
 *   measured against the manually-advanced injected clock, per context.json.
 *
 * MUTATION SENSITIVITY (each documented assertion flips if the guarantee is
 * reverted — noted inline at every case):
 *   - DB-ready-<=60s-before-complete: reverting "report ready before complete"
 *     (returning complete while status !== 'ready') OR letting the bring-up run
 *     over 60_000ms flips the ordering / duration / code assertions.
 *   - 60s-timeout-no-partial-DB: dropping teardown-in-failResult flips the live-DB
 *     registry assertion (a partial DB stays registered) and the teardown count.
 *   - migration-<=120s-via-confirm: removing the confirm gate flips
 *     consent-consulted + the classifier-tag assertion; over-budget flips the
 *     duration / MIGRATION_TIMEOUT assertions.
 *   - failure/denied-no-partial-schema: applying anyway flips the applied-schema
 *     side-effect + schemaVersion == prior assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createDatabaseProvisioner,
  createBackendScaffolder,
  createSchemaMigrator,
  guardBackendSecrets,
  DEFAULT_DB_PROVISION_TIMEOUT_MS,
  DEFAULT_MIGRATION_TIMEOUT_MS,
} from '../src/sandbox/database-service.js';
import { createCommandGuard, DEFAULT_CONFIRM_TIMEOUT_MS } from '../src/sandbox/command-guard.js';
import { createDatabaseService } from '../src/model/database-service.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import { createTemplateProvider } from '../src/project/templates.js';
import { classifyCommand } from '../src/engine/plumby.js';

// ---------------------------------------------------------------- harness

const PROJECT_ID = 'proj-fullstack-int';
// A concrete, real-world migration command the REAL classifier gates as
// db-migration -> confirm (asserted below, never stubbed).
const MIGRATION_COMMAND = 'npx prisma migrate deploy';

/**
 * A MANUALLY-ADVANCED ms clock: reads return the current value; the harness
 * advances it by a scripted per-command duration on every exec. This single
 * counter is the seam ALL timing SLOs (60s provisioning, 120s migration) are
 * measured against — NO real wall-clock wait.
 */
function manualClock({ start = 0 } = {}) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  return now;
}

/**
 * The ONE fake seam: a shared in-Sandbox boundary standing in for
 * SandboxManager.exec + the provisioner teardown. It composes with a manual
 * clock and REAL side-effect registries so "no partial DB" / "the DB seam
 * applied nothing" are meaningful integration assertions, not trivially true.
 *
 * @param {object} args
 * @param {Function} args.clock            the manual clock (advanced per command)
 * @param {(command:string)=>object} args.script  maps a command string to
 *        { result, durationMs } where `result` is merged over the REAL exec
 *        contract and durationMs is how far to advance the injected clock.
 */
function boundary({ clock, script }) {
  const calls = [];
  // REAL side-effect registries the real objects mutate through this seam.
  const liveDatabases = new Map(); // id -> record (a "provisioned but live" DB)
  const appliedSchema = { version: null };

  const exec = async (projectId, command, execOpts) => {
    const commandString = Array.isArray(command) ? command.join(' ') : command;
    calls.push({ projectId, command: commandString, opts: execOpts });
    const plan = script(commandString) ?? {};
    const durationMs = typeof plan.durationMs === 'number' ? plan.durationMs : 0;
    // Advance the SINGLE injected clock — this is the only "time" that passes.
    if (durationMs > 0) clock.advance(durationMs);

    const contract = {
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
      ...(plan.result ?? {}),
    };

    const succeeded =
      contract.exitCode === 0 && contract.denied !== true && contract.timedOut !== true;

    // REAL side effects, keyed off the command surface + genuine success:
    if (/db-provision/.test(commandString) && succeeded) {
      // A DB was brought up and is now LIVE. teardown must remove it.
      const m = commandString.match(/--id\s+(\S+)/);
      liveDatabases.set(m ? m[1] : 'db', { command: commandString });
    }
    if (/(prisma|db:migrate|db-migrate|migrate)/.test(commandString) && succeeded) {
      appliedSchema.version = plan.appliedVersionSideEffect ?? '20260101_init';
    }
    return Object.freeze(contract);
  };

  return { calls, liveDatabases, appliedSchema, exec };
}

/** A manager façade over the boundary that also feeds the teardown seam. */
function harness({ clock, script }) {
  const b = boundary({ clock, script });
  const manager = { exec: b.exec };
  // A teardown seam that produces a REAL side effect: it removes the live DB
  // from the registry, so "no active partial DB" is asserted against real state.
  const teardownCalls = [];
  const teardown = async ({ database }) => {
    teardownCalls.push(database?.id ?? null);
    if (database?.id) b.liveDatabases.delete(database.id);
    // best-effort: also drive a teardown command through the boundary
    await b.exec(PROJECT_ID, `db-teardown --id ${database?.id ?? ''}`, { timeoutMs: 1 });
  };
  return { ...b, manager, teardown, teardownCalls };
}

/** A fresh tmp StorageLayout + a real SecretStore. */
function freshStore(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-dbsvc-int-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const layout = createStorageLayout(baseDir);
  const store = createSecretStore({ layout });
  return { baseDir, layout, store };
}

/** A ready Database_Service record with the given prior schema version. */
function readyDb(schemaVersion = null) {
  return createDatabaseService({
    id: 'db-int',
    projectId: PROJECT_ID,
    status: 'ready',
    engine: 'postgres',
    schemaVersion: schemaVersion ?? undefined,
    createdAt: '2026-01-02T03:04:05.000Z',
  });
}

// =========================================================== (1) DB ready <=60s BEFORE scaffolding completes (Req 9.2)

test('INTEGRATION DB ready <=60s BEFORE scaffolding completes (Req 9.2): real scaffolder+provisioner, one boundary seam, injected clock', async (t) => {
  const clock = manualClock();
  // Endpoint probe takes 5s, DB bring-up 40s -> total 45s, well within the 60s
  // ceiling and both measured on the SINGLE injected clock.
  const h = harness({
    clock,
    script: (command) => {
      if (/http-probe/.test(command)) return { result: { exitCode: 0 }, durationMs: 5_000 };
      if (/db-provision/.test(command)) return { result: { exitCode: 0 }, durationMs: 40_000 };
      return { result: { exitCode: 0 }, durationMs: 0 };
    },
  });

  const provisioner = createDatabaseProvisioner({
    manager: h.manager,
    teardown: h.teardown,
    now: clock,
    newId: () => 'db-int-ready',
  });
  const scaffolder = createBackendScaffolder({
    provisioner,
    manager: h.manager,
    templateProvider: createTemplateProvider(),
    now: clock,
  });

  const res = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'full-stack-web' });

  // Scaffolding is complete ONLY after the DB reports ready.
  assert.equal(res.ok, true);
  assert.equal(res.complete, true);
  assert.equal(res.endpointStatusOk, true);
  assert.equal(res.database.status, 'ready', 'DB reported READY before scaffolding-complete (flips if reported early)');

  // TIMING: the DB provisioning duration is measured on the injected clock and
  // is <= 60_000ms (Req 9.2). Flips if the bring-up runs over budget.
  assert.equal(res.durationMs, 40_000, 'provisioning duration measured on the injected clock');
  assert.ok(res.durationMs <= DEFAULT_DB_PROVISION_TIMEOUT_MS, 'DB ready within the 60s ceiling');

  // ORDERING: the endpoint probe ran BEFORE the DB bring-up, and the DB was
  // reported ready before scaffolding returned complete (Req 9.1 before 9.2).
  assert.match(h.calls[0].command, /http-probe/, 'endpoint reachability probed first');
  assert.match(h.calls[1].command, /db-provision/, 'DB provisioned after the endpoint check');
  assert.equal(h.calls[1].opts.timeoutMs, DEFAULT_DB_PROVISION_TIMEOUT_MS, '60s ceiling threaded to exec');

  // The DB is LIVE (registered by the real boundary side effect) and NOT torn
  // down on the success path.
  assert.equal(h.liveDatabases.size, 1, 'the provisioned DB is live on success');
  assert.equal(h.teardownCalls.length, 0, 'no teardown on the success path');
});

// =========================================================== (2) >60s provisioning -> timeout, no active partial DB (Req 9.3)

test('INTEGRATION >60s provisioning -> DB_PROVISION_TIMEOUT, scaffolding incomplete, no active partial DB (Req 9.3)', async (t) => {
  const clock = manualClock();
  // Endpoint OK (5s); DB bring-up hits the boundary wall-clock reaper at the 60s
  // ceiling: the injected clock advances by 60_000ms and exec returns the REAL
  // timeout contract. NO real waiting.
  const h = harness({
    clock,
    script: (command) => {
      if (/http-probe/.test(command)) return { result: { exitCode: 0 }, durationMs: 5_000 };
      if (/db-provision/.test(command)) {
        return {
          result: { exitCode: null, denied: true, deniedReason: 'timeout', timedOut: true, stderr: 'still initializing at kill' },
          durationMs: DEFAULT_DB_PROVISION_TIMEOUT_MS,
        };
      }
      return { result: { exitCode: 0 }, durationMs: 0 };
    },
  });

  const provisioner = createDatabaseProvisioner({
    manager: h.manager,
    teardown: h.teardown,
    now: clock,
    newId: () => 'db-int-timeout',
  });
  const scaffolder = createBackendScaffolder({
    provisioner,
    manager: h.manager,
    templateProvider: createTemplateProvider(),
    now: clock,
  });

  const res = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'full-stack-web' });

  // Scaffolding is INCOMPLETE and the cause is the DB provisioning timeout.
  assert.equal(res.ok, false);
  assert.equal(res.complete, false, 'scaffolding is incomplete when the DB does not come up');
  assert.equal(res.code, 'DB_PROVISION_TIMEOUT');
  assert.equal(res.endpointStatusOk, true, 'the endpoint was reachable; only the DB failed');
  // TIMING measured on the SINGLE injected clock: probe (5s) + bring-up hitting
  // the 60s ceiling. The clock advanced exactly to 65_000ms (no real waiting),
  // and the boundary reaper fired at the 60s ceiling threaded to exec.
  assert.equal(clock(), 65_000, 'total elapsed measured on the injected clock (no real wait)');
  assert.equal(h.calls[1].opts.timeoutMs, DEFAULT_DB_PROVISION_TIMEOUT_MS, '60s ceiling threaded to the DB bring-up exec');

  // NO active partial DB (Req 9.3): the teardown seam ran and removed the DB from
  // the live registry; the returned record status is 'torn-down'. Both flip if
  // the teardown-in-failResult rollback is reverted (a partial DB stays live).
  assert.equal(res.tornDown, true);
  assert.equal(res.database.status, 'torn-down', 'no active partial DB record survives');
  assert.equal(h.teardownCalls.length, 1, 'the partial DB was reaped exactly once');
  assert.equal(h.liveDatabases.size, 0, 'no partial DB remains live after teardown');
});

// =========================================================== (3) provisioning failure -> teardown, no active DB (Req 9.3)

test('INTEGRATION provisioning failure -> DB_PROVISION_FAILED, teardown invoked, no active DB (Req 9.3)', async (t) => {
  const clock = manualClock();
  const h = harness({
    clock,
    script: (command) => {
      if (/http-probe/.test(command)) return { result: { exitCode: 0 }, durationMs: 2_000 };
      if (/db-provision/.test(command)) {
        return { result: { exitCode: 1, denied: false, stderr: 'FATAL: could not initialize cluster' }, durationMs: 8_000 };
      }
      return { result: { exitCode: 0 }, durationMs: 0 };
    },
  });

  const provisioner = createDatabaseProvisioner({
    manager: h.manager,
    teardown: h.teardown,
    now: clock,
    newId: () => 'db-int-fail',
  });
  const scaffolder = createBackendScaffolder({
    provisioner,
    manager: h.manager,
    templateProvider: createTemplateProvider(),
    now: clock,
  });

  const res = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'multi-target' });

  assert.equal(res.ok, false);
  assert.equal(res.complete, false);
  assert.equal(res.code, 'DB_PROVISION_FAILED');
  assert.equal(res.tornDown, true);
  assert.equal(res.database.status, 'torn-down');
  // No active partial DB: teardown ran and the live registry is empty. Flips if
  // the teardown rollback is removed.
  assert.equal(h.teardownCalls.length, 1, 'teardown reaped the failed DB');
  assert.equal(h.liveDatabases.size, 0, 'no active DB after a failed provisioning');
});

// =========================================================== (4) migration <=120s via the REAL confirm path (Req 9.4)

test('INTEGRATION migration <=120s via the REAL confirm path (Req 9.4): real guard+classifier+migrator, injected clock', async (t) => {
  const clock = manualClock();
  // The migration executes (consent granted) in 90s -> within the 120s ceiling,
  // measured on the injected clock.
  const h = harness({
    clock,
    script: (command) => {
      if (/prisma|db:migrate|db-migrate|migrate/.test(command)) {
        return {
          result: { exitCode: 0, stdout: 'Applied migration\napplied_version: 20260501_add_orders' },
          durationMs: 90_000,
          appliedVersionSideEffect: '20260501_add_orders',
        };
      }
      return { result: { exitCode: 0 }, durationMs: 0 };
    },
  });

  // The REAL classifier gates this command — asserted directly so the whole
  // confirm path rests on a REAL (un-stubbed) fact.
  const mig = classifyCommand(MIGRATION_COMMAND);
  assert.equal(mig.outcome, 'confirm');
  assert.equal(mig.category, 'db-migration');

  const consentRequests = [];
  const guard = createCommandGuard({
    manager: h.manager,
    onConfirmRequest: (req) => {
      consentRequests.push(req);
      return true; // grant
    },
  });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: clock });

  const res = await migrator.migrate({ projectId: PROJECT_ID, database: readyDb(null), command: MIGRATION_COMMAND });

  assert.equal(res.ok, true);
  assert.equal(res.appliedVersion, '20260501_add_orders', 'the applied version is reported (Req 9.4)');
  assert.equal(res.database.schemaVersion, '20260501_add_orders', 'Database_Service.schemaVersion updated');

  // TIMING: measured on the injected clock, within the 120s ceiling. Flips if the
  // migration runs over budget (see the timeout case below).
  assert.equal(res.durationMs, 90_000, 'migration duration measured on the injected clock');
  assert.ok(res.durationMs <= DEFAULT_MIGRATION_TIMEOUT_MS, 'migration applied within the 120s ceiling');

  // Routed THROUGH the REAL confirm gate: the guard consulted the consent seam
  // (only because the REAL classifier tagged it db-migration/confirm), THEN exec
  // ran once with the 120s ceiling threaded down. Removing the confirm-gating
  // flips consent-consulted + the category assertion.
  assert.equal(consentRequests.length, 1, 'the confirm gate was consulted (confirm-class)');
  assert.equal(consentRequests[0].category, 'db-migration');
  assert.equal(h.calls.length, 1, 'the migration executed exactly once');
  assert.equal(h.calls[0].opts.timeoutMs, DEFAULT_MIGRATION_TIMEOUT_MS, '120s MIGRATION ceiling threaded to exec');
  // REAL side effect: the schema was applied inside the box.
  assert.equal(h.appliedSchema.version, '20260501_add_orders', 'the DB seam applied the schema');

  // The 120s migration ceiling is DISTINCT from the guard's 60s consent ceiling.
  assert.notEqual(DEFAULT_MIGRATION_TIMEOUT_MS, DEFAULT_CONFIRM_TIMEOUT_MS);
  assert.equal(DEFAULT_MIGRATION_TIMEOUT_MS, 120_000);
  assert.equal(DEFAULT_CONFIRM_TIMEOUT_MS, 60_000);
});

// =========================================================== (5) >120s migration -> timeout, prior schema intact (Req 9.5)

test('INTEGRATION >120s migration -> MIGRATION_TIMEOUT via the injected clock, prior schema intact (Req 9.5)', async (t) => {
  const clock = manualClock();
  // The boundary wall-clock reaper fires at the 120s ceiling; the injected clock
  // advances by 120_000ms and exec returns the REAL timeout contract.
  const h = harness({
    clock,
    script: (command) => {
      if (/prisma|db:migrate|db-migrate|migrate/.test(command)) {
        return {
          result: { exitCode: null, denied: true, deniedReason: 'timeout', timedOut: true, stderr: 'killed at ceiling' },
          durationMs: DEFAULT_MIGRATION_TIMEOUT_MS,
        };
      }
      return { result: { exitCode: 0 }, durationMs: 0 };
    },
  });
  const guard = createCommandGuard({ manager: h.manager, onConfirmRequest: () => true });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: clock });

  const prior = readyDb('20250101_base');
  const res = await migrator.migrate({ projectId: PROJECT_ID, database: prior, command: MIGRATION_COMMAND });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'MIGRATION_TIMEOUT');
  assert.equal(res.durationMs, DEFAULT_MIGRATION_TIMEOUT_MS, 'timeout measured on the injected clock');
  assert.equal(h.calls[0].opts.timeoutMs, DEFAULT_MIGRATION_TIMEOUT_MS, '120s ceiling threaded to exec');
  // Prior schema intact, no partial change (Req 9.5). Flips if the migrator
  // updates schemaVersion on a timeout.
  assert.equal(h.appliedSchema.version, null, 'the DB seam applied nothing on timeout');
  assert.equal(res.database.schemaVersion, '20250101_base', 'prior schema left in effect');
  assert.equal(res.priorSchemaVersion, '20250101_base');
});

// =========================================================== (6) migration failure -> prior schema intact (Req 9.5)

test('INTEGRATION migration failure (non-zero exit) -> MIGRATION_FAILED, prior schema intact (Req 9.5)', async (t) => {
  const clock = manualClock();
  const h = harness({
    clock,
    script: (command) => {
      if (/prisma|db:migrate|db-migrate|migrate/.test(command)) {
        return { result: { exitCode: 1, denied: false, stderr: 'ERROR: relation exists; aborted' }, durationMs: 12_000 };
      }
      return { result: { exitCode: 0 }, durationMs: 0 };
    },
  });
  const guard = createCommandGuard({ manager: h.manager, onConfirmRequest: () => true });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: clock });

  const res = await migrator.migrate({ projectId: PROJECT_ID, database: readyDb('20250101_base'), command: MIGRATION_COMMAND });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'MIGRATION_FAILED');
  assert.equal(res.exitCode, 1);
  assert.equal(h.calls.length, 1, 'the migration executed (consent granted) but failed');
  // Prior schema intact: the side effect only fires on exit 0, so the applied
  // schema record is untouched and schemaVersion == prior. Flips if applied anyway.
  assert.equal(h.appliedSchema.version, null, 'the DB seam applied nothing on failure');
  assert.equal(res.database.schemaVersion, '20250101_base', 'prior schema intact, no partial change');
});

// =========================================================== (7) confirm DENIED -> prior schema intact, never executed (Req 9.5)

test('INTEGRATION confirm DENIED via the REAL guard -> MIGRATION_CONFIRM_DENIED, exec never ran, prior schema intact (Req 9.5)', async (t) => {
  const clock = manualClock();
  const h = harness({
    clock,
    // If exec were (wrongly) reached it would succeed — so exec-count 0 is a real
    // proof the confirm gate blocked it, not a trivially-failing command.
    script: () => ({ result: { exitCode: 0 }, durationMs: 30_000 }),
  });
  const consentRequests = [];
  const guard = createCommandGuard({
    manager: h.manager,
    onConfirmRequest: (req) => {
      consentRequests.push(req);
      return false; // deny
    },
  });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: clock });

  const res = await migrator.migrate({ projectId: PROJECT_ID, database: readyDb('20250101_base'), command: MIGRATION_COMMAND });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'MIGRATION_CONFIRM_DENIED');
  assert.equal(res.outcome, 'confirm', 'the classifier answered confirm; the denial is the consent gate');
  // Routed THROUGH the gate (consent consulted) but NEVER executed. Removing the
  // confirm-gating flips exec-count (would be 1) and the schemaVersion assertion.
  assert.equal(consentRequests.length, 1, 'the confirm gate was consulted');
  assert.equal(h.calls.length, 0, 'the migration never executed (confirm denied)');
  assert.equal(h.appliedSchema.version, null, 'the DB seam applied nothing');
  assert.equal(res.database.schemaVersion, '20250101_base', 'prior schema left in effect, no partial change');
});

// =========================================================== (8) end-to-end: provision -> guard secrets -> migrate, no literal secret committed (Property 8 + Req 9.2/9.4)

test('INTEGRATION end-to-end full-stack lifecycle: DB ready -> Property-8 guarded source on disk -> migration applied via confirm path', async (t) => {
  const { store, layout } = freshStore(t);
  const clock = manualClock();

  // A real Secret (a DB connection string) put into the REAL SecretStore; the
  // value lives out-of-tree and is injected at runtime via envForProject (Req 9.6).
  const SECRET_NAME = 'DATABASE_URL';
  const SECRET_VALUE = 'postgres://admin:sup3r-s3cret@db.internal:5432/app';
  store.put(PROJECT_ID, SECRET_NAME, SECRET_VALUE);
  const env = store.envForProject(PROJECT_ID);

  const h = harness({
    clock,
    script: (command) => {
      if (/http-probe/.test(command)) return { result: { exitCode: 0 }, durationMs: 3_000 };
      if (/db-provision/.test(command)) return { result: { exitCode: 0 }, durationMs: 20_000 };
      if (/prisma|db:migrate|db-migrate|migrate/.test(command)) {
        return {
          result: { exitCode: 0, stdout: 'applied_version: 20260601_init' },
          durationMs: 45_000,
          appliedVersionSideEffect: '20260601_init',
        };
      }
      return { result: { exitCode: 0 }, durationMs: 0 };
    },
  });

  // 1) Provision + scaffold: DB ready within 60s, before scaffolding completes.
  const provisioner = createDatabaseProvisioner({
    manager: h.manager,
    teardown: h.teardown,
    now: clock,
    newId: () => 'db-int-e2e',
  });
  const scaffolder = createBackendScaffolder({
    provisioner,
    manager: h.manager,
    templateProvider: createTemplateProvider(),
    now: clock,
  });
  const scaffold = await scaffolder.scaffoldBackend({ projectId: PROJECT_ID, targetCategory: 'full-stack-web' });
  assert.equal(scaffold.complete, true);
  assert.equal(scaffold.database.status, 'ready');
  assert.ok(scaffold.durationMs <= DEFAULT_DB_PROVISION_TIMEOUT_MS);

  // 2) Property 8: generated backend/DB source that naively embeds the literal
  // secret is run through the REAL guardrail and written to the REAL export tree;
  // no committed file contains the literal (grep the on-disk tree).
  const generated = {
    'backend/db.js':
      `// generated DB client\n` +
      `export const connectionString = '${SECRET_VALUE}';\n` +
      `export function connect() { return connectionString; }\n`,
  };
  const { files, report } = guardBackendSecrets({ files: generated, secrets: env });
  assert.equal(files['backend/db.js'].includes(SECRET_VALUE), false, 'literal secret rewritten out of the source');
  assert.match(files['backend/db.js'], /process\.env\.DATABASE_URL/, 'secret rewritten to an env-var reference');
  assert.equal(report.some((r) => r.name === SECRET_NAME), true);

  const treeRoot = layout.exportableProjectTree(PROJECT_ID);
  assert.equal(layout.isInsideExportTree(treeRoot), true);
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(treeRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
  const onDisk = fs.readFileSync(path.join(treeRoot, 'backend', 'db.js'), 'utf8');
  assert.equal(onDisk.includes(SECRET_VALUE), false, 'no committed backend source contains the literal secret (Property 8)');

  // 3) Migrate the now-ready DB via the REAL confirm path within 120s.
  const consentRequests = [];
  const guard = createCommandGuard({
    manager: h.manager,
    onConfirmRequest: (req) => {
      consentRequests.push(req);
      return true;
    },
  });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: clock });
  const migrated = await migrator.migrate({ projectId: PROJECT_ID, database: scaffold.database, command: MIGRATION_COMMAND });

  assert.equal(migrated.ok, true);
  assert.equal(migrated.appliedVersion, '20260601_init');
  assert.equal(migrated.database.schemaVersion, '20260601_init', 'schemaVersion updated after a confirmed migration');
  assert.ok(migrated.durationMs <= DEFAULT_MIGRATION_TIMEOUT_MS, 'migration within the 120s ceiling');
  // The migration routed through the REAL confirm gate (consent consulted,
  // classifier tagged db-migration).
  assert.equal(consentRequests.length, 1);
  assert.equal(consentRequests[0].category, 'db-migration');
});
