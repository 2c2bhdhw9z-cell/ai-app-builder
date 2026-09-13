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

/* ===================================================================== *
 * DERIVED DECISION LAYER (ui-redesign Req 1, 2)                          *
 *                                                                        *
 * The nine palette keys stay the ONLY themeable input. Everything else a  *
 * real design system needs — a readable foreground, neutral anchors,      *
 * elevation color — is DERIVED from those nine here.                      *
 *                                                                        *
 * Why this exists: styles.css shipped `body { color: var(--color-accent) }`,*
 * so body text was painted with the theme's ACCENT hue. That makes body    *
 * contrast equal to accent-on-background, and it FAILS WCAG AA on four of  *
 * the eight shipped themes (pastel-pasture 2.15:1, morning-dew 2.36:1,     *
 * summer-sunset 2.63:1, peach-popsicle 2.14:1). A real foreground token    *
 * fixes it for every palette, including palettes that do not exist yet.    *
 *                                                                        *
 * Everything below is PURE: same nine inputs -> same outputs, no DOM, no  *
 * prior state. That is what lets a Theme preview revert by simply         *
 * re-applying the committed palette (web-ui Property 27 extends for free).*
 * ===================================================================== */

/** Near-black / near-white anchor bases. Nudged per-palette, never used raw. */
const INK_BASE = Object.freeze([10, 12, 15]);
const PAPER_BASE = Object.freeze([255, 255, 255]);
/** Max share of the palette's own background mixed into an anchor. */
const NUDGE_MAX = 0.09;
/** Guaranteed-legible fallbacks. Better-of-these is always >= 4.58:1. */
const PURE_INK_RGB = Object.freeze([0, 0, 0]);
const PURE_PAPER_RGB = Object.freeze([255, 255, 255]);
const PURE_INK_HEX = '#000000';
const PURE_PAPER_HEX = '#ffffff';
/** WCAG AA floor for body text. */
const AA_FLOOR = 4.5;

