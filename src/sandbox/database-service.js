/**
 * THE DATABASE PROVISIONER + BACKEND SCAFFOLDER — full-stack Database_Service
 * bring-up and backend-scaffolding completion (spec Task 20.1, Req 9.1, 9.2,
 * 9.3; Req 9.6, 9.7 / Correctness Property 8).
 *
 * A `full-stack-web` / `multi-target` Project needs (a) a `backend` Target with
 * at least one reachable endpoint returning an HTTP status < 400 in the Sandbox
 * (Req 9.1) and (b) a Database_Service provisioned within 60 seconds and
 * reported READY before scaffolding is marked complete (Req 9.2). If the DB does
 * not come up within 60s or fails, the cause is reported and NO partially
 * provisioned DB is left active (Req 9.3).
 *
 * This module is a thin COMPOSING layer over the EXISTING seams — it reinvents
 * none of them, mirroring src/sandbox/package-manager.js:
 *
 *   - CONTAINMENT: the DB bring-up runs INSIDE the project's Isolation_Boundary
 *     via the injected `provisioner` seam, whose default drives the boundary
 *     through SandboxManager.exec (src/sandbox/sandbox-manager.js). It produces
 *     the REAL exec contract ({ exitCode, denied, deniedReason, timedOut, ... }).
 *     Secret env is injected at runtime by the SandboxManager's own
 *     secretStore/envForProject seam (Req 9.6) — this module never writes secret
 *     values into the tree.
 *
 *   - THE 60s CEILING (Req 9.2/9.3): measured against the INJECTED clock (`now`)
 *     and threaded as `timeoutMs` down to exec, exactly as package-manager.js
 *     threads its 300s install ceiling. NOT a real wall-clock wait.
 *
 *   - NO PARTIAL DB ON NON-SUCCESS (Req 9.3): on failure OR timeout the
 *     provisioner invokes the `teardown` seam in a finally-style rollback so any
 *     partially provisioned DB is reaped and left inactive — mirroring
 *     package-manager.js restoreManifest/cleanPartialDeps and the
 *     SandboxManager release-in-finally discipline. The returned record's status
 *     is 'torn-down', never a lingering 'provisioning'/'ready'.
 *
 *   - SECRET NON-LEAKAGE (Req 9.7 / Property 8): generated backend/DB source is
 *     run through generation-guardrail.scanAndSubstitute so a literal Secret
 *     value (e.g. a DB connection string) is rewritten to an env-var reference
 *     and never committed to the exportable tree.
 *
 * CONTRACTS (never throw on a handled failure — REPORT it):
 *   provision():
 *     success -> { ok:true, database:{ ...status:'ready' }, durationMs }  ONLY
 *                after the DB reports ready.
 *     failure -> { ok:false, code:'DB_PROVISION_FAILED'|'DB_PROVISION_TIMEOUT',
 *                  message, durationMs, database:{ ...status:'torn-down' },
 *                  tornDown:true }  with the teardown seam invoked.
 *
 *   scaffoldBackend(): confirms a backend Target with a reachable < 400 endpoint,
 *     THEN provisions the DB, and returns scaffolding-complete ONLY after the DB
 *     is ready. On DB non-success it returns a structured failure with
 *     complete:false and no active partial DB.
 *
 * Conventions: a factory createX({...deps}) returning Object.freeze({...});
 * DI for the clock (`now`) and every collaborator; structured
 * { ok:true|false, code?, message? } results. Adds NO dependency; imports no
 * plumby package (the boundary invariant).
 */

import crypto from 'node:crypto';

import { fail, requireString } from '../model/validate.js';
import { createDatabaseService } from '../model/database-service.js';
import { scanAndSubstitute } from '../secrets/generation-guardrail.js';

/** The 60s Database_Service provisioning ceiling (Req 9.2/9.3). */
export const DEFAULT_DB_PROVISION_TIMEOUT_MS = 60_000;

/**
 * The default in-Sandbox DB bring-up command. A caller can override per-call via
 * `command`, or swap the whole builder via the factory's `provisionCommand` seam.
 * It is interpreted by the CONTAINER's shell (SandboxManager.exec), never the
 * host's — there is no host-side shell interpolation.
 */
function defaultProvisionCommand({ engine }) {
  return `db-provision --engine ${engine} --wait-ready`;
}

