# Implementation Plan: Web UI

## Overview

This plan builds the **Web UI** — a no-build, vanilla ES-module browser client served as same-origin static assets over the existing `ai-app-builder` Builder_Server — incrementally, so the core builder screen is usable early (minimal-but-real) and then grown. The staging follows the priority order carried from the requirements and design:

1. **Core builder screen** — additive static-asset route + HTML shell + state store + transport (API/SSE) + prompt box + live Activity_Stream over SSE + preview pane + confirm approvals.
2. **Browser OIDC login** — Login_Flow, Token_Store, auto-attached Bearer, expiry/logout.
3. **Workspace shell** — project creation, Workspace_Experience switching, Theme rendering via CSS custom properties, Work_Mode header, Mobile Command Center (360px).
4. **Remaining settings surfaces** — provider selection, connectors, skills + memory, build/deploy/export/lock-in-audit/share.
5. **Non-disclosing error handling** — woven throughout (central `api.js` classification + `error`-frame hygiene).

Each task builds on prior ones and ends by wiring new code into the running client — no orphaned code.

### Constraints honored by every task

- **No new dependencies.** The client is no-build vanilla ES modules; the platform adds **no runtime dependency** and **no new devDependency**. Property tests use **`fast-check`** (the existing sole devDependency) and run under the existing `node --test` runner.
- **Single additive backend change.** A static-asset serving route on the Builder_Server (`src/server/builder-server.js`) reusing the existing `securityHeaders()` so the CSP is applied by the same code path, serving files from a new `src/server/public/` directory (Task 1.1).
- **Property tests** implement the design's **31 correctness properties**, each as a single `fast-check` test tagged `Feature: web-ui, Property {n}: {title}` running **≥100 iterations** (`{ numRuns: 100 }` or higher). Pure logic is factored DOM-free so tests run under `node --test`.
- **Real collaborators over mocks.** Per the design and prior learnings (over-mocking hid real bugs), property and unit tests exercise the real reducers, validators, schedulers, state store, and (where feasible) the real served assets/route rather than stand-in doubles.
- **Coding tasks only.** No deployment, user research, performance-gathering, or non-code activities appear below.

### Out of scope (future phase)

**Monetization / billing is explicitly a future phase and out of scope for this list** — no subscription plans, credit packs, metering, invoicing, email/notifications, or HTTP-edge rate limiting are implemented here, consistent with the requirements and design. The architecture leaves that door open (the `429` named-limit outcome is already a first-class, tested result — Property 4), but no billing concept is built by any task below.

## Tasks

- [ ] 1. Static-asset delivery: additive server route + HTML shell + client bootstrap
  - [ ] 1.1 Add the additive static-asset serving route to the Builder_Server
    - Modify `src/server/builder-server.js` `handle()` to serve a fixed allow-list of asset paths (`/`, `/index.html`, the module `*.js` files, `/styles.css`, `/manifest.webmanifest`) with `GET`, reading from a new `src/server/public/` directory via `node:fs`/`node:path`
    - Reuse the existing `securityHeaders()` baseline so the CSP is applied by the same code path as every other response; content-type by extension; missing asset → generic 404 (no directory listing)
    - Place the route **after** `/healthz` and `/auth/*` and **before** the auth-gated routes so the shell loads with no Bearer_Token; unknown paths still 405
    - Add **no** runtime dependency
    - _Requirements: 1.1, 1.2, 1.3, 1.5_
  - [ ] 1.2 Author the CSP-clean HTML shell and stylesheet
    - Create `src/server/public/index.html` with `<script type="module" src="/app.js">` and `<link rel="stylesheet" href="/styles.css">` only — **no** inline `<script>` and **no** inline `<style>`
    - Create `src/server/public/styles.css` using only `var(--color-*)` references for palette-driven colors; include a `manifest.webmanifest`
    - _Requirements: 1.4, 9.1_
  - [ ] 1.3 Create the client bootstrap entry module
    - Create `src/server/public/app.js` as the ES-module entry that instantiates the store and router and mounts an initial (empty) view, so `GET /` renders a live client shell
    - _Requirements: 1.3, 1.4_
  - [ ]* 1.4 Integration test the static route under the real CSP
    - Assert unauthenticated `GET /` returns `200 text/html` (not JSON) carrying the `securityHeaders()` CSP, and that an unknown path still 405s and a missing asset 404s
    - Structural check over the asset set: no inline script/style, no external-origin references (Req 1.4)
    - Use the real server route, not a mock
    - _Requirements: 1.1, 1.3, 1.4, 1.5_
  - [ ]* 1.5 Smoke test: no dependency growth
    - Assert `package.json` `dependencies` did not grow (no runtime dependency added)
    - _Requirements: 1.2_

