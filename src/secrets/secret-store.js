/**
 * THE SECRET STORE (spec subtask 7.1, Req 9.6, 9.7, 10.4, 11.4, 11.5; Property 8).
 *
 * A SecretStore holds a project's secret VALUES so they can be injected into the
 * Sandbox environment at runtime, while GUARANTEEING those values never land in
 * an exportable project tree and are never exposed by name-listing surfaces.
 *
 * THE STORAGE SPLIT (the core invariant, enforced structurally here):
 *   - Every secret VALUE is persisted at EXACTLY
 *       layout.controlSecretPath(ownerId, projectId, name)
 *     which the StorageLayout computes under `controlRoot` — always OUT-OF-TREE,
 *     never under `exportRoot/projects/`. Before every write we additionally
 *     call layout.assertOutsideExportTrees(path, 'secret'), so a value can NEVER
 *     be written inside an exportable project tree even if the layout changed.
 *   - list(projectId) returns NAMES only. ConnectorBinding.secretRefs are names
 *     only (see src/model/connector.js); this store mirrors that: values leave
 *     the store ONLY through get()/envForProject() for runtime env injection,
 *     never through any listing / export / committed surface.
 *
 * THE ENCRYPTION SEAM (deferral to Task 12.4 — DO NOT pull forward):
 *   Real envelope encryption / KMS (Encryption_At_Rest) is Task 12.4. This store
 *   writes through a pluggable `codec` seam { encode(value)->bytes, decode(bytes)
 *   ->value } that DEFAULTS to an identity/opaque passthrough (values are stored
 *   as UTF-8 bytes with no encryption). Task 12.4 slots a real envelope-encryption
 *   codec in HERE — same call sites, same on-disk path — without changing any
 *   caller. We deliberately do NOT force the value blob through createSecret
 *   (src/model/connector.js), whose Secret record forbids a plaintext `value` and
 *   requires ciphertext+wrappedDataKey; that encrypted record is the 12.4 shape.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';

/**
 * A secret NAME must be BOTH a safe single path segment (it becomes a filename
 * under controlSecretPath) AND a valid environment-variable name (it is injected
 * as a container env var). This shape rules out traversal, separators, and any
 * character an `-e NAME` reference could not carry.
 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * RESERVED / DANGEROUS env-var names a secret may NOT be stored under. The child
 * container env is built from stored secrets and merged OVER process.env (see
 * container-backend runOneShot/runCli), so a secret named after a runtime-critical
 * variable would silently SHADOW it inside the container. Rejecting these at
 * put() time keeps a secret from ever hijacking the loader, shell, or Node
 * runtime of a sandboxed process. Frozen so the set cannot be mutated at runtime.
 */
export const RESERVED_ENV_NAMES = Object.freeze(
  new Set([
    'PATH',
    'HOME',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'IFS',
    'SHELL',
    'PWD',
    'USER',
  ]),
);

function requireSecretName(model, name) {
  requireString(model, 'name', name);
  if (!ENV_NAME_RE.test(name)) {
    fail(
      model,
      `name must be a valid env-var name (^[A-Za-z_][A-Za-z0-9_]*$), got ${JSON.stringify(name)}`,
    );
  }
  if (RESERVED_ENV_NAMES.has(name)) {
    fail(
      model,
      `name ${JSON.stringify(name)} is a reserved/dangerous env-var that would shadow a runtime-critical variable in the container`,
    );
  }
  return name;
}

/**
 * The default codec: an identity/opaque passthrough. encode() turns the value
 * string into UTF-8 bytes; decode() turns bytes back into the value string. No
 * encryption happens here — that is Task 12.4, which replaces this codec.
 */
export const identityCodec = Object.freeze({
  encode(value) {
    return Buffer.from(String(value), 'utf8');
  },
  decode(bytes) {
    return Buffer.from(bytes).toString('utf8');
  },
});

/**
 * Create a SecretStore.
 *
 * @param {object} args
 * @param {object} args.layout        a StorageLayout (src/storage/layout.js)
 * @param {string} [args.ownerId]     the owning account id; defaults to 'default'
 *                                    when a single-tenant caller has no owner axis
 *                                    (the storage split is still enforced — the
 *                                    value simply lands under controlRoot/.../ownerId).
 * @param {object} [args.codec]       { encode(value)->bytes, decode(bytes)->value };
 *                                    defaults to identityCodec (Task 12.4 seam).
 * @returns {object} store (frozen)
 */
