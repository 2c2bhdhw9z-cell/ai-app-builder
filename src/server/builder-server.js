/**
 * builder-server.js — the Builder Server (Task 10.1 / 10.2*), the HTTP + SSE
 * SURFACE of ai-app-builder, built on node:http only.
 *
 * This is the process/transport half of the platform's builder surface, in the
 * same spirit as plumby/src/web/server.js (which it deliberately MIRRORS): a
 * zero-dependency node:http server that streams the Activity_Stream to a browser
 * over Server-Sent Events, accepts a user message over POST, and resolves
 * confirm-class command prompts over POST — every response carrying a baseline
 * of security headers applied in one place before routing.
 *
 * What is DIFFERENT from plumby's single-user web surface, and why:
 *
 *   - EVERY request is gated through the AuthService BEFORE it reaches the loop
 *     (Req 7.1, 7.2). An unauthenticated or unauthorized request receives a
 *     GENERIC access-denied indication and NOTHING about a Project's existence
 *     or contents is disclosed. Only after authn + authz does a request touch a
 *     Project Session.
 *
 *   - State is PER PROJECT SESSION, keyed by (authenticated accountId +
 *     projectId), not process-wide. Each session owns its own Builder_Agent, its
 *     own set of SSE clients, its own single in-flight turn, and its own pending
 *     confirm registry. One tenant's turn, prompts, and stream can never reach
 *     another's.
 *
 *   - The confirm hook is wired to the EXISTING CommandGuard consent seam
 *     (src/sandbox/command-guard.js). The guard already awaits a
 *     promise-returning `onConfirmRequest(request)` seam under its own <=60s
 *     ceiling; the server SUPPLIES that seam per session: it registers a
 *     resolver keyed by request.requestId, broadcasts a confirm_request frame to
 *     the session's SSE clients, and returns a promise resolved by POST /confirm
 *     — FAIL-CLOSED, so a disconnect or a never-answered prompt denies. The
 *     guard's contract is untouched.
 *
 * The Builder_Agent reaches plumby ONLY through the boundary module
 * (src/engine/plumby.js): createAgent + buildSystemPrompt build it, toViewEvent
 * projects its loop events onto the stream. Nothing here imports the plumby
 * package directly.
 *
 * The factory returns the http.Server plus helpers so tests can bind an
 * ephemeral port (listen 0) and drive real requests with node's built-in fetch.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  createAgent,
  buildSystemPrompt,
  defaultTools,
  spawnSubagentTool,
  subagentTools,
} from '../engine/plumby.js';
import { createActivityStream } from './activity-stream.js';
import {
  workspaceExperienceLayouts,
  defaultCustomLayout,
  createWorkModeSession,
} from '../presentation/index.js';
import { isValidWorkspaceExperience, isValidTheme, THEME_CATALOG } from '../model/enums.js';

/** Cap on a POST body we will buffer, so a client cannot exhaust memory. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Default bound on how long a confirm-class prompt may sit unanswered. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * Hard cap on a single SSE frame we will broadcast (audit H12). A malformed or
 * pathological view payload (e.g. a binary Buffer that slipped through as
 * {"type":"Buffer","data":[...]}, ~6 bytes of JSON per source byte) could
 * otherwise be serialized in full and pushed to EVERY connected client — a
 * direct OOM path with no backpressure. Any frame over this size is dropped and
 * replaced with a compact notice so the stream stays alive without blowing up.
 */
const MAX_SSE_FRAME_BYTES = 256 * 1024;

/**
 * The baseline security headers every response carries. Pure, so the exact set
 * is unit-testable and cannot drift between routes. Mirrors plumby's
 * securityHeaders(): same-origin CSP (the SSE stream and POST routes are all
 * same-origin), nosniff, no-referrer, no framing, and cross-origin isolation.
 * No Strict-Transport-Security — TLS is terminated by whatever fronts this.
 *
 * @returns {Record<string, string>}
 */
export function securityHeaders() {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
}

/** A single, non-disclosing access-denied body. Never varies by cause. */
const ACCESS_DENIED = { error: 'access denied' };

/**
 * Whether `provider` is a usable plumby provider (audit H13): plumby's
 * createAgent requires a provider exposing complete() and/or stream(). We check
 * the shape here so a misconfigured provider fails fast at construction with a
 * clear message rather than deep inside the loop on the first turn.
 */
function isUsableProvider(provider) {
  return (
    !!provider &&
    typeof provider === 'object' &&
    (typeof provider.complete === 'function' || typeof provider.stream === 'function')
  );
}

/**
 * Project a served-preview handle (from previewController.servedPreview) onto a
 * SAFE, broadcastable preview_status frame (Req 3.1-3.7, Req 4.4). PURE, so the
 * exact shape is unit-testable and cannot drift between the /preview response,
 * the /events reconnection frame, and the /preview/restart broadcast.
 *
 * The served-preview status vocabulary ('none'|'served'|'committed'|
 * 'showing-prior'|'no-preview') is mapped onto the client-facing lifecycle
 * vocabulary ('loading'|'ready'|'error'|'showing_prior'). A 'committed' status
 * (snapshot published but no Dev_Server running yet, so no live url) maps to
 * 'loading' — it is honestly not-yet-ready rather than 'ready'. Only SAFE fields
 * cross the wire:
 * status, snapshotId, url, and a redacted single-line cause SUMMARY — never a
 * raw build cause or secret, consistent with the observability error-frame
 * pattern that broadcasts only a generic userMessage.
 *
 * @param {{ snapshotId:string|null, url:string|null, status:string,
 *           showingPrior:boolean, buildError:string|null }} served
 * @returns {{ type:'preview_status', status:string, snapshotId?:string,
 *            url?:string, showingPrior?:boolean, cause?:string }}
 */
export function previewStatusFrame(served = {}) {
  const status =
    served.status === 'served'
      ? 'ready'
      : served.status === 'showing-prior'
        ? 'showing_prior'
        : served.status === 'no-preview'
          ? 'error'
          : 'loading';

  const frame = { type: 'preview_status', status };
  if (typeof served.snapshotId === 'string') frame.snapshotId = served.snapshotId;
  if (typeof served.url === 'string') frame.url = served.url;
  if (served.showingPrior === true) frame.showingPrior = true;
  // A build error surfaces ONLY as a bounded, single-line safe summary — never
  // the raw cause. This keeps a failed-build cause from leaking secrets/stack.
  if (typeof served.buildError === 'string' && served.buildError.trim() !== '') {
    frame.cause = safePreviewCause(served.buildError);
  }
  return frame;
}

/**
 * Reduce an arbitrary preview cause string to a bounded, single-line SAFE
 * summary suitable for broadcasting. Collapses whitespace/newlines and caps the
 * length so a raw multi-line cause (which could carry a stack or secret) never
 * reaches a client frame verbatim — mirrors the observability redaction spirit.
 */
