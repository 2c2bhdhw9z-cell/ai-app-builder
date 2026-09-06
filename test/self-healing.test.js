/**
 * Self-Healing controller tests (spec Task 17.2, Req 20.2, 20.5, 20.6, 20.7,
 * 20.8, 20.9, 20.10, 20.11). HERMETIC + OFFLINE per context.json:
 *   - the verify + agentFactory seams are spy/counter FAKES so the loop's
 *     boundedness, oscillation short-circuit, PASS-stops-mutation, and
 *     cancellation behavior are asserted by CALL COUNTS (this is how the mutation
 *     checks flip);
 *   - one scenario exercises a REAL plumby agent turn via the hermetic harness
 *     (test/support/scripted-agent.js) so the injected agentFactory seam is
 *     proven against the real loop + scripted provider (no network);
 *   - the SnapshotStore wiring is asserted via a spy on onTurnComplete;
 *   - the runGeneration integration is asserted end-to-end with a fake pipeline.
 *
 * MUTATION SENSITIVITY (documented for the reviewer):
 *   - Boundedness: with verify ALWAYS FAIL (each attempt a NEW signature) and
 *     maxAttempts=N, verify is called exactly N times inside the loop and the
 *     result is reason==='max-attempts'. Removing the cap would make verify be
 *     called unboundedly (the test asserts the exact count, so it flips).
 *   - Oscillation: with verify returning the SAME failure signature, the loop
 *     stops at the FIRST repeat — strictly FEWER agent/verify calls than the cap.
 *     Removing the signature short-circuit lets it run to the cap (flips the
 *     call-count + reason==='oscillation' assertions).
 *   - PASS-stops: verify FAILs once then PASSes; the agent is sent EXACTLY once
 *     and verify EXACTLY once inside the loop. Making the loop ignore a PASS and
 *     keep going would raise those counts (flips).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import {
  createSelfHealingController,
  failureSignatureOf,
  MAX_ATTEMPTS_FLOOR,
  MAX_ATTEMPTS_CEILING,
} from '../src/project/self-healing.js';
import { normalizeVerifyResult } from '../src/project/verify-result.js';
import { createProjectManager } from '../src/project/project-manager.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createProjectRegistry } from '../src/project/project-registry.js';
import { Target_Category, Project_Origin } from '../src/model/enums.js';
import { createScriptedAgent } from './support/scripted-agent.js';

// ---------------------------------------------------------------- fakes/helpers

const PROJECT = Object.freeze({ id: 'proj-1', sandboxId: 'proj-1', targetCategory: 'web-app' });
const SANDBOX = Object.freeze({ projectId: 'proj-1', handle: 'sandbox:proj-1' });

/** The plumby-verify TEXT contract for a FAIL, with a distinguishing tail. */
function failText(tail = 'error: something broke') {
  return `verdict: FAIL\nexit code: 1\n${tail}`;
}
const PASS_TEXT = 'verdict: PASS\nexit code: 0\nAll checks passed';

/** A structured FAIL VerifyResult (the shape runGeneration hands to heal()). */
function failResult(tail = 'error: something broke') {
  return { verdict: 'FAIL', exitCode: 1, failureLines: 'verdict: FAIL', outputTail: tail };
}

/**
 * A verify seam that returns each scripted value in order (last value repeats).
 * RECORDS every call so call-counts can be asserted.
 */
function scriptedVerify(values) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const idx = Math.min(calls.length - 1, values.length - 1);
    const v = values[idx];
    if (typeof v === 'function') return v();
    return v;
  };
  fn.calls = calls;
  return fn;
}

/** A counting agentFactory whose agent.send() records + returns an optional result. */
function countingAgentFactory(sendImpl) {
  const sends = [];
  const factory = (args) => ({
    agent: {
      cwd: '/tmp/project',
      async send(text, opts) {
        sends.push({ text, opts, factoryArgs: args });
        return typeof sendImpl === 'function' ? sendImpl(text, opts, sends.length) : undefined;
      },
    },
  });
  factory.sends = sends;
  return factory;
}

