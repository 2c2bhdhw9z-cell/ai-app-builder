/**
 * PROJECT_EXPORT (spec Task 27.1, Req 11.6, 11.7, 11.8, 11.9).
 *
 * createProjectExport produces a SELF-CONTAINED copy of a Project's full file
 * state that builds and runs OUTSIDE the platform with a Standard_Toolchain,
 * requiring NO platform account and NO network to a platform-controlled host,
 * within a 300s SLO for a Project within the configured file-count limit.
 *
 * ─── WHAT THE EXPORT COPIES (Req 11.6) ───────────────────────────────────
 * The Project's exportable file state is EXACTLY what lives inside
 * layout.exportableProjectTree(projectId) — that directory IS the Project's
 * repository (Req 19.9). We read it back with the SAME on-disk read + text/
 * binary contract the PersistenceStore uses (readPersistedTree +
 * tree-codec.decodeTreeEntry): text round-trips as a utf8 String, binary as a
 * Buffer, and the project's Git repo (.git) is NEVER read as a tree file. The
 * export never reaches into layout.controlRoot — secrets, connector bindings,
 * and every other control-plane record live OUT-OF-TREE by construction (see
 * src/storage/layout.js), so they cannot enter an export tree.
 *
 * ─── NO PLATFORM ACCOUNT / NO NETWORK TO A PLATFORM HOST (Req 11.6) ───────
 * This is enforced STRUCTURALLY, not by a runtime probe: the exported tree
 * contains ONLY the (credential-stripped) project files plus an env-var
 * template. It references no platform-host literal (the generation guardrail
 * rewrites any such literal to a `process.env.PLATFORM_HOST` reference), embeds
 * no credential, and needs no platform account to build with a Standard_Toolchain
 * (the generated templates are stdlib-only, dependencies:{}, offline baseline).
 * We do NOT attempt any live network / clone / deploy here.
 *
 * ─── CREDENTIAL NON-LEAKAGE (Req 11.8) ───────────────────────────────────
 * Secrets and Connector credentials are referenced by NAME and injected at
 * runtime; their VALUES live out-of-tree and never enter the exportable tree
 * (the PRIMARY mechanism, Req 11.4). As a SECONDARY safety net (Req 11.5) the
 * export runs src/secrets/generation-guardrail.js scanAndSubstitute over the
 * read tree, using the Project's known secret VALUES (as needles only) and the
 * known platform/connector hosts; any literal that WOULD have leaked is
 * rewritten into an env-var reference and recorded in a substitution report. The
 * secret VALUES are used ONLY as guardrail needles and are NEVER written into
 * the exported tree. The export then emits an env-var TEMPLATE listing every
 * required variable NAME with NO value.
 *
 * ─── ABORT-ON-FAILURE RETAINS STORED STATE UNCHANGED (Req 11.7) ───────────
 * The export is READ-ONLY with respect to the Project's stored state: it reads
 * exportableProjectTree and writes ONLY to a separate export destination (a
 * caller-supplied dir or an fs.mkdtemp temp dir). On ANY failure (file-count
 * exceeded, timeout, read/copy/guardrail error) it returns a structured
 * { ok:false, code, message, cause? }, cleans up any partial export output, and
 * leaves the Project's stored tree byte-for-byte UNCHANGED. It never mutates the
 * source tree.
 *
 * ─── SLOs MEASURED AGAINST THE INJECTED CLOCK (Req 11.6) ──────────────────
 * The 300s budget is measured against the injected `now()` clock, NEVER a real
 * wait. If the measured duration exceeds `exportTimeoutMs` the export ABORTS
 * with EXPORT_TIMEOUT (partial output cleaned up).
 *
 * Conventions: a composing factory createProjectExport({...deps}) returning
 * Object.freeze({...}); dependency injection for the clock (`now`) and every
 * collaborator/sink; structured { ok:true|false, code, message } results for
 * expected failures (never throw on a handled failure path). Node stdlib only;
 * no new dependency; imports NO plumby package (the boundary invariant).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { requireString, requireNumber, fail } from '../model/validate.js';
import { decodeTreeEntry } from '../persistence/tree-codec.js';
import { scanAndSubstitute, PLATFORM_HOST_ENV_NAME } from '../secrets/generation-guardrail.js';
import {
  DEFAULT_FILE_COUNT_LIMIT,
  requireFileCountLimit,
  checkFileCount,
} from './file-count.js';

/** The 300s Project_Export SLO (Req 11.6). Measured against the injected clock. */
export const EXPORT_SLO_MS = 300_000;

