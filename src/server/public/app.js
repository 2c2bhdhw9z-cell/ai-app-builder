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
import { createWorkspaceController } from './workspace.js';
import { createThemeController } from './theme.js';
import { createWorkModeController } from './work-mode.js';
import { createPromptView } from './views/prompt.js';
import {
  createActivityStreamView,
  connectActivityStream,
} from './views/activity-stream.js';
import { createPreviewPaneView } from './views/preview-pane.js';
import { createConfirmView } from './views/confirm.js';
import { createProjectsView } from './views/projects.js';
import { createLayoutView } from './views/layout.js';
import { createFilePanelView } from './views/file-panel.js';
import { createSessionHeaderView } from './views/session-header.js';
import { createWorkspaceControlsView } from './views/workspace-controls.js';
import { createRouter } from './router.js';
import { createProviderController } from './settings/provider.js';
import { createConnectorsController } from './settings/connectors.js';
import { createSkillsController } from './settings/skills.js';
import { createMemoryController } from './settings/memory.js';
import { createLifecycleController } from './settings/lifecycle.js';
import { createSettingsPanel } from './views/settings/settings-panel.js';

/** The DOM node the client mounts into (declared in index.html). */
const ROOT_ID = 'app';

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
  // The workspace-shell controllers (Tasks 10.1 / 11.1 / 12.1). All three share
  // the SAME store + gated api client so the Bearer flows and every applied
  // frame lands in the one observable state the views read:
  //   - workspace: Workspace_Experience select → POST /workspace-experience,
  //     applied as LAYOUT ONLY (Req 8) — the store reducer enforces non-mutation.
  //   - theme:     the 8-theme catalog + preview/commit/cancel → POST/GET /theme,
  //     applying the palette to document.documentElement's CSSOM (Req 9). In a
  //     browser the styleTarget defaults to the real documentElement.style; a
  //     test injects a recorder.
  //   - workMode:  the Session_Header mode switch → POST /work-mode (Req 10).
  client.workspace = deps.workspace ?? createWorkspaceController({ store, api });
  client.theme = deps.theme ?? createThemeController({ store, api });
  client.workMode = deps.workMode ?? createWorkModeController({ store, api });

  // The settings-surface controllers (Task 14). Each is the LAST-stage feature
  // logic behind a settings screen, all sharing the SAME store + gated api
  // client so the Bearer flows and their non-disclosing notices (re-auth/error)
  // land in the one observable session.notice the settings panel reads. They
  // consume assumed-contract /settings/* endpoints (the exact shapes are not
  // pinned in the requirements glossary) using the IDENTICAL api.js tagged-result
  // contract and non-disclosing error posture as every other surface:
  //   - provider:   list + select the builder's model provider (Req 12).
  //   - connectors: list the catalog grouped by category + configure; a secret is
  //                 sent only over the authorized request and never rendered back
  //                 (Req 13).
  //   - skills:     list stocked + user skills, add/import (Req 14.1/14.2).
  //   - memory:     list project/global entries + active Memory_Mode, edit/prune,
  //                 change mode among auto/manual/off (Req 14.3–14.5).
  //   - lifecycle:  build/deploy/export(download)/lock-in-audit/share (Req 15).
  client.provider = deps.provider ?? createProviderController({ store, api });
  client.connectors = deps.connectors ?? createConnectorsController({ store, api });
  client.skills = deps.skills ?? createSkillsController({ store, api });
  client.memory = deps.memory ?? createMemoryController({ store, api });
  client.lifecycle = deps.lifecycle ?? createLifecycleController({ store, api });

  // The in-client view router (Task 15.1): toggles the SETTINGS panel on top of
  // the logged-in builder/workspace shell. login-vs-builder is derived from the
  // store's auth slice (the login gate wired in Task 8), so a 401 that clears the
  // token via api.js onAccessDenied returns the user to login from the settings
  // surface too (Req 6.7, 16.1). A test may inject its own router.
  client.router = deps.router ?? createRouter({ initial: 'builder' });

  // Per-account presentation bootstrap (Req 8.5, 9.8): the default
  // Workspace_Experience and committed Theme are read ONCE, when a Bearer_Token
  // first becomes held (both endpoints are gated, so they need a token). The
  // experience read must precede the theme read because a Theme is committed per
  // (account, experience) pair, so the theme controller resolves the current
  // experience from the store the workspace read just populated. Guarded so it
  // fires exactly once per login. A test that injects its own controllers can
  // still drive bootstrap() directly.
  if (deps.bootstrapPresentation !== false) {
    let bootstrapped = false;
    const runPresentationBootstrap = async () => {
      if (bootstrapped) return;
      bootstrapped = true;
      try {
        await client.workspace.bootstrap();
        await client.theme.bootstrap();
      } catch {
        // A failed bootstrap leaves the stylesheet :root fallback / default
        // layout in effect; a later frame corrects it. Never throws.
      }
    };
    if (store.getState().auth.hasToken) {
      void runPresentationBootstrap();
    } else if (typeof store.subscribe === 'function') {
      const unsub = store.subscribe((s) => s.auth, (auth) => {
        if (auth && auth.hasToken) {
          unsub();
          void runPresentationBootstrap();
        }
      });
    }
  }
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
  // Read the Session's active Work_Mode + offered choices (Req 10.1/10.2). Until
  // it resolves the store's `vibe` default stands (Req 10.5). Fire-and-forget:
  // the header re-renders reactively when the frame lands.
  if (client.workMode && typeof client.workMode.bootstrap === 'function') {
    void client.workMode.bootstrap();
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

  const views = [];

  // ---- The chat-first workspace shell (Tasks 10.1 / 11.1 / 12.1) ----------
  //
  // The shell is a calm single main column with a persistent slim top header:
  //   - the Session_Header (Task 12.1) is the slim top bar — the active
  //     Work_Mode + a touch-sized switch, plus the experience + theme selectors
  //     (views/workspace-controls.js) and the current experience/theme context.
  //     It is ALWAYS visible, including at 360px (Req 11.4).
  //   - the layout view (Task 10.1) arranges the conversation surfaces
  //     (activityStream, compose=prompt, confirm) in the main column and the
  //     Preview as a secondary panel, per the active Workspace_Experience — and
  //     collapses to ONE column for mobile-command-center / phone widths
  //     (Req 8.3, 11.1). Selecting an experience re-arranges LAYOUT ONLY.
  //
  // Guarded so a minimal test (no collaborators) still renders a shell rather
  // than throwing.
  if (client && client.store) {
    // The conversation compose box (the prompt view) — the chat-first primary.
    const prompt = createPromptView({
      doc,
      store: client.store,
      controller: client.builder,
    });
    views.push(prompt);

    // The live Activity_Stream feed.
    const activity = createActivityStreamView({
      doc,
      store: client.store,
      sse: client.sse,
    });
    views.push(activity);

    // The secondary Preview panel (same-origin iframe + lifecycle + mobile QR).
    const preview = createPreviewPaneView({
      doc,
      store: client.store,
      controller: client.preview,
    });
    views.push(preview);

    // The confirm approvals surface — rendered in the main column so a
    // confirm_request is front-and-centre while unanswered (Req 5.3).
    const confirm = createConfirmView({
      doc,
      store: client.store,
      controller: client.confirm,
    });
    views.push(confirm);

    // The file/tool panel surface (Req 27.2) — the fifth surface the layout
    // descriptors position. It derives its file list from the session's REAL
    // Activity_Stream diff/tool frames (no invented backend route) and shows an
    // explicit empty state until the agent reports touching a file.
    const filePanel = createFilePanelView({
      doc,
      store: client.store,
    });
    views.push(filePanel);

    // The experience + theme selectors (embedded in the header's context).
    const controls = createWorkspaceControlsView({
      doc,
      store: client.store,
      workspace: client.workspace,
      theme: client.theme,
    });
    views.push(controls);

    // The slim top bar: the Work_Mode switch + the embedded controls.
    const sessionHeader = createSessionHeaderView({
      doc,
      store: client.store,
      controller: client.workMode,
      controls,
    });
    views.push(sessionHeader);

    // A wrapper so the compose box + confirm flow in the main column together as
    // one "compose" surface beneath the activity feed.
    const composeWrap = doc.createElement('div');
    composeWrap.className = 'shell__compose';
    composeWrap.append(confirm.el, prompt.el);

    // The layout view arranges ALL FIVE surfaces into the regions the ACTIVE
    // Workspace_Experience's descriptor names, and re-arranges (layout only) on a
    // workspace_experience frame (Req 8.3, 11.1, 27.2). Every surface named in
    // the descriptors is supplied here, so each of the five experiences renders
    // its own real geometry rather than a flattened one.
    const layout = createLayoutView({
      doc,
      store: client.store,
      surfaces: {
        sessionHeader,
        activityStream: activity,
        compose: { el: composeWrap },
        preview,
        filePanel,
      },
    });
    views.push(layout);

    // The settings toggle — a slim, touch-sized control in the header that flips
    // the router between the builder shell and the settings panel (Task 15.1).
    const settingsToggle = doc.createElement('button');
    settingsToggle.id = 'shell-settings-toggle';
    settingsToggle.className = 'shell__settings-toggle';
    settingsToggle.setAttribute('type', 'button');
    settingsToggle.setAttribute('aria-label', 'Settings');
    settingsToggle.textContent = 'Settings';
    if (client.router && typeof client.router.toggleSettings === 'function') {
      settingsToggle.addEventListener('click', () => client.router.toggleSettings());
    }
    // Embed the toggle in the header bar so it is always reachable (incl. 360px).
    sessionHeader.el.append(settingsToggle);

    // The settings panel (Task 14 surfaces). Mounted alongside the builder shell
    // and shown/hidden by the router so switching to settings never tears down
    // the builder state (the SSE stream, the in-flight turn, etc. stay live).
    const settingsPanel = createSettingsPanel({
      doc,
      store: client.store,
      controllers: {
        provider: client.provider,
        connectors: client.connectors,
        skills: client.skills,
        memory: client.memory,
        lifecycle: client.lifecycle,
      },
    });
    views.push(settingsPanel);

    // Route-driven visibility: the builder shell OR the settings panel is shown,
    // never both. When the settings route becomes active the first time, the
    // controllers refresh their lists (list()); the panel re-renders reactively.
    let listsLoaded = false;
    function applyRoute() {
      const route =
        client.router && typeof client.router.getRoute === 'function'
          ? client.router.getRoute()
          : 'builder';
      const showSettings = route === 'settings';
      layout.el.hidden = showSettings;
      settingsPanel.el.hidden = !showSettings;
      settingsToggle.setAttribute('aria-pressed', showSettings ? 'true' : 'false');
      settingsToggle.textContent = showSettings ? 'Close settings' : 'Settings';
      if (showSettings && !listsLoaded) {
        listsLoaded = true;
        // Load each surface's data once on first open (fire-and-forget; the
        // panel re-renders when each controller's surface state updates). A
        // denied read surfaces a non-disclosing re-auth notice via the store.
        for (const ctrl of [client.provider, client.connectors, client.skills, client.memory]) {
          if (ctrl && typeof ctrl.list === 'function') void ctrl.list();
        }
      }
    }
    const unsubRoute =
      client.router && typeof client.router.subscribe === 'function'
        ? client.router.subscribe(applyRoute)
        : () => {};
    applyRoute();

    main.append(layout.el, settingsPanel.el);
    views.push({
      el: settingsToggle,
      destroy() {
        unsubRoute();
      },
    });
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
