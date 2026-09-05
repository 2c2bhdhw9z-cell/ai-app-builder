/**
 * Data-model barrel.
 *
 * Re-exports the closed enums and every record factory for the 14 data models
 * from design.md's Data Models section. Records are plain serializable objects;
 * each `createX` factory validates required fields and enum membership at the
 * edge (reusing enums.js predicates) and rejects invalid input with a clear
 * error.
 *
 * The 14 models: User_Account, Authorization, Project, Target, Snapshot,
 * Connector, ConnectorBinding, Secret, Skill, MemoryEntry, MemoryStoreMeta,
 * DeploymentArtifact, ShareLink, VerifyResult.
 */

// Closed enums + predicates.
export * from './enums.js';

// Identity + authorization.
export {
  createUserAccount,
  createAuthorization,
  AUTHZ_RESOURCE_TYPES,
  AUTHZ_RELATIONS,
} from './account.js';

// Project / Target / Snapshot.
export {
  createProject,
  createTarget,
  createSnapshot,
  PROJECT_PROVIDERS,
  SNAPSHOT_TRIGGERS,
} from './project.js';

// Connector / ConnectorBinding / Secret.
export {
  createConnector,
  createConnectorBinding,
  createSecret,
  CONNECTOR_CAPTURE_KINDS,
  CONNECTOR_BINDING_STATUS,
} from './connector.js';

// Skill.
export { createSkill, SKILL_KINDS } from './skill.js';

// Memory.
export {
  createMemoryEntry,
  createMemoryStoreMeta,
  MEMORY_SCOPES,
  MEMORY_ENTRY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_STORE_DEFAULTS,
} from './memory.js';

// Deployment / ShareLink / VerifyResult.
export {
  createDeploymentArtifact,
  createShareLink,
  createVerifyResult,
  VERIFY_VERDICTS,
  SHARE_LINK_ACCESS,
} from './deployment.js';
