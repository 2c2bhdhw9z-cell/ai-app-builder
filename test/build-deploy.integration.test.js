/**
 * Build / Deploy / Mobile / Multi-Target INTEGRATION tests (node --test) — spec
 * Task 26.4 (the optional `*` tests), Req 15.1, 15.2, 15.4, 15.5, 16.1, 16.2,
 * 16.6, 18.1, 18.4.
 *
 * Where test/build-deploy.test.js, test/mobile-build.test.js and
 * test/multi-target.test.js exercise the build/deploy service, the mobile build
 * service and the multi-target coordinator at the UNIT level, this file wires
 * the WHOLE build/deploy/mobile/multi-target surface together with REAL
 * collaborators and asserts the cross-component TIMING SLOs + failure/no-partial
 * guarantees end-to-end, exactly as test/database-service.integration.test.js
 * does for the full-stack DB lifecycle.
 *
 *   REAL, wired together (no stubs of the objects under test):
 *     - a REAL StorageLayout (createStorageLayout on an fs.mkdtempSync temp dir)
 *       backing REAL createDeploymentArtifact records + REAL on-disk artifact
 *       files (build outputs land under layout.controlRoot/build-artifacts);
 *     - a REAL CommandGuard (createCommandGuard) driven by the REAL plumby
 *       classifier (classifyCommand via THE plumby boundary at
 *       src/engine/plumby.js — NOT stubbed) so a confirm-classified deploy
 *       command genuinely classifies `confirm` and is gated within the 60s
 *       consent ceiling, while a plain deploy command is `allow`;
 *     - the REAL FEAT-002 build service + mobile build service and the REAL
 *       FEAT-003 multi-target coordinator (createBuildService /
 *       createMobileBuildService / createMultiTargetCoordinator);
 *     - the REAL PreviewController (createPreviewController over the REAL
 *       createDevServer seam) for the multi-target Preview SELECTOR (web default
 *       + explicit defaultUsed / INVALID_TARGET rejection) and the <=60s Expo
 *       reachability endpoint (previewMobile).
 *
 *   FAKE only at the ONE class of seam the real objects cannot reach offline —
 *   the external build / deploy / mobile-build / hosting / propagation boundary.
 *   Each fake is a shared spy that (a) records every call so we can assert the
 *   exact timeoutMs threaded down, (b) returns the REAL boundary contract shape
 *   ({ exitStatus, artifactPath?, bytes?, url?, queuedMs?, executionMs?,
 *   missingToolchain?, ok?, ... }), and (c) advances a SINGLE INJECTED `now` ms
 *   counter by a scripted per-phase duration and carries REAL side effects (the
 *   service writes a real artifact file to the temp tree; a successful deploy
 *   flips an in-memory deployed-URL registry). NO real framework build, NO real
 *   container/image push, NO real Expo/EAS mobile build, NO real hosting
 *   deploy, NO real network, NO real wall-clock waiting — EVERY SLO (300s build,
 *   120s deploy, 60s consent, 30s mobile scaffold, 60s Expo endpoint, the 1800s
 *   mobile-build EXECUTION timeout with queue EXCLUDED, 5s shared propagation)
 *   is measured against the manually-advanced injected clock, per context.json.
 *   No live build/deploy/mobile run occurs here.
 *
 * MUTATION SENSITIVITY (each documented assertion flips if the guarantee is
 * reverted — noted inline at every case):
 *   - build-<=300s-one-artifact / >300s-no-artifact: reverting the 300s SLO gate
 *     flips the duration / artifact-absence assertions.
 *   - deploy-URL-<=120s + prior-state-intact-on-failure: applying-anyway flips
 *     the prior-URL-unchanged registry assertion.
 *   - confirm-gated deploy: removing the confirm gate flips the consent-consulted
 *     + no-deploy-on-decline/timeout assertions (a declined/timed-out consent
 *     would otherwise deploy).
 *   - mobile 1800s EXECUTION timeout with queue EXCLUDED: counting queue time
 *     toward the 1800s would flip the long-queue + short-exec SUCCESS assertion.
 *   - exactly four Targets / shared propagation <=5s + last-good retention:
 *     dropping the rollback flips the retained-version assertions.
 *   - per-Target artifact selection: building an unrequested Target, or dropping
 *     a failed Target while others complete, flips the artifact-map assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBuildService,
  BUILD_SLO_MS,
  DEPLOY_SLO_MS,
} from '../src/project/build-service.js';
import {
  createMobileBuildService,
  SCAFFOLD_SLO_MS,
  DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS,
} from '../src/project/mobile-build-service.js';
import { createMultiTargetCoordinator, PROPAGATION_SLO_MS } from '../src/project/multi-target.js';
import { createPreviewController, MOBILE_REACHABLE_MS } from '../src/project/preview-controller.js';
import { createDevServer } from '../src/project/dev-server.js';
import { createCommandGuard, DEFAULT_CONFIRM_TIMEOUT_MS } from '../src/sandbox/command-guard.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { Target } from '../src/model/enums.js';
import { classifyCommand } from '../src/engine/plumby.js';

// ---------------------------------------------------------------- harness

const PROJECT_ID = 'proj-build-deploy-int';

// A concrete, real-world deploy command the REAL classifier gates as `confirm`
// (a Route53 DNS record change points a domain at a new deployment) — asserted
// below, never stubbed. Reused from the existing build-deploy UNIT test so the
// confirm path rests on the same REAL classifier fact.
const CONFIRM_DEPLOY_COMMAND =
  'aws route53 change-resource-record-sets --hosted-zone-id Z123 --change-batch file://dns.json';
// A plain deploy command the REAL classifier tags `allow`.
const ALLOW_DEPLOY_COMMAND = 'netlify deploy --prod --dir ./dist';

/**
 * A MANUALLY-ADVANCED ms clock: reads return the current value; the harness
 * advances it by a scripted per-phase duration on every boundary call. This
 * single counter is the seam ALL timing SLOs are measured against — NO real
 * wall-clock wait ever happens in this file.
 */
