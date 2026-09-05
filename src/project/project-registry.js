/**
 * project-registry.js — the control-plane ProjectRegistry (spec subtask 13.1,
 * Req 1, 7.3, 7.6).
 *
 * The ProjectRegistry is the authoritative, out-of-tree list of a User_Account's
 * Project records. It backs two things the ProjectManager and Builder Server
 * depend on:
 *
 *   - the QuotaManager `totalProjects` Resource_Quota — countForOwner(ownerId)
 *     is EXACTLY the projectCounter(accountId) seam that
 *     QuotaManager.checkQuota(account, null, 'totalProjects') expects; and
 *   - the Builder Server projectResolver / authorize() check — resolver(projectId)
 *     yields { id, ownerId } (or null) so the server can authorize a project
 *     touch without disclosing existence. Wiring this resolver as the server's
 *     projectResolver is the natural place the still-open "real projectResolver"
 *     review finding is satisfied (kept scoped here; the server change is
 *     strictly additive).
 *
 * WHERE STATE LIVES (the storage split, src/storage/layout.js): the registry is
 * CONTROL-PLANE metadata that must NEVER enter an exported project tree, so it
 * persists OUT-OF-TREE at layout.controlProjectRegistryPath(ownerId) — a
 * per-owner `projects.json`. Writes are ATOMIC (temp file + rename), mirroring
 * the SnapshotStore's saveRegistry so a crash can never leave a half-written
 * registry. Records ALWAYS round-trip through createProject (src/model/project.js)
 * so malformed data is rejected at the edge with a TypeError.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection
 * for the clock; the layout is the only I/O seam.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';
import { createProject } from '../model/project.js';

/**
 * Create a ProjectRegistry.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout exposing controlProjectRegistryPath(ownerId)
 * @param {() => string} [args.now]  injectable ISO-timestamp clock (reserved for callers)
 * @returns {object} registry (frozen)
 */
export function createProjectRegistry({ layout, now = () => new Date().toISOString() } = {}) {
  const model = 'ProjectRegistry';
  if (!layout || typeof layout.controlProjectRegistryPath !== 'function') {
    fail(model, 'layout with controlProjectRegistryPath(ownerId) is required');
  }
  if (typeof now !== 'function') fail(model, 'now must be a function returning an ISO timestamp');

  /** The out-of-tree registry path for an owner. */
  function pathFor(ownerId) {
    requireString(model, 'ownerId', ownerId);
    const p = layout.controlProjectRegistryPath(ownerId);
    // When the layout exposes the storage-split guard, prove the path is
    // out-of-tree (control-plane metadata can never enter an exported tree).
    if (typeof layout.assertOutsideExportTrees === 'function') {
      layout.assertOutsideExportTrees(p, 'project-registry');
    }
    return p;
  }

  /** Load an owner's registry (array of Project records) or [] when none. */
  function loadForOwner(ownerId) {
    const p = pathFor(ownerId);
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  /** Persist an owner's registry atomically (temp file + rename), out-of-tree. */
  function saveForOwner(ownerId, records) {
    const p = pathFor(ownerId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, p);
  }

  /**
   * register(project) — validate a Project through createProject (rejecting
   * malformed data with a TypeError) and persist it under its owner. Replaces an
   * existing record with the same id (idempotent re-register / update). Returns
   * the persisted, normalized record.
   *
   * @param {object} project  a Project-shaped input (must satisfy createProject)
   * @returns {object} the persisted Project record
   */
  function register(project) {
    // Round-trip through the model so malformed data is rejected at the edge.
    const record = createProject(project);
    const records = loadForOwner(record.ownerId);
    const idx = records.findIndex((r) => r && r.id === record.id);
    if (idx >= 0) records[idx] = record;
    else records.push(record);
    saveForOwner(record.ownerId, records);
    return record;
  }

  /**
   * get(projectId) — the Project record with this id, or null. Scans every
   * owner's registry (the registry is keyed by ownerId on disk, but get is
   * owner-agnostic so callers with only a projectId can resolve it).
   */
  function get(projectId) {
    requireString(model, 'projectId', projectId);
    for (const ownerId of listOwners()) {
      const rec = loadForOwner(ownerId).find((r) => r && r.id === projectId);
      if (rec) return rec;
    }
    return null;
  }

  /** listForOwner(ownerId) — every Project record owned by an account. */
  function listForOwner(ownerId) {
    requireString(model, 'ownerId', ownerId);
    return loadForOwner(ownerId);
  }

  /**
   * countForOwner(ownerId) — the number of Projects an account owns. This is
   * EXACTLY the projectCounter(accountId) seam QuotaManager.checkQuota expects
   * for the 'totalProjects' Resource_Quota.
   */
  function countForOwner(ownerId) {
    requireString(model, 'ownerId', ownerId);
    return loadForOwner(ownerId).length;
  }

  /**
   * resolver(projectId) — resolve a projectId to the shape the Builder Server's
   * projectResolver / authorize() consumes: { id, ownerId } or null. Returning
   * null denies WITHOUT disclosure at the server's gate.
   */
  function resolver(projectId) {
    const rec = get(projectId);
    return rec ? { id: rec.id, ownerId: rec.ownerId } : null;
  }

  /** Enumerate owner ids that currently have a registry file on disk. */
  function listOwners() {
    // controlProjectRegistryPath(ownerId) => <controlRoot>/registry/<ownerId>/projects.json
    // so the parent of the per-owner file's directory is the registry root.
    let sampleDir;
    try {
      sampleDir = path.dirname(path.dirname(layout.controlProjectRegistryPath('__probe__')));
    } catch {
      return [];
    }
    let entries;
    try {
      entries = fs.readdirSync(sampleDir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  return Object.freeze({
    register,
    get,
    listForOwner,
    countForOwner,
    resolver,
  });
}
