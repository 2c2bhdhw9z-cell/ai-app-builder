/**
 * THE CONNECTOR-BINDING STORE (spec Task 21.1, Req 10.5, 10.7; storage split).
 *
 * A ConnectorBindingStore persists a Project's ConnectorBindings OUT-OF-TREE,
 * mirroring the SecretStore's storage discipline (src/secrets/secret-store.js):
 *
 *   - Every binding record is persisted at EXACTLY
 *       layout.controlConnectorBindingPath(ownerId, projectId)
 *     which the StorageLayout computes under `controlRoot` and asserts with
 *     assertOutsideExportTrees — so a binding can NEVER be written inside an
 *     exportable project tree (Property 9 / Req 10.4 support: the control-plane
 *     record does not enter an exported tree).
 *   - A binding holds secret NAMES only (secretRefs), never values. Records go
 *     through createConnectorBinding (src/model/connector.js), whose validation
 *     rejects a non-string secretRef, so a plaintext value can never land in a
 *     binding record.
 *
 * A single project's bindings live in ONE JSON file (a map keyed by service),
 * so add/remove/setStatus are read-modify-write on that file. This mirrors how
 * the control-plane registry stores a per-owner JSON document.
 *
 * The `bindingsFor(projectId)` adapter returns the project's ACTIVE bindings in
 * the exact shape SandboxManager's `bindingsFor` seam and egress.js expect (a
 * ConnectorBinding-shaped object carrying its connector + an endpoint host), so
 * adding an active binding both authorizes its secret env and adds its endpoint
 * to the egress allowlist, and removing it revokes both.
 *
 * Conventions mirror the SecretStore: a factory createX({...deps}) returning
 * Object.freeze({...}); node:fs only; no plumby import; no new dependency.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';
import { createConnectorBinding } from '../model/connector.js';

/**
 * Create a ConnectorBindingStore.
 *
 * @param {object} args
 * @param {object} args.layout      a StorageLayout (src/storage/layout.js) — supplies
 *        controlConnectorBindingPath(ownerId, projectId) + assertOutsideExportTrees.
 * @param {string} [args.ownerId='default']  the owning account id (storage-split axis).
 * @returns {object} store (frozen)
 */
export function createConnectorBindingStore({ layout, ownerId = 'default' } = {}) {
  const model = 'ConnectorBindingStore';
  if (
    !layout ||
    typeof layout.controlConnectorBindingPath !== 'function' ||
    typeof layout.assertOutsideExportTrees !== 'function'
  ) {
    fail(model, 'layout with controlConnectorBindingPath/assertOutsideExportTrees is required');
  }
  requireString(model, 'ownerId', ownerId);

  /** Resolve + assert the out-of-tree JSON path for a project's bindings. */
  function pathFor(projectId) {
    const p = layout.controlConnectorBindingPath(ownerId, projectId);
    layout.assertOutsideExportTrees(p, 'connector-binding');
    return p;
  }

  /**
   * Read the project's on-disk binding document: a plain object keyed by
   * connector service -> a stored binding record. Returns {} when none exist.
   */
  function readDoc(projectId) {
    const p = pathFor(projectId);
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return {};
      throw err;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      fail(model, `connector-binding document for ${JSON.stringify(projectId)} is not valid JSON`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      fail(model, `connector-binding document for ${JSON.stringify(projectId)} must be a JSON object`);
    }
    return doc;
  }

  /** Atomically persist the project's binding document (temp-file + rename). */
  function writeDoc(projectId, doc) {
    const p = pathFor(projectId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  }

  /**
   * Rehydrate a stored record into a validated ConnectorBinding-shaped object,
   * carrying the endpoint host(s) egress.js reads. createConnectorBinding
   * validates connector + secretRefs (names only) + status; the endpoint host(s)
   * are attached alongside (egress endpointHostsForBinding reads `hosts`).
   */
  function toBinding(stored) {
    const binding = createConnectorBinding({
      connector: stored.connector,
      secretRefs: stored.secretRefs ?? [],
      status: stored.status,
    });
    const hosts = Array.isArray(stored.hosts) ? [...stored.hosts] : [];
    return Object.freeze({ ...binding, hosts: Object.freeze(hosts) });
  }

  /**
   * put(projectId, { connector, secretRefs, status, hosts }): persist a binding
   * for a connector service (validated through createConnectorBinding). Replaces
   * any existing binding for the same service. Returns the stored binding.
   */
  function put(projectId, input = {}) {
    requireString(model, 'projectId', projectId);
    const binding = createConnectorBinding({
      connector: input.connector,
      secretRefs: input.secretRefs ?? [],
      status: input.status,
    });
    const service = binding.connector.service;
    const hosts = Array.isArray(input.hosts) ? [...input.hosts] : [];
    const doc = readDoc(projectId);
    doc[service] = {
      connector: binding.connector,
      secretRefs: binding.secretRefs,
      status: binding.status,
      hosts,
    };
    writeDoc(projectId, doc);
    return toBinding(doc[service]);
  }

  /** get(projectId, service): the stored binding for a service, or null. */
  function get(projectId, service) {
    requireString(model, 'projectId', projectId);
    requireString(model, 'service', service);
    const doc = readDoc(projectId);
    const stored = doc[service];
    return stored ? toBinding(stored) : null;
  }

  /** has(projectId, service): whether a binding exists for a service. */
  function has(projectId, service) {
    requireString(model, 'projectId', projectId);
    requireString(model, 'service', service);
    return Object.prototype.hasOwnProperty.call(readDoc(projectId), service);
  }

  /** list(projectId): ALL bindings for a project (active AND removed). */
  function list(projectId) {
    requireString(model, 'projectId', projectId);
    const doc = readDoc(projectId);
    return Object.freeze(
      Object.keys(doc)
        .sort()
        .map((service) => toBinding(doc[service])),
    );
  }

  /**
   * setStatus(projectId, service, status): flip a binding's status ('active' |
   * 'removed') in place, re-validating via createConnectorBinding. Returns the
   * updated binding, or null when no binding exists for the service.
   */
  function setStatus(projectId, service, status) {
    requireString(model, 'projectId', projectId);
    requireString(model, 'service', service);
    const doc = readDoc(projectId);
    const stored = doc[service];
    if (!stored) return null;
    // Re-validate the whole record with the new status.
    const binding = createConnectorBinding({
      connector: stored.connector,
      secretRefs: stored.secretRefs ?? [],
      status,
    });
    doc[service] = { ...stored, status: binding.status };
    writeDoc(projectId, doc);
    return toBinding(doc[service]);
  }

  /**
   * remove(projectId, service): delete a binding record entirely. Idempotent —
   * removing an absent binding is success. Returns { projectId, service,
   * removed:true }.
   */
  function remove(projectId, service) {
    requireString(model, 'projectId', projectId);
    requireString(model, 'service', service);
    const doc = readDoc(projectId);
    if (Object.prototype.hasOwnProperty.call(doc, service)) {
      delete doc[service];
      writeDoc(projectId, doc);
    }
    return { projectId, service, removed: true };
  }

  /**
   * bindingsFor(projectId): the project's ACTIVE bindings, in the shape
   * SandboxManager's `bindingsFor` seam and egress.js consume. A 'removed'
   * binding is intentionally omitted — that is how removal revokes its egress
   * and its authorization (Req 10.7).
   */
  function bindingsFor(projectId) {
    return list(projectId).filter((b) => b.status === 'active');
  }

  return Object.freeze({
    ownerId,
    put,
    get,
    has,
    list,
    setStatus,
    remove,
    bindingsFor,
  });
}
