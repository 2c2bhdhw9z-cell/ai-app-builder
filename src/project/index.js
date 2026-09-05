/**
 * Project subsystem barrel (spec Task 13 — Project lifecycle and creation).
 *
 * The public seam for the ProjectManager (input validation + the 10s "begins
 * creation" SLO + the generation -> verify -> Dev_Server / editable-on-fail
 * pipeline), the control-plane ProjectRegistry (out-of-tree per-owner Project
 * records backing the QuotaManager totalProjects counter and the Builder Server
 * projectResolver), and the Dev_Server process-launch seam — mirroring how
 * src/sandbox/index.js and src/persistence/index.js aggregate their modules.
 *
 * Callers compose these from a StorageLayout (src/storage/layout.js), a
 * SandboxManager, a QuotaManager, the SnapshotStore, and the plumby Builder_Agent
 * + verify seams (through src/engine/plumby.js only — this subsystem never
 * imports the plumby package directly). A real Dev_Server / Preview cannot run
 * offline, so createDevServer is a seam-only default; production swaps a real
 * launcher behind the same interface.
 */

export { createProjectManager, MAX_DESCRIPTION_CHARS } from './project-manager.js';

export { createProjectRegistry } from './project-registry.js';

export { createDevServer } from './dev-server.js';
