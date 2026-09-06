/**
 * CommandGuard tests (node --test) — spec Task 6, Req 8.7–8.10 / 22.1–22.7.
 *
 * The guard is the SEPARATE, classifier-DEPENDENT gate in front of the
 * Isolation_Boundary. These tests use a STUB SandboxManager for deterministic
 * behavior (no real container needed for the guard's gating logic) while using
 * the REAL plumby classifier (composed via src/engine/plumby.js) so the
 * allow/confirm/refuse verdicts are the genuine ones.
 *
 * Property 5 (subtask 6.2*) runs >=100 iterations under the EXACT spec tag and
 * asserts a refuse-class command is NEVER handed to exec under any combination
 * of config/flags/consent. The 6.3* unit tests cover every gating path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createCommandGuard, truncateStream } from '../src/sandbox/command-guard.js';
import { createCommandGuard as fromBarrel } from '../src/sandbox/index.js';
import { classifyCommand } from '../src/engine/plumby.js';

/**
 * A stub SandboxManager whose exec records every call and returns a canned
 * denial-contract result. If `throwOnExec` is set, exec throws when called —
 * used to PROVE the guard never reaches exec on a blocked command.
 */
function stubManager(overrides = {}) {
  const calls = [];
  const result = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    denied: false,
    deniedReason: null,
    timedOut: false,
    signal: null,
    ...overrides.result,
  };
  return {
    calls,
    exec: async (projectId, command, opts) => {
      calls.push({ projectId, command, opts });
      if (overrides.throwOnExec) {
        throw new Error('exec must not be called for a blocked command');
      }
      if (typeof overrides.execImpl === 'function') {
        return Object.freeze(await overrides.execImpl({ projectId, command, opts }));
      }
      return Object.freeze({ ...result });
    },
  };
}

// Known-verdict command samples (verified against the real plumby classifier).
const REFUSE_SAMPLES = [
  'rm -rf /',
  'git filter-branch --tree-filter x HEAD',
  'git filter-repo --path secret',
  ':(){ :|:& };:',
  'mkfs.ext4 /dev/sda',
  'dd if=/dev/zero of=/dev/sda',
];
const CONFIRM_SAMPLES = [
  'git push --force origin main',
  'git push -f',
  'rails db:migrate',
  'alembic upgrade head',
  'nsupdate < changes.txt',
  'aws route53 change-resource-record-sets --hosted-zone-id Z1',
];
const ALLOW_SAMPLES = ['ls', 'npm test', 'echo hi', 'cat README.md', ''];

// --- Property 5 (subtask 6.2*) -------------------------------------------

test(propertyTag(5, 'Permission classifier never allows refuse-class commands'), async () => {
  await fc.assert(
    fc.asyncProperty(
      // A mix of known refuse strings and random strings so refuse cases are
      // actually exercised; we filter to refuse-class before asserting.
      fc.oneof(
        fc.constantFrom(...REFUSE_SAMPLES),
        fc.string(),
        fc.string({ minLength: 0, maxLength: 40 }),
      ),
      // Random config/flag/consent combinations — none may let a refuse run.
      fc.boolean(), // subAgent
      fc.boolean(), // consent grant (should be irrelevant for refuse)
      fc.integer({ min: 1, max: 120000 }), // confirmTimeoutMs
      fc.integer({ min: 1, max: 120000 }), // classifyTimeoutMs
      async (command, subAgent, grant, confirmTimeoutMs, classifyTimeoutMs) => {
        fc.pre(classifyCommand(command).outcome === 'refuse');
        const manager = stubManager({ throwOnExec: true });
        const guard = createCommandGuard({
          manager,
          confirmTimeoutMs,
          classifyTimeoutMs,
          onConfirmRequest: () => grant, // approved consent must NOT help a refuse
        });
        const res = await guard.run('proj-1', command, { subAgent, onConfirmRequest: () => grant });
        assert.equal(res.executed, false, 'refuse-class must never execute');
        assert.equal(res.blocked, true);
        assert.equal(res.outcome, 'refuse');
        assert.equal(manager.calls.length, 0, 'exec must never be called for refuse');
      },
    ),
    fcConfig,
  );
});

// --- W3: assert against an INDEPENDENT corpus, not classifier-filtered inputs ---

/**
 * Audit W3: Property 5 uses `fc.pre(classifyCommand(command).outcome ===
 * 'refuse')`, which FILTERS its inputs through the very classifier under test —
 * so any command the classifier wrongly rates non-refuse is silently EXCLUDED
 * from the property rather than failing it. That can only ever prove "the guard
 * routes a verdict it already computed", never "a destructive command cannot
 * reach exec".
 *
 * This corpus is curated INDEPENDENTLY of classifyCommand: each entry pins the
 * verdict the guard MUST reach, decided by a human from the command's meaning,
 * not by asking the classifier. A regression that makes the guard mis-route any
 * of these (or reach exec for a refuse / an unapproved confirm) fails HERE, even
 * though Property 5's `fc.pre` would have hidden it.
 *
 * (Scope note: the plumby classifier itself is out of this repo's control — its
 * own bypass findings H2-H5 are fixed in plumby. This corpus therefore lists
 * commands whose verdicts the SHIPPED classifier already computes, and asserts
 * the GUARD's routing/no-exec contract against them independently.)
 */
