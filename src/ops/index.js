/**
 * Platform-operations subsystem barrel (spec Task 12).
 *
 * The public seam for the platform-operations primitives — rate limiting &
 * quotas, data retention/deletion, envelope-encryption codec wiring, the
 * append-only audit log, and observability — mirroring how src/secrets/index.js
 * and src/sandbox/index.js aggregate their modules. Later Task-12 features add
 * their exports here (AuditLog, observability).
 *
 * The centralized secret-redaction filter (createRedactor) is the single filter
 * every audit / metrics / error log path routes through (Req 24.4).
 *
 * The RetentionService (createRetentionService) performs Project and
 * User_Account deletion (Req 24.2-24.5) with retain-until-deletion semantics:
 * persisted state + Snapshots are retained until the user deletes the Project or
 * the User_Account (no silent expiry); it deletes-or-anonymizes every
 * ownerId-keyed category and emits redacted PROJECT_DELETED / ACCOUNT_DELETED
 * audit events.
 */

export {
  createRedactor,
  REDACTION_PLACEHOLDER,
  MIN_SECRET_LENGTH,
} from './redaction.js';

export {
  createQuotaManager,
  RATE_LIMITED_OPERATIONS,
  QUOTA_RESOURCES,
  DEFAULT_QUOTA_CONFIG,
} from './quota-manager.js';

export {
  createRetentionService,
  OWNER_KEYED_CATEGORIES,
} from './retention.js';
