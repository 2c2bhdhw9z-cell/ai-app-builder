/**
 * THE SHARE_LINK SERVICE (spec Task 29.1, Req 26.1-26.7 + 7.5).
 *
 * Generates, resolves access for, and revokes read-only Share_Links. This is a
 * thin composition over EXISTING seams — it deliberately does NOT reimplement
 * authorization or the grant/deny logic:
 *
 *   - project existence/ownership is resolved via projectResolver(projectId)
 *     (ProjectRegistry.resolver) -> { id, ownerId } | null;
 *   - the authorization decision is the REAL createAuthorizer() result — every
 *     share/access/revoke decision runs through authorize / resolveAccess, whose
 *     isLiveReadGrant already fail-closes on a revoked, expired (H8), or
 *     mis-targeted (H7) link, and grants ONLY the 'read' action;
 *   - records persist ONLY in the control-plane ShareLinkStore (out-of-tree);
 *   - lifecycle events go to the injected audit sink (token NEVER logged).
 *
 * DENY-DISCLOSE-NOTHING (Req 26.2, 26.4, 7.5): a nonexistent project, an
 * unauthorized requester, and a malformed/expired/revoked link all collapse to
 * the SAME generic { ok:false } shape. The service never distinguishes
 * not-found from not-authorized, and never leaks a project existence hint.
 *
 * TIME: the injected `now()` returns epoch-ms. createdAt/expiresAt and the
 * expiry decision are computed from it, so the 5s SLOs (all in-memory + one
 * file write) and the 7-day expiry are verifiable against an injected clock
 * without ever waiting on real time.
 *
 * node:crypto only for the token; no plumby import; no new dependency.
 */

import crypto from 'node:crypto';

import { AUDIT_EVENTS, toAuditSink } from './audit.js';
import { createShareLink } from '../model/deployment.js';

/** Default Share_Link lifetime: 7 days (Req 26.1). */
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Default token entropy in bytes (256-bit, unguessable). */
const DEFAULT_TOKEN_BYTES = 32;

/**
 * The single generic denial result. Reused for EVERY reject path (nonexistent
 * project, unauthorized requester, malformed/expired/revoked link) so a caller
 * can never distinguish the reason and no existence hint leaks (Req 26.2/26.4).
 */
function denied() {
  return { ok: false, code: 'denied', message: 'access denied' };
}

/**
 * Create a ShareLinkService.
 *
 * @param {object} args
 * @param {object} args.store            a ShareLinkStore (put/get/list).
 * @param {object} args.authorizer       the REAL createAuthorizer() result
 *        ({ authorize, resolveAccess }). REUSED — not reimplemented.
 * @param {(projectId:string)=>({id:string,ownerId:string}|null)} args.projectResolver
 *        ProjectRegistry.resolver — resolves whether a Project EXISTS + its owner.
 * @param {()=>number} [args.now]        injected clock returning epoch-ms.
 * @param {Function|{record:Function}} [args.auditSink]  lifecycle audit sink.
 * @param {number} [args.tokenBytes]     token entropy in bytes (default 32).
 * @param {number} [args.expiryMs]       link lifetime in ms (default 7 days).
 * @returns {object} service (frozen) — { share, access, revoke }.
 */