- [ ] 2. State store and transport layer (the only modules that touch the network)
  - [ ] 2.1 Implement the observable state store
    - Create `src/server/public/store.js` with `getState()`, `subscribe(selector, cb)`, `dispatch(action)` and the Data-Models slices (session, preview, theme, workspace, work-mode, connection, token presence)
    - Enforce store invariants: `submitInFlight` gating and `committedTheme` only overwritten by a committed frame/read (preview writes `previewedTheme` only)
    - _Requirements: 2.5, 9.3, 9.4, 9.5_
  - [ ] 2.2 Implement the gated API client with central error classification
    - Create `src/server/public/api.js` wrapping `fetch`, attaching `Authorization: Bearer <token>` from the Token_Store on gated calls, enforcing per-call timeouts via `AbortController`, and normalizing responses into the tagged `ApiResult` (`ok | denied | rateLimited | validation | protocol | timeout | error`)
    - `401` → discard body, `denied`, fire `onAccessDenied`; `429` → `rateLimited` with named limit; `400` → `validation`/`protocol`; timeout → `timeout`
    - _Requirements: 2.6, 2.7, 2.8, 6.4, 7.4, 7.5, 9.6, 9.7, 16.1_
  - [ ]* 2.3 Write property test for the rate-limited outcome
    - **Property 4: A rate-limited surface displays the named limit and retains input**
    - **Validates: Requirements 2.8, 7.5**
  - [ ]* 2.4 Write property test for non-disclosing access denial
    - **Property 31: An Access_Denied_Response yields one generic indication and discloses nothing**
    - Generate adversarial `401` bodies embedding project ids/paths/existence hints; assert no field value appears in rendered output
    - **Validates: Requirements 16.1, 2.7, 5.5, 15.6**

- [ ] 3. Core builder: prompt submission and running-turn state
  - [ ] 3.1 Implement prompt validation and the builder submit controller
    - Create `src/server/public/builder.js`: trim-based validation (submit iff trimmed length in 1..10,000), send trimmed text to `POST /message` via `api.js`, drive the running-turn indicator, handle timeout/retry and `429`/`401`
    - Retain entered text on reject/timeout/429
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
  - [ ] 3.2 Implement the prompt view and wire it into the shell
    - Create `src/server/public/views/prompt.js`: textarea (1–10,000 chars) + submit, disabled during in-flight turn, touch-sized controls; subscribe to the store and mount it in `app.js`
    - _Requirements: 2.1, 2.5, 11.3_
  - [ ]* 3.3 Write property test for prompt validation gating
    - **Property 1: Prompt validation gates submission by trimmed length**
    - Generators include Unicode whitespace and boundary lengths (0, 1, 10000, 10001)
    - **Validates: Requirements 2.2, 2.3, 2.4**
  - [ ]* 3.4 Write property test for trimmed submitted text
    - **Property 2: A submitted prompt carries the trimmed text**
    - **Validates: Requirements 2.2**
  - [ ]* 3.5 Write property test for in-flight concurrency gating
    - **Property 3: An in-flight turn admits no second concurrent submit**
    - **Validates: Requirements 2.5**
  - [ ]* 3.6 Write unit test for the 30s message timeout (fake clock)
    - End in-flight, re-enable submit, retain text, show timeout message
    - _Requirements: 2.6_