const INDEPENDENT_CORPUS = [
  // Destructive => refuse, must NEVER execute regardless of consent.
  { command: 'rm -rf /', expected: 'refuse' },
  { command: 'git filter-branch --tree-filter x HEAD', expected: 'refuse' },
  { command: ':(){ :|:& };:', expected: 'refuse' },
  { command: 'mkfs.ext4 /dev/sda', expected: 'refuse' },
  { command: 'dd if=/dev/zero of=/dev/sda', expected: 'refuse' },
  // Sensitive => confirm, must NOT execute without consent.
  { command: 'git push --force origin main', expected: 'confirm' },
  { command: 'rails db:migrate', expected: 'confirm' },
  // Ordinary => allow, executes.
  { command: 'ls', expected: 'allow' },
  { command: 'npm test', expected: 'allow' },
];

test('W3: an INDEPENDENT command corpus routes to the pinned verdict; refuse/unapproved-confirm never exec', async () => {
  for (const { command, expected } of INDEPENDENT_CORPUS) {
    // (i) refuse: consent is irrelevant, exec is never reached.
    if (expected === 'refuse') {
      const manager = stubManager({ throwOnExec: true });
      const guard = createCommandGuard({ manager, onConfirmRequest: () => true });
      const res = await guard.run('p', command, { onConfirmRequest: () => true });
      assert.equal(res.outcome, 'refuse', `${command} must be refuse`);
      assert.equal(res.executed, false, `${command} must never execute`);
      assert.equal(manager.calls.length, 0, `${command} must not reach exec`);
      continue;
    }
    // (ii) confirm WITHOUT consent: blocked, exec never reached.
    if (expected === 'confirm') {
      const denyManager = stubManager({ throwOnExec: true });
      const denyGuard = createCommandGuard({ manager: denyManager, onConfirmRequest: () => false });
      const denied = await denyGuard.run('p', command, { onConfirmRequest: () => false });
      assert.equal(denied.outcome, 'confirm', `${command} must be confirm`);
      assert.equal(denied.executed, false, `${command} must not execute without consent`);
      assert.equal(denyManager.calls.length, 0, `${command} must not reach exec without consent`);
      // WITH consent it executes (the gate genuinely gates, not blanket-denies).
      const okManager = stubManager({ result: { stdout: 'ok', exitCode: 0 } });
      const okGuard = createCommandGuard({ manager: okManager, onConfirmRequest: () => true });
      const approved = await okGuard.run('p', command, { onConfirmRequest: () => true });
      assert.equal(approved.executed, true, `${command} executes once consented`);
      continue;
    }
    // (iii) allow: executes without any prompt.
    const manager = stubManager({ result: { stdout: 'ok', exitCode: 0 } });
    const guard = createCommandGuard({ manager });
    const res = await guard.run('p', command);
    assert.equal(res.outcome, 'allow', `${command} must be allow`);
    assert.equal(res.executed, true, `${command} must execute`);
    assert.equal(manager.calls.length, 1, `${command} reaches exec exactly once`);
  }
});

// --- 6.3* (a) fail-closed: classify throws / unavailable -----------------

test('(a) fail closed to refuse when classify throws', async () => {
  const manager = stubManager({ throwOnExec: true });
  const guard = createCommandGuard({
    manager,
    classify: () => {
      throw new Error('classifier unavailable');
    },
  });
  const res = await guard.run('p', 'ls');
  assert.equal(res.outcome, 'refuse');
  assert.equal(res.executed, false);
  assert.equal(res.failedClosed, true);
  assert.equal(res.reason, 'could not classify');
  assert.equal(manager.calls.length, 0);
});

test('(a) fail closed to refuse when classify returns a malformed verdict', async () => {
  const manager = stubManager({ throwOnExec: true });
  const guard = createCommandGuard({ manager, classify: () => ({ nope: true }) });
  const res = await guard.run('p', 'ls');
  assert.equal(res.outcome, 'refuse');
  assert.equal(res.executed, false);
  assert.equal(res.failedClosed, true);
  assert.equal(manager.calls.length, 0);
});

// --- 6.3* (b) fail-closed: classify does not return within the ceiling ---

