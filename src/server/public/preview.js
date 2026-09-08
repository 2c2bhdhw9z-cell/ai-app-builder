/*
 * preview.js — the Preview_Pane controller + preview lifecycle helpers
 * (spec Task 5.1; design §"Controllers — preview.js", Req 4.1–4.6).
 *
 * This is the feature logic that turns preview_status frames (delivered over
 * SSE by frames.js, or synthesized from the 5s liveness poll by
 * preview-poll.js) into the store's preview slice, and that drives the restart
 * control. The heavy lifting — the ready-empty-url RETAIN rule (Req 4.2), the
 * loading SUPPRESSION rule (Req 4.3), the failure cause-iff-present rule
 * (Req 4.4/4.5), and carrying restartOffered (Req 4.6) — lives in the store's
 * PURE `PREVIEW_STATUS_SET` reducer so it is property-testable without a DOM.
 * This module is the thin controller around it plus:
 *
 *   1. `previewFromServed(served)` — a PURE projection of the raw GET /preview
 *      served handle (`{ snapshotId, url, status, showingPrior, buildError,
 *      building, mobile }`, whose `status` uses the SERVED vocabulary
 *      'none'|'served'|'committed'|'showing-prior'|'no-preview') onto the
 *      CLIENT preview_status shape (`{ status, url?, snapshotId?, showingPrior?,
 *      cause?, source }`). It mirrors the server's own `previewStatusFrame`
 *      mapping so the poll and the SSE frame agree, and tags itself
 *      `source:'poll'` so a poll-driven failure is attributable (Req 4.8).
 *      It ALSO reports `isLive` so the poller knows when to drive a failure.
 *
 *   2. `createPreviewController({ store, api })` — exposes `restart()` which
 *      issues `POST /preview/restart` for the open session through the gated
 *      api client (Req 4.6), and `applyServed(served)` used by the poller.
 *
 * DOM-free and dependency-free vanilla ES module code: it imports only the
 * store's action names + selectors, so it runs verbatim under `node --test`,
 * adds no runtime dependency, and never touches plumby. The view
 * (views/preview-pane.js) reads the store slice this controller mutates.
 */

import { ACTIONS, selectPreview } from './store.js';

/**
 * The SERVED-preview status values that mean a LIVE, in-browser preview is
 * genuinely being served (a running Dev_Server handle backs a URL). Anything
 * else the poll sees is treated as NON-LIVE and drives a failure indication
 * (Req 4.8). 'served' is the only genuinely-live served status; 'committed'
 * (published but no running handle yet) is honestly not-yet-live but is NOT a
 * failure — it maps to 'loading', so it is excluded from the failure set below.
 * @type {ReadonlySet<string>}
 */
const LIVE_SERVED_STATUS = new Set(['served']);

/**
 * The SERVED statuses that are NOT-YET-live but are also NOT a failure (so a
 * poll seeing them must not fabricate a failure). 'committed' is a published
 * snapshot with no running Dev_Server yet; 'none' is simply "nothing published
 * yet". Both map to a benign 'loading' rather than an error.
 * @type {ReadonlySet<string>}
 */
const BENIGN_SERVED_STATUS = new Set(['committed', 'none']);

/**
 * Project the raw GET /preview served handle onto the client preview_status
 * shape, tagging the source. PURE and exported so the poll's property test
 * drives the REAL projection. Mirrors the server's `previewStatusFrame`:
 *   served 'served'        -> 'ready'   (live; carries the running url)
 *   served 'showing-prior' -> 'showing_prior'
 *   served 'no-preview'    -> 'error'
 *   served 'committed'|'none'|other -> 'loading'
 *
 * @param {{ snapshotId?:string|null, url?:string|null, status?:string,
 *           showingPrior?:boolean, buildError?:string|null,
 *           mobile?:{ url?:string }|null } | null | undefined} served
 * @param {'poll'|'sse'} [source='poll']
 * @returns {{ status:string, url?:string, snapshotId?:string, showingPrior?:boolean,
 *            cause?:string, source:string, isLive:boolean, mobileUrl:(string|null) }}
 */
