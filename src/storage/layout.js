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
   * The project registry entry for an owner. Keyed by ownerId so the registry
   * is filterable per account (three-axis isolation, Req 7.6).
   */
  controlProjectRegistryPath(ownerId) {
    requireId('ownerId', ownerId);
    return path.join(this.controlRoot, REGISTRY_DIR, ownerId, 'projects.json');
  }

  /** ShareLink storage for an owner (control-plane only, Req 26). */
  controlShareLinkPath(ownerId, token) {
    requireId('ownerId', ownerId);
    requireId('token', token);
    return path.join(this.controlRoot, SHARE_LINKS_DIR, ownerId, `${token}.json`);
  }

  /** ConnectorBinding storage for an owner's project (secret NAMES only). */
  controlConnectorBindingPath(ownerId, projectId) {
    requireId('ownerId', ownerId);
    requireId('projectId', projectId);
    return path.join(this.controlRoot, BINDINGS_DIR, ownerId, `${projectId}.json`);
  }

  /**
   * Secret VALUE (ciphertext) storage for an owner's project + secret name.
   * ALWAYS out-of-tree: computed under controlRoot, never under exportRoot.
   */
  controlSecretPath(ownerId, projectId, secretName) {
    requireId('ownerId', ownerId);
    requireId('projectId', projectId);
    requireId('secretName', secretName);
    return path.join(
      this.controlRoot,
      SECRETS_DIR,
      ownerId,
      projectId,
      `${secretName}.enc`,
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
    return path.join(this.controlRoot, SNAPSHOTS_DIR, ownerId, `${projectId}.json`);
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

function requireId(field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`storage layout: ${field} must be a non-empty string`);
  }
  // A path-segment id must not smuggle separators or traversal.
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('..')) {
    throw new TypeError(`storage layout: ${field} must be a single safe path segment, got ${JSON.stringify(value)}`);
  }
}
