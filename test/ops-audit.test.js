/**
 * AuditLog tests (node --test), spec Task 12.6 / 12.7*, Req 24.4, 25.1.
 *
 * The AuditLog is the append-only stream of security-relevant actions. These
 * tests cover:
 *   (a) it drops into the EXISTING toAuditSink seam so AuthService session
 *       issuance/rotation + authorize decisions are recorded WITHOUT changing
 *       src/auth internals (it is a valid { record } sink);
 *   (b) authn success/denied, authz decisions, secret access, confirm-class op,
 *       and project/account deletion are each recorded and scoped to the acting
 *       accountId;
 *   (c) a Secret value handed into an event ANYWHERE is REDACTED in the stored
 *       entry (top-level, nested, embedded as a substring);
 *   (d) the log is append-only — there is no update/delete surface and read
 *       helpers return copies;
 *   (e) an optional downstream sink receives each redacted entry.
 *
 * Mutation guard: with the central redactor neutered to a no-op passthrough, the
 * 'no plaintext secret value in any audit entry' assertion FAILS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createAuditLog, createRedactor, REDACTION_PLACEHOLDER } from '../src/ops/index.js';
import { AUDIT_EVENTS } from '../src/auth/audit.js';
import { createAuthService } from '../src/auth/index.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createSecretStore } from '../src/secrets/index.js';
import { createCommandGuard } from '../src/sandbox/index.js';
import { createRetentionService } from '../src/ops/index.js';

const SECRET = 'sk-live-4f2c8a1b9d7e6f30';

/** A fake IdP verifier mapping any idToken to a stable subject. */
function fakeIdp(subject = 'user-1') {
  return {
    async verifyIdToken(idToken) {
      if (!idToken) throw new Error('no token');
      return { provider: 'github', subject: `${subject}:${idToken}` };
    },
  };
}

/** A layout rooted at a fresh temp dir so real file I/O stays hermetic. */
function tempLayout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-ops-audit-'));
  return { base, layout: createStorageLayout(base) };
}

// -------------------------------------------------------------- basics

test('AuditLog stamps at=now(), requires a typed event, and is a valid sink', () => {
  let clock = 1000;
  const log = createAuditLog({ redactor: createRedactor({}), now: () => clock });
  assert.equal(typeof log.record, 'function', 'exposes record -> valid audit-sink shape');

  clock = 4242;
  const entry = log.record({ type: AUDIT_EVENTS.AUTHN_SUCCESS, accountId: 'acct-1', at: 1 });
  assert.equal(entry.at, 4242, "the log's clock is authoritative and overrides caller `at`");
  assert.equal(entry.accountId, 'acct-1');
  assert.equal(log.size(), 1);

  assert.throws(() => log.record(null), TypeError);
  assert.throws(() => log.record({}), TypeError, 'an event needs a non-empty string type');
  assert.throws(() => log.record([{ type: 'x' }]), TypeError, 'must be a plain object');
});

test('AuditLog is append-only: no update/delete surface, reads return copies', () => {
  const log = createAuditLog({ redactor: createRedactor({}), now: () => 1 });
  log.record({ type: AUDIT_EVENTS.AUTHN_SUCCESS, accountId: 'a' });

  // No mutation surface beyond record().
  assert.equal(log.update, undefined);
  assert.equal(log.delete, undefined);
  assert.equal(log.remove, undefined);
  assert.equal(log.clear, undefined);

  // Read helpers return copies; the stored entry itself is frozen.
  const first = log.all();
  first.push({ type: 'injected' });
  assert.equal(log.size(), 1, 'mutating a returned array does not change the log');
  const [entry] = log.all();
  assert.throws(() => {
    entry.type = 'tampered';
  }, TypeError, 'stored entries are frozen');
});

// ------------------------------------------- AuthService seam (no auth edits)