/**
 * The default reachability probe command (Req 9.1): asks the Sandbox to invoke
 * the backend's endpoint and report its HTTP status. The default `readiness`
 * interpreter treats exitCode 0 as "responded < 400" (the fake/real exec's
 * contract), matching the full-stack-web template's test/server.test.js which
 * boots the node:http handler in-process and asserts res.status < 400.
 */
function defaultEndpointProbeCommand({ path: probePath }) {
  return `http-probe --path ${probePath} --max-status 399`;
}

/**
 * Normalize an OPTIONAL observability/audit sink into a record(event) fn (no-op
 * when absent). Mirrors package-manager.js toRecordSink.
 */
function toRecordSink(sink) {
  if (sink === undefined || sink === null) return () => {};
  if (typeof sink === 'function') return (event) => sink(event);
  if (typeof sink.record === 'function') return (event) => sink.record(event);
  fail('DatabaseProvisioner', 'observability/audit sink must be a function or an object with a record(event) method');
  return () => {};
}

/**
 * Interpret a SandboxManager.exec-shaped result as a boundary SUCCESS
 * (executed inside the box with exit 0), a TIMEOUT (the wall-clock reaper
 * fired), or a FAILURE (launch failure, or a non-zero exit — the command's own
 * failure inside the box). Returns { ok, timedOut, exitCode, message }.
 */
function classifyExecResult(result) {
  const denied = result?.denied === true;
  const timedOut = result?.timedOut === true || result?.deniedReason === 'timeout';
  const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : null;
  const stderr = String(result?.stderr ?? '');
  const stdout = String(result?.stdout ?? '');
  if (timedOut) {
    return { ok: false, timedOut: true, exitCode, message: stderr || stdout || 'boundary wall-clock timeout' };
  }
  if (denied) {
    // launch-failure (or any other boundary refusal that is not a timeout)
    return { ok: false, timedOut: false, exitCode, message: stderr || 'boundary refused to launch the command' };
  }
  if (exitCode === 0) {
    return { ok: true, timedOut: false, exitCode, message: stdout };
  }
  return { ok: false, timedOut: false, exitCode, message: stderr || `command exited ${exitCode}` };
}

/**
 * Create a Database_Service provisioner.
 *
 * @param {object} args
 * @param {object} [args.manager]   a SandboxManager (src/sandbox/sandbox-manager.js) with
 *        exec(projectId, command, {timeoutMs, signal}). Used by the default provisioner
 *        seam to run the DB bring-up INSIDE the boundary. Optional when an explicit
 *        `provisioner` seam is injected.
 * @param {(args:{projectId,command,timeoutMs,signal})=>Promise<object>} [args.provisioner]
 *        the DB-bring-up boundary seam. Defaults to a function that calls manager.exec.
 *        Must resolve to the REAL exec contract shape.
 * @param {(args:{projectId,database})=>Promise<void>|void} [args.teardown]  the reap/teardown
 *        seam invoked on ANY non-success so no partial DB stays active (Req 9.3). Defaults to
 *        a manager.exec-driven `db-teardown` command.
 * @param {() => number} [args.now]   injectable ms clock for the ceiling + durationMs (default Date.now).
 * @param {number} [args.provisionTimeoutMs=60000]  the 60s wall-clock ceiling threaded to exec.
 * @param {string} [args.engine='postgres']  the DB engine descriptor.
 * @param {(args:{engine,projectId})=>string} [args.provisionCommand]  bring-up command builder.
 * @param {() => string} [args.newId]  id generator for the Database_Service record.
 * @param {Function|{record:Function}} [args.observability]  OPTIONAL observability sink.
 * @param {Function|{record:Function}} [args.audit]          OPTIONAL audit sink.
 * @returns {object} provisioner (frozen)
 */
