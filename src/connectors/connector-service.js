/**
 * THE CONNECTOR SERVICE — the composing layer for managed Connectors (spec Task
 * 21.1, Req 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8).
 *
 * This is the thin COMPOSING layer (mirroring src/sandbox/package-manager.js and
 * src/sandbox/database-service.js) that turns "the user selected a Connector"
 * into a contained, no-partial-state credential capture + injection, reusing the
 * EXISTING seams rather than reinventing any of them:
 *
 *   - THE CATALOG (Req 10.1): src/connectors/catalog.js supplies the concrete
 *     Connector across all six categories, its captureKind, its credential
 *     env-var NAME(s), and its egress endpoint host(s).
 *   - THE CAPTURE SEAM (Req 10.2): the OAuth authorization / API-key entry
 *     boundary is an INJECTED `capture` seam whose contract is
 *       { ok:true, credentials:{ NAME: value } }   on success
 *       { ok:false, reason:'failed'|'cancelled'|'denied' }  otherwise.
 *     This is the ONLY external boundary; a test injects a fake. This module
 *     never performs a real OAuth flow.
 *   - THE SECRET STORE (Req 10.3, 10.4): a captured credential is stored as a
 *     Secret via secretStore.put(projectId, NAME, value) — VALUE out-of-tree,
 *     NAME only surfaces. The value is NEVER written into the exportable tree.
 *   - THE BINDING STORE (Req 10.5, 10.7): a ConnectorBinding (secretRefs = NAMES
 *     only, status 'active') is persisted; removal flips it to 'removed' /
 *     deletes it. This drives the SandboxManager's `bindingsFor` seam and, via
 *     egress.js, the deny-by-default egress allowlist.
 *   - THE STEERING WRITER (Req 10.5, 11.4): the connectors manifest under
 *     `.plumby/steering/` is regenerated from the active-connector set so the
 *     Builder_Agent references the injected Secret NAME, never a literal.
 *   - RUNTIME INJECTION (Req 10.3): the credential is injected into the Sandbox
 *     env ONLY at exec time, through the SandboxManager's existing
 *     secretStore.envForProject / bindingsFor seam — this module writes no env
 *     file and never hands a value to the tree.
 *   - THE COMMAND GUARD (Req 10.8): a `hosting-deploy` deploy command is routed
 *     through commandGuard.run — the SAME plumby classifier gate the package
 *     manager / schema migrator use. No path reaches the deploy boundary without
 *     the guard.
 *
 * NO-PARTIAL-STATE DISCIPLINE (Req 10.6): on capture fail/cancel/deny, NOTHING is
 * written — no Secret, no binding, no steering. And on the SUCCESS path, the
 * secret writes and the binding write live inside ONE guarded scope: if EITHER
 * throws, every credential written so far is rolled back (and the binding, if
 * any, dropped), so a partial state — an orphaned out-of-tree Secret with no
 * binding, still injectable via envForProject — can never be left behind. The
 * function returns a structured failure and leaves the Project's existing
 * Connectors and Secrets byte-for-byte unchanged.
 *
 * THE ai-model DISTINCTION (Req 10.1): an `ai-model` Connector is a service the
 * GENERATED APP calls; it is DISTINCT from the builder's own model provider
 * (createAnthropicProvider/Gemini/OpenRouter behind the plumby boundary). This
 * module treats an ai-model connector exactly like any other catalog entry —
 * capture -> Secret -> binding -> steering — and never touches the builder
 * provider.
 *
 * Conventions: a factory createX({...deps}) returning Object.freeze({...}); DI
 * for the clock (`now`) and every collaborator; structured { ok, code?, message? }
 * results; NEVER throws on a handled failure (it REPORTS it). Adds NO dependency;
 * imports no plumby package (the boundary invariant).
 */

import { fail, requireString } from '../model/validate.js';
import { createConnector } from '../model/connector.js';
import { defaultConnectorCatalog } from './catalog.js';

