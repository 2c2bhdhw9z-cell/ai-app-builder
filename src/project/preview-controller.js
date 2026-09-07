/**
 * preview-controller.js — the PreviewController (spec Task 18.1 + 18.2, Req 3.1,
 * 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 1.3, 15.2, 15.3, 16.4, 16.5; design §4 "Preview
 * pipeline", decision (d) "Preview vs. Snapshot timing", Property 3).
 *
 * The PreviewController is the first-class, lifecycle-managed Preview SURFACE. It
 * layers ON TOP OF the existing Dev_Server launch seam (src/project/dev-server.js)
 * and — in production — the project's Sandbox (src/sandbox/sandbox-manager.js): a
 * Dev_Server runs INSIDE the project's Isolation_Boundary and the served Preview
 * is what the user is told is "the app". This module owns four things:
 *
 *   1. publish-on-commit web semantics (Req 3.1, 3.3, 3.4; decision (d);
 *      Property 3): the SERVED preview ALWAYS corresponds to the most-recent
 *      SUCCESSFULLY-BUILT COMMITTED Snapshot, never to uncommitted intermediate
 *      state. publish({...}) is the ONLY transition that changes served state.
 *   2. Dev_Server lifecycle (Req 3.5, 3.6, 3.7, 1.3): a preview-loading status
 *      while starting, a 60s startup-timeout with a restart offer, unexpected-
 *      exit handling that preserves state and offers restart, and a restart cap
 *      of exactly 3 attempts before a persistent-failure error with no further
 *      automatic restarts.
 *   3. mobile/Expo preview (Req 3.2, 15.2, 15.3): a reachable-within-60s Expo
 *      endpoint exposing a connection URL AND a scannable QR-code payload, and
 *      on unreachability a reported cause while any prior reachable preview is
 *      RETAINED.
 *   4. a multi-target selector (Req 16.4, 16.5): defaults to `web` with an
 *      explicit defaultUsed:true indication, previews only the single selected
 *      Target, and rejects an out-of-enum Target with a structured error.
 *
 * WHY THIS IS ONLY A SEAM HERE (offline-environment constraint — stated
 * explicitly): a REAL long-running Dev_Server process, a REAL container, a REAL
 * served in-browser web Preview, and a REAL Expo/mobile endpoint CANNOT run in
 * this offline / repository-access-only environment (no docker daemon, no image
 * pulls, no live processes, no reachable ports, no external HTTP). So this module
 * LAUNCHES NOTHING real: it delegates process management to the INJECTED
 * `devServer` seam, and ALL wall-clock bounds — the <=5s publish-update SLO
 * (Req 3.3), the <=60s Dev_Server startup bound (Req 3.5), the <=60s
 * preview-available bound measured FROM Dev_Server start (Req 1.3), and the <=60s
 * mobile-reachability bound (Req 15.2) — are MEASURED against an INJECTED CLOCK,
 * never real waits. The QR-code payload is a deterministic string synthesized
 * from the connection URL, NOT a live endpoint. This is the tested Preview
 * CONTRACT + lifecycle surface; actually serving it live is a deployment step on
 * a container-capable host and is out of scope for this environment.
 *
 * TWO SEQUENTIAL PHASES (design clarification, NOT one 60s window): phase 1 is
 * the Dev_Server becoming ready (<=60s, or a startup-timeout, Req 3.5), measured
 * from t0 to the ready instant; phase 2, measured FROM that Dev_Server-ready
 * instant (a distinct origin, NOT t0), is the Preview becoming available (<=60s,
 * Req 1.3). start(...) captures an intermediate readiness timestamp so the two
 * phases are genuine sequential deltas, and exposes BOTH measured elapsed values
 * so each SLO is independently observable and testable.
 *
 * THE PLUMBY BOUNDARY: this module NEVER imports the plumby package. It only
 * touches the Dev_Server / Sandbox seams and closed enums.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock and every collaborator; structured { ok:false, code, message }
 * results for expected rejections rather than throwing.
 */

import { requireString, fail } from '../model/validate.js';
import { Target, isValidTarget } from '../model/enums.js';

/** The <=5s publish-update SLO (Req 3.3), in ms. Measured against the clock. */
export const PUBLISH_SLO_MS = 5_000;