export function createDatabaseProvisioner({
  manager,
  provisioner,
  teardown,
  now = Date.now,
  provisionTimeoutMs = DEFAULT_DB_PROVISION_TIMEOUT_MS,
  engine = 'postgres',
  provisionCommand = defaultProvisionCommand,
  newId = () => `db-${crypto.randomBytes(6).toString('hex')}`,
  observability,
  audit,
} = {}) {
  // Either an explicit provisioner seam OR a manager to drive exec is required.
  const hasManagerExec = manager && typeof manager.exec === 'function';
  if (typeof provisioner !== 'function' && !hasManagerExec) {
    fail(
      'DatabaseProvisioner',
      'either a provisioner(args) seam or a manager with exec(projectId, command, opts) is required',
    );
  }
  if (typeof now !== 'function') {
    fail('DatabaseProvisioner', 'now must be a function returning milliseconds');
  }
  if (typeof provisionTimeoutMs !== 'number' || !Number.isFinite(provisionTimeoutMs) || provisionTimeoutMs <= 0) {
    fail('DatabaseProvisioner', 'provisionTimeoutMs must be a positive number');
  }
  if (typeof provisionCommand !== 'function') {
    fail('DatabaseProvisioner', 'provisionCommand must be a function');
  }

  const emitObservability = toRecordSink(observability);
  const emitAudit = toRecordSink(audit);

  // The DB bring-up seam: run the command INSIDE the boundary. Default drives
  // SandboxManager.exec so secret env is injected at runtime by the manager's
  // own secretStore/envForProject seam (Req 9.6) and no value touches this layer.
  const runProvision =
    typeof provisioner === 'function'
      ? provisioner
      : ({ projectId, command, timeoutMs, signal }) => manager.exec(projectId, command, { timeoutMs, signal });

  // The teardown seam: reap any partial DB on non-success (Req 9.3). Default
  // drives a `db-teardown` command inside the boundary (best-effort).
  const runTeardown =
    typeof teardown === 'function'
      ? teardown
      : async ({ projectId, database }) => {
          if (!hasManagerExec) return;
          try {
            await manager.exec(projectId, `db-teardown --id ${database?.id ?? ''}`, {
              timeoutMs: provisionTimeoutMs,
            });
          } catch {
            /* best-effort reap; never throw from the rollback path */
          }
        };

  /**
   * provision — bring up the Project's Database_Service inside the boundary
   * within the 60s ceiling and report it ready (Req 9.2), or report the cause
   * and reap any partial DB (Req 9.3).
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string|string[]} [params.command]  explicit bring-up command (overrides the builder)
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} a frozen structured result
   */
  async function provision(params = {}) {
    const { projectId, command, signal } = params;
    requireString('DatabaseProvisioner', 'projectId', projectId);

    // The record begins its life in 'provisioning' — never reported ready until
    // the boundary confirms the DB is up (Req 9.2).
    const database = createDatabaseService({
      id: newId(),
      projectId,
      status: 'provisioning',
      engine,
      createdAt: new Date(now()).toISOString(),
    });

    const bringUpCommand = command !== undefined ? command : provisionCommand({ engine, projectId });

    // The 60s ceiling is threaded as timeoutMs so the boundary's wall-clock
    // reaper can fire; durationMs is derived from the INJECTED clock.
    const startedAt = now();
    let execResult;
    try {
      execResult = await runProvision({ projectId, command: bringUpCommand, timeoutMs: provisionTimeoutMs, signal });
    } catch (err) {
      // A thrown provisioner is a FAILURE (not a handled exec contract). Reap
      // any partial DB and report the cause.
      return failResult({ projectId, database, code: 'DB_PROVISION_FAILED', durationMs: now() - startedAt, message: `database provisioning threw: ${err?.message ?? String(err)}` });
    }
    const durationMs = Math.max(0, now() - startedAt);

    const verdict = classifyExecResult(execResult);

    // Enforce the 60s ceiling against the INJECTED clock too (belt-and-braces:
    // even if the boundary did not report a timeout, an over-budget bring-up is
    // a provisioning TIMEOUT — Req 9.2/9.3).
    const overBudget = durationMs > provisionTimeoutMs;

    if (verdict.timedOut || overBudget) {
      return failResult({
        projectId,
        database,
        code: 'DB_PROVISION_TIMEOUT',
        durationMs,
        message: verdict.timedOut
          ? `database provisioning exceeded the ${provisionTimeoutMs}ms ceiling (boundary reaper fired)`
          : `database provisioning exceeded the ${provisionTimeoutMs}ms ceiling (took ${durationMs}ms)`,
      });
    }

    if (!verdict.ok) {
      return failResult({
        projectId,
        database,
        code: 'DB_PROVISION_FAILED',
        durationMs,
        message: `database provisioning failed: ${verdict.message}`,
      });
    }

    // SUCCESS — the DB reported ready. Only NOW is the record 'ready' (Req 9.2).
    const ready = createDatabaseService({ ...database, status: 'ready' });
    emitAudit({ type: 'db.provision.succeeded', projectId, id: ready.id, durationMs });
    emitObservability({ type: 'db.provision', projectId, ok: true, code: 'DB_READY', durationMs });
    return Object.freeze({
      ok: true,
      database: Object.freeze(ready),
      durationMs,
      message: 'Database_Service ready',
    });
  }

  /**
   * Report a provisioning FAILURE/TIMEOUT: reap any partial DB via the teardown
   * seam (Req 9.3 — leave no partial DB active) and return the structured
   * failure with a 'torn-down' record.
   */
  async function failResult({ projectId, database, code, durationMs, message }) {
    // Reap the (possibly partial) DB so none stays active. Best-effort but
    // AWAITED so the caller knows teardown ran before the failure is returned.
    let tornDown = false;
    try {
      await runTeardown({ projectId, database });
      tornDown = true;
    } catch {
      /* best-effort reap; still report the failure */
    }
    const torn = createDatabaseService({ ...database, status: 'torn-down' });
    emitAudit({ type: 'db.provision.failed', projectId, id: database.id, code, tornDown });
    emitObservability({ type: 'db.provision', projectId, ok: false, code, durationMs });
    return Object.freeze({
      ok: false,
      code,
      message,
      durationMs,
      tornDown,
      database: Object.freeze(torn),
    });
  }

  return Object.freeze({
    provision,
    provisionTimeoutMs,
    engine,
  });
}