- [ ] 4. Core builder: live Activity_Stream over SSE
  - [ ] 4.1 Implement the SSE client with fetch-based streaming and bounded reconnect
    - Create `src/server/public/sse.js`: open `GET /events?projectId=…` via a `fetch()` streaming reader (so the Bearer header can be attached), parse `data:`/`retry:` lines, expose `connect/disconnect/onFrame/onStatus/reconnectNow`
    - Bounded reconnect (delay ≤5s, ≤10 consecutive attempts, then `status:'lost'`); `401` on open → `status:'unauthorized'`; replay frames flow through the same `onFrame` path
    - Frame hygiene: drop frames > 1,048,576 bytes or of unrecognized `type` without rendering and without closing
    - _Requirements: 3.1, 3.2, 3.5, 3.6, 3.7, 3.9, 6.4_
  - [ ] 4.2 Implement the frame-dispatch reducer and recognized-frame registry
    - Create `src/server/public/frames.js`: closed set of recognized `type`s + per-type handler mapping frames to store actions; ordered append of Activity_Stream frames by monotonic seq; normalize diff frames into `hunks` with `{ marker:'+'|'-'|' ', text }`; `error` frames read only `message` + `correlationId`
    - _Requirements: 3.3, 3.4, 3.7, 3.8, 3.9, 16.2_
  - [ ] 4.3 Implement the Activity_Stream view and wire SSE into the session open
    - Create `src/server/public/views/activity-stream.js`: render ordered by seq with persistent `+`/`-` textual markers; connect SSE within 2s of the session view rendering; unauthorized/lost states show the appropriate message + manual reconnect control
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6_
  - [ ]* 4.4 Write property test for Activity_Stream ordering
    - **Property 5: Activity_Stream frames render in ascending sequence order**
    - Generate shuffled/duplicate sequence ids
    - **Validates: Requirements 3.3**
  - [ ]* 4.5 Write property test for diff line markers
    - **Property 6: Diffs carry a persistent non-color marker per line**
    - **Validates: Requirements 3.4**
  - [ ]* 4.6 Write property test for bounded reconnection
    - **Property 7: SSE reconnection is bounded in interval and count**
    - **Validates: Requirements 3.5, 3.6**
  - [ ]* 4.7 Write property test for unrecognized/oversized frame dropping
    - **Property 8: Unrecognized or oversized frames are dropped without closing the stream**
    - **Validates: Requirements 3.9**
  - [ ]* 4.8 Write property test for the error-frame renderer
    - **Property 9: The error-frame / access-denied renderer discloses nothing beyond the safe fields**
    - Seed `error` frames with adversarial extra fields (cause, stack, secret, ids)
    - **Validates: Requirements 3.8, 16.2**
  - [ ]* 4.9 Write unit tests for SSE open-within-2s and reconnect replay (fake clock)
    - Open within 2s (3.1); on re-establish, each replayed slice is applied (3.7)
    - _Requirements: 3.1, 3.7_

- [ ] 5. Core builder: preview pane and liveness poll
  - [ ] 5.1 Implement the preview controller and preview reducers
    - Create `src/server/public/preview.js`: apply `preview_status` frames (ready-with-url replaces content; ready-empty-url retains prior + shows URL-unavailable error; loading suppresses prior content; showing_prior/error/persistent_failure show indicator + safe cause iff present); restart control iff `restartOffered`, activating calls `POST /preview/restart`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [ ] 5.2 Implement the 5s preview liveness poll
    - Create `src/server/public/preview-poll.js`: while a session is open, `GET /preview?projectId=…` every 5s; non-live result → failure indication tagged `source:'poll'`; timeout/non-success → retain last status and continue next interval
    - _Requirements: 4.7, 4.8, 4.9_
  - [ ] 5.3 Implement the preview view and wire it into the layout
    - Create `src/server/public/views/preview-pane.js`: same-origin `<iframe>` for the preview URL; loading/showing_prior/error/persistent_failure indicators; mobile connection URL as selectable text + scannable QR rendered as an inline `data:` image (CSP-legal); mount in the builder layout
    - Include a dependency-free QR encoder helper (`src/server/public/qr.js`) producing a `data:` image — no external service, no new dependency
    - _Requirements: 4.10, 4.11_
  - [ ]* 5.4 Write property test for ready-preview URL application
    - **Property 10: A ready preview frame is applied only with a usable URL**
    - **Validates: Requirements 4.1, 4.2**
  - [ ]* 5.5 Write property test for loading suppression
    - **Property 11: A loading status suppresses previously rendered preview content**
    - **Validates: Requirements 4.3**
  - [ ]* 5.6 Write property test for failure-state cause display
    - **Property 12: Failure-state frames show a cause summary iff one is present**
    - **Validates: Requirements 4.4, 4.5**
  - [ ]* 5.7 Write property test for the restart control
    - **Property 13: The restart control appears exactly when offered and calls restart**
    - **Validates: Requirements 4.6**
  - [ ]* 5.8 Write property test for poll result handling
    - **Property 14: A non-live poll result drives a failure state; a failed poll is inert**
    - **Validates: Requirements 4.8, 4.9**
  - [ ]* 5.9 Write property test for the mobile QR round-trip
    - **Property 15: The mobile connection URL round-trips through its QR encoding**
    - encode-then-decode is the identity on the URL
    - **Validates: Requirements 4.10**
  - [ ]* 5.10 Write integration test for preview cadence and same-origin iframe / QR CSP
    - 5s poll cadence with fake clock (4.7); iframe is same-origin and app doc not embeddable cross-origin (4.11); QR is an `img-src 'self' data:`-legal image (4.10)
    - _Requirements: 4.7, 4.10, 4.11_

