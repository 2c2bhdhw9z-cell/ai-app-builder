/**
 * Database_Service record (spec Req 9.2, 9.3, 9.4, 9.5).
 *
 * A Database_Service is the per-Project database a full-stack (`full-stack-web`
 * / `multi-target`) Project is provisioned with. This module is JUST the plain,
 * serializable RECORD + its closed status enum, following the same edge-
 * validating factory pattern as src/model/project.js (createTarget) and
 * src/model/deployment.js (createDeploymentArtifact): validate required fields
 * and enum membership with the shared helpers in src/model/validate.js, then
 * return a normalized plain object.
 *
 * The provisioning / migration LIFECYCLE that drives a record through these
 * statuses lives in src/sandbox/database-service.js (the provisioner) — this
 * file holds no behaviour, only the shape and the legal state set, so both the
 * provisioner (FEAT-002) and the migration path (FEAT-003) share one model and
 * one status vocabulary and cannot drift.
 */

import {
  requireString,
  requireOneOf,
  requireIsoDate,
  optionalString,
} from './validate.js';

/**
 * The CLOSED set of Database_Service statuses. A record is only ever in one of
 * these states:
 *   - 'provisioning' — bring-up in flight; not yet usable.
 *   - 'ready'        — provisioned and reachable; scaffolding may be marked
 *                      complete (Req 9.2 "report ready before scaffolding
 *                      complete").
 *   - 'failed'       — provisioning failed or timed out (Req 9.3).
 *   - 'torn-down'    — the (possibly partial) DB was reaped so none stays active
 *                      (Req 9.3 "no partially provisioned Database_Service in an
 *                      active state").
 * Frozen so the value set can never be mutated at runtime.
 */
export const DATABASE_SERVICE_STATUS = Object.freeze([
  'provisioning',
  'ready',
  'failed',
  'torn-down',
]);

/** The database engines a Database_Service descriptor may name (closed set). */
export const DATABASE_SERVICE_ENGINES = Object.freeze(['postgres', 'sqlite', 'mysql']);

/** True when `value` is a legal Database_Service status. */
export function isValidDatabaseServiceStatus(value) {
  return DATABASE_SERVICE_STATUS.includes(value);
}

/**
 * createDatabaseService — the Database_Service record factory.
 *
 * Fields:
 *   - id           a non-empty identifier for the Database_Service.
 *   - projectId    the owning Project's id.
 *   - status       one of DATABASE_SERVICE_STATUS (defaults to 'provisioning',
 *                  the state a freshly-requested DB begins in).
 *   - engine       one of DATABASE_SERVICE_ENGINES (defaults to 'postgres').
 *   - schemaVersion  nullable — the applied schema version once a migration has
 *                  run (Req 9.4). null/undefined before any migration.
 *   - createdAt    a parseable ISO-8601 timestamp (normalized to canonical ISO).
 *
 * Invalid input is rejected with a clear TypeError so a bad record never reaches
 * storage. Returns a plain (unfrozen, serializable) object matching the other
 * model records.
 *
 * @param {object} [input]
 * @returns {{ id:string, projectId:string, status:string, engine:string,
 *   schemaVersion:(string|null), createdAt:string }}
 */
export function createDatabaseService(input = {}) {
  const model = 'DatabaseService';
  const schemaVersion = optionalString(model, 'schemaVersion', input.schemaVersion);
  return {
    id: requireString(model, 'id', input.id),
    projectId: requireString(model, 'projectId', input.projectId),
    status: requireOneOf(
      model,
      'status',
      input.status ?? 'provisioning',
      DATABASE_SERVICE_STATUS,
    ),
    engine: requireOneOf(
      model,
      'engine',
      input.engine ?? 'postgres',
      DATABASE_SERVICE_ENGINES,
    ),
    // Nullable: null before any migration; a version string once one applied.
    schemaVersion: schemaVersion === undefined ? null : schemaVersion,
    createdAt: requireIsoDate(model, 'createdAt', input.createdAt),
  };
}