/** The <=60s Dev_Server startup bound (Req 3.5), in ms. */
export const STARTUP_TIMEOUT_MS = 60_000;

/** The <=60s "Preview available after Dev_Server start" bound (Req 1.3), in ms. */
export const PREVIEW_AVAILABLE_MS = 60_000;

/** The <=60s Expo/mobile reachability bound (Req 15.2), in ms. */
export const MOBILE_REACHABLE_MS = 60_000;

/** The restart cap: exactly 3 attempts before persistent-failure (Req 3.7). */
export const RESTART_CAP = 3;

/** The default multi-target Target when the user selects none (Req 16.5). */
export const DEFAULT_TARGET = 'web';

/**
 * Create a PreviewController.
 *
 * @param {object} args
 * @param {object} args.devServer  the Dev_Server seam (src/project/dev-server.js)
 *        with start({projectId,sandbox,targetCategory})->{ok,url?,startedAt?},
 *        stop(projectId)->{ok,stopped}, isRunning(projectId). REQUIRED — the
 *        controller launches nothing itself; it delegates to this seam.
 * @param {object} [args.sandboxManager]  OPTIONAL SandboxManager; the Dev_Server
 *        runs inside the project's Sandbox in production. Reserved here (the seam
 *        already receives the sandbox handle); never used to launch anything.
 * @param {() => number} [args.now]  injectable ms clock for every SLO. Default
 *        Date.now. NEVER a real wait — bounds are measured against this clock.
 * @param {(url:string)=>string} [args.qrEncode]  injectable QR-payload
 *        synthesizer for the mobile connection URL. Default: a deterministic
 *        `qr:<url>` string (a seam, NOT a live/scanned endpoint).
 * @returns {object} controller (frozen)
 */
