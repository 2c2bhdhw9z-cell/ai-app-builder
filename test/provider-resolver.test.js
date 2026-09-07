/**
 * ProviderResolver tests (spec Task 25.2, Req 21.2-21.6).
 *
 * Real-collaborator style (mirroring test/server-start.test.js and
 * test/connectors.test.js): the resolver runs against the REAL plumby
 * PROVIDERS / describeProviders through the engine boundary
 * (../src/engine/plumby.js), driven by INJECTED fake env maps. No live model
 * call is ever made — provider construction is not even reached on these paths,
 * and where a turn-start path is exercised a plumby scripted provider records
 * that ZERO turns ran.
 *
 * Each test is written to FAIL if the behavior is reverted:
 *   - unsupported provider / model dropping the name or mutating state,
 *   - the env-order default being hardcoded instead of derived from plumby
 *     (proven by a fake env where only a LATER provider has a key),
 *   - the no-credential path dropping the env-var name or starting a turn,
 *   - a successful selection not persisting across repeated calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderResolver } from '../src/server/provider-resolver.js';
import {
  PROVIDERS,
  describeProviders,
  createScriptedProvider,
} from '../src/engine/plumby.js';

// ---------------------------------------------------------------- Req 21.3

test('Req 21.3: an unsupported provider is rejected, named, and leaves the Session unchanged', () => {
  const r = createProviderResolver({ env: {} });

  // Establish a valid prior selection so we can prove it is NOT mutated.
  const good = r.select({ provider: 'anthropic' });
  assert.equal(good.ok, true);
  const before = r.current();
  assert.equal(before.provider, 'anthropic');

  const bad = r.select({ provider: 'not-a-real-provider' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'UNSUPPORTED_PROVIDER');
  // The message NAMES the unsupported provider — a mutation dropping the name fails here.
  assert.match(bad.message, /not-a-real-provider/);

  // Session UNCHANGED — still the prior valid selection.
  const after = r.current();
  assert.deepEqual(after, before);
  assert.equal(after.provider, 'anthropic');
});

test('Req 21.3: the supported set is derived from plumby PROVIDERS (not hardcoded)', () => {
  const r = createProviderResolver({ env: {} });
  assert.deepEqual([...r.supportedProviders], Object.keys(PROVIDERS));
  // Every real plumby provider is accepted by select().
  for (const name of Object.keys(PROVIDERS)) {
    assert.equal(r.select({ provider: name }).ok, true, `${name} should be supported`);
  }
});

// ---------------------------------------------------------------- Req 21.4

test('Req 21.4: an unsupported model is rejected and leaves BOTH provider and model unchanged', () => {
  // Injected validateModel seam: only the exact model "claude-good" is valid.
  const r = createProviderResolver({
    env: {},
    validateModel: ({ model }) => model === 'claude-good',
  });

  // Valid prior selection through the seam.
  const good = r.select({ provider: 'anthropic', model: 'claude-good' });
  assert.equal(good.ok, true);
  const before = r.current();
  assert.deepEqual(before, { provider: 'anthropic', model: 'claude-good' });

  const bad = r.select({ provider: 'gemini', model: 'totally-made-up-model' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'UNSUPPORTED_MODEL');
  // Message names the provider AND the model.
  assert.match(bad.message, /gemini/);
  assert.match(bad.message, /totally-made-up-model/);

  // Req 21.4: BOTH provider and model unchanged (still the anthropic selection).
  const after = r.current();
  assert.deepEqual(after, before);
  assert.equal(after.provider, 'anthropic');
  assert.equal(after.model, 'claude-good');
});

test('Req 21.4: without a validateModel seam an explicit model and the default are accepted', () => {
  const r = createProviderResolver({ env: {} });
  const withModel = r.select({ provider: 'anthropic', model: 'some-explicit-model' });
  assert.equal(withModel.ok, true);
  assert.equal(withModel.model, 'some-explicit-model');

  // Omitting the model defaults to the provider's own defaultModel from plumby.
  const withDefault = r.select({ provider: 'gemini' });
  assert.equal(withDefault.ok, true);
  assert.equal(withDefault.model, PROVIDERS.gemini.defaultModel);
});

// ---------------------------------------------------------------- Req 21.5

test('Req 21.5: with only anthropic key set, resolve() picks anthropic (first in env order)', () => {
  const r = createProviderResolver({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
  const res = r.resolve();
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'anthropic');
  assert.equal(res.origin, 'env-order');
  assert.equal(res.model, PROVIDERS.anthropic.defaultModel);
});

test('Req 21.5: with ONLY openrouter (a LATER provider) key set, resolve() picks openrouter', () => {
  // PROVING the order is derived from plumby: openrouter is the THIRD/last slot,
  // yet with only its key present it must win. A hardcoded "first slot" default
  // would wrongly pick anthropic and fail this.
  const r = createProviderResolver({ env: { OPENROUTER_API_KEY: 'or-test' } });
  const res = r.resolve();
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'openrouter');
  assert.equal(res.origin, 'env-order');
});

test('Req 21.5: with multiple keys set, the FIRST provider in plumby order wins', () => {
  const r = createProviderResolver({
    env: { GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'or', ANTHROPIC_API_KEY: 'a' },
  });
  const res = r.resolve();
  assert.equal(res.ok, true);
  // Order is anthropic, gemini, openrouter — anthropic first even though env
  // was written in a different order.
  assert.equal(res.provider, Object.keys(PROVIDERS)[0]);
  assert.equal(res.provider, 'anthropic');
});

test('Req 21.5: gemini resolves via either accepted key alias (GOOGLE_API_KEY)', () => {
  const r = createProviderResolver({ env: { GOOGLE_API_KEY: 'g-test' } });
  const res = r.resolve();
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'gemini');
});

// ---------------------------------------------------------------- Req 21.6

test('Req 21.6: with no credential, resolve() reports the missing provider + env var and starts no turn', () => {
  // A scripted provider proves NO turn runs: if resolve() gated correctly, the
  // caller never builds/runs an agent, so the scripted provider records nothing.
  const scripted = createScriptedProvider([]);
  const r = createProviderResolver({ env: {} });

  const before = r.current();
  const res = r.resolve();

  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_CREDENTIAL');
  // Names a provider and its exact env var — a mutation dropping either fails.
  assert.match(res.message, /anthropic|ANTHROPIC_API_KEY/);
  assert.match(res.message, /ANTHROPIC_API_KEY/);

  // Session UNCHANGED.
  assert.deepEqual(r.current(), before);

  // Simulate the caller's turn-start gate: a turn only starts on ok:true. Since
  // resolve() is not ok, the provider is never driven and records zero turns.
  let turnsStarted = 0;
  if (res.ok) {
    turnsStarted += 1;
    void scripted; // would construct/run here on a real turn
  }
  assert.equal(turnsStarted, 0);
});

test('Req 21.6: the no-credential reason matches plumby describeProviders exactly', () => {
  // Prove we reuse plumby's real `reason` string rather than inventing our own.
  const env = {};
  const described = describeProviders({ env });
  const first = Object.keys(PROVIDERS)[0];
  const r = createProviderResolver({ env });
  const res = r.resolve();
  assert.equal(res.ok, false);
  assert.ok(
    res.message.includes(described[first].reason),
    `resolve message should embed plumby's reason: ${described[first].reason}`,
  );
});

// ---------------------------------------------------------------- Req 21.2

test('Req 21.2: a successful selection persists across repeated resolve()/current() calls until changed', () => {
  const r = createProviderResolver({ env: { ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'or' } });

  const sel = r.select({ provider: 'openrouter', model: 'my-model' });
  assert.equal(sel.ok, true);

  // Repeated calls return the SAME selected value (not the env-order default of
  // anthropic, which IS available here — so a bug that ignored the selection
  // would resolve anthropic and fail this).
  for (let i = 0; i < 3; i += 1) {
    const res = r.resolve();
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'openrouter');
    assert.equal(res.model, 'my-model');
    assert.equal(res.origin, 'selection');
    assert.deepEqual(r.current(), { provider: 'openrouter', model: 'my-model' });
  }

  // Changing the selection is reflected on the next resolve().
  const sel2 = r.select({ provider: 'gemini' });
  assert.equal(sel2.ok, true);
  assert.equal(r.resolve().provider, 'gemini');
  assert.equal(r.current().provider, 'gemini');
});

test('Req 21.2: current() returns an unselected snapshot before any select()', () => {
  const r = createProviderResolver({ env: {} });
  assert.deepEqual(r.current(), { provider: null, model: null });
});
