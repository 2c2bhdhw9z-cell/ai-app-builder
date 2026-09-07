/**
 * EXHAUSTIVE behavioral-hook routing suite (spec Task 22.5 / FEAT-006,
 * Req 12.11, 12.12; also 12.5, 12.6).
 *
 * REAL collaborators: the REAL CommandGuard (src/sandbox/command-guard.js)
 * composing plumby's REAL classifier (via the plumby boundary), the REAL
 * lock-in hooks (src/skills/lockin-hooks.js). The ONLY fake is the exec
 * boundary — a SandboxManager whose exec returns the REAL frozen result
 * contract and mutates a tiny in-memory "project state" so we can prove a
 * DECLINED confirmation leaves the pre-operation state intact. The confirm
 * seam (onConfirmRequest) and a clock are injected, never stubbed inside the
 * guard.
 *
 * The smoke suite (test/skills-session.test.js) covers filter-branch + a single
 * force-push confirm/decline. This suite adds the full recoverable-op matrix
 * (force-push, remote-delete, credential-rotation, db-migration, dns-change),
 * proves filter-repo is refused with consent too, proves the DECLINE preserves
 * pre-operation state, and exhaustively covers the two skill selectors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLockinHooks,
  DEVENDOR_SKILL_NAME,
  GUARD_SKILL_NAME,
} from '../src/skills/lockin-hooks.js';
import { createCommandGuard } from '../src/sandbox/command-guard.js';

/**
 * A fake SandboxManager. Its exec is the ONLY faked seam. It returns the REAL
 * frozen exec contract the guard consumes, and applies a `mutate` side effect
 * to a shared `state` object so a test can prove that a command that never
 * reaches exec leaves state untouched (pre-operation state preserved).
 */
function fakeManager(state, mutate = () => {}) {
  const calls = [];
  return {
    calls,
    exec: async (projectId, command, opts) => {
      calls.push({ projectId, command, opts });
      mutate(state); // the "destructive" effect only happens if exec is reached
      return Object.freeze({
        stdout: 'done',
        stderr: '',
        exitCode: 0,
        denied: false,
        deniedReason: null,
        timedOut: false,
        signal: null,
      });
    },
  };
}

/** Build REAL guard + REAL hooks over a fake exec, with an injected clock. */
function build(state, mutate) {
  const manager = fakeManager(state, mutate);
  const guard = createCommandGuard({ manager, now: () => new Date('2026-04-04T00:00:00.000Z') });
  const hooks = createLockinHooks({ commandGuard: guard });
  return { manager, guard, hooks };
}

// --- (a) unrecoverable ops REFUSED even with a granting confirm seam ---------

for (const command of [
  'git filter-branch --tree-filter "rm -f secrets" -- --all',
  'git filter-repo --path secrets --invert-paths',
]) {
  test(`unrecoverable "${command.split(' ').slice(0, 2).join(' ')}" is REFUSED even with a granting confirm seam (executed:false, state unchanged) (Req 12.11)`, async () => {
    const state = { history: 'intact' };
    const { manager, hooks } = build(state, (s) => { s.history = 'rewritten'; });
    const res = await hooks.routeDestructiveOperation('proj-1', command, {
      onConfirmRequest: () => true, // GRANT — must be irrelevant for a refuse
    });
    assert.equal(res.outcome, 'refuse');
    assert.equal(res.category, 'history-rewrite');
    assert.equal(res.executed, false);
    assert.equal(manager.calls.length, 0, 'a refuse must never reach exec');
    assert.equal(state.history, 'intact', 'pre-operation state is preserved');
  });
}

// --- (b) recoverable ops: GRANT executes, DECLINE preserves pre-op state -----

const RECOVERABLE_OPS = [
  { label: 'force-push', command: 'git push --force origin main', category: 'force-push' },
  { label: 'remote-delete', command: 'git push --delete origin release-1', category: 'remote-delete' },
  { label: 'credential-rotation', command: 'aws iam create-access-key --user-name deployer', category: 'credential-rotation' },
  { label: 'db-migration', command: 'alembic upgrade head', category: 'db-migration' },
  { label: 'dns-change', command: 'aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch file://c.json', category: 'dns-change' },
];

for (const { label, command, category } of RECOVERABLE_OPS) {
  test(`recoverable "${label}" requires confirmation: GRANT executes (Req 12.12)`, async () => {
    const state = { applied: false };
    const { manager, hooks } = build(state, (s) => { s.applied = true; });
    const res = await hooks.routeDestructiveOperation('proj-1', command, {
      onConfirmRequest: () => true,
    });
    assert.equal(res.outcome, 'confirm');
    assert.equal(res.category, category);
    assert.equal(res.executed, true, 'a granted confirm reaches exec');
    assert.equal(manager.calls.length, 1);
    assert.equal(state.applied, true, 'the operation was applied on grant');
  });

  test(`recoverable "${label}" requires confirmation: DECLINE does NOT execute and preserves pre-operation state (Req 12.12)`, async () => {
    const state = { applied: false };
    const { manager, hooks } = build(state, (s) => { s.applied = true; });
    const res = await hooks.routeDestructiveOperation('proj-1', command, {
      onConfirmRequest: () => false,
    });
    assert.equal(res.outcome, 'confirm');
    assert.equal(res.category, category);
    assert.equal(res.executed, false, 'a declined confirm must not execute');
    assert.equal(res.denied, true);
    assert.equal(manager.calls.length, 0, 'a declined confirm never reaches exec');
    assert.equal(state.applied, false, 'the pre-operation state is preserved on decline');
  });
}

// --- (c) skill selectors ------------------------------------------------------

test('skillForRequest maps de-couple / escape / remove-lock-in intents to the Devendor_Skill (Req 12.5)', () => {
  const { hooks } = build({});
  for (const intent of [
    'please remove lock-in from this project',
    'I want to escape this platform',
    'help me de-couple our code from the vendor',
    'we should own the code again',
    'the app keeps phoning home, make it stop',
    'I feel completely trapped by this service',
  ]) {
    assert.equal(hooks.skillForRequest(intent), DEVENDOR_SKILL_NAME, `intent: ${intent}`);
  }
  // A plain feature request selects no lock-in skill.
  assert.equal(hooks.skillForRequest('add a settings page'), null);
  assert.equal(hooks.skillForRequest(''), null);
});

test('skillForEvaluation maps dependency / sdk / template / connector to the Guard_Skill (Req 12.6)', () => {
  const { hooks } = build({});
  for (const kind of ['dependency', 'sdk', 'SDK', 'template', 'Template', 'connector', 'Connector']) {
    assert.equal(hooks.skillForEvaluation(kind), GUARD_SKILL_NAME, `kind: ${kind}`);
  }
  // An unrelated evaluation kind selects no skill.
  assert.equal(hooks.skillForEvaluation('feature'), null);
  assert.equal(hooks.skillForEvaluation('bugfix'), null);
});
