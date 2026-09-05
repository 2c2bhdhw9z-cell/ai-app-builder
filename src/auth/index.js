/**
 * Auth subsystem barrel (design.md Architecture §0, Req 7).
 *
 * The AuthService is the single security gate: OAuth2/OIDC delegated
 * authentication (NO platform passwords), short-lived signed session tokens with
 * refresh/rotation each bound to one User_Account, the single owner-or-grant
 * authorize() / resolveAccess() decision point, and three-axis multi-tenant
 * isolation (control-plane enumeration filtering + per-owner storage paths;
 * per-Project runtime isolation is task 5 and out of scope here).
 */

export { createAuthService } from './auth-service.js';
export {
  createIdentityManager,
  createInMemoryAccountStore,
  toAuthIdentity,
  SUPPORTED_IDP_PROVIDERS,
} from './identity.js';
export {
  createSessionManager,
  DEFAULT_SESSION_TTL_MS,
} from './session.js';
export {
  createAuthorizer,
  filterByOwner,
  AUTHORIZABLE_RESOURCE_TYPES,
  READ_ACTION,
} from './authorize.js';
export {
  createCollectorSink,
  toAuditSink,
  AUDIT_EVENTS,
} from './audit.js';