export function previewFromServed(served, source = 'poll') {
  const s = served && typeof served === 'object' ? served : {};
  const servedStatus = typeof s.status === 'string' ? s.status : 'none';

  let status;
  if (servedStatus === 'served') status = 'ready';
  else if (servedStatus === 'showing-prior') status = 'showing_prior';
  else if (BENIGN_SERVED_STATUS.has(servedStatus)) status = 'loading';
  else status = 'error'; // no-preview, exited, or any other non-live status → failure

  const out = { status, source, isLive: LIVE_SERVED_STATUS.has(servedStatus) };

  if (typeof s.url === 'string') out.url = s.url;
  if (typeof s.snapshotId === 'string') out.snapshotId = s.snapshotId;
  if (s.showingPrior === true) out.showingPrior = true;

  // A build error becomes the SAFE single-line cause summary (the raw handle
  // returned to the owner may carry a fuller buildError; we collapse it here so
  // the client never renders a multi-line/stacky cause). Only non-empty.
  if (typeof s.buildError === 'string' && s.buildError.trim() !== '') {
    out.cause = safeCause(s.buildError);
  }

  // Mobile connection detail, when the served handle supplies one.
  out.mobileUrl =
    s.mobile && typeof s.mobile === 'object' && typeof s.mobile.url === 'string' && s.mobile.url.trim() !== ''
      ? s.mobile.url
      : null;

  return out;
}

/**
 * Whether a served handle represents a NON-LIVE preview that a poll must
 * surface as a failure (Req 4.8). A live 'served' handle is live; the benign
 * not-yet ('committed'/'none') statuses are NOT failures; everything else
 * (no-preview, showing-prior, exited, …) is a non-live failure.
 * @param {{ status?:string }|null|undefined} served
 * @returns {boolean}
 */
export function isNonLiveServed(served) {
  const st = served && typeof served.status === 'string' ? served.status : 'none';
  if (LIVE_SERVED_STATUS.has(st)) return false;
  if (BENIGN_SERVED_STATUS.has(st)) return false;
  return true;
}

/**
 * Reduce an arbitrary cause string to a bounded, single-line SAFE summary
 * (mirrors the server's safePreviewCause). Collapses whitespace/newlines and
 * caps length so a raw multi-line cause never reaches the DOM verbatim.
 * @param {unknown} cause
 * @returns {string}
 */
