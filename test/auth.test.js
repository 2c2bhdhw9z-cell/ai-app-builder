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

// --- OUT OF SCOPE note --------------------------------------------------------
// Property tests for the Isolation_Boundary (Property 1) and secret
// non-leakage (Property 8) belong to LATER tasks (task 5 runtime isolation,
// task 12 audit/secret storage) and are intentionally NOT implemented here.
// Axis-3 per-Project RUNTIME isolation is a separate enforcement point
// (SandboxManager) and is out of scope for FEAT-003.
