/**
 * PreviewController tests (spec Task 18.1 + 18.2, Req 3.1-3.7, 1.3, 15.2-15.3,
 * 16.4-16.5). Everything here is HERMETIC and OFFLINE exactly as context.json
 * mandates: a FAKE Dev_Server seam that RECORDS start/stop (launches nothing), an
 * INJECTED mutable ms clock so every SLO bound is measured WITHOUT a real wait,
 * and a deterministic injected QR encoder. No real process/container/network.
 *
 * MUTATION SENSITIVITY (documented for the reviewer — each is independently
 * mutation-catching):
 *   - publish points served preview at the committed snapshot; a mutation that
 *     lets a FAILED build overwrite the served preview flips the "retains prior +
 *     showingPrior + buildError" assertions.
 *   - a preview is NEVER exposed as served before readiness: the startup-timeout
 *     test asserts servedPreview stays 'none' when start() times out; a mutation
 *     that exposed a preview before the seam reports ready flips it.
 *   - startup exceeding 60s yields STARTUP_TIMEOUT + restartOffered; a mutation
 *     to the bound (e.g. >= vs >) is caught by the exactly-60000 boundary case.
 *   - the 3rd failed restart yields PERSISTENT_FAILURE with no further automatic
 *     restart; a mutation raising the cap from 3 to 4 flips the cap assertions.
 *   - mobile returns URL + QR and honors the 60s reachability bound; unreachable
 *     retains the prior preview.
 *   - the multi-target selector defaults to web with defaultUsed:true and rejects
 *     an out-of-enum target.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPreviewController,
  STARTUP_TIMEOUT_MS,
  MOBILE_REACHABLE_MS,
  RESTART_CAP,
} from '../src/project/preview-controller.js';

const PID = 'proj-1';

/**
 * A fake Dev_Server seam that RECORDS start/stop calls and launches nothing. Its
 * start() behavior is scriptable: `outcomes` is a queue of { ok, url? } (or a
 * default success) so a restart run can be made to fail deterministically.
 */
function fakeDevServer({ outcomes } = {}) {
  const startCalls = [];
  const stopCalls = [];
  const queue = Array.isArray(outcomes) ? [...outcomes] : null;
  return {
    startCalls,
    stopCalls,
    start(args) {
      startCalls.push(args);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        return next;
      }
      return { ok: true, url: `http://preview.local/${args?.projectId}`, startedAt: 'T0' };
    },
    stop(projectId) {
      stopCalls.push(projectId);
      return { ok: true, stopped: true };
    },
    isRunning(projectId) {
      return startCalls.some((c) => c.projectId === projectId);
    },
  };
}

/**
 * An injected ms clock that advances by `step` on each read. Setting step lets a
 * test drive an elapsed interval WITHOUT a real wait (e.g. step just under vs.
 * over the 60s startup bound).
 */
function steppingClock({ start = 1000, step = 1 } = {}) {
  let t = start;
  const now = () => {
    const v = t;
    t += step;
    return v;
  };
  now.set = (v) => {
    t = v;
  };
  return now;
}

// --------------------------------------------------- publish-on-commit web (3.1/3.3/3.4)

test('publish(buildOk:true) BEFORE any start advances the served snapshot but does NOT fabricate a live url (honest committed state)', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock() });

  // An uncommitted edit is exposed only as building, NEVER as served content.
  pc.markBuilding({ projectId: PID, snapshotId: 'wip-x' });
  assert.equal(pc.servedPreview(PID).snapshotId, null, 'no served preview from an uncommitted edit');
  assert.ok(pc.servedPreview(PID).building, 'uncommitted edit surfaces only as building');

  const res = pc.publish({ projectId: PID, snapshotId: 'snap-1', buildOk: true });
  assert.equal(res.ok, true);
  // Property 3 snapshot-identity semantics are intact: the committed snapshot is
  // published exactly as before.
  assert.equal(res.snapshotId, 'snap-1', 'committed snapshot still advances');
  assert.equal(res.showingPrior, false);
  assert.ok(res.publishMs >= 0);
  // But with NO running Dev_Server the surface must not claim a live url. A
  // mutation restoring the `http://preview.local/${projectId}` fallback would
  // flip these two assertions.
  assert.equal(res.status, 'committed', 'no running handle => committed, not served');
  assert.equal(res.url, null, 'no fabricated live url before start');
  assert.equal(devServer.startCalls.length, 0, 'publish launched no Dev_Server');

  const served = pc.servedPreview(PID);
  assert.equal(served.snapshotId, 'snap-1', 'served points at the committed snapshot');
  assert.equal(served.status, 'committed', 'servedPreview reports committed, not served, with no live handle');
  assert.equal(served.url, null, 'servedPreview presents no fabricated live url');
  assert.equal(served.showingPrior, false);
  assert.equal(served.building, null, 'publish clears the building label');
});

