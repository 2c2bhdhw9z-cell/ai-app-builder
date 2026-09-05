/**
 * Platform-operations subsystem barrel (spec Task 12).
 *
 * The public seam for the platform-operations primitives — rate limiting &
 * quotas, data retention/deletion, envelope-encryption codec wiring, the
 * append-only audit log, and observability — mirroring how src/secrets/index.js
 * and src/sandbox/index.js aggregate their modules. Later Task-12 features add
 * their exports here (QuotaManager, AuditLog, observability, retention/deletion
 * service).
 *
 * The centralized secret-redaction filter (createRedactor) is the single filter
 * every audit / metrics / error log path routes through (Req 24.4).
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