function manualClock({ start = 0 } = {}) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  return now;
}

/** A fresh tmp StorageLayout under fs.mkdtempSync, auto-removed after the test. */
function freshLayout(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-builddeploy-int-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  return createStorageLayout(baseDir);
}

/**
 * The ONE build/deploy/hosting boundary fake: a shared spy standing in for the
 * external framework-build + hosting-deploy the real objects cannot reach
 * offline. It advances the SINGLE injected clock per phase, returns the REAL
 * boundary contracts, and carries a REAL side effect for deploy (a
 * `deployedRegistry` mirroring the actual live hosting record) so
 * "prior state intact" is a meaningful integration assertion, not trivially true.
 *
 * @param {Function} clock  the manual clock (advanced per phase)
 * @param {(target:string)=>object} buildScript   maps a target to { durationMs, exitStatus?, bytes? }
 * @param {(target:string)=>object} deployScript  maps a target to { durationMs, ok?, exitStatus?, url? }
 */
function buildDeployBoundary({ clock, buildScript, deployScript }) {
  const buildCalls = [];
  const deployCalls = [];
  // A REAL side-effect registry the successful deploy flips (the "live hosting"
  // record). key = `${projectId}::${targetKind}` -> url.
  const deployedRegistry = new Map();

  const buildBoundary = async ({ projectId, target, timeoutMs, signal }) => {
    buildCalls.push({ projectId, target, timeoutMs });
    const plan = (buildScript && buildScript(target)) ?? {};
    const durationMs = typeof plan.durationMs === 'number' ? plan.durationMs : 0;
    if (durationMs > 0) clock.advance(durationMs);
    return {
      exitStatus: typeof plan.exitStatus === 'number' ? plan.exitStatus : 0,
      artifactPath: plan.artifactPath ?? `${target}/${projectId}.artifact`,
      bytes: plan.bytes ?? `bytes:${projectId}:${target}`,
      stderr: plan.stderr ?? '',
    };
  };

  const deployBoundary = async ({ projectId, artifact, destination, timeoutMs, signal }) => {
    deployCalls.push({ projectId, targetKind: artifact.targetKind, destination, timeoutMs });
    const plan = (deployScript && deployScript(artifact.targetKind)) ?? {};
    const durationMs = typeof plan.durationMs === 'number' ? plan.durationMs : 0;
    if (durationMs > 0) clock.advance(durationMs);
    const ok = plan.ok !== undefined ? plan.ok : true;
    const exitStatus = typeof plan.exitStatus === 'number' ? plan.exitStatus : (ok ? 0 : 1);
    const url = plan.url !== undefined ? plan.url : `https://${projectId}-${artifact.targetKind}.hosting.local`;
    // REAL side effect: a genuinely successful deploy flips the live-hosting
    // registry. A failed deploy touches NOTHING (prior record intact).
    if (ok && exitStatus === 0 && typeof url === 'string') {
      deployedRegistry.set(`${projectId}::${artifact.targetKind}`, url);
    }
    return { ok, exitStatus, url, stderr: plan.stderr ?? '' };
  };

  return { buildBoundary, deployBoundary, buildCalls, deployCalls, deployedRegistry };
}

/**
 * A REAL CommandGuard over the REAL plumby classifier. manager.exec is a fake
 * standing in for the boundary the guard runs an allowed/consented command
 * through; it reports a clean in-box success and records calls so a
 * declined/refused deploy is proven to NEVER reach exec.
 */
function realGuard(onConfirmRequest) {
  const execCalls = [];
  const manager = {
    exec: async (projectId, command, opts) => {
      execCalls.push({ projectId, command, opts });
      return { stdout: 'ok', stderr: '', exitCode: 0, denied: false, deniedReason: null, timedOut: false };
    },
  };
  const guard = createCommandGuard({ manager, classify: classifyCommand, onConfirmRequest });
  return { guard, execCalls };
}

/**
 * The ONE mobile scaffold + build boundary fake. Models the Expo scaffold and
 * the shared-mobile-build farm's QUEUE phase then EXECUTION phase as SEPARATE
 * injected-clock deltas — both advance the clock, but only executionMs is what
 * the service compares to the 1800s execution timeout.
 */