/** Parse `#rgb`/`#rrggbb` to [r,g,b]. Returns null when unparseable. */
function parseHex(value) {
  if (typeof value !== 'string') return null;
  let h = value.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** [r,g,b] -> `#rrggbb`. */
function toHex(rgb) {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.x relative luminance of an [r,g,b] triple. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two [r,g,b] triples. Always >= 1. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear per-channel mix: `amount` of b into a. */
function mix(a, b, amount) {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * amount);
}

/**
 * Nudge an anchor toward the palette's background hue so a neutral does not
 * read dirty against a warm or cool surface — but BOUNDED and CONTRAST-FLOORED:
 * the nudge is stepped back until it clears AA against `bg`, so warmth can
 * never be bought with legibility.
 */
function nudgeAnchor(base, bg) {
  for (let amount = NUDGE_MAX; amount > 0; amount -= 0.03) {
    const candidate = mix(base, bg, amount);
    // Judge the rounded value, since that is what is emitted and measured.
    if (contrast(parseHex(toHex(candidate)), bg) >= AA_FLOOR) return candidate;
  }
  return base;
}

/**
 * Derive every non-themeable colour DECISION from the nine palette inputs.
 *
 * PURE and DOM-FREE by construction: takes only a palette, returns only data,
 * reads no module state. Malformed input degrades to a safe neutral rather
 * than throwing, so a partial or junk palette can never blank the UI.
 *
 * @param {Record<string,string> | null | undefined} palette
 * @returns {{
 *   polarity: 'light'|'dark', colorScheme: 'light'|'dark',
 *   ink: string, paper: string, shadowColor: string,
 *   on: Record<string,string>,
 * }}
 */
export function deriveDecisions(palette) {
  const pal = palette && typeof palette === 'object' ? palette : {};
  // A junk/absent background degrades to white so the result stays usable.
  const bg = parseHex(pal.background) ?? [255, 255, 255];

  const ink = nudgeAnchor(INK_BASE, bg);
  const paper = nudgeAnchor(PAPER_BASE, bg);
  const inkHex = toHex(ink);
  const paperHex = toHex(paper);

  const isDark = luminance(bg) < 0.5;

  // Elevation tint comes from ink, never pure black, so shadows sit INSIDE the
  // theme instead of laying a grey film over it.
  const shadowColor = toHex(mix(ink, bg, 0.18));

  /**
   * Readable foreground for one fill.
   *
   * The hue-nudged anchors are a PREFERENCE, not a guarantee: against a
   * mid-luminance fill the headroom above AA is only ~0.08, so any nudge can
   * push it under the floor. So we take the better nudged anchor when it clears
   * AA, and otherwise fall back to the pure neutral. Picking the better of pure
   * black/white is provably >= 4.58:1 for ANY fill (the worst case is a fill at
   * relative luminance 0.179, where both anchors tie at 4.58), so this can
   * never return an unreadable pairing.
   */
  const onFill = (raw) => {
    const fill = parseHex(raw) ?? bg;
    const nudged = contrast(ink, fill) >= contrast(paper, fill) ? ink : paper;
    const nudgedHex = toHex(nudged);
    // Measure the ROUNDED value we actually emit, not the float we computed from.
    // `toHex` rounds, the AA floor is a hard boundary, and a ratio of 4.501 can
    // round down through it — so the decision has to be made on the emitted value.
    if (contrast(parseHex(nudgedHex), fill) >= AA_FLOOR) return nudgedHex;
    return contrast(PURE_INK_RGB, fill) >= contrast(PURE_PAPER_RGB, fill)
      ? PURE_INK_HEX
      : PURE_PAPER_HEX;
  };

  const on = {};
  for (const key of PALETTE_KEYS) on[key] = onFill(pal[key]);

  return Object.freeze({
    polarity: isDark ? 'dark' : 'light',
    colorScheme: isDark ? 'dark' : 'light',
    ink: inkHex,
    paper: paperHex,
    shadowColor,
    on: Object.freeze(on),
  });
}

/** The twelve derived custom property names, for tests and stylesheet authors. */
export const DERIVED_VAR_NAMES = Object.freeze([
  '--ink',
  '--paper',
  '--shadow-color',
  ...PALETTE_KEYS.map((k) => `--on-${k}`),
]);

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
 * Apply the DERIVED decision layer (ui-redesign Req 1.3).
 *
 * Deliberately a SEPARATE function from `applyPalette` rather than an extension
 * of it. `web-ui` Property 26 asserts that applying a palette puts EXACTLY nine
 * custom properties on the surface (`target.size() === PALETTE_KEYS.length`), so
 * it is an exclusivity assertion, not merely a completeness one. Folding the
 * derived writes into `applyPalette` would break that shipped contract. Keeping
 * them apart means Property 26 holds verbatim and untouched, while the stylesheet
 * still gets everything it needs.
 *
 * In the browser both functions receive the same `documentElement.style`, so the
 * cascade sees one merged set; only the *contract of applyPalette* stays narrow.
 *
 * @param {{ setProperty: (name: string, value: string) => void } | null | undefined} target
 * @param {Record<string,string> | null | undefined} palette
 * @param {{ setAttribute: (name: string, value: string) => void }} [element]
 *   optional element for the `data-polarity` attribute (the document element).
 * @returns {number} how many properties were set
 */
export function applyDerivedDecisions(target, palette, element) {
  if (!target || typeof target.setProperty !== 'function') return 0;
  if (!palette || typeof palette !== 'object') return 0;
  const d = deriveDecisions(palette);
  let set = 0;
  const put = (name, value) => {
    target.setProperty(name, value);
    set += 1;
  };
  put('--ink', d.ink);
  put('--paper', d.paper);
  put('--shadow-color', d.shadowColor);
  for (const key of PALETTE_KEYS) put(`--on-${key}`, d.on[key]);
  // `color-scheme` is a real CSS property so it rides the same CSSOM write and
  // stays CSP-legal. `--is-dark` lets the sheet branch numerically in calc() and
  // color-mix() without needing an attribute selector.
  put('color-scheme', d.colorScheme);
  put('--is-dark', d.polarity === 'dark' ? '1' : '0');
  if (element && typeof element.setAttribute === 'function') {
    element.setAttribute('data-polarity', d.polarity);
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

  // The element the `data-polarity` attribute goes on. Same defensive shape as
  // `target`: absent outside a browser, in which case the attribute is skipped
  // and the derived custom properties still apply.
  const docElement =
    typeof document !== 'undefined' && document.documentElement ? document.documentElement : null;
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
    const palette = t.previewedPalette ?? t.committedPalette;
    applyPalette(target, palette);
    applyDerivedDecisions(target, palette, docElement);
  }

  /** Apply the last COMMITTED palette to the surface (the revert baseline). */
  function applyCommitted() {
    const palette = store.getState().theme.committedPalette;
    applyPalette(target, palette);
    applyDerivedDecisions(target, palette, docElement);
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