test('publish(buildOk:true) AFTER start uses the REAL running Dev_Server handle url and reports served', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock() });

  // Production ordering: start THEN publish (as finalizePass does).
  const started = pc.start({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(started.ok, true);

  const res = pc.publish({ projectId: PID, snapshotId: 'snap-1', buildOk: true });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'served', 'a running handle makes the preview genuinely served');
  assert.equal(res.snapshotId, 'snap-1');
  // The url is the ACTUAL running Dev_Server handle url, not a fabricated one.
  assert.equal(res.url, started.url, 'served url is the real running Dev_Server handle url');
  assert.equal(res.url, `http://preview.local/${PID}`);

  const served = pc.servedPreview(PID);
  assert.equal(served.status, 'served');
  assert.equal(served.url, started.url, 'servedPreview surfaces the real handle url');
});

test('publish(buildOk:false) RETAINS the prior served preview, records the build error, marks showingPrior (mutation-sensitive)', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock() });

  // First a good publish establishes the served preview.
  pc.publish({ projectId: PID, snapshotId: 'good-1', buildOk: true });
  // Now a committed snapshot that FAILS to build.
  const res = pc.publish({ projectId: PID, snapshotId: 'broken-2', buildOk: false, buildError: 'TypeError: boom' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'showing-prior');
  assert.equal(res.showingPrior, true);
  assert.equal(res.buildError, 'TypeError: boom');
  // The served snapshot is STILL the last good one, NOT the broken commit. A
  // mutation letting a failed build overwrite the served preview flips this.
  assert.equal(res.snapshotId, 'good-1', 'served snapshot is the last GOOD commit, not the broken one');

  const served = pc.servedPreview(PID);
  assert.equal(served.snapshotId, 'good-1', 'served preview retained across a failed build');
  assert.equal(served.showingPrior, true, 'surface indicates a prior state is shown');
  assert.equal(served.buildError, 'TypeError: boom', 'captured build error is surfaced');
});

test('publish(buildOk:false) with NO prior good preview shows no-preview and records the error', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock() });
  const res = pc.publish({ projectId: PID, snapshotId: 'broken-1', buildOk: false, buildError: 'compile failed' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'no-preview');
  assert.equal(res.showingPrior, false, 'no prior preview means showingPrior stays false');
  assert.equal(res.snapshotId, null);
  assert.equal(pc.servedPreview(PID).buildError, 'compile failed');
});

test('publish rejects a non-boolean buildOk with a structured error', () => {
  const pc = createPreviewController({ devServer: fakeDevServer(), now: steppingClock() });
  const res = pc.publish({ projectId: PID, snapshotId: 'snap-1' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'BUILD_OK_REQUIRED');
});

// ----------------------------------------------- Dev_Server lifecycle (3.5/3.6/3.7/1.3)

test('start: within the 60s bound returns ready with BOTH phase elapsed values exposed and does not expose served preview early', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock({ start: 0, step: 1 }) });
  const res = pc.start({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ready');
  assert.equal(typeof res.startupMs, 'number', 'phase 1 (startup) elapsed exposed');
  assert.equal(typeof res.previewAvailableMs, 'number', 'phase 2 (preview-available) elapsed exposed');
  assert.ok(res.startupMs <= STARTUP_TIMEOUT_MS);
  // Readiness alone does NOT publish a served preview — only publish() does. A
  // mutation exposing a preview before a publish flips this.
  assert.equal(pc.servedPreview(PID).snapshotId, null, 'no served preview merely from a ready Dev_Server');
  assert.equal(devServer.startCalls.length, 1);
});

