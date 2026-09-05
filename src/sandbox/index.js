/**
 * Sandbox subsystem barrel — the per-project Isolation_Boundary (spec Task 5).
 *
 * The public seam for the SandboxManager and its collaborators, mirroring how
 * src/model/index.js and src/auth/index.js aggregate their modules. Callers
 * compose a manager from a StorageLayout (src/storage/layout.js) and a container
 * backend, then use the stable acquire/exec/release interface. The concrete
 * container runtime lives entirely behind container-backend.js so the backend
 * can be swapped (Docker/OCI → gVisor/Firecracker) without touching callers.
 */

export { createSandboxManager } from './sandbox-manager.js';

export {
  createContainerBackend,
  buildRunArgs,
  cgroupFlagsFor,
  WORKSPACE_MOUNT_PATH,
  DEFAULT_IMAGE,
  OWNER_LABEL,
} from './container-backend.js';

export {
  computeEgressAllowlist,
  normalizeHost,
  isForbiddenEgressHost,
  endpointHostsForBinding,
  DEFAULT_PACKAGE_REGISTRY_HOSTS,
} from './egress.js';
