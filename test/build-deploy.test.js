/**
 * Build + Deploy UNIT tests (node --test) — spec Task 26.1, Req 18.1, 18.3,
 * 18.4, 18.5, 18.6, 18.7, 18.8.
 *
 * These exercise the REAL createBuildService with REAL collaborators — a REAL
 * StorageLayout on an fs.mkdtempSync temp dir, REAL createDeploymentArtifact
 * records + REAL on-disk artifact files, and a REAL CommandGuard driven by the
 * REAL plumby classifier (classifyCommand via THE plumby boundary at
 * src/engine/plumby.js). ONLY the external build/deploy boundary is faked, and
 * the fakes produce REAL contracts + REAL side effects (a written artifact file,
 * a recorded deployed URL) so assertions land on real state, never on a mock.
 *
 * A SINGLE manually-advanced injected `now` ms counter is the only "time" that
 * passes — every SLO (300s build, 120s deploy, 60s consent) is measured against
 * it, never a real wall-clock wait (per context.json).
 *
 * MUTATION SENSITIVITY (each key assertion flips if the guarantee is reverted —
 * noted inline): build-exit0-within-300s-produces-one-artifact; non-zero-exit ->
 * BUILD_FAILED no artifact; >300s -> BUILD_TIMEOUT no artifact; deploy URL <=120s
 * recorded; deploy failure/timeout leaves prior deployed state unchanged;
 * confirm-gated deploy needs consent (granted deploys, declined does not, prior
 * unchanged); nonexistent artifact -> NO_ARTIFACT before any guard/deploy call;
 * a `mobile` target is rejected by build().
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBuildService, BUILD_SLO_MS, DEPLOY_SLO_MS } from '../src/project/build-service.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createCommandGuard } from '../src/sandbox/command-guard.js';
import { classifyCommand } from '../src/engine/plumby.js';

const PROJECT_ID = 'proj-build-deploy';

// A concrete deploy command the REAL classifier gates as `confirm` (dns-change:
// a DNS record change points a domain at a new deployment). Asserted below,
// never stubbed.
const CONFIRM_DEPLOY_COMMAND =
  'aws route53 change-resource-record-sets --hosted-zone-id Z123 --change-batch file://dns.json';
// A plain deploy command the REAL classifier tags `allow`.
const ALLOW_DEPLOY_COMMAND = 'netlify deploy --prod --dir ./dist';

/** A manually-advanced ms clock — the single seam every SLO is measured against. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-deploy-'));
  return createStorageLayout(dir);
}

/**
 * A build boundary that advances the injected clock by a scripted duration and
 * returns a REAL exec-shaped contract. It writes nothing itself — the service
 * writes the real artifact file — but it CAN carry `bytes`.
 */
function scriptedBuildBoundary(clock, plan = {}) {
  const calls = [];
  const boundary = async ({ projectId, target, timeoutMs, signal }) => {
    calls.push({ projectId, target, timeoutMs, signal });
    const durationMs = typeof plan.durationMs === 'number' ? plan.durationMs : 0;
    if (durationMs > 0) clock.advance(durationMs);
    return {
      exitStatus: typeof plan.exitStatus === 'number' ? plan.exitStatus : 0,
      artifactPath: plan.artifactPath ?? `${target}/${projectId}.artifact`,
      bytes: plan.bytes ?? `bytes:${projectId}:${target}`,
      stderr: plan.stderr ?? '',
    };
  };
  boundary.calls = calls;
  return boundary;
}

/** A deploy boundary that advances the clock and returns a scripted contract. */
function scriptedDeployBoundary(clock, plan = {}) {
  const calls = [];
  const boundary = async ({ projectId, artifact, destination, timeoutMs, signal }) => {
    calls.push({ projectId, artifact, destination, timeoutMs, signal });
    const durationMs = typeof plan.durationMs === 'number' ? plan.durationMs : 0;
    if (durationMs > 0) clock.advance(durationMs);
    return {
      ok: plan.ok !== undefined ? plan.ok : true,
      exitStatus: typeof plan.exitStatus === 'number' ? plan.exitStatus : 0,
      url: plan.url !== undefined ? plan.url : `https://${projectId}.hosting.local`,
      stderr: plan.stderr ?? '',
    };
  };
  boundary.calls = calls;
  return boundary;
}

/**
 * A REAL CommandGuard over the REAL plumby classifier. The manager.exec seam is
 * a fake that reports a clean in-box success (exit 0) — it stands in for the
 * boundary the guard runs an allowed/consented command through. It records
 * calls so we can assert that a declined/refused deploy NEVER reaches exec.
 */