/** Map a capture-seam failure `reason` to a structured result code (Req 10.6). */
const CAPTURE_REASON_CODE = Object.freeze({
  failed: 'CAPTURE_FAILED',
  cancelled: 'CAPTURE_CANCELLED',
  denied: 'CAPTURE_DENIED',
});

/**
 * Normalize an OPTIONAL observability/audit sink into a record(event) fn (no-op
 * when absent). Mirrors package-manager.js / database-service.js toRecordSink.
 */
function toRecordSink(sink) {
  if (sink === undefined || sink === null) return () => {};
  if (typeof sink === 'function') return (event) => sink(event);
  if (typeof sink.record === 'function') return (event) => sink.record(event);
  fail('ConnectorService', 'observability/audit sink must be a function or an object with a record(event) method');
  return () => {};
}

/**
 * Create the Connector service.
 *
 * @param {object} args
 * @param {object} args.secretStore     a SecretStore (src/secrets/secret-store.js) with put/get/remove/has.
 * @param {object} args.bindingStore     a ConnectorBindingStore (src/connectors/binding-store.js).
 * @param {object} args.steeringWriter   a connectors steering writer (src/connectors/steering.js).
 * @param {(args:{projectId,service,category,captureKind,envNames})=>Promise<object>|object} args.capture
 *        the OAuth/API-key capture boundary seam. Returns { ok:true, credentials:{NAME:value} }
 *        on success, or { ok:false, reason:'failed'|'cancelled'|'denied' } otherwise.
 * @param {object} [args.catalog]        a Connector_Catalog (defaults to the built-in one).
 * @param {object} [args.sandboxManager] a SandboxManager whose updateEgress recomputes the egress
 *        allowlist after add/remove (optional; the allowlist is a pure function of bindings, so a
 *        caller may recompute lazily — this module updates it opportunistically when acquired).
 * @param {object} [args.commandGuard]   a CommandGuard (src/sandbox/command-guard.js) — required for deployTo.
 * @param {() => number} [args.now]      injectable ms clock (default Date.now).
 * @param {Function|{record:Function}} [args.observability]  OPTIONAL observability sink.
 * @param {Function|{record:Function}} [args.audit]          OPTIONAL audit sink.
 * @returns {object} connector service (frozen)
 */