test('(b) fail closed to refuse when classify does not answer within classifyTimeoutMs', async () => {
  const manager = stubManager({ throwOnExec: true });
  const guard = createCommandGuard({
    manager,
    classifyTimeoutMs: 20,
    // A slow async classifier that never answers in time.
    classify: () => new Promise((resolve) => setTimeout(() => resolve({ outcome: 'allow' }), 10_000)),
  });
  const res = await guard.run('p', 'ls');
  assert.equal(res.outcome, 'refuse');
  assert.equal(res.executed, false);
  assert.equal(res.failedClosed, true);
  assert.equal(res.reason, 'could not classify');
  assert.equal(manager.calls.length, 0);
});

// --- 6.3* (c) representative refuse -> blocked, exec never called --------

test('(c) representative refuse commands are blocked and never executed', async () => {
  for (const command of ['rm -rf /', 'git filter-branch --all']) {
    const manager = stubManager({ throwOnExec: true });
    const guard = createCommandGuard({ manager });
    const res = await guard.run('p', command);
    assert.equal(res.outcome, 'refuse');
    assert.equal(res.executed, false);
    assert.equal(res.blocked, true);
    assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
    assert.equal(manager.calls.length, 0);
  }
});

// --- 6.3* (d) representative confirm -> consent gates execution ----------

test('(d) confirm-class executes when consent is granted within 60s', async () => {
  const manager = stubManager({ result: { stdout: 'done', exitCode: 0 } });
  const requests = [];
  const guard = createCommandGuard({
    manager,
    onConfirmRequest: (req) => {
      requests.push(req);
      return true;
    },
  });
  const res = await guard.run('p', 'git push --force origin main');
  assert.equal(res.outcome, 'confirm');
  assert.equal(res.confirmed, true);
  assert.equal(res.executed, true);
  assert.equal(res.denied, false);
  assert.equal(res.stdout, 'done');
  assert.equal(manager.calls.length, 1);
  // The confirm_request seam received a correlatable request.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].category, 'force-push');
  assert.ok(requests[0].requestId);
});

test('(d) confirm-class is denied (state unchanged) when consent is denied', async () => {
  const manager = stubManager({ throwOnExec: true });
  const guard = createCommandGuard({ manager, onConfirmRequest: () => false });
  const res = await guard.run('p', 'rails db:migrate');
  assert.equal(res.outcome, 'confirm');
  assert.equal(res.executed, false);
  assert.equal(res.denied, true);
  assert.equal(res.reason, 'confirmation denied');
  assert.equal(manager.calls.length, 0);
});

test('(d) confirm-class is denied when no consent mechanism is supplied', async () => {
  const manager = stubManager({ throwOnExec: true });
  const guard = createCommandGuard({ manager });
  const res = await guard.run('p', 'git push --force origin main');
  assert.equal(res.outcome, 'confirm');
  assert.equal(res.executed, false);
  assert.equal(res.denied, true);
  assert.equal(res.reason, 'confirmation not granted within 60000ms');
  assert.equal(manager.calls.length, 0);
});

test('(d) confirm-class is denied when consent is not granted within confirmTimeoutMs', async () => {
  const manager = stubManager({ throwOnExec: true });
  const guard = createCommandGuard({
    manager,
    confirmTimeoutMs: 20,
    onConfirmRequest: () => new Promise((resolve) => setTimeout(() => resolve(true), 10_000)),
  });
  const res = await guard.run('p', 'nsupdate < changes.txt');
  assert.equal(res.outcome, 'confirm');
  assert.equal(res.executed, false);
  assert.equal(res.denied, true);
  assert.equal(res.reason, 'confirmation not granted within 20ms');
  assert.equal(manager.calls.length, 0);
});

// --- 6.3* (e) allow -> proceeds; exec contract mapped correctly ----------

test('(e) allow-class proceeds and calls exec', async () => {
  const manager = stubManager({ result: { stdout: 'files', exitCode: 0 } });
  const guard = createCommandGuard({ manager });
  const res = await guard.run('p', 'ls');
  assert.equal(res.outcome, 'allow');
  assert.equal(res.executed, true);
  assert.equal(res.denied, false);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, 'files');
  assert.equal(manager.calls.length, 1);
});

test('(e) a non-zero in-box exit stays executed:true / denied:false (command own failure)', async () => {
  const manager = stubManager({
    result: { stdout: '', stderr: 'boom', exitCode: 2, denied: false, deniedReason: null },
  });
  const guard = createCommandGuard({ manager });
  const res = await guard.run('p', 'npm test');
  assert.equal(res.executed, true);
  assert.equal(res.denied, false);
  assert.equal(res.deniedReason, null);
  assert.equal(res.exitCode, 2);
  assert.equal(res.stderr, 'boom');
});