/** A spy SnapshotStore recording onTurnComplete calls; returns a committed snapshot. */
function spySnapshotStore() {
  const calls = [];
  return {
    calls,
    onTurnComplete(args) {
      calls.push(args);
      return { ok: true, projectId: args.projectId, snapshotId: 'sha-healed', committed: true, verdict: args.verifyResult.verdict };
    },
  };
}

/** A spy QuotaManager recording observeUsage (the sustained-failed-build seam). */
function spyQuotaManager() {
  const calls = [];
  return { calls, observeUsage(sandboxId, signal) { calls.push({ sandboxId, signal }); return { mitigated: false }; } };
}

/** A spy Observability recording emitted operational events + metrics. */
function spyObservability() {
  const events = [];
  const metrics = [];
  return {
    events,
    metrics,
    emitOperationalEvent(e) { events.push(e); return e; },
    emitMetric(name, fields) { metrics.push({ name, fields }); return { name, ...fields }; },
  };
}

// ---------------------------------------------------------------------- 20.2

test('(1) verify-cannot-produce leaves files unchanged and runs no agent turn (Req 20.2)', async () => {
  // A verify seam that THROWS inside a re-verify: heal must report the cause and
  // not loop further. To hit the initial-cannot-produce path we pass a
  // non-verdict initial result.
  const verify = scriptedVerify([failText()]);
  const agentFactory = countingAgentFactory();
  const controller = createSelfHealingController({ agentFactory, verify });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: { notAVerdict: true } });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'VERIFY_UNAVAILABLE');
  assert.equal(res.filesUnchanged, true);
  assert.equal(agentFactory.sends.length, 0, 'no agent turn on verify-cannot-produce');
  assert.equal(verify.calls.length, 0, 'no verify re-run on verify-cannot-produce');
});

test('(1b) a verify seam that THROWS inside the loop stops cleanly as VERIFY_UNAVAILABLE (Req 20.2)', async () => {
  const verify = scriptedVerify([
    () => { throw new Error('verify tool crashed'); },
  ]);
  const agentFactory = countingAgentFactory();
  const controller = createSelfHealingController({ agentFactory, verify });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult() });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'VERIFY_UNAVAILABLE');
  assert.equal(res.filesUnchanged, true);
  assert.equal(agentFactory.sends.length, 1, 'exactly one correction turn ran before the re-verify threw');
  assert.equal(verify.calls.length, 1);
});

// ---------------------------------------------------------------------- 20.7/20.11

test('(2) FAIL -> heal -> re-verify PASS stops on PASS, reports attempts + diffs, and triggers a turn-pass snapshot (Req 20.7/20.11)', async () => {
  const verify = scriptedVerify([PASS_TEXT]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn', diff: '--- a\n+++ b\n@@ fix @@' }));
  const snapshotStore = spySnapshotStore();
  const controller = createSelfHealingController({ agentFactory, verify, snapshotStore });

  const projectTree = { 'index.js': 'console.log(1)' };
  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult(), projectTree });

  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'PASS');
  assert.equal(res.attempts, 1);
  assert.ok(Array.isArray(res.diffs) && res.diffs.length === 1, 'corrective diffs are reported');
  assert.ok(Array.isArray(res.history) && res.history.length >= 2);
  // The healed green turn reused the SnapshotStore turn-pass policy.
  assert.equal(snapshotStore.calls.length, 1, 'onTurnComplete called exactly once on the healed PASS');
  assert.equal(snapshotStore.calls[0].projectId, PROJECT.id);
  assert.equal(snapshotStore.calls[0].verifyResult.verdict, 'PASS');
  assert.deepEqual(snapshotStore.calls[0].projectTree, projectTree);
  assert.ok(res.snapshot && res.snapshot.committed === true);
});

