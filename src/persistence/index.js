/**
 * Persistence subsystem barrel (spec Task 8 — Persistence, Snapshots, resumability).
 *
 * The public seam for the PersistenceStore (idle debounced durable file-state
 * persistence, Req 19.1, 19.2, 19.9) and the SnapshotStore (atomic content-
 * addressed Git commit + deterministic idempotent restore + resume rules +
 * turn-trigger policy, Req 19.3-19.8), mirroring how src/model/index.js,
 * src/secrets/index.js, and src/sandbox/index.js aggregate their modules.
 *
 * Callers compose both stores from a StorageLayout (src/storage/layout.js):
 * persisted project FILES live under the exportable project tree, while the
 * Snapshot REGISTRY is control-plane bookkeeping resolved out-of-tree. The
 * SnapshotStore's resume() takes an optional PersistenceStore so the "no
 * Snapshot yet" resume rule (Req 19.6) can read the most recent persisted state.
 *
 * DELETION SURFACES (Task 12.3 / Req 24.3, retain-until-deletion): the
 * PersistenceStore exposes deleteProjectTree(projectId) (rm the exportable tree
 * + drop any pending write) and the SnapshotStore exposes
 * deleteSnapshots(projectId) (rm the project's .git repo + the out-of-tree
 * Snapshot registry). Both are idempotent and return structured summaries; the
 * RetentionService (src/ops/retention.js) composes them on project/account
 * deletion.
 */

export { createPersistenceStore, MAX_DEBOUNCE_MS } from './persistence-store.js';

export { createSnapshotStore, SNAPSHOT_IDENTITY } from './snapshot-store.js';
