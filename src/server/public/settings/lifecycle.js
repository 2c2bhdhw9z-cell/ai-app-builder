/*
 * settings/lifecycle.js — the build/deploy/export/lock-in-audit/share settings
 * controller (spec Task 14.4; design §"Controllers — settings/*.js",
 * Req 15.1–15.6).
 *
 * The feature logic behind the project-lifecycle screen:
 *   - build()   → POST a build with the Bearer + display the build outcome (15.1)
 *   - deploy()  → POST a deploy with the Bearer + display the deploy outcome (15.2)
 *   - export()  → request the Project_Export package with the Bearer and provide
 *                 it to the user as a DOWNLOAD (15.3). The package bytes are read
 *                 as a blob (api `expect:'blob'`) and handed to an injected
 *                 `download` seam (in a browser: an <a download> object-URL
 *                 click) so the download side-effect is observable in tests.
 *   - audit()   → request the Lockin_Audit and display the reported signals (15.4)
 *   - share()   → request a Share_Link with the Bearer and display the copyable
 *                 URL (15.5)
 *   - ANY 401 on any of these → a re-auth notice with NO project detail (15.6),
 *                 via the shared store's session.notice (the api.js 401 body is
 *                 already discarded, so nothing project-specific can leak).
 *
 * ─── ASSUMED CONTRACT (honest note) ───────────────────────────────────────
 * The Builder_Server exposes NO build/deploy/export/audit/share HTTP routes
 * today — these are backend services: src/portability/export.js (createProject-
 * Export → { ok, ... }), src/portability/lockin-audit.js (audit → { ok,
 * findings }), src/auth/share-link-service.js (create → { ok, link:{ token,
 * url? } }), and build/deploy live behind the sandbox command guard. None is
 * HTTP-surfaced. Per the spec, this controller is written against a DOCUMENTED/
 * ASSUMED contract mirroring those real service shapes and does NOT add or
 * modify any backend route:
 *
 *   POST /settings/build   body { projectId }                    (Bearer gated)
 *     200 → { outcome: 'succeeded'|'failed'|..., summary? }
 *   POST /settings/deploy  body { projectId, service? }          (Bearer gated)
 *     200 → { outcome, summary?, url? }
 *   GET  /settings/export?projectId=…                            (Bearer gated)
 *     200 (blob) → the exported package bytes (a downloadable file)
 *   GET  /settings/lockin-audit?projectId=…                      (Bearer gated)
 *     200 → { findings: [{ signal, file?, line?, evidence? }...], clean: boolean }
 *   POST /settings/share   body { projectId }                    (Bearer gated)
 *     200 → { url } | { link: { url } }                          (copyable URL)
 *     401 → (non-disclosing denial; body discarded by api.js) (Req 15.6)
 *
 * The outcome/findings/link shapes mirror the real services above. A Share_Link
 * URL is the copyable capability; the raw token is never surfaced beyond it.
 *
 * DOM-free and dependency-free at import: the ONLY browser touch is the default
 * `download` seam, which is created lazily and can be overridden by an injected
 * one, so the controller imports and runs cleanly under `node --test`.
 */

import { ACTIONS } from '../store.js';
import { RESULT } from '../api.js';
import { createSettingsState } from './settings-state.js';

/** Client-authored, non-disclosing notice text. */
export const LIFECYCLE_MESSAGES = Object.freeze({
  REAUTH: 'Your session expired. Please sign in again.',
  RATE_LIMITED: 'A usage limit was reached.',
  ERROR: 'The operation could not be completed.',
});

/**
 * The default browser download seam: turn a package blob into a file download by
 * creating an object URL, clicking a synthetic <a download>, and revoking the
 * URL. Built lazily (only when export() runs in a browser) so importing this
 * module in Node never touches a browser global. A test injects its own seam and
 * asserts it was called with the package bytes (Req 15.3).
 *
 * @param {object} pkg  { blob, filename }
 */
function defaultDownload({ blob, filename }) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename || 'project-export.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/**
 * Create the lifecycle controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function }} deps.store
 * @param {{ request: Function }} deps.api
 * @param {(pkg: { blob: any, filename: string }) => void} [deps.download]
 *        the download side-effect seam (Req 15.3); defaults to a browser <a> click.
 * @returns {object}
 */