test('(2b) MUTATION: PASS stops the loop the instant verify returns PASS — exactly one agent turn + one verify (Req 20.7)', async () => {
  // verify FAILs on the first re-verify, then PASSes. The loop must send the
  // agent exactly twice and verify exactly twice, then STOP — not run a third.
  const verify = scriptedVerify([failText('still broken'), PASS_TEXT]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const controller = createSelfHealingController({ agentFactory, verify, defaultMaxAttempts: 5 });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult() });

  assert.equal(res.ok, true);
  assert.equal(res.verdict, 'PASS');
  assert.equal(res.attempts, 2);
  assert.equal(agentFactory.sends.length, 2, 'stops sending the moment verify PASSes (not run to the cap)');
  assert.equal(verify.calls.length, 2, 'verify not called again after PASS');
});

// ---------------------------------------------------------------------- 20.9/20.10 (cap)

test('(3) cap stops without an infinite loop — verify called exactly maxAttempts times, files editable (Req 20.9/20.10)', async () => {
  const N = 3;
  // Each FAIL has a DISTINCT tail so signatures differ and the cap (not the
  // oscillation short-circuit) is what stops the loop.
  let i = 0;
  const verify = scriptedVerify([() => failText(`distinct-failure-${i++}`)]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const quotaManager = spyQuotaManager();
  const controller = createSelfHealingController({ agentFactory, verify, quotaManager, defaultMaxAttempts: N });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult('initial') });

  assert.equal(res.ok, false);
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, 'max-attempts');
  assert.equal(res.attempts, N);
  assert.equal(res.editable, true, 'files left editable so the user can intervene');
  assert.ok(res.outputTail, 'unresolved output surfaced');
  assert.ok(Array.isArray(res.history) && res.history.length === N + 1, 'full attempt history surfaced');
  // MUTATION: the loop is strictly bounded by the cap.
  assert.equal(verify.calls.length, N, 'verify called exactly maxAttempts times, never unbounded');
  assert.equal(agentFactory.sends.length, N, 'agent sent exactly maxAttempts times');
  // The sustained-failed-build abuse signal is fed on give-up.
  assert.equal(quotaManager.calls.length, 1);
  assert.equal(quotaManager.calls[0].signal.reason, 'sustained-failed-build');
  assert.equal(quotaManager.calls[0].signal.failedBuilds, N);
});

test('(3b) MUTATION: removing the cap would break boundedness — maxAttempts=1 runs exactly one attempt', async () => {
  let i = 0;
  const verify = scriptedVerify([() => failText(`d-${i++}`)]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const controller = createSelfHealingController({ agentFactory, verify, defaultMaxAttempts: 1 });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult('x') });

  assert.equal(res.reason, 'max-attempts');
  assert.equal(res.attempts, 1);
  assert.equal(verify.calls.length, 1);
  assert.equal(agentFactory.sends.length, 1);
});

// ---------------------------------------------------------------------- 20.8 (oscillation)

test('(4) repeated IDENTICAL failure signature stops EARLY as oscillation, not retrying variations (Req 20.8)', async () => {
  // verify ALWAYS returns the SAME failure text -> same signature. The INITIAL
  // verify result handed to heal is the SAME normalized value the seam returns,
  // so the FIRST re-verify already matches the captured signature -> the loop
  // stops at attempt 1, well before the cap of 5.
  const SAME = failText('the exact same error every time');
  const verify = scriptedVerify([SAME]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const quotaManager = spyQuotaManager();
  const controller = createSelfHealingController({ agentFactory, verify, quotaManager, defaultMaxAttempts: 5 });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: normalizeVerifyResult(SAME) });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'oscillation');
  assert.equal(res.editable, true);
  // MUTATION: it stops EARLY — strictly fewer calls than the cap of 5.
  assert.equal(res.attempts, 1, 'stops at the first repeated signature');
  assert.equal(agentFactory.sends.length, 1, 'does NOT keep retrying variations to the cap');
  assert.equal(verify.calls.length, 1);
  assert.ok(res.attempts < 5, 'fewer attempts than the cap');
  assert.equal(quotaManager.calls.length, 1, 'abuse signal fed on oscillation give-up too');
});