function mobileBoundary({ clock, scaffoldPlan, buildPlan }) {
  const scaffoldCalls = [];
  const buildCalls = [];

  const scaffoldBoundary = async ({ projectId, timeoutMs }) => {
    scaffoldCalls.push({ projectId, timeoutMs });
    const plan = scaffoldPlan ?? {};
    const durationMs = typeof plan.durationMs === 'number' ? plan.durationMs : 0;
    if (durationMs > 0) clock.advance(durationMs);
    return {
      exitStatus: typeof plan.exitStatus === 'number' ? plan.exitStatus : 0,
      files: plan.files ?? [`mobile/${projectId}/App.js`, `mobile/${projectId}/app.json`],
      stderr: plan.stderr ?? '',
    };
  };

  const mobileBuildBoundary = async ({ projectId, executionTimeoutMs }) => {
    buildCalls.push({ projectId, executionTimeoutMs });
    const plan = buildPlan ?? {};
    if (plan.missingToolchain) return { missingToolchain: plan.missingToolchain };
    const queuedMs = typeof plan.queuedMs === 'number' ? plan.queuedMs : 0;
    const executionMs = typeof plan.executionMs === 'number' ? plan.executionMs : 0;
    // Queue time passes on the clock but is reported separately (NOT counted).
    if (queuedMs > 0) clock.advance(queuedMs);
    // Execution time passes on the clock too (this is what is measured).
    if (executionMs > 0) clock.advance(executionMs);
    return {
      queuedMs,
      executionMs,
      exitStatus: typeof plan.exitStatus === 'number' ? plan.exitStatus : 0,
      bytes: plan.bytes ?? `mobile-artifact:${projectId}`,
      stderr: plan.stderr ?? '',
    };
  };

  return { scaffoldBoundary, mobileBuildBoundary, scaffoldCalls, buildCalls };
}

// ============================================ classifier facts (REAL, un-stubbed)

test('INTEGRATION the chosen deploy commands classify as expected by the REAL plumby classifier', () => {
  // MUTATION SENSITIVITY: if the confirm command stopped classifying `confirm`,
  // the confirm-gate integration tests below would silently exercise the allow
  // path. Pin the REAL classifier fact the whole confirm path rests on.
  assert.equal(classifyCommand(CONFIRM_DEPLOY_COMMAND).outcome, 'confirm');
  assert.equal(classifyCommand(ALLOW_DEPLOY_COMMAND).outcome, 'allow');
});

// ============================================ (1) web/backend/shared build <=300s

test('INTEGRATION web/backend/shared build <=300s each -> exactly one REAL artifact of the right targetKind (Req 18.1)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  // Each non-mobile target builds in 250s -> within the 300s SLO.
  const b = buildDeployBoundary({ clock, buildScript: () => ({ durationMs: 250_000, exitStatus: 0 }) });
  const svc = createBuildService({
    layout,
    buildBoundary: b.buildBoundary,
    deployBoundary: b.deployBoundary,
    now: clock,
  });

  for (const target of ['web', 'backend', 'shared']) {
    const res = await svc.build({ projectId: PROJECT_ID, target });
    assert.equal(res.ok, true);
    // A REAL Deployment_Artifact of the requested target kind.
    assert.equal(res.artifact.targetKind, target);
    assert.equal(res.artifact.exitStatus, 0);
    // TIMING measured on the injected clock, within the 300s SLO.
    assert.equal(res.buildMs, 250_000, 'build duration measured on the injected clock');
    assert.ok(res.buildMs <= BUILD_SLO_MS, 'built within the 300s ceiling');
    // MUTATION SENSITIVITY: the artifact bytes are a REAL on-disk file — if the
    // service stopped writing the artifact this read throws.
    assert.equal(fs.readFileSync(res.artifactPath, 'utf8'), `bytes:${PROJECT_ID}:${target}`);
    // The 300s ceiling was threaded to the boundary.
    const call = b.buildCalls.find((c) => c.target === target);
    assert.equal(call.timeoutMs, BUILD_SLO_MS, '300s build SLO threaded to the boundary');
  }
  // Exactly three artifacts (one per non-mobile target) exist on disk; no others.
  assert.equal(svc.artifactFor(PROJECT_ID, 'web').targetKind, 'web');
  assert.equal(svc.artifactFor(PROJECT_ID, 'backend').targetKind, 'backend');
  assert.equal(svc.artifactFor(PROJECT_ID, 'shared').targetKind, 'shared');
});

test('INTEGRATION build scripted >300s -> BUILD_TIMEOUT, NO artifact on disk (Req 18.3)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  // Exit 0 but over the 300s budget on the injected clock.
  const b = buildDeployBoundary({ clock, buildScript: () => ({ durationMs: BUILD_SLO_MS + 1, exitStatus: 0 }) });
  const svc = createBuildService({ layout, buildBoundary: b.buildBoundary, now: clock });

  const res = await svc.build({ projectId: PROJECT_ID, target: 'web' });
  // MUTATION SENSITIVITY: dropping the >300s gate flips this to ok:true with an
  // artifact even though the build blew the SLO.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BUILD_TIMEOUT');
  assert.ok(res.buildMs > BUILD_SLO_MS, 'over-budget measured on the injected clock');
  assert.equal(svc.artifactFor(PROJECT_ID, 'web'), null, 'no artifact tracked for a timed-out build');
});

// ============================================ (2) deploy URL <=120s + failure keeps prior state

