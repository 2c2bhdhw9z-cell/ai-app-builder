/**
 * Share_Link subsystem unit tests (node --test) — spec Task 29 (Task 29.1 +
 * 29.2), Req 26.1-26.7 and 7.5.
 *
 * TESTING DISCIPLINE: these exercise REAL collaborators end to end —
 *   - the REAL createShareLink model (src/model/deployment.js),
 *   - the REAL createAuthorizer -> authorize / resolveAccess / isLiveReadGrant
 *     (src/auth/authorize.js) — NO fake authorizer, so a fail-open cannot hide
 *     behind a permissive mock,
 *   - a REAL on-disk ShareLinkStore on an fs.mkdtempSync temp dir with a REAL
 *     StorageLayout (src/storage/layout.js),
 *   - a REAL ProjectRegistry so project existence/ownership is real
 *     (src/project/project-registry.js), wired as the projectResolver, and
 *   - a REAL createCollectorSink audit sink (src/auth/audit.js).
 *
 * TIME: expiry and every SLO-bounded behavior is driven by an INJECTED clock
 * (`clock`, epoch-ms) advanced in memory — NEVER a real sleep/wait. The 7-day
 * expiry test advances the clock past 7 days.
 *
 * MUTATION SENSITIVITY (which assertion flips if the behavior is reverted) is
 * documented inline per test:
 *   - 26.1 uniqueness/expiry: if tokens were not unique or expiry were not 7
 *     days, the distinct-token / expiresAt assertions flip.
 *   - 26.2/7.5: a fail-open authorize would return ok:true and write a file —
 *     the { ok:false } + list-length assertions flip.
 *   - 26.3: routes through the real authorizer (asserted via the AUTHZ_DECISION
 *     'Allowed'/'granted' audit event).
 *   - 26.4 expired: reverting H8 expiry handling (absent/reached expiry treated
 *     as live) flips the deny to ok:true.
 *   - 26.4 revoked/malformed: a get() that threw/leaked on a malformed token,
 *     or an authorize that ignored `revoked`, flips the clean-deny assertions.
 *   - 26.5: if a non-read action were grantable, the modify path would allow —
 *     the "Project unchanged + generic deny" assertions flip.
 *   - 26.6: if revoke did not set revoked or authorize ignored revoked, access
 *     would still be ok — the post-revoke deny flips.
 *   - 26.7: a revoke that touched siblings, or reported a match for an
 *     already-revoked/nonexistent token, flips the byte-for-byte + no_match
 *     assertions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createStorageLayout } from '../src/storage/layout.js';
import { createProjectRegistry } from '../src/project/project-registry.js';
import {
  createAuthorizer,
  createCollectorSink,
  createShareLinkStore,
  createShareLinkService,
  AUDIT_EVENTS,
} from '../src/auth/index.js';

const OWNER = 'owner-share';
const RECIPIENT = 'recipient-share';
const STRANGER = 'stranger-share';
const PROJECT = 'proj-share';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

/**
 * A fresh temp-rooted layout with the real ProjectRegistry, real authorizer,
 * real on-disk ShareLinkStore, real audit collector, and an injected clock.
 * The clock is a mutable object so tests can advance it in place.
 */
function harness({ registerProject = true, ownerId = OWNER } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-share-'));
  const layout = createStorageLayout(base);
  const clock = { t: Date.parse('2026-01-01T00:00:00.000Z') };
  const now = () => clock.t;

  const registry = createProjectRegistry({ layout });
  if (registerProject) {
    registry.register(makeProject(PROJECT, ownerId));
  }

  const audit = createCollectorSink();
  const authorizer = createAuthorizer({ auditSink: audit, now });
  const store = createShareLinkStore({ layout, ownerId });
  const service = createShareLinkService({
    store,
    authorizer,
    projectResolver: (id) => registry.resolver(id),
    now,
    auditSink: audit,
  });

  return { base, layout, clock, registry, audit, authorizer, store, service, ownerId };
}