test('(4b) failureSignatureOf is stable across volatile noise (paths/timestamps/PIDs) but distinguishes real differences', () => {
  const a = failureSignatureOf({ verdict: 'FAIL', exitCode: 1, failureLines: 'boom', outputTail: 'Error at /home/alice/app/src/x.js:12 pid 4821 at 2024-01-02T03:04:05.678Z' });
  const b = failureSignatureOf({ verdict: 'FAIL', exitCode: 1, failureLines: 'boom', outputTail: 'Error at /var/tmp/build/src/x.js:99 pid 9137 at 2025-07-08T11:22:33.001Z' });
  assert.equal(a, b, 'volatile path/pid/timestamp differences normalize to the same signature');

  const c = failureSignatureOf({ verdict: 'FAIL', exitCode: 2, failureLines: 'boom', outputTail: 'a genuinely different error message' });
  assert.notEqual(a, c, 'a real difference produces a different signature');
});

test('(4c) two failures differing ONLY in a short multi-digit code/line number are DISTINGUISHED (no premature oscillation, Req 20.8)', () => {
  // Over-normalization guard: a short numeric status/error code is often the ONLY
  // discriminator between two genuinely-different failures. Collapsing it would
  // hash them equal and prematurely stop a still-progressing fix. failureLines
  // preserves short (1..3 digit) numeric tokens, so these must DIFFER.
  const http404 = failureSignatureOf({ verdict: 'FAIL', exitCode: 1, failureLines: 'request failed with status 404', outputTail: 'see log' });
  const http500 = failureSignatureOf({ verdict: 'FAIL', exitCode: 1, failureLines: 'request failed with status 500', outputTail: 'see log' });
  assert.notEqual(http404, http500, 'HTTP 404 vs 500 must NOT collapse to the same signature');

  const line12 = failureSignatureOf({ verdict: 'FAIL', exitCode: 1, failureLines: 'SyntaxError at line 12', outputTail: '' });
  const line87 = failureSignatureOf({ verdict: 'FAIL', exitCode: 1, failureLines: 'SyntaxError at line 87', outputTail: '' });
  assert.notEqual(line12, line87, 'a compile error on line 12 vs line 87 must NOT collapse');

  // But a genuinely LONG digit run (pid/port/offset) in failureLines still
  // collapses — those are volatile noise, not a discriminator.
  const pidA = failureSignatureOf({ verdict: 'FAIL', exitCode: 1, failureLines: 'worker crashed pid 48213', outputTail: '' });
  const pidB = failureSignatureOf({ verdict: 'FAIL', exitCode: 1, failureLines: 'worker crashed pid 91375', outputTail: '' });
  assert.equal(pidA, pidB, 'long PID runs are still normalized away');
});

// ---------------------------------------------------------------------- cancellation

test('(5) an already-aborted signal aborts cleanly with NO agent/verify calls', async () => {
  const verify = scriptedVerify([failText()]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const controller = createSelfHealingController({ agentFactory, verify, defaultMaxAttempts: 5 });

  const ac = new AbortController();
  ac.abort();
  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult(), signal: ac.signal });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'CANCELLED');
  assert.equal(res.editable, true);
  assert.equal(agentFactory.sends.length, 0, 'no agent turn after abort');
  assert.equal(verify.calls.length, 0, 'no verify after abort');
});

test('(5b) an agent turn returning stopReason:aborted stops the loop with no further calls', async () => {
  const verify = scriptedVerify([PASS_TEXT]);
  // The agent reports aborted on its first send.
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'aborted' }));
  const controller = createSelfHealingController({ agentFactory, verify, defaultMaxAttempts: 5 });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult() });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'CANCELLED');
  assert.equal(agentFactory.sends.length, 1, 'the aborted turn was attempted once');
  assert.equal(verify.calls.length, 0, 'no re-verify after an aborted agent turn');
});