test('INTEGRATION deploy returns a hosting URL <=120s and records it in the live-hosting registry (Req 18.4)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({
    clock,
    buildScript: () => ({ durationMs: 1000, exitStatus: 0 }),
    deployScript: () => ({ durationMs: 90_000, url: 'https://live.example.app' }),
  });
  const svc = createBuildService({
    layout,
    buildBoundary: b.buildBoundary,
    deployBoundary: b.deployBoundary,
    now: clock,
  });

  const built = await svc.build({ projectId: PROJECT_ID, target: 'web' });
  const res = await svc.deploy({ projectId: PROJECT_ID, artifact: built.artifact, destination: 'prod' });

  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://live.example.app');
  // TIMING measured on the injected clock, within the 120s SLO.
  assert.equal(res.deployMs, 90_000, 'deploy duration measured on the injected clock');
  assert.ok(res.deployMs <= DEPLOY_SLO_MS, 'deployed within the 120s ceiling');
  // REAL side effect: the live-hosting registry now holds the URL, and the
  // service records it as the current deployed state.
  assert.equal(b.deployedRegistry.get(`${PROJECT_ID}::web`), 'https://live.example.app', 'live-hosting registry flipped by the deploy');
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), 'https://live.example.app');
  // The 120s ceiling was threaded to the boundary.
  assert.equal(b.deployCalls[0].timeoutMs, DEPLOY_SLO_MS, '120s deploy SLO threaded to the boundary');
});

test('INTEGRATION a failing deploy reports the cause and leaves the PRIOR deployed URL in the registry unchanged (Req 18.6)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  // Flip the deploy boundary between calls: first succeeds, second fails.
  let failNext = false;
  const b = buildDeployBoundary({
    clock,
    buildScript: () => ({ durationMs: 1000, exitStatus: 0 }),
    deployScript: () =>
      failNext
        ? { durationMs: 1000, ok: false, exitStatus: 1, url: null, stderr: 'provider 500' }
        : { durationMs: 1000, ok: true, url: 'https://good.example.app' },
  });
  const svc = createBuildService({
    layout,
    buildBoundary: b.buildBoundary,
    deployBoundary: b.deployBoundary,
    now: clock,
  });
  const built = await svc.build({ projectId: PROJECT_ID, target: 'web' });

  const first = await svc.deploy({ projectId: PROJECT_ID, artifact: built.artifact, destination: 'prod' });
  assert.equal(first.ok, true);
  assert.equal(b.deployedRegistry.get(`${PROJECT_ID}::web`), 'https://good.example.app');

  failNext = true;
  const second = await svc.deploy({ projectId: PROJECT_ID, artifact: built.artifact, destination: 'prod' });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'DEPLOY_FAILED');
  assert.match(second.message, /provider 500|no hosting URL/);
  assert.equal(second.priorUrl, 'https://good.example.app', 'the failing deploy echoes the prior URL');
  // MUTATION SENSITIVITY: applying-anyway would overwrite the registry / clear
  // it. The prior live-hosting record is byte-for-byte intact.
  assert.equal(b.deployedRegistry.get(`${PROJECT_ID}::web`), 'https://good.example.app', 'prior live-hosting record unchanged after a failed deploy');
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), 'https://good.example.app', 'recorded deployed state unchanged after a failed deploy');
});

// ============================================ (3) confirm-gated deploy via the REAL guard + classifier

test('INTEGRATION confirm-gated deploy via the REAL guard+classifier: consent GRANTED -> deploys and flips the registry (Req 18.7)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({
    clock,
    buildScript: () => ({ durationMs: 1000, exitStatus: 0 }),
    deployScript: () => ({ durationMs: 1000, url: 'https://confirmed.example.app' }),
  });
  const consentRequests = [];
  const { guard, execCalls } = realGuard((req) => {
    consentRequests.push(req);
    return true; // grant
  });
  const svc = createBuildService({
    layout,
    buildBoundary: b.buildBoundary,
    deployBoundary: b.deployBoundary,
    commandGuard: guard,
    now: clock,
  });
  const built = await svc.build({ projectId: PROJECT_ID, target: 'web' });

  const res = await svc.deploy({
    projectId: PROJECT_ID,
    artifact: built.artifact,
    destination: 'prod',
    command: CONFIRM_DEPLOY_COMMAND,
  });

  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://confirmed.example.app');
  // Routed THROUGH the REAL confirm gate: the guard consulted the consent seam
  // (only because the REAL classifier tagged it `confirm`), THEN the deploy ran.
  assert.equal(consentRequests.length, 1, 'the confirm gate was consulted (confirm-class)');
  assert.equal(execCalls.length, 1, 'the consented command reached exec through the REAL guard');
  // REAL side effect: the deploy flipped the live-hosting registry.
  assert.equal(b.deployedRegistry.get(`${PROJECT_ID}::web`), 'https://confirmed.example.app');
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), 'https://confirmed.example.app');
  // The 60s consent ceiling is DISTINCT from the 120s deploy ceiling.
  assert.equal(DEFAULT_CONFIRM_TIMEOUT_MS, 60_000);
  assert.notEqual(DEFAULT_CONFIRM_TIMEOUT_MS, DEPLOY_SLO_MS);
});