- [ ] 6. Core builder: confirm-class command approvals
  - [ ] 6.1 Implement the confirm controller and view
    - Create `src/server/public/confirm.js` and `src/server/public/views/confirm.js`: render approve/deny (touch-sized) on `confirm_request`; on decision `POST /confirm` with the frame `requestId` + Bearer; keep visible while unanswered; re-display idempotently on reconnect replay keyed by `requestId`; clear on `confirm_timeout`; `401` → re-auth without project detail
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 11.3_
  - [ ]* 6.2 Write property test for the confirm decision request id
    - **Property 16: A confirm decision posts the frame's request id**
    - **Validates: Requirements 5.1, 5.2**
  - [ ]* 6.3 Write property test for pending-confirm idempotent re-display
    - **Property 17: A pending confirm stays visible and is re-displayed idempotently**
    - **Validates: Requirements 5.3, 5.4**

- [ ] 7. Checkpoint — core builder screen usable end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Browser OIDC login: Token_Store, Login_Flow, and auto-attach
  - [ ] 8.1 Implement the Token_Store with atomic write and same-origin-only persistence
    - Create `src/server/public/token-store.js`: atomic `{ token, accountId, expiresAt }` write; validate payload (non-empty token/accountId, valid future ISO-8601 `expiresAt`) before writing; in-memory primary with optional `sessionStorage` continuity; never `document.cookie` or any cross-origin-readable sink; atomic clear
    - _Requirements: 6.2, 6.3, 16.3_
  - [ ] 8.2 Implement the auth controller (Login_Flow, callback, expiry, logout) and wire into `api.js`/`sse.js`
    - Create `src/server/public/auth.js`: login control navigates to `GET /auth/login` within 500ms; handle `/auth/callback` 200/401/400 branches (generic login-failed on 401/400, exclude raw `code`, offer restart); no PKCE verifier; clear Token_Store + return to login within 1s on expiry-reached, any gated `401` (via `api.js` `onAccessDenied`), or logout
    - Wire the login gate so gated views require a token and the login control shows when none is held
    - _Requirements: 6.1, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_
  - [ ]* 8.3 Write property test for atomic callback storage / discard
    - **Property 18: A valid callback payload is stored atomically; an invalid one is discarded**
    - Generators include missing fields and past/invalid `expiresAt`
    - **Validates: Requirements 6.2, 6.3**
  - [ ]* 8.4 Write property test for the Bearer header on every gated request
    - **Property 19: Every gated request while a token is held carries the Bearer header**
    - Cover `/message`, `/confirm`, `/projects`, `/preview`, `/preview/restart`, `/theme`, `/work-mode`, `/workspace-experience`, and the `/events` connect
    - **Validates: Requirements 6.4, 3.1**
  - [ ]* 8.5 Write property test for login-protocol code non-disclosure
    - **Property 20: A login-protocol code is never disclosed, and a restart is offered**
    - **Validates: Requirements 6.6**
  - [ ]* 8.6 Write property test for token clearing triggers
    - **Property 21: Every token-clearing trigger fully empties the Token_Store**
    - **Validates: Requirements 6.7, 6.9**
  - [ ]* 8.7 Write property test for absence of PKCE verifier
    - **Property 22: No Login_Flow request carries a PKCE code verifier**
    - **Validates: Requirements 6.8**
  - [ ]* 8.8 Write unit tests for login navigation timing and token storage sink
    - Login navigation within 500ms (6.1); assert Token_Store writes only to in-memory/`sessionStorage`, never `document.cookie` (16.3)
    - _Requirements: 6.1, 16.3_

- [ ] 9. Workspace shell: project creation and session open
  - [ ] 9.1 Implement the project-creation controller and form view
    - Create `src/server/public/projects.js` and `src/server/public/views/projects.js`: category (`web`/`full-stack-web`/`mobile`/`multi-target`) + origin (`blank`/`template`/`github-import`/`fork`) form; `POST /projects` with Bearer; on 201 open the core builder screen for the Project_Session; on 400 show specific validation message + keep editable; on 429 show named limit + keep editable; origin-specific gates (template select, github-import repo ref, fork source project)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_
  - [ ]* 9.2 Write property test for project creation outcomes
    - **Property 23: A created project opens its session, and a validation error stays editable**
    - **Validates: Requirements 7.2, 7.3, 7.4**
  - [ ]* 9.3 Write unit tests for origin-specific form gates and option presence
    - template (7.6), github-import (7.7), fork (7.8); categories/origins present (7.1)
    - _Requirements: 7.1, 7.6, 7.7, 7.8_