/**
 * Create a backend scaffolder — the integration point that marks a full-stack
 * Project's scaffolding COMPLETE only AFTER the Database_Service is ready
 * (Req 9.1, 9.2, 9.3). It:
 *   (a) confirms the scaffolded tree contains a `backend` Target with at least
 *       one reachable endpoint returning HTTP < 400 in the Sandbox (Req 9.1),
 *       driven by the injected exec/probe seam (a REAL exec contract, never a
 *       real network call);
 *   (b) provisions the Database_Service via the provisioner;
 *   (c) reports the DB ready BEFORE returning scaffolding-complete;
 *   (d) on DB failure/timeout returns a structured failure with complete:false
 *       and no active partial DB (the provisioner already reaped it).
 *
 * @param {object} args
 * @param {object} args.provisioner   a Database_Service provisioner (createDatabaseProvisioner)
 * @param {object} [args.manager]     a SandboxManager for the default endpoint probe
 * @param {(args:{projectId,path,command,timeoutMs,signal})=>Promise<object>} [args.endpointProbe]
 *        the reachability seam. Defaults to manager.exec of the probe command.
 * @param {number} [args.probeTimeoutMs=60000]  the probe wall-clock ceiling.
 * @param {(args:{path,projectId})=>string} [args.endpointProbeCommand]  probe command builder.
 * @param {object} [args.templateProvider]  a template provider (createTemplateProvider) — used to
 *        assert the category scaffolds a `backend` Target via templateTargets(category).
 * @param {() => number} [args.now]
 * @returns {object} scaffolder (frozen)
 */
