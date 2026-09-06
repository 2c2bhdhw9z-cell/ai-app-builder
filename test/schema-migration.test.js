/**
 * Schema_Migration tests (node --test) — spec Task 20.2, Req 9.4, 9.5.
 *
 * The Schema Migrator (createSchemaMigrator in src/sandbox/database-service.js)
 * is the thin COMPOSING layer that applies a database migration to a
 * Database_Service ONLY through the confirm-gated command path, within a 120s
 * ceiling, reporting the applied version on success and leaving the PRIOR schema
 * in effect with NO partial changes on any non-success. These tests follow the
 * repo's testing discipline and exercise REAL collaborators — they do NOT stub
 * the very gate under test:
 *
 *   - a REAL CommandGuard (createCommandGuard from src/sandbox/command-guard.js)
 *     driven by the REAL plumby classifier (classifyCommand re-exported through
 *     THE plumby boundary at src/engine/plumby.js — NOT stubbed). So
 *     'npx prisma migrate deploy' / 'rake db:migrate' genuinely classify
 *     `db-migration` -> confirm and are gated, while a plain 'ls' classifies
 *     `allow` and is NOT gated (asserted directly against the real classifier);
 *   - a FAKE SandboxManager `manager` implementing ONLY exec(projectId, command,
 *     {timeoutMs, signal}) and returning the REAL exec contract shape (see
 *     src/sandbox/sandbox-manager.js: { stdout, stderr, exitCode:number|null,
 *     denied, deniedReason:'launch-failure'|'timeout'|null, timedOut, signal,
 *     projectId, ... }). The fake is a spy so we can assert exec CALL COUNTS and
 *     the exact opts (timeoutMs) threaded down, AND it carries a REAL side effect
 *     (it flips an in-memory "applied schema" record) so "the DB seam applied
 *     nothing" on a denied/failed path is a meaningful assertion, not trivially
 *     true;
 *   - a REAL Database_Service model (createDatabaseService) — the record's
 *     schemaVersion transitions are asserted against the real factory;
 *   - an INJECTED clock (a `now` counter) driving the 120s ceiling — NEVER real
 *     waiting.
 *
 * MUTATION SENSITIVITY (which assertion flips if the behavior is reverted):
 *   - routes-through-confirm-gate: the CONFIRM-GRANTED and CONFIRM-DENIED tests
 *     drive the migration through the REAL guard; the guard only emits a
 *     confirm_request (and consults the consent seam) because the REAL classifier
 *     tagged the command `db-migration`/confirm. A companion assertion checks the
 *     classifier directly: the migration command classifies confirm/db-migration
 *     and 'ls' classifies allow. If the migrator stopped routing through the
 *     confirm gate (e.g. ran exec directly), the DENIED test's exec-not-called
 *     assertion + the consent-seam-was-consulted assertion flip.
 *   - success-updates-version: the CONFIRM-GRANTED test asserts ok:true, the
 *     applied version is reported, exec ran exactly once with timeoutMs === 120s,
 *     and database.schemaVersion is updated. Reverting the schemaVersion update
 *     flips database.schemaVersion.
 *   - confirm-denied-no-partial-change: the CONFIRM-DENIED test denies consent
 *     through the real guard; asserts code 'MIGRATION_CONFIRM_DENIED', exec was
 *     NEVER called (spy count 0), the in-memory applied-schema record is
 *     unchanged, and database.schemaVersion equals the PRIOR version. Removing
 *     the confirm-gating (or applying anyway) flips exec-count and schemaVersion.
 *   - failure-no-partial-change: the FAILURE test's fake exec returns a non-zero
 *     exit; asserts code 'MIGRATION_FAILED' and schemaVersion == prior (untouched).
 *   - timeout-via-injected-clock: the TIMEOUT test uses an injected `now` counter
 *     past 120s and a fake exec returning the boundary timeout contract; asserts
 *     migrationTimeoutMs threaded as opts.timeoutMs (=== 120s), code
 *     'MIGRATION_TIMEOUT', durationMs === 120s, schemaVersion == prior.
 *   - two-timeout-distinction: asserts DEFAULT_MIGRATION_TIMEOUT_MS === 120_000
 *     and that it differs from the guard's DEFAULT_CONFIRM_TIMEOUT_MS (60_000).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSchemaMigrator,
  DEFAULT_MIGRATION_TIMEOUT_MS,
} from '../src/sandbox/database-service.js';
import {
  createCommandGuard,
  DEFAULT_CONFIRM_TIMEOUT_MS,
} from '../src/sandbox/command-guard.js';
import { createDatabaseService } from '../src/model/database-service.js';
import { classifyCommand } from '../src/engine/plumby.js';

// ---------------------------------------------------------------- fakes/helpers

const PROJECT_ID = 'proj-migrate-1';
// A concrete, real-world migration command the REAL classifier gates as
// db-migration -> confirm. 'rake db:migrate' is an alternative; both are used.
const MIGRATION_COMMAND = 'npx prisma migrate deploy';

/**
 * A FAKE SandboxManager exposing ONLY exec(projectId, command, {timeoutMs,
 * signal}). It is a spy recording every call (so we can assert COUNT + the exact
 * opts threaded down) and returns the REAL exec contract shape. `result` is
 * merged over the contract defaults so a test can model exit 0 (success), a
 * non-zero exit (the migration tool's OWN failure), or the boundary TIMEOUT
 * contract. `appliedSchema` is a REAL side-effect record: exec MUTATES it only on
 * a successful (exit 0) run — so "the DB seam applied nothing" on a denied/failed
 * path is a genuine assertion (the record stays at its prior value).
 */