function realGuard() {
  const execCalls = [];
  const manager = {
    exec: async (projectId, command, opts) => {
      execCalls.push({ projectId, command, opts });
      return { stdout: 'ok', stderr: '', exitCode: 0, denied: false, deniedReason: null, timedOut: false };
    },
  };
  const guard = createCommandGuard({ manager, classify: classifyCommand });
  return { guard, execCalls };
}

// ------------------------------------------------------------ classifier facts

test('the chosen deploy commands classify as expected by the REAL plumby classifier', () => {
  // MUTATION SENSITIVITY: if the confirm command stopped classifying `confirm`,
  // the confirm-gate tests below would silently exercise the allow path. Pin it.
  assert.equal(classifyCommand(CONFIRM_DEPLOY_COMMAND).outcome, 'confirm');
  assert.equal(classifyCommand(ALLOW_DEPLOY_COMMAND).outcome, 'allow');
});

// ------------------------------------------------------------ build (Req 18.1/18.3/18.5)

for (const target of ['web', 'backend', 'shared']) {
  test(`build ${target}: exit 0 within 300s produces exactly one REAL artifact of the right targetKind`, async () => {
    const clock = manualClock();
    const layout = tempLayout();
    const build = scriptedBuildBoundary(clock, { durationMs: 250_000, exitStatus: 0 });
    const svc = createBuildService({ layout, buildBoundary: build, now: clock });

    const res = await svc.build({ projectId: PROJECT_ID, target });

    assert.equal(res.ok, true);
    // Real Deployment_Artifact of the requested target kind.
    assert.equal(res.artifact.targetKind, target);
    assert.equal(res.artifact.exitStatus, 0);
    // buildMs is the injected-clock delta and is within the 300s SLO.
    assert.equal(res.buildMs, 250_000);
    assert.ok(res.buildMs <= BUILD_SLO_MS);
    // MUTATION SENSITIVITY: the artifact bytes are a REAL on-disk file. If the
    // service stopped writing the artifact, this read throws.
    const onDisk = fs.readFileSync(res.artifactPath, 'utf8');
    assert.equal(onDisk, `bytes:${PROJECT_ID}:${target}`);
    // Exactly one artifact tracked for this project+target.
    assert.equal(svc.artifactFor(PROJECT_ID, target).targetKind, target);
    // The boundary was threaded the 300s timeout.
    assert.equal(build.calls[0].timeoutMs, BUILD_SLO_MS);
  });
}

test('build: non-zero exit -> BUILD_FAILED, NO artifact, error reported (Req 18.5)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedBuildBoundary(clock, { durationMs: 10_000, exitStatus: 2, stderr: 'compile error x' });
  const svc = createBuildService({ layout, buildBoundary: build, now: clock });

  const res = await svc.build({ projectId: PROJECT_ID, target: 'web' });

  // MUTATION SENSITIVITY: if a non-zero exit still produced an artifact, ok would
  // be true and artifactFor would be non-null.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BUILD_FAILED');
  assert.match(res.message, /compile error x/);
  assert.equal(svc.artifactFor(PROJECT_ID, 'web'), null);
});

test('build: >300s -> BUILD_TIMEOUT, NO artifact (Req 18.3)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  // Exit 0 but over the 300s budget on the injected clock.
  const build = scriptedBuildBoundary(clock, { durationMs: BUILD_SLO_MS + 1, exitStatus: 0 });
  const svc = createBuildService({ layout, buildBoundary: build, now: clock });

  const res = await svc.build({ projectId: PROJECT_ID, target: 'backend' });

  // MUTATION SENSITIVITY: dropping the >300s check flips this to ok:true with an
  // artifact even though the build blew the SLO.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BUILD_TIMEOUT');
  assert.ok(res.buildMs > BUILD_SLO_MS);
  assert.equal(svc.artifactFor(PROJECT_ID, 'backend'), null);
});

test('build: a `mobile` target is rejected (mobile goes through the mobile build service)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const svc = createBuildService({ layout, now: clock });

  const res = await svc.build({ projectId: PROJECT_ID, target: 'mobile' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'MOBILE_NOT_SUPPORTED_HERE');
  assert.equal(svc.artifactFor(PROJECT_ID, 'mobile'), null);
});

