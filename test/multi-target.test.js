/**
 * Multi-Target coordinator UNIT tests (node --test) — spec Task 26.3, Req 16.1,
 * 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8.
 *
 * These exercise the REAL createMultiTargetCoordinator with REAL collaborators:
 *   - the REAL closed Target enum (src/model/enums.js) as the four-Target set;
 *   - the REAL PreviewController (createPreviewController over the REAL
 *     createDevServer seam) for the Preview selector — the coordinator DELEGATES
 *     to it rather than reimplementing a second selector;
 *   - the REAL FEAT-002 createBuildService with a REAL StorageLayout on an
 *     fs.mkdtempSync temp dir, so per-Target builds produce REAL
 *     createDeploymentArtifact records + REAL on-disk artifact files.
 * ONLY the external build/propagation boundary is faked, and the fakes produce
 * REAL contracts + REAL side effects, so assertions land on real state.
 *
 * A SINGLE manually-advanced injected `now` ms counter is the only "time" that
 * passes — the 5s propagation SLO is measured against it, never a real wait.
 *
 * MUTATION SENSITIVITY (each key assertion flips if the guarantee is reverted —
 * noted inline): targets() is exactly the four enum Targets in order;
 * propagateShared success <=5s commits the new version to all three targets; a
 * failed propagation RETAINS the LAST GOOD version in ALL targets (retained ==
 * prior good, NOT the new one) and names the failed target(s); >5s ->
 * PROPAGATION_FAILED; selectPreviewTarget delegates to the real selector (web
 * default + defaultUsed; explicit; INVALID_TARGET); buildTargets produces exactly
 * one artifact per requested target and NONE for unrequested; a failed target
 * build still completes the others, names it, produces no artifact for it, and
 * preserves previously produced artifacts; an invalid target rejects the whole
 * request naming it with no artifact modified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createMultiTargetCoordinator,
  PROPAGATION_SLO_MS,
} from '../src/project/multi-target.js';
import { createBuildService } from '../src/project/build-service.js';
import { createPreviewController } from '../src/project/preview-controller.js';
import { createDevServer } from '../src/project/dev-server.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { Target } from '../src/model/enums.js';

const PROJECT_ID = 'proj-multi-target';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-target-'));
  return createStorageLayout(dir);
}

/**
 * A build boundary that advances the injected clock and returns a REAL
 * exec-shaped contract. It can be scripted to FAIL a specific target so we can
 * prove a failed target build does not stop the others and preserves priors.
 */
function scriptedBuildBoundary(clock, { failTargets = [], durationMs = 1000 } = {}) {
  const calls = [];
  const boundary = async ({ projectId, target, timeoutMs, signal }) => {
    calls.push({ projectId, target });
    if (durationMs > 0) clock.advance(durationMs);
    if (failTargets.includes(target)) {
      return { exitStatus: 2, stderr: `build failed for ${target}` };
    }
    return {
      exitStatus: 0,
      artifactPath: `${target}/${projectId}.artifact`,
      bytes: `bytes:${projectId}:${target}`,
      stderr: '',
    };
  };
  boundary.calls = calls;
  return boundary;
}

/** A REAL PreviewController over the REAL Dev_Server seam (nothing launched). */
function realPreviewController() {
  return createPreviewController({ devServer: createDevServer() });
}

// ------------------------------------------------------------ targets() (Req 16.1)

test('targets() returns exactly the four Targets from the closed enum, in enum order', () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildService = createBuildService({ layout, buildBoundary: scriptedBuildBoundary(clock), now: clock });
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), now: clock });

  const t = coord.targets();
  // MUTATION SENSITIVITY: a hardcoded/parallel list or a wrong count flips this.
  assert.deepEqual(t, ['web', 'backend', 'mobile', 'shared']);
  assert.deepEqual(t, Target.slice());
  assert.equal(t.length, 4);
  // Returns a fresh copy — mutating it must not affect the coordinator's view.
  t.push('bogus');
  assert.equal(coord.targets().length, 4);
});

// ------------------------------------------------------------ propagateShared (Req 16.2/16.3)

