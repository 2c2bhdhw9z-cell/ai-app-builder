/**
 * Secrets subsystem barrel (spec Task 7).
 *
 * The public seam for the SecretStore and the generation guardrail, mirroring
 * how src/model/index.js, src/auth/index.js, and src/sandbox/index.js aggregate
 * their modules. Callers compose a SecretStore from a StorageLayout, use it to
 * hold secret VALUES out-of-tree, materialize an in-memory env map for the
 * Sandbox to inject at runtime (envForProject), and run the generation guardrail
 * as the secondary safety net that rewrites literal credentials / platform hosts
 * into env-var references before source is written.
 *
 * ENCRYPTION SEAM: createSecretStore takes a pluggable `codec` (default
 * identityCodec). Real envelope encryption / KMS is Task 12.4 and slots in via
 * that seam without changing any caller here.
 */

export { createSecretStore, identityCodec } from './secret-store.js';

export { scanAndSubstitute, PLATFORM_HOST_ENV_NAME } from './generation-guardrail.js';