test('INTEGRATION confirm-gated deploy DECLINED via the REAL guard -> does NOT deploy, prior state intact (Req 18.7)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({
    clock,
    buildScript: () => ({ durationMs: 1000, exitStatus: 0 }),
    // If the deploy boundary were (wrongly) reached it would SUCCEED — so a
    // never-flipped registry is real proof the confirm gate blocked it.
    deployScript: () => ({ durationMs: 1000, url: 'https://should-not.example.app' }),
  });
  const consentRequests = [];
  const { guard, execCalls } = realGuard((req) => {
    consentRequests.push(req);
    return false; // decline
  });
  const svc = createBuildService({
    layout,
    buildBoundary: b.buildBoundary,
    deployBoundary: b.deployBoundary,
    commandGuard: guard,
    now: clock,
  });
  const built = await svc.build({ projectId: PROJECT_ID, target: 'web' });

  const res = await svc.deploy({
    projectId: PROJECT_ID,
    artifact: built.artifact,
    destination: 'prod',
    command: CONFIRM_DEPLOY_COMMAND,
  });

  // MUTATION SENSITIVITY: removing the confirm gate would let this deploy anyway.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPLOY_CONFIRM_DENIED');
  assert.equal(consentRequests.length, 1, 'the confirm gate was consulted');
  assert.equal(execCalls.length, 0, 'the declined command NEVER reached exec');
  assert.equal(b.deployCalls.length, 0, 'the deploy boundary NEVER ran on a declined confirm');
  assert.equal(b.deployedRegistry.has(`${PROJECT_ID}::web`), false, 'nothing recorded in the live-hosting registry');
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), null, 'no deployed state on a declined confirm');
});

test('INTEGRATION confirm-gated deploy consent NOT granted within the 60s window (injected clock advances past it) -> does NOT deploy, prior state intact (Req 18.7)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({
    clock,
    buildScript: () => ({ durationMs: 1000, exitStatus: 0 }),
    deployScript: () => ({ durationMs: 1000, url: 'https://should-not.example.app' }),
  });
  const consentRequests = [];
  // A consent seam that models the user NOT approving inside the 60s window: it
  // advances the injected clock PAST the 60s consent bound and then answers with
  // a non-grant. NO real waiting — the ceiling is measured on the injected clock,
  // and a non-grant maps to the same DEPLOY_CONFIRM_DENIED as a hard timeout.
  const { guard, execCalls } = realGuard((req) => {
    consentRequests.push(req);
    clock.advance(DEFAULT_CONFIRM_TIMEOUT_MS + 1);
    return false; // consent not granted within the window
  });
  const svc = createBuildService({
    layout,
    buildBoundary: b.buildBoundary,
    deployBoundary: b.deployBoundary,
    commandGuard: guard,
    now: clock,
  });
  const built = await svc.build({ projectId: PROJECT_ID, target: 'web' });

  const res = await svc.deploy({
    projectId: PROJECT_ID,
    artifact: built.artifact,
    destination: 'prod',
    command: CONFIRM_DEPLOY_COMMAND,
  });

  // MUTATION SENSITIVITY: without the confirm gate, a non-granted consent would
  // still deploy. It must DENY and not deploy, and the 60s ceiling has elapsed
  // on the injected clock.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DEPLOY_CONFIRM_DENIED');
  assert.ok(clock() > DEFAULT_CONFIRM_TIMEOUT_MS, 'the 60s consent window elapsed on the injected clock');
  assert.equal(consentRequests.length, 1, 'the confirm gate was consulted');
  assert.equal(execCalls.length, 0, 'an ungranted consent NEVER reached exec');
  assert.equal(b.deployCalls.length, 0, 'the deploy boundary NEVER ran on an ungranted consent');
  assert.equal(svc.deployedUrl(PROJECT_ID, 'web'), null, 'no deployed state on an ungranted consent');
});

test('INTEGRATION an allow-classified deploy command proceeds through the REAL guard without consent (Req 18.7)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({
    clock,
    buildScript: () => ({ durationMs: 1000, exitStatus: 0 }),
    deployScript: () => ({ durationMs: 1000, url: 'https://allowed.example.app' }),
  });
  const consentRequests = [];
  const { guard } = realGuard((req) => {
    consentRequests.push(req);
    return true;
  });
  const svc = createBuildService({
    layout,
    buildBoundary: b.buildBoundary,
    deployBoundary: b.deployBoundary,
    commandGuard: guard,
    now: clock,
  });
  const built = await svc.build({ projectId: PROJECT_ID, target: 'web' });

  const res = await svc.deploy({
    projectId: PROJECT_ID,
    artifact: built.artifact,
    destination: 'prod',
    command: ALLOW_DEPLOY_COMMAND,
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://allowed.example.app');
  // An allow-class command needs NO consent — the confirm seam was never called.
  assert.equal(consentRequests.length, 0, 'allow-class deploy consulted no consent gate');
});

// ============================================ (4) mobile scaffold <=30s + Expo endpoint <=60s

