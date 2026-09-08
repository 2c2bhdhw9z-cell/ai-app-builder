/*
 * app.js — Web UI client bootstrap entry module (spec Task 1.3, Req 1.3 / 1.4).
 *
 * This is the ES-module entry point loaded by index.html's
 * <script type="module" src="/app.js">. Its job in this first slice is small but
 * REAL: mount an initial client-rendered view into the #app root so that GET /
 * renders a LIVE client shell (a mounted DOM view), not a static server string
 * and not JSON. It is intentionally minimal — the observable state store, the
 * view router, and the feature views are added in later tasks (2.x, 3.x, …) and
 * will replace the placeholder mounted here.
 *
 * It obeys the CSP the shell is served under: it is a same-origin module
 * (script-src 'self'), it touches no external origin, and it applies no inline
 * <style> — any theming later happens by setting --color-* custom properties on
 * document.documentElement via the CSSOM.
 */

/** The DOM node the client mounts into (declared in index.html). */
const ROOT_ID = 'app';

/** The human-facing product title shown in the initial shell. */
const APP_TITLE = 'AI App Builder';

/**
 * Build the initial (minimal but real) view as detached DOM. Returns an element
 * the caller mounts into the root. Kept as a pure builder so a later task can
 * unit-test it and the router can swap it out. No innerHTML / no inline event
 * handlers — nodes are constructed via the DOM API so nothing depends on an
 * inline-script or inline-style CSP exception.
 *
 * @param {Document} doc
 * @returns {HTMLElement}
 */
export function createInitialView(doc) {
  const main = doc.createElement('main');
  main.className = 'app-shell';

  const title = doc.createElement('h1');
  title.className = 'app-shell__title';
  title.textContent = APP_TITLE;

  const status = doc.createElement('p');
  status.className = 'app-shell__status';
  status.textContent = 'Loading\u2026';

  main.append(title, status);
  return main;
}

/**
 * Mount the initial view into the given root, replacing the server-rendered
 * fallback. Idempotent: clears any existing children first so a re-mount does
 * not stack duplicate views.
 *
 * @param {Document} doc
 * @param {HTMLElement} root
 * @returns {HTMLElement} the mounted view element
 */
export function mount(doc, root) {
  const view = createInitialView(doc);
  root.replaceChildren(view);
  return view;
}

/**
 * Bootstrap the client: locate the root and mount the initial view. Guarded so
 * importing this module in a non-browser context (e.g. a Node unit test that
 * exercises createInitialView directly) is a no-op rather than a crash.
 */
export function bootstrap() {
  if (typeof document === 'undefined') return;
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  mount(document, root);
}

// Run on load in a browser. A module script is deferred by default, so the DOM
// (including the #app root) is already parsed by the time this executes.
if (typeof document !== 'undefined') {
  bootstrap();
}
