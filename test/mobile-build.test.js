/**
 * Mobile scaffold + build UNIT tests (node --test) — spec Task 26.2, Req 15.1,
 * 15.4, 15.5, 15.6, 15.7, 18.2, 18.3.
 *
 * Exercises the REAL createMobileBuildService with a REAL StorageLayout on an
 * fs.mkdtempSync temp dir and REAL createDeploymentArtifact records + REAL
 * on-disk artifact files. ONLY the external Expo-scaffold / shared-mobile-build
 * boundary is faked, and the fake produces a REAL contract + a REAL side effect
 * (the service writes the real artifact file), so assertions land on real state.
 *
 * A SINGLE manually-advanced injected `now` ms counter is the only "time" that
 * passes. CRUCIALLY, the mobile-build boundary reports its QUEUE time and its
 * EXECUTION time as SEPARATE deltas: the 1800s execution timeout is measured
 * from execution start and EXCLUDES queue time — so a long queue + a short
 * execution SUCCEEDS, proving queue time is not counted (Req 15.5).
 *
 * MUTATION SENSITIVITY (noted inline): scaffold exit0-<=30s success; scaffold
 * over-budget/non-zero fails; missing toolchain -> MISSING_TOOLCHAIN naming the
 * component, prior state unchanged; long-queue + short-execution SUCCEEDS
 * (queue excluded); execution past the timeout -> BUILD_TIMEOUT no artifact;
 * non-zero execution exit -> BUILD_FAILED no artifact; a configured non-default
 * executionTimeoutMs is honored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createMobileBuildService,
  SCAFFOLD_SLO_MS,
  DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS,
} from '../src/project/mobile-build-service.js';
import { createStorageLayout } from '../src/storage/layout.js';

const PROJECT_ID = 'proj-mobile';

function manualClock({ start = 0 } = {}) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  return now;
}

function tempLayout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-build-'));
  return createStorageLayout(dir);
}

/** A scaffold boundary that advances the clock and returns a scripted contract. */
function scriptedScaffold(clock, plan = {}) {
  const calls = [];
  const boundary = async ({ projectId, timeoutMs }) => {
    calls.push({ projectId, timeoutMs });
    const durationMs = typeof plan.durationMs === 'number' ? plan.durationMs : 0;
    if (durationMs > 0) clock.advance(durationMs);
    return {
      exitStatus: typeof plan.exitStatus === 'number' ? plan.exitStatus : 0,
      files: plan.files ?? [`mobile/${projectId}/App.js`],
      stderr: plan.stderr ?? '',
    };
  };
  boundary.calls = calls;
  return boundary;
}

/**
 * A mobile-build boundary that models a QUEUE phase then an EXECUTION phase as
 * two SEPARATE injected-clock deltas. Both advance the clock; only executionMs
 * is what the service compares to the timeout.
 */
function scriptedMobileBuild(clock, plan = {}) {
  const calls = [];
  const boundary = async ({ projectId, executionTimeoutMs }) => {
    calls.push({ projectId, executionTimeoutMs });
    if (plan.missingToolchain) {
      // A missing toolchain surfaces immediately; nothing runs.
      return { missingToolchain: plan.missingToolchain };
    }
    const queuedMs = typeof plan.queuedMs === 'number' ? plan.queuedMs : 0;
    const executionMs = typeof plan.executionMs === 'number' ? plan.executionMs : 0;
    // Queue time passes on the clock but is reported separately.
    if (queuedMs > 0) clock.advance(queuedMs);
    // Execution time passes on the clock too.
    if (executionMs > 0) clock.advance(executionMs);
    return {
      queuedMs,
      executionMs,
      exitStatus: typeof plan.exitStatus === 'number' ? plan.exitStatus : 0,
      bytes: plan.bytes ?? `mobile-artifact:${projectId}`,
      stderr: plan.stderr ?? '',
    };
  };
  boundary.calls = calls;
  return boundary;
}

// ------------------------------------------------------------ scaffold (Req 15.1)

test('scaffoldMobile: exit 0 within 30s succeeds and threads the 30s SLO', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const scaffold = scriptedScaffold(clock, { durationMs: 20_000, exitStatus: 0 });
  const svc = createMobileBuildService({ layout, scaffoldBoundary: scaffold, now: clock });

  const res = await svc.scaffoldMobile({ projectId: PROJECT_ID });
  assert.equal(res.ok, true);
  assert.equal(res.scaffoldMs, 20_000);
  assert.ok(res.scaffoldMs <= SCAFFOLD_SLO_MS);
  assert.equal(scaffold.calls[0].timeoutMs, SCAFFOLD_SLO_MS);
});

