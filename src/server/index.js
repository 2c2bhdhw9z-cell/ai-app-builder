/**
 * Server subsystem barrel (spec Task 10 — the Builder Server).
 *
 * The public seam for the Builder Server: the node:http + SSE surface that
 * streams the Activity_Stream per Project Session (GET /events), accepts a user
 * message (POST /message) returning 202 then streaming the turn, and resolves
 * confirm-class prompts (POST /confirm) fail-closed against the CommandGuard's
 * existing consent seam — every request gated through the AuthService BEFORE it
 * reaches the loop. Mirrors how src/auth/index.js, src/sandbox/index.js, and
 * src/persistence/index.js aggregate their modules.
 *
 * When an OPTIONAL PreviewController is injected, the surface also presents the
 * running Preview CONCURRENTLY with the Activity_Stream (Req 4.4): GET /preview
 * returns the served Preview handle for an authorized session, POST
 * /preview/restart restarts the Dev_Server (capped at 3 attempts), and Preview
 * lifecycle status frames are broadcast on the SAME per-session SSE stream as the
 * reasoning feed. This is strictly additive and behind the injected controller.
 *
 * When an OPTIONAL WorkspaceExperienceStore is injected, the surface also
 * exposes a LAYOUT-ONLY, per-User_Account Workspace_Experience selection (Req 27,
 * Property 20): GET /workspace-experience reads the current experience + its
 * layout, POST /workspace-experience selects/switches it (or saves a `custom`
 * arrangement), and the selection is broadcast as a layout-only
 * `workspace_experience` frame on the SAME per-session SSE stream. It mutates no
 * Project state and enqueues no loop turn; strictly additive and behind the
 * injected store.
 *
 * Every Project Session also carries a per-Session Work_Mode (Req 28), a CORE
 * capability defaulting to `vibe`: GET /work-mode reads the active mode + the
 * three creation choices, POST /work-mode requests a switch that routes through
 * the EXISTING POST /confirm consent seam (a switch applies only after explicit
 * confirmation) and reshapes only the NEXT turn's flow — it preserves ALL
 * Project state and enqueues no loop turn. The active mode is always observable
 * in the Session_Header, including the /events reconnection frames.
 *
 * The Builder_Agent behind each Project Session reaches plumby ONLY through the
 * boundary module (src/engine/plumby.js); this subsystem never imports the
 * plumby package directly.
 */

export {
  createBuilderServer,
  securityHeaders,
  previewStatusFrame,
  restartStatusFrame,
  safePreviewCause,
  workspaceExperienceFrame,
  workModeFrame,
  sessionHeaderFrame,
  themeFrame,
} from './builder-server.js';
export { createActivityStream, toActivityFrame } from './activity-stream.js';