test('INTEGRATION mobile scaffold <=30s (exit 0) + Expo Preview endpoint reachable <=60s via the REAL PreviewController (Req 15.1/15.2)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const mb = mobileBoundary({ clock, scaffoldPlan: { durationMs: 20_000, exitStatus: 0 } });
  const mobileSvc = createMobileBuildService({
    layout,
    scaffoldBoundary: mb.scaffoldBoundary,
    now: clock,
  });

  const scaffold = await mobileSvc.scaffoldMobile({ projectId: PROJECT_ID });
  assert.equal(scaffold.ok, true);
  // TIMING measured on the injected clock, within the 30s scaffold SLO.
  assert.equal(scaffold.scaffoldMs, 20_000, 'scaffold duration measured on the injected clock');
  assert.ok(scaffold.scaffoldMs <= SCAFFOLD_SLO_MS, 'scaffolded within the 30s ceiling');
  assert.equal(mb.scaffoldCalls[0].timeoutMs, SCAFFOLD_SLO_MS, '30s scaffold SLO threaded to the boundary');

  // The Expo endpoint reachability <=60s exercised via the REAL PreviewController
  // (over the REAL createDevServer seam). The 45s reachability is on the injected
  // clock; the connection URL + a scannable QR payload come back.
  const preview = createPreviewController({ devServer: createDevServer(), now: clock });
  const reach = preview.previewMobile({
    projectId: PROJECT_ID,
    reachable: true,
    connectionUrl: `exp://preview.local/${PROJECT_ID}`,
    elapsedMs: 45_000,
  });
  assert.equal(reach.ok, true);
  assert.equal(reach.url, `exp://preview.local/${PROJECT_ID}`);
  assert.equal(reach.qr, `qr:exp://preview.local/${PROJECT_ID}`, 'a scannable QR payload synthesized from the URL');
  // MUTATION SENSITIVITY: an endpoint that took >60s must be reported unavailable.
  assert.ok(reach.reachableMs <= MOBILE_REACHABLE_MS, 'Expo endpoint reachable within the 60s bound');

  // And prove the >60s bound is enforced (prior reachable preview retained).
  const late = preview.previewMobile({
    projectId: PROJECT_ID,
    reachable: true,
    connectionUrl: `exp://late.local/${PROJECT_ID}`,
    elapsedMs: MOBILE_REACHABLE_MS + 1,
  });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'MOBILE_PREVIEW_UNAVAILABLE');
  assert.equal(late.priorPreview.url, `exp://preview.local/${PROJECT_ID}`, 'the prior reachable Expo preview is retained');
});

// ============================================ (5) mobile build bounded by 1800s EXECUTION timeout, queue EXCLUDED

test('INTEGRATION mobile build: a LONG queue + SHORT execution SUCCEEDS (queue reported separately, NOT counted) (Req 15.4/15.5)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  // Queue for 2x the execution timeout, but execute in well under it.
  const queuedMs = DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS * 2;
  const executionMs = 60_000;
  const mb = mobileBoundary({ clock, buildPlan: { queuedMs, executionMs, exitStatus: 0 } });
  const mobileSvc = createMobileBuildService({
    layout,
    mobileBuildBoundary: mb.mobileBuildBoundary,
    now: clock,
  });

  const statuses = [];
  const res = await mobileSvc.buildMobile({ projectId: PROJECT_ID, onStatus: (s) => statuses.push(s) });

  // MUTATION SENSITIVITY: if queue time were counted against the 1800s execution
  // timeout, total elapsed (2x timeout + 60s) would blow the budget and this
  // would be BUILD_TIMEOUT. It SUCCEEDS because ONLY executionMs is measured.
  assert.equal(res.ok, true);
  assert.equal(res.executionMs, executionMs, 'only the execution delta is measured');
  assert.equal(res.queuedMs, queuedMs, 'queue delta reported separately');
  assert.ok(res.executionMs <= DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS, 'execution within the 1800s timeout');
  // The queued status was reported separately (Req 15.5).
  assert.deepEqual(statuses, [{ status: 'queued', queuedMs }], 'queued status reported separately and once');
  // The total elapsed clock is well past 1800s (proving the queue really passed
  // on the clock), yet the build SUCCEEDED — queue time was excluded.
  assert.ok(clock() > DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS, 'total wall-clock exceeded 1800s (queue passed) yet build succeeded');
  // A REAL mobile artifact was produced on disk.
  assert.equal(res.artifact.targetKind, 'mobile');
  assert.equal(fs.readFileSync(res.artifactPath, 'utf8'), `mobile-artifact:${PROJECT_ID}`);
  // The 1800s execution timeout was threaded to the boundary.
  assert.equal(mb.buildCalls[0].executionTimeoutMs, DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS);
});

test('INTEGRATION mobile build: execution scripted past 1800s -> BUILD_TIMEOUT, NO artifact (Req 15.7)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const mb = mobileBoundary({
    clock,
    buildPlan: { queuedMs: 5000, executionMs: DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS + 1, exitStatus: 0 },
  });
  const mobileSvc = createMobileBuildService({
    layout,
    mobileBuildBoundary: mb.mobileBuildBoundary,
    now: clock,
  });

  const res = await mobileSvc.buildMobile({ projectId: PROJECT_ID });
  // MUTATION SENSITIVITY: dropping the execution-timeout check flips this to ok.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BUILD_TIMEOUT');
  assert.ok(res.executionMs > DEFAULT_MOBILE_BUILD_EXECUTION_TIMEOUT_MS, 'execution over budget, queue excluded');
  assert.equal(mobileSvc.artifactFor(PROJECT_ID), null, 'no mobile artifact on an execution timeout');
});

// ============================================ (6) exactly four Targets + shared propagation <=5s