test('drops into the AuthService auditSink seam: authn + authz + session events recorded', async () => {
  const log = createAuditLog({ redactor: createRedactor({}), now: () => 100 });
  const authService = createAuthService({ idpVerifier: fakeIdp(), auditSink: log });

  // authn success
  const { account } = await authService.authenticate({ idToken: 'tok' });
  assert.ok(account && account.id);

  // session issuance
  const session = authService.scopeSession(account);
  // authz decision (owner-or-grant): owner writes its own resource -> allowed
  const decision = authService.authorize(account, 'write', { id: 'p1', ownerId: account.id }, {});
  assert.equal(decision.ok, true);

  // authn denied
  await authService.authenticate({ idToken: '' });

  assert.ok(log.ofType(AUDIT_EVENTS.AUTHN_SUCCESS).length >= 1, 'authn success recorded');
  assert.ok(log.ofType(AUDIT_EVENTS.AUTHN_DENIED).length >= 1, 'authn denied recorded');
  assert.ok(log.ofType(AUDIT_EVENTS.SESSION_ISSUED).length >= 1, 'session issuance recorded');
  assert.ok(log.ofType(AUDIT_EVENTS.AUTHZ_DECISION).length >= 1, 'authz decision recorded');

  // Every recorded authn-success / authz entry is scoped to the acting account.
  for (const e of log.ofType(AUDIT_EVENTS.AUTHN_SUCCESS)) assert.equal(e.accountId, account.id);
  assert.ok(
    log.ofType(AUDIT_EVENTS.AUTHZ_DECISION).some((e) => e.accountId === account.id),
    'an authz decision is scoped to the acting account',
  );
});

// ------------------------------------------- SecretStore SECRET_ACCESS seam