export function createPreviewController({
  devServer,
  sandboxManager,
  now = () => Date.now(),
  qrEncode = (url) => `qr:${url}`,
} = {}) {
  const model = 'PreviewController';
  if (!devServer || typeof devServer.start !== 'function') {
    fail(model, 'devServer with start(...) is required');
  }
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');
  if (typeof qrEncode !== 'function') fail(model, 'qrEncode must be a function');

  /**
   * Per-project served-preview state. Each entry tracks the committed Snapshot
   * the served preview points at, plus lifecycle bookkeeping. Keyed by projectId.
   * SEAM-ONLY: this is pure in-memory bookkeeping — nothing is served.
   *
   * Shape:
   *   {
   *     served: { snapshotId, url, publishedAt } | null  // last GOOD published state
   *     building: { snapshotId?, since } | null          // labeled in-progress edit
   *     buildError: string | null                        // captured error of a failed build
   *     showingPrior: boolean                            // served points at a PRIOR snapshot
   *     devServer: { url, startedAt } | null             // the running Dev_Server handle
   *     restartAttempts: number                          // failed-restart run count (cap 3)
   *     mobile: { url, qr, reachableAt } | null          // last reachable mobile preview
   *     selectedTarget: string | null                    // multi-target selection
   *   }
   */
  const state = new Map();

  /** Get (creating if absent) the per-project preview state. */
  function stateFor(projectId) {
    let s = state.get(projectId);
    if (!s) {
      s = {
        served: null,
        building: null,
        buildError: null,
        showingPrior: false,
        devServer: null,
        restartAttempts: 0,
        mobile: null,
        selectedTarget: null,
      };
      state.set(projectId, s);
    }
    return s;
  }

  // ------------------------------------------------------------ publish-on-commit

  /**
   * markBuilding({ projectId, snapshotId? }) — label an uncommitted / in-progress
   * edit as "building" (decision (d), step 1). This NEVER changes the served
   * preview: uncommitted intermediate state is exposed only as a labeled
   * in-progress status via servedPreview().building, never as served content.
   * Property 3 depends on this being the ONLY way in-progress edits surface.
   *
   * @returns {{ ok:true, status:'building' }}
   */
  function markBuilding({ projectId, snapshotId } = {}) {
    requireString(model, 'projectId', projectId);
    const s = stateFor(projectId);
    s.building = { snapshotId: typeof snapshotId === 'string' ? snapshotId : undefined, since: now() };
    return { ok: true, status: 'building' };
  }

  /**
   * publish({ projectId, snapshotId, buildOk }) — the ONLY transition that
   * changes served state (decision (d), Property 3, Req 3.3, 3.4).
   *
   *   - buildOk === true: point the served preview at THIS committed Snapshot,
   *     record the publish time (the <=5s update SLO is measured against the
   *     injected clock), clear any prior build error / showingPrior flag, and
   *     clear the in-progress "building" label. This is the only point at which
   *     the served content is asserted to reflect "current committed state".
   *     HONESTY of the served URL: the url reflects the ACTUAL running Dev_Server
   *     handle (s.devServer?.url) when one exists. When publish runs BEFORE any
   *     start (no running handle), the committed snapshot is still published (the
   *     served snapshotId advances exactly as before — Property 3), but url stays
   *     null and status is 'committed' rather than 'served', so the surface never
   *     claims a live URL for a Dev_Server that is not running. The production
   *     ordering (finalizePass starts THEN publishes) is unaffected: with a
   *     running handle the real url is used and status is 'served'.
   *   - buildOk === false: a committed Snapshot FAILED to build (Req 3.4). RETAIN
   *     the last successfully-built served preview, record the captured build
   *     error, and mark showingPrior:true so the surface indicates a PRIOR state
   *     is shown. The served snapshotId is NOT advanced to the broken commit.
   *
   * @param {object} args
   * @param {string} args.projectId
   * @param {string} args.snapshotId  the committed Snapshot id
   * @param {boolean} args.buildOk     did the committed Snapshot build successfully?
   * @param {string} [args.buildError] captured build error output (used when !buildOk)
   * @returns {{ ok:true, snapshotId, url, status, publishMs, showingPrior?, buildError? }
   *          | { ok:false, code, message }}
   */
  function publish({ projectId, snapshotId, buildOk, buildError } = {}) {
    requireString(model, 'projectId', projectId);
    requireString(model, 'snapshotId', snapshotId);
    if (typeof buildOk !== 'boolean') {
      return { ok: false, code: 'BUILD_OK_REQUIRED', message: 'buildOk must be a boolean' };
    }
    const s = stateFor(projectId);
    const at = now();

    if (buildOk) {
      // Successful build: publish the committed Snapshot as the served preview.
      // The served URL is HONEST: it reflects the actual running Dev_Server handle
      // when one exists, and stays null when publish runs before any start so we
      // never advertise a live URL for a Dev_Server that is not running. The
      // committed snapshotId advances either way (Property 3 is about snapshot
      // identity, not URL); only the url/status differ.
      const url = s.devServer?.url ?? null;
      const status = url !== null ? 'served' : 'committed';
      s.served = { snapshotId, url, publishedAt: at };
      s.buildError = null;
      s.showingPrior = false;
      // The freshly-committed state is now served, so it is no longer "building".
      s.building = null;
      const publishMs = now() - at;
      return { ok: true, snapshotId, url, status, publishMs, showingPrior: false };
    }

    // Failed build: RETAIN the last successfully-built preview, capture the
    // error, indicate a prior state is shown (Req 3.4). Do NOT advance served.
    s.buildError = typeof buildError === 'string' ? buildError : 'committed snapshot failed to build';
    // showingPrior is true only when there IS a prior good preview to show.
    s.showingPrior = s.served !== null;
    const publishMs = now() - at;
    return {
      ok: true,
      snapshotId: s.served ? s.served.snapshotId : null,
      url: s.served ? s.served.url : null,
      status: s.served ? 'showing-prior' : 'no-preview',
      publishMs,
      showingPrior: s.showingPrior,
      buildError: s.buildError,
    };
  }

  /**
   * servedPreview(projectId) — the current served-preview view. The `snapshotId`
   * ALWAYS points at a successfully-built COMMITTED Snapshot (or null before any
   * successful publish); it is NEVER an uncommitted/in-progress edit — that only
   * appears under `building`. Property 3 is asserted against this method.
   *
   * The `status` is HONEST about whether a live Dev_Server is serving the
   * committed snapshot: 'served' when a running handle URL backs it, 'committed'
   * when the snapshot is published but no Dev_Server is running yet (url null),
   * and 'showing-prior' when a broken commit sits atop a prior good preview.
   *
   * @returns {{ snapshotId:string|null, url:string|null, status:string,
   *            showingPrior:boolean, buildError:string|null, building:object|null }}
   */
  function servedPreview(projectId) {
    requireString(model, 'projectId', projectId);
    const s = state.get(projectId);
    if (!s || !s.served) {
      return {
        snapshotId: null,
        url: null,
        status: s && s.buildError ? 'no-preview' : 'none',
        showingPrior: false,
        buildError: s ? s.buildError : null,
        building: s ? s.building : null,
      };
    }
    return {
      snapshotId: s.served.snapshotId,
      url: s.served.url,
      status: s.showingPrior ? 'showing-prior' : s.served.url !== null ? 'served' : 'committed',
      showingPrior: s.showingPrior,
      buildError: s.buildError,
      building: s.building,
    };
  }

  // --------------------------------------------------------- Dev_Server lifecycle

  /**
   * start({ projectId, sandbox, targetCategory }) — start the Dev_Server via the
   * injected seam and measure the two SEQUENTIAL phases (Req 3.5, 1.3):
   *
   *   phase 1 (startupMs): Dev_Server becoming ready. Measured against the
   *     injected clock. If the seam does not report a started handle within the
   *     60s startup bound, return a startup-timeout error WITH a restart offer
   *     and do NOT expose a broken preview (Req 3.5).
   *   phase 2 (previewAvailableMs): the Preview becoming available, measured FROM
   *     the Dev_Server-ready instant (NOT from t0), bounded at 60s (Req 1.3).
   *     We capture an intermediate readiness timestamp (readyAt) once the seam
   *     reports ready and compute previewAvailableMs = now() - readyAt, so the
   *     two phases are true SEQUENTIAL deltas from different origins rather than
   *     two cumulative-from-t0 values. Exposed as its own value so it is not
   *     collapsed into phase 1.
   *
   * While starting, the reported status is 'preview-loading' (Req 3.5); once the
   * seam reports started it becomes 'ready'. A successful start RESETS the
   * restart-attempt counter (a fresh failure run starts from zero).
   *
   * @returns {{ ok:true, status:'ready', url, startupMs, previewAvailableMs }
   *          | { ok:false, code:'STARTUP_TIMEOUT', message, restartOffered:true, startupMs }
   *          | { ok:false, code, message, restartOffered?:true }}
   */
  function start({ projectId, sandbox, targetCategory } = {}) {
    requireString(model, 'projectId', projectId);
    const s = stateFor(projectId);
    const t0 = now();
    // Status while starting (Req 3.5): preview-loading. (Observable via the seam
    // and the returned shape; nothing real is launched.)
    let started;
    try {
      started = devServer.start({ projectId, sandbox, targetCategory });
    } catch (err) {
      return {
        ok: false,
        code: 'DEV_SERVER_START_FAILED',
        message: err?.message ?? String(err),
        restartOffered: true,
      };
    }
    // Phase 1: readiness elapsed, measured against the injected clock.
    const startupMs = now() - t0;

    // If the seam did not produce a started handle, or readiness exceeded the
    // 60s startup bound, surface a startup-timeout error + a restart offer and do
    // NOT expose a preview (Req 3.5).
    if (!started || started.ok !== true || startupMs > STARTUP_TIMEOUT_MS) {
      return {
        ok: false,
        code: 'STARTUP_TIMEOUT',
        message:
          !started || started.ok !== true
            ? `Dev_Server did not become ready for project ${projectId}`
            : `Dev_Server startup exceeded ${STARTUP_TIMEOUT_MS}ms for project ${projectId}`,
        restartOffered: true,
        startupMs,
      };
    }

    // Ready. Capture the readiness instant so phase 2 is measured FROM it (not
    // from t0). Record the running handle. Phase 2 (preview-available) is the
    // delta from Dev_Server-ready to preview-available, exposed as its own value
    // so the SLO stays observable and independent of phase 1.
    const readyAt = now();
    s.devServer = { url: started.url ?? `http://preview.local/${projectId}`, startedAt: started.startedAt ?? null };
    s.restartAttempts = 0;
    const previewAvailableMs = now() - readyAt;
    return {
      ok: true,
      status: 'ready',
      url: s.devServer.url,
      startupMs,
      previewAvailableMs,
    };
  }

  /**
   * notifyExit({ projectId, error }) — model an UNEXPECTED Dev_Server exit
   * (Req 3.6): surface the captured error, PRESERVE the current served state
   * (the served preview is NOT cleared — Property 3 still holds across a crash),
   * and offer a restart. Forgets only the running Dev_Server handle.
   *
   * @returns {{ ok:true, status:'exited', error, restartOffered:true, servedRetained:boolean }}
   */
  function notifyExit({ projectId, error } = {}) {
    requireString(model, 'projectId', projectId);
    const s = stateFor(projectId);
    const hadServed = s.served !== null;
    s.devServer = null; // the process is gone; served state is preserved.
    // HONESTY of the served URL, same rule publish() applies: the committed
    // snapshot is RETAINED (Property 3 is about snapshot identity), but the URL it
    // was served at no longer answers, so we stop advertising it. servedPreview
    // therefore reports 'committed' with url:null rather than 'served' — otherwise
    // a crashed Dev_Server left the surface claiming a live preview forever, which
    // is exactly the dishonesty the placeholder URL was faulted for.
    if (s.served) s.served.url = null;
    return {
      ok: true,
      status: 'exited',
      error: typeof error === 'string' ? error : (error?.message ?? 'Dev_Server exited unexpectedly'),
      restartOffered: true,
      servedRetained: hadServed,
    };
  }

  /**
   * restart({ projectId, sandbox, targetCategory }) — attempt to restart the
   * Dev_Server (Req 3.7). Attempts are capped at exactly RESTART_CAP (3) across a
   * failure run:
   *
   *   - Each call increments the per-project attempt counter FIRST. If the
   *     counter would exceed 3 (i.e. this is the 4th attempt), refuse with a
   *     persistent-failure error and stop offering further AUTOMATIC restarts —
   *     no start is attempted.
   *   - Otherwise delegate to start(...). A SUCCESSFUL start resets the counter
   *     (a later failure run begins from zero). A FAILED start leaves the counter
   *     advanced; after the 3rd failed attempt the counter is at 3, so the next
   *     restart hits the cap and returns persistent-failure.
   *
   * @returns {{ ok:true, status:'ready', attempt:number, url }
   *          | { ok:false, code:'PERSISTENT_FAILURE', message, attempts:number, restartOffered:false }
   *          | { ok:false, code, message, attempt:number, restartOffered:boolean }}
   */
  function restart({ projectId, sandbox, targetCategory } = {}) {
    requireString(model, 'projectId', projectId);
    const s = stateFor(projectId);

    // Cap check: after 3 failed attempts, refuse further automatic restarts.
    if (s.restartAttempts >= RESTART_CAP) {
      return {
        ok: false,
        code: 'PERSISTENT_FAILURE',
        message: `Dev_Server failed to restart after ${RESTART_CAP} attempts for project ${projectId}; no further automatic restarts`,
        attempts: s.restartAttempts,
        restartOffered: false,
      };
    }

    s.restartAttempts += 1;
    const attempt = s.restartAttempts;
    const res = start({ projectId, sandbox, targetCategory });
    if (res.ok) {
      // start() already reset the counter to 0 on success.
      return { ok: true, status: 'ready', attempt, url: res.url };
    }
    // Failed attempt: counter stays advanced. Only offer another restart while
    // under the cap; once the counter reaches the cap, the NEXT call is refused.
    return {
      ok: false,
      code: res.code ?? 'RESTART_FAILED',
      message: res.message ?? 'Dev_Server restart failed',
      attempt,
      restartOffered: s.restartAttempts < RESTART_CAP,
    };
  }

  // ------------------------------------------------------------- mobile / Expo

  /**
   * previewMobile({ projectId, reachable, connectionUrl }) — expose an
   * Expo-compatible mobile Preview (Req 3.2, 15.2, 15.3). Reachability is a SEAM:
   * the caller injects whether the endpoint became reachable within the bound
   * (there is no real endpoint offline) and, when reachable, the connection URL.
   *
   *   - reachable within the 60s bound: return the connection URL AND a scannable
   *     QR-code payload synthesized from that URL (a deterministic seam string,
   *     NOT a live endpoint), record it as the last reachable mobile preview, and
   *     report the reachability elapsed measured against the injected clock.
   *   - unreachable (or over the 60s bound): report the preview unavailability
   *     WITH its cause and RETAIN any prior reachable mobile preview (Req 15.3).
   *
   * @param {object} args
   * @param {string} args.projectId
   * @param {boolean} args.reachable       did the Expo endpoint become reachable?
   * @param {string} [args.connectionUrl]  the Expo connection URL (when reachable)
   * @param {number} [args.elapsedMs]      injected reachability elapsed (bound check)
   * @param {string} [args.cause]          cause of unreachability (when !reachable)
   * @returns {{ ok:true, url, qr, reachableMs }
   *          | { ok:false, code, message, cause, priorPreview:object|null }}
   */
  function previewMobile({ projectId, reachable, connectionUrl, elapsedMs, cause } = {}) {
    requireString(model, 'projectId', projectId);
    const s = stateFor(projectId);
    const reachMs = typeof elapsedMs === 'number' ? elapsedMs : 0;

    if (reachable === true && reachMs <= MOBILE_REACHABLE_MS) {
      const url = typeof connectionUrl === 'string' && connectionUrl.trim() !== ''
        ? connectionUrl
        : `exp://preview.local/${projectId}`;
      const qr = qrEncode(url);
      s.mobile = { url, qr, reachableAt: now() };
      return { ok: true, url, qr, reachableMs: reachMs };
    }

    // Unreachable (or over bound): report the cause, RETAIN any prior reachable
    // mobile preview unchanged.
    const why = typeof cause === 'string' && cause.trim() !== ''
      ? cause
      : reachable === true
        ? `Expo endpoint reachability exceeded ${MOBILE_REACHABLE_MS}ms`
        : 'Expo endpoint did not become reachable';
    return {
      ok: false,
      code: 'MOBILE_PREVIEW_UNAVAILABLE',
      message: `mobile Preview unavailable for project ${projectId}: ${why}`,
      cause: why,
      priorPreview: s.mobile ? { url: s.mobile.url, qr: s.mobile.qr } : null,
    };
  }

  // --------------------------------------------------------- multi-target selector

  /**
   * selectTarget({ projectId, targetCategory, target? }) — the multi-target
   * Preview selector (Req 16.4, 16.5, 16.8 spirit). For a `multi-target` project
   * it lists the selectable Targets (`web`, `mobile`, `backend`) and previews
   * only the single selected Target:
   *
   *   - no target selected: default to `web` and set defaultUsed:true (Req 16.5).
   *   - an explicit selectable target: use it, defaultUsed:false (Req 16.4).
   *   - a target outside the closed Target enum: reject with a structured error
   *     identifying the invalid target, WITHOUT modifying existing served state
   *     (Req 16.8 spirit).
   *
   * @returns {{ ok:true, selected:string, defaultUsed:boolean, selectable:string[] }
   *          | { ok:false, code:'INVALID_TARGET', message, target }}
   */
  function selectTarget({ projectId, targetCategory, target } = {}) {
    requireString(model, 'projectId', projectId);
    const s = stateFor(projectId);
    // The Targets a multi-target Preview offers (Req 16.4): web/mobile/backend
    // (the `shared` Target is not independently previewable).
    const selectable = Target.filter((t) => t !== 'shared');

    // No selection: default to `web` with an explicit indication (Req 16.5).
    if (target === undefined || target === null) {
      s.selectedTarget = DEFAULT_TARGET;
      return { ok: true, selected: DEFAULT_TARGET, defaultUsed: true, selectable };
    }

    // A target outside the closed Target enum: reject WITHOUT touching served
    // state (Req 16.8 spirit).
    if (!isValidTarget(target)) {
      return {
        ok: false,
        code: 'INVALID_TARGET',
        message: `invalid Target ${JSON.stringify(target)}: must be one of [${Target.join(', ')}]`,
        target,
      };
    }

    s.selectedTarget = target;
    return { ok: true, selected: target, defaultUsed: false, selectable };
  }

  return Object.freeze({
    markBuilding,
    publish,
    servedPreview,
    start,
    notifyExit,
    restart,
    previewMobile,
    selectTarget,
    PUBLISH_SLO_MS,
    STARTUP_TIMEOUT_MS,
    PREVIEW_AVAILABLE_MS,
    MOBILE_REACHABLE_MS,
    RESTART_CAP,
  });
}