test('scaffoldMobile: over-budget (>30s) fails with SCAFFOLD_TIMEOUT and no success claim', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const scaffold = scriptedScaffold(clock, { durationMs: SCAFFOLD_SLO_MS + 1, exitStatus: 0 });
  const svc = createMobileBuildService({ layout, scaffoldBoundary: scaffold, now: clock });

  const res = await svc.scaffoldMobile({ projectId: PROJECT_ID });
  // MUTATION SENSITIVITY: dropping the >30s check flips this to ok:true.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SCAFFOLD_TIMEOUT');
  assert.ok(res.scaffoldMs > SCAFFOLD_SLO_MS);
});

test('scaffoldMobile: non-zero exit fails with SCAFFOLD_FAILED and no success claim', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const scaffold = scriptedScaffold(clock, { durationMs: 5000, exitStatus: 3, stderr: 'expo init failed' });
  const svc = createMobileBuildService({ layout, scaffoldBoundary: scaffold, now: clock });

  const res = await svc.scaffoldMobile({ projectId: PROJECT_ID });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SCAFFOLD_FAILED');
  assert.match(res.message, /expo init failed/);
});

// ------------------------------------------------------------ toolchain (Req 15.6)

test('buildMobile: a missing toolchain component is NAMED, no success, prior artifact unchanged (Req 15.6)', async () => {
  const clock = manualClock();
  const layout = tempLayout();

  // First produce a good prior artifact.
  const goodBuild = scriptedMobileBuild(clock, { queuedMs: 1000, executionMs: 60_000, exitStatus: 0 });
  const svc = createMobileBuildService({ layout, mobileBuildBoundary: goodBuild, now: clock });
  const first = await svc.buildMobile({ projectId: PROJECT_ID });
  assert.equal(first.ok, true);
  const priorArtifact = svc.artifactFor(PROJECT_ID);
  assert.equal(priorArtifact.targetKind, 'mobile');
  const priorBytes = fs.readFileSync(priorArtifact.path, 'utf8');

  // Now a build whose boundary reports a missing toolchain component.
  const missingBuild = scriptedMobileBuild(clock, { missingToolchain: 'Android SDK Platform 34' });
  const svc2 = createMobileBuildService({ layout, mobileBuildBoundary: missingBuild, now: clock });
  // Seed svc2 with a prior artifact so we can assert it is unchanged.
  const seed = scriptedMobileBuild(clock, { queuedMs: 0, executionMs: 1000, exitStatus: 0 });
  const svcSeed = createMobileBuildService({ layout, mobileBuildBoundary: seed, now: clock });
  await svcSeed.buildMobile({ projectId: PROJECT_ID });
  const seededArtifact = svcSeed.artifactFor(PROJECT_ID);
  const seededBytes = fs.readFileSync(seededArtifact.path, 'utf8');

  const res = await svc2.buildMobile({ projectId: PROJECT_ID });
  // MUTATION SENSITIVITY: the specific missing component must be named, and no
  // artifact produced. Dropping the toolchain check flips ok / component.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'MISSING_TOOLCHAIN');
  assert.equal(res.component, 'Android SDK Platform 34');
  assert.equal(svc2.artifactFor(PROJECT_ID), null);
  // Prior artifacts on disk are untouched.
  assert.equal(fs.readFileSync(priorArtifact.path, 'utf8'), priorBytes);
  assert.equal(fs.readFileSync(seededArtifact.path, 'utf8'), seededBytes);
});

// ------------------------------------------------------------ queue-aware build (Req 15.4/15.5/18.2)

test('buildMobile: a LONG queue + a SHORT execution SUCCEEDS (queue time is NOT counted) (Req 15.5)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  // Queue for 2x the execution timeout, but execute in well under it.
  const queuedMs = DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS * 2;
  const executionMs = 60_000;
  const build = scriptedMobileBuild(clock, { queuedMs, executionMs, exitStatus: 0 });
  const svc = createMobileBuildService({ layout, mobileBuildBoundary: build, now: clock });

  const statuses = [];
  const res = await svc.buildMobile({ projectId: PROJECT_ID, onStatus: (s) => statuses.push(s) });

  // MUTATION SENSITIVITY: if queue time were counted against the execution
  // timeout, total elapsed (2x timeout + 60s) would blow the budget and this
  // would be BUILD_TIMEOUT. It SUCCEEDS because only executionMs is measured.
  assert.equal(res.ok, true);
  assert.equal(res.executionMs, executionMs);
  assert.equal(res.queuedMs, queuedMs);
  assert.ok(res.executionMs <= DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS);
  // The queued status was reported separately.
  assert.deepEqual(statuses, [{ status: 'queued', queuedMs }]);
  // A REAL mobile artifact was produced on disk.
  assert.equal(res.artifact.targetKind, 'mobile');
  assert.equal(fs.readFileSync(res.artifactPath, 'utf8'), `mobile-artifact:${PROJECT_ID}`);
});

