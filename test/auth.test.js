/**
 * Auth & authz unit tests (node --test) — spec task 4.2, Req 7.1–7.6.
 *
 * Covers:
 *   (a) unauthenticated create/open/modify is denied WITHOUT disclosing Project
 *       contents (Req 7.1, 7.2);
 *   (b) an action on a non-owned resource is denied — authorize() returns
 *       AccessDenied / relation 'none' (Req 7.4);
 *   (c) resolveAccess() resolves "authorized to access" against the REQUESTER —
 *       owner allowed, non-owner without grant denied, holder of a read-only
 *       Share_Link grant allowed for read (Req 7.5);
 *   (d) session scoping isolates users — a session bound to user A cannot
 *       enumerate user B's resources via ownerId filtering (Req 7.6);
 *   (e) session tokens are signed and verify, an expired token is rejected, and
 *       rotation invalidates the prior token;
 *   (f) the platform stores NO password field on User_Account (authIdentity
 *       only).
 *
 * A fake injected IdP verifier and a fake audit sink are used — no network, no
 * key. Where a property test would belong (isolation-boundary Property 1,
 * secret non-leakage Property 8) it is OUT OF SCOPE: those are LATER tasks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAuthService } from '../src/auth/auth-service.js';
import { createSessionManager } from '../src/auth/session.js';
import { createCollectorSink, AUDIT_EVENTS } from '../src/auth/audit.js';
import { createProject } from '../src/model/index.js';
import { createShareLink } from '../src/model/index.js';

const NOW = Date.parse('2024-01-01T00:00:00.000Z');

/** A fake OIDC IdP verifier: maps a canned idToken to claims. No network. */
function fakeIdp(mapping) {
  return {
    async verifyIdToken(idToken) {
      const claims = mapping[idToken];
      if (!claims) throw new Error('fake IdP: unknown token');
      return claims;
    },
  };
}

/** A small clock we can advance. */
function fakeClock(start = NOW) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** Build a valid Project record owned by ownerId. */
function projectOwnedBy(ownerId, id = 'p1') {
  return createProject({
    id,
    ownerId,
    description: 'demo',
    targetCategory: 'web',
    origin: 'blank',
    targets: [],
    sandboxId: 'sbx-1',
    provider: 'anthropic',
    model: 'claude',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  });
}

function makeService(extra = {}) {
  const audit = createCollectorSink();
  const clock = fakeClock();
  const service = createAuthService({
    idpVerifier: fakeIdp({
      'gh-token-A': { provider: 'github', subject: 'gh|A' },
      'goog-token-B': { provider: 'google', subject: 'goog|B' },
    }),
    signingKey: 'test-signing-key-do-not-use-in-prod',
    auditSink: audit,
    now: clock.now,
    ...extra,
  });
  return { service, audit, clock };
}

// --- (a) unauthenticated is denied without disclosing Project contents -------

test('(a) unauthenticated create/open/modify is denied without disclosing contents', async () => {
  const { service } = makeService();

  // No credential in the request ⇒ authentication denied.
  const result = await service.authenticate({});
  assert.equal(result.denied, true);
  assert.equal(result.account, undefined);
  // The denial indication carries NO project fields / contents.
  assert.deepEqual(Object.keys(result), ['denied']);

  // An authorize check with no principal (unauthenticated) is denied and
  // returns nothing about the resource beyond the access-denied indication.
  const project = projectOwnedBy('userA');
  const decision = service.authorize(undefined, 'read', project);
  assert.equal(decision.decision, 'AccessDenied');
  assert.equal(decision.relation, 'none');
  assert.equal(decision.ok, false);
  assert.equal('description' in decision, false);
});

test('(a) an IdP-rejected token is denied without leaking the cause', async () => {
  const { service } = makeService();
  const result = await service.authenticate({ idToken: 'not-a-real-token' });
  assert.equal(result.denied, true);
  assert.deepEqual(Object.keys(result), ['denied']);
});

// --- (b) action on a non-owned resource is denied ----------------------------

test('(b) authorize denies an action on a non-owned resource (relation none)', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  const projectOfB = projectOwnedBy(userB.id);

  const owner = service.authorize(userB, 'write', projectOfB);
  assert.equal(owner.decision, 'Allowed');
  assert.equal(owner.relation, 'owner');

  const other = service.authorize(userA, 'write', projectOfB);
  assert.equal(other.decision, 'AccessDenied');
  assert.equal(other.relation, 'none');
});