export function safePreviewCause(cause) {
  const oneLine = String(cause).replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

/**
 * Project a PreviewController.restart(...) result onto a SAFE broadcastable
 * lifecycle frame. A successful restart becomes a 'ready' preview_status; a
 * persistent failure (the 3-attempt cap, code PERSISTENT_FAILURE) becomes a
 * 'persistent_failure' status with restartOffered:false; any other failed
 * attempt becomes an 'error' status carrying restartOffered and a safe cause
 * summary. Never leaks a raw cause.
 *
 * @param {object} result  the previewController.restart(...) result
 * @returns {{ type:'preview_status', status:string, url?:string,
 *            attempt?:number, attempts?:number, restartOffered?:boolean, cause?:string }}
 */
export function restartStatusFrame(result = {}) {
  if (result.ok === true) {
    const frame = { type: 'preview_status', status: 'ready', restartOffered: false };
    if (typeof result.url === 'string') frame.url = result.url;
    if (typeof result.attempt === 'number') frame.attempt = result.attempt;
    return frame;
  }
  if (result.code === 'PERSISTENT_FAILURE') {
    const frame = { type: 'preview_status', status: 'persistent_failure', restartOffered: false };
    if (typeof result.attempts === 'number') frame.attempts = result.attempts;
    if (typeof result.message === 'string') frame.cause = safePreviewCause(result.message);
    return frame;
  }
  const frame = {
    type: 'preview_status',
    status: 'error',
    restartOffered: result.restartOffered === true,
  };
  if (typeof result.attempt === 'number') frame.attempt = result.attempt;
  if (typeof result.message === 'string') frame.cause = safePreviewCause(result.message);
  return frame;
}

/**
 * Project a Workspace_Experience selection onto a SAFE, LAYOUT-ONLY,
 * broadcastable `workspace_experience` frame (spec Task 31, Req 27, Property 20).
 * PURE, so the exact shape is unit-testable and cannot drift between the POST
 * /workspace-experience response, the SSE broadcast, and the /events
 * reconnection frame.
 *
 * The frame carries ONLY layout/organization data: the selected `experience`
 * name and its `layout` descriptor (which surfaces are shown and where). For the
 * `technical-workbench` experience the layout descriptor already carries a
 * presentational, non-affiliated `attribution` credit as DATA (Req 27.8); when
 * an `attribution` is supplied it is surfaced on the frame verbatim. There is
 * structurally NOTHING here that could change a Theme, a Work_Mode, source code,
 * agent state, Project data, models, Skills, Connectors, permissions, or
 * Project_Origin (Req 27.2/27.3, Property 20) — it re-parametrizes layout only.
 *
 * @param {{ experience:string, layout:object, attribution?:string }} args
 * @returns {{ type:'workspace_experience', experience:string, layout:object, attribution?:string }}
 */
export function workspaceExperienceFrame({ experience, layout, attribution } = {}) {
  const frame = { type: 'workspace_experience', experience, layout };
  if (typeof attribution === 'string' && attribution !== '') {
    frame.attribution = attribution;
  } else if (layout && typeof layout.attribution === 'string' && layout.attribution !== '') {
    // A layout descriptor may itself carry the presentational credit as data
    // (the technical-workbench case). Surface it so a client can render it.
    frame.attribution = layout.attribution;
  }
  return frame;
}

/**
 * Project a per-Session Work_Mode onto a SAFE, broadcastable `work_mode` frame
 * (spec Task 32, Req 28, Property 21). PURE, so the exact shape is unit-testable
 * and cannot drift between the GET/POST /work-mode responses, the SSE broadcast,
 * and the /events reconnection frame — mirrors how workspaceExperienceFrame is
 * written and re-exported.
 *
 * The frame carries ONLY interaction-flow data: the active `mode` and the three
 * offerable `choices` at Session creation (Req 28.2/28.4). There is structurally
 * NOTHING here that could change source code, agent state, Project data,
 * Snapshots, models, Skills, Connectors, permissions, Project_Origin, Theme, or
 * Workspace_Experience (Req 28.6) — it re-parametrizes the next turn's flow only.
 *
 * @param {{ mode:string, choices?:string[] }} args
 * @returns {{ type:'work_mode', mode:string, choices:string[] }}
 */
export function workModeFrame({ mode, choices } = {}) {
  return {
    type: 'work_mode',
    mode,
    choices: Array.isArray(choices) ? [...choices] : [],
  };
}

/**
 * Project a Session's observable header onto a SAFE, broadcastable
 * `session_header` frame (spec Task 32, Req 28.4). PURE. WHILE a Session is
 * active, the ACTIVE Work_Mode is ALWAYS present on the Session_Header so a
 * (re)connecting client can always render it. Carries only the active `mode` and
 * the offerable `choices` — no Project state. Kept alongside workModeFrame so the
 * header shape cannot drift between the POST /work-mode response, the SSE
 * broadcast, and the /events reconnection frame.
 *
 * @param {{ mode:string, choices?:string[] }} args
 * @returns {{ type:'session_header', workMode:string, workModeChoices:string[] }}
 */
export function sessionHeaderFrame({ mode, choices } = {}) {
  return {
    type: 'session_header',
    workMode: mode,
    workModeChoices: Array.isArray(choices) ? [...choices] : [],
  };
}

/**
 * Project a named color Theme onto a SAFE, broadcastable `theme` frame (spec
 * Task 33, Req 29, Property 22). PURE, so the exact shape is unit-testable and
 * cannot drift between the GET/POST /theme responses, the SSE broadcast, and the
 * /events reconnection frame — mirrors how workspaceExperienceFrame/workModeFrame
 * are written and re-exported.
 *
 * The frame carries ONLY visual data: the selected `theme` id, its rendered
 * `palette` (the frozen color map from THEME_CATALOG), whether this is an
 * UNCOMMITTED preview vs a committed value (`previewed`), and which
 * `workspaceExperience` the theme applies to (a Theme is committed per
 * (User_Account, Workspace_Experience) pair, Req 29.2/29.3). There is
 * structurally NOTHING here that could change source code, agent state, Project
 * data, Snapshots, models, Skills, Connectors, permissions, Work_Mode,
 * Project_Origin, the Workspace_Experience layout, or ANOTHER experience's
 * committed Theme (Req 29.6, Property 22) — it re-parametrizes surface colors
 * only, and a `previewed:true` frame is reversible (the committed value in the
 * store is untouched).
 *
 * @param {{ theme:string, palette:object, previewed?:boolean, experience:string }} args
 * @returns {{ type:'theme', theme:string, palette:object, previewed:boolean, workspaceExperience:string }}
 */
export function themeFrame({ theme, palette, previewed, experience } = {}) {
  return {
    type: 'theme',
    theme,
    palette,
    previewed: previewed === true,
    workspaceExperience: experience,
  };
}

/**
 * Create the Builder Server.
 *
 * @param {object} opts
 * @param {object} [opts.provider]    a plumby PROVIDER (from src/engine/plumby.js:
 *        createAnthropicProvider / createGeminiProvider / createOpenRouterProvider,
 *        or createScriptedProvider in tests). REQUIRED when no agentFactory is
 *        injected: the default agent path builds a plumby agent, which throws
 *        without a provider (audit H13). Construction fails fast if neither is
 *        supplied, rather than 500ing on the first POST /message.
 * @param {string} [opts.model]       optional model id threaded onto the default
 *        agent build (falls back to the provider's own default).
 * @param {object} opts.authService   the AuthService gate (src/auth). Required:
 *        provides tryVerifySession(token) and authorize(account, action,
 *        resource, context) — the single authn + authz choke point.
 * @param {(args: { projectId: string, accountId: string, cwd: string, onEvent: Function, commandGuard?: object, onConfirmRequest: Function }) => { agent: object }} [opts.agentFactory]
 *        builds the Builder_Agent for a Project Session. Injectable so tests
 *        drive a scripted agent; the default builds a plumby agent through the
 *        boundary with cwd = the Project tree. `onConfirmRequest` is the session's
 *        fail-closed confirm seam to hand the CommandGuard so a confirm-class
 *        command reaches this server's POST /confirm.
 * @param {object} [opts.sandboxManager]  a SandboxManager whose acquire(projectId)
 *        yields the Sandbox handle (mountSource = the Project tree host path).
 * @param {object} [opts.observability]   an OPTIONAL Observability instance
 *        (src/ops/observability.js). When present, a platform-level turn failure
 *        calls observability.reportError(account, op, cause) to mint a
 *        correlationId + record a redacted operational entry, and the server
 *        broadcasts a user-facing `error` frame on the Activity_Stream/SSE
 *        carrying ONLY the correlationId + generic userMessage (never the raw
 *        cause). Optional and back-compatible: with no observability injected the
 *        existing turn_done error fallback is unchanged.
 * @param {object} [opts.quotaManager]    an OPTIONAL QuotaManager (src/ops/quota-manager.js).
 *        When present, its checkRate/checkQuota gate runs in POST /message AFTER
 *        gate() (authn+authz) succeeds and BEFORE any allocation (session,
 *        agent, sandbox acquire), so an over-limit request allocates NOTHING and
 *        is refused with an HTTP 429 whose body NAMES the exceeded limit. When
 *        absent, behaviour is unchanged (backward compatible). The gate never
 *        runs before auth passes, so an unauthenticated over-limit request still
 *        receives the generic access-denied — no limit disclosure before auth.
 * @param {object} [opts.layout]          a StorageLayout, for exportableProjectTree.
 * @param {object} [opts.commandGuard]    the CommandGuard the agent's commands go
 *        through; the server supplies its onConfirmRequest seam per session.
 * @param {(projectId: string) => (object|null|Promise<object|null>)} [opts.projectResolver]
 *        resolves a projectId to a control-plane project record { id, ownerId }
 *        for the authorization check. Returning null denies WITHOUT disclosure.
 *        A ProjectRegistry's resolver (src/project/project-registry.js) is the
 *        natural production wiring here — see opts.projectManager.
 * @param {object} [opts.projectManager]  an OPTIONAL ProjectManager (src/project/
 *        project-manager.js). When present, a POST /projects route is enabled that
 *        runs the EXISTING gate() authn (no projectId yet, so authn only), then
 *        the EXISTING QuotaManager gate for the 'project.create' operation
 *        (checkRate) BEFORE invoking projectManager.createProject — returning 400
 *        with the specific message on validation rejection, 429 naming the limit
 *        on quota/rate rejection, and 201 with the created project id on success.
 *        This is STRICTLY ADDITIVE: with no projectManager injected the server
 *        behaves exactly as before and the /events, /message, /confirm routes are
 *        unchanged. (When a ProjectRegistry's resolver is wired as projectResolver
 *        above, that satisfies the open "real projectResolver" review finding.)
 * @param {object} [opts.previewController]  an OPTIONAL PreviewController
 *        (src/project/preview-controller.js). When present, two STRICTLY
 *        ADDITIVE routes are enabled — GET /preview (the current served Preview
 *        handle for an authenticated+authorized session) and POST /preview/restart
 *        (restart the Dev_Server, capped at 3 attempts before a persistent
 *        failure) — and the Preview lifecycle status is broadcast on the SAME
 *        per-session SSE stream as the Activity_Stream, so a client can render the
 *        reasoning feed and the running-preview status side by side (Req 4.4,
 *        Req 3.1-3.7). A (re)connecting /events client also receives the CURRENT
 *        preview_status frame among its reconnection frames. Only SAFE summaries
 *        (status, snapshotId, url, a redacted cause string) ever reach a broadcast
 *        frame — never a raw cause or secret, mirroring the observability
 *        error-frame pattern. With NO previewController injected, the /preview and
 *        /preview/restart routes are NOT routed and every existing route/behavior
 *        is byte-identical (backward compatible).
 * @param {object} [opts.workspaceExperienceStore]  an OPTIONAL
 *        WorkspaceExperienceStore (src/presentation/workspace-experience-store.js).
 *        When present, two STRICTLY ADDITIVE, LAYOUT-ONLY routes are enabled —
 *        GET /workspace-experience (read the current per-User_Account
 *        Workspace_Experience + its resolved layout descriptor) and POST
 *        /workspace-experience (select/switch it, or save a `custom` layout) —
 *        and the selection is broadcast as a layout-only `workspace_experience`
 *        frame on the SAME per-session SSE stream as the Activity_Stream so the
 *        surface re-arranges immediately (Req 27, Property 20). Presentation is
 *        PER-ACCOUNT (not per-project): both routes gate on AUTHN ONLY via the
 *        existing gate(req, null) and touch NO Project. This surface is
 *        structurally incapable of mutating Project state or enqueuing a loop
 *        turn: it NEVER calls session.agent.send, NEVER sets session.running,
 *        and NEVER touches any Project file or agent state — it carries ONLY
 *        layout/organization data (plus the technical-workbench presentational
 *        credit as data). A (re)connecting /events client also learns the
 *        current workspace_experience frame among its reconnection frames so a
 *        later Session re-applies the layout (Req 27.5). With NO store injected,
 *        neither route is routed and every existing route/behavior is
 *        byte-identical (backward compatible).
 * @param {object} [opts.themeStore]  an OPTIONAL ThemeStore
 *        (src/presentation/theme-store.js). When present, two STRICTLY ADDITIVE,
 *        VISUALS-ONLY routes are enabled — GET /theme (read the current
 *        committed Theme + its palette for a (User_Account, Workspace_Experience)
 *        pair) and POST /theme (a two-step { action:'preview'|'commit' }
 *        interaction) — and the result is broadcast as a visuals-only `theme`
 *        frame on the SAME per-session SSE stream as the Activity_Stream so the
 *        surface recolors immediately (Req 29, Property 22). A Theme is committed
 *        per (User_Account, Workspace_Experience) pair; the experience is taken
 *        from the request or, when omitted and a workspaceExperienceStore is
 *        injected, defaulted to that account's CURRENT Workspace_Experience.
 *        Presentation is PER-ACCOUNT (not per-project): both routes gate on
 *        AUTHN ONLY via the existing gate(req, null) and touch NO Project.
 *        A PREVIEW is REVERSIBLE and NON-PERSISTING: it sets per-session
 *        `themePreview` state + broadcasts a `previewed:true` frame and writes
 *        NOTHING (Req 29.4). A COMMIT is the ONLY writer: it persists via
 *        themeStore.commit, clears the per-session preview, and broadcasts a
 *        `previewed:false` frame (Req 29.4/29.5). An out-of-catalog Theme (on
 *        preview OR commit) is refused 400 { code:'unsupported_theme' } with the
 *        current committed Theme left in effect and NO write and NO preview
 *        (Req 29.8). This surface is structurally incapable of mutating Project
 *        state or enqueuing a loop turn: it NEVER calls session.agent.send,
 *        NEVER sets session.running, and has NO code path to Project data or any
 *        non-theme setting — selecting/switching a Workspace_Experience never
 *        changes any committed Theme, and committing one experience's Theme
 *        never changes another's (Req 29.6/29.7). A (re)connecting /events client
 *        also learns the CURRENT COMMITTED theme frame (previewed:false) for the
 *        account's current experience so a later Session re-applies it (Req 29.5);
 *        a live preview is NOT inherited as committed. With NO themeStore
 *        injected, neither route is routed and every existing route/behavior is
 *        byte-identical (backward compatible).
 * @param {number} [opts.confirmTimeoutMs=60000]  fail-closed confirm ceiling.
 * @param {() => number} [opts.now]       injectable clock.
 * @returns {object} frozen server handle.
 */
export function createBuilderServer(opts = {}) {
  const {
    authService,
    agentFactory,
    sandboxManager,
    layout,
    commandGuard,
    projectResolver,
    quotaManager,
    projectManager,
    observability,
    previewController,
    workspaceExperienceStore,
    themeStore,
    provider,
    model,
    confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
    now = () => Date.now(),
  } = opts;

  if (!authService || typeof authService.tryVerifySession !== 'function') {
    throw new TypeError('createBuilderServer requires an authService with tryVerifySession()');
  }

  // FAIL FAST at construction (audit H13): the default agent path calls plumby's
  // createAgent, which THROWS without a provider. Previously that throw happened
  // mid-request on the first POST /message (a 500 for every default wiring). If
  // no agentFactory is injected, a provider MUST be supplied here so the failure
  // surfaces at construction, not per-request. A `model` is threaded onto the
  // agent build. Tests inject agentFactory (scripted), so they need no provider.
  if (typeof agentFactory !== 'function' && !isUsableProvider(provider)) {
    throw new TypeError(
      'createBuilderServer requires either an agentFactory or a provider ' +
        '(the default agent path builds a plumby agent, which needs a provider). ' +
        'Pass opts.provider (e.g. createAnthropicProvider from src/engine/plumby.js) or opts.agentFactory.',
    );
  }

  const buildAgent = typeof agentFactory === 'function' ? agentFactory : defaultAgentFactory;

  /** Computed once; identical on every response. */
  const baselineHeaders = securityHeaders();

  /**
   * The ActivityStream mapping (spec Task 11.1): the pure projection from core
   * loop events to the rich Activity_Stream frames broadcast over SSE. It wraps
   * plumby's toViewEvent through the engine boundary and adds the binary
   * write_file guard. Constructed once (it is pure and stateless) and reused by
   * every session's onEvent. Kept without a readFileSync so a write_file renders
   * exactly as the prior direct toViewEvent call did (an all-green "new file");
   * the seam is available to wire a real before/after reader in a later task.
   */
  const activityStream = createActivityStream();

  /**
   * Project Sessions, keyed by `${accountId}::${projectId}`. Each is lazily
   * created on first authenticated+authorized touch and holds everything scoped
   * to that (account, project) pair — see makeSession().
   */
  const sessions = new Map();

  function sessionKey(accountId, projectId) {
    return `${accountId}::${projectId}`;
  }

  /** Total pending confirms across all sessions (for tests / introspection). */
  function pendingCount() {
    let total = 0;
    for (const s of sessions.values()) total += s.pendingConfirms.size;
    return total;
  }

  // ---------------------------------------------------------- session state

  /**
   * Build the per-Project-Session record. `cwd` is the Project tree inside its
   * Sandbox (resolved from the SandboxManager handle or the StorageLayout when
   * provided). The Builder_Agent is constructed lazily on the first turn so a
   * mere /events connection does not spin one up.
   */
  function makeSession(accountId, projectId) {
    const session = {
      accountId,
      projectId,
      agent: null,
      /** The turn currently running, or null. One in-flight turn per session. */
      running: null,
      /** Live SSE client responses for THIS session. */
      sseClients: new Set(),
      /** Pending confirm-class approvals: requestId -> resolve(boolean). */
      pendingConfirms: new Map(),
      /** Display payloads for pending confirms, re-broadcast on reconnect. */
      pendingConfirmPayloads: new Map(),
      /**
       * The per-Session active Work_Mode (spec Task 32, Req 28). A NEW Session
       * defaults to 'vibe' (Req 28.3). This is pure interaction-FLOW state that
       * shapes only the NEXT turn's prompt/flow and holds ONLY the mode string
       * (+ a pending switch target) — it has NO path to any Project state
       * (Req 28.6). It persists NO Project data.
       */
      workMode: createWorkModeSession({ now: () => new Date(now()) }),
      /**
       * The per-Session UNCOMMITTED Theme preview (spec Task 33, Req 29.4), or
       * null. A PREVIEW sets this to { experience, theme }; a COMMIT or a
       * cancel/navigate-away clears it back to null. This is per-surface,
       * uncommitted, REVERSIBLE visual state — the committed Theme lives ONLY in
       * the ThemeStore (the store is the sole writer, Req 29.4/29.5). It holds
       * only two strings and has NO path to any Project state (Req 29.6).
       */
      themePreview: null,
    };

    /** Send a raw view payload to every SSE client of THIS session. */
    session.broadcast = (payload) => {
      if (!payload) return;
      let body = JSON.stringify(payload);
      // Cap total frame size (audit H12): never broadcast an oversized frame to
      // every client. Replace it with a compact, typed notice carrying only the
      // event type and the dropped byte count — never the offending content.
      if (typeof body === 'string' && body.length > MAX_SSE_FRAME_BYTES) {
        body = JSON.stringify({
          type: typeof payload.type === 'string' ? payload.type : 'frame',
          truncated: true,
          notice: `[frame dropped: ${body.length} bytes exceeds ${MAX_SSE_FRAME_BYTES}-byte cap]`,
        });
      }
      const frame = `data: ${body}\n\n`;
      for (const res of session.sseClients) {
        try {
          res.write(frame);
        } catch {
          session.sseClients.delete(res);
        }
      }
    };

    /** Map a core loop event to an Activity_Stream frame and broadcast it. */
    session.onEvent = (event) => {
      const view = activityStream.toFrame(event);
      if (view) session.broadcast(view);
    };

    /**
     * Broadcast a Preview lifecycle status on THIS session's SSE stream — the
     * SAME stream the Activity_Stream flows on, so the reasoning feed and the
     * running-preview status are presented CONCURRENTLY (Req 4.4). The argument
     * is either a served-preview handle (projected onto a SAFE preview_status
     * frame) or an already-projected typed frame (e.g. a preview_mobile frame).
     * Only SAFE summaries reach the wire — never a raw cause/secret. This is the
     * per-session hook the PreviewController's status changes flow through,
     * mirroring how session.onEvent forwards activity frames.
     */
    session.broadcastPreview = (statusOrFrame) => {
      if (!statusOrFrame) return;
      // An already-typed frame (has a `type`) is broadcast as-is; a raw served
      // handle is projected onto the SAFE preview_status frame first.
      const frame =
        typeof statusOrFrame.type === 'string'
          ? statusOrFrame
          : previewStatusFrame(statusOrFrame);
      session.broadcast(frame);
    };

    /**
     * The confirm consent seam handed to the CommandGuard for THIS session. The
     * guard calls it with a request carrying a requestId; we register a resolver,
     * broadcast a confirm_request frame, and return a promise the POST /confirm
     * route (or the fail-closed timeout / last-client-disconnect) resolves.
     *
     * FAIL-CLOSED: no watcher, a disconnect, or an unanswered prompt all deny.
     * Resolve-once so a POST, a disconnect, and the timeout can race safely.
     *
     * @param {{ requestId?: string, command?: any, category?: string, reason?: string }} request
     * @returns {Promise<boolean>}
     */
    session.onConfirmRequest = (request = {}) => {
      const requestId = request.requestId ?? randomUUID();
      return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const settle = (allow) => {
          if (settled) return;
          settled = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          session.pendingConfirms.delete(requestId);
          session.pendingConfirmPayloads.delete(requestId);
          resolve(allow === true);
        };
        session.pendingConfirms.set(requestId, settle);

        const payload = {
          type: 'confirm_request',
          requestId,
          command: request.command ?? '',
          category: request.category ?? '',
          reason: request.reason ?? '',
        };
        session.pendingConfirmPayloads.set(requestId, payload);
        session.broadcast(payload);

        // No one is watching this session's stream: no one can answer. Deny
        // promptly rather than pin a turn behind a prompt that will never show.
        if (session.sseClients.size === 0) {
          settle(false);
          return;
        }

        // A connected-but-silent client would otherwise pin the turn forever.
        // Bound the wait and DENY on expiry, consistent with fail-closed.
        if (confirmTimeoutMs > 0) {
          timer = setTimeout(() => {
            session.broadcast({ type: 'confirm_timeout', requestId });
            settle(false);
          }, confirmTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }
      });
    };

    /** Deny every outstanding approval for this session — fail-closed. */
    session.denyAllPending = () => {
      for (const settle of [...session.pendingConfirms.values()]) settle(false);
    };

    return session;
  }

  /** Get or lazily create the Project Session for (account, project). */
  function sessionFor(accountId, projectId) {
    const key = sessionKey(accountId, projectId);
    let session = sessions.get(key);
    if (!session) {
      session = makeSession(accountId, projectId);
      sessions.set(key, session);
    }
    return session;
  }

  /**
   * Resolve the Project tree cwd for a session's Builder_Agent. Prefer the live
   * Sandbox handle's mount source; fall back to the StorageLayout's exportable
   * project tree; finally the process cwd (a scripted test agent ignores it).
   */
  function projectCwd(projectId) {
    if (sandboxManager && typeof sandboxManager.acquire === 'function') {
      const handle = sandboxManager.acquire(projectId);
      if (handle && (handle.mountSource || handle.workspacePath)) {
        return handle.mountSource ?? handle.workspacePath;
      }
    }
    if (layout && typeof layout.exportableProjectTree === 'function') {
      return layout.exportableProjectTree(projectId);
    }
    return process.cwd();
  }

  /**
   * The DEFAULT Builder_Agent factory: a real plumby agent built through the
   * boundary, with the full default toolset + spawn_subagent and the read-only
   * sub-agent bundle, working in the Project tree. Command execution is expected
   * to flow through the injected CommandGuard, whose confirm seam this session
   * supplies; if a guard is present its onConfirmRequest is threaded onto the
   * agent's confirm hook so a confirm-class command reaches this server.
   */
  function defaultAgentFactory({ cwd, onEvent, onConfirmRequest }) {
    // A provider is REQUIRED (audit H13): createAgent throws without one. The
    // server construction already guaranteed a usable provider exists when no
    // agentFactory was injected, so this cannot be reached without one.
    // Confirm wiring (audit H13): plumby's confirm hook is named `confirm` and
    // takes ({ command, category, reason }) -> Promise<boolean>. We thread THIS
    // session's onConfirmRequest onto it, so a confirm-class command in the
    // default wiring reaches this server's POST /confirm round-trip instead of
    // being silently denied by plumby's no-hook default. When no seam is
    // supplied, plumby's safe default (deny confirm-class) still applies.
    const agent = createAgent({
      cwd,
      provider,
      ...(typeof model === 'string' && model !== '' ? { model } : {}),
      system: buildSystemPrompt({ cwd }),
      tools: [...defaultTools, spawnSubagentTool],
      subagentTools,
      subagentProvider: provider,
      onEvent,
      ...(typeof onConfirmRequest === 'function' ? { confirm: onConfirmRequest } : {}),
    });
    return { agent };
  }

  // ------------------------------------------------------------- auth gate

  /**
   * Extract a bearer/session token from the request. Accepts a standard
   * `Authorization: Bearer <token>` header (the documented shape).
   */
  function tokenFrom(req) {
    const header = req.headers['authorization'];
    if (typeof header !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    return m ? m[1].trim() : null;
  }

  /**
   * Gate a request: verify the session token, then (when a projectId is given)
   * authorize the account for that Project. Returns { account } on success or
   * { denied: true } — the caller replies with a single, non-disclosing
   * access-denied indication for EITHER failure, so an unauthenticated request
   * and an unauthorized-project request are indistinguishable to a client.
   *
   * @returns {Promise<{ account: { id: string } } | { denied: true }>}
   */
  async function gate(req, projectId) {
    const token = tokenFrom(req);
    if (!token) return { denied: true };
    const claims = authService.tryVerifySession(token);
    if (!claims || typeof claims.accountId !== 'string') return { denied: true };

    const account = { id: claims.accountId };

    if (projectId != null) {
      // Authorize the {projectId} action for this account. A project the account
      // may not touch (or that does not resolve) yields the SAME access-denied
      // as an unauthenticated request — no existence/contents disclosure.
      let resource = { id: projectId, ownerId: account.id };
      if (typeof projectResolver === 'function') {
        const resolved = await projectResolver(projectId);
        if (!resolved) return { denied: true };
        resource = resolved;
      }
      const decision = authService.authorize(account, 'write', resource, {});
      if (!decision || decision.ok !== true) return { denied: true };
    }

    return { account };
  }

  // --------------------------------------------------------------- http server

  const server = http.createServer((req, res) => {
    // Baseline security headers on EVERY response — set before any route runs so
    // a new route cannot forget them. setHeader() before writeHead(): a route's
    // own content-type / SSE headers still win.
    for (const [name, value] of Object.entries(baselineHeaders)) res.setHeader(name, value);

    handle(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end(`internal error: ${err?.message ?? err}`);
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    // Unauthenticated readiness probe (deploy/uptime checks). Placed BEFORE the
    // auth-gated routes so a container host or load balancer can poll readiness
    // without credentials. Discloses nothing sensitive: a fixed, minimal body.
    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (req.method === 'GET' && pathname === '/events') return handleEvents(req, res);
    if (req.method === 'POST' && pathname === '/message') return handleMessage(req, res);
    if (req.method === 'POST' && pathname === '/confirm') return handleConfirm(req, res);
    // Strictly additive: only enabled when a ProjectManager is injected.
    if (projectManager && req.method === 'POST' && pathname === '/projects') {
      return handleCreateProject(req, res);
    }
    // Strictly additive: the Preview surface is only routed when a
    // PreviewController is injected (Req 4.4, Req 3.1-3.7). With none injected,
    // these paths fall through to 405 exactly as an unknown route always has.
    if (previewController && req.method === 'GET' && pathname === '/preview') {
      return handlePreview(req, res);
    }
    if (previewController && req.method === 'POST' && pathname === '/preview/restart') {
      return handlePreviewRestart(req, res);
    }
    // Strictly additive: the layout-only Workspace_Experience surface is only
    // routed when a WorkspaceExperienceStore is injected (Req 27, Property 20).
    // With none injected these paths fall through to 405 exactly as an unknown
    // route always has. Presentation is per-account, so both routes are authn
    // only and touch no Project.
    if (workspaceExperienceStore && req.method === 'GET' && pathname === '/workspace-experience') {
      return handleGetWorkspaceExperience(req, res);
    }
    if (workspaceExperienceStore && req.method === 'POST' && pathname === '/workspace-experience') {
      return handleSelectWorkspaceExperience(req, res);
    }
    // Strictly additive: the visuals-only Theme surface is only routed when a
    // ThemeStore is injected (spec Task 33, Req 29, Property 22). With none
    // injected these paths fall through to 405 exactly as an unknown route
    // always has. Presentation is per-account, so both routes are authn only and
    // touch no Project.
    if (themeStore && req.method === 'GET' && pathname === '/theme') {
      return handleGetTheme(req, res);
    }
    if (themeStore && req.method === 'POST' && pathname === '/theme') {
      return handleTheme(req, res);
    }
    // The per-Session Work_Mode surface (spec Task 32, Req 28). Work_Mode is a
    // CORE Session capability (every Session has one, defaulting to 'vibe'), so
    // these routes are always available — unlike the per-account
    // Workspace_Experience surface behind an injected store. They are STRICTLY
    // ADDITIVE: no existing route byte changes, and both gate on FULL auth for a
    // projectId (a Session is (accountId, projectId)) exactly like
    // /events/message/confirm.
    if (req.method === 'GET' && pathname === '/work-mode') {
      return handleGetWorkMode(req, res);
    }
    if (req.method === 'POST' && pathname === '/work-mode') {
      return handleSwitchWorkMode(req, res);
    }

    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
    res.end('method not allowed');
  }

  // -------- POST /projects (create) — only routed when a ProjectManager is injected

  /**
   * Create a Project. Reuses the EXISTING gate ordering: gate() authn (there is
   * no projectId yet, so authn only), then the EXISTING QuotaManager gate for the
   * 'project.create' operation (checkRate) BEFORE any allocation, then delegates
   * to projectManager.createProject (which itself enforces the totalProjects
   * Resource_Quota behind this gate and allocates the Sandbox). Never duplicates
   * the gate. Responses: 400 (validation) / 429 (rate|quota, naming the limit) /
   * 201 (created, with the project id). An unauthenticated request receives the
   * generic access-denied — no limit disclosed before auth.
   */
  async function handleCreateProject(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    // AUTH GATE (authn only — no projectId exists yet at create time).
    const result = await gate(req, null);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    // RATE-LIMIT GATE for 'project.create' — AFTER authn, BEFORE any allocation.
    if (quotaManager && typeof quotaManager.checkRate === 'function') {
      const rate = quotaManager.checkRate(result.account, 'project.create');
      if (rate && rate.ok === false) {
        return sendJson(res, 429, {
          error: rate.message ?? 'rate limit exceeded',
          limit: rate.limit,
          operation: rate.operation,
        });
      }
    }

    // Delegate to the ProjectManager (validation + totalProjects quota + acquire).
    const created = projectManager.createProject({
      accountId: result.account.id,
      description: body?.description,
      targetCategory: body?.targetCategory,
      origin: body?.origin,
      ref: typeof body?.ref === 'string' ? body.ref : undefined,
    });

    if (created && created.ok === false) {
      // A Resource_Quota rejection (totalProjects OR concurrentSandboxes) is a
      // 429 naming the limit; a post-registration Sandbox-acquire failure is a
      // 503 (the create was rolled back, so it is retryable); every other
      // rejection (validation) is a 400 with the specific message.
      if (created.code === 'QUOTA_EXCEEDED') {
        return sendJson(res, 429, {
          error: created.message,
          limit: created.limit,
          resource: created.resource,
        });
      }
      if (created.code === 'SANDBOX_ACQUIRE_FAILED') {
        return sendJson(res, 503, { error: created.message, code: created.code });
      }
      return sendJson(res, 400, { error: created.message, code: created.code });
    }

    return sendJson(res, 201, { id: created.project.id, project: created.project });
  }

  // -------- GET /preview — only routed when a PreviewController is injected

  /**
   * Return the current served Preview handle for an authenticated + authorized
   * (accountId, projectId) session (Req 3.1, 3.3, 3.4; Req 16.4/16.5 shape).
   * Reuses the EXISTING gate() so an unauthenticated OR unauthorized-project
   * request receives the IDENTICAL non-disclosing 401 ACCESS_DENIED — no Project
   * existence/contents disclosure. Requires the projectId query param exactly as
   * handleEvents does (400 when missing). The handle is exactly what
   * previewController.servedPreview(projectId) returns (snapshotId, url, status,
   * showingPrior, buildError-as-safe-summary is not applied here — the raw
   * handle is returned only to an authorized owner over the same-origin surface;
   * the SAFE summary is applied only to BROADCAST frames).
   */
  async function handlePreview(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const projectId = url.searchParams.get('projectId');
    if (!projectId) return sendJson(res, 400, { error: "a 'projectId' query parameter is required" });

    const result = await gate(req, projectId);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const served = previewController.servedPreview(projectId);
    return sendJson(res, 200, { preview: served });
  }

  // -------- POST /preview/restart — only routed when a PreviewController is injected

  /**
   * Restart the Dev_Server for an authenticated + authorized session (Req 3.7).
   * Reuses the EXISTING gate() (identical non-disclosing 401 on denial) and the
   * EXISTING projectCwd/sandboxManager wiring to resolve the Sandbox handle,
   * never duplicating either. Delegates to previewController.restart({projectId,
   * sandbox, targetCategory}); the restart cap (exactly 3 attempts) and its
   * persistent-failure result are OWNED by the controller — this route only
   * surfaces the result as JSON and broadcasts the resulting lifecycle status
   * frame to the session's SSE clients so the Activity_Stream and Preview stay
   * concurrent (Req 4.4). Only a SAFE summary reaches the broadcast frame.
   */
  async function handlePreviewRestart(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    if (!projectId) return sendJson(res, 400, { error: "a 'projectId' field is required" });

    const result = await gate(req, projectId);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    // Resolve the Sandbox handle through the SAME wiring the Builder_Agent uses
    // (reuse, do not duplicate). A missing SandboxManager simply yields an
    // undefined handle; the controller/dev-server seam tolerates that.
    const sandbox =
      sandboxManager && typeof sandboxManager.acquire === 'function'
        ? sandboxManager.acquire(projectId)
        : undefined;
    const targetCategory = typeof body?.targetCategory === 'string' ? body.targetCategory : undefined;

    const restart = previewController.restart({ projectId, sandbox, targetCategory });

    // Broadcast the lifecycle status on the SAME per-session SSE stream as the
    // Activity_Stream so a client observing the reasoning feed also sees the
    // preview status update (Req 4.4). Only a SAFE summary is broadcast.
    const session = sessionFor(result.account.id, projectId);
    session.broadcast(restartStatusFrame(restart));

    return sendJson(res, 200, { restart });
  }

  // -------- Workspace_Experience surface — only routed when a store is injected

  /**
   * Resolve the LAYOUT-ONLY descriptor for a Workspace_Experience selection from
   * the store's full UserPresentationSettings document. For `custom` this is the
   * user's saved arrangement (settings.customLayout) or the documented
   * defaultCustomLayout when they have not arranged one yet (Req 27.4); for every
   * other experience it is the platform's own clean-room descriptor from
   * workspaceExperienceLayouts. Pure lookup — carries only layout/organization
   * data (plus the technical-workbench presentational credit as data).
   */
  function layoutForSettings(settings) {
    const experience = settings.workspaceExperience;
    if (experience === 'custom') {
      const saved = settings.customLayout;
      return saved && typeof saved === 'object' && !Array.isArray(saved)
        ? saved
        : defaultCustomLayout;
    }
    return workspaceExperienceLayouts[experience] ?? defaultCustomLayout;
  }

  /**
   * Broadcast a layout-only workspace_experience frame to EVERY live session
   * whose accountId matches (presentation is per-User_Account, so it applies
   * across that account's Project Sessions). This reuses the EXISTING per-session
   * session.broadcast SSE mechanism and enqueues NO turn: it NEVER calls
   * session.agent.send and NEVER sets session.running. A no-op when the account
   * has no live sessions (a later /events connect re-applies via the
   * reconnection frame set).
   */
  function broadcastWorkspaceExperience(accountId, frame) {
    for (const session of sessions.values()) {
      if (session.accountId === accountId) session.broadcast(frame);
    }
  }

  /**
   * GET /workspace-experience — read the current per-User_Account
   * Workspace_Experience selection + its resolved layout descriptor for the
   * AUTHENTICATED account (Req 27.1/27.5/27.6). Presentation is per-account, so
   * this gates on AUTHN ONLY via the EXISTING gate(req, null) — no projectId, no
   * Project touched. On denial it replies with the IDENTICAL non-disclosing 401
   * ACCESS_DENIED the other routes use. The documented default is applied when
   * the user has made no selection (the store returns it without writing).
   */
  async function handleGetWorkspaceExperience(req, res) {
    // Presentation state is per-account: authn only, no projectId, no Project.
    const result = await gate(req, null);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const settings = workspaceExperienceStore.getSettings(result.account.id);
    const layout = layoutForSettings(settings);
    return sendJson(res, 200, {
      ...workspaceExperienceFrame({ experience: settings.workspaceExperience, layout }),
    });
  }

  /**
   * POST /workspace-experience — select/switch the per-User_Account
   * Workspace_Experience, or save a `custom` layout (Req 27.4/27.5/27.7). This
   * is a LAYOUT-ONLY surface event: it persists ONLY the presentation selection
   * via the store, broadcasts a layout-only workspace_experience frame to the
   * account's live SSE clients, and is STRUCTURALLY INCAPABLE of mutating Project
   * state or enqueuing a loop turn — it never references the agent/loop/tree
   * paths, never calls session.agent.send, and never sets session.running.
   *
   * Gates on AUTHN ONLY via the EXISTING gate(req, null) (no projectId, no
   * Project). A body carrying `customLayout` (a plain layout object) is routed to
   * the store's saveCustomLayout and selects `custom` per account. Otherwise the
   * body's `experience` is validated via the store's select(): an out-of-enum
   * value responds 400 (unsupported) WITHOUT writing and returns the STILL-CURRENT
   * experience so a client can confirm nothing changed (Req 27.7); a valid value
   * persists and responds 200 with the new experience + its layout descriptor.
   */
  async function handleSelectWorkspaceExperience(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    // Presentation state is per-account: authn only, no projectId, no Project.
    const result = await gate(req, null);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const accountId = result.account.id;

    // A `custom` arrangement carried in the body is saved per account (Req 27.4)
    // and selects the `custom` experience. Layout-only: the store writes ONLY the
    // UserPresentationSettings document.
    const hasCustomLayout =
      body && typeof body.customLayout === 'object' && body.customLayout !== null && !Array.isArray(body.customLayout);
    if (hasCustomLayout) {
      const saved = workspaceExperienceStore.saveCustomLayout(accountId, body.customLayout);
      if (!saved.ok) {
        return sendJson(res, 400, { error: saved.message, code: saved.code });
      }
      const frame = workspaceExperienceFrame({ experience: 'custom', layout: saved.customLayout });
      broadcastWorkspaceExperience(accountId, frame);
      return sendJson(res, 200, { ...frame });
    }

    const experience = typeof body?.experience === 'string' ? body.experience : '';
    const selected = workspaceExperienceStore.select(accountId, experience);
    if (!selected.ok) {
      // Out-of-enum value: the store refused to write and the current experience
      // is left in effect. Respond 400 (unsupported) and return the STILL-CURRENT
      // experience + layout so a client can confirm nothing changed (Req 27.7).
      const settings = workspaceExperienceStore.getSettings(accountId);
      return sendJson(res, 400, {
        error: selected.message ?? 'unsupported Workspace_Experience',
        code: selected.code,
        current: workspaceExperienceFrame({
          experience: settings.workspaceExperience,
          layout: layoutForSettings(settings),
        }),
      });
    }

    // Persisted. Resolve the layout descriptor for the new selection and
    // broadcast a layout-only frame to the account's live sessions — no turn.
    const settings = workspaceExperienceStore.getSettings(accountId);
    const frame = workspaceExperienceFrame({
      experience: selected.experience,
      layout: layoutForSettings(settings),
    });
    broadcastWorkspaceExperience(accountId, frame);
    return sendJson(res, 200, { ...frame });
  }

  // -------- Theme surface (spec Task 33, Req 29, Property 22) — visuals only

  /**
   * Resolve the Workspace_Experience for a Theme operation (the theme key is the
   * (User_Account, Workspace_Experience) pair, Req 29.2). Prefer an explicit
   * value from the request; when it is omitted AND a workspaceExperienceStore is
   * injected, default to that account's CURRENT experience (Req 29.3). Returns
   * { ok:true, experience } or a structured { ok:false, status, body } the
   * caller sends verbatim. NEVER writes anything, NEVER touches a Project.
   */
  function resolveThemeExperience(accountId, requested) {
    let experience = typeof requested === 'string' && requested !== '' ? requested : '';
    if (experience === '') {
      if (workspaceExperienceStore && typeof workspaceExperienceStore.getSettings === 'function') {
        experience = workspaceExperienceStore.getSettings(accountId).workspaceExperience;
      } else {
        return {
          ok: false,
          status: 400,
          body: { error: "a 'workspaceExperience' is required", code: 'workspace_experience_required' },
        };
      }
    }
    if (!isValidWorkspaceExperience(experience)) {
      return {
        ok: false,
        status: 400,
        body: { error: 'unsupported Workspace_Experience', code: 'unsupported_experience' },
      };
    }
    return { ok: true, experience };
  }

  /**
   * Project the CURRENT COMMITTED Theme for a (account, experience) pair onto a
   * theme frame with previewed:false. The store yields the experience default
   * when none is committed (Req 29.3) and defensively reads an out-of-catalog
   * persisted value back as that default, so THEME_CATALOG[committed] is always
   * present. Read-only: getCommitted's default read writes NOTHING.
   */
  function committedThemeFrame(accountId, experience) {
    const committed = themeStore.getCommitted(accountId, experience);
    return themeFrame({
      experience,
      theme: committed,
      palette: THEME_CATALOG[committed].palette,
      previewed: false,
    });
  }

  /**
   * Broadcast a visuals-only theme frame to EVERY live session whose accountId
   * matches (a Theme is per-User_Account (per-experience), so it applies across
   * that account's Project Sessions). Mirrors broadcastWorkspaceExperience: it
   * reuses the EXISTING per-session session.broadcast SSE mechanism and enqueues
   * NO turn — it NEVER calls session.agent.send and NEVER sets session.running.
   * A no-op when the account has no live sessions (a later /events connect
   * re-applies the COMMITTED theme via the reconnection frame set). An optional
   * `mutate(session)` runs per matched session to set/clear the per-session
   * themePreview holder alongside the broadcast.
   */
  function broadcastTheme(accountId, frame, mutate) {
    for (const session of sessions.values()) {
      if (session.accountId !== accountId) continue;
      if (typeof mutate === 'function') mutate(session);
      session.broadcast(frame);
    }
  }

  /**
   * GET /theme — read the CURRENT committed Theme + its palette for the
   * AUTHENTICATED account and a Workspace_Experience (Req 29.2/29.3). Presentation
   * is per-account, so this gates on AUTHN ONLY via the EXISTING gate(req, null)
   * — no projectId, no Project touched. On denial it replies with the IDENTICAL
   * non-disclosing 401 ACCESS_DENIED the other routes use. The experience is read
   * from the `workspaceExperience` query param; when omitted and a
   * workspaceExperienceStore is injected it defaults to the account's current
   * experience, else a 400 requires it. An unsupported experience is a 400. The
   * committed value defaults to the experience's default Theme when none is
   * committed (the store returns it WITHOUT writing). Read-only: touches NO
   * Project state, enqueues NO turn.
   */
  async function handleGetTheme(req, res) {
    // Presentation state is per-account: authn only, no projectId, no Project.
    const result = await gate(req, null);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const accountId = result.account.id;
    const url = new URL(req.url, 'http://localhost');
    const resolved = resolveThemeExperience(accountId, url.searchParams.get('workspaceExperience'));
    if (!resolved.ok) return sendJson(res, resolved.status, resolved.body);

    return sendJson(res, 200, { ...committedThemeFrame(accountId, resolved.experience) });
  }

  /**
   * POST /theme — the two-step { action:'preview'|'commit' } Theme interaction
   * (spec Task 33, Req 29.4/29.8, Property 22). Body { action, workspaceExperience,
   * theme }. Gates on AUTHN ONLY via the EXISTING gate(req, null) (no projectId,
   * no Project) — identical non-disclosing 401 on denial.
   *
   * This is a VISUALS-ONLY surface event: it is STRUCTURALLY INCAPABLE of
   * mutating Project state or enqueuing a loop turn — it never references the
   * agent/loop/tree paths, NEVER calls session.agent.send, and NEVER sets
   * session.running (Req 29.6). It has no code path to Project data or any
   * non-theme setting.
   *
   * VALIDATION ordering: an out-of-range `action` is a 400. The experience is
   * resolved/validated exactly as GET. An out-of-catalog `theme` (on EITHER
   * preview OR commit) is refused 400 { code:'unsupported_theme', current } with
   * the CURRENT committed Theme left in effect, WITHOUT writing and WITHOUT
   * setting a preview (Req 29.8).
   *
   * PREVIEW: set session.themePreview={experience,theme} for EVERY live session
   * of this account and broadcast themeFrame previewed:true — it calls NO writer
   * and persists NOTHING; the preview is reversible (Req 29.4). Responds 200 with
   * the previewed frame.
   *
   * COMMIT: themeStore.commit(accountId, experience, theme) is the ONLY writer.
   * On success, clear session.themePreview for the account's sessions and
   * broadcast themeFrame previewed:false (Req 29.4/29.5). Responds 200 with the
   * committed frame + at.
   */
  async function handleTheme(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    // Presentation state is per-account: authn only, no projectId, no Project.
    const result = await gate(req, null);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const accountId = result.account.id;

    const action = typeof body?.action === 'string' ? body.action : '';
    if (action !== 'preview' && action !== 'commit') {
      return sendJson(res, 400, {
        error: "an 'action' of 'preview' or 'commit' is required",
        code: 'unsupported_action',
      });
    }

    const resolved = resolveThemeExperience(accountId, body?.workspaceExperience);
    if (!resolved.ok) return sendJson(res, resolved.status, resolved.body);
    const experience = resolved.experience;

    const theme = typeof body?.theme === 'string' ? body.theme : '';
    // An out-of-catalog Theme is refused on BOTH preview and commit, WITHOUT
    // writing and WITHOUT setting a preview: the current committed Theme is left
    // in effect and returned so a client can confirm nothing changed (Req 29.8).
    if (!isValidTheme(theme)) {
      return sendJson(res, 400, {
        error: 'unsupported Theme',
        code: 'unsupported_theme',
        current: committedThemeFrame(accountId, experience),
      });
    }

    const palette = THEME_CATALOG[theme].palette;

    if (action === 'preview') {
      // Reversible, NON-PERSISTING: set the per-session preview holder for every
      // live session of this account and broadcast a previewed:true frame. NO
      // writer is called; the committed value in the store is untouched (Req 29.4).
      const frame = themeFrame({ experience, theme, palette, previewed: true });
      broadcastTheme(accountId, frame, (session) => {
        session.themePreview = { experience, theme };
      });
      return sendJson(res, 200, { ...frame });
    }

    // COMMIT: the store is the ONLY writer (Req 29.4/29.5). The theme + experience
    // were already screened, so a failure here would only be a store-level bad
    // value — surface its structured error verbatim without changing state.
    const committed = themeStore.commit(accountId, experience, theme);
    if (!committed.ok) {
      return sendJson(res, 400, {
        error: committed.message ?? 'unsupported Theme',
        code: committed.code,
        current: committedThemeFrame(accountId, experience),
      });
    }

    // Persisted. Clear the per-session preview for the account's sessions (the
    // commit supersedes any in-flight preview) and broadcast the committed
    // previewed:false frame so every client re-renders it — no turn.
    const frame = themeFrame({ experience, theme, palette, previewed: false });
    broadcastTheme(accountId, frame, (session) => {
      session.themePreview = null;
    });
    return sendJson(res, 200, { ...frame, at: committed.at });
  }

  // -------- Work_Mode surface (spec Task 32, Req 28) — a core Session capability

  /**
   * GET /work-mode — return the current Session's active Work_Mode + the three
   * creation choices as a work_mode frame (Req 28.2/28.4). Work_Mode is
   * per-Session, so this gates on FULL auth for the projectId via the EXISTING
   * gate(req, projectId) (a Session is (accountId, projectId)) — identical
   * non-disclosing 401 on denial. Requires the projectId query param exactly as
   * handleEvents does (400 when missing). Read-only: touches NO Project state,
   * enqueues NO turn.
   */
  async function handleGetWorkMode(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const projectId = url.searchParams.get('projectId');
    if (!projectId) return sendJson(res, 400, { error: "a 'projectId' query parameter is required" });

    const result = await gate(req, projectId);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const session = sessionFor(result.account.id, projectId);
    return sendJson(res, 200, {
      ...workModeFrame({
        mode: session.workMode.current(),
        choices: session.workMode.creationChoices(),
      }),
    });
  }

  /**
   * POST /work-mode — request a Work_Mode switch for a Session (Req 28.5/28.6/
   * 28.7). Body { projectId, mode }. Gates on FULL auth for the projectId via the
   * EXISTING gate(req, projectId).
   *
   * An out-of-enum `mode` is rejected 400 { code:'unsupported_work_mode',
   * current } with the current mode LEFT IN EFFECT and NO confirm minted
   * (Req 28.7). A valid target does NOT apply immediately: it routes through the
   * EXISTING confirm surface — session.onConfirmRequest broadcasts a
   * confirm_request frame keyed by the same requestId POST /confirm settles, and
   * we await it under the fail-closed <=60s ceiling. There is NO second confirm
   * mechanism. When the awaited promise resolves TRUE, we call
   * session.workMode.applySwitch(mode) — the ONLY mutator, which holds only the
   * mode string and CANNOT touch any Project state (Req 28.6) — and broadcast the
   * updated work_mode + session_header frames so every client sees the new active
   * mode. When it resolves FALSE (denied) or fail-closed (timeout/no client), we
   * DO NOT apply: the current mode stays in effect and we respond that the switch
   * was not applied.
   */
  async function handleSwitchWorkMode(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    if (!projectId) return sendJson(res, 400, { error: "a 'projectId' field is required" });

    const result = await gate(req, projectId);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const session = sessionFor(result.account.id, projectId);
    const mode = typeof body?.mode === 'string' ? body.mode : '';

    // Validate the requested target. An out-of-enum mode is rejected WITHOUT
    // minting a confirm; the current mode stays in effect (Req 28.7).
    const requested = session.workMode.requestSwitch(mode);
    if (!requested.ok) {
      return sendJson(res, 400, {
        error: requested.message ?? 'unsupported Work_Mode',
        code: requested.code,
        current: workModeFrame({
          mode: session.workMode.current(),
          choices: session.workMode.creationChoices(),
        }),
      });
    }

    // A valid target routes through the EXISTING confirm surface: broadcast a
    // confirm_request frame keyed by the SAME requestId POST /confirm settles,
    // and await it under the fail-closed <=60s ceiling. No second mechanism.
    const approved = await session.onConfirmRequest({
      requestId: requested.requestId,
      command: `work-mode switch to ${mode}`,
      category: 'work_mode_switch',
      reason: `Switch the Session Work_Mode to '${mode}'`,
    });

    if (approved === true) {
      // Confirmed: apply the switch (the ONLY mutator) and broadcast the new
      // active mode on the Session_Header so every client re-renders it.
      const applied = session.workMode.applySwitch(mode);
      const frame = workModeFrame({
        mode: session.workMode.current(),
        choices: session.workMode.creationChoices(),
      });
      session.broadcast(frame);
      session.broadcast(
        sessionHeaderFrame({
          mode: session.workMode.current(),
          choices: session.workMode.creationChoices(),
        }),
      );
      return sendJson(res, 200, { applied: true, ...frame, at: applied.at });
    }

    // Denied / timed-out / no client: leave the current mode in effect and
    // report the switch was not applied (Req 28.5). Broadcast the still-current
    // mode so any observer confirms nothing changed.
    const frame = workModeFrame({
      mode: session.workMode.current(),
      choices: session.workMode.creationChoices(),
    });
    session.broadcast(frame);
    return sendJson(res, 200, { applied: false, ...frame });
  }

  // -------- GET /events (SSE)

  async function handleEvents(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const projectId = url.searchParams.get('projectId');
    if (!projectId) return sendJson(res, 400, { error: "a 'projectId' query parameter is required" });

    const result = await gate(req, projectId);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const session = sessionFor(result.account.id, projectId);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // An initial comment + retry hint opens the stream and tells EventSource how
    // soon to reconnect.
    res.write(': connected\n');
    res.write('retry: 2000\n\n');

    session.sseClients.add(res);

    // A client that connects (or reconnects mid-turn) has missed the frames so
    // far. Tell it the current state so it does not show "ready" while a turn is
    // in flight, and re-broadcast any still-pending confirm prompts so it can
    // answer them rather than leaving the turn blocked behind a prompt it can no
    // longer see. Mirrors plumby's reconnection frame set.
    const frames = [{ type: 'turn_state', running: session.running != null }];
    if (session.running) frames.push({ type: 'turn_start' });
    // When a PreviewController is injected, a (re)connecting client also learns
    // the CURRENT preview status (loading/ready/showing_prior/error) so it can
    // render the running-preview state immediately alongside the Activity_Stream
    // (Req 4.4). Only a SAFE summary crosses the wire. Strictly additive: with
    // no previewController the reconnection frame set is unchanged.
    if (previewController && typeof previewController.servedPreview === 'function') {
      frames.push(previewStatusFrame(previewController.servedPreview(projectId)));
    }
    // When a WorkspaceExperienceStore is injected, a (re)connecting client also
    // learns the CURRENT per-User_Account Workspace_Experience + its resolved
    // layout, so a later Session re-applies the layout (Req 27.5). This is
    // layout-only and per-account (keyed off the authenticated account, not the
    // project). Strictly additive: with no store the reconnection frame set is
    // unchanged.
    if (workspaceExperienceStore && typeof workspaceExperienceStore.getSettings === 'function') {
      const settings = workspaceExperienceStore.getSettings(result.account.id);
      frames.push(
        workspaceExperienceFrame({
          experience: settings.workspaceExperience,
          layout: layoutForSettings(settings),
        }),
      );
    }
    // When a ThemeStore is injected AND a WorkspaceExperienceStore is injected
    // (so the account's CURRENT Workspace_Experience — the theme key — is
    // determinable), a (re)connecting client also learns the CURRENT COMMITTED
    // Theme frame (previewed:false) for that experience, so a later Session
    // re-applies it (Req 29.5). A LIVE preview is deliberately NOT inherited by a
    // reconnecting client as committed — the reconnection frame always reflects
    // the committed value. Without a workspaceExperienceStore the (account,
    // experience) pair is undetermined here, so the theme frame is skipped.
    // Strictly additive: with no themeStore the reconnection frame set is
    // unchanged.
    if (
      themeStore &&
      typeof themeStore.getCommitted === 'function' &&
      workspaceExperienceStore &&
      typeof workspaceExperienceStore.getSettings === 'function'
    ) {
      const experience = workspaceExperienceStore.getSettings(result.account.id).workspaceExperience;
      frames.push(committedThemeFrame(result.account.id, experience));
    }
    // A (re)connecting client ALWAYS learns the CURRENT active Work_Mode in the
    // Session_Header (spec Task 32, Req 28.4). This is per-Session (keyed off the
    // session, not the account), unlike the per-account workspace_experience
    // frame. Both the work_mode and session_header frames are pushed so a client
    // can render the observable header immediately. Work_Mode is a core Session
    // capability, so this is always present.
    frames.push(
      workModeFrame({
        mode: session.workMode.current(),
        choices: session.workMode.creationChoices(),
      }),
    );
    frames.push(
      sessionHeaderFrame({
        mode: session.workMode.current(),
        choices: session.workMode.creationChoices(),
      }),
    );
    for (const payload of session.pendingConfirmPayloads.values()) frames.push(payload);
    for (const payload of frames) {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        session.sseClients.delete(res);
      }
    }

    const drop = () => {
      session.sseClients.delete(res);
      // If the last watcher leaves mid-approval, fail those approvals closed so a
      // blocked turn is not stuck forever.
      if (session.sseClients.size === 0) session.denyAllPending();
    };
    req.on('close', drop);
    req.on('error', drop);
  }

  // -------- POST /message

  async function handleMessage(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    if (!projectId) return sendJson(res, 400, { error: "a 'projectId' field is required" });

    // AUTH GATE before ANY project action or existence check.
    const result = await gate(req, projectId);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return sendJson(res, 400, { error: "a non-empty 'text' field is required" });

    // QUOTA / RATE-LIMIT GATE — runs AFTER authn+authz has succeeded and BEFORE
    // any allocation (no Project Session is created, no Builder_Agent is built,
    // no Sandbox is acquired below this point). An over-limit request therefore
    // allocates NOTHING. The gate is skipped entirely when no quotaManager is
    // injected (backward compatible). Because it sits after gate(), an
    // unauthenticated request never reaches here — no limit is disclosed before
    // auth passes. A rejection is a 429 whose body NAMES the exceeded limit.
    if (quotaManager) {
      const rate =
        typeof quotaManager.checkRate === 'function'
          ? quotaManager.checkRate(result.account, 'generation.turn')
          : { ok: true };
      if (rate && rate.ok === false) {
        return sendJson(res, 429, {
          error: rate.message ?? 'rate limit exceeded',
          limit: rate.limit,
          operation: rate.operation,
        });
      }

      const quota =
        typeof quotaManager.checkQuota === 'function'
          ? quotaManager.checkQuota(result.account, projectId, 'concurrentSandboxes')
          : { ok: true };
      if (quota && quota.ok === false) {
        return sendJson(res, 429, {
          error: quota.message ?? 'resource quota exceeded',
          limit: quota.limit,
          resource: quota.resource,
        });
      }
    }

    const session = sessionFor(result.account.id, projectId);

    // ONE in-flight turn per Project Session. A second send while a turn runs is
    // refused with a human-readable 409; it does NOT start a second turn.
    if (session.running) {
      return sendJson(res, 409, {
        error: 'a turn is already running for this project session; wait for it to finish',
      });
    }

    // Construct the Builder_Agent lazily on the first turn.
    if (!session.agent) {
      const cwd = projectCwd(projectId);
      const built = buildAgent({
        projectId,
        // The authenticated accountId for THIS session, threaded so a real
        // composition can bind it into the CommandGuard's run() opts and make
        // CONFIRM_CLASS_OP audit entries attributable to a User_Account rather
        // than account-null (Req 25.1). The default factory ignores it; a
        // guard-wiring factory passes it as guard.run(pid, cmd, { accountId }).
        accountId: session.accountId,
        cwd,
        onEvent: session.onEvent,
        commandGuard,
        onConfirmRequest: session.onConfirmRequest,
      });
      session.agent = built.agent;
    }

    const controller = new AbortController();
    session.running = controller;

    // Respond 202 immediately: the turn streams over SSE, not this response.
    sendJson(res, 202, { accepted: true });
    session.broadcast({ type: 'turn_start' });

    // Run the turn in the background, forwarding onEvent frames (already wired at
    // construction) to the session's SSE clients. Broadcast turn_done on
    // completion or error; always clear running in finally.
    (async () => {
      try {
        await session.agent.send(text, { signal: controller.signal });
        session.broadcast({ type: 'turn_done', ok: true });
      } catch (err) {
        // Platform-level turn failure (Req 25.3). When an Observability instance
        // is injected, report the error to mint a correlationId + record a
        // redacted operational entry, then broadcast a user-facing `error` frame
        // carrying ONLY the correlationId + generic userMessage (never the raw
        // cause). The existing turn_done error frame is preserved as the fallback
        // (and still emitted) so behaviour is unchanged when no observability is
        // wired — the raw cause on turn_done is the agent's own message, not a
        // platform secret, and the redacted, correlated detail lives in the log.
        if (observability && typeof observability.reportError === 'function') {
          const { correlationId, userMessage } = observability.reportError(
            { id: session.accountId },
            'generation.turn',
            err,
          );
          session.broadcast({ type: 'error', correlationId, message: userMessage });
        }
        session.broadcast({ type: 'turn_done', ok: false, error: err?.message ?? String(err) });
      } finally {
        session.running = null;
      }
    })();
  }

  // -------- POST /confirm

  async function handleConfirm(req, res) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    if (!projectId) return sendJson(res, 400, { error: "a 'projectId' field is required" });

    const result = await gate(req, projectId);
    if (result.denied) return sendJson(res, 401, ACCESS_DENIED);

    const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
    if (!requestId) return sendJson(res, 400, { error: "a 'requestId' field is required" });

    const session = sessions.get(sessionKey(result.account.id, projectId));
    const settle = session && session.pendingConfirms.get(requestId);
    if (!settle) return sendJson(res, 404, { error: 'no pending confirmation for that requestId' });

    // Resolve the guard's awaited seam. approved must be strictly true to allow;
    // anything else denies. The resolve-once guard inside settle() ignores
    // duplicates, so a repeated POST is a harmless 200.
    settle(body.approved === true);
    return sendJson(res, 200, { ok: true });
  }

  // ------------------------------------------------------------------ helpers

  /** Read and JSON-parse a POST body, capped at MAX_BODY_BYTES. */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim() === '') return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('request body must be valid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /** Write a JSON response with the given status. */
  function sendJson(res, status, payload) {
    const bodyText = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(bodyText);
  }

  // --------------------------------------------------------------- lifecycle

  let boundAddress = null;

  /** Bind an ephemeral (or given) port; resolves to { port, host }. */
  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        boundAddress = addr;
        resolve({ port: addr.port, host: addr.address });
      });
    });
  }

  /** Close the server and deny every session's pending confirms (fail-closed). */
  function close() {
    for (const session of sessions.values()) session.denyAllPending();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  /** The bound address, or null before listen(). */
  function address() {
    return boundAddress ?? server.address();
  }

  /**
   * Push a Preview lifecycle status onto a specific (accountId, projectId)
   * session's SSE stream — the SAME stream the Activity_Stream flows on (Req
   * 4.4). This is the per-session hook a composition (ProjectManager +
   * PreviewController) calls when the served preview changes (publish-on-commit,
   * loading, ready, showing-prior, an unexpected exit, or a mobile QR/URL), so
   * the client sees the preview status update concurrently with the reasoning
   * feed. The `statusOrFrame` is either a served-preview handle (projected onto
   * a SAFE preview_status frame) or an already-typed frame (e.g. preview_mobile).
   * A no-op when the target session has never been touched (no client to reach).
   *
   * Only SAFE summaries reach the wire — no raw cause/secret. Strictly additive:
   * unused when no previewController is injected.
   *
   * @param {string} accountId
   * @param {string} projectId
   * @param {object} statusOrFrame  a served-preview handle or a typed frame
   * @returns {boolean} whether a live session received the frame
   */
  function broadcastPreviewStatus(accountId, projectId, statusOrFrame) {
    const session = sessions.get(sessionKey(accountId, projectId));
    if (!session) return false;
    session.broadcastPreview(statusOrFrame);
    return true;
  }

  return Object.freeze({
    server,
    listen,
    close,
    address,
    pendingCount,
    broadcastPreviewStatus,
    securityHeaders: () => ({ ...baselineHeaders }),
  });
}