export function createShareLinkService({
  store,
  authorizer,
  projectResolver,
  now = () => Date.now(),
  auditSink,
  tokenBytes = DEFAULT_TOKEN_BYTES,
  expiryMs = DEFAULT_EXPIRY_MS,
} = {}) {
  if (!store || typeof store.put !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('ShareLinkService: store with put/get is required');
  }
  if (
    !authorizer ||
    typeof authorizer.authorize !== 'function' ||
    typeof authorizer.resolveAccess !== 'function'
  ) {
    throw new TypeError('ShareLinkService: authorizer with authorize/resolveAccess is required');
  }
  if (typeof projectResolver !== 'function') {
    throw new TypeError('ShareLinkService: projectResolver(projectId) is required');
  }
  if (typeof now !== 'function') {
    throw new TypeError('ShareLinkService: now must be a function returning epoch-ms');
  }
  const audit = toAuditSink(auditSink);

  /** Generate a fresh, unguessable token. Two calls yield distinct tokens. */
  function mintToken() {
    return crypto.randomBytes(tokenBytes).toString('base64url');
  }

  /** A recipient-safe view of a link (never a mutation handle). */
  function shareableView(link) {
    return Object.freeze({
      token: link.token,
      projectId: link.projectId,
      access: link.access,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
    });
  }

  /**
   * share(requester, projectId) — Req 26.1 / 26.2 / 7.5.
   *
   * Resolve the project; if it does not exist OR the requester is not
   * authorized to access it, reject with the generic { ok:false } and write NO
   * link (no partial state). On success, mint a unique token, build the record
   * (createdAt = now, expiresAt = now + 7 days), persist it, audit
   * SHARE_LINK_CREATED (no token), and return { ok:true, link }.
   */
  function share(requester, projectId) {
    const project =
      typeof projectId === 'string' && projectId !== '' ? projectResolver(projectId) : null;

    // Project does not exist -> generic deny, no link. Do NOT reveal absence.
    if (!project) return denied();

    // Authorize the requester against the REAL authorizer (7.5: "authorized to
    // access" resolves against the requesting User_Account). AccessDenied ->
    // the SAME generic shape, so not-found and not-authorized are indistinct.
    const decision = authorizer.resolveAccess(requester, {
      kind: 'project',
      resource: project,
    });
    if (!decision.ok) return denied();

    const t = now();
    const token = mintToken();
    const link = createShareLink({
      token,
      projectId: project.id,
      access: 'read-only',
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + expiryMs).toISOString(),
      revoked: false,
    });
    store.put(link);

    audit({
      type: AUDIT_EVENTS.SHARE_LINK_CREATED,
      at: t,
      accountId: requester && requester.id,
      ownerId: project.ownerId,
      projectId: project.id,
      // token intentionally omitted — it is secret capability material.
    });

    return { ok: true, link: shareableView(link) };
  }

  /**
   * access(recipient, token) — Req 26.3 / 26.4.
   *
   * Load the link; a null (absent OR malformed) token denies generically,
   * disclosing nothing. Otherwise resolve the target project and delegate to
   * the REAL resolveAccess with { grants:[link] }: because isLiveReadGrant
   * checks revoked / expiry (H8) / targeting (H7), a revoked, expired, or
   * mis-targeted link is simply not a live grant and resolveAccess returns
   * AccessDenied -> the SAME generic deny. On Allowed -> a read-only view.
   */
  function access(recipient, token) {
    const link = store.get(token);
    if (!link) return denied();

    const project = projectResolver(link.projectId);
    if (!project) return denied();

    const decision = authorizer.resolveAccess(recipient, {
      kind: 'share-link',
      resource: project,
      grants: [link],
    });
    if (!decision.ok) return denied();

    return { ok: true, access: 'read-only', projectId: project.id };
  }

  /**
   * modify(recipient, token) — Req 26.5.
   *
   * The service exposes NO mutation path via a Share_Link; this method exists
   * only to prove a recipient's modification attempt is rejected. It authorizes
   * a 'write' action through the REAL authorize with the link as a grant — which
   * denies, because only the 'read' action is grantable. Always returns a
   * generic deny; the Project is never touched.
   */
  function modify(recipient, token) {
    const link = store.get(token);
    if (!link) return denied();
    const project = projectResolver(link.projectId);
    if (!project) return denied();
    // A non-read action can never be granted by a Share_Link -> AccessDenied.
    authorizer.authorize(recipient, 'write', project, { grants: [link] });
    return denied();
  }

  /**
   * revoke(requester, token) — Req 26.6 / 26.7.
   *
   * Load the link and authorize the requester as the owner of the underlying
   * project before revoking (an arbitrary account cannot revoke). If NO ACTIVE
   * (existing, non-revoked, owner-authorized) link matches — a nonexistent
   * token OR an already-revoked token — return { ok:false, code:'no_match' }
   * and change NOTHING (idempotent, non-destructive to sibling links). On a
   * match, flip revoked:true, re-validate via createShareLink, persist the ONE
   * file atomically, and audit SHARE_LINK_REVOKED. A subsequent access() then
   * denies (isLiveReadGrant sees revoked).
   */
  function revoke(requester, token) {
    const noMatch = { ok: false, code: 'no_match', message: 'no active Share_Link matched' };

    const link = store.get(token);
    // Nonexistent OR already-revoked -> no active link matched; touch nothing.
    if (!link || link.revoked) return noMatch;

    const project = projectResolver(link.projectId);
    if (!project) return noMatch;

    // Only an account authorized on the underlying project (its owner) may
    // revoke. This is a plain ownership check via the REAL authorizer with NO
    // grants (a Share_Link does not authorize revoking another link).
    const decision = authorizer.authorize(requester, 'read', project, { grants: [] });
    if (!decision.ok) return noMatch;

    const revokedLink = createShareLink({ ...link, revoked: true });
    store.put(revokedLink); // one file, atomic; sibling links untouched.

    audit({
      type: AUDIT_EVENTS.SHARE_LINK_REVOKED,
      at: now(),
      accountId: requester && requester.id,
      ownerId: project.ownerId,
      projectId: project.id,
      // token intentionally omitted.
    });

    return { ok: true };
  }

  return Object.freeze({ share, access, modify, revoke });
}
