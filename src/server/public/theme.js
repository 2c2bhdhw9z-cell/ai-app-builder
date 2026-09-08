/*
 * theme.js — the Theme controller + palette application (spec Task 11.1; design
 *  §"Controllers — theme.js" / §"Theme state", Req 9.1–9.8, Property 26–28).
 *
 * This is the feature logic that renders the named color Themes that already
 * exist as backend data (THEME_CATALOG) but were never rendered by anything.
 * It owns:
 *
 *   1. `applyPalette(target, palette)` — a PURE, INJECTABLE palette applier: it
 *      sets the NINE `--color-*` CSS custom properties on a style TARGET (in the
 *      browser, `document.documentElement.style`; in a test, any object exposing
 *      `setProperty(name, value)`). Because styles.css references only
 *      `var(--color-*)`, setting these recolors every styled surface (Req 9.1),
 *      and it is testable without a DOM by passing a recording target. The nine
 *      property names are EXACTLY those named in design Property 26
 *      (`--color-background`, `--color-surface`, `--color-accent`,
 *      `--color-button`, `--color-badge`, `--color-statusInfo`,
 *      `--color-statusSuccess`, `--color-statusWarning`, `--color-statusError`),
 *      i.e. `--color-<paletteKey>` for each of the store's PALETTE_KEYS.
 *
 *   2. `createThemeController({ store, api, styleTarget, getExperience })` — the
 *      catalog control (the 8 themes), and the preview / commit / cancel flow:
 *        - preview(themeId): POST /theme { action:'preview' }, apply the returned
 *          previewed palette to the surface WITHOUT recording it committed (the
 *          store's THEME_PREVIEWED writes previewedTheme only) (Req 9.3).
 *        - commit(themeId): POST /theme { action:'commit' }, apply + record the
 *          committed palette (THEME_COMMITTED) (Req 9.4).
 *        - cancel(): revert the surface to the last committed palette and drop
 *          the preview (THEME_PREVIEW_CANCELLED) (Req 9.5).
 *        - a 400 { code:'unsupported_theme' } keeps the committed palette applied
 *          and shows an "unsupported" message (Req 9.6); a timeout / other non-200
 *          keeps the committed palette applied and shows a "could-not-complete"
 *          message (Req 9.7).
 *        - bootstrap(): GET /theme, record the reported default as the committed
 *          theme + apply its palette (Req 9.8).
 *
 * The heavy state-machine invariants (previewed never touches committed; commit
 * overwrites committed and clears preview; cancel drops preview leaving committed
 * intact) live in the store's PURE reducer, so this controller is a thin driver
 * that also mirrors the SURFACE (the applied CSS custom properties) to match the
 * store slice after each action.
 *
 * The backend contract this consumes is FIXED (read from src/server/builder-server.js
 * handleGetTheme / handleTheme + themeFrame + src/model/enums.js THEME_CATALOG /
 * Theme):
 *
 *   GET  /theme?workspaceExperience=<exp>                        (Bearer gated)
 *     200 → { type:'theme', theme, palette, previewed:false, workspaceExperience }
 *   POST /theme  body { action:'preview'|'commit', workspaceExperience, theme }
 *     200 → { type:'theme', theme, palette, previewed:<bool>, workspaceExperience }
 *     400 → { error, code:'unsupported_theme', current:{ ...theme frame } }
 *
 * DOM-free and dependency-free: every collaborator (`store`, gated `api`,
 * `styleTarget`, `getExperience`) is INJECTED, so the whole controller — and the
 * pure `applyPalette` — run under `node --test` with the REAL store reducer and
 * the REAL api client (driven by an injected fetch) and a recording style target.
 * It imports only the store's PALETTE_KEYS + action names + the api result kinds.
 */

import { ACTIONS, PALETTE_KEYS } from './store.js';
import { RESULT } from './api.js';

/** The eight catalog Theme ids offered by the control (Req 9.2). Mirrors
 *  src/model/enums.js `Theme`, in the same order. */
export const THEMES = Object.freeze([
  'light',
  'dark',
  'pastel-pasture',
  'out-there',
  'paranormal-purple',
  'morning-dew',
  'summer-sunset',
  'peach-popsicle',
]);

/** Human labels for the catalog control. Presentation only. */
export const THEME_LABELS = Object.freeze({
  light: 'Light',
  dark: 'Dark',
  'pastel-pasture': 'Pastel Pasture',
  'out-there': 'Out There',
  'paranormal-purple': 'Paranormal Purple',
  'morning-dew': 'Morning Dew',
  'summer-sunset': 'Summer Sunset',
  'peach-popsicle': 'Peach Popsicle',
});