export function safeCause(cause) {
  const oneLine = String(cause ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

/**
 * Create the preview controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function }} deps.store  the REAL store
 * @param {{ request: Function }} deps.api  the gated api client (Task 2.2)
 * @returns {{
 *   applyFrame: (frame: object) => void,
 *   applyServed: (served: object) => void,
 *   setMobileUrl: (url: string) => void,
 *   restart: () => Promise<{ kind: string, [k: string]: any }>,
 * }}
 */
export function createPreviewController({ store, api } = {}) {
  if (!store || typeof store.dispatch !== 'function') {
    throw new TypeError('createPreviewController requires a store with dispatch');
  }

  /**
   * Apply a raw preview_status frame (already parsed) to the store. Provided so
   * a controller-driven path (not just frames.js) can update preview state; the
   * store reducer owns the lifecycle semantics.
   * @param {object} frame  a preview_status-shaped object
   */
  function applyFrame(frame) {
    const f = frame && typeof frame === 'object' ? frame : {};
    store.dispatch({
      type: ACTIONS.PREVIEW_STATUS_SET,
      preview: {
        status: f.status,
        ...('url' in f ? { url: f.url } : {}),
        ...('snapshotId' in f ? { snapshotId: f.snapshotId } : {}),
        showingPrior: f.showingPrior === true,
        cause: typeof f.cause === 'string' ? f.cause : null,
        restartOffered: f.restartOffered === true,
        source: f.source === 'poll' ? 'poll' : 'sse',
      },
    });
    if (typeof f.mobileUrl === 'string') setMobileUrl(f.mobileUrl);
  }

  /**
   * Apply a raw GET /preview served handle to the store (used by the poller).
   * A NON-LIVE served handle drives a failure indication tagged source:'poll'
   * (Req 4.8); a live/benign handle updates the mirrored status. Returns the
   * projection so the poller can decide/log.
   * @param {object} served  the `preview` field of the GET /preview response
   */
  function applyServed(served) {
    const projected = previewFromServed(served, 'poll');
    applyFrame(projected);
    if (projected.mobileUrl) setMobileUrl(projected.mobileUrl);
    return projected;
  }

  /** Set the mobile connection URL (Req 4.10). Empty clears it. */
  function setMobileUrl(url) {
    store.dispatch({ type: ACTIONS.PREVIEW_MOBILE_SET, url: typeof url === 'string' ? url : '' });
  }

  /**
   * Activate the restart control: issue POST /preview/restart for the open
   * session through the gated api client (Req 4.6). The Bearer is attached by
   * the api client; the resulting lifecycle frame is broadcast by the server on
   * the SAME SSE stream, so the store's preview slice updates through the normal
   * frame path — this method only fires the request and returns its ApiResult.
   * @returns {Promise<{ kind: string, [k: string]: any }>}
   */
  async function restart() {
    const state = store.getState();
    const projectId = state.session.projectId;
    if (typeof projectId !== 'string' || projectId === '') {
      return { kind: 'error' };
    }
    return api.request('POST', '/preview/restart', { body: { projectId }, timeoutMs: 5_000 });
  }

  return { applyFrame, applyServed, setMobileUrl, restart };
}

/**
 * Pure view-model over the preview slice for the Preview_Pane view. Decides
 * what the view renders WITHOUT a DOM so it is unit/property-testable:
 *   - `showIframe`  : a same-origin <iframe> is shown iff status is 'ready' with
 *                     a non-empty url (Req 4.1). Never while loading (Req 4.3).
 *   - `showLoading` : the loading indicator is shown while status is 'loading'
 *                     (Req 4.3) — and it SUPPRESSES the iframe.
 *   - `showPrior`   : the showing-prior indicator (Req 4.4).
 *   - `showFailure` : an error / persistent_failure indication (Req 4.5).
 *   - `cause`       : the safe cause summary, shown iff non-empty (Req 4.4/4.5).
 *   - `urlUnavailable` : the ready-url-unavailable error (Req 4.2).
 *   - `showRestart` : the restart control, shown iff restartOffered (Req 4.6).
 *   - `mobileUrl`   : the mobile connection URL, when present (Req 4.10).
 *
 * @param {object} state
 * @returns {{ status:string, url:(string|null), showIframe:boolean,
 *   showLoading:boolean, showPrior:boolean, showFailure:boolean,
 *   cause:(string|null), urlUnavailable:boolean, showRestart:boolean,
 *   mobileUrl:(string|null) }}
 */
export function previewViewModel(state) {
  const p = selectPreview(state);
  const isReady = p.status === 'ready';
  const hasUrl = typeof p.url === 'string' && p.url !== '';
  const showLoading = p.status === 'loading';
  return {
    status: p.status,
    url: p.url,
    // Req 4.1/4.3: the iframe shows only for a ready+url state, and loading
    // suppresses it.
    showIframe: isReady && hasUrl && !showLoading,
    showLoading,
    showPrior: p.status === 'showing_prior',
    showFailure: p.status === 'error' || p.status === 'persistent_failure',
    // Req 4.4/4.5: the cause summary is shown iff a non-empty one is present.
    cause: typeof p.cause === 'string' && p.cause !== '' ? p.cause : null,
    urlUnavailable: p.urlUnavailable === true,
    showRestart: p.restartOffered === true,
    mobileUrl: p.mobile && typeof p.mobile.url === 'string' && p.mobile.url !== '' ? p.mobile.url : null,
  };
}