export function createConnectorService({
  secretStore,
  bindingStore,
  steeringWriter,
  capture,
  catalog = defaultConnectorCatalog,
  sandboxManager,
  commandGuard,
  now = Date.now,
  observability,
  audit,
} = {}) {
  const model = 'ConnectorService';
  if (!secretStore || typeof secretStore.put !== 'function' || typeof secretStore.remove !== 'function') {
    fail(model, 'secretStore with put/remove is required');
  }
  if (
    !bindingStore ||
    typeof bindingStore.put !== 'function' ||
    typeof bindingStore.list !== 'function' ||
    typeof bindingStore.remove !== 'function'
  ) {
    fail(model, 'bindingStore with put/list/remove is required');
  }
  if (!steeringWriter || typeof steeringWriter.write !== 'function') {
    fail(model, 'steeringWriter with write(projectId, connectors) is required');
  }
  if (typeof capture !== 'function') {
    fail(model, 'capture must be a function (the OAuth/API-key boundary seam)');
  }
  if (!catalog || typeof catalog.get !== 'function') {
    fail(model, 'catalog with get(service) is required');
  }
  if (typeof now !== 'function') {
    fail(model, 'now must be a function returning milliseconds');
  }

  const emitObservability = toRecordSink(observability);
  const emitAudit = toRecordSink(audit);

  /**
   * Recompute the steering manifest from the store's CURRENT active bindings,
   * decorating each with its catalog envNames/category so the surface names the
   * injected env-var NAMEs (never values). Best-effort refresh of the egress
   * allowlist too, when the sandbox is acquired.
   */
  function refreshSurfaces(projectId) {
    const active = bindingStore.list(projectId).filter((b) => b.status === 'active');
    const connectors = active.map((b) => {
      const service = b.connector.service;
      const entry = catalog.get(service);
      return {
        service,
        category: b.connector.category,
        envNames: entry ? [...entry.envNames] : [...b.secretRefs],
      };
    });
    steeringWriter.write(projectId, connectors);

    // The egress allowlist is a PURE function of the current bindings; if the
    // sandbox is acquired, recompute it so a newly-active endpoint is allowed
    // and a removed one is revoked. Never fatal — a not-yet-acquired project is
    // recomputed lazily by SandboxManager.acquire from bindingsFor.
    if (sandboxManager && typeof sandboxManager.updateEgress === 'function') {
      try {
        sandboxManager.updateEgress(projectId, bindingStore.bindingsFor(projectId));
      } catch {
        /* project not acquired yet — allowlist derives from bindingsFor at acquire */
      }
    }
  }

  /**
   * addConnector — initiate a Connector's credential capture and, on success,
   * store the credential(s) as Secret(s), persist an active ConnectorBinding,
   * and surface the Connector to the Builder_Agent (Req 10.2, 10.3, 10.5, 10.6).
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.service     a catalog service name
   * @param {object} [params.capture]   per-call override of the capture seam
   * @returns {Promise<object>} a frozen structured result
   */
  async function addConnector(params = {}) {
    const { projectId, service } = params;
    requireString(model, 'projectId', projectId);
    requireString(model, 'service', service);

    const entry = catalog.get(service);
    if (!entry) {
      return Object.freeze({
        ok: false,
        code: 'UNKNOWN_CONNECTOR',
        message: `no Connector_Catalog entry for service ${JSON.stringify(service)}`,
      });
    }

    // Validate the connector record up front (also proves the catalog entry maps
    // to a valid Connector). Never persisted unless capture succeeds.
    const connector = createConnector({
      service: entry.service,
      category: entry.category,
      captureKind: entry.captureKind,
    });

    // (1) INITIATE CAPTURE via the injected boundary seam (Req 10.2). A per-call
    // override wins so a caller can supply a request-scoped seam.
    const captureSeam = typeof params.capture === 'function' ? params.capture : capture;
    let captureResult;
    try {
      captureResult = await captureSeam({
        projectId,
        service: entry.service,
        category: entry.category,
        captureKind: entry.captureKind,
        envNames: [...entry.envNames],
      });
    } catch (err) {
      // A thrown capture seam is treated as a FAILURE — nothing partial written.
      const message = `connector credential capture threw: ${err?.message ?? String(err)}`;
      emitAudit({ type: 'connector.add.failed', projectId, service, code: 'CAPTURE_FAILED' });
      emitObservability({ type: 'connector.add', projectId, service, ok: false, code: 'CAPTURE_FAILED' });
      return Object.freeze({ ok: false, code: 'CAPTURE_FAILED', service, message });
    }

    // (3) FAILURE / CANCEL / DENY (Req 10.6): report, store NOTHING partial,
    // create NO binding, write NO steering. The existing Connectors/Secrets are
    // untouched because we have not written anything on this path.
    if (!captureResult || captureResult.ok !== true) {
      const reason = captureResult?.reason;
      const code = CAPTURE_REASON_CODE[reason] ?? 'CAPTURE_FAILED';
      const message = `connector ${JSON.stringify(service)} credential capture ${reason ?? 'failed'}; nothing stored, existing connectors and secrets unchanged`;
      emitAudit({ type: 'connector.add.failed', projectId, service, code });
      emitObservability({ type: 'connector.add', projectId, service, ok: false, code });
      return Object.freeze({ ok: false, code, service, reason: reason ?? 'failed', message });
    }

    // Validate the captured credential map against the catalog's declared NAMEs
    // BEFORE writing anything, so a malformed capture leaves state unchanged too.
    const credentials = captureResult.credentials;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return Object.freeze({
        ok: false,
        code: 'CAPTURE_FAILED',
        service,
        message: 'capture succeeded but returned no credentials map; nothing stored',
      });
    }
    const secretRefs = [...entry.envNames];
    for (const name of secretRefs) {
      const value = credentials[name];
      if (typeof value !== 'string' || value === '') {
        return Object.freeze({
          ok: false,
          code: 'CAPTURE_FAILED',
          service,
          message: `capture did not return a value for required credential ${JSON.stringify(name)}; nothing stored, existing connectors and secrets unchanged`,
        });
      }
    }

    // (2) SUCCESS — store each captured credential as a Secret (value out-of-
    // tree; NAME only surfaces), then persist the ACTIVE binding. Both writes
    // live inside ONE guarded scope with a rollback of everything committed so
    // far: if the secret write throws we remove any secret already written; if
    // the BINDING write throws we ALSO remove the just-written secrets so an
    // orphaned, still-injectable credential can never be left behind (Req 10.6
    // "stores nothing partial"). This mirrors the snapshot-and-restore rollback
    // discipline of package-manager.js / database-service.js.
    const written = [];
    let binding;
    try {
      for (const name of secretRefs) {
        secretStore.put(projectId, name, credentials[name]);
        written.push(name);
      }
      binding = bindingStore.put(projectId, {
        connector,
        secretRefs,
        status: 'active',
        hosts: [...entry.hosts],
      });
    } catch (err) {
      // Roll back EVERYTHING committed on this path so nothing partial remains:
      // the secrets we wrote AND (defensively) the binding, whether the failure
      // came from a secret write or the binding write (Req 10.6).
      for (const name of written) {
        try {
          secretStore.remove(projectId, name);
        } catch {
          /* best-effort rollback */
        }
      }
      try {
        bindingStore.remove(projectId, service);
      } catch {
        /* best-effort rollback — a binding may not have been written */
      }
      const code = binding === undefined && written.length === secretRefs.length ? 'BINDING_STORE_FAILED' : 'SECRET_STORE_FAILED';
      emitAudit({ type: 'connector.add.failed', projectId, service, code });
      emitObservability({ type: 'connector.add', projectId, service, ok: false, code });
      return Object.freeze({
        ok: false,
        code,
        service,
        message: `failed to persist connector ${JSON.stringify(service)}: ${err?.message ?? String(err)}; rolled back, existing connectors and secrets unchanged`,
      });
    }

    // Surface to the Builder_Agent + recompute egress from the current bindings.
    // This runs AFTER the secret+binding are committed. It writes NAMEs only (no
    // credential value), so a failure here cannot leak — but to honor the
    // module's "never throw on a handled path" contract, a surface-refresh error
    // is caught and reported as a structured DEGRADED success: the connector IS
    // active and injectable (secret+binding committed), only the steering/egress
    // surface failed to refresh (recomputed lazily from bindingsFor at acquire).
    let steeringPath;
    try {
      refreshSurfaces(projectId);
      steeringPath = steeringWriter.manifestPathFor(projectId);
    } catch (err) {
      emitAudit({ type: 'connector.add.degraded', projectId, service, secretRefs });
      emitObservability({ type: 'connector.add', projectId, service, ok: true, code: 'ADDED_DEGRADED' });
      return Object.freeze({
        ok: true,
        degraded: true,
        connector,
        binding,
        secretRefs: Object.freeze([...secretRefs]),
        code: 'SURFACE_REFRESH_FAILED',
        message: `connector ${JSON.stringify(service)} added and injected, but surface refresh (steering/egress) failed: ${err?.message ?? String(err)}; the allowlist is recomputed from bindingsFor at sandbox acquire`,
      });
    }

    emitAudit({ type: 'connector.add.succeeded', projectId, service, secretRefs });
    emitObservability({ type: 'connector.add', projectId, service, ok: true, code: 'ADDED' });

    return Object.freeze({
      ok: true,
      connector,
      binding,
      secretRefs: Object.freeze([...secretRefs]),
      steeringPath,
      message: `connector ${JSON.stringify(service)} added; credential injected at runtime via env-var reference`,
    });
  }

  /**
   * removeConnector — remove a Connector from a Project, revoking the associated
   * Secret's runtime injection and reporting the removal (Req 10.7). Idempotent:
   * removing an absent/already-removed connector still reports success.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.service
   * @returns {object} a frozen structured result
   */
  function removeConnector(params = {}) {
    const { projectId, service } = params;
    requireString(model, 'projectId', projectId);
    requireString(model, 'service', service);

    const existing = bindingStore.get(projectId, service);
    // The secret NAMEs to revoke: prefer the binding's own refs; fall back to
    // the catalog so an orphaned secret is still cleaned up.
    const entry = catalog.get(service);
    const revokedSecretRefs = existing
      ? [...existing.secretRefs]
      : entry
        ? [...entry.envNames]
        : [];

    // Revoke the runtime injection: remove each Secret so envForProject no longer
    // materializes it (SecretStore.remove is idempotent).
    for (const name of revokedSecretRefs) {
      try {
        secretStore.remove(projectId, name);
      } catch {
        /* best-effort revoke; still report the removal */
      }
    }

    // Drop the binding entirely (idempotent). Recomputing egress from the now-
    // absent binding revokes its endpoint; the steering refresh drops its block.
    bindingStore.remove(projectId, service);
    refreshSurfaces(projectId);

    emitAudit({ type: 'connector.remove', projectId, service, revokedSecretRefs });
    emitObservability({ type: 'connector.remove', projectId, service, ok: true });

    return Object.freeze({
      ok: true,
      removed: true,
      service,
      revokedSecretRefs: Object.freeze([...revokedSecretRefs]),
      message: `connector ${JSON.stringify(service)} removed; secret injection revoked`,
    });
  }

  /**
   * deployTo — use a `hosting-deploy` Connector as the deployment destination for
   * the Project's Deployment_Artifact, routing the deploy command through the
   * SAME plumby classifier gate the package manager / schema migrator use (Req
   * 10.8). No path reaches the deploy boundary without the guard.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.service               a hosting-deploy catalog service
   * @param {string|string[]} params.command      the deploy command
   * @param {(req:object)=>(Promise<boolean>|boolean)} [params.onConfirmRequest]
   * @param {AbortSignal} [params.signal]
   * @param {boolean} [params.subAgent]
   * @param {number} [params.timeoutMs]
   * @returns {Promise<object>} the guard's structured outcome (frozen)
   */
  async function deployTo(params = {}) {
    const { projectId, service, command, onConfirmRequest, signal, subAgent, timeoutMs } = params;
    requireString(model, 'projectId', projectId);
    requireString(model, 'service', service);
    if (!commandGuard || typeof commandGuard.run !== 'function') {
      fail(model, 'deployTo requires a commandGuard with run(projectId, command, opts)');
    }
    if (command === undefined || command === null || (typeof command !== 'string' && !Array.isArray(command))) {
      fail(model, 'deployTo requires a command (string or argv array)');
    }

    const entry = catalog.get(service);
    if (!entry) {
      return Object.freeze({
        ok: false,
        code: 'UNKNOWN_CONNECTOR',
        service,
        message: `no Connector_Catalog entry for service ${JSON.stringify(service)}`,
      });
    }
    if (entry.category !== 'hosting-deploy') {
      return Object.freeze({
        ok: false,
        code: 'NOT_A_DEPLOY_CONNECTOR',
        service,
        message: `connector ${JSON.stringify(service)} is category ${JSON.stringify(entry.category)}, not hosting-deploy; it cannot be a deploy destination`,
      });
    }

    // ROUTE through the guard — the SINGLE classifier gate (Req 10.8).
    const outcome = await commandGuard.run(projectId, command, {
      timeoutMs,
      signal,
      subAgent,
      onConfirmRequest,
    });
    emitAudit({ type: 'connector.deploy', projectId, service, outcome: outcome?.outcome ?? null });
    emitObservability({ type: 'connector.deploy', projectId, service, outcome: outcome?.outcome ?? null });
    return outcome;
  }

  return Object.freeze({
    addConnector,
    removeConnector,
    deployTo,
    catalog,
  });
}