test('(e) an exec launch-failure surfaces denied:true with deniedReason', async () => {
  const manager = stubManager({
    result: { exitCode: null, denied: true, deniedReason: 'launch-failure', stderr: 'no runtime' },
  });
  const guard = createCommandGuard({ manager });
  const res = await guard.run('p', 'ls');
  assert.equal(res.executed, true);
  assert.equal(res.denied, true);
  assert.equal(res.deniedReason, 'launch-failure');
  assert.equal(res.exitCode, null);
});

test('(e) an exec timeout surfaces denied:true with deniedReason timeout', async () => {
  const manager = stubManager({
    result: { exitCode: null, denied: true, deniedReason: 'timeout', timedOut: true },
  });
  const guard = createCommandGuard({ manager });
  const res = await guard.run('p', 'sleep 999');
  assert.equal(res.executed, true);
  assert.equal(res.denied, true);
  assert.equal(res.deniedReason, 'timeout');
  assert.equal(res.timedOut, true);
});

// --- 6.3* (f) sub-agent read-only policy ---------------------------------

test('(f) sub-agent: refuse-class is blocked without execution', async () => {
  const manager = stubManager({ throwOnExec: true });
  const guard = createCommandGuard({ manager });
  const res = await guard.run('p', 'rm -rf /', { subAgent: true });
  assert.equal(res.executed, false);
  assert.equal(res.blocked, true);
  assert.equal(res.subAgent, true);
  assert.match(res.reason, /read-only sub-agent policy/);
  assert.equal(manager.calls.length, 0);
});

test('(f) sub-agent: confirm-class is blocked without execution even with consent', async () => {
  const manager = stubManager({ throwOnExec: true });
  const guard = createCommandGuard({ manager, onConfirmRequest: () => true });
  const res = await guard.run('p', 'git push --force origin main', {
    subAgent: true,
    onConfirmRequest: () => true,
  });
  assert.equal(res.executed, false);
  assert.equal(res.blocked, true);
  assert.equal(res.subAgent, true);
  assert.match(res.reason, /read-only sub-agent policy/);
  assert.equal(manager.calls.length, 0);
});

test('(f) sub-agent: allow-class proceeds', async () => {
  const manager = stubManager({ result: { stdout: 'ok', exitCode: 0 } });
  const guard = createCommandGuard({ manager });
  const res = await guard.run('p', 'ls', { subAgent: true });
  assert.equal(res.outcome, 'allow');
  assert.equal(res.executed, true);
  assert.equal(manager.calls.length, 1);
});

// --- 6.3* (g) truncateStream ---------------------------------------------

test('(g) truncateStream leaves a sub-64KB stream unchanged', () => {
  const text = 'a'.repeat(1000);
  assert.equal(truncateStream(text), text);
  assert.equal(truncateStream(''), '');
});

test('(g) truncateStream retains first 65536 bytes and appends a single notice line', () => {
  const total = 65536 + 5000;
  const text = 'a'.repeat(total); // pure ASCII: 1 byte per char
  const out = truncateStream(text);
  const lines = out.split('\n');
  const notice = lines[lines.length - 1];
  // The kept payload is exactly the first 65536 bytes.
  const kept = out.slice(0, out.length - notice.length - 1); // drop notice + its \n
  assert.equal(Buffer.byteLength(kept, 'utf8'), 65536);
  // The notice is on its own line and names the omitted byte count.
  assert.equal(notice, '[output truncated: 5000 bytes omitted]');
  // The notice line contains only the notice (own line).
  assert.equal(lines.filter((l) => l.includes('output truncated')).length, 1);
});

test('(g) truncateStream never splits a multibyte UTF-8 sequence at the boundary', () => {
  // '€' is 3 bytes in utf8. Fill just past 64 KB with multibyte chars.
  const euro = '\u20AC';
  const count = Math.ceil((65536 + 300) / 3);
  const text = euro.repeat(count);
  const out = truncateStream(text);
  const notice = out.split('\n').pop();
  const kept = out.slice(0, out.length - notice.length - 1);
  // The kept slice is valid UTF-8 (no replacement char introduced) and <= 65536 bytes.
  assert.ok(Buffer.byteLength(kept, 'utf8') <= 65536);
  assert.ok(!kept.includes('\uFFFD'), 'no broken multibyte sequence');
  assert.match(notice, /^\[output truncated: \d+ bytes omitted\]$/);
});

test('(g) the guard truncates both stdout and stderr of an exec result', async () => {
  const big = 'x'.repeat(65536 + 100);
  const manager = stubManager({ result: { stdout: big, stderr: big, exitCode: 0 } });
  const guard = createCommandGuard({ manager });
  const res = await guard.run('p', 'ls');
  assert.match(res.stdout, /\n\[output truncated: 100 bytes omitted\]$/);
  assert.match(res.stderr, /\n\[output truncated: 100 bytes omitted\]$/);
});

// --- barrel export smoke -------------------------------------------------

test('createCommandGuard is exported from the sandbox barrel', () => {
  assert.equal(typeof fromBarrel, 'function');
});