test('propagateShared: success within 5s commits the new version to web/mobile/backend', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildService = createBuildService({ layout, buildBoundary: scriptedBuildBoundary(clock), now: clock });
  // Each target propagation advances the clock by 1s (3s total, within 5s).
  const propagateBoundary = async () => {
    clock.advance(1000);
    return { ok: true };
  };
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), propagateBoundary, now: clock });

  const res = await coord.propagateShared({ projectId: PROJECT_ID, version: 'v1' });
  assert.equal(res.ok, true);
  assert.equal(res.version, 'v1');
  // MUTATION SENSITIVITY: propagationMs is the injected-clock delta, within 5s.
  assert.equal(res.propagationMs, 3000);
  assert.ok(res.propagationMs <= PROPAGATION_SLO_MS);
  // The new version is now last-good and received in ALL three targets.
  assert.equal(coord.lastGoodSharedVersion(PROJECT_ID), 'v1');
  for (const target of ['web', 'backend', 'mobile']) {
    assert.equal(coord.receivedSharedVersion(PROJECT_ID, target), 'v1');
  }
});

test('propagateShared: a failed propagation to one target retains the LAST GOOD version in ALL targets and names the failed target(s)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildService = createBuildService({ layout, buildBoundary: scriptedBuildBoundary(clock), now: clock });

  // First: a fully-successful propagation establishes last-good = 'v1'.
  let mode = 'all-ok';
  const propagateBoundary = async ({ target }) => {
    clock.advance(500);
    if (mode === 'fail-backend' && target === 'backend') return { ok: false };
    return { ok: true };
  };
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), propagateBoundary, now: clock });

  const first = await coord.propagateShared({ projectId: PROJECT_ID, version: 'v1' });
  assert.equal(first.ok, true);
  assert.equal(coord.lastGoodSharedVersion(PROJECT_ID), 'v1');

  // Now attempt to propagate 'v2', but `backend` fails to receive it.
  mode = 'fail-backend';
  const res = await coord.propagateShared({ projectId: PROJECT_ID, version: 'v2' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PROPAGATION_FAILED');
  // The failed target is NAMED.
  assert.deepEqual(res.failedTargets, ['backend']);
  // MUTATION SENSITIVITY: the retained version must equal the PRIOR good ('v1'),
  // NOT the attempted new one ('v2'). If a partial propagation left web/mobile on
  // 'v2' (torn state), these would read 'v2' and flip.
  assert.equal(res.retainedVersion, 'v1');
  assert.equal(coord.lastGoodSharedVersion(PROJECT_ID), 'v1');
  for (const target of ['web', 'backend', 'mobile']) {
    assert.equal(coord.receivedSharedVersion(PROJECT_ID, target), 'v1');
  }
});

test('propagateShared: an initial failed propagation retains the last-good (null) in all targets and names all failed targets', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildService = createBuildService({ layout, buildBoundary: scriptedBuildBoundary(clock), now: clock });
  // web ok, backend fails, mobile fails -> two named failed targets.
  const propagateBoundary = async ({ target }) => {
    clock.advance(100);
    return { ok: target === 'web' };
  };
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), propagateBoundary, now: clock });

  const res = await coord.propagateShared({ projectId: PROJECT_ID, version: 'v1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PROPAGATION_FAILED');
  assert.deepEqual(res.failedTargets, ['backend', 'mobile']);
  // MUTATION SENSITIVITY: with no prior good, last-good stays null everywhere
  // (rollback of the provisional web receipt), never advanced to the failed 'v1'.
  assert.equal(res.retainedVersion, null);
  assert.equal(coord.lastGoodSharedVersion(PROJECT_ID), null);
  for (const target of ['web', 'backend', 'mobile']) {
    assert.equal(coord.receivedSharedVersion(PROJECT_ID, target), null);
  }
});

test('propagateShared: over the 5s SLO -> PROPAGATION_FAILED, last good retained everywhere', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildService = createBuildService({ layout, buildBoundary: scriptedBuildBoundary(clock), now: clock });
  // Every target "receives" ok, but the total blows the 5s budget.
  const propagateBoundary = async () => {
    clock.advance(2000); // 3 targets * 2000ms = 6000ms > 5000ms
    return { ok: true };
  };
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), propagateBoundary, now: clock });

  const res = await coord.propagateShared({ projectId: PROJECT_ID, version: 'v1' });
  // MUTATION SENSITIVITY: dropping the >5s check flips this to ok:true with the
  // version committed even though it blew the SLO.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PROPAGATION_FAILED');
  assert.equal(res.overBudget, true);
  assert.ok(res.propagationMs > PROPAGATION_SLO_MS);
  // No prior good -> nothing committed; last-good stays null in all targets.
  assert.equal(coord.lastGoodSharedVersion(PROJECT_ID), null);
  for (const target of ['web', 'backend', 'mobile']) {
    assert.equal(coord.receivedSharedVersion(PROJECT_ID, target), null);
  }
});