- [ ] 10. Workspace shell: experience switching and layout
  - [ ] 10.1 Implement the workspace controller and layout view
    - Create `src/server/public/workspace.js` and `src/server/public/views/layout.js`: experience select (5 options) → `POST /workspace-experience` with Bearer; apply `workspace_experience` frame as **layout only** (never mutate theme/work-mode/project/preview); render `attribution` when present; default via `GET /workspace-experience`; `custom` arrange + save
    - Layout arranges surfaces per the layout descriptor; single-column touch layout for `mobile-command-center`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 11.1_
  - [ ]* 10.2 Write property test for layout-only application
    - **Property 24: Applying a Workspace_Experience frame changes layout only**
    - **Validates: Requirements 8.3, 8.4**
  - [ ]* 10.3 Write property test for selection dispatch (experience + work mode)
    - **Property 25: Selecting a Workspace_Experience or Work_Mode posts the selected value**
    - **Validates: Requirements 8.2, 10.4**
  - [ ]* 10.4 Write unit test for the default experience bootstrap
    - Render default reported by `GET /workspace-experience` when none selected (8.5); experiences option set present (8.1)
    - _Requirements: 8.1, 8.5_

- [ ] 11. Workspace shell: theme rendering and preview-then-commit
  - [ ] 11.1 Implement the theme controller and palette application
    - Create `src/server/public/theme.js`: apply a `theme` frame's palette by setting the nine `--color-*` CSS custom properties on `document.documentElement`; catalog control for the 8 themes; preview (`POST /theme` action `preview`, apply without committing), commit (action `commit`, apply + record committed), cancel/navigate-away reverts to committed palette; `unsupported_theme` 400 and timeout/other non-200 keep committed palette + show message; default via `GET /theme`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_
  - [ ]* 11.2 Write property test for full-palette application
    - **Property 26: Applying a theme frame sets the full palette on the surface**
    - **Validates: Requirements 9.1**
  - [ ]* 11.3 Write property test for preview/commit/cancel state machine
    - **Property 27: Theme preview is non-committing and cancel is a round-trip to committed**
    - **Validates: Requirements 9.3, 9.4, 9.5**
  - [ ]* 11.4 Write property test for failed theme change
    - **Property 28: A failed theme change keeps the last committed palette applied**
    - **Validates: Requirements 9.6, 9.7**
  - [ ]* 11.5 Write unit test for default theme bootstrap and theme option set
    - Default palette via `GET /theme` recorded as committed (9.8); 8-theme control present (9.2)
    - _Requirements: 9.2, 9.8_

- [ ] 12. Workspace shell: Work_Mode header and mobile layout
  - [ ] 12.1 Implement the work-mode controller and session header view
    - Create `src/server/public/work-mode.js` and `src/server/public/views/session-header.js`: display active Work_Mode + switch control (`vibe`/`spec`/`hybrid`) → `POST /work-mode` with Bearer; update from `session_header`/`work_mode` frames; new session defaults to `vibe`; header always visible (including 360px) showing experience + theme; touch-sized switch control
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 11.3, 11.4_
  - [ ]* 12.2 Write property test for work-mode/session-header frame application
    - **Property 29: A Work_Mode / session_header frame sets the displayed mode and choices**
    - **Validates: Requirements 10.2**
  - [ ]* 12.3 Write unit test for the new-session vibe default
    - Display `vibe` until a differing frame is received (10.5); mode option set present (10.3)
    - _Requirements: 10.3, 10.5_
  - [ ]* 12.4 Write integration test for 360px Mobile Command Center layout
    - Single-column touch-operable layout; no horizontal overflow of the primary column at 360px; Work_Mode stays visible
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

