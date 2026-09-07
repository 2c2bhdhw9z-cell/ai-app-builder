/**
 * Portability subsystem barrel (spec Task 27 — Export + Lockin-Audit).
 *
 * The public seam for the "no lock-in" subsystem (Req 11): Project_Export
 * (Task 27.1) produces a self-contained, credential-stripped copy of a Project
 * that builds/runs with a Standard_Toolchain outside the platform, and (later)
 * Lockin_Audit (Task 27.2) scans a Project for lock-in signals. Both share one
 * configurable file-count limit (Req 11.9), re-exported here.
 *
 * Mirrors how src/secrets/index.js and src/connectors/index.js aggregate their
 * modules. Node stdlib only; no new dependency; imports NO plumby package.
 */

export {
  createProjectExport,
  EXPORT_SLO_MS,
  ENV_TEMPLATE_FILENAME,
} from './export.js';

export {
  createLockinAudit,
  AUDIT_SLO_MS,
} from './lockin-audit.js';

export {
  DEFAULT_FILE_COUNT_LIMIT,
  requireFileCountLimit,
  countTreeFiles,
  checkFileCount,
} from './file-count.js';