test('(b) authorize covers all six resource types via ownerId', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  for (const type of ['project', 'user-skill', 'global-memory', 'connector', 'secret', 'share-link']) {
    const owned = { id: `${type}-1`, ownerId: userA.id };
    assert.equal(service.authorize(userA, 'write', owned).relation, 'owner', type);
    assert.equal(service.authorize(userB, 'write', owned).relation, 'none', type);
  }
});

// --- (c) resolveAccess resolves against the requester ------------------------

test('(c) resolveAccess: owner allowed, non-owner without grant denied', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  const projectOfA = projectOwnedBy(userA.id);

  // Owner (fork source / repo owner) is authorized to access.
  const asOwner = service.resolveAccess(userA, { kind: 'project', resource: projectOfA });
  assert.equal(asOwner.decision, 'Allowed');
  assert.equal(asOwner.relation, 'owner');

  // Non-owner with no grant is NOT authorized to access.
  const asOther = service.resolveAccess(userB, { kind: 'project', resource: projectOfA });
  assert.equal(asOther.decision, 'AccessDenied');
  assert.equal(asOther.relation, 'none');
});

test('(c) resolveAccess: holder of a read-only Share_Link grant is allowed for read', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  const projectOfA = projectOwnedBy(userA.id, 'p-shared');
  const link = createShareLink({
    token: 'share-tok-1',
    projectId: 'p-shared',
    access: 'read-only',
    createdAt: '2024-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revoked: false,
  });

  // With the grant, the non-owner requester is authorized to READ.
  const granted = service.resolveAccess(userB, {
    kind: 'share-link',
    resource: projectOfA,
    grants: [link],
  });
  assert.equal(granted.decision, 'Allowed');
  assert.equal(granted.relation, 'granted');

  // A read-only grant does NOT authorize a write action.
  const write = service.authorize(userB, 'write', projectOfA, { grants: [link] });
  assert.equal(write.decision, 'AccessDenied');
  assert.equal(write.relation, 'none');

  // A revoked link grants nothing.
  const revoked = createShareLink({ ...link, revoked: true });
  const denied = service.resolveAccess(userB, { resource: projectOfA, grants: [revoked] });
  assert.equal(denied.decision, 'AccessDenied');
});

test('(c) resolveAccess: an expired Share_Link grants no access', async () => {
  const { service, clock } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  const projectOfA = projectOwnedBy(userA.id, 'p-exp');
  const link = createShareLink({
    token: 'share-tok-exp',
    projectId: 'p-exp',
    access: 'read-only',
    createdAt: '2024-01-01T00:00:00.000Z',
    expiresAt: '2024-01-01T00:00:05.000Z',
    revoked: false,
  });

  // Before expiry: allowed.
  assert.equal(
    service.resolveAccess(userB, { resource: projectOfA, grants: [link] }).relation,
    'granted',
  );
  // Advance past expiry: denied.
  clock.advance(10_000);
  assert.equal(
    service.resolveAccess(userB, { resource: projectOfA, grants: [link] }).decision,
    'AccessDenied',
  );
});

// --- (c) authorize fail-open regressions (audit H7, H8) ----------------------

test('(c/H7) a grant with no projectId does NOT match a resource with no id (fail closed)', async () => {
  const { service } = makeService();
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  // A grant-shaped object with NO projectId, and a resource with NO id/ownerId.
  // Pre-fix, `undefined !== undefined` is false, so the targeting check passed
  // and this returned Allowed/granted. The fix requires both sides to be
  // non-empty strings, so this must be denied.
  const looseGrant = { access: 'read-only', revoked: false, expiresAt: '2099-01-01T00:00:00.000Z' };
  const resourceNoId = { description: 'no id, no ownerId' };
  const decision = service.resolveAccess(userB, { resource: resourceNoId, grants: [looseGrant] });
  assert.equal(decision.decision, 'AccessDenied', 'a projectId-less grant must not match an id-less resource');
  assert.equal(decision.relation, 'none');
});

test('(c/H7) a grant with a projectId does not match a DIFFERENT resource id', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  const projectOfA = projectOwnedBy(userA.id, 'p-real');
  const grantForOther = {
    access: 'read-only', revoked: false, projectId: 'p-other', expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const decision = service.resolveAccess(userB, { resource: projectOfA, grants: [grantForOther] });
  assert.equal(decision.decision, 'AccessDenied');
});