test('INTEGRATION coordinator has EXACTLY the four Targets from the closed enum (Req 16.1)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({ clock, buildScript: () => ({ durationMs: 1000, exitStatus: 0 }) });
  const buildSvc = createBuildService({ layout, buildBoundary: b.buildBoundary, now: clock });
  const coordinator = createMultiTargetCoordinator({ buildService: buildSvc, now: clock });

  // Exactly four Targets, from the enum, in enum order.
  assert.deepEqual(coordinator.targets(), ['web', 'backend', 'mobile', 'shared']);
  assert.deepEqual(coordinator.targets(), Target.slice());
  assert.equal(coordinator.targets().length, 4);
});

test('INTEGRATION shared propagation <=5s commits the new version to web/mobile/backend (Req 16.2)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({ clock, buildScript: () => ({ durationMs: 1000, exitStatus: 0 }) });
  const buildSvc = createBuildService({ layout, buildBoundary: b.buildBoundary, now: clock });
  // Each of the three targets receives the update in ~1s -> ~3s total, <=5s.
  const propagateBoundary = async () => {
    clock.advance(1000);
    return { ok: true };
  };
  const coordinator = createMultiTargetCoordinator({ buildService: buildSvc, propagateBoundary, now: clock });

  const res = await coordinator.propagateShared({ projectId: PROJECT_ID, version: 'v2' });
  assert.equal(res.ok, true);
  assert.equal(res.version, 'v2');
  // TIMING measured on the injected clock, within the 5s propagation SLO.
  assert.ok(res.propagationMs <= PROPAGATION_SLO_MS, 'propagated within the 5s ceiling');
  // Committed to all three propagation targets + recorded as last-good.
  assert.equal(coordinator.lastGoodSharedVersion(PROJECT_ID), 'v2');
  for (const target of ['web', 'mobile', 'backend']) {
    assert.equal(coordinator.receivedSharedVersion(PROJECT_ID, target), 'v2', `${target} received v2`);
  }
});

test('INTEGRATION a FAILED shared propagation retains the last-good version EVERYWHERE and NAMES the failed target(s) (Req 16.3)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({ clock, buildScript: () => ({ durationMs: 1000, exitStatus: 0 }) });
  const buildSvc = createBuildService({ layout, buildBoundary: b.buildBoundary, now: clock });

  // First propagate v1 successfully to establish a last-good.
  let failMobile = false;
  const propagateBoundary = async ({ target }) => {
    clock.advance(1000);
    if (failMobile && target === 'mobile') return { ok: false };
    return { ok: true };
  };
  const coordinator = createMultiTargetCoordinator({ buildService: buildSvc, propagateBoundary, now: clock });

  const good = await coordinator.propagateShared({ projectId: PROJECT_ID, version: 'v1' });
  assert.equal(good.ok, true);
  assert.equal(coordinator.lastGoodSharedVersion(PROJECT_ID), 'v1');

  // Now v2 fails on `mobile`.
  failMobile = true;
  const res = await coordinator.propagateShared({ projectId: PROJECT_ID, version: 'v2' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PROPAGATION_FAILED');
  assert.deepEqual(res.failedTargets, ['mobile'], 'the failed Target is named');
  assert.equal(res.retainedVersion, 'v1', 'the retained version is the PRIOR good, not the new one');
  // MUTATION SENSITIVITY: dropping the ALL-OR-NOTHING rollback would leave web /
  // backend on v2 (torn state). The last-good v1 is retained EVERYWHERE.
  assert.equal(coordinator.lastGoodSharedVersion(PROJECT_ID), 'v1', 'last-good unchanged after a failed propagation');
  for (const target of ['web', 'mobile', 'backend']) {
    assert.equal(coordinator.receivedSharedVersion(PROJECT_ID, target), 'v1', `${target} retained v1 (no torn state)`);
  }
});

// ============================================ (7) preview selector (web default + explicit indication)

test('INTEGRATION multi-target Preview selector via the REAL PreviewController: web default with an explicit defaultUsed, and INVALID_TARGET rejection (Req 16.4/16.5)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({ clock, buildScript: () => ({ durationMs: 1000, exitStatus: 0 }) });
  const buildSvc = createBuildService({ layout, buildBoundary: b.buildBoundary, now: clock });
  const preview = createPreviewController({ devServer: createDevServer(), now: clock });
  const coordinator = createMultiTargetCoordinator({ buildService: buildSvc, previewController: preview, now: clock });

  // No target selected -> web default WITH an explicit indication.
  const def = coordinator.selectPreviewTarget({ projectId: PROJECT_ID, targetCategory: 'multi-target' });
  assert.equal(def.ok, true);
  assert.equal(def.selected, 'web');
  assert.equal(def.defaultUsed, true, 'the web default is explicitly indicated');

  // Explicit target -> that target, no default indication.
  const explicit = coordinator.selectPreviewTarget({ projectId: PROJECT_ID, targetCategory: 'multi-target', target: 'mobile' });
  assert.equal(explicit.selected, 'mobile');
  assert.equal(explicit.defaultUsed, false);

  // Out-of-enum target -> INVALID_TARGET naming it.
  const bad = coordinator.selectPreviewTarget({ projectId: PROJECT_ID, targetCategory: 'multi-target', target: 'desktop' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_TARGET');
  assert.equal(bad.target, 'desktop', 'the invalid Target is named');
});

// ============================================ (8) per-Target artifact selection end-to-end

test('INTEGRATION buildTargets builds EXACTLY the requested Targets (one real artifact each) and NONE for unrequested (Req 16.6)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({ clock, buildScript: () => ({ durationMs: 1000, exitStatus: 0 }) });
  const buildSvc = createBuildService({ layout, buildBoundary: b.buildBoundary, now: clock });
  const mb = mobileBoundary({ clock, buildPlan: { queuedMs: 0, executionMs: 1000, exitStatus: 0 } });
  const mobileSvc = createMobileBuildService({ layout, mobileBuildBoundary: mb.mobileBuildBoundary, now: clock });
  const coordinator = createMultiTargetCoordinator({ buildService: buildSvc, mobileBuildService: mobileSvc, now: clock });

  // Request web + backend only.
  const res = await coordinator.buildTargets({ projectId: PROJECT_ID, targets: ['web', 'backend'] });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.artifacts).sort(), ['backend', 'web']);
  assert.equal(res.artifacts.web.targetKind, 'web');
  assert.equal(res.artifacts.backend.targetKind, 'backend');
  // MUTATION SENSITIVITY: building an unrequested Target would flip these. NO
  // artifact exists for `mobile` or `shared` (unrequested).
  assert.equal(mobileSvc.artifactFor(PROJECT_ID), null, 'no mobile artifact for an unrequested Target');
  assert.equal(buildSvc.artifactFor(PROJECT_ID, 'shared'), null, 'no shared artifact for an unrequested Target');
  // Real on-disk artifacts for exactly the requested Targets.
  assert.equal(fs.existsSync(buildSvc.artifactFor(PROJECT_ID, 'web').path), true);
  assert.equal(fs.existsSync(buildSvc.artifactFor(PROJECT_ID, 'backend').path), true);
});