// ------------------------------------------------------------ selectPreviewTarget (Req 16.4/16.5)

test('selectPreviewTarget: delegates to the REAL PreviewController — web default with defaultUsed:true', () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildService = createBuildService({ layout, buildBoundary: scriptedBuildBoundary(clock), now: clock });
  const previewController = realPreviewController();
  const coord = createMultiTargetCoordinator({ buildService, previewController, now: clock });

  const res = coord.selectPreviewTarget({ projectId: PROJECT_ID, targetCategory: 'multi-target' });
  // MUTATION SENSITIVITY: a wrong/absent default or missing indication flips this.
  assert.equal(res.ok, true);
  assert.equal(res.selected, 'web');
  assert.equal(res.defaultUsed, true);
});

test('selectPreviewTarget: an explicit selectable target is used (defaultUsed:false)', () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildService = createBuildService({ layout, buildBoundary: scriptedBuildBoundary(clock), now: clock });
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), now: clock });

  const res = coord.selectPreviewTarget({ projectId: PROJECT_ID, targetCategory: 'multi-target', target: 'mobile' });
  assert.equal(res.ok, true);
  assert.equal(res.selected, 'mobile');
  assert.equal(res.defaultUsed, false);
});

test('selectPreviewTarget: an out-of-enum target is rejected INVALID_TARGET naming it', () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildService = createBuildService({ layout, buildBoundary: scriptedBuildBoundary(clock), now: clock });
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), now: clock });

  const res = coord.selectPreviewTarget({ projectId: PROJECT_ID, targetCategory: 'multi-target', target: 'nope' });
  // MUTATION SENSITIVITY: accepting an out-of-enum target flips ok to true.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_TARGET');
  assert.equal(res.target, 'nope');
});

// ------------------------------------------------------------ buildTargets (Req 16.6/16.7/16.8)

test('buildTargets: produces exactly one artifact per requested target and NONE for unrequested (Req 16.6)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildBoundary = scriptedBuildBoundary(clock);
  const buildService = createBuildService({ layout, buildBoundary, now: clock });
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), now: clock });

  // Request web + backend only; do NOT request shared.
  const res = await coord.buildTargets({ projectId: PROJECT_ID, targets: ['web', 'backend'] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.failedTargets, []);
  // Exactly one artifact per requested target, of the right kind, on disk.
  assert.equal(Object.keys(res.artifacts).length, 2);
  assert.equal(res.artifacts.web.targetKind, 'web');
  assert.equal(res.artifacts.backend.targetKind, 'backend');
  assert.ok(fs.existsSync(res.artifacts.web.path));
  assert.ok(fs.existsSync(res.artifacts.backend.path));
  // MUTATION SENSITIVITY: NONE for unrequested — no `shared` artifact was built,
  // and the build boundary was NEVER invoked for `shared`.
  assert.equal(res.artifacts.shared, undefined);
  assert.equal(buildService.artifactFor(PROJECT_ID, 'shared'), null);
  assert.ok(!buildBoundary.calls.some((c) => c.target === 'shared'));
});

test('buildTargets: a failed target build still completes the others, names the failed one, produces no artifact for it, and preserves prior artifacts (Req 16.7)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  // `backend` fails to build; `web` and `shared` succeed.
  const buildBoundary = scriptedBuildBoundary(clock, { failTargets: ['backend'] });
  const buildService = createBuildService({ layout, buildBoundary, now: clock });
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), now: clock });

  // Establish a PRIOR good artifact for `web` from an earlier build so we can
  // prove it is preserved across a later partial-failure build.
  const prior = await coord.buildTargets({ projectId: PROJECT_ID, targets: ['web'] });
  assert.equal(prior.ok, true);
  const priorWebPath = prior.artifacts.web.path;
  const priorWebBytes = fs.readFileSync(priorWebPath, 'utf8');

  const res = await coord.buildTargets({ projectId: PROJECT_ID, targets: ['web', 'backend', 'shared'] });
  // Partial: overall not ok, but the non-failed targets DID complete.
  assert.equal(res.ok, false);
  // MUTATION SENSITIVITY: the failed target is NAMED and produces NO artifact.
  assert.deepEqual(res.failedTargets, ['backend']);
  assert.equal(res.artifacts.backend, undefined);
  assert.equal(buildService.artifactFor(PROJECT_ID, 'backend'), null);
  // The remaining requested targets completed with real artifacts on disk.
  assert.equal(res.artifacts.web.targetKind, 'web');
  assert.equal(res.artifacts.shared.targetKind, 'shared');
  assert.ok(fs.existsSync(res.artifacts.shared.path));
  // MUTATION SENSITIVITY: the previously produced `web` artifact is PRESERVED
  // (still on disk, unchanged bytes) — a failed sibling build never deletes it.
  assert.ok(fs.existsSync(priorWebPath));
  assert.equal(fs.readFileSync(priorWebPath, 'utf8'), priorWebBytes);
});