test('(5c) an abort landing DURING the agent turn (before it resolves normally) triggers NO extra verify (mid-loop cancellation window)', async () => {
  // The agent turn resolves NORMALLY (not stopReason:aborted, no throw) but the
  // signal has already been aborted by the time it returns. The controller must
  // re-check the signal BEFORE safeVerify so the abort does not trigger one more
  // verify — it returns the same clean CANCELLED result.
  const ac = new AbortController();
  const verify = scriptedVerify([PASS_TEXT]);
  const agentFactory = countingAgentFactory(() => {
    // Abort mid-turn, then resolve normally (no thrown abort, no aborted flag).
    ac.abort();
    return { stopReason: 'end_turn', diff: 'partial fix' };
  });
  const controller = createSelfHealingController({ agentFactory, verify, defaultMaxAttempts: 5 });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult(), signal: ac.signal });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'CANCELLED');
  assert.equal(res.editable, true);
  assert.equal(agentFactory.sends.length, 1, 'the one in-flight agent turn ran');
  assert.equal(verify.calls.length, 0, 'NO re-verify runs after the mid-turn abort');
});

// ---------------------------------------------------------------------- 20.6 (disabled)

test('(6) disabled healing reports the failing VerifyResult and attempts no correction (Req 20.6)', async () => {
  const verify = scriptedVerify([PASS_TEXT]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const controller = createSelfHealingController({ agentFactory, verify });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult('boom'), config: { enabled: false } });

  assert.equal(res.ok, false);
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.reason, 'disabled');
  assert.equal(res.attempts, 0);
  assert.equal(res.editable, true);
  assert.equal(agentFactory.sends.length, 0, 'no correction attempted when disabled');
  assert.equal(verify.calls.length, 0);
});

// ---------------------------------------------------------------------- 20.5 (config)

test('(7) maxAttempts defaults to 3 and validates to the inclusive 1..10 range (Req 20.5)', async () => {
  const verify = scriptedVerify([failText()]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const controller = createSelfHealingController({ agentFactory, verify });

  // Default cap = 3 (distinct failures each time so the cap stops it).
  let i = 0;
  const verify3 = scriptedVerify([() => failText(`d${i++}`)]);
  const c3 = createSelfHealingController({ agentFactory: countingAgentFactory(() => ({ stopReason: 'end_turn' })), verify: verify3 });
  const capped = await c3.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult('x') });
  assert.equal(capped.attempts, 3, 'default maxAttempts is 3');

  // Boundaries + rejects via resolveConfig.
  assert.equal(controller.MAX_ATTEMPTS_FLOOR, MAX_ATTEMPTS_FLOOR);
  assert.equal(controller.MAX_ATTEMPTS_CEILING, MAX_ATTEMPTS_CEILING);
  assert.equal(controller.resolveConfig({ maxAttempts: 1 }).ok, true, 'floor 1 accepted');
  assert.equal(controller.resolveConfig({ maxAttempts: 10 }).ok, true, 'ceiling 10 accepted');

  const below = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult(), config: { maxAttempts: 0 } });
  assert.equal(below.ok, false);
  assert.equal(below.code, 'INVALID_CONFIG', 'below floor rejected, not silently coerced');
  const above = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult(), config: { maxAttempts: 11 } });
  assert.equal(above.code, 'INVALID_CONFIG', 'above ceiling rejected, not silently coerced');
  const nonInt = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult(), config: { maxAttempts: 2.5 } });
  assert.equal(nonInt.code, 'INVALID_CONFIG', 'non-integer rejected');
  // No agent turn ran for any rejected config.
  assert.equal(agentFactory.sends.length, 0);
});

// ---------------------------------------------------------------------- observability

test('(8) observability emits a per-attempt self_heal_attempt event (Activity Stream surface)', async () => {
  const verify = scriptedVerify([PASS_TEXT]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const observability = spyObservability();
  const controller = createSelfHealingController({ agentFactory, verify, observability });

  await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult() });

  // Initial FAIL (attempt 0) + the PASS attempt (attempt 1).
  assert.ok(observability.events.length >= 2);
  assert.equal(observability.events[0].type, 'self_heal_attempt');
  assert.equal(observability.events[0].subsystem, 'build');
  assert.ok(observability.events.some((e) => e.verdict === 'PASS'));
  assert.ok(observability.metrics.length >= 1);
});

