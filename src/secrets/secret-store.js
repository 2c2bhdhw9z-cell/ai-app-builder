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
 * THE ENCRYPTION SEAM (Task 12.4 — Encryption_At_Rest):
 *   This store writes through a pluggable `codec` seam { encode(value)->bytes,
 *   decode(bytes)->value } that DEFAULTS to an identity/opaque passthrough
 *   (values stored as UTF-8 bytes, for tests / back-compat). Real envelope
 *   encryption / KMS now exists as createEnvelopeCodec({ kms }) (see
 *   src/secrets/envelope-codec.js + src/secrets/kms.js) and slots into THIS same
 *   seam — same call sites, same on-disk `.enc` path — without changing any
 *   caller. When the envelope codec is injected the on-disk bytes are ciphertext
 *   plus a KMS-wrapped data key, from which the plaintext is unrecoverable
 *   without the master key. We deliberately do NOT force the value blob through
 *   createSecret (src/model/connector.js), whose Secret record forbids a
 *   plaintext `value`; the codec produces opaque bytes satisfying the same
 *   ciphertext+wrappedDataKey shape conceptually.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';
import { AUDIT_EVENTS, toAuditSink } from '../auth/audit.js';

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
 * @param {Function|{record:Function}} [args.auditSink]  OPTIONAL audit-sink seam
 *        (Task 12.6 / Req 25.1). When injected, reading a secret VALUE for
 *        injection (get/envForProject) records an AUDIT_EVENTS.SECRET_ACCESS
 *        event carrying { accountId(=ownerId), projectId, name } — the NAME
 *        ONLY, never the value. Optional and back-compatible: with no sink,
 *        every existing call site and test behaves exactly as before.
 * @returns {object} store (frozen)
 */
export function createSecretStore({ layout, ownerId = 'default', codec = identityCodec, auditSink } = {}) {
  const model = 'SecretStore';
  if (!layout || typeof layout.controlSecretPath !== 'function' || typeof layout.assertOutsideExportTrees !== 'function') {
    fail(model, 'layout with controlSecretPath/assertOutsideExportTrees is required');
  }
  requireString(model, 'ownerId', ownerId);
  if (!codec || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
    fail(model, 'codec must expose encode(value)->bytes and decode(bytes)->value');
  }

  // Optional audit seam: normalize into a record(event) fn (no-op when absent).
  // Never carries a secret VALUE — only accountId + projectId + secret NAME.
  const emitAudit = toAuditSink(auditSink);

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
   * The directory that holds ALL of this owner's secret files across every
   * project (out-of-tree). It is the parent of every dirFor(projectId), derived
   * from a placeholder project path so the shape stays in sync with the layout.
   */
  function ownerDir() {
    return path.dirname(dirFor('PLACEHOLDER'));
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
    const value = codec.decode(bytes);
    // A secret VALUE is being read for runtime injection — the one moment that
    // is auditable (Req 25.1 'Secret access'). Record NAME only, never value.
    emitAudit({
      type: AUDIT_EVENTS.SECRET_ACCESS,
      accountId: ownerId,
      projectId,
      name,
    });
    return value;
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

  /**
   * deleteProjectSecrets(projectId): remove EVERY stored secret for a project
   * (Task 12.3 / Req 24.3 project deletion). Enumerates list(projectId) and
   * removes each, then removes the project's out-of-tree secrets directory so no
   * residue (or stray non-secret file) survives. Idempotent — deleting a project
   * with no secrets is success. Returns a structured summary.
   */
  function deleteProjectSecrets(projectId) {
    requireString(model, 'projectId', projectId);
    const removed = list(projectId);
    for (const name of removed) {
      remove(projectId, name);
    }
    // Drop the whole project secrets dir (idempotent; force swallows ENOENT).
    const dir = dirFor(projectId);
    layout.assertOutsideExportTrees(dir, 'secret-dir');
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, projectId, ownerId, removed };
  }

  /**
   * deleteAccountData(userAccountId): remove ALL secrets owned by this store's
   * account (Task 12.3 / Req 24.4 account deletion). This store is ownerId-
   * scoped, so it removes the owner's entire out-of-tree secrets subtree under
   * controlRoot. The userAccountId argument must match this store's ownerId (a
   * mismatch is a caller error, not a silent no-op, so an account's data is
   * never left behind by deleting the wrong owner). Idempotent. Returns a
   * structured summary.
   */
  function deleteAccountData(userAccountId) {
    requireString(model, 'userAccountId', userAccountId);
    if (userAccountId !== ownerId) {
      fail(
        model,
        `deleteAccountData: userAccountId ${JSON.stringify(userAccountId)} does not match this store's ownerId ${JSON.stringify(ownerId)}`,
      );
    }
    const dir = ownerDir();
    layout.assertOutsideExportTrees(dir, 'owner-secrets-dir');
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, ownerId };
  }

  return Object.freeze({
    ownerId,
    put,
    get,
    has,
    remove,
    list,
    envForProject,
    deleteProjectSecrets,
    deleteAccountData,
  });
}