export function createBackendScaffolder({
  provisioner,
  manager,
  endpointProbe,
  probeTimeoutMs = DEFAULT_DB_PROVISION_TIMEOUT_MS,
  endpointProbeCommand = defaultEndpointProbeCommand,
  templateProvider,
  now = Date.now,
} = {}) {
  if (!provisioner || typeof provisioner.provision !== 'function') {
    fail('BackendScaffolder', 'a provisioner with provision(params) is required');
  }
  const hasManagerExec = manager && typeof manager.exec === 'function';
  if (typeof endpointProbe !== 'function' && !hasManagerExec) {
    fail('BackendScaffolder', 'either an endpointProbe(args) seam or a manager with exec(...) is required');
  }
  if (typeof now !== 'function') {
    fail('BackendScaffolder', 'now must be a function returning milliseconds');
  }

  const runProbe =
    typeof endpointProbe === 'function'
      ? endpointProbe
      : ({ projectId, command, timeoutMs, signal }) => manager.exec(projectId, command, { timeoutMs, signal });

  /**
   * Confirm the scaffolded category includes a `backend` Target (Req 9.1). Uses
   * the template provider's templateTargets when available; otherwise trusts the
   * caller-supplied `targets` list.
   */
  function backendTargetPresent({ targetCategory, targets }) {
    let list = Array.isArray(targets) ? targets : null;
    if (!list && templateProvider && typeof templateProvider.templateTargets === 'function') {
      list = templateProvider.templateTargets(targetCategory);
    }
    return Array.isArray(list) && list.includes('backend');
  }

  /**
   * scaffoldBackend — the completion gate.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.targetCategory  'full-stack-web' | 'multi-target'
   * @param {string[]} [params.targets]     the scaffolded Target list (overrides the provider)
   * @param {string} [params.endpointPath='/']  the endpoint to probe for < 400
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<object>} a frozen structured result
   */
  async function scaffoldBackend(params = {}) {
    const { projectId, targetCategory, targets, endpointPath = '/', signal } = params;
    requireString('BackendScaffolder', 'projectId', projectId);
    requireString('BackendScaffolder', 'targetCategory', targetCategory);

    // (a1) A `backend` Target must be present (Req 9.1).
    if (!backendTargetPresent({ targetCategory, targets })) {
      return Object.freeze({
        ok: false,
        complete: false,
        code: 'BACKEND_TARGET_MISSING',
        message: `Target_Category ${JSON.stringify(targetCategory)} does not scaffold a backend Target`,
      });
    }

    // (a2) The backend endpoint must be REACHABLE with a status < 400 in the
    // Sandbox (Req 9.1), verified through the exec/probe seam's REAL contract —
    // exitCode 0 == "responded < 400". Never a real network call here.
    const probeCommand = endpointProbeCommand({ path: endpointPath, projectId });
    let probeResult;
    try {
      probeResult = await runProbe({ projectId, path: endpointPath, command: probeCommand, timeoutMs: probeTimeoutMs, signal });
    } catch (err) {
      return Object.freeze({
        ok: false,
        complete: false,
        code: 'ENDPOINT_UNREACHABLE',
        message: `backend endpoint probe threw: ${err?.message ?? String(err)}`,
      });
    }
    const probe = classifyExecResult(probeResult);
    if (!probe.ok) {
      return Object.freeze({
        ok: false,
        complete: false,
        code: 'ENDPOINT_UNREACHABLE',
        message: `backend endpoint did not return HTTP < 400 in the Sandbox: ${probe.message}`,
        endpointStatusOk: false,
      });
    }

    // (b) + (c) Provision the DB and report it ready BEFORE completion.
    const provisioned = await provisioner.provision({ projectId, signal });
    if (!provisioned.ok) {
      // (d) DB non-success: scaffolding is INCOMPLETE; the provisioner already
      // reaped the partial DB (Req 9.3). Surface the cause.
      return Object.freeze({
        ok: false,
        complete: false,
        code: provisioned.code,
        message: provisioned.message,
        endpointStatusOk: true,
        database: provisioned.database,
        tornDown: provisioned.tornDown === true,
      });
    }

    // The DB is ready — scaffolding is complete (Req 9.2). Only reachable here
    // AFTER database.status === 'ready'.
    return Object.freeze({
      ok: true,
      complete: true,
      endpointStatusOk: true,
      database: provisioned.database,
      durationMs: provisioned.durationMs,
      message: 'backend scaffolded, endpoint reachable, Database_Service ready',
    });
  }

  return Object.freeze({
    scaffoldBackend,
    probeTimeoutMs,
  });
}

/**
 * Prepare generated backend/DB source so no committed file contains a literal
 * Secret value (Req 9.7 / Property 8). A thin, explicit wrapper over
 * generation-guardrail.scanAndSubstitute so a caller scaffolding backend/DB
 * source runs it through the guardrail before writing to the exportable tree.
 * The PRIMARY mechanism is still reference-by-name + runtime injection via
 * SecretStore.envForProject (Req 9.6); this is the secondary safety net.
 *
 * @param {object} args
 * @param {Object<string,string>} args.files   { relPath: content } generated source
 * @param {Array<{name,value}>|Object} args.secrets  known secrets ({ name, value } or { NAME:value })
 * @param {string[]} [args.platformHosts]
 * @returns {{ files:object, report:Array<object> }}
 */
export function guardBackendSecrets({ files, secrets, platformHosts = [] } = {}) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    fail('guardBackendSecrets', 'files must be a { relPath: content } map');
  }
  return scanAndSubstitute({ files, secrets, platformHosts });
}
