/*
 * app.js — Web UI client bootstrap entry module (spec Task 1.3 / 3.2,
 * Req 1.3 / 1.4 / 2.1).
 *
 * This is the ES-module entry point loaded by index.html's
 * <script type="module" src="/app.js">. Its job is to wire the client's real
 * collaborators together and mount the live UI into the #app root so that GET /
 * renders a LIVE client shell (mounted DOM views), not a static server string
 * and not JSON.
 *
 * Task 1.3 mounted a minimal placeholder. Task 3.2 extends — not replaces —
 * that bootstrap: it now instantiates the observable store (Task 2.1) and the
 * gated api client (Task 2.2), builds the builder submit controller (Task 3.1),
 * and mounts the prompt view (Task 3.2) so the prompt box actually renders and
 * submits in the client shell. Later tasks add the remaining views/controllers
 * (Activity_Stream, preview, confirm, workspace, theme, …) alongside these.
 *
 * It obeys the CSP the shell is served under: it is a same-origin module
 * (script-src 'self'), it touches no external origin, builds nodes via the DOM
 * API (no innerHTML / no inline handlers), and applies no inline <style> — any
 * theming later happens by setting --color-* custom properties on
 * document.documentElement via the CSSOM.
 */

import { createStore, ACTIONS } from './store.js';
import { createApiClient } from './api.js';
import { createBuilderController } from './builder.js';
import { createSseClient } from './sse.js';
import { createPromptView } from './views/prompt.js';
import {
  createActivityStreamView,
  connectActivityStream,
} from './views/activity-stream.js';

/** The DOM node the client mounts into (declared in index.html). */
const ROOT_ID = 'app';

/** The human-facing product title shown in the initial shell. */
const APP_TITLE = 'AI App Builder';

/**
 * Wire the client's real collaborators. Pure of the DOM so it is unit-testable:
 * builds the store, the gated api client, and the builder submit controller and
 * returns them. The token getter is a SEAM the auth controller (Task 8) fills;
 * until then it returns null, so gated calls resolve `denied` without a network
 * hit rather than sending an unauthenticated request.
 *
 * @param {object} [deps]  optional injected collaborators (tests may override)
 * @returns {{ store: object, api: object, builder: object }}
 */
export function createClient(deps = {}) {
  const store = deps.store ?? createStore();
  const api =
    deps.api ??
    createApiClient({
      // Token_Store wiring lands in Task 8; for now no token is held.
      getToken: deps.getToken ?? (() => null),
    });
  const builder = deps.builder ?? createBuilderController({ store, api });
  // The SSE client shares the SAME token seam as the api client (Req 6.4), so
  // the Bearer is attached to the /events stream once the Token_Store (Task 8)
  // fills the getToken seam. Injected timer/fetch/AbortController default to the
  // browser globals in production.
  const sse =
    deps.sse ??
    createSseClient({
      getToken: deps.getToken ?? (() => null),
    });
  return { store, api, builder, sse };
}

/**
 * Open a Project_Session: reset the per-session activity slice, mark the session
 * open (which the store defaults to Work_Mode 'vibe'), then wire and open the
 * SSE Activity_Stream for the project (Req 3.1). Returns the SSE wiring teardown
 * so a session close (or a re-open) can disconnect cleanly. This is the single
 * place session-open side effects live; the project-creation controller (Task 9)
 * calls it on a 201.
 *
 * @param {{ store: object, sse: object }} client
 * @param {string} projectId
 * @returns {{ disconnect: () => void }}
 */
export function openSession(client, projectId) {
  client.store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId });
  client.store.dispatch({ type: ACTIONS.ACTIVITY_CLEARED });
  return connectActivityStream({ store: client.store, sse: client.sse, projectId });
}

/**
 * Build the app shell as detached DOM and mount the initial feature views into
 * it. Returns the shell element plus the views it created (so a re-mount or a
 * test can tear them down). Kept as a builder that takes its collaborators, so
 * nothing here depends on module-global browser state. No innerHTML / no inline
 * handlers — every node is built via the DOM API (Req 1.4).
 *
 * @param {Document} doc
 * @param {{ store: object, builder: object }} client
 * @returns {{ el: HTMLElement, views: Array<{ destroy: Function }> }}
 */
export function createInitialView(doc, client) {
  const main = doc.createElement('main');
  main.className = 'app-shell';

  const title = doc.createElement('h1');
  title.className = 'app-shell__title';
  title.textContent = APP_TITLE;

  main.append(title);

  const views = [];
  // Mount the prompt view (Task 3.2) so the prompt box renders and submits.
  // Guarded: if collaborators are absent (e.g. a minimal test), the shell still
  // renders its title rather than throwing.
  if (client && client.store && client.builder) {
    const prompt = createPromptView({
      doc,
      store: client.store,
      controller: client.builder,
    });
    main.append(prompt.el);
    views.push(prompt);
  }

  // Mount the Activity_Stream view (Task 4.3) alongside the prompt so the live
  // reasoning/tool/diff feed and the connection state render in the shell. The
  // SSE stream itself is opened by openSession() when a Project_Session opens.
  if (client && client.store) {
    const activity = createActivityStreamView({
      doc,
      store: client.store,
      sse: client.sse,
    });
    main.append(activity.el);
    views.push(activity);
  }

  return { el: main, views };
}

/**
 * Mount the app shell into the given root, replacing the server-rendered
 * fallback. Idempotent: replaces any existing children so a re-mount does not
 * stack duplicate views.
 *
 * @param {Document} doc
 * @param {HTMLElement} root
 * @param {{ store: object, builder: object }} client
 * @returns {{ el: HTMLElement, views: Array<{ destroy: Function }> }}
 */
export function mount(doc, root, client) {
  const view = createInitialView(doc, client);
  root.replaceChildren(view.el);
  return view;
}

/**
 * Bootstrap the client: wire collaborators, locate the root, and mount the
 * initial views. Guarded so importing this module in a non-browser context
 * (e.g. a Node unit test that exercises the pure builders directly) is a no-op
 * rather than a crash.
 */
export function bootstrap() {
  if (typeof document === 'undefined') return;
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const client = createClient();
  mount(document, root, client);
}

// Run on load in a browser. A module script is deferred by default, so the DOM
// (including the #app root) is already parsed by the time this executes.
if (typeof document !== 'undefined') {
  bootstrap();
}