function fakeManager(result = {}, appliedSchema) {
  const calls = [];
  return {
    calls,
    exec: async (projectId, command, execOpts) => {
      calls.push({ projectId, command, opts: execOpts });
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
        ...result,
      };
      // REAL side effect: apply the schema ONLY when the run genuinely succeeds
      // inside the box (exit 0, not denied, not timed out).
      if (appliedSchema && contract.exitCode === 0 && contract.denied !== true && contract.timedOut !== true) {
        appliedSchema.version = result.appliedVersionSideEffect ?? '20260101_init';
      }
      return Object.freeze(contract);
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

/** A fresh Database_Service record with the given prior schema version. */
function dbRecord(schemaVersion = null) {
  return createDatabaseService({
    id: 'db-migrate',
    projectId: PROJECT_ID,
    status: 'ready',
    engine: 'postgres',
    schemaVersion: schemaVersion ?? undefined,
    createdAt: '2026-01-02T03:04:05.000Z',
  });
}

// ================================================================ classifier sanity (routes through the confirm gate)

test('CLASSIFIER (Req 9.4): the REAL plumby classifier tags the migration db-migration/confirm and a plain command allow', () => {
  // This is the load-bearing fact the whole confirm-gating rests on: the REAL
  // classifier (NOT stubbed) gates migrations. If this flips, the confirm path
  // below is not actually a confirm path.
  const mig = classifyCommand(MIGRATION_COMMAND);
  assert.equal(mig.outcome, 'confirm');
  assert.equal(mig.category, 'db-migration');

  const rake = classifyCommand('rake db:migrate');
  assert.equal(rake.outcome, 'confirm');
  assert.equal(rake.category, 'db-migration');

  // A plain, non-migration command is NOT gated (allow) — so the gating is
  // specific to migrations, not blanket.
  const ls = classifyCommand('ls');
  assert.equal(ls.outcome, 'allow');
});

// ================================================================ (a) confirm GRANTED + exit 0 within 120s -> ok:true

test('MIGRATION SUCCESS (Req 9.4): consent granted + exit 0 within 120s -> ok:true, applied version reported, schemaVersion updated', async () => {
  const applied = { version: null };
  const manager = fakeManager({ exitCode: 0, stdout: 'Applied migration\napplied_version: 20260201_add_users' }, applied);
  // A REAL CommandGuard driven by the REAL classifier; consent GRANTED via the
  // seam only reached because the classifier said `confirm`.
  const consentRequests = [];
  const guard = createCommandGuard({
    manager,
    onConfirmRequest: (req) => {
      consentRequests.push(req);
      return true; // grant
    },
  });
  const migrator = createSchemaMigrator({
    commandGuard: guard,
    // now() ticks: [startedAt, finishedAt] -> 30s migration within 120s.
    now: fakeClock([0, 30_000]),
  });

  const res = await migrator.migrate({ projectId: PROJECT_ID, database: dbRecord(null), command: MIGRATION_COMMAND });

  assert.equal(res.ok, true);
  assert.equal(res.appliedVersion, '20260201_add_users', 'the applied schema version is reported (Req 9.4)');
  assert.equal(res.durationMs, 30_000, 'durationMs derived from the injected clock');
  assert.equal(res.database.schemaVersion, '20260201_add_users', 'Database_Service.schemaVersion is updated');

  // The migration routed THROUGH the confirm gate: the guard consulted the
  // consent seam (only because the REAL classifier tagged it confirm), THEN exec
  // ran once with the 120s ceiling threaded down.
  assert.equal(consentRequests.length, 1, 'the confirm gate was consulted (confirm-class)');
  assert.equal(consentRequests[0].category, 'db-migration');
  assert.equal(manager.calls.length, 1, 'the migration executed exactly once');
  assert.equal(manager.calls[0].opts.timeoutMs, DEFAULT_MIGRATION_TIMEOUT_MS, '120s MIGRATION ceiling threaded to exec');
  // REAL side effect confirms the schema was applied inside the box.
  assert.equal(applied.version, '20260101_init');
});

test('MIGRATION SUCCESS declared version (Req 9.4): a caller-declared version is reported when output has none', async () => {
  const manager = fakeManager({ exitCode: 0, stdout: 'ok' });
  const guard = createCommandGuard({ manager, onConfirmRequest: () => true });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: fakeClock([0, 1_000]) });

  const res = await migrator.migrate({
    projectId: PROJECT_ID,
    database: dbRecord('20250101_base'),
    command: 'rake db:migrate',
    version: '20260301_orders',
  });
  assert.equal(res.ok, true);
  assert.equal(res.appliedVersion, '20260301_orders');
  assert.equal(res.database.schemaVersion, '20260301_orders');
});