test('build: an invalid target is rejected as INVALID_TARGET naming the target', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const svc = createBuildService({ layout, now: clock });

  const res = await svc.build({ projectId: PROJECT_ID, target: 'nope' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_TARGET');
  assert.equal(res.target, 'nope');
});

// ------------------------------------------------------------ deploy (Req 18.4/18.6/18.8)

async function buildOne(svc, target = 'web') {
  const res = await svc.build({ projectId: PROJECT_ID, target });
  assert.equal(res.ok, true);
  return res.artifact;
}

test('deploy: returns a hosting URL within 120s and records it as the current deployed state (Req 18.4)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedBuildBoundary(clock, { durationMs: 1000, exitStatus: 0 });
  const deployB = scriptedDeployBoundary(clock, { durationMs: 90_000, url: 'https://live.example.app' });
  const svc = createBuildService({ layout, buildBoundary: build, deployBoundary: deployB, now: clock });

  const artifact = await buildOne(svc, 'web');
  const res = await svc.deploy({ projectId: PROJECT_ID, artifact, destination: 'prod' });

  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://live.example.app');
  // MUTATION SENSITIVITY: deployMs is the injected-clock delta; within 120s.
  assert.equal(res.deployMs, 90_000);
  assert.ok(res.deployMs <= DEPLOY_SLO_MS);
  // The deployed URL is recorded as current state.
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), 'https://live.example.app');
});

test('deploy: failure reports the cause and produces no deployed state (Req 18.6)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedBuildBoundary(clock, { durationMs: 1000, exitStatus: 0 });
  // A deploy boundary that fails by returning a non-zero exit and no url.
  const failing = scriptedDeployBoundary(clock, {
    durationMs: 1000,
    ok: false,
    exitStatus: 1,
    url: null,
    stderr: 'provider 500',
  });
  const svc = createBuildService({ layout, buildBoundary: build, deployBoundary: failing, now: clock });
  const artifact = await buildOne(svc, 'web');

  const res = await svc.deploy({ projectId: PROJECT_ID, artifact, destination: 'prod' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPLOY_FAILED');
  assert.match(res.message, /provider 500|no hosting URL/);
  // MUTATION SENSITIVITY: no prior state existed, and a failed deploy records
  // nothing — a partial deploy that recorded a URL would flip this.
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), null);
});

test('deploy: prior deployed state is unchanged after a subsequent failing deploy on the same service', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedBuildBoundary(clock, { durationMs: 1000, exitStatus: 0 });

  // A deploy boundary whose behavior we flip between calls.
  let failNext = false;
  const deployB = async ({ projectId }) => {
    clock.advance(1000);
    if (failNext) return { ok: false, exitStatus: 1, url: null, stderr: 'boom' };
    return { ok: true, exitStatus: 0, url: 'https://good.example.app' };
  };
  const svc = createBuildService({ layout, buildBoundary: build, deployBoundary: deployB, now: clock });
  const artifact = await buildOne(svc, 'web');

  const first = await svc.deploy({ projectId: PROJECT_ID, artifact, destination: 'prod' });
  assert.equal(first.ok, true);
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), 'https://good.example.app');

  failNext = true;
  const second = await svc.deploy({ projectId: PROJECT_ID, artifact, destination: 'prod' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'DEPLOY_FAILED');
  // The failing deploy echoes the prior URL and leaves the recorded state intact.
  assert.equal(second.priorUrl, 'https://good.example.app');
  // MUTATION SENSITIVITY: a partial deploy that overwrote state would flip this.
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), 'https://good.example.app');
});

test('deploy: >120s -> DEPLOY_TIMEOUT, prior state unchanged (Req 18.6)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedBuildBoundary(clock, { durationMs: 1000, exitStatus: 0 });
  const deployB = scriptedDeployBoundary(clock, { durationMs: DEPLOY_SLO_MS + 1, url: 'https://late.example.app' });
  const svc = createBuildService({ layout, buildBoundary: build, deployBoundary: deployB, now: clock });
  const artifact = await buildOne(svc, 'web');

  const res = await svc.deploy({ projectId: PROJECT_ID, artifact, destination: 'prod' });
  // MUTATION SENSITIVITY: dropping the >120s check flips this to ok:true.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPLOY_TIMEOUT');
  assert.ok(res.deployMs > DEPLOY_SLO_MS);
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), null);
});