/** Client-authored, non-disclosing notice text. Exported so the view + tests
 *  reference the same strings. None carries a backend body field. */
export const THEME_MESSAGES = Object.freeze({
  UNSUPPORTED: 'That theme is not available.',
  FAILED: 'The theme change could not be completed.',
  REAUTH: 'Your session expired. Please sign in again.',
});

/**
 * The nine CSS custom property names, one per palette key, in PALETTE_KEYS
 * order: `--color-<key>`. These are EXACTLY the names design Property 26 asserts
 * (`--color-background` … `--color-statusError`). Exported so styles.css authors
 * and the tests share one source of truth.
 * @type {readonly string[]}
 */
export const CSS_VAR_NAMES = Object.freeze(PALETTE_KEYS.map((key) => `--color-${key}`));

/**
 * The CSS custom property name for a palette key: `--color-<key>`.
 * @param {string} key  a PALETTE_KEYS member (e.g. 'statusInfo')
 * @returns {string}    e.g. '--color-statusInfo'
 */
export function cssVarName(key) {
  return `--color-${key}`;
}

/**
 * PURE palette applier (Req 9.1, Property 26). Set the nine `--color-*` CSS
 * custom properties on a style TARGET from a palette map. The target is anything
 * exposing `setProperty(name, value)` — in the browser this is
 * `document.documentElement.style` (the CSSOM, which is NOT an inline <style>
 * element and is CSP-legal under style-src 'self'); in a test it is a recording
 * object. Missing/non-string palette values are skipped (defensive) so a partial
 * palette never writes `undefined`.
 *
 * @param {{ setProperty: (name: string, value: string) => void } | null | undefined} target
 * @param {Record<string,string> | null | undefined} palette
 * @returns {number}  how many properties were set (for tests/telemetry-free assert)
 */
export function applyPalette(target, palette) {
  if (!target || typeof target.setProperty !== 'function') return 0;
  if (!palette || typeof palette !== 'object') return 0;
  let set = 0;
  for (const key of PALETTE_KEYS) {
    const value = palette[key];
    if (typeof value === 'string') {
      target.setProperty(cssVarName(key), value);
      set += 1;
    }
  }
  return set;
}

/**
 * Create the Theme controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function, subscribe?: Function }} deps.store
 *   the REAL observable store (createStore()).
 * @param {{ request: Function }} deps.api
 *   the REAL gated api client (createApiClient()).
 * @param {{ setProperty: Function }} [deps.styleTarget]
 *   the CSSOM style target the palette is applied to. Defaults to
 *   `document.documentElement.style` in a browser; a test injects a recorder.
 *   Absent (non-browser, no injection) → palette application is a no-op but the
 *   store slice still updates, so the flow stays testable.
 * @param {() => string} [deps.getExperience]
 *   returns the CURRENT Workspace_Experience (a Theme is committed per
 *   (account, experience) pair). Defaults to reading the store's workspace
 *   slice; the value is sent as `workspaceExperience` on the /theme calls.
 * @returns {{
 *   themes: readonly string[],
 *   labels: typeof THEME_LABELS,
 *   preview: (themeId: string) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 *   commit: (themeId: string) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 *   cancel: () => void,
 *   bootstrap: () => Promise<{ ok: boolean, theme?: string }>,
 *   applyCommitted: () => void,
 * }}
 */