test('(c/H8) a grant with an UNPARSEABLE expiresAt is denied (fail closed)', async () => {
  const { service, clock } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  const projectOfA = projectOwnedBy(userA.id, 'p-badexp');
  // A grant naming the right project but with an expiry Date.parse cannot read.
  // Pre-fix, Number.isFinite(NaN) is false so the expiry branch was skipped and
  // the grant was PERMANENT. The fix fails closed on any unparseable expiry.
  for (const bad of ['never', 'not-a-date', '2024-13-45', '']) {
    const grant = { access: 'read-only', revoked: false, projectId: 'p-badexp', expiresAt: bad };
    const decision = service.resolveAccess(userB, { resource: projectOfA, grants: [grant] });
    assert.equal(decision.decision, 'AccessDenied', `expiresAt ${JSON.stringify(bad)} must not grant access`);
  }

  // Sanity: a valid future ISO expiry on the same project still grants (control).
  clock.advance(0);
  const good = { access: 'read-only', revoked: false, projectId: 'p-badexp', expiresAt: '2099-01-01T00:00:00.000Z' };
  assert.equal(service.resolveAccess(userB, { resource: projectOfA, grants: [good] }).relation, 'granted');
});

test('(H8) createShareLink rejects an unparseable expiresAt at the model edge', () => {
  assert.throws(
    () => createShareLink({
      token: 't', projectId: 'p1', access: 'read-only',
      createdAt: '2024-01-01T00:00:00.000Z', expiresAt: 'never', revoked: false,
    }),
    /expiresAt must be a parseable ISO-8601 date/,
  );
});

// --- (d) session scoping isolates users --------------------------------------

test('(d) a session bound to user A cannot enumerate user B resources', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  const registry = [
    projectOwnedBy(userA.id, 'a1'),
    projectOwnedBy(userA.id, 'a2'),
    projectOwnedBy(userB.id, 'b1'),
  ];

  const sessionA = service.scopeSession(userA);
  const visibleToA = sessionA.enumerate(registry);
  assert.deepEqual(visibleToA.map((p) => p.id).sort(), ['a1', 'a2']);
  // B's resource is not enumerable through A's session.
  assert.equal(visibleToA.some((p) => p.ownerId === userB.id), false);

  const sessionB = service.scopeSession(userB);
  const visibleToB = sessionB.enumerate(registry);
  assert.deepEqual(visibleToB.map((p) => p.id), ['b1']);
});

test('(d) a scoped session authorizes as its bound account', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const { account: userB } = await service.authenticate({ idToken: 'goog-token-B' });

  const projectOfA = projectOwnedBy(userA.id, 'pa');
  const sessionB = service.scopeSession(userB);
  // B's session cannot authorize an action on A's project.
  assert.equal(sessionB.authorize('read', projectOfA).decision, 'AccessDenied');
  assert.equal(sessionB.accountId, userB.id);
});

// --- (e) signed tokens verify / expire / rotate ------------------------------

test('(e) session tokens are signed, verify, and bind exactly one account', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });

  const session = service.scopeSession(userA);
  assert.match(session.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // payload.sig
  const claims = service.verifySession(session.token);
  assert.equal(claims.accountId, userA.id);
  assert.equal(claims.sessionId, session.sessionId);
});

test('(e) a tampered token fails verification', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const session = service.scopeSession(userA);
  const tampered = session.token.slice(0, -2) + (session.token.endsWith('aa') ? 'bb' : 'aa');
  assert.throws(() => service.verifySession(tampered), /invalid session/);
});

test('(e) a token signed with a different key does not verify', () => {
  const clock = fakeClock();
  const good = createSessionManager({ signingKey: 'key-one', now: clock.now });
  const evil = createSessionManager({ signingKey: 'key-two', now: clock.now });
  const s = good.issue({ id: 'u1' });
  // The evil manager has no record of the session AND a different key.
  assert.throws(() => evil.verify(s.token), /invalid session/);
});

test('(e) an expired token is rejected', async () => {
  const clock = fakeClock();
  const { service } = makeService({ sessionTtlMs: 1000, now: clock.now });
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const session = service.scopeSession(userA);

  // Still valid just before expiry.
  clock.advance(999);
  assert.equal(service.verifySession(session.token).accountId, userA.id);

  // Rejected at/after expiry.
  clock.advance(2);
  assert.throws(() => service.verifySession(session.token), /invalid session/);
});

