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
import { createTokenStore } from './token-store.js';
import { createAuthController } from './auth.js';
import { createBuilderController } from './builder.js';
import { createSseClient } from './sse.js';
import { createPreviewController } from './preview.js';
import { createPreviewPoll } from './preview-poll.js';
import { createConfirmController } from './confirm.js';
import { createProjectsController } from './projects.js';
import { createPromptView } from './views/prompt.js';
import {
  createActivityStreamView,
  connectActivityStream,
} from './views/activity-stream.js';
import { createPreviewPaneView } from './views/preview-pane.js';
import { createConfirmView } from './views/confirm.js';
import { createProjectsView } from './views/projects.js';

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
  // The Token_Store (Task 8.1) is the client-side Bearer_Token holder. Its
  // `getToken` is THE seam api.js and sse.js read to attach `Authorization:
  // Bearer <token>` to every gated request and the `/events` connect (Req 6.4).
  // In-memory primary + optional sessionStorage continuity; never document.cookie
  // (Req 16.3). A test may inject its own tokenStore or a bare getToken.
  const tokenStore = deps.tokenStore ?? createTokenStore();
  // Prefer an explicitly injected getToken (tests); otherwise read the REAL
  // Token_Store, so once the auth controller stores a token it flows into both
  // transports with no rewire.
  const getToken = deps.getToken ?? (() => tokenStore.getToken());
  const api =
    deps.api ??
    createApiClient({
      getToken,
    });
  const builder = deps.builder ?? createBuilderController({ store, api });
  // The SSE client shares the SAME token seam as the api client (Req 6.4), so
  // the Bearer is attached to the /events stream from the Token_Store's
  // getToken. Injected timer/fetch/AbortController default to the browser
  // globals in production.
  const sse =
    deps.sse ??
    createSseClient({
      getToken,
    });
  // The preview controller (Task 5.1) owns the restart control + the store
  // projection of preview_status; the poller (Task 5.2) is the safety net for
  // the known "dead preview not pushed over SSE" gap (Req 4.7–4.9). Both share
  // the SAME store + gated api client, so the Bearer flows once the Token_Store
  // (Task 8) fills the getToken seam.
  const preview = deps.preview ?? createPreviewController({ store, api });
  const previewPoll = deps.previewPoll ?? createPreviewPoll({ store, api, controller: preview });
  // The confirm controller (Task 6.1) turns an approve/deny intent into a
  // POST /confirm carrying the frame's requestId + the Bearer, sharing the SAME
  // store + gated api client so the Bearer flows once the Token_Store (Task 8)
  // fills the getToken seam. The confirm_request/confirm_timeout frames are
  // already dispatched into store.pendingConfirms by frames.js (Task 4).
  const confirm = deps.confirm ?? createConfirmController({ store, api });
  // The auth controller (Task 8.2) owns the Login_Flow + the Token_Store
  // lifecycle. It registers the api.js `onAccessDenied` seam so ANY gated 401
  // clears the token and returns to login (Req 6.7), navigates to /auth/login on
  // the login control (Req 6.1), applies the /auth/callback branches (Req
  // 6.2/6.3/6.5/6.6), and clears on expiry/logout (Req 6.7/6.9). It shares the
  // SAME store, api client, and tokenStore so token presence, auto-attach, and
  // clearing all stay consistent.
  const auth =
    deps.auth ??
    createAuthController({
      store,
      api,
      tokenStore,
      ...(deps.navigate ? { navigate: deps.navigate } : {}),
    });
  const client = { store, api, builder, sse, preview, previewPoll, confirm, tokenStore, auth };
  // The project-creation controller (Task 9.1) turns a chosen Target_Category +
  // Project_Origin (+ any origin-specific reference) into a POST /projects
  // carrying the Bearer (Req 7.2), and on a 201 opens the core builder screen
  // for the new Project_Session (Req 7.3). Its `openSession` seam is a closure
  // over the SAME client + the real openSession() below, so a created project
  // resets the activity slice, opens the SSE stream, and starts the preview poll
  // with no rewire. It shares the SAME store + gated api client so the Bearer
  // flows and the notice slice the form view reads is the same one.
  client.projects =
    deps.projects ??
    createProjectsController({
      store,
      api,
      openSession: (projectId) => openSession(client, projectId),
    });
  return client;
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
  const wiring = connectActivityStream({ store: client.store, sse: client.sse, projectId });
  // Start the 5s preview liveness poll for this session (Req 4.7). It is the
  // ONLY mechanism that detects a dead preview the backend does not push.
  if (client.previewPoll && typeof client.previewPoll.start === 'function') {
    client.previewPoll.start(projectId);
  }
  return {
    disconnect() {
      if (client.previewPoll && typeof client.previewPoll.stop === 'function') {
        client.previewPoll.stop();
      }
      wiring.disconnect();
    },
  };
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

  // Mount the Preview_Pane view (Task 5.3) beside the activity feed so the live
  // preview (same-origin iframe), its lifecycle indicators, the restart control,
  // and the mobile connection URL + QR render in the shell.
  if (client && client.store) {
    const preview = createPreviewPaneView({
      doc,
      store: client.store,
      controller: client.preview,
    });
    main.append(preview.el);
    views.push(preview);
  }

  // Mount the Confirm view (Task 6.1) so a `confirm_request` frame renders its
  // approve/deny controls, stays visible while unanswered (Req 5.3), and is
  // re-displayed idempotently on reconnect replay keyed by requestId (Req 5.4).
  // The controller posts the decision to /confirm; the view reads the
  // store.pendingConfirms slice frames.js populates.
  if (client && client.store && client.confirm) {
    const confirm = createConfirmView({
      doc,
      store: client.store,
      controller: client.confirm,
    });
    main.append(confirm.el);
    views.push(confirm);
  }

  // Mount the project-creation form view (Task 9.1). It is shown ONLY when the
  // user is logged in (a Bearer_Token is held) AND no Project_Session is open —
  // i.e. the workspace-shell entry point between login and the builder screen.
  // On a 201 the controller opens the core builder screen (openSession), which
  // sets session.projectId and thereby hides this form. The form's visibility is
  // driven by a subscription to the auth + session slices so it appears/hides
  // reactively without any imperative navigation here.
  if (client && client.store && client.projects) {
    const projects = createProjectsView({
      doc,
      store: client.store,
      controller: client.projects,
    });
    const gate = doc.createElement('div');
    gate.className = 'projects-gate';
    gate.append(projects.el);
    main.append(gate);

    function applyGate() {
      const state = client.store.getState();
      const loggedIn = !!(state.auth && state.auth.hasToken);
      const sessionOpen = !!(state.session && state.session.projectId);
      // Shown iff logged in AND no session open.
      gate.hidden = !(loggedIn && !sessionOpen);
    }
    // Re-evaluate on any auth or session change. Two subscriptions (one per
    // slice) keep the gate correct whether the token or the session changes.
    const unsubAuth = client.store.subscribe((s) => s.auth, applyGate);
    const unsubSession = client.store.subscribe((s) => s.session, applyGate);
    applyGate();

    views.push({
      el: gate,
      destroy() {
        unsubAuth();
        unsubSession();
        projects.destroy();
        gate.remove();
      },
    });
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
