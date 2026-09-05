/**
 * QuotaManager unit tests (spec Task 12.2*, Req 23).
 *
 * Hermetic: no network, no live containers, no real sleeps. Rate-limit windows
 * are driven by an injected `now()` clock; abuse mitigation is verified against
 * the SandboxManager INTERFACE with spies/fakes (assert the suspend/release
 * action was invoked and the reported action + audit events), NOT against a live
 * container. The audit stream is captured with the auth createCollectorSink.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createQuotaManager, QUOTA_RESOURCES } from '../src/ops/index.js';
import { AUDIT_EVENTS, createCollectorSink } from '../src/auth/index.js';

/** A mutable fake clock. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    set(ms) {
      t = ms;
    },
  };
}

const ACCOUNT = { id: 'acct-1' };

test('checkRate rejects the (N+1)th resource-creating operation in a window, naming Rate_Limit, and emits RATE_LIMIT_EXCEEDED', () => {
  const clock = fakeClock();
  const audit = createCollectorSink();
  const qm = createQuotaManager({
    config: { rate: { 'generation.turn': { max: 3, windowMs: 60_000 } } },
    auditSink: audit,
    now: clock.now,
  });

  // First N (=3) are allowed.
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(qm.checkRate(ACCOUNT, 'generation.turn'), { ok: true }, `call ${i} allowed`);
  }

  // The (N+1)th is rejected, naming the exceeded Rate_Limit and the operation.
  const rejected = qm.checkRate(ACCOUNT, 'generation.turn');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.limit, 'Rate_Limit');
  assert.equal(rejected.operation, 'generation.turn');
  assert.match(rejected.message, /Rate_Limit/);
  assert.match(rejected.message, /generation\.turn/);

  // A RATE_LIMIT_EXCEEDED audit event was emitted.
  const events = audit.ofType(AUDIT_EVENTS.RATE_LIMIT_EXCEEDED);
  assert.equal(events.length, 1);
  assert.equal(events[0].accountId, 'acct-1');
  assert.equal(events[0].operation, 'generation.turn');
});

test('checkRate window reset via the injected clock allows a subsequent request', () => {
  const clock = fakeClock();
  const qm = createQuotaManager({
    config: { rate: { build: { max: 1, windowMs: 10_000 } } },
    now: clock.now,
  });

  assert.equal(qm.checkRate(ACCOUNT, 'build').ok, true);
  assert.equal(qm.checkRate(ACCOUNT, 'build').ok, false, 'second in window rejected');

  // Advance past the window: a fresh window opens and the request is allowed.
  clock.advance(10_000);
  assert.equal(qm.checkRate(ACCOUNT, 'build').ok, true, 'allowed after window reset');
});

test('checkRate limits are per-(account, operation): distinct accounts and operations do not share a budget', () => {
  const clock = fakeClock();
  const qm = createQuotaManager({
    config: { rate: { deploy: { max: 1, windowMs: 60_000 } } },
    now: clock.now,
  });

  assert.equal(qm.checkRate({ id: 'a' }, 'deploy').ok, true);
  assert.equal(qm.checkRate({ id: 'a' }, 'deploy').ok, false, 'same account+op over budget');
  // A different account has its own budget.
  assert.equal(qm.checkRate({ id: 'b' }, 'deploy').ok, true, 'other account independent');
  // A non-rate-limited operation always passes.
  assert.equal(qm.checkRate({ id: 'a' }, 'read.something').ok, true, 'non-limited op passes');
});

test('checkQuota rejects over-maxConcurrentSandboxes, naming the Resource_Quota, and emits QUOTA_EXCEEDED', () => {
  const audit = createCollectorSink();
  // Fake SandboxManager at the concurrency ceiling.
  const sandboxManager = { activeProjectIds: () => ['p1', 'p2', 'p3'] };
  const qm = createQuotaManager({
    config: { quota: { maxConcurrentSandboxes: 3, maxTotalProjects: 100 } },
    sandboxManager,
    auditSink: audit,
  });

  const rejected = qm.checkQuota(ACCOUNT, 'p-new', QUOTA_RESOURCES.CONCURRENT_SANDBOXES);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.limit, 'Resource_Quota');
  assert.equal(rejected.resource, 'concurrentSandboxes');
  assert.equal(rejected.max, 3);
  assert.equal(rejected.current, 3);
  assert.match(rejected.message, /Resource_Quota/);
  assert.match(rejected.message, /concurrent Sandboxes/);

  const events = audit.ofType(AUDIT_EVENTS.QUOTA_EXCEEDED);
  assert.equal(events.length, 1);
  assert.equal(events[0].resource, 'concurrentSandboxes');
});

test('checkQuota allows concurrent sandboxes below the ceiling', () => {
  const sandboxManager = { activeProjectIds: () => ['p1'] };
  const qm = createQuotaManager({
    config: { quota: { maxConcurrentSandboxes: 3 } },
    sandboxManager,
  });
  assert.deepEqual(qm.checkQuota(ACCOUNT, 'p-new', QUOTA_RESOURCES.CONCURRENT_SANDBOXES), { ok: true });
});

test('checkQuota rejects over-maxTotalProjects via the injected projectCounter, naming the Resource_Quota', () => {
  const audit = createCollectorSink();
  const qm = createQuotaManager({
    config: { quota: { maxTotalProjects: 2 } },
    projectCounter: (accountId) => (accountId === 'acct-1' ? 2 : 0),
    auditSink: audit,
  });

  const rejected = qm.checkQuota(ACCOUNT, null, QUOTA_RESOURCES.TOTAL_PROJECTS);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.limit, 'Resource_Quota');
  assert.equal(rejected.resource, 'totalProjects');
  assert.equal(rejected.max, 2);
  assert.equal(rejected.current, 2);
  assert.match(rejected.message, /total Projects/);

  // A different account below the ceiling is allowed.
  assert.deepEqual(
    qm.checkQuota({ id: 'acct-2' }, null, QUOTA_RESOURCES.TOTAL_PROJECTS),
    { ok: true },
  );

  assert.equal(audit.ofType(AUDIT_EVENTS.QUOTA_EXCEEDED).length, 1);
});

test('observeUsage suspends the offending Sandbox on a sustained-failed-build signal and reports the action, emitting ABUSE_MITIGATED', () => {
  const audit = createCollectorSink();
  const released = [];
  const sandboxManager = {
    activeProjectIds: () => [],
    release: (projectId) => {
      released.push(projectId);
      return { projectId, released: true };
    },
  };
  const qm = createQuotaManager({
    config: { abuse: { maxFailedBuilds: 5, action: 'suspend' } },
    sandboxManager,
    auditSink: audit,
  });

  const result = qm.observeUsage('proj-abuse', { failedBuilds: 5 });
  assert.equal(result.mitigated, true);
  assert.equal(result.action, 'suspend');
  assert.equal(result.sandboxId, 'proj-abuse');
  assert.equal(result.projectId, 'proj-abuse');
  assert.equal(result.reason, 'sustained-failed-build');

  // The SandboxManager suspend/release action was actually invoked.
  assert.deepEqual(released, ['proj-abuse']);

  // ABUSE_MITIGATED + an operational event were emitted.
  const mitigated = audit.ofType(AUDIT_EVENTS.ABUSE_MITIGATED);
  assert.equal(mitigated.length, 1);
  assert.equal(mitigated[0].action, 'suspend');
  assert.equal(mitigated[0].projectId, 'proj-abuse');
  assert.equal(audit.ofType(AUDIT_EVENTS.OPERATIONAL_ERROR).length, 1);
});

test('observeUsage mitigates a runaway-resource signal and can use an injected throttle action', () => {
  const audit = createCollectorSink();
  const throttled = [];
  const qm = createQuotaManager({
    config: { abuse: { maxFailedBuilds: 5, action: 'throttle' } },
    suspendAction: ({ sandboxId, action }) => throttled.push({ sandboxId, action }),
    auditSink: audit,
  });

  const result = qm.observeUsage('sbx-9', { runawayResource: true, projectId: 'proj-9' });
  assert.equal(result.mitigated, true);
  assert.equal(result.action, 'throttle');
  assert.equal(result.projectId, 'proj-9');
  assert.equal(result.reason, 'runaway-resource');
  assert.deepEqual(throttled, [{ sandboxId: 'sbx-9', action: 'throttle' }]);
  assert.equal(audit.ofType(AUDIT_EVENTS.ABUSE_MITIGATED).length, 1);
});

test('observeUsage below threshold does nothing (no mitigation, no action, no audit event)', () => {
  const audit = createCollectorSink();
  const released = [];
  const sandboxManager = {
    activeProjectIds: () => [],
    release: (projectId) => released.push(projectId),
  };
  const qm = createQuotaManager({
    config: { abuse: { maxFailedBuilds: 5 } },
    sandboxManager,
    auditSink: audit,
  });

  const result = qm.observeUsage('proj-ok', { failedBuilds: 4, runawayResource: false });
  assert.deepEqual(result, { mitigated: false });
  assert.deepEqual(released, [], 'no suspend/release below threshold');
  assert.equal(audit.ofType(AUDIT_EVENTS.ABUSE_MITIGATED).length, 0);
  assert.equal(audit.ofType(AUDIT_EVENTS.OPERATIONAL_ERROR).length, 0);
});

test('QuotaManager does not redefine per-Sandbox CPU/memory/exec-time limits (unknown resource passes through)', () => {
  const qm = createQuotaManager({});
  // The manager only understands cross-Sandbox / per-account quotas; a
  // per-Sandbox resource kind is NOT its concern (enforced by the SandboxManager
  // per Req 8.2) and must pass through rather than being (re)enforced here.
  assert.deepEqual(qm.checkQuota(ACCOUNT, 'p', 'cpu'), { ok: true });
  assert.deepEqual(qm.checkQuota(ACCOUNT, 'p', 'memory'), { ok: true });
  assert.deepEqual(qm.checkQuota(ACCOUNT, 'p', 'execTime'), { ok: true });
});
