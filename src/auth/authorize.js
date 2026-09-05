/**
 * The SINGLE ownership-based owner-or-grant authorization check (design.md §0,
 * Req 7.3–7.5). Deliberately simpler than RBAC/ABAC: an account OWNS its
 * resources, and shared access is an EXPLICIT grant — today the only grant type
 * is a read-only Share_Link. This module is the one place the authorization
 * decision lives, so origins/sharing subsystems delegate to it.
 *
 *   authorize(userAccount, action, resource) -> Allowed | AccessDenied
 *   resolveAccess(userAccount, ref)          -> resolution against the requester
 *
 * Every decision is fed to the injectable audit sink (Req 25.1). The result
 * carries the Authorization relation ('owner' | 'granted' | 'none').
 *
 * Multi-tenant isolation (Req 7.6) axes 1 & 2 are enforced here + via the
 * storage layout: `filterByOwner` provides control-plane enumeration that a
 * tenant cannot use to see another tenant's resources. Axis 3 — per-Project
 * RUNTIME isolation via the Isolation_Boundary — is task 5 and OUT OF SCOPE
 * here; see the seam comment in resolveAccess/authorize below.
 */

import { AUTHZ_RELATIONS } from '../model/account.js';
import { AUDIT_EVENTS, toAuditSink } from './audit.js';

/** Resource types authorize() covers (mirror model AUTHZ_RESOURCE_TYPES). */
export const AUTHORIZABLE_RESOURCE_TYPES = Object.freeze([
  'project',
  'user-skill',
  'global-memory',
  'connector',
  'secret',
  'share-link',
]);

/** Actions the check understands. Only 'read' is grantable via a Share_Link. */
export const READ_ACTION = 'read';

/** An Allowed decision. `relation` is 'owner' or 'granted'. */
function allowed(relation) {
  return { ok: true, decision: 'Allowed', relation };
}

/** An AccessDenied decision. `relation` is always 'none'. */
function denied() {
  return { ok: false, decision: 'AccessDenied', relation: 'none' };
}

/**
 * True when `link` is a live read-only Share_Link grant for `resource` held by
 * a requester (grants are anchored on the resource, not the account: anyone
 * presenting a valid, unrevoked, unexpired Share_Link for the resource has the
 * read grant). `now` is the current epoch-ms.
 */
function isLiveReadGrant(link, resource, now) {
  if (!link || typeof link !== 'object') return false;
  if (link.access !== 'read-only') return false;
  if (link.revoked) return false;
  // The grant must target this resource (by projectId for Projects).
  const targetId = resource && (resource.id ?? resource.projectId);
  if (link.projectId !== targetId) return false;
  if (link.expiresAt) {
    const exp = Date.parse(link.expiresAt);
    if (Number.isFinite(exp) && now >= exp) return false;
  }
  return true;
}

/**
 * Create an Authorizer bound to an audit sink and clock.
 *
 * @param {object} [opts]
 * @param {Function|{record:Function}} [opts.auditSink]
 * @param {() => number} [opts.now]
 */
export function createAuthorizer(opts = {}) {
  const audit = toAuditSink(opts.auditSink);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /**
   * The single owner-or-grant check.
   *
   * @param {{id:string}} userAccount   the REQUESTING account
   * @param {string} action             e.g. 'read' | 'write' | 'delete'
   * @param {object} resource           control-plane record with `ownerId`
   * @param {object} [context]          optional { grants: ShareLink[] }
   * @returns {{ok:boolean, decision:'Allowed'|'AccessDenied', relation:string}}
   */
  function authorize(userAccount, action, resource, context = {}) {
    const accountId = userAccount && userAccount.id;
    const resourceId = resource && (resource.id ?? resource.projectId);

    // Unauthenticated / malformed principal ⇒ deny WITHOUT disclosing anything.
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      const result = denied();
      auditDecision(action, resourceId, undefined, result);
      return result;
    }

    let result;
    if (resource && resource.ownerId === accountId) {
      // Axis-1/2 anchor: ownership is recorded on the control-plane record.
      result = allowed('owner');
    } else if (action === READ_ACTION && hasReadGrant(resource, context)) {
      // Explicit grant: today only a read-only Share_Link, read action only.
      result = allowed('granted');
    } else {
      result = denied();
    }

    // NOTE (task 5, OUT OF SCOPE): per-Project RUNTIME isolation via the
    // Isolation_Boundary is enforced at execution time by SandboxManager, not
    // here. This function decides DATA-plane access (axes 1 & 2) only; the
    // boundary is a separate, independent enforcement point.
    auditDecision(action, resourceId, accountId, result);
    return result;
  }

  /** Whether any grant in context authorizes read on `resource`. */
  function hasReadGrant(resource, context) {
    const grants = Array.isArray(context.grants) ? context.grants : [];
    const t = now();
    return grants.some((g) => isLiveReadGrant(g, resource, t));
  }

  /**
   * resolveAccess — the single "authorized to access" resolution (Req 7.5),
   * used by github-import repos, fork source Projects, and Share_Links. Resolved
   * against the REQUESTING userAccount; delegates to authorize (ownership+grant).
   *
   * `ref` describes what is being accessed:
   *   { kind: 'repo'|'project'|'share-link', resource, grants? }
   * Returns the same decision shape as authorize.
   */
  function resolveAccess(userAccount, ref = {}) {
    const { resource, grants } = ref;
    // "Authorized to access" is a READ resolution against the requester.
    return authorize(userAccount, READ_ACTION, resource, { grants });
  }

  function auditDecision(action, resourceId, accountId, result) {
    audit({
      type: AUDIT_EVENTS.AUTHZ_DECISION,
      at: now(),
      accountId,
      action,
      resourceId,
      decision: result.decision,
      relation: result.relation,
    });
  }

  return { authorize, resolveAccess };
}

/**
 * Control-plane enumeration filter (three-axis isolation, axis 1; Req 7.6).
 * Given the authenticated account and a collection of owned records, return
 * only the records owned by that account, so one tenant can NEVER enumerate
 * another tenant's resources. This is the enforcement seam for list/enumerate.
 *
 * @param {{id:string}} userAccount
 * @param {Array<{ownerId?:string}>} records
 */
export function filterByOwner(userAccount, records) {
  const accountId = userAccount && userAccount.id;
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    // No authenticated principal ⇒ enumerate nothing (fail-closed).
    return [];
  }
  if (!Array.isArray(records)) return [];
  return records.filter((r) => r && r.ownerId === accountId);
}

// Re-export the relation vocabulary so callers don't reach into the model.
export { AUTHZ_RELATIONS };
