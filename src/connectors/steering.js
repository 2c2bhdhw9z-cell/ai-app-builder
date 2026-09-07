/**
 * THE CONNECTORS STEERING WRITER (spec Task 21.1, Req 10.5, 11.4).
 *
 * When a Connector is added to a Project, the Builder_Agent must be made aware
 * of it so it generates integration code that references the injected Secret
 * env-var NAME — never a literal credential and never a hardcoded platform host
 * (Req 10.5, 11.4). The surface for this is plumby's steering mechanism:
 * loadSteeringFiles(cwd) reads `.plumby/steering/*.md` from the project's
 * working directory and folds them into the Builder_Agent's system prompt.
 *
 * This writer maintains a single human-readable `.plumby/steering/connectors.md`
 * inside the project's EXPORTABLE tree (layout.exportableProjectTree(projectId)),
 * listing every ACTIVE connector with the env-var NAME(s) to reference. It NEVER
 * writes a credential value — only names. The steering dir is the plumby-defined
 * relative path `.plumby/steering`; since that path is a stable relative string
 * we hardcode it here (matching plumby's STEERING_DIR) rather than importing
 * plumby, keeping the plumby boundary (src/engine/plumby.js) untouched.
 *
 * The manifest is regenerated from the CURRENT active-connector set on every
 * write, so adding a connector adds its block and removing one drops it (Req
 * 10.7). When no active connectors remain, the manifest file is removed so the
 * Builder_Agent is no longer told to reference a connector that is gone.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';

/**
 * The plumby steering directory, relative to a project's working directory.
 * Mirrors plumby's STEERING_DIR (src/cli/project_context.js). Kept as a local
 * constant so this writer needs no plumby import (the boundary stays clean).
 */
export const STEERING_DIR = path.join('.plumby', 'steering');

/** The single connectors manifest file name within the steering dir. */
export const CONNECTORS_MANIFEST_FILE = 'connectors.md';

/**
 * Render the connectors manifest markdown from a list of active connectors.
 * Each connector contributes a section naming its env-var NAME(s). NO credential
 * value ever appears — only names — which is the reference-by-NAME mechanism
 * (Req 10.5, 11.4). An empty list renders null (the caller removes the file).
 *
 * @param {Array<{service,category,envNames:string[]}>} connectors
 * @returns {string|null}
 */
export function renderConnectorsManifest(connectors) {
  const active = Array.isArray(connectors) ? connectors : [];
  if (active.length === 0) return null;

  const lines = [];
  lines.push('# Connectors');
  lines.push('');
  lines.push(
    'This project has managed Connectors. When you generate or edit integration',
  );
  lines.push(
    'code for a Connector, reference its credential(s) ONLY through the injected',
  );
  lines.push(
    'environment variable NAME(s) listed below (e.g. `process.env.NAME`). NEVER',
  );
  lines.push(
    'write a literal credential value or a hardcoded platform host into a source',
  );
  lines.push(
    'file — the credentials are injected into the Sandbox environment at runtime.',
  );
  lines.push('');

  for (const c of [...active].sort((a, b) => a.service.localeCompare(b.service))) {
    lines.push(`## ${c.service} (${c.category})`);
    lines.push('');
    lines.push('Reference these environment variables (never their values):');
    lines.push('');
    for (const name of c.envNames) {
      lines.push(`- \`${name}\``);
    }
    lines.push('');
  }

  return `${lines.join('\n')}`.trimEnd() + '\n';
}

/**
 * Create the steering writer.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout — supplies exportableProjectTree(projectId).
 * @returns {object} writer (frozen)
 */
export function createConnectorsSteeringWriter({ layout } = {}) {
  const model = 'ConnectorsSteeringWriter';
  if (!layout || typeof layout.exportableProjectTree !== 'function') {
    fail(model, 'layout with exportableProjectTree(projectId) is required');
  }

  /** Absolute path to the project's connectors steering manifest. */
  function manifestPathFor(projectId) {
    requireString(model, 'projectId', projectId);
    return path.join(layout.exportableProjectTree(projectId), STEERING_DIR, CONNECTORS_MANIFEST_FILE);
  }

  /**
   * write(projectId, connectors): regenerate the connectors manifest from the
   * CURRENT active-connector set. Writes the file (creating `.plumby/steering/`)
   * when there is at least one active connector; removes the file when the set is
   * empty. Returns { projectId, path, written:boolean, removed:boolean }.
   */
  function write(projectId, connectors) {
    requireString(model, 'projectId', projectId);
    const absPath = manifestPathFor(projectId);
    const body = renderConnectorsManifest(connectors);

    if (body === null) {
      // No active connectors — drop the manifest so nothing stale is surfaced.
      try {
        fs.rmSync(absPath, { force: true });
      } catch {
        /* best-effort removal */
      }
      return { projectId, path: absPath, written: false, removed: true };
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const tmp = `${absPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, Buffer.from(body, 'utf8'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, absPath);
    return { projectId, path: absPath, written: true, removed: false };
  }

  return Object.freeze({
    manifestPathFor,
    write,
  });
}