/** A minimal, valid Project record for the registry. */
function makeProject(id, ownerId) {
  return {
    id,
    ownerId,
    description: 'a shareable project',
    targetCategory: 'web',
    origin: 'blank',
    targets: [],
    sandboxId: 'sandbox-1',
    provider: 'anthropic',
    model: 'claude',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** An account principal (only `id` matters to authorize). */
const acct = (id) => ({ id });

/** Read a file's exact bytes, or null when absent (byte-for-byte diffing). */
function readBytes(p) {
  try {
    return fs.readFileSync(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Req 26.1 + generation uniqueness + 7.5 — authorized share of an EXISTING
// project yields a unique read-only link expiring exactly 7 days later.
// ─────────────────────────────────────────────────────────────────────────
test('share() by the authorized owner mints a unique read-only link expiring in 7 days; two shares are distinct (Req 26.1, 7.5)', () => {
  const { clock, service, store } = harness();

  const r1 = service.share(acct(OWNER), PROJECT);
  assert.equal(r1.ok, true);
  assert.equal(r1.link.access, 'read-only');
  assert.equal(r1.link.projectId, PROJECT);
  // expiresAt == createdAt + 7 days, both from the injected clock.
  assert.equal(Date.parse(r1.link.createdAt), clock.t);
  assert.equal(Date.parse(r1.link.expiresAt) - Date.parse(r1.link.createdAt), SEVEN_DAYS_MS);
  // Mutation check: if expiry were not exactly 7 days, this flips.
  assert.equal(Date.parse(r1.link.expiresAt), clock.t + SEVEN_DAYS_MS);

  const r2 = service.share(acct(OWNER), PROJECT);
  assert.equal(r2.ok, true);
  // Mutation check: a non-unique token generator flips this.
  assert.notEqual(r1.link.token, r2.link.token);

  // Both files exist on disk under the control-plane store.
  assert.ok(store.get(r1.link.token));
  assert.ok(store.get(r2.link.token));
  assert.equal(store.list().length, 2);
});

// ─────────────────────────────────────────────────────────────────────────
// Req 26.2 + 7.5 — nonexistent project OR unauthorized requester: same generic
// deny, NO link written, no disclosure.
// ─────────────────────────────────────────────────────────────────────────
test('share() for a nonexistent project denies generically and writes NO link (Req 26.2)', () => {
  const { service, store } = harness();
  const before = store.list().length;

  const res = service.share(acct(OWNER), 'does-not-exist');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'denied');
  // No projectId / existence hint leaked.
  assert.equal(res.projectId, undefined);
  // Mutation check: a fail-open path would write a file and return ok:true.
  assert.equal(store.list().length, before);
});

test('share() by a NON-owner of an existing project denies with the SAME generic shape and writes NO link (Req 26.2, 7.5)', () => {
  const { service, store } = harness();
  const before = store.list().length;

  const res = service.share(acct(STRANGER), PROJECT);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'denied');
  assert.equal(res.projectId, undefined);
  // Same generic shape as the not-found case (not-found vs not-authorized
  // must be indistinguishable — no existence disclosure).
  assert.deepEqual(res, { ok: false, code: 'denied', message: 'access denied' });
  // Mutation check: a fail-open authorize would mint+persist a link.
  assert.equal(store.list().length, before);
});

// ─────────────────────────────────────────────────────────────────────────
// Req 26.3 — a recipient with a valid/unexpired/unrevoked link gets read-only
// access, routed through the REAL authorizer.
// ─────────────────────────────────────────────────────────────────────────
test('access() with a valid link grants read-only access via the real authorizer (Req 26.3)', () => {
  const { service, audit } = harness();
  const shared = service.share(acct(OWNER), PROJECT);
  assert.equal(shared.ok, true);

  const res = service.access(acct(RECIPIENT), shared.link.token);
  assert.equal(res.ok, true);
  assert.equal(res.access, 'read-only');
  assert.equal(res.projectId, PROJECT);

  // Prove it routed through the REAL authorizer: a 'granted'/'Allowed'
  // AUTHZ_DECISION was recorded for the recipient.
  const granted = audit
    .ofType(AUDIT_EVENTS.AUTHZ_DECISION)
    .some((e) => e.accountId === RECIPIENT && e.decision === 'Allowed' && e.relation === 'granted');
  assert.ok(granted, 'expected an Allowed/granted AUTHZ_DECISION for the recipient');
});

// ─────────────────────────────────────────────────────────────────────────
// Req 26.4 — expired link: advance the injected clock past 7 days -> deny.
// ─────────────────────────────────────────────────────────────────────────
test('access() with an EXPIRED link (clock advanced past 7 days) denies generically (Req 26.4)', () => {
  const { clock, service } = harness();
  const shared = service.share(acct(OWNER), PROJECT);
  assert.equal(shared.ok, true);

  // Still valid just before expiry.
  clock.t += SEVEN_DAYS_MS - 1000;
  assert.equal(service.access(acct(RECIPIENT), shared.link.token).ok, true);

  // Advance PAST the 7-day expiry.
  clock.t += 2000; // now clock.t > createdAt + 7 days
  const res = service.access(acct(RECIPIENT), shared.link.token);
  // Mutation check: reverting H8 expiry handling flips this to ok:true.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'denied');
  assert.equal(res.projectId, undefined);
  assert.equal(res.access, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// Req 26.4 — malformed/unknown tokens: clean generic deny, no throw, nothing
// disclosed.
// ─────────────────────────────────────────────────────────────────────────
test('access() with malformed/unknown tokens denies generically WITHOUT throwing (Req 26.4)', () => {
  const { service } = harness();
  const generic = { ok: false, code: 'denied', message: 'access denied' };

  const malformed = ['../etc/passwd', '', '__proto__', 'constructor', 'a/b', 'no-such-token', 'x\0y'];
  for (const token of malformed) {
    // Mutation check: if get() threw/leaked on a malformed token this throws
    // (test fails) instead of returning a clean generic deny.
    const res = service.access(acct(RECIPIENT), token);
    assert.deepEqual(res, generic, `token ${JSON.stringify(token)} must deny generically`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Req 26.5 — a recipient modification attempt is rejected and the Project is
// unchanged (only 'read' is grantable via a Share_Link).
// ─────────────────────────────────────────────────────────────────────────
test('a recipient modification attempt via a share link is rejected; Project unchanged (Req 26.5)', () => {
  const { layout, service } = harness();
  const shared = service.share(acct(OWNER), PROJECT);
  assert.equal(shared.ok, true);

  const projectFile = layout.controlProjectRegistryPath(OWNER);
  const before = readBytes(projectFile);

  const res = service.modify(acct(RECIPIENT), shared.link.token);
  // Mutation check: if a non-read action were grantable, authorize would Allow
  // and the service could expose a mutation path — this deny flips.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'denied');

  const after = readBytes(projectFile);
  assert.deepEqual(after, before, 'Project registry bytes must be unchanged by a modify attempt');
});

// ─────────────────────────────────────────────────────────────────────────
// Req 26.6 — revoke denies all subsequent access via that link.
// ─────────────────────────────────────────────────────────────────────────
test('revoke() denies all subsequent access via that link (Req 26.6)', () => {
  const { clock, service, audit } = harness();
  const shared = service.share(acct(OWNER), PROJECT);
  assert.equal(shared.ok, true);
  const token = shared.link.token;

  // Access works before revoke.
  assert.equal(service.access(acct(RECIPIENT), token).ok, true);

  const before = clock.t;
  const rev = service.revoke(acct(OWNER), token);
  assert.equal(rev.ok, true);
  // No real waiting: revoke is synchronous, clock unchanged (within the 5s SLO).
  assert.equal(clock.t, before);

  // Mutation check: if revoke did not set revoked (or authorize ignored it),
  // access would still be ok.
  const res = service.access(acct(RECIPIENT), token);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'denied');

  // A SHARE_LINK_REVOKED event was audited, and it never carries the token.
  const revoked = audit.ofType(AUDIT_EVENTS.SHARE_LINK_REVOKED);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].token, undefined);
});

test('revoke() by a NON-owner does not revoke (Req 26.6 owner-gated)', () => {
  const { service } = harness();
  const shared = service.share(acct(OWNER), PROJECT);
  const token = shared.link.token;

  const rev = service.revoke(acct(STRANGER), token);
  assert.equal(rev.ok, false);
  assert.equal(rev.code, 'no_match');
  // The link is still live for a legitimate recipient.
  assert.equal(service.access(acct(RECIPIENT), token).ok, true);
});

// ─────────────────────────────────────────────────────────────────────────
// Req 26.7 — revoke of a nonexistent/already-revoked token reports no match and
// leaves OTHER links byte-for-byte unchanged.
// ─────────────────────────────────────────────────────────────────────────
test('revoke() of a nonexistent/already-revoked token reports no match; sibling links unchanged (Req 26.7)', () => {
  const { store, service } = harness();

  const a = service.share(acct(OWNER), PROJECT);
  const b = service.share(acct(OWNER), PROJECT);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const pathA = store.pathFor(a.link.token);
  const pathB = store.pathFor(b.link.token);
  const bytesA0 = readBytes(pathA);
  const bytesB0 = readBytes(pathB);

  // (1) Revoke a NONEXISTENT token -> no match, NO file touched.
  const none = service.revoke(acct(OWNER), 'this-token-was-never-issued');
  assert.equal(none.ok, false);
  assert.equal(none.code, 'no_match');
  assert.equal(none.message, 'no active Share_Link matched');
  assert.deepEqual(readBytes(pathA), bytesA0, 'link A must be untouched by a no-match revoke');
  assert.deepEqual(readBytes(pathB), bytesB0, 'link B must be untouched by a no-match revoke');

  // (2) Revoke link A (a real active link) -> ok, and B is untouched.
  const revA = service.revoke(acct(OWNER), a.link.token);
  assert.equal(revA.ok, true);
  const bytesB1 = readBytes(pathB);
  // Mutation check: a revoke that touched siblings flips this.
  assert.deepEqual(bytesB1, bytesB0, 'revoking A must not change B on disk');

  // (3) Revoke A AGAIN (already revoked) -> no match, and B still unchanged.
  const revAagain = service.revoke(acct(OWNER), a.link.token);
  assert.equal(revAagain.ok, false);
  assert.equal(revAagain.code, 'no_match');
  assert.equal(revAagain.message, 'no active Share_Link matched');
  assert.deepEqual(readBytes(pathB), bytesB0, 'a repeat revoke of A must not change B');

  // B is still usable via access() (proves sibling non-destruction end to end).
  assert.equal(service.access(acct(RECIPIENT), b.link.token).ok, true);
  // A now denies.
  assert.equal(service.access(acct(RECIPIENT), a.link.token).ok, false);
});

// ─────────────────────────────────────────────────────────────────────────
// Storage-split: ShareLink records persist ONLY in the control-plane root,
// never inside an exportable project tree.
// ─────────────────────────────────────────────────────────────────────────
test('ShareLink records persist OUTSIDE every exportable project tree (control-plane only, Req 26)', () => {
  const { layout, store, service } = harness();
  const shared = service.share(acct(OWNER), PROJECT);
  assert.equal(shared.ok, true);

  const stored = store.pathFor(shared.link.token);
  assert.equal(layout.isInsideExportTree(stored), false);
  // assertOutsideExportTrees must not throw for the stored path.
  assert.doesNotThrow(() => layout.assertOutsideExportTrees(stored, 'share-link-test'));
  // And it really is on disk under the control root.
  assert.ok(stored.startsWith(layout.controlRoot));
  assert.ok(readBytes(stored) !== null);
});