/** The env-var template filename written at the export root (Req 11.8). */
export const ENV_TEMPLATE_FILENAME = '.env.template';

/** A monotonic-ish default clock (ms). Overridable for deterministic tests. */
function defaultNow() {
  return Date.now();
}

/**
 * The default read seam: walk the on-disk exportable project tree and return a
 * { relPath: contents } map, using the SAME semantics as
 * PersistenceStore.readPersistedTree — text decodes to a utf8 String, binary to
 * a Buffer, and the project's Git repo (.git) is NEVER read as a tree file.
 * Returns {} when nothing has been persisted yet.
 */
function defaultReadTree(root) {
  const tree = {};
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const ent of ents) {
      if (ent.name === '.git') continue; // SnapshotStore's repo, not a tree file
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        tree[rel] = decodeTreeEntry(fs.readFileSync(full));
      }
    }
  };
  walk(root);
  return tree;
}

/**
 * The default export materializer: write the (credential-stripped) tree map +
 * the env-var template into `destDir`. A string entry is written utf8, a Buffer
 * raw — symmetric with the PersistenceStore write path. Throws on any I/O error
 * (the caller converts it into a structured abort AND cleans up partial output).
 */
function defaultWriteExport(destDir, treeMap, envTemplate) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const [rel, contents] of Object.entries(treeMap)) {
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
    fs.writeFileSync(dest, buf);
  }
  fs.writeFileSync(path.join(destDir, ENV_TEMPLATE_FILENAME), Buffer.from(envTemplate, 'utf8'));
}

/**
 * Render the env-var TEMPLATE text (Req 11.8): every required variable NAME with
 * NO accompanying value. We emit `NAME=` lines (sorted, de-duplicated) so a user
 * can fill in values, plus a header comment. Deliberately NO values are written.
 *
 * @param {string[]} names  the required env-var names (already collected)
 * @returns {string} the template file body
 */
function renderEnvTemplate(names) {
  const unique = [...new Set(names)].sort();
  const header = [
    '# Environment variables required by this exported project.',
    '# Each Secret and Connector credential is referenced by NAME and injected',
    '# at runtime; fill in a value for each below. No values are exported here',
    '# (credential non-leakage, Requirement 11.8).',
    '',
  ];
  const lines = unique.map((name) => `${name}=`);
  return `${[...header, ...lines].join('\n')}\n`;
}

/**
 * Best-effort recursive cleanup of a partial export destination we created.
 * Never throws — a failed cleanup must not mask the original abort cause.
 */
function cleanupDest(destDir) {
  try {
    fs.rmSync(destDir, { recursive: true, force: true });
  } catch {
    /* best-effort: a failed cleanup must never mask the abort cause */
  }
}

/**
 * Create a Project_Export factory.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout (src/storage/layout.js) — supplies
 *        exportableProjectTree(projectId), the exportable state to copy.
 * @param {() => number} [args.now]           injectable clock (ms) for the SLO.
 * @param {number} [args.fileCountLimit]      configurable maximum file-count (default 10,000, Req 11.9).
 * @param {number} [args.exportTimeoutMs]     the export SLO budget (default 300000, Req 11.6).
 * @param {(root: string) => Object<string,string|Buffer>} [args.readTree]
 *        injectable read seam (default walks the on-disk exportable tree with the
 *        PersistenceStore text/binary contract).
 * @param {(destDir: string, treeMap: object, envTemplate: string) => void} [args.writeExport]
 *        injectable export materializer (default writes files + the env template
 *        to destDir). A failing writer drives the abort-on-failure path.
 * @param {object} [args.connectorCatalog]  a Connector_Catalog (src/connectors/catalog.js)
 *        for the platform/connector hosts (guardrail needles) and the connector
 *        credential env-var NAMES (env template). Optional.
 * @returns {object} the frozen export factory
 */