// ================================================================ (b) confirm DENIED -> no partial change

test('MIGRATION CONFIRM-DENIED (Req 9.5): consent denied -> MIGRATION_CONFIRM_DENIED, exec NOT applied, prior schema unchanged', async () => {
  const applied = { version: 'prior-applied' };
  const manager = fakeManager({ exitCode: 0 }, applied);
  // A REAL CommandGuard; consent DENIED via the seam. Because the REAL classifier
  // said `confirm`, the guard consults the seam and (deny) never calls exec.
  const consentRequests = [];
  const guard = createCommandGuard({
    manager,
    onConfirmRequest: (req) => {
      consentRequests.push(req);
      return false; // deny
    },
  });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: fakeClock([0, 2_000]) });

  const prior = dbRecord('20250101_base');
  const res = await migrator.migrate({ projectId: PROJECT_ID, database: prior, command: MIGRATION_COMMAND });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'MIGRATION_CONFIRM_DENIED');
  assert.equal(res.outcome, 'confirm', 'the classifier answered confirm; the denial is the consent gate');
  // The confirm gate WAS consulted (proves it routed through the gate), but the
  // migration NEVER executed: exec spy count 0.
  assert.equal(consentRequests.length, 1, 'the confirm gate was consulted');
  assert.equal(manager.calls.length, 0, 'the migration never executed (confirm denied)');
  // No partial change: the DB seam applied nothing, and schemaVersion is the
  // PRIOR version, untouched (Req 9.5). Flips if the migrator applied anyway.
  assert.equal(applied.version, 'prior-applied', 'the DB seam applied nothing');
  assert.equal(res.database.schemaVersion, '20250101_base', 'prior schema left in effect, no partial change');
  assert.equal(res.priorSchemaVersion, '20250101_base');
});

// ================================================================ (c) FAILURE (non-zero exit) -> no partial change

test('MIGRATION FAILED (Req 9.5): migration executes but non-zero exit -> MIGRATION_FAILED, prior schema intact', async () => {
  const applied = { version: 'prior-applied' };
  // The command executed inside the box but the migration tool failed
  // (denied:false, non-zero exit). A transactional tool rolls back, so no
  // partial schema change; exec's side effect only fires on exit 0, so the
  // applied-schema record stays at prior.
  const manager = fakeManager({ exitCode: 1, denied: false, stderr: 'ERROR: relation exists; migration aborted' }, applied);
  const guard = createCommandGuard({ manager, onConfirmRequest: () => true });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: fakeClock([0, 4_000]) });

  const res = await migrator.migrate({ projectId: PROJECT_ID, database: dbRecord('20250101_base'), command: MIGRATION_COMMAND });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'MIGRATION_FAILED');
  assert.equal(res.exitCode, 1);
  assert.match(res.message, /prior schema/);
  assert.equal(manager.calls.length, 1, 'the migration executed (consent granted) but failed');
  assert.equal(applied.version, 'prior-applied', 'the DB seam applied nothing on failure');
  assert.equal(res.database.schemaVersion, '20250101_base', 'prior schema intact, no partial change');
});