test('buildTargets: a FAILED target with its OWN prior artifact preserves that prior artifact across the failed rebuild (Req 16.7)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  // A boundary we can flip: first build `backend` successfully, then fail it.
  let failBackend = false;
  const buildBoundary = async ({ projectId, target }) => {
    clock.advance(1000);
    if (failBackend && target === 'backend') {
      return { exitStatus: 2, stderr: `build failed for ${target}` };
    }
    return {
      exitStatus: 0,
      artifactPath: `${target}/${projectId}.artifact`,
      bytes: `bytes:${projectId}:${target}`,
      stderr: '',
    };
  };
  const buildService = createBuildService({ layout, buildBoundary, now: clock });
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), now: clock });

  // Establish a PRIOR good artifact for `backend` itself (the target that will
  // later FAIL its rebuild). This is the case Req 16.7 protects: the FAILED
  // target's OWN previously produced artifact must survive its failed rebuild.
  const prior = await coord.buildTargets({ projectId: PROJECT_ID, targets: ['backend'] });
  assert.equal(prior.ok, true);
  const priorBackendPath = prior.artifacts.backend.path;
  const priorBackendBytes = fs.readFileSync(priorBackendPath, 'utf8');
  const priorBackendArtifact = buildService.artifactFor(PROJECT_ID, 'backend');
  assert.equal(priorBackendArtifact.targetKind, 'backend');

  // Now rebuild with `backend` FAILING while `web` succeeds.
  failBackend = true;
  const res = await coord.buildTargets({ projectId: PROJECT_ID, targets: ['web', 'backend'] });
  assert.equal(res.ok, false);
  assert.deepEqual(res.failedTargets, ['backend']);
  assert.equal(res.artifacts.backend, undefined);
  // The sibling `web` completed.
  assert.equal(res.artifacts.web.targetKind, 'web');
  // MUTATION SENSITIVITY: the FAILED target's OWN prior artifact is PRESERVED —
  // still on disk with unchanged bytes, and still the tracked artifact for
  // `backend`. A failed rebuild that deleted or overwrote its own prior would
  // flip these. (This is distinct from the sibling-preservation case: here the
  // preserved prior belongs to the target that FAILED.)
  assert.ok(fs.existsSync(priorBackendPath));
  assert.equal(fs.readFileSync(priorBackendPath, 'utf8'), priorBackendBytes);
  const stillTracked = buildService.artifactFor(PROJECT_ID, 'backend');
  assert.equal(stillTracked.targetKind, 'backend');
  assert.equal(stillTracked.path, priorBackendPath);
});

test('buildTargets: an invalid requested target rejects the WHOLE request naming it, modifying NO existing artifact (Req 16.8)', async () => {
  const clock = manualClock();
  const layout = tempLayout();
  const buildBoundary = scriptedBuildBoundary(clock);
  const buildService = createBuildService({ layout, buildBoundary, now: clock });
  const coord = createMultiTargetCoordinator({ buildService, previewController: realPreviewController(), now: clock });

  // Establish a prior good `web` artifact.
  const prior = await coord.buildTargets({ projectId: PROJECT_ID, targets: ['web'] });
  assert.equal(prior.ok, true);
  const priorWebBytes = fs.readFileSync(prior.artifacts.web.path, 'utf8');
  const callsBefore = buildBoundary.calls.length;

  // A request that includes an invalid target must reject the WHOLE request.
  const res = await coord.buildTargets({ projectId: PROJECT_ID, targets: ['web', 'nope'] });
  // MUTATION SENSITIVITY: validating up-front (before any build) is what makes
  // this reject the whole request naming 'nope' without building `web` again.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_TARGET');
  assert.equal(res.target, 'nope');
  // NO existing artifact modified: no new build boundary calls, prior bytes intact.
  assert.equal(buildBoundary.calls.length, callsBefore);
  assert.equal(fs.readFileSync(prior.artifacts.web.path, 'utf8'), priorWebBytes);
});
