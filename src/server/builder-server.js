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

/** Cap on a POST body we will buffer, so a client cannot exhaust memory. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Default bound on how long a confirm-class prompt may sit unanswered. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

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
 * Create the Builder Server.
 *
 * @param {object} opts
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
    confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
    now = () => Date.now(),
  } = opts;

  if (!authService || typeof authService.tryVerifySession !== 'function') {
    throw new TypeError('createBuilderServer requires an authService with tryVerifySession()');
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
    };

    /** Send a raw view payload to every SSE client of THIS session. */
    session.broadcast = (payload) => {
      if (!payload) return;
      const frame = `data: ${JSON.stringify(payload)}\n\n`;
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
  function defaultAgentFactory({ cwd, onEvent }) {
    // Command execution flows through the injected CommandGuard, which the
    // caller wires with this session's onConfirmRequest seam (see the factory
    // call site), so a confirm-class command reaches this server's POST /confirm
    // rather than the plumby loop's own confirm hook. The session's `accountId`
    // is also handed to this factory (ignored here) so a guard-wiring factory
    // can bind it into guard.run(pid, cmd, { accountId }) and make
    // CONFIRM_CLASS_OP audit entries attributable rather than account-null.
    const agent = createAgent({
      cwd,
      system: buildSystemPrompt({ cwd }),
      tools: [...defaultTools, spawnSubagentTool],
      subagentTools,
      onEvent,
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

    if (req.method === 'GET' && pathname === '/events') return handleEvents(req, res);
    if (req.method === 'POST' && pathname === '/message') return handleMessage(req, res);
    if (req.method === 'POST' && pathname === '/confirm') return handleConfirm(req, res);
    // Strictly additive: only enabled when a ProjectManager is injected.
    if (projectManager && req.method === 'POST' && pathname === '/projects') {
      return handleCreateProject(req, res);
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
      // A totalProjects quota rejection is a 429 naming the limit; every other
      // rejection (validation) is a 400 with the specific message.
      if (created.code === 'QUOTA_EXCEEDED') {
        return sendJson(res, 429, {
          error: created.message,
          limit: created.limit,
          resource: created.resource,
        });
      }
      return sendJson(res, 400, { error: created.message, code: created.code });
    }

    return sendJson(res, 201, { id: created.project.id, project: created.project });
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

  return Object.freeze({
    server,
    listen,
    close,
    address,
    pendingCount,
    securityHeaders: () => ({ ...baselineHeaders }),
  });
}
