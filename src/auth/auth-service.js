/**
 * AuthService / IdentityManager (design.md "AuthService / IdentityManager"
 * component + Architecture §0). The single security gate that runs AHEAD of
 * ProjectManager and the plumby loop:
 *
 *   authenticate(request) -> User_Account | Denied      (Req 7.1, 7.2)
 *   scopeSession(userAccount) -> Session                (Req 7.6)
 *   authorize(userAccount, action, resource) -> ...      (Req 7.3, 7.4)
 *   resolveAccess(userAccount, ref) -> ...               (Req 7.5)
 *   enumerate(userAccount, records) -> owned records     (Req 7.6, axis 1)
 *
 * It composes three collaborators — the IdentityManager (OIDC), the
 * SessionManager (signed tokens + rotation), and the Authorizer (owner-or-grant)
 * — around one injectable audit sink so session and authorization security
 * events land in a single stream (Req 25.1). Everything is injectable so tests
 * run with a fake IdP + fake audit sink and no network/key.
 *
 * NO platform passwords are stored anywhere in this subsystem: authentication
 * is delegated to the IdP and only User_Account.authIdentity is recorded.
 */

import crypto from 'node:crypto';

import { createIdentityManager } from './identity.js';
import { createSessionManager, DEFAULT_SESSION_TTL_MS } from './session.js';
import { createAuthorizer, filterByOwner } from './authorize.js';
import { AUDIT_EVENTS, toAuditSink } from './audit.js';

/**
 * Construct an AuthService.
 *
 * @param {object} opts
 * @param {{verifyIdToken?:Function, exchangeCode?:Function}} opts.idpVerifier
 *        injectable IdP verifier (fake in tests)
 * @param {string|Buffer} [opts.signingKey]  session HMAC key (random if omitted)
 * @param {number} [opts.sessionTtlMs]       session lifetime (~24h default)
 * @param {object} [opts.accountStore]       account persistence seam
 * @param {Function|{record:Function}} [opts.auditSink]  security-event sink
 * @param {() => number} [opts.now]          injectable clock
 */
export function createAuthService(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const audit = toAuditSink(opts.auditSink);
  const signingKey = opts.signingKey ?? crypto.randomBytes(32);

  const identity = createIdentityManager({
    idpVerifier: opts.idpVerifier,
    accountStore: opts.accountStore,
    now,
  });
  const sessions = createSessionManager({
    signingKey,
    ttlMs: opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    now,
    auditSink: audit,
  });
  const authz = createAuthorizer({ auditSink: audit, now });

  return {
    /**
     * Require an authenticated identity before create/open/modify (Req 7.1).
     * Returns { account } or { denied: true }. On denial NO Project contents are
     * disclosed — the caller receives only the access-denied indication.
     */
    async authenticate(request) {
      const result = await identity.authenticate(request);
      if (result.denied) {
        audit({ type: AUDIT_EVENTS.AUTHN_DENIED, at: now(), reason: result.reason });
        return { denied: true };
      }
      audit({ type: AUDIT_EVENTS.AUTHN_SUCCESS, at: now(), accountId: result.account.id });
      return { account: result.account };
    },

    /**
     * Scope a Session to exactly one User_Account (Req 7.6). The returned
     * Session attaches the account to every downstream request/Project/memory
     * and carries authz + enumeration helpers already bound to that account.
     */
    scopeSession(userAccount) {
      if (!userAccount || typeof userAccount.id !== 'string' || userAccount.id.trim() === '') {
        throw new TypeError('scopeSession requires an authenticated User_Account');
      }
      const issued = sessions.issue(userAccount);
      return {
        token: issued.token,
        sessionId: issued.sessionId,
        accountId: issued.accountId,
        issuedAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
        userAccount,
        /** authorize an action on a resource AS this scoped account. */
        authorize: (action, resource, context) => authz.authorize(userAccount, action, resource, context),
        /** resolve "authorized to access" AS this scoped account. */
        resolveAccess: (ref) => authz.resolveAccess(userAccount, ref),
        /** enumerate only THIS account's records (axis-1 isolation). */
        enumerate: (records) => filterByOwner(userAccount, records),
      };
    },

    /** Verify a session token; throws on invalid/expired/rotated-out tokens. */
    verifySession(token) {
      return sessions.verify(token);
    },

    /** Soft verify: returns claims or null. */
    tryVerifySession(token) {
      return sessions.tryVerify(token);
    },

    /** Refresh/rotate a session; the prior token is invalidated. */
    rotateSession(token) {
      return sessions.rotate(token);
    },

    /** Revoke a session by id (logout). */
    revokeSession(sessionId) {
      sessions.revoke(sessionId);
    },

    /** The single owner-or-grant authorization check (Req 7.3, 7.4). */
    authorize(userAccount, action, resource, context) {
      return authz.authorize(userAccount, action, resource, context);
    },

    /** The single "authorized to access" resolution (Req 7.5). */
    resolveAccess(userAccount, ref) {
      return authz.resolveAccess(userAccount, ref);
    },

    /** Control-plane enumeration filtered by ownerId (Req 7.6, axis 1). */
    enumerate(userAccount, records) {
      return filterByOwner(userAccount, records);
    },

    // Exposed for advanced callers/tests.
    _identity: identity,
    _sessions: sessions,
  };
}
