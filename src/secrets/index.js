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
 * identityCodec). Real envelope encryption / KMS (Task 12.4) is provided here by
 * createEnvelopeCodec({ kms }) over a KMS seam (createLocalKms is the local /
 * offline implementation; a cloud KMS slots in behind the same interface). The
 * envelope codec drops into the SAME `codec` seam with no caller changes.
 */

export { createSecretStore, identityCodec } from './secret-store.js';

export { createEnvelopeCodec } from './envelope-codec.js';

export { createLocalKms } from './kms.js';

export { scanAndSubstitute, PLATFORM_HOST_ENV_NAME } from './generation-guardrail.js';