test('deploy: a nonexistent artifact is rejected NO_ARTIFACT before any deploy work (Req 18.8)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const deployB = scriptedDeployBoundary(clock, { durationMs: 1000 });
  const svc = createBuildService({ layout, deployBoundary: deployB, now: clock });

  // No build happened, so no artifact record/file exists for this project+target.
  const res = await svc.deploy({
    projectId: PROJECT_ID,
    artifact: { targetKind: 'web', path: '/does/not/exist', exitStatus: 0 },
    destination: 'prod',
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_ARTIFACT');
  // MUTATION SENSITIVITY: the deploy boundary must NEVER have been called.
  assert.equal(deployB.calls.length, 0);
});

// ------------------------------------------------------------ confirm gate (Req 18.7)

test('deploy: confirm-classified command deploys ONLY when consent is granted; declined does not deploy (Req 18.7)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedBuildBoundary(clock, { durationMs: 1000, exitStatus: 0 });

  // --- consent GRANTED ---
  {
    const { guard, execCalls } = realGuard();
    const deployB = scriptedDeployBoundary(clock, { durationMs: 1000, url: 'https://confirmed.example.app' });
    const svc = createBuildService({ layout, buildBoundary: build, deployBoundary: deployB, commandGuard: guard, now: clock });
    const artifact = await buildOne(svc, 'web');

    const res = await svc.deploy({
      projectId: PROJECT_ID,
      artifact,
      destination: 'prod',
      command: CONFIRM_DEPLOY_COMMAND,
      onConfirmRequest: () => true,
    });
    // MUTATION SENSITIVITY: if the confirm gate were bypassed, a declined
    // consent (below) would still deploy. Here consent is granted -> deploys.
    assert.equal(res.ok, true);
    assert.equal(res.url, 'https://confirmed.example.app');
    // The REAL guard ran the consented command through exec (the boundary).
    assert.equal(execCalls.length, 1);
    assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), 'https://confirmed.example.app');
  }

  // --- consent DECLINED ---
  {
    const { guard, execCalls } = realGuard();
    const deployB = scriptedDeployBoundary(clock, { durationMs: 1000, url: 'https://should-not.example.app' });
    const svc = createBuildService({ layout, buildBoundary: build, deployBoundary: deployB, commandGuard: guard, now: clock });
    const artifact = await buildOne(svc, 'web');

    const res = await svc.deploy({
      projectId: PROJECT_ID,
      artifact,
      destination: 'prod',
      command: CONFIRM_DEPLOY_COMMAND,
      onConfirmRequest: () => false,
    });
    // MUTATION SENSITIVITY: a declined confirm must NOT deploy.
    assert.equal(res.ok, false);
    assert.equal(res.code, 'DEPLOY_CONFIRM_DENIED');
    // The declined command NEVER reached exec, and the deploy boundary NEVER ran.
    assert.equal(execCalls.length, 0);
    assert.equal(deployB.calls.length, 0);
    // Prior state unchanged (nothing recorded).
    assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), null);
  }
});

test('deploy: an allow-class command DENIED at the boundary does NOT proceed to deploy (Req 18.7)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedBuildBoundary(clock, { durationMs: 1000, exitStatus: 0 });

  // A REAL guard whose manager.exec reports a BOUNDARY DENIAL (launch-failure)
  // for the allow-class command: executed reached exec, but the boundary refused
  // it (denied:true) — DISTINCT from a non-zero in-box exit.
  const execCalls = [];
  const manager = {
    exec: async (projectId, command, opts) => {
      execCalls.push({ projectId, command, opts });
      return { stdout: '', stderr: '', exitCode: null, denied: true, deniedReason: 'launch-failure', timedOut: false };
    },
  };
  const guard = createCommandGuard({ manager, classify: classifyCommand });

  const deployB = scriptedDeployBoundary(clock, { durationMs: 1000, url: 'https://should-not.example.app' });
  const svc = createBuildService({ layout, buildBoundary: build, deployBoundary: deployB, commandGuard: guard, now: clock });
  const artifact = await buildOne(svc, 'web');

  const res = await svc.deploy({
    projectId: PROJECT_ID,
    artifact,
    destination: 'prod',
    command: ALLOW_DEPLOY_COMMAND,
  });

  // MUTATION SENSITIVITY: without the `denied !== true` guard, an allow-class
  // command that the boundary DENIED would still be treated as permitted and the
  // deploy boundary would run. The gate command reached exec, but its boundary
  // denial must block the deploy.
  assert.equal(execCalls.length, 1);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPLOY_DENIED');
  // The deploy boundary NEVER ran and nothing was recorded.
  assert.equal(deployB.calls.length, 0);
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), null);
});

test('deploy: an allow-classified deploy command proceeds through the guard (Req 18.7)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const build = scriptedBuildBoundary(clock, { durationMs: 1000, exitStatus: 0 });
  const { guard } = realGuard();
  const deployB = scriptedDeployBoundary(clock, { durationMs: 1000, url: 'https://allowed.example.app' });
  const svc = createBuildService({ layout, buildBoundary: build, deployBoundary: deployB, commandGuard: guard, now: clock });
  const artifact = await buildOne(svc, 'web');

  const res = await svc.deploy({
    projectId: PROJECT_ID,
    artifact,
    destination: 'prod',
    command: ALLOW_DEPLOY_COMMAND,
    // No onConfirmRequest needed — allow-class needs no consent.
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://allowed.example.app');
});