test('(e) rotation issues a new token and invalidates the prior one', async () => {
  const { service } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const session = service.scopeSession(userA);

  const rotated = service.rotateSession(session.token);
  assert.notEqual(rotated.token, session.token);
  assert.equal(rotated.sessionId, session.sessionId); // same session, new token
  assert.equal(rotated.accountId, userA.id);

  // The new token verifies...
  assert.equal(service.verifySession(rotated.token).accountId, userA.id);
  // ...and the OLD token is now invalid (bounded blast radius).
  assert.throws(() => service.verifySession(session.token), /invalid session/);
});

test('(e) session issuance and rotation are audited as security events', async () => {
  const { service, audit } = makeService();
  const { account: userA } = await service.authenticate({ idToken: 'gh-token-A' });
  const session = service.scopeSession(userA);
  service.rotateSession(session.token);

  assert.equal(audit.ofType(AUDIT_EVENTS.SESSION_ISSUED).length, 1);
  assert.equal(audit.ofType(AUDIT_EVENTS.SESSION_ROTATED).length, 1);
  // Authorization decisions are audited too (the single decision point).
  service.authorize(userA, 'read', projectOwnedBy(userA.id));
  assert.ok(audit.ofType(AUDIT_EVENTS.AUTHZ_DECISION).length >= 1);
});

// --- (H18) session lifetime cap, reuse detection, revoke ownership, reaping --

test('(H18) rotation cannot extend a session past its absolute lifetime cap', () => {
  const clock = fakeClock();
  // ttl 1000ms (rolling), but absolute cap 5000ms from issue.
  const mgr = createSessionManager({
    signingKey: 'k', ttlMs: 1000, maxLifetimeMs: 5000, now: clock.now,
  });
  let s = mgr.issue({ id: 'u1' });

  // Rotate every 900ms; pre-fix the rolling ttl let this verify forever.
  for (let i = 0; i < 4; i += 1) {
    clock.advance(900);
    s = mgr.rotate(s.token); // still within the 5000ms cap
    assert.equal(mgr.verify(s.token).accountId, 'u1');
  }

  // Advance past the absolute cap (issued at 0, cap at 5000; now ~3600 + 1500).
  clock.advance(1500); // total ~5100ms
  assert.throws(() => mgr.verify(s.token), /invalid session/, 'a token past the absolute cap is rejected');
  assert.throws(() => mgr.rotate(s.token), /invalid session/, 'rotation past the cap is refused');
});

test('(H18) a replayed STALE-rotation token kills the whole session family', () => {
  const clock = fakeClock();
  const audit = createCollectorSink();
  const mgr = createSessionManager({ signingKey: 'k', ttlMs: 100000, now: clock.now, auditSink: audit });
  const s0 = mgr.issue({ id: 'u1' });
  const s1 = mgr.rotate(s0.token); // s0 is now stale (rot 0 < current 1)

  // The current token verifies.
  assert.equal(mgr.verify(s1.token).accountId, 'u1');

  // Presenting the STALE token (valid signature, rot < current) is reuse: it
  // must kill the family and emit a high-severity event — NOT merely reject.
  assert.throws(() => mgr.verify(s0.token), /invalid session/);
  const reuse = audit.ofType(AUDIT_EVENTS.SESSION_REUSE_DETECTED);
  assert.equal(reuse.length, 1, 'reuse is detected and audited');
  assert.equal(reuse[0].severity, 'high');

  // The newest token is now dead too (the family was revoked).
  assert.throws(() => mgr.verify(s1.token), /invalid session/, 'the live token is killed after reuse');
});

test('(H18) revoke enforces ownership and audits SESSION_REVOKED', () => {
  const clock = fakeClock();
  const audit = createCollectorSink();
  const mgr = createSessionManager({ signingKey: 'k', now: clock.now, auditSink: audit });
  const s = mgr.issue({ id: 'u1' });

  // A different account cannot revoke this session.
  assert.equal(mgr.revoke(s.sessionId, 'attacker'), false, 'ownership mismatch refuses revoke');
  assert.equal(mgr.verify(s.token).accountId, 'u1', 'the session survives a foreign revoke attempt');

  // The owner can, and it is audited.
  assert.equal(mgr.revoke(s.sessionId, 'u1'), true);
  assert.equal(audit.ofType(AUDIT_EVENTS.SESSION_REVOKED).length, 1);
  assert.throws(() => mgr.verify(s.token), /invalid session/);
});

