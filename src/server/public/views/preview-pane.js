/*
 * views/preview-pane.js — the Preview_Pane view (spec Task 5.3; design
 *  §"Views — views/preview-pane.js", Req 4.1–4.6, 4.10, 4.11).
 *
 * A thin DOM renderer over the store's preview slice (mutated by the preview
 * controller / poller through the pure PREVIEW_STATUS_SET reducer). It shows:
 *   - a SAME-ORIGIN <iframe> for a ready preview URL (Req 4.1). The app document
 *     itself is not embeddable (frame-ancestors 'none' / X-Frame-Options DENY),
 *     but a same-origin <iframe> INSIDE the app pointing at a same-origin
 *     preview URL is allowed by default-src/frame-src 'self' (Req 4.11);
 *   - a loading indicator while status is 'loading', which SUPPRESSES the iframe
 *     (Req 4.3);
 *   - a showing-prior indicator + safe cause summary iff present (Req 4.4);
 *   - an error / persistent-failure indication + safe cause iff present (Req 4.5);
 *   - a "ready URL unavailable" error when a ready frame had no usable url,
 *     while the prior state is retained by the reducer (Req 4.2);
 *   - a restart control shown iff the frame reported restartOffered, which calls
 *     the injected controller.restart() → POST /preview/restart (Req 4.6);
 *   - for a mobile Target, the connection URL as SELECTABLE text plus a
 *     scannable QR rendered as an inline `data:` image (CSP img-src 'self' data:
 *     -legal), synthesized by qr.js — no external QR service, no dependency
 *     (Req 4.10).
 *
 * CSP hygiene (Req 1.4): every node is built with the DOM API — NO innerHTML,
 * NO inline handlers, NO inline <style>. The QR image `src` is a `data:` URI,
 * which img-src 'self' data: permits. The pure view-model (previewViewModel in
 * preview.js) is exported there for DOM-free testing.
 */

import { previewViewModel } from '../preview.js';
import { encodeQrDataUri } from '../qr.js';

/** Stable DOM ids/classes so the view is greppable and styleable. */
export const PREVIEW_DOM = Object.freeze({
  rootClass: 'preview',
  frame: 'preview-frame',
  loading: 'preview-loading',
  status: 'preview-status',
  cause: 'preview-cause',
  urlError: 'preview-url-error',
  restart: 'preview-restart',
  mobile: 'preview-mobile',
  mobileUrl: 'preview-mobile-url',
  mobileQr: 'preview-mobile-qr',
});

/** Client-authored, non-disclosing indicator messages (Req 4.2–4.5). */
export const PREVIEW_MESSAGES = Object.freeze({
  loading: 'Starting the preview\u2026',
  showingPrior: 'Showing a previous version of your app.',
  error: 'The preview is unavailable.',
  persistentFailure: 'The preview could not be started after repeated attempts.',
  urlUnavailable: 'The preview is ready but its URL was unavailable.',
  mobileHint: 'Scan or open this URL on your phone to connect:',
});

/**
 * Map the preview view-model to the status indicator message (or '').
 * @param {{ status:string, showLoading:boolean, showPrior:boolean, showFailure:boolean }} vm
 * @returns {string}
 */
export function statusMessageFor(vm) {
  if (vm.showLoading) return PREVIEW_MESSAGES.loading;
  if (vm.showPrior) return PREVIEW_MESSAGES.showingPrior;
  if (vm.status === 'persistent_failure') return PREVIEW_MESSAGES.persistentFailure;
  if (vm.showFailure) return PREVIEW_MESSAGES.error;
  return '';
}