test('buildMobile: executionMs is MEASURED against the injected clock (not the boundary self-report) (Req 15.4)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const queuedMs = 300_000;
  const executionMs = 120_000;
  // A boundary that advances the clock for BOTH phases but UNDER-REPORTS its own
  // executionMs. Because the service measures execution as (clock delta - queue),
  // it must report the REAL clock-measured execution, not the boundary's number.
  const underReporting = async ({ projectId }) => {
    clock.advance(queuedMs);
    clock.advance(executionMs);
    return {
      queuedMs,
      executionMs: 1, // deliberately wrong / under-reported
      exitStatus: 0,
      bytes: `mobile-artifact:${projectId}`,
      stderr: '',
    };
  };
  const svc = createMobileBuildService({ layout, mobileBuildBoundary: underReporting, now: clock });

  const res = await svc.buildMobile({ projectId: PROJECT_ID });
  // MUTATION SENSITIVITY: if the service trusted result.executionMs instead of
  // measuring the clock, res.executionMs would be 1. It measures the clock delta
  // minus the queued portion, so a dropped/wrong execution advance is detectable.
  assert.equal(res.ok, true);
  assert.equal(res.queuedMs, queuedMs);
  assert.equal(res.executionMs, executionMs);
  assert.notEqual(res.executionMs, 1);
});

test('buildMobile: a dropped execution clock advance is DETECTED (execution measured on the clock) (Req 15.4)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const queuedMs = 1000;
  // A buggy boundary that CLAIMS a huge execution but never advances the clock
  // for it. A clock-measured service sees ~0 execution; a self-reporting one
  // would (wrongly) time out. This pins that execution is a real clock delta.
  const droppedAdvance = async ({ projectId }) => {
    clock.advance(queuedMs); // queue advances...
    // ...but NO execution advance, despite claiming one past the timeout.
    return {
      queuedMs,
      executionMs: DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS + 1,
      exitStatus: 0,
      bytes: `mobile-artifact:${projectId}`,
      stderr: '',
    };
  };
  const svc = createMobileBuildService({ layout, mobileBuildBoundary: droppedAdvance, now: clock });

  const res = await svc.buildMobile({ projectId: PROJECT_ID });
  // MUTATION SENSITIVITY: trusting the boundary's executionMs would flip this to
  // BUILD_TIMEOUT. Measuring on the clock, the execution delta is 0 -> success.
  assert.equal(res.ok, true);
  assert.equal(res.executionMs, 0);
  assert.equal(res.queuedMs, queuedMs);
});

test('buildMobile: execution past the timeout -> BUILD_TIMEOUT, no artifact (Req 15.7)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedMobileBuild(clock, {
    queuedMs: 5000,
    executionMs: DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS + 1,
    exitStatus: 0,
  });
  const svc = createMobileBuildService({ layout, mobileBuildBoundary: build, now: clock });

  const res = await svc.buildMobile({ projectId: PROJECT_ID });
  // MUTATION SENSITIVITY: dropping the execution-timeout check flips this to ok.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BUILD_TIMEOUT');
  assert.ok(res.executionMs > DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS);
  assert.equal(svc.artifactFor(PROJECT_ID), null);
});

test('buildMobile: non-zero execution exit -> BUILD_FAILED, no artifact (Req 15.7)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedMobileBuild(clock, { queuedMs: 1000, executionMs: 30_000, exitStatus: 7, stderr: 'gradle failed' });
  const svc = createMobileBuildService({ layout, mobileBuildBoundary: build, now: clock });

  const res = await svc.buildMobile({ projectId: PROJECT_ID });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BUILD_FAILED');
  assert.match(res.message, /gradle failed/);
  assert.equal(svc.artifactFor(PROJECT_ID), null);
});

test('buildMobile: a configured non-default executionTimeoutMs is honored (Req 15.4)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const customTimeout = 600_000; // 10 minutes
  // Execution just over the CUSTOM timeout but well under the 1800s default.
  const build = scriptedMobileBuild(clock, { queuedMs: 0, executionMs: customTimeout + 1, exitStatus: 0 });
  const svc = createMobileBuildService({
    layout,
    mobileBuildBoundary: build,
    now: clock,
    executionTimeoutMs: customTimeout,
  });

  const res = await svc.buildMobile({ projectId: PROJECT_ID });
  // MUTATION SENSITIVITY: if the factory ignored executionTimeoutMs and used the
  // 1800s default, this execution (600s+1) would SUCCEED. It must TIMEOUT.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BUILD_TIMEOUT');
  assert.equal(svc.executionTimeoutMs, customTimeout);
  assert.equal(svc.artifactFor(PROJECT_ID), null);
});
