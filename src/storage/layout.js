/**
 * THE STORAGE SPLIT.
 *
 * ai-app-builder stores two categories of state in two physically separate
 * roots so that exportable state and control-plane metadata can never overlap:
 *
 *   (1) EXPORTABLE — human-readable files-on-disk that live INSIDE a Project's
 *       tree and are what an export/download produces: project source files,
 *       project memory (human-readable), and skills (SKILL.md). Rooted under
 *       `exportRoot/projects/<projectId>/`.
 *
 *   (2) CONTROL-PLANE — out-of-tree metadata that must NEVER enter an exported
 *       tree: the project registry, share links, connector bindings, and secret
 *       values (ciphertext). Rooted under `controlRoot/` and keyed/filterable by
 *       ownerId (three-axis isolation, Req 7.6).
 *
 * THE INVARIANT (Req 9.7, 10.4, Properties 8, 9, 14): every control-plane /
 * secret path resolves OUTSIDE every Project's exportable tree. This module
 * makes that structural — `exportRoot` and `controlRoot` are sibling directories
 * with neither an ancestor of the other — and `isInsideExportTree()` /
 * `assertOutsideExportTrees()` let callers and tests prove it. Because a secret
 * value's storage location is computed here and always lands under `controlRoot`,
 * it can never fall inside an exported project tree.
 *
 * Real encryption at rest and a full persistence engine are later tasks (12.4);
 * this module defines only the path layout and the no-overlap guarantee, which
 * are real and tested.
 */

import path from 'node:path';

/** Subdirectory (under exportRoot) that holds all exportable project trees. */
const PROJECTS_DIR = 'projects';

/** Control-plane subdirectories, all under controlRoot (out of every tree). */
const REGISTRY_DIR = 'registry'; // project registry, keyed by ownerId
const SHARE_LINKS_DIR = 'share-links'; // ShareLink records, keyed by ownerId
const BINDINGS_DIR = 'connector-bindings'; // ConnectorBinding records
const SECRETS_DIR = 'secrets'; // Secret ciphertext (out-of-tree only)
const SNAPSHOTS_DIR = 'snapshots'; // Snapshot registry/metadata (out-of-tree only)
const USER_SKILLS_DIR = 'user-skills'; // per-owner User_Skill library (out-of-tree)

/**
 * Create a storage layout rooted at `baseDir`. `exportRoot` and `controlRoot`
 * are siblings under `baseDir`, guaranteeing neither contains the other.
 *
 * @param {string} baseDir absolute base directory for this platform instance
 */
export function createStorageLayout(baseDir) {
  if (typeof baseDir !== 'string' || baseDir.trim() === '') {
    throw new TypeError('createStorageLayout: baseDir must be a non-empty string');
  }
  const root = path.resolve(baseDir);
  // Two sibling roots. Distinct top-level names ⇒ neither is an ancestor of the
  // other, which is the structural basis of the storage split.
  const exportRoot = path.join(root, 'export');
  const controlRoot = path.join(root, 'control-plane');

  return new StorageLayout(root, exportRoot, controlRoot);
}

class StorageLayout {
  constructor(root, exportRoot, controlRoot) {
    this.root = root;
    /** EXPORTABLE root — everything under here is exportable, files-on-disk. */
    this.exportRoot = exportRoot;
    /** CONTROL-PLANE root — out-of-tree; never exported. */
    this.controlRoot = controlRoot;
  }

  // --- EXPORTABLE (inside a project tree) ---------------------------------

  /** Absolute path to a Project's exportable tree (source files live here). */
  exportableProjectTree(projectId) {
    requireId('projectId', projectId);
    return path.join(this.exportRoot, PROJECTS_DIR, projectId);
  }

  /** Human-readable project memory, inside the exportable tree. */
  exportableMemoryPath(projectId) {
    return path.join(this.exportableProjectTree(projectId), '.memory');
  }

  /** Skills (SKILL.md dirs), inside the exportable tree. */
  exportableSkillsPath(projectId) {
    return path.join(this.exportableProjectTree(projectId), '.skills');
  }

  // --- CONTROL-PLANE (out of every project tree) --------------------------

  /**
   * The project-registry ROOT directory (control-plane, out of every tree).
   * Owner subdirectories live directly beneath it. Exposed explicitly so the
   * ProjectRegistry can enumerate owners and derive per-owner/per-project paths
   * WITHOUT reverse-engineering the path shape from a sentinel ownerId.
   */
  controlProjectRegistryRoot() {
    return path.join(this.controlRoot, REGISTRY_DIR);
  }

  /**
   * The project registry entry for an owner. Keyed by ownerId so the registry
   * is filterable per account (three-axis isolation, Req 7.6).
   */
  controlProjectRegistryPath(ownerId) {
    requireId('ownerId', ownerId);
    // L9: prove-by-construction that a control-plane path never lands inside an
    // exportable project tree, rather than relying on the split holding only
    // structurally. Self-applying the invariant here makes it impossible for a
    // control path builder to return an in-tree location undetected.
    return this.assertOutsideExportTrees(
      path.join(this.controlRoot, REGISTRY_DIR, ownerId, 'projects.json'),
      'controlProjectRegistryPath',
    );
  }

  /** ShareLink storage for an owner (control-plane only, Req 26). */
  controlShareLinkPath(ownerId, token) {
    requireId('ownerId', ownerId);
    requireId('token', token);
    return this.assertOutsideExportTrees(
      path.join(this.controlRoot, SHARE_LINKS_DIR, ownerId, `${token}.json`),
      'controlShareLinkPath',
    );
  }