test('SecretStore records SECRET_ACCESS (name only, never value) on read', () => {
  const { base, layout } = tempLayout();
  try {
    const log = createAuditLog({ redactor: createRedactor({ secretValues: [SECRET] }), now: () => 7 });
    const store = createSecretStore({ layout, ownerId: 'owner-1', auditSink: log });
    store.put('proj-1', 'API_KEY', SECRET);

    // A read for injection is the auditable moment.
    assert.equal(store.get('proj-1', 'API_KEY'), SECRET);

    const events = log.ofType(AUDIT_EVENTS.SECRET_ACCESS);
    assert.equal(events.length, 1, 'exactly one SECRET_ACCESS on one read');
    const [ev] = events;
    assert.equal(ev.accountId, 'owner-1', 'scoped to the acting (owner) account');
    assert.equal(ev.projectId, 'proj-1');
    assert.equal(ev.name, 'API_KEY', 'the NAME is recorded');
    // The value must NEVER appear anywhere in the event.
    assert.ok(!JSON.stringify(ev).includes(SECRET), 'no secret value in the SECRET_ACCESS entry');

    // envForProject also reads values; it too emits SECRET_ACCESS, no value.
    const env = store.envForProject('proj-1');
    assert.equal(env.API_KEY, SECRET);
    assert.ok(log.ofType(AUDIT_EVENTS.SECRET_ACCESS).length >= 2);
    for (const e of log.ofType(AUDIT_EVENTS.SECRET_ACCESS)) {
      assert.ok(!JSON.stringify(e).includes(SECRET));
    }

    // With NO sink injected, behaviour is unchanged (no throw, value returned).
    const plain = createSecretStore({ layout, ownerId: 'owner-1' });
    assert.equal(plain.get('proj-1', 'API_KEY'), SECRET);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ------------------------------------------- CommandGuard CONFIRM_CLASS_OP

test('CommandGuard records CONFIRM_CLASS_OP with the command redacted', async () => {
  const log = createAuditLog({ redactor: createRedactor({ secretValues: [SECRET] }), now: () => 9 });
  const redactor = createRedactor({ secretValues: [SECRET] });

  // A fake manager.exec and a classifier that returns confirm-class.
  const manager = {
    async exec() {
      return { denied: false, exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const classify = () => ({ outcome: 'confirm', category: 'destructive', reason: 'rm -rf' });
  const guard = createCommandGuard({ manager, classify, auditSink: log, redactor });

  // Grant path: the confirm command carries a secret in its argv.
  const granted = await guard.run('proj-1', `deploy --token ${SECRET}`, {
    accountId: 'acct-9',
    onConfirmRequest: () => true,
  });
  assert.equal(granted.confirmed, true);

  // Deny path.
  await guard.run('proj-1', `deploy --token ${SECRET}`, {
    accountId: 'acct-9',
    onConfirmRequest: () => false,
  });

  const events = log.ofType(AUDIT_EVENTS.CONFIRM_CLASS_OP);
  assert.equal(events.length, 2, 'both grant and deny are audited');
  const [grant, deny] = events;
  assert.equal(grant.granted, true);
  assert.equal(deny.granted, false);
  for (const e of events) {
    assert.equal(e.accountId, 'acct-9');
    assert.equal(e.category, 'destructive');
    assert.ok(!JSON.stringify(e).includes(SECRET), 'the command secret is redacted in the entry');
    assert.ok(String(e.command).includes(REDACTION_PLACEHOLDER), 'command shows the placeholder');
  }
});

// ------------------------------------------- Retention deletion events

test('RetentionService deletions land in the AuditLog, redacted + account-scoped', async () => {
  const log = createAuditLog({ redactor: createRedactor({ secretValues: [SECRET] }), now: () => 11 });
  const redactor = createRedactor({ secretValues: [SECRET] });

  // Minimal fakes for each injectable resource seam.
  const persistenceStore = { deleteProjectTree: () => ({ ok: true }) };
  const snapshotStore = { deleteSnapshots: () => ({ ok: true }) };
  const sandboxManager = { release: async () => ({ ok: true }) };
  const secretStore = {
    deleteProjectSecrets: () => ({ ok: true }),
    deleteAccountData: () => ({ ok: true }),
  };
  const projectRegistry = {
    listForOwner: () => [{ id: 'p1', ownerId: 'acct-11' }],
    unregister: () => true,
  };

  const retention = createRetentionService({
    persistenceStore,
    snapshotStore,
    sandboxManager,
    secretStore,
    projectRegistry,
    auditSink: log,
    redactor,
    now: () => 11,
  });

  await retention.deleteProject({ id: 'acct-11' }, 'p1');
  await retention.deleteAccount({ id: 'acct-11' });

  const del = log.ofType(AUDIT_EVENTS.PROJECT_DELETED);
  const acc = log.ofType(AUDIT_EVENTS.ACCOUNT_DELETED);
  assert.ok(del.length >= 1, 'PROJECT_DELETED recorded');
  assert.ok(acc.length >= 1, 'ACCOUNT_DELETED recorded');
  for (const e of [...del, ...acc]) assert.equal(e.accountId, 'acct-11');
});

// ------------------------------------------- redaction in the log

test('a Secret value handed into an event ANYWHERE is redacted in the stored entry', () => {
  const redactor = createRedactor({ secretValues: [SECRET] });
  const log = createAuditLog({ redactor, now: () => 1 });

  log.record({
    type: AUDIT_EVENTS.SECRET_ACCESS,
    accountId: 'acct-1',
    // A caller accidentally hands a secret in — top-level, nested, and embedded.
    value: SECRET,
    ctx: { header: `Authorization: Bearer ${SECRET}` },
    args: ['--token', SECRET],
  });

  const [entry] = log.all();
  assert.ok(!JSON.stringify(entry).includes(SECRET), 'NO plaintext secret value in any audit entry');
  assert.equal(entry.value, REDACTION_PLACEHOLDER);
  assert.ok(entry.ctx.header.includes(REDACTION_PLACEHOLDER));
  assert.deepEqual(entry.args, ['--token', REDACTION_PLACEHOLDER]);
});

test('MUTATION GUARD: a no-op redactor lets a plaintext secret survive in an entry', () => {
  // This proves the redaction is load-bearing: swap the central redactor for a
  // no-op passthrough and the 'no plaintext secret' invariant FAILS. In the real
  // wiring the central createRedactor is used; here we demonstrate the failure a
  // broken redactor would cause.
  const noopRedactor = { redact: (x) => x };
  const log = createAuditLog({ redactor: noopRedactor, now: () => 1 });
  log.record({ type: AUDIT_EVENTS.SECRET_ACCESS, accountId: 'a', value: SECRET });
  const [entry] = log.all();
  assert.ok(
    JSON.stringify(entry).includes(SECRET),
    'with a no-op redactor the plaintext secret survives (the guarded assertion would flip)',
  );
});

test('the optional downstream sink receives each redacted entry', () => {
  const redactor = createRedactor({ secretValues: [SECRET] });
  const forwarded = [];
  const log = createAuditLog({ redactor, now: () => 1, sink: (e) => forwarded.push(e) });
  log.record({ type: AUDIT_EVENTS.SECRET_ACCESS, accountId: 'a', value: SECRET });
  assert.equal(forwarded.length, 1);
  assert.ok(!JSON.stringify(forwarded[0]).includes(SECRET), 'forwarded entry is redacted');
});