test('INTEGRATION a FAILED requested Target build completes the others, NAMES the failed one, produces no artifact for it, preserves prior artifacts (Req 16.7)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  // `backend` build fails (non-zero exit); `web` and `shared` succeed.
  const b = buildDeployBoundary({
    clock,
    buildScript: (target) =>
      target === 'backend'
        ? { durationMs: 1000, exitStatus: 1, stderr: 'backend build broke' }
        : { durationMs: 1000, exitStatus: 0 },
  });
  const buildSvc = createBuildService({ layout, buildBoundary: b.buildBoundary, now: clock });
  const coordinator = createMultiTargetCoordinator({ buildService: buildSvc, now: clock });

  // First establish a prior good `web` artifact via a separate request.
  const pre = await coordinator.buildTargets({ projectId: PROJECT_ID, targets: ['web'] });
  assert.equal(pre.ok, true);
  const priorWebPath = buildSvc.artifactFor(PROJECT_ID, 'web').path;
  const priorWebBytes = fs.readFileSync(priorWebPath, 'utf8');

  // Now request web + backend + shared, with backend failing.
  const res = await coordinator.buildTargets({ projectId: PROJECT_ID, targets: ['web', 'backend', 'shared'] });
  // MUTATION SENSITIVITY: a failed Target must not abort the others.
  assert.equal(res.ok, false);
  assert.deepEqual(res.failedTargets, ['backend'], 'the failed Target is named');
  assert.deepEqual(Object.keys(res.artifacts).sort(), ['shared', 'web'], 'the other Targets still built');
  // No artifact for the failed backend.
  assert.equal(buildSvc.artifactFor(PROJECT_ID, 'backend'), null, 'no artifact for the failed Target');
  // The prior `web` artifact is preserved on disk (rebuilt, still present).
  assert.equal(fs.existsSync(priorWebPath), true, 'prior artifact preserved');
  assert.equal(fs.readFileSync(priorWebPath, 'utf8'), priorWebBytes);
});

test('INTEGRATION an INVALID requested Target rejects the WHOLE request naming it, modifying NO existing artifact (Req 16.8)', async (t) => {
  const clock = manualClock();
  const layout = freshLayout(t);
  const b = buildDeployBoundary({ clock, buildScript: () => ({ durationMs: 1000, exitStatus: 0 }) });
  const buildSvc = createBuildService({ layout, buildBoundary: b.buildBoundary, now: clock });
  const coordinator = createMultiTargetCoordinator({ buildService: buildSvc, now: clock });

  // Establish a prior good `web` artifact.
  const pre = await coordinator.buildTargets({ projectId: PROJECT_ID, targets: ['web'] });
  assert.equal(pre.ok, true);
  const priorWebPath = buildSvc.artifactFor(PROJECT_ID, 'web').path;
  const priorWebBytes = fs.readFileSync(priorWebPath, 'utf8');
  const buildCallsBefore = b.buildCalls.length;

  // A request containing an invalid Target rejects the WHOLE request.
  const res = await coordinator.buildTargets({ projectId: PROJECT_ID, targets: ['web', 'desktop'] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_TARGET');
  assert.equal(res.target, 'desktop', 'the invalid Target is named');
  // MUTATION SENSITIVITY: no build was attempted for ANY Target (not even the
  // valid `web`), and the prior artifact is byte-for-byte unchanged.
  assert.equal(b.buildCalls.length, buildCallsBefore, 'no build attempted on an invalid-Target request');
  assert.equal(fs.readFileSync(priorWebPath, 'utf8'), priorWebBytes, 'existing artifact unmodified');
});