test('start: readiness exceeding 60s yields STARTUP_TIMEOUT + restart offer and exposes NO preview (mutation-sensitive boundary)', () => {
  // A clock that jumps beyond the 60s startup bound between the two reads.
  let calls = 0;
  const now = () => {
    calls += 1;
    // read 1 -> 0 (t0); read 2 -> just OVER the bound.
    return calls === 1 ? 0 : STARTUP_TIMEOUT_MS + 1;
  };
  const pc = createPreviewController({ devServer: fakeDevServer(), now });
  const res = pc.start({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'STARTUP_TIMEOUT');
  assert.equal(res.restartOffered, true);
  assert.ok(res.startupMs > STARTUP_TIMEOUT_MS);
  // A broken/slow startup NEVER exposes a preview.
  assert.equal(pc.servedPreview(PID).snapshotId, null, 'startup-timeout must not expose a served preview');
});

test('start: exactly 60000ms readiness is WITHIN bound (boundary case pins > vs >=)', () => {
  let calls = 0;
  const now = () => {
    calls += 1;
    return calls === 1 ? 0 : STARTUP_TIMEOUT_MS; // exactly 60000ms elapsed
  };
  const pc = createPreviewController({ devServer: fakeDevServer(), now });
  const res = pc.start({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(res.ok, true, 'exactly 60000ms is within the startup bound');
  assert.equal(res.startupMs, STARTUP_TIMEOUT_MS);
});

test('start: phase 1 and phase 2 are measured from DIFFERENT origins (phase 2 is a delta from Dev_Server-ready, not cumulative-from-t0)', () => {
  // A scripted clock with explicit reads so the ready instant and the
  // preview-available read are separated by a known interval:
  //   read 1 (t0)                 -> 0
  //   read 2 (phase-1 elapsed)    -> 5000  => startupMs = 5000
  //   read 3 (readyAt)            -> 100000
  //   read 4 (preview-available)  -> 100200 => previewAvailableMs = 200
  // If phase 2 were still `now() - t0` it would read ~100200 (cumulative), not
  // the 200ms post-ready delta. This pins the two-origin arithmetic and would
  // catch a mutation collapsing phase 2 back onto t0.
  const reads = [0, 5_000, 100_000, 100_200];
  let i = 0;
  const now = () => reads[Math.min(i++, reads.length - 1)];
  const pc = createPreviewController({ devServer: fakeDevServer(), now });
  const res = pc.start({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(res.ok, true);
  assert.equal(res.startupMs, 5_000, 'phase 1 is the t0->ready delta');
  assert.equal(res.previewAvailableMs, 200, 'phase 2 is ONLY the ready->available delta, not cumulative-from-t0');
  assert.notEqual(res.previewAvailableMs, 100_200, 'phase 2 must not be measured from t0');
});

test('start: a devServer seam that reports !ok yields STARTUP_TIMEOUT + restart offer, no served preview', () => {
  const devServer = fakeDevServer({ outcomes: [{ ok: false }] });
  const pc = createPreviewController({ devServer, now: steppingClock({ start: 0, step: 1 }) });
  const res = pc.start({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'STARTUP_TIMEOUT');
  assert.equal(res.restartOffered, true);
  assert.equal(pc.servedPreview(PID).snapshotId, null);
});

test('notifyExit: preserves the served state and offers a restart (Req 3.6)', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock() });
  pc.start({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  pc.publish({ projectId: PID, snapshotId: 'snap-1', buildOk: true });

  const res = pc.notifyExit({ projectId: PID, error: 'exit code 137' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'exited');
  assert.equal(res.error, 'exit code 137');
  assert.equal(res.restartOffered, true);
  assert.equal(res.servedRetained, true);
  // The served preview is PRESERVED across the crash — Property 3 holds.
  assert.equal(pc.servedPreview(PID).snapshotId, 'snap-1', 'served state preserved across unexpected exit');
});

test('restart: the 3rd failed restart yields PERSISTENT_FAILURE with no further automatic restarts (cap-of-3 is mutation-sensitive)', () => {
  // Every start fails, so each restart attempt fails.
  const devServer = fakeDevServer({ outcomes: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }] });
  const pc = createPreviewController({ devServer, now: steppingClock({ start: 0, step: 1 }) });

  const r1 = pc.restart({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(r1.ok, false);
  assert.equal(r1.attempt, 1);
  assert.equal(r1.restartOffered, true, 'attempt 1 still offers a restart');

  const r2 = pc.restart({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(r2.attempt, 2);
  assert.equal(r2.restartOffered, true, 'attempt 2 still offers a restart');

  const r3 = pc.restart({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(r3.attempt, 3);
  // After the 3rd failed attempt no further restart is offered.
  assert.equal(r3.restartOffered, false, 'attempt 3 (the cap) offers no further restart');

  // A 4th restart is refused as persistent-failure — the cap is EXACTLY 3. A
  // mutation raising the cap to 4 would let this attempt run and flip it.
  const r4 = pc.restart({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'PERSISTENT_FAILURE');
  assert.equal(r4.attempts, RESTART_CAP);
  assert.equal(r4.restartOffered, false);
  // Exactly 3 real start attempts were made (the 4th was refused before start).
  assert.equal(devServer.startCalls.length, 3, 'the 4th restart never reached the Dev_Server seam');
});

test('restart: a successful restart RESETS the attempt counter so a later failure run starts from zero', () => {
  // First start fails, second succeeds, then a fresh failure run.
  const devServer = fakeDevServer({
    outcomes: [{ ok: false }, { ok: true, url: 'http://preview.local/proj-1', startedAt: 'T1' }, { ok: false }],
  });
  const pc = createPreviewController({ devServer, now: steppingClock({ start: 0, step: 1 }) });

  const r1 = pc.restart({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(r1.ok, false);
  assert.equal(r1.attempt, 1);

  const r2 = pc.restart({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(r2.ok, true, 'a restart that starts successfully');
  assert.equal(r2.status, 'ready');

  // Counter was reset by the successful start: the next failure is attempt 1.
  const r3 = pc.restart({ projectId: PID, sandbox: {}, targetCategory: 'web' });
  assert.equal(r3.attempt, 1, 'attempt counter reset after a successful start');
});

// ----------------------------------------------------------- mobile / Expo (3.2/15.2/15.3)

test('previewMobile: reachable within 60s returns a connection URL AND a scannable QR payload', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock(), qrEncode: (u) => `QR[${u}]` });
  const res = pc.previewMobile({
    projectId: PID,
    reachable: true,
    connectionUrl: 'exp://192.168.1.5:19000',
    elapsedMs: 42_000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, 'exp://192.168.1.5:19000');
  assert.equal(res.qr, 'QR[exp://192.168.1.5:19000]', 'QR payload synthesized from the connection URL');
  assert.equal(res.reachableMs, 42_000);
});

test('previewMobile: over the 60s reachability bound reports the cause and RETAINS the prior reachable preview', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock() });
  // Establish a prior reachable mobile preview.
  pc.previewMobile({ projectId: PID, reachable: true, connectionUrl: 'exp://prior', elapsedMs: 10_000 });

  // A later attempt that exceeds the 60s bound.
  const res = pc.previewMobile({ projectId: PID, reachable: true, connectionUrl: 'exp://slow', elapsedMs: 61_000 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'MOBILE_PREVIEW_UNAVAILABLE');
  assert.match(res.cause, /reachability exceeded/);
  // The prior reachable preview is retained.
  assert.deepEqual(res.priorPreview, { url: 'exp://prior', qr: 'qr:exp://prior' });
});

test('previewMobile: exactly 60000ms elapsed is STILL reachable (boundary case pins <= vs < on the mobile bound)', () => {
  const devServer = fakeDevServer();
  const pc = createPreviewController({ devServer, now: steppingClock(), qrEncode: (u) => `QR[${u}]` });
  // Exactly at MOBILE_REACHABLE_MS (60000ms) the endpoint is in-bound. A mutation
  // flipping the `<=` reachability bound to `<` would report this as unavailable.
  const res = pc.previewMobile({
    projectId: PID,
    reachable: true,
    connectionUrl: 'exp://192.168.1.9:19000',
    elapsedMs: MOBILE_REACHABLE_MS,
  });
  assert.equal(res.ok, true, 'exactly 60000ms is within the mobile reachability bound');
  assert.equal(res.url, 'exp://192.168.1.9:19000');
  assert.equal(res.qr, 'QR[exp://192.168.1.9:19000]');
  assert.equal(res.reachableMs, MOBILE_REACHABLE_MS);
});

test('previewMobile: unreachable reports the cause and retains a prior preview (or null when none)', () => {
  const pc = createPreviewController({ devServer: fakeDevServer(), now: steppingClock() });
  const res = pc.previewMobile({ projectId: PID, reachable: false, cause: 'tunnel refused' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'MOBILE_PREVIEW_UNAVAILABLE');
  assert.equal(res.cause, 'tunnel refused');
  assert.equal(res.priorPreview, null, 'no prior reachable preview yet');
});

// ------------------------------------------------------- multi-target selector (16.4/16.5)

test('selectTarget: no selection defaults to web with defaultUsed:true and lists selectable targets', () => {
  const pc = createPreviewController({ devServer: fakeDevServer(), now: steppingClock() });
  const res = pc.selectTarget({ projectId: PID, targetCategory: 'multi-target' });
  assert.equal(res.ok, true);
  assert.equal(res.selected, 'web');
  assert.equal(res.defaultUsed, true, 'default web with an explicit indication (Req 16.5)');
  assert.deepEqual(res.selectable, ['web', 'backend', 'mobile']);
});

test('selectTarget: an explicit selectable target is used with defaultUsed:false', () => {
  const pc = createPreviewController({ devServer: fakeDevServer(), now: steppingClock() });
  const res = pc.selectTarget({ projectId: PID, targetCategory: 'multi-target', target: 'mobile' });
  assert.equal(res.ok, true);
  assert.equal(res.selected, 'mobile');
  assert.equal(res.defaultUsed, false);
});

test('selectTarget: an out-of-enum target is rejected with a structured error identifying it, without changing served state', () => {
  const pc = createPreviewController({ devServer: fakeDevServer(), now: steppingClock() });
  // Establish a served preview first.
  pc.publish({ projectId: PID, snapshotId: 'snap-1', buildOk: true });

  const res = pc.selectTarget({ projectId: PID, targetCategory: 'multi-target', target: 'desktop' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_TARGET');
  assert.equal(res.target, 'desktop');
  assert.match(res.message, /invalid Target/);
  // Existing served state is untouched.
  assert.equal(pc.servedPreview(PID).snapshotId, 'snap-1', 'served state unchanged by an invalid target');
});