/**
 * Create and mount the Preview_Pane view.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {{ getState: Function, subscribe: Function }} opts.store
 * @param {{ restart: Function }} [opts.controller]  the preview controller (for the restart control)
 * @param {(url:string)=>{ dataUri:string }} [opts.qrEncode]  injectable QR encoder (tests); defaults to qr.js
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createPreviewPaneView({ doc, store, controller, qrEncode }) {
  const encodeQr = typeof qrEncode === 'function' ? qrEncode : encodeQrDataUri;

  const root = doc.createElement('section');
  root.className = PREVIEW_DOM.rootClass;
  root.setAttribute('aria-label', 'Preview');

  // The loading indicator.
  const loading = doc.createElement('p');
  loading.id = PREVIEW_DOM.loading;
  loading.className = 'preview__loading';
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  loading.hidden = true;

  // The status indicator (showing-prior / error / persistent-failure).
  const status = doc.createElement('p');
  status.id = PREVIEW_DOM.status;
  status.className = 'preview__status';
  status.setAttribute('role', 'status');
  status.hidden = true;

  // The safe cause summary (Req 4.4/4.5).
  const cause = doc.createElement('p');
  cause.id = PREVIEW_DOM.cause;
  cause.className = 'preview__cause';
  cause.hidden = true;

  // The ready-url-unavailable error (Req 4.2).
  const urlError = doc.createElement('p');
  urlError.id = PREVIEW_DOM.urlError;
  urlError.className = 'preview__url-error';
  urlError.setAttribute('role', 'alert');
  urlError.hidden = true;
  urlError.textContent = PREVIEW_MESSAGES.urlUnavailable;

  // The restart control (Req 4.6). Touch-sized via the stylesheet class.
  const restart = doc.createElement('button');
  restart.id = PREVIEW_DOM.restart;
  restart.className = 'preview__restart';
  restart.setAttribute('type', 'button');
  restart.textContent = 'Restart preview';
  restart.hidden = true;

  // The same-origin preview iframe (Req 4.1, 4.11).
  const frame = doc.createElement('iframe');
  frame.id = PREVIEW_DOM.frame;
  frame.className = 'preview__frame';
  frame.setAttribute('title', 'App preview');
  // A restrictive same-origin sandbox: allow scripts + same-origin so the
  // previewed app runs, consistent with a same-origin preview URL under the
  // app's own CSP. No allow-* beyond what a same-origin app needs.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.hidden = true;

  // The mobile connection block (Req 4.10): selectable URL + scannable QR.
  const mobile = doc.createElement('div');
  mobile.id = PREVIEW_DOM.mobile;
  mobile.className = 'preview__mobile';
  mobile.hidden = true;

  const mobileHint = doc.createElement('p');
  mobileHint.className = 'preview__mobile-hint';
  mobileHint.textContent = PREVIEW_MESSAGES.mobileHint;

  // Selectable text: a <code> holding the URL with user-select allowed via the
  // stylesheet. It is real text content (not a link target we navigate to).
  const mobileUrl = doc.createElement('code');
  mobileUrl.id = PREVIEW_DOM.mobileUrl;
  mobileUrl.className = 'preview__mobile-url';
  mobileUrl.setAttribute('tabindex', '0');

  const mobileQr = doc.createElement('img');
  mobileQr.id = PREVIEW_DOM.mobileQr;
  mobileQr.className = 'preview__mobile-qr';
  mobileQr.setAttribute('alt', 'QR code for the mobile connection URL');

  mobile.append(mobileHint, mobileUrl, mobileQr);

  root.append(loading, status, cause, urlError, restart, frame, mobile);

  function onRestart() {
    if (controller && typeof controller.restart === 'function') void controller.restart();
  }
  restart.addEventListener('click', onRestart);

  // Track the last mobile URL we encoded so re-renders don't re-encode a QR for
  // an unchanged URL (encoding is cheap but this keeps the DOM stable).
  let lastMobileUrl = null;

  /** Apply the pure view-model to the DOM. Idempotent full re-render. */
  function render() {
    const vm = previewViewModel(store.getState());

    // Loading indicator + iframe suppression (Req 4.3).
    loading.hidden = !vm.showLoading;
    if (vm.showLoading) loading.textContent = PREVIEW_MESSAGES.loading;

    // The same-origin iframe: shown only for a ready+url state (Req 4.1) and
    // never while loading (Req 4.3).
    if (vm.showIframe && typeof vm.url === 'string' && vm.url !== '') {
      if (frame.getAttribute('src') !== vm.url) frame.setAttribute('src', vm.url);
      frame.hidden = false;
    } else {
      frame.hidden = true;
      // Drop the src so a suppressed/failed preview shows nothing stale.
      if (frame.hasAttribute('src')) frame.removeAttribute('src');
    }

    // Status indicator (showing-prior / error / persistent-failure) (Req 4.4/4.5).
    const msg = statusMessageFor(vm);
    if (msg) {
      status.textContent = msg;
      status.hidden = false;
    } else {
      status.textContent = '';
      status.hidden = true;
    }

    // Safe cause summary, shown IFF present (Req 4.4/4.5).
    if (vm.cause) {
      cause.textContent = vm.cause;
      cause.hidden = false;
    } else {
      cause.textContent = '';
      cause.hidden = true;
    }

    // Ready-URL-unavailable error (Req 4.2).
    urlError.hidden = !vm.urlUnavailable;

    // Restart control, shown IFF offered (Req 4.6).
    restart.hidden = !vm.showRestart;

    // Mobile connection URL + QR (Req 4.10).
    if (vm.mobileUrl) {
      mobileUrl.textContent = vm.mobileUrl;
      if (vm.mobileUrl !== lastMobileUrl) {
        const { dataUri } = encodeQr(vm.mobileUrl);
        mobileQr.setAttribute('src', dataUri);
        lastMobileUrl = vm.mobileUrl;
      }
      mobile.hidden = false;
    } else {
      mobile.hidden = true;
      lastMobileUrl = null;
    }
  }

  const unsub = store.subscribe((s) => s.preview, render);
  render();

  function destroy() {
    unsub();
    restart.removeEventListener('click', onRestart);
    root.remove();
  }

  return { el: root, render, destroy };
}