export function createLifecycleController({ store, api, download } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createLifecycleController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createLifecycleController requires an api client with request()');
  }
  const doDownload = typeof download === 'function' ? download : defaultDownload;

  const surface = createSettingsState({
    build: null, // { outcome, summary? }
    deploy: null, // { outcome, summary?, url? }
    audit: null, // { findings:[...], clean }
    shareUrl: null, // the copyable Share_Link URL
    exported: false, // whether the last export produced a download
    inFlight: null, // which op is in flight ('build'|'deploy'|'export'|'audit'|'share'|null)
  });

  /** Map a non-OK result to a notice; returns the reason. Shared by all ops. */
  function noticeForFailure(result) {
    switch (result.kind) {
      case RESULT.RATE_LIMITED: {
        const named = typeof result.limit === 'string' && result.limit ? result.limit : null;
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'rateLimited', message: LIFECYCLE_MESSAGES.RATE_LIMITED, limit: named });
        return 'rateLimited';
      }
      case RESULT.DENIED:
        // Req 15.6: re-auth prompt, NO project-specific detail (api.js already
        // discarded the 401 body — nothing project-specific can reach here).
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: LIFECYCLE_MESSAGES.REAUTH });
        return 'denied';
      default:
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: LIFECYCLE_MESSAGES.ERROR });
        return 'error';
    }
  }

  /** Invoke a build (Req 15.1). */
  async function build(projectId) {
    surface.set({ inFlight: 'build' });
    const result = await api.request('POST', '/settings/build', { body: { projectId } });
    if (result.kind === RESULT.OK) {
      const data = result.data && typeof result.data === 'object' ? result.data : {};
      surface.set({ build: { outcome: data.outcome ?? 'unknown', summary: typeof data.summary === 'string' ? data.summary : null }, inFlight: null });
      store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
      return { ok: true, outcome: surface.getState().build.outcome, result };
    }
    const reason = noticeForFailure(result);
    surface.set({ inFlight: null });
    return { ok: false, reason, result };
  }

  /** Invoke a deploy (Req 15.2). */
  async function deploy(projectId, service) {
    surface.set({ inFlight: 'deploy' });
    const body = { projectId };
    if (typeof service === 'string' && service) body.service = service;
    const result = await api.request('POST', '/settings/deploy', { body });
    if (result.kind === RESULT.OK) {
      const data = result.data && typeof result.data === 'object' ? result.data : {};
      surface.set({
        deploy: {
          outcome: data.outcome ?? 'unknown',
          summary: typeof data.summary === 'string' ? data.summary : null,
          url: typeof data.url === 'string' ? data.url : null,
        },
        inFlight: null,
      });
      store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
      return { ok: true, outcome: surface.getState().deploy.outcome, result };
    }
    const reason = noticeForFailure(result);
    surface.set({ inFlight: null });
    return { ok: false, reason, result };
  }

  /**
   * Invoke an export (Req 15.3): request the package as a blob and hand it to the
   * download seam so the user receives it as a file. The blob is never retained
   * in surface state; only an `exported` flag is set so the view can confirm.
   *
   * @param {string} projectId
   * @param {string} [filename]
   */
  async function exportProject(projectId, filename) {
    surface.set({ inFlight: 'export' });
    const result = await api.request('GET', `/settings/export?projectId=${encodeURIComponent(projectId ?? '')}`, {
      expect: 'blob',
      timeoutMs: 60_000,
    });
    if (result.kind === RESULT.OK) {
      // Provide the package as a download (Req 15.3). The seam is the observable
      // side-effect a test asserts; the bytes are not stored anywhere.
      doDownload({ blob: result.data, filename: filename || `${projectId || 'project'}-export.zip` });
      surface.set({ exported: true, inFlight: null });
      store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
      return { ok: true, result };
    }
    const reason = noticeForFailure(result);
    surface.set({ inFlight: null });
    return { ok: false, reason, result };
  }

  /** Invoke a lock-in audit (Req 15.4): display the reported signals. */
  async function audit(projectId) {
    surface.set({ inFlight: 'audit' });
    const result = await api.request('GET', `/settings/lockin-audit?projectId=${encodeURIComponent(projectId ?? '')}`);
    if (result.kind === RESULT.OK && result.data && typeof result.data === 'object') {
      const findings = Array.isArray(result.data.findings) ? result.data.findings : [];
      surface.set({ audit: { findings, clean: result.data.clean === true || findings.length === 0 }, inFlight: null });
      store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
      return { ok: true, findings, result };
    }
    const reason = noticeForFailure(result);
    surface.set({ inFlight: null });
    return { ok: false, reason, result };
  }

  /** Create a Share_Link (Req 15.5): display the copyable URL. */
  async function share(projectId) {
    surface.set({ inFlight: 'share' });
    const result = await api.request('POST', '/settings/share', { body: { projectId } });
    if (result.kind === RESULT.OK && result.data && typeof result.data === 'object') {
      const url =
        typeof result.data.url === 'string'
          ? result.data.url
          : result.data.link && typeof result.data.link.url === 'string'
            ? result.data.link.url
            : null;
      surface.set({ shareUrl: url, inFlight: null });
      store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
      return { ok: true, url, result };
    }
    const reason = noticeForFailure(result);
    surface.set({ inFlight: null });
    return { ok: false, reason, result };
  }

  return {
    getState: surface.getState,
    subscribe: surface.subscribe,
    build,
    deploy,
    export: exportProject,
    audit,
    share,
  };
}