test('(H18) reapExpired removes sessions past their absolute lifetime', () => {
  const clock = fakeClock();
  const mgr = createSessionManager({ signingKey: 'k', ttlMs: 1000, maxLifetimeMs: 2000, now: clock.now });
  mgr.issue({ id: 'u1' });
  mgr.issue({ id: 'u2' });
  assert.equal(mgr.reapExpired(), 0, 'nothing to reap yet');
  clock.advance(3000); // both past the 2000ms cap
  assert.equal(mgr.reapExpired(), 2, 'both expired sessions are reaped');
  assert.equal(mgr.reapExpired(), 0, 'idempotent after reaping');
});

// --- (f) no password stored on User_Account ----------------------------------

test('(f) the platform stores no password field; only authIdentity is recorded', async () => {
  const { service } = makeService();
  const { account } = await service.authenticate({ idToken: 'gh-token-A' });

  assert.equal(account.authIdentity, 'github:gh|A');
  assert.deepEqual(Object.keys(account).sort(), ['authIdentity', 'createdAt', 'id']);
  for (const forbidden of ['password', 'passwordHash', 'secret', 'credential', 'passphrase']) {
    assert.equal(forbidden in account, false, `no ${forbidden} field`);
  }
});

test('(f) re-authenticating the same identity returns the same account (no new secret)', async () => {
  const { service } = makeService();
  const first = await service.authenticate({ idToken: 'gh-token-A' });
  const second = await service.authenticate({ idToken: 'gh-token-A' });
  assert.equal(first.account.id, second.account.id);
  assert.equal(first.account.authIdentity, second.account.authIdentity);
});

// --- (H17) the account store seam is treated as ASYNC ------------------------

/**
 * An account store whose methods return PROMISES, like a real persistence
 * layer. Pre-fix, identity.authenticate did not await findByAuthIdentity/save,
 * so `!account` was false for the truthy pending Promise, NO account was
 * created, and the caller got a Promise where a User_Account was required —
 * scopeSession then threw. This asserts the async seam works end-to-end.
 */
function asyncAccountStore() {
  const byIdentity = new Map();
  return {
    saveCalls: 0,
    async findByAuthIdentity(authIdentity) {
      await Promise.resolve();
      return byIdentity.get(authIdentity) ?? null;
    },
    async save(account) {
      this.saveCalls += 1;
      await Promise.resolve();
      byIdentity.set(account.authIdentity, account);
      return account;
    },
    all() {
      return [...byIdentity.values()];
    },
  };
}

test('(H17) an ASYNC account store yields a real User_Account, not a Promise', async () => {
  const store = asyncAccountStore();
  const { service } = makeService({ accountStore: store });

  const first = await service.authenticate({ idToken: 'gh-token-A' });
  assert.equal(first.denied, undefined, 'authentication succeeds against an async store');
  assert.equal(typeof first.account, 'object');
  assert.equal(first.account.authIdentity, 'github:gh|A');
  // The returned account is a real record: scopeSession must not throw.
  const session = service.scopeSession(first.account);
  assert.equal(session.accountId, first.account.id);
  assert.equal(store.saveCalls, 1, 'a new identity created exactly one account');

  // Re-authenticating the same identity finds the existing account (no new save).
  const second = await service.authenticate({ idToken: 'gh-token-A' });
  assert.equal(second.account.id, first.account.id);
  assert.equal(store.saveCalls, 1, 'an existing identity is found, not re-created');
});

test('(H17) a store returning a MISMATCHED identity fails closed', async () => {
  const bad = {
    async findByAuthIdentity() {
      // Returns a record for a DIFFERENT identity than the one requested.
      return { id: 'evil', authIdentity: 'github:someone-else', createdAt: NOW };
    },
    async save(a) { return a; },
    all() { return []; },
  };
  const { service } = makeService({ accountStore: bad });
  const res = await service.authenticate({ idToken: 'gh-token-A' });
  assert.equal(res.denied, true, 'a mismatched account record must not bind a session');
  assert.equal(res.account, undefined);
});

// --- OUT OF SCOPE note --------------------------------------------------------
// Property tests for the Isolation_Boundary (Property 1) and secret
// non-leakage (Property 8) belong to LATER tasks (task 5 runtime isolation,
// task 12 audit/secret storage) and are intentionally NOT implemented here.
// Axis-3 per-Project RUNTIME isolation is a separate enforcement point
// (SandboxManager) and is out of scope for FEAT-003.