export function createSecretStore({ layout, ownerId = 'default', codec = identityCodec } = {}) {
  const model = 'SecretStore';
  if (!layout || typeof layout.controlSecretPath !== 'function' || typeof layout.assertOutsideExportTrees !== 'function') {
    fail(model, 'layout with controlSecretPath/assertOutsideExportTrees is required');
  }
  requireString(model, 'ownerId', ownerId);
  if (!codec || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
    fail(model, 'codec must expose encode(value)->bytes and decode(bytes)->value');
  }

  /** Resolve + assert the out-of-tree path for a project's secret. */
  function pathFor(projectId, name) {
    // controlSecretPath itself validates the id/name path-segment shape.
    const p = layout.controlSecretPath(ownerId, projectId, name);
    // Belt-and-braces: prove the value never lands inside an exportable tree.
    layout.assertOutsideExportTrees(p, 'secret');
    return p;
  }

  /** The directory that holds a project's secret files (out-of-tree). */
  function dirFor(projectId) {
    // Any valid name resolves under the same parent dir; borrow one to derive it.
    return path.dirname(layout.controlSecretPath(ownerId, projectId, 'PLACEHOLDER'));
  }

  /**
   * put(projectId, name, value): persist codec.encode(value) at the out-of-tree
   * path (creating parents). The value is written ONLY under controlRoot.
   */
  function put(projectId, name, value) {
    requireString(model, 'projectId', projectId);
    requireSecretName(model, name);
    if (typeof value !== 'string') {
      fail(model, 'value must be a string');
    }
    const p = pathFor(projectId, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, codec.encode(value));
    return { projectId, name, path: p };
  }

  /**
   * remove(projectId, name): delete the out-of-tree file. Idempotent — removing
   * a secret that does not exist is success.
   */
  function remove(projectId, name) {
    requireString(model, 'projectId', projectId);
    requireSecretName(model, name);
    const p = pathFor(projectId, name);
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // force:true already swallows ENOENT; ignore any residual error.
    }
    return { projectId, name, removed: true };
  }

  /**
   * get(projectId, name): read + codec.decode -> value. Returns null when the
   * secret does not exist. This value is for RUNTIME INJECTION ONLY — it must
   * never be written into an exported / committed surface.
   */
  function get(projectId, name) {
    requireString(model, 'projectId', projectId);
    requireSecretName(model, name);
    const p = pathFor(projectId, name);
    let bytes;
    try {
      bytes = fs.readFileSync(p);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    return codec.decode(bytes);
  }

  /**
   * has(projectId, name): whether a secret exists, WITHOUT decoding its value.
   */
  function has(projectId, name) {
    requireString(model, 'projectId', projectId);
    requireSecretName(model, name);
    return fs.existsSync(pathFor(projectId, name));
  }

  /**
   * list(projectId): NAMES only, never values. Derives names from the stored
   * filenames under the out-of-tree secrets dir. Returns [] when none exist.
   */
  function list(projectId) {
    requireString(model, 'projectId', projectId);
    const dir = dirFor(projectId);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((f) => f.endsWith('.enc'))
      .map((f) => f.slice(0, -'.enc'.length))
      .filter((n) => ENV_NAME_RE.test(n))
      .sort();
  }

  /**
   * envForProject(projectId): build the in-memory { NAME: value } map for the
   * Sandbox to inject at run time ONLY. It reads each stored value via the codec
   * and NEVER writes an env file into the mounted project tree. Returns a plain
   * object (not frozen) so the caller can merge it into a child `env`.
   */
  function envForProject(projectId) {
    requireString(model, 'projectId', projectId);
    const env = {};
    for (const name of list(projectId)) {
      const value = get(projectId, name);
      if (value !== null) env[name] = value;
    }
    return env;
  }

  return Object.freeze({
    ownerId,
    put,
    get,
    has,
    remove,
    list,
    envForProject,
  });
}