// ================================================================ (d) TIMEOUT via injected clock -> no partial change

test('MIGRATION TIMEOUT (Req 9.5): exceeds the 120s ceiling via INJECTED clock -> MIGRATION_TIMEOUT, prior schema intact', async () => {
  const applied = { version: 'prior-applied' };
  // The boundary's wall-clock reaper fired at the ceiling: exitCode null, denied
  // true, deniedReason 'timeout', timedOut true — NO real waiting.
  const manager = fakeManager(
    { exitCode: null, denied: true, deniedReason: 'timeout', timedOut: true, stderr: 'killed at ceiling' },
    applied,
  );
  const guard = createCommandGuard({ manager, onConfirmRequest: () => true });
  const migrator = createSchemaMigrator({
    commandGuard: guard,
    // now() ticks: [startedAt, finishedAt] -> derives durationMs=120000.
    now: fakeClock([0, DEFAULT_MIGRATION_TIMEOUT_MS]),
  });

  const res = await migrator.migrate({ projectId: PROJECT_ID, database: dbRecord('20250101_base'), command: MIGRATION_COMMAND });

  // The 120s MIGRATION ceiling was threaded as opts.timeoutMs into exec.
  assert.equal(manager.calls.length, 1);
  assert.equal(manager.calls[0].opts.timeoutMs, DEFAULT_MIGRATION_TIMEOUT_MS);

  assert.equal(res.ok, false);
  assert.equal(res.code, 'MIGRATION_TIMEOUT');
  assert.equal(res.durationMs, DEFAULT_MIGRATION_TIMEOUT_MS, 'durationMs derived from the injected clock');
  assert.match(res.message, /ceiling/);
  assert.equal(applied.version, 'prior-applied', 'the DB seam applied nothing on timeout');
  assert.equal(res.database.schemaVersion, '20250101_base', 'prior schema intact, no partial change');
});

// ================================================================ REFUSE / could-not-classify -> never apply

test('MIGRATION REFUSED (Req 9.5): a refuse-class command never applies the migration; prior schema in effect', async () => {
  const applied = { version: 'prior-applied' };
  const manager = fakeManager({ exitCode: 0 }, applied);
  const guard = createCommandGuard({ manager, onConfirmRequest: () => true });
  const migrator = createSchemaMigrator({ commandGuard: guard, now: fakeClock([0, 1_000]) });

  // A genuinely destructive command the REAL classifier REFUSES — never runs.
  const refused = classifyCommand('rm -rf / --no-preserve-root');
  assert.equal(refused.outcome, 'refuse', 'sanity: the REAL classifier refuses this');

  const res = await migrator.migrate({
    projectId: PROJECT_ID,
    database: dbRecord('20250101_base'),
    command: 'rm -rf / --no-preserve-root',
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'MIGRATION_REFUSED');
  assert.equal(manager.calls.length, 0, 'a refused command never reaches exec');
  assert.equal(applied.version, 'prior-applied', 'the DB seam applied nothing');
  assert.equal(res.database.schemaVersion, '20250101_base', 'prior schema left in effect');
});

// ================================================================ two-timeout distinction

test('TWO TIMEOUTS (Req 9.4): the 120s MIGRATION ceiling is distinct from the guard 60s CONSENT ceiling', () => {
  assert.equal(DEFAULT_MIGRATION_TIMEOUT_MS, 120_000, 'the migration wall-clock ceiling is 120s');
  assert.equal(DEFAULT_CONFIRM_TIMEOUT_MS, 60_000, 'the guard consent ceiling is 60s');
  assert.notEqual(DEFAULT_MIGRATION_TIMEOUT_MS, DEFAULT_CONFIRM_TIMEOUT_MS, 'the two ceilings are not conflated');
});