export function createProjectExport({
  layout,
  now = defaultNow,
  fileCountLimit = DEFAULT_FILE_COUNT_LIMIT,
  exportTimeoutMs = EXPORT_SLO_MS,
  readTree = defaultReadTree,
  writeExport = defaultWriteExport,
  connectorCatalog = null,
} = {}) {
  const model = 'ProjectExport';
  if (!layout || typeof layout.exportableProjectTree !== 'function') {
    fail(model, 'layout with exportableProjectTree is required');
  }
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');
  requireFileCountLimit(model, fileCountLimit);
  requireNumber(model, 'exportTimeoutMs', exportTimeoutMs);
  if (exportTimeoutMs <= 0) fail(model, 'exportTimeoutMs must be a positive number of ms');
  if (typeof readTree !== 'function') fail(model, 'readTree must be a function');
  if (typeof writeExport !== 'function') fail(model, 'writeExport must be a function');
  if (
    connectorCatalog !== null &&
    (typeof connectorCatalog !== 'object' || typeof connectorCatalog.list !== 'function')
  ) {
    fail(model, 'connectorCatalog, when provided, must be a Connector_Catalog with list()');
  }

  /**
   * The platform/connector hosts the guardrail rewrites to a PLATFORM_HOST env
   * reference: the caller-supplied platformHosts UNION every catalog endpoint
   * host. De-duplicated, non-empty strings only.
   */
  function collectPlatformHosts(extraHosts) {
    const hosts = new Set();
    if (connectorCatalog) {
      for (const entry of connectorCatalog.list()) {
        for (const h of entry.hosts ?? []) {
          if (typeof h === 'string' && h !== '') hosts.add(h);
        }
      }
    }
    for (const h of extraHosts) {
      if (typeof h === 'string' && h !== '') hosts.add(h);
    }
    return [...hosts];
  }

  /**
   * The connector credential env-var NAMES from the catalog (names only). These
   * join the Project's Secret names in the env template.
   */
  function catalogEnvNames() {
    const names = [];
    if (connectorCatalog) {
      for (const entry of connectorCatalog.list()) {
        for (const n of entry.envNames ?? []) {
          if (typeof n === 'string' && n !== '') names.push(n);
        }
      }
    }
    return names;
  }

  /**
   * export(projectId, options): produce a self-contained export.
   *
   * @param {string} projectId
   * @param {object} [options]
   * @param {string} [options.destDir]  where to write the export. Defaults to a
   *        fresh fs.mkdtemp temp dir (always SEPARATE from the source tree).
   * @param {Object<string,string>} [options.secretEnv]  { NAME: value } map of the
   *        Project's known secret VALUES (e.g. SecretStore.envForProject(projectId)).
   *        Used ONLY as guardrail needles; VALUES are NEVER written into the export.
   * @param {string[]} [options.secretNames]  the Project's Secret NAMES (e.g.
   *        SecretStore.list(projectId)) for the env template. Defaults to the keys
   *        of secretEnv when omitted.
   * @param {string[]} [options.connectorEnvNames]  extra connector credential env
   *        NAMES for the template (e.g. from ConnectorBinding.secretRefs).
   * @param {string[]} [options.platformHosts]  extra platform-host literals to
   *        rewrite (joined with the catalog hosts).
   * @returns {{ ok:true, ... } | { ok:false, code, message, cause? }}
   */
  function exportProject(projectId, options = {}) {
    requireString(model, 'projectId', projectId);
    if (options === null || typeof options !== 'object') {
      fail(model, 'options must be an object');
    }
    const secretEnv = options.secretEnv ?? {};
    if (secretEnv === null || typeof secretEnv !== 'object' || Array.isArray(secretEnv)) {
      fail(model, 'secretEnv must be a { NAME: value } map');
    }
    const secretNames = Array.isArray(options.secretNames)
      ? options.secretNames
      : Object.keys(secretEnv);
    const connectorEnvNames = Array.isArray(options.connectorEnvNames)
      ? options.connectorEnvNames
      : [];
    const extraHosts = Array.isArray(options.platformHosts) ? options.platformHosts : [];

    // The source tree we read (never mutated) and a SEPARATE export destination.
    const sourceRoot = layout.exportableProjectTree(projectId);
    let destDir = options.destDir;
    let createdTempDest = false;
    if (destDir === undefined) {
      destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-export-'));
      createdTempDest = true;
    } else {
      requireString(model, 'destDir', destDir);
    }

    const start = now();

    /** Abort helper: clean up any partial output we created, then return cause. */
    const abort = (code, message, cause) => {
      // Clean up partial export output. When WE created the temp dest, remove it
      // wholesale; when the caller supplied a dest, best-effort remove it so no
      // half-written export is left behind (the export owns its destination).
      cleanupDest(destDir);
      const result = { ok: false, projectId, code, message };
      if (cause !== undefined) result.cause = cause;
      return result;
    };

    // (1) Read the Project's full exportable file state (read-only).
    let tree;
    try {
      tree = readTree(sourceRoot);
    } catch (err) {
      return abort(
        'READ_FAILED',
        `failed to read the exportable project tree for ${projectId}: ${err?.message ?? err}`,
        err,
      );
    }

    // (2) Enforce the configurable file-count limit (Req 11.9) — REPORT excess,
    // never silently truncate.
    const fc = checkFileCount(tree, fileCountLimit);
    if (!fc.ok) {
      // Clean up any temp dest we created, then REPORT the excess (Req 11.9).
      cleanupDest(destDir);
      return {
        ok: false,
        projectId,
        code: 'FILE_COUNT_EXCEEDED',
        message: `project ${projectId} has ${fc.count} files, exceeding the export file-count limit of ${fc.limit}`,
        count: fc.count,
        limit: fc.limit,
      };
    }

    // (3) SECONDARY non-leakage net: rewrite any literal secret value / platform
    // host in the read tree into an env-var reference. VALUES are needles only.
    const secretNeedles = Object.entries(secretEnv).map(([name, value]) => ({
      name,
      value: String(value ?? ''),
    }));
    const platformHosts = collectPlatformHosts(extraHosts);

    // The guardrail operates on string file bodies; binary (Buffer) entries
    // cannot carry a credential literal meaningfully and are copied verbatim.
    const textFiles = {};
    const binaryFiles = {};
    for (const [rel, contents] of Object.entries(tree)) {
      if (typeof contents === 'string') textFiles[rel] = contents;
      else binaryFiles[rel] = contents;
    }

    let rewritten;
    let substitutionReport;
    try {
      const scan = scanAndSubstitute({
        files: textFiles,
        secrets: secretNeedles,
        platformHosts,
      });
      rewritten = scan.files;
      substitutionReport = scan.report;
    } catch (err) {
      return abort(
        'GUARDRAIL_FAILED',
        `credential guardrail failed while exporting ${projectId}: ${err?.message ?? err}`,
        err,
      );
    }

    // The materialized export tree: rewritten text + verbatim binary.
    const exportTree = { ...rewritten, ...binaryFiles };

    // (4) Env-var TEMPLATE (Req 11.8): every required NAME, NO value. Union of
    // Secret NAMES + connector credential NAMES + PLATFORM_HOST when a platform
    // host was actually substituted.
    const platformHostSubstituted = substitutionReport.some((r) => r.kind === 'platform-host');
    const templateNames = [
      ...secretNames.filter((n) => typeof n === 'string' && n !== ''),
      ...connectorEnvNames.filter((n) => typeof n === 'string' && n !== ''),
      ...catalogEnvNames(),
    ];
    if (platformHostSubstituted) templateNames.push(PLATFORM_HOST_ENV_NAME);
    const envTemplate = renderEnvTemplate(templateNames);

    // (5) 300s SLO measured against the INJECTED clock — never a real wait.
    // Checked BEFORE writing so an over-budget export produces no output.
    const elapsedBeforeWrite = now() - start;
    if (elapsedBeforeWrite > exportTimeoutMs) {
      return abort(
        'EXPORT_TIMEOUT',
        `export of ${projectId} exceeded the ${exportTimeoutMs}ms SLO (took ${elapsedBeforeWrite}ms)`,
        undefined,
      );
    }

    // (6) Materialize the export into the SEPARATE destination. A failing writer
    // (or any I/O error) aborts, cleans up partial output, and — because we only
    // ever read the source tree — leaves the Project's stored state UNCHANGED.
    try {
      writeExport(destDir, exportTree, envTemplate);
    } catch (err) {
      return abort(
        'WRITE_FAILED',
        `failed to materialize the export for ${projectId}: ${err?.message ?? err}`,
        err,
      );
    }

    const exportMs = now() - start;
    // Re-check the SLO against the full measured duration (write included).
    if (exportMs > exportTimeoutMs) {
      return abort(
        'EXPORT_TIMEOUT',
        `export of ${projectId} exceeded the ${exportTimeoutMs}ms SLO (took ${exportMs}ms)`,
        undefined,
      );
    }

    return {
      ok: true,
      projectId,
      destDir,
      createdTempDest,
      fileCount: fc.count,
      exportMs,
      files: exportTree,
      envTemplate,
      envNames: [...new Set(templateNames)].sort(),
      substitutionReport,
    };
  }

  return Object.freeze({
    fileCountLimit,
    exportTimeoutMs,
    export: exportProject,
  });
}