  /** ConnectorBinding storage for an owner's project (secret NAMES only). */
  controlConnectorBindingPath(ownerId, projectId) {
    requireId('ownerId', ownerId);
    requireId('projectId', projectId);
    return this.assertOutsideExportTrees(
      path.join(this.controlRoot, BINDINGS_DIR, ownerId, `${projectId}.json`),
      'controlConnectorBindingPath',
    );
  }

  /**
   * Secret VALUE (ciphertext) storage for an owner's project + secret name.
   * ALWAYS out-of-tree: computed under controlRoot, never under exportRoot.
   */
  controlSecretPath(ownerId, projectId, secretName) {
    requireId('ownerId', ownerId);
    requireId('projectId', projectId);
    requireId('secretName', secretName);
    return this.assertOutsideExportTrees(
      path.join(this.controlRoot, SECRETS_DIR, ownerId, projectId, `${secretName}.enc`),
      'controlSecretPath',
    );
  }

  /**
   * Snapshot REGISTRY / metadata for an owner's project. This is the list of
   * committed Snapshot records ({ id: gitSha, createdAt, trigger, parentId }),
   * NOT the file bytes: the file bytes and the project's Git repository (.git)
   * live INSIDE the exportable project tree (exportableProjectTree), because
   * that IS "the Project's repository" per Req 19.9 and is what an export
   * produces. The registry, by contrast, is control-plane bookkeeping that must
   * never enter an exported tree, so it resolves OUT-OF-TREE under controlRoot
   * (asserted with assertOutsideExportTrees at the call sites).
   */
  controlSnapshotRegistryPath(ownerId, projectId) {
    requireId('ownerId', ownerId);
    requireId('projectId', projectId);
    return this.assertOutsideExportTrees(
      path.join(this.controlRoot, SNAPSHOTS_DIR, ownerId, `${projectId}.json`),
      'controlSnapshotRegistryPath',
    );
  }

  /**
   * The per-owner User_Skill library ROOT (control-plane, out of every tree).
   * User_Skills are per-User_Account (Req 13.3) — not per-project — so they are
   * keyed by ownerId here and made available to all of the owner's Projects by
   * the Skill Library, rather than living inside any single exportable tree.
   * Each skill is stored as an open Agent Skills SKILL.md dir beneath this root
   * (`<root>/<dirName>/SKILL.md`), so the tree stays loadable by plumby's
   * loader (Req 13.9) and portable to other Agent Skills tools (Property 19).
   * It resolves OUT-OF-TREE (asserted) so a User_Skill library can never leak
   * into an exported project tree.
   */
  controlUserSkillsRoot(ownerId) {
    requireId('ownerId', ownerId);
    return this.assertOutsideExportTrees(
      path.join(this.controlRoot, USER_SKILLS_DIR, ownerId),
      'controlUserSkillsRoot',
    );
  }

  // --- INVARIANT HELPERS --------------------------------------------------

  /**
   * True when `candidate` is inside SOME project's exportable tree (i.e. under
   * `exportRoot/projects/`). Uses path.relative so `..` segments cannot escape.
   */
  isInsideExportTree(candidate) {
    const projectsRoot = path.join(this.exportRoot, PROJECTS_DIR);
    return isInside(projectsRoot, candidate);
  }

  /**
   * Assert `candidate` resolves OUTSIDE every exportable project tree. Throws a
   * clear error otherwise. This is the guard that proves a secret/control-plane
   * location can never fall inside an exported project tree.
   */
  assertOutsideExportTrees(candidate, label = 'path') {
    if (this.isInsideExportTree(candidate)) {
      throw new Error(
        `storage-split violation: ${label} (${candidate}) resolves inside an exportable project tree`,
      );
    }
    return candidate;
  }
}

/** True when `candidate` is `root` or a descendant of it. */
function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true; // the root itself
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Ids that would poison a plain-object index via the prototype chain (L7). */
const DANGEROUS_ID_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function requireId(field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`storage layout: ${field} must be a non-empty string`);
  }
  // A NUL byte (L8): passes the separator checks but makes fs throw
  // ERR_INVALID_ARG_VALUE deep in a store (a leaked 500). Reject it here.
  if (value.includes('\0')) {
    throw new TypeError(`storage layout: ${field} must not contain a NUL byte`);
  }
  // Prototype-pollution keys (L7): a projectId of '__proto__' etc. would index
  // through Object.prototype in a plain-object map (truthy, non-string), so a
  // client-supplied id turned into a thrown TypeError / dropped write instead of
  // a clean miss. Reject them as ids outright.
  if (DANGEROUS_ID_KEYS.has(value)) {
    throw new TypeError(`storage layout: ${field} must not be a reserved object key, got ${JSON.stringify(value)}`);
  }
  // A path-segment id must not smuggle separators or traversal. We reject a
  // literal '.'/'..' segment and any actual traversal component, but do NOT
  // reject a harmless '..' SUBSTRING inside a normal name like 'my..app' (L8):
  // split on the path separators and check for a '..' component instead.
  if (value.includes('/') || value.includes('\\')) {
    throw new TypeError(`storage layout: ${field} must be a single safe path segment, got ${JSON.stringify(value)}`);
  }
  if (value === '.' || value === '..') {
    throw new TypeError(`storage layout: ${field} must be a single safe path segment, got ${JSON.stringify(value)}`);
  }
  // Windows drive/reserved token (L8): 'C:' would not stay under the root on
  // win32. Reject a colon anywhere (never valid in our ids).
  if (value.includes(':')) {
    throw new TypeError(`storage layout: ${field} must not contain a drive/colon token, got ${JSON.stringify(value)}`);
  }
}