- [ ] 13. Checkpoint — login + workspace shell complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Settings surfaces (last stage): provider, connectors, skills, memory, lifecycle
  - [ ] 14.1 Implement the provider-selection settings screen
    - Create `src/server/public/settings/provider.js`: list available providers, submit selection with Bearer, display active provider on confirm, on error display it + keep previously active provider selected
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
  - [ ] 14.2 Implement the connectors settings screen
    - Create `src/server/public/settings/connectors.js`: list catalog grouped by category, submit config with Bearer, transmit secret only over the authorized request and never render the stored secret back in plaintext, display bound state
    - _Requirements: 13.1, 13.2, 13.3, 13.4_
  - [ ] 14.3 Implement the skill-library and memory settings screens
    - Create `src/server/public/settings/skills.js` and `src/server/public/settings/memory.js`: list stocked/user skills + add/import with Bearer; list project/global memory + active mode, edit/prune with Bearer, change Memory_Mode (`auto`/`manual`/`off`) with Bearer
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_
  - [ ] 14.4 Implement build/deploy/export/lock-in-audit/share screen
    - Create `src/server/public/settings/lifecycle.js`: build/deploy submit with Bearer + display outcome; export requests package and provides it as a download; lock-in audit displays reported signals; share creates and displays the copyable URL; any `401` → re-auth without project detail
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_
  - [ ]* 14.5 Write property test for connector secret non-disclosure
    - **Property 30: A submitted connector secret is never rendered back in plaintext**
    - **Validates: Requirements 13.3**
  - [ ]* 14.6 Write unit tests for settings render/submit/outcome and export download
    - Render + submit-with-Bearer + outcome/error display for provider/connectors/skills/memory (12–14); export download side-effect (15.3); non-disclosing 401 (15.6)
    - _Requirements: 12.1, 12.3, 12.4, 13.1, 13.4, 14.1, 14.3, 15.3, 15.6_

- [ ] 15. Final wiring and non-disclosing error handling pass
  - [ ] 15.1 Wire the router and all controllers/views together in the bootstrap
    - Extend `src/server/public/app.js` to route between login, builder, workspace, and settings surfaces; register all controllers with the store; connect the `api.js` `onAccessDenied` hook to the auth controller's clear-and-return-to-login flow; add each new module file to the server route allow-list from Task 1.1
    - Verify no orphaned modules: every created module is imported and mounted
    - _Requirements: 1.3, 6.7, 16.1_
  - [ ]* 15.2 Write integration test for the full asset set under CSP
    - Load the assembled client under a CSP-enforcing context and assert no CSP violation is reported; re-run the no-inline / no-external structural check over the final asset set
    - _Requirements: 1.4_

- [ ] 16. Final checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks (property, unit, integration, smoke) and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references specific requirement sub-clauses for traceability; property-test tasks additionally reference their design Correctness Property number and title.
- All 31 design correctness properties are covered exactly once (Properties 1–4 in Tasks 2–3; 5–9 in Task 4; 10–15 in Task 5; 16–17 in Task 6; 18–22 in Task 8; 23 in Task 9; 24–25 in Task 10; 26–28 in Task 11; 29 in Task 12; 30 in Task 14; 31 in Task 2).
- Property tests use `fast-check` at ≥100 iterations, tagged `Feature: web-ui, Property {n}: {title}`, and exercise real reducers/validators/store/served-assets rather than over-mocked doubles.
- The only backend change is the additive static route in Task 1.1, reusing `securityHeaders()`; no runtime dependency is added anywhere.
- **Monetization/billing is a future phase and out of scope here** — no task implements plans, credits, metering, notifications, or edge rate limiting.
- Checkpoints (Tasks 7, 13, 16) mark the priority-order stage boundaries: core builder → login+shell → settings/final.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4", "1.5", "2.1"] },
    { "id": 2, "tasks": ["2.2", "8.1"] },
    { "id": 3, "tasks": ["2.3", "2.4", "3.1", "5.2", "8.2"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "4.1", "5.1", "8.3", "8.4", "8.5", "8.6", "8.7", "8.8"] },
    { "id": 5, "tasks": ["4.2", "4.6", "5.4", "5.5", "5.6", "5.7", "5.8", "9.1"] },
    { "id": 6, "tasks": ["4.3", "5.3", "6.1", "9.2", "9.3", "10.1", "11.1", "12.1"] },
    { "id": 7, "tasks": ["4.4", "4.5", "4.7", "4.8", "4.9", "5.9", "5.10", "6.2", "6.3", "10.2", "10.3", "10.4", "11.2", "11.3", "11.4", "11.5", "12.2", "12.3", "12.4"] },
    { "id": 8, "tasks": ["14.1", "14.2", "14.3", "14.4"] },
    { "id": 9, "tasks": ["14.5", "14.6"] },
    { "id": 10, "tasks": ["15.1"] },
    { "id": 11, "tasks": ["15.2"] }
  ]
}
```
