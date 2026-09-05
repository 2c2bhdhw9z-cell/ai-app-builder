/**
 * Proves the test harness itself works: the scripted-agent runs a real plumby
 * tool through the real loop with no network, the eval runner isolates and
 * cleans up its temp dir, the plumby boundary re-exports resolve, the enums are
 * frozen with working predicates, and the fast-check config is correct.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createScriptedAgent } from './support/scripted-agent.js';
import { fcConfig, propertyTag } from './support/fc.js';
import { runCase } from '../eval/runner.js';
import { createScriptedProvider, classifyCommand } from '../src/engine/plumby.js';
import {
  Target_Category,
  Target,
  Project_Origin,
  Connector_Category,
  Memory_Mode,
  Classifier_Outcome,
  isValidTargetCategory,
  isValidTarget,
  isValidProjectOrigin,
  isValidConnectorCategory,
  isValidMemoryMode,
  isValidClassifierOutcome,
} from '../src/model/enums.js';

test('(a) scripted-agent runs a real write_file tool call through the real loop with no network', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-harness-'));
  try {
    const { agent } = createScriptedAgent({
      cwd: dir,
      turns: [
        { toolCalls: [{ name: 'write_file', input: { path: 'hello.txt', content: 'hi from scripted' } }] },
        { text: 'Done.' },
      ],
    });

    const result = await agent.send('Write hello.txt');

    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.text, 'Done.');

    const written = await fs.readFile(path.join(dir, 'hello.txt'), 'utf8');
    assert.equal(written, 'hi from scripted');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(b) eval runner creates and then removes its temp dir', async () => {
  let capturedDir;

  const providerFor = () =>
    createScriptedProvider([
      { toolCalls: [{ name: 'write_file', input: { path: 'out.txt', content: 'ok' } }] },
      { text: 'Done.' },
    ]);

  const result = await runCase({
    case: {
      id: 'temp-dir-lifecycle',
      prompt: 'Write out.txt',
      check: async ({ dir, exec }) => {
        capturedDir = dir;
        // The dir must exist DURING the run.
        assert.ok(fsSync.existsSync(dir), 'temp dir should exist during the check');
        const { stdout } = await exec('cat out.txt');
        return { pass: stdout.trim() === 'ok', detail: stdout };
      },
    },
    providerFor,
  });

  assert.equal(result.pass, true, `case should pass, got: ${result.detail}`);
  assert.ok(capturedDir, 'check should have run and captured the dir');
  // And it must be gone AFTER the run (removed in the finally).
  assert.equal(fsSync.existsSync(capturedDir), false, 'temp dir should be removed after the run');
});

test('(c) plumby boundary re-exports resolve; classifyCommand refuses rm -rf /', () => {
  const outcome = classifyCommand('rm -rf /');
  assert.equal(outcome.outcome, 'refuse');
});

test('(d) enums are frozen and isValid predicates work', () => {
  for (const set of [Target_Category, Target, Project_Origin, Connector_Category, Memory_Mode, Classifier_Outcome]) {
    assert.ok(Object.isFrozen(set), 'enum set should be frozen');
  }

  assert.deepEqual(Target_Category, ['web', 'full-stack-web', 'mobile', 'multi-target']);
  assert.deepEqual(Target, ['web', 'backend', 'mobile', 'shared']);
  assert.deepEqual(Project_Origin, ['blank', 'template', 'github-import', 'fork']);
  assert.deepEqual(Connector_Category, ['database', 'auth', 'payments', 'hosting-deploy', 'storage', 'ai-model']);
  assert.deepEqual(Memory_Mode, ['auto', 'manual', 'off']);
  assert.deepEqual(Classifier_Outcome, ['allow', 'confirm', 'refuse']);

  assert.equal(isValidTargetCategory('multi-target'), true);
  assert.equal(isValidTargetCategory('nope'), false);
  assert.equal(isValidTarget('backend'), true);
  assert.equal(isValidTarget('nope'), false);
  assert.equal(isValidProjectOrigin('github-import'), true);
  assert.equal(isValidProjectOrigin('nope'), false);
  assert.equal(isValidConnectorCategory('payments'), true);
  assert.equal(isValidConnectorCategory('nope'), false);
  assert.equal(isValidMemoryMode('auto'), true);
  assert.equal(isValidMemoryMode('nope'), false);
  assert.equal(isValidClassifierOutcome('refuse'), true);
  assert.equal(isValidClassifierOutcome('nope'), false);

  // Mutation attempts must not change a frozen array.
  assert.throws(() => {
    'use strict';
    Target.push('x');
  });
});

test('(e) fc.js propertyTag produces the exact tag string and fcConfig.numRuns >= 100', () => {
  assert.equal(
    propertyTag(7, 'idempotent scaffold'),
    'Feature: ai-app-builder, Property 7: idempotent scaffold',
  );
  assert.ok(fcConfig.numRuns >= 100, 'fcConfig.numRuns should be >= 100');
});