export function createThemeController({ store, api, styleTarget, getExperience } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createThemeController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createThemeController requires an api client with request()');
  }

  // Resolve the style target: injected recorder, else the browser CSSOM root.
  const target =
    styleTarget && typeof styleTarget.setProperty === 'function'
      ? styleTarget
      : typeof document !== 'undefined' && document.documentElement
        ? document.documentElement.style
        : null;

  const experienceOf =
    typeof getExperience === 'function'
      ? getExperience
      : () => {
          const ws = store.getState().workspace;
          return ws && typeof ws.experience === 'string' ? ws.experience : '';
        };

  /** Apply whatever palette the store currently deems ACTIVE: the previewed
   *  palette if previewing, else the committed baseline. */
  function applyActive() {
    const t = store.getState().theme;
    applyPalette(target, t.previewedPalette ?? t.committedPalette);
  }

  /** Apply the last COMMITTED palette to the surface (the revert baseline). */
  function applyCommitted() {
    applyPalette(target, store.getState().theme.committedPalette);
  }

  /**
   * Preview a theme (Req 9.3): POST /theme action 'preview', then dispatch
   * THEME_PREVIEWED (writes previewedTheme/Palette only, never committed) and
   * apply the previewed palette to the surface. On failure keep the committed
   * palette applied + show a message (Req 9.6/9.7).
   * @param {string} themeId
   */
  async function preview(themeId) {
    const result = await api.request('POST', '/theme', {
      body: { action: 'preview', theme: themeId, workspaceExperience: experienceOf() },
      timeoutMs: 5_000,
    });
    return handleThemeResult(result, 'preview', themeId);
  }

  /**
   * Commit a theme (Req 9.4): POST /theme action 'commit', then dispatch
   * THEME_COMMITTED (overwrites committed + clears preview) and apply the
   * committed palette. On failure keep the committed palette applied + show a
   * message (Req 9.6/9.7).
   * @param {string} themeId
   */
  async function commit(themeId) {
    const result = await api.request('POST', '/theme', {
      body: { action: 'commit', theme: themeId, workspaceExperience: experienceOf() },
      timeoutMs: 5_000,
    });
    return handleThemeResult(result, 'commit', themeId);
  }

  /**
   * Cancel a preview / navigate away (Req 9.5): drop the preview in the store and
   * revert the surface to the last committed palette within the frame budget.
   */
  function cancel() {
    store.dispatch({ type: ACTIONS.THEME_PREVIEW_CANCELLED });
    applyCommitted();
  }

  /**
   * Bootstrap the default committed Theme for the current experience (Req 9.8):
   * GET /theme, record the reported palette as committed (THEME_COMMITTED) and
   * apply it. A denied/failed read leaves the committed palette null so the
   * stylesheet :root fallback remains until a later frame.
   * @returns {Promise<{ ok: boolean, theme?: string }>}
   */
  async function bootstrap() {
    const result = await api.request('GET', `/theme?workspaceExperience=${encodeURIComponent(experienceOf())}`, {
      timeoutMs: 5_000,
    });
    if (result.kind === RESULT.OK && result.data && result.data.type === 'theme') {
      store.dispatch({
        type: ACTIONS.THEME_COMMITTED,
        themeId: result.data.theme,
        palette: result.data.palette,
      });
      applyCommitted();
      return { ok: true, theme: result.data.theme };
    }
    return { ok: false };
  }

  /**
   * Map a /theme transport result onto the store + surface. On OK the frame's
   * `previewed` flag decides preview vs commit; on any failure the committed
   * palette stays applied (the store is untouched) and a message is shown.
   * @param {object} result   the ApiResult from api.request
   * @param {'preview'|'commit'} action
   * @param {string} themeId
   */
  function handleThemeResult(result, action, themeId) {
    switch (result.kind) {
      case RESULT.OK: {
        const frame = result.data && typeof result.data === 'object' ? result.data : {};
        if (frame.previewed === true || action === 'preview') {
          store.dispatch({ type: ACTIONS.THEME_PREVIEWED, themeId: frame.theme ?? themeId, palette: frame.palette });
        } else {
          store.dispatch({ type: ACTIONS.THEME_COMMITTED, themeId: frame.theme ?? themeId, palette: frame.palette });
        }
        // Mirror the store's active palette onto the surface (previewed if
        // previewing, else committed) (Req 9.1).
        applyActive();
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        return { ok: true, result };
      }
      case RESULT.VALIDATION:
      case RESULT.PROTOCOL: {
        // Req 9.6: an unsupported_theme 400 keeps the committed palette applied
        // and shows the unsupported message. The committed store slice is NOT
        // touched, so the surface baseline stays; re-apply defensively.
        const code = result.code;
        applyCommitted();
        store.dispatch({
          type: ACTIONS.NOTICE_SET,
          kind: 'validation',
          message: code === 'unsupported_theme' ? THEME_MESSAGES.UNSUPPORTED : THEME_MESSAGES.FAILED,
        });
        return { ok: false, reason: code === 'unsupported_theme' ? 'unsupported' : 'validation', result };
      }
      case RESULT.DENIED:
        applyCommitted();
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: THEME_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };
      case RESULT.TIMEOUT:
      default:
        // Req 9.7: a timeout or any other non-200 keeps the committed palette
        // applied and shows a could-not-complete message.
        applyCommitted();
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: THEME_MESSAGES.FAILED });
        return { ok: false, reason: result.kind === RESULT.TIMEOUT ? 'timeout' : 'error', result };
    }
  }

  return {
    themes: THEMES,
    labels: THEME_LABELS,
    preview,
    commit,
    cancel,
    bootstrap,
    applyCommitted,
  };
}