test('(8b) the injected now() clock stamps `at` on every attempt event, metric, and history record (Req 20 time seam)', async () => {
  const verify = scriptedVerify([PASS_TEXT]);
  const agentFactory = countingAgentFactory(() => ({ stopReason: 'end_turn' }));
  const observability = spyObservability();
  // A deterministic monotonic clock so we can assert `at` is sourced from it.
  let t = 5000;
  const now = () => (t += 100);
  const controller = createSelfHealingController({ agentFactory, verify, observability, now });

  const res = await controller.heal({ project: PROJECT, sandbox: SANDBOX, verifyResult: failResult() });

  assert.equal(res.ok, true);
  // Every history record carries an `at` from the injected clock (multiples of 100 above 5000).
  assert.ok(res.history.every((h) => typeof h.at === 'number' && h.at > 5000 && h.at % 100 === 0), 'history stamped via now()');
  // The clock is monotonic across the recorded attempts.
  assert.ok(res.history[1].at > res.history[0].at, 'attempt timestamps advance with the injected clock');
  // The emitted events + metrics carry the same `at` stamp.
  assert.ok(observability.events.every((e) => typeof e.at === 'number'), 'events carry an at stamp');
  assert.ok(observability.metrics.every((m) => typeof m.fields.at === 'number'), 'metrics carry an at stamp');
});

// ---------------------------------------------------------------------- real agent turn (hermetic harness)

test('(9) a REAL plumby agent turn drives a correction that flips verify to PASS (hermetic harness)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-heal-'));
  try {
    // The injected agentFactory yields a REAL plumby agent on the scripted
    // provider: it writes a fix file (through the real loop + tools, no network).
    const agentFactory = () => createScriptedAgent({
      cwd: dir,
      turns: [
        { toolCalls: [{ name: 'write_file', input: { path: 'fix.js', content: 'export const fixed = true;' } }] },
        { text: 'Fixed.' },
      ],
    });
    // verify FAILs first (already handed in), PASSes after the correction turn.
    const verify = scriptedVerify([PASS_TEXT]);
    const controller = createSelfHealingController({ agentFactory, verify });

    const res = await controller.heal({ project: { id: 'proj-real', sandboxId: 'proj-real' }, sandbox: SANDBOX, verifyResult: failResult() });

    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'PASS');
    assert.equal(res.attempts, 1);
    // The real agent turn actually wrote the fix file.
    const written = await fs.readFile(path.join(dir, 'fix.js'), 'utf8');
    assert.equal(written, 'export const fixed = true;');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------- runGeneration integration

test('(10) runGeneration engages the controller on FAIL and returns the PASS shape on a healed PASS; no controller = byte-identical FAIL', async () => {
  const fsSync = await import('node:fs');
  const base = fsSync.mkdtempSync(path.join(os.tmpdir(), 'aab-heal-pm-'));
  try {
    const layout = createStorageLayout(base);
    const registry = createProjectRegistry({ layout });

    const startCalls = [];
    const devServer = {
      start(args) { startCalls.push(args); return { ok: true, url: 'http://preview.local' }; },
      stop() { return { ok: true }; },
    };
    const sandboxManager = { acquire: (id) => ({ projectId: id }), activeProjectIds: () => [], release() {} };
    // generation agentFactory: the initial turn (no-op) and the heal turn.
    const genAgentFactory = () => ({ agent: { async send() {} } });

    // ---- with controller: verify FAILs (generation), then the heal turn's
    //      re-verify PASSes -> runGeneration returns the PASS shape.
    const genVerify = scriptedVerify([failText('gen broke')]); // runGeneration's own verify -> FAIL
    const healVerify = scriptedVerify([PASS_TEXT]);              // controller's re-verify -> PASS
    const snapshotStore = spySnapshotStore();
    const controller = createSelfHealingController({
      agentFactory: countingAgentFactory(() => ({ stopReason: 'end_turn', diff: 'fix' })),
      verify: healVerify,
      snapshotStore,
    });

    const withHeal = createProjectManager({
      registry, sandboxManager, devServer,
      agentFactory: genAgentFactory,
      verify: genVerify,
      selfHealingController: controller,
      snapshotStore,
      now: () => 1000,
    });

    const project = { id: 'pm-proj-1', ownerId: 'acct-1', sandboxId: 'pm-proj-1', targetCategory: 'web-app' };
    const projectTree = { 'a.js': '1' };
    const healed = await withHeal.runGeneration({ project, sandbox: { projectId: 'pm-proj-1' }, message: 'build it', projectTree });

    assert.equal(healed.ok, true);
    assert.equal(healed.verdict, 'PASS');
    assert.equal(healed.healed, true, 'flagged as healed');
    assert.equal(healed.attempts, 1);
    assert.equal(startCalls.length, 1, 'Dev_Server started exactly once on the healed PASS');
    assert.equal(snapshotStore.calls.length, 1, 'the healed PASS committed a turn-pass snapshot');

    // ---- NO controller injected: byte-identical FAIL report (editable), no
    //      Dev_Server start, no snapshot.
    startCalls.length = 0;
    const genVerify2 = scriptedVerify([failText('gen broke')]);
    const noHeal = createProjectManager({
      registry, sandboxManager, devServer,
      agentFactory: genAgentFactory,
      verify: genVerify2,
      snapshotStore: spySnapshotStore(),
      now: () => 1000,
    });
    const failed = await noHeal.runGeneration({ project, sandbox: { projectId: 'pm-proj-1' }, message: 'build it', projectTree });

    assert.equal(failed.ok, false);
    assert.equal(failed.verdict, 'FAIL');
    assert.equal(failed.editable, true);
    assert.equal(failed.healed, undefined, 'no controller -> no healed flag (unchanged behavior)');
    assert.equal(startCalls.length, 0, 'FAIL never starts the Dev_Server');
  } finally {
    fsSync.rmSync(base, { recursive: true, force: true });
  }
});

