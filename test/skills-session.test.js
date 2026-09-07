/**
 * Smoke coverage for the Builder_Agent skill-session wiring and the lock-in
 * behavioral hooks (spec Task 22.2 / FEAT-003). The exhaustive edge-case suite
 * lands in FEAT-006; these tests prove the wiring is real:
 *
 *   - the vendored Guard + Devendor skills are discoverable through plumby's
 *     loadSkills at session start (no runtime fetch), exposing only name +
 *     description via buildSkillsBlock, and load_skill returns a body by exact
 *     name — all through the plumby boundary (Req 12.3, 12.4, 12.10);
 *   - the pure hook selectors name the right skill (Req 12.5, 12.6);
 *   - routeDestructiveOperation delegates to the REAL CommandGuard: filter-branch
 *     is refused even with a granting seam (Req 12.11), a confirm-class op only
 *     runs on grant, and a declined confirmation leaves state unchanged with
 *     executed:false (Req 12.12).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSkillSession,
  buildBuilderAgentSkillArgs,
} from '../src/skills/session.js';
import {
  createLockinHooks,
  DEVENDOR_SKILL_NAME,
  GUARD_SKILL_NAME,
} from '../src/skills/lockin-hooks.js';
import { createCommandGuard } from '../src/sandbox/command-guard.js';
import { loadSkillTool } from '../src/engine/plumby.js';

/** The checked-in vendored tree owned by ai-app-builder (FEAT-002 output). */
const VENDORED_CWD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'vendored-skills',
);

/** A stub SandboxManager exec that records calls and returns a benign result. */
function stubManager() {
  const calls = [];
  return {
    calls,
    exec: async (projectId, command, opts) => {
      calls.push({ projectId, command, opts });
      return Object.freeze({
        stdout: 'ok',
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

test('session: vendored Guard + Devendor skills discoverable at session start with no runtime fetch', () => {
  const session = createSkillSession({ cwd: VENDORED_CWD });
  const records = session.discover();
  const names = records.map((r) => r.name).sort();
  assert.deepEqual(names, [DEVENDOR_SKILL_NAME, GUARD_SKILL_NAME].sort());

  const block = session.listingBlock(records);
  assert.match(block, /## Available skills/);
  assert.match(block, new RegExp(GUARD_SKILL_NAME));
  assert.match(block, new RegExp(DEVENDOR_SKILL_NAME));
});

test('session: buildBuilderAgentSkillArgs yields skills + a single systemExtra block', () => {
  const { skills, systemExtra } = buildBuilderAgentSkillArgs(VENDORED_CWD);
  assert.equal(skills.length, 2);
  assert.equal(systemExtra.length, 1);
  assert.match(systemExtra[0], /## Available skills/);
});

test('session: load_skill returns a body by exact name via the real plumby tool', async () => {
  const session = createSkillSession({ cwd: VENDORED_CWD });
  const skills = session.indexed();
  const body = await loadSkillTool.handler(
    { name: GUARD_SKILL_NAME },
    { skills, cwd: VENDORED_CWD },
  );
  assert.match(body, new RegExp(`# Skill: ${GUARD_SKILL_NAME}`));
  assert.ok(body.length > 0);
});

test('session: load_skill rejects an unknown name listing the available names', async () => {
  const session = createSkillSession({ cwd: VENDORED_CWD });
  const skills = session.indexed();
  await assert.rejects(
    () => loadSkillTool.handler({ name: 'nope' }, { skills, cwd: VENDORED_CWD }),
    (err) => {
      assert.match(err.message, new RegExp(GUARD_SKILL_NAME));
      assert.match(err.message, new RegExp(DEVENDOR_SKILL_NAME));
      return true;
    },
  );
});

test('hooks: skillForRequest maps de-couple/escape intents to the Devendor_Skill', () => {
  const guard = createCommandGuard({ manager: stubManager() });
  const hooks = createLockinHooks({ commandGuard: guard });
  assert.equal(hooks.skillForRequest('help me de-couple from this vendor'), DEVENDOR_SKILL_NAME);
  assert.equal(hooks.skillForRequest('I want to escape this platform'), DEVENDOR_SKILL_NAME);
  assert.equal(hooks.skillForRequest('I feel trapped and want to own my code'), DEVENDOR_SKILL_NAME);
  assert.equal(hooks.skillForRequest('just add a login page'), null);
});

test('hooks: skillForEvaluation maps dependency/sdk/template/connector to the Guard_Skill', () => {
  const guard = createCommandGuard({ manager: stubManager() });
  const hooks = createLockinHooks({ commandGuard: guard });
  for (const kind of ['dependency', 'SDK', 'Template', 'connector']) {
    assert.equal(hooks.skillForEvaluation(kind), GUARD_SKILL_NAME);
  }
  assert.equal(hooks.skillForEvaluation('feature'), null);
});

test('hooks: filter-branch is REFUSED even with a granting confirm seam (state unchanged)', async () => {
  const manager = stubManager();
  const guard = createCommandGuard({ manager });
  const hooks = createLockinHooks({ commandGuard: guard });
  const res = await hooks.routeDestructiveOperation('proj-1', 'git filter-branch --tree-filter x HEAD', {
    onConfirmRequest: () => true, // grant — must be irrelevant for a refuse
  });
  assert.equal(res.outcome, 'refuse');
  assert.equal(res.executed, false);
  assert.equal(manager.calls.length, 0, 'refuse must never reach exec');
});

test('hooks: a confirm-class op runs only on grant; a decline leaves pre-operation state', async () => {
  // Declined confirmation: executed:false, exec never reached.
  const declinedManager = stubManager();
  const declinedGuard = createCommandGuard({ manager: declinedManager });
  const declinedHooks = createLockinHooks({ commandGuard: declinedGuard });
  const declined = await declinedHooks.routeDestructiveOperation(
    'proj-1',
    'git push --force origin main',
    { onConfirmRequest: () => false },
  );
  assert.equal(declined.outcome, 'confirm');
  assert.equal(declined.executed, false);
  assert.equal(declined.denied, true);
  assert.equal(declinedManager.calls.length, 0, 'a declined confirm must not reach exec');

  // Granted confirmation: the same op executes.
  const grantedManager = stubManager();
  const grantedGuard = createCommandGuard({ manager: grantedManager });
  const grantedHooks = createLockinHooks({ commandGuard: grantedGuard });
  const granted = await grantedHooks.routeDestructiveOperation(
    'proj-1',
    'git push --force origin main',
    { onConfirmRequest: () => true },
  );
  assert.equal(granted.outcome, 'confirm');
  assert.equal(granted.executed, true);
  assert.equal(grantedManager.calls.length, 1, 'a granted confirm reaches exec once');
});

test('hooks: a DNS-change op is confirm-class via the existing plumby classifier (no new rule)', async () => {
  const manager = stubManager();
  const guard = createCommandGuard({ manager });
  const hooks = createLockinHooks({ commandGuard: guard });
  const declined = await hooks.routeDestructiveOperation(
    'proj-1',
    'aws route53 change-resource-record-sets --hosted-zone-id Z1 --change-batch file://c.json',
    { onConfirmRequest: () => false },
  );
  assert.equal(declined.outcome, 'confirm');
  assert.equal(declined.category, 'dns-change');
  assert.equal(declined.executed, false);
  assert.equal(manager.calls.length, 0);
});