test('(11) no double-commit on a healed PASS: the SAME SnapshotStore in BOTH the manager and the controller commits onTurnComplete EXACTLY once', async () => {
  // Pins the no-double-commit invariant: the controller commits the turn-pass
  // snapshot via onTurnComplete, and runGeneration REUSES healed.snapshot rather
  // than re-committing. With one shared store across both layers, calls.length
  // must be exactly 1 (a re-commit in runGeneration would flip this to 2).
  const fsSync = await import('node:fs');
  const base = fsSync.mkdtempSync(path.join(os.tmpdir(), 'aab-heal-once-'));
  try {
    const layout = createStorageLayout(base);
    const registry = createProjectRegistry({ layout });

    const devServer = { start() { return { ok: true, url: 'http://preview.local' }; }, stop() { return { ok: true }; } };
    const sandboxManager = { acquire: (id) => ({ projectId: id }), activeProjectIds: () => [], release() {} };
    const genAgentFactory = () => ({ agent: { async send() {} } });

    const genVerify = scriptedVerify([failText('gen broke')]); // generation -> FAIL
    const healVerify = scriptedVerify([PASS_TEXT]);             // heal re-verify -> PASS

    // ONE shared spy store injected into BOTH the controller and the manager.
    const snapshotStore = spySnapshotStore();
    const controller = createSelfHealingController({
      agentFactory: countingAgentFactory(() => ({ stopReason: 'end_turn', diff: 'fix' })),
      verify: healVerify,
      snapshotStore,
    });
    const pm = createProjectManager({
      registry, sandboxManager, devServer,
      agentFactory: genAgentFactory,
      verify: genVerify,
      selfHealingController: controller,
      snapshotStore,
      now: () => 1000,
    });

    const project = { id: 'pm-once-1', ownerId: 'acct-1', sandboxId: 'pm-once-1', targetCategory: 'web-app' };
    const res = await pm.runGeneration({ project, sandbox: { projectId: 'pm-once-1' }, message: 'build it', projectTree: { 'a.js': '1' } });

    assert.equal(res.ok, true);
    assert.equal(res.verdict, 'PASS');
    assert.equal(res.healed, true);
    // THE invariant: exactly one turn-pass snapshot committed, never two.
    assert.equal(snapshotStore.calls.length, 1, 'onTurnComplete called EXACTLY once — no double-commit');
    assert.equal(snapshotStore.calls[0].verifyResult.verdict, 'PASS');
  } finally {
    fsSync.rmSync(base, { recursive: true, force: true });
  }
});
