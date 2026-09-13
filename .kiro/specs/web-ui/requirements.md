# Requirements Document — Web UI **backend contract**

> ## Scope of this document, read before using it
>
> This spec is retained for **one reason**: it documents the backend surface the UI
> consumes, and ~40 shipped test files reference its numbered properties
> (`Feature: web-ui, Property N`). Do not delete it and do not renumber it.
>
> **The interface is NOT specified here.** `../ui-redesign/PLAN.md` owns the interface
> and is authoritative. The UI described below — a chat column with a preview panel,
> five Workspace Experience geometries, a Work Mode toggle in a header — has been
> replaced.
>
> | Requirements | Status for the client |
> |---|---|
> | 1–7, 12–16 | **Still binding.** Static-asset delivery, prompt submission, SSE Activity Stream, preview pipeline, confirm approvals, OIDC login, project creation, provider, connectors, skills/memory, build/deploy/export/share, non-disclosing errors |
> | 9 | **Still binding.** Theme palette application and preview-then-commit. `ui-redesign` builds directly on it |
> | 8, 10, 11 | **Superseded.** Workspace Experience switching, Work Mode as a header control, and Mobile Command Center as one experience among five. Replaced by the three-surface model in `PLAN.md` §3. The backend endpoints still exist; the client no longer renders five geometries |
>
> Its `tasks.md` was **deleted** — the checkboxes were long out of sync with the code
> and were actively misleading. `../ui-redesign/tasks.md` is the live plan.
> Its `screenshots/` were **deleted** — they pictured the replaced UI.

## Introduction

This document specifies the requirements for the **Web UI** — the browser-based front-end for the existing `ai-app-builder` platform. Today the platform is API-complete but **API-only**: every capability is reachable over HTTP (JSON) and Server-Sent Events (SSE), but there is **no** browser front-end at all. Opening the deployed platform in a browser returns raw JSON rather than screens, and logging in returns a raw JSON bearer token that a user would have to copy and paste by hand.

The Web UI closes that gap. It is a browser client that renders screens over the platform's existing HTTP + SSE surface — it does **not** change, re-specify, or reimplement any backend behavior. The backend facts it integrates with (real OIDC login via GitHub/Google, the Builder Server over HTTP + SSE, project lifecycle, project origins, templates, refinement, self-healing, the preview pipeline, connectors, the skill library, memory, provider selection, build/deploy, export + lock-in audit, sharing, Workspace Experiences, Work Modes, and Themes) are treated as **fixed contracts** the UI consumes.

The work is deliberately staged, minimal-but-real first, then grown — not delivered as one big bang. The priority order is:

1. **Core builder screen** (the heart of the product): a prompt box, a live Activity Stream fed by SSE, and a preview pane — the describe-an-app-and-watch-it-build experience.
2. **Browser login handling**: complete the OIDC round-trip in the browser and store/use the bearer token automatically for all subsequent API and SSE calls, replacing the copy-paste-a-token workflow.
3. **Workspace shell**: switch between Workspace Experiences; render the per-surface named color Themes that already exist as data but are not yet rendered by anything; show and switch the active Work Mode in the header.
4. **Settings screens and the remaining surfaces**: provider selection, connectors, skill library, memory, project lifecycle management, build/deploy, export + lock-in audit, and sharing.

### Product and platform constraints

These constraints shape the requirements and are carried through deliberately:

- **This platform is intended to grow beyond personal use.** The current build is single-instance and is being built UI-first, but the goal is a product the owner can eventually offer to other people and earn income from. The Web UI should be built so it does not block that future.
- **Money-making features come in a later phase, after the UI.** Today there is **no** billing/metering, **no** email/notifications, and **no** HTTP-edge rate limiting, and this document does not specify them. Subscription plans, credit packs, and related paid features are a deliberate future phase that will be specified once the UI described here is complete.
- **No added runtime dependencies.** The `ai-app-builder` package ships with zero runtime dependencies (its only devDependency is `fast-check`). The Web UI MUST NOT introduce a runtime dependency into the `ai-app-builder` package and MUST be deliverable as same-origin static assets the existing Builder Server can serve, consistent with the server's `default-src 'self'` / `connect-src 'self'` Content-Security-Policy. This constraint is called out explicitly wherever it bears on a requirement.
- **Phone usability is required.** The Web UI MUST be usable on a phone via the Mobile Command Center experience; the platform itself runs on Android via Termux.
- **PKCE is not yet implemented** in the backend login flow; the Web UI relies on the backend's existing cookie-bound `state` CSRF protection and MUST NOT assume a PKCE code-verifier round-trip.
- **The preview pipeline pushes most, but not all, status over SSE.** A dead preview is currently detected by polling `GET /preview`, not pushed over SSE. The Web UI MUST accommodate this specific gap for preview liveness.

## Glossary

- **Web_UI**: The browser-based front-end client specified by this document; renders screens over the platform's existing HTTP + SSE surface and holds no server-side authority of its own.
- **Builder_Server**: The existing HTTP + SSE server (`src/server/builder-server.js`) the Web_UI calls; exposes `/healthz`, `/auth/login`, `/auth/callback`, `/events`, `/message`, `/confirm`, `/projects`, `/preview`, `/preview/restart`, `/workspace-experience`, `/work-mode`, and `/theme`.
- **Activity_Stream**: The live, ordered feed of the Builder_Agent's streamed reasoning text, tool actions, and inline file Diffs, delivered to the Web_UI as SSE frames on the `/events` stream for a Project Session.
- **SSE_Frame**: A single Server-Sent-Events message on the `/events` stream, carrying a typed payload (for example `preview_status`, `confirm_request`, `error`, `work_mode`, `session_header`, `workspace_experience`, `theme`, or an Activity_Stream event).
- **Preview_Pane**: The Web_UI surface that displays the running Preview of a Project via the URL supplied by the preview pipeline.
- **Preview_Status**: The lifecycle state of a Project's Preview as reported by the backend, one of `loading`, `ready`, `error`, `showing_prior`, or `persistent_failure`.
- **Bearer_Token**: The session token minted by the backend login flow (`{ token, accountId, expiresAt, tokenType: 'Bearer' }`) that every gated request must carry as `Authorization: Bearer <token>`.
- **Token_Store**: The Web_UI's client-side holder of the Bearer_Token and its associated `accountId` and `expiresAt`, used to authorize subsequent API and SSE calls.
- **Login_Flow**: The backend OIDC round-trip the Web_UI drives — `GET /auth/login` (redirect to the identity provider) then `GET /auth/callback` (which returns the Bearer_Token) — provided by GitHub or Google.
- **Confirm_Prompt**: A confirm-class command approval surfaced to the Web_UI as a `confirm_request` SSE_Frame, answered by `POST /confirm`; unanswered prompts fail closed at the backend.
- **Project_Session**: The backend session keyed by (authenticated `accountId`, `projectId`) that owns one Activity_Stream, its Preview status, and its Work_Mode.
- **Workspace_Experience**: A user-selected, layout-only arrangement of the builder surfaces, one of `kiro-style`, `vibe-first`, `technical-workbench`, `mobile-command-center`, or `custom`; selecting one changes layout only.
- **Work_Mode**: A per-Session interaction flow, one of `vibe`, `spec`, or `hybrid`, shown and switchable in the Session_Header; `vibe` is the default for a new Session.
- **Session_Header**: The persistent header region of the Web_UI that always displays the active Work_Mode and offers a control to switch it, alongside the current Workspace_Experience and Theme.
- **Theme**: A named visual appearance, one of `light`, `dark`, `pastel-pasture`, `out-there`, `paranormal-purple`, `morning-dew`, `summer-sunset`, or `peach-popsicle`, each carrying a color Palette; committed per (User_Account, Workspace_Experience) pair.
- **Palette**: The frozen color map a Theme carries (`background`, `surface`, `accent`, `button`, `badge`, `statusInfo`, `statusSuccess`, `statusWarning`, `statusError`), which the Web_UI applies to render the surface.
- **User_Account**: The authenticated identity the Bearer_Token represents, on whose behalf the Web_UI makes all gated calls.
- **Access_Denied_Response**: The backend's single, non-disclosing denial (HTTP 401 with a generic body) returned for any unauthenticated or unauthorized request.

## Requirements

### Requirement 1: Serve the Web UI as same-origin static assets

**User Story:** As a platform operator, I want the browser front-end delivered without adding runtime dependencies, so that the platform keeps its zero-runtime-dependency, single-instance posture and its same-origin security model.

#### Acceptance Criteria

1. THE Web_UI SHALL be delivered as static assets served from the same origin as the Builder_Server so that all API and SSE calls satisfy the Builder_Server's `connect-src 'self'` Content-Security-Policy.
2. THE Web_UI SHALL add no runtime dependency to the `ai-app-builder` package.
3. WHEN a browser requests the application root path of the deployed platform, THE Web_UI SHALL return an HTML document that loads the browser client rather than a raw JSON payload.
4. THE Web_UI SHALL load and execute under the Builder_Server's `script-src 'self'` and `style-src 'self'` Content-Security-Policy without requiring inline-script or external-origin exceptions.
5. WHERE the Builder_Server exposes the unauthenticated `GET /healthz` endpoint, THE Web_UI SHALL NOT require a Bearer_Token to load its initial HTML shell.

### Requirement 2: Core builder prompt submission

**User Story:** As a builder user, I want a prompt box where I describe or refine an app, so that I can drive the build without hand-crafting API calls.

#### Acceptance Criteria

1. THE Web_UI SHALL present a prompt input control that accepts 1 to 10,000 characters and a submit control on the core builder screen.
2. WHEN a user submits a prompt containing 1 to 10,000 characters after trimming leading and trailing whitespace for an open Project_Session, THE Web_UI SHALL send the trimmed prompt to the Builder_Server via `POST /message` carrying the `Authorization: Bearer <token>` header from the Token_Store.
3. IF a user submits a prompt whose content has zero characters after trimming leading and trailing whitespace, THEN THE Web_UI SHALL reject the submission, SHALL NOT call `POST /message`, SHALL retain any entered characters in the prompt input control, and SHALL display a message requesting prompt text.
4. IF a user submits a prompt exceeding 10,000 characters after trimming leading and trailing whitespace, THEN THE Web_UI SHALL reject the submission, SHALL NOT call `POST /message`, SHALL retain the entered text in the prompt input control, and SHALL display a message indicating the 10,000-character maximum.
5. WHILE a turn is in flight for the open Project_Session, THE Web_UI SHALL display a running-turn indicator and SHALL disable the submit control so that a second concurrent prompt for that Project_Session cannot be submitted.
6. WHEN a `POST /message` request does not receive any response within 30 seconds, THE Web_UI SHALL end the in-flight state for that Project_Session, SHALL re-enable the submit control, SHALL retain the submitted prompt text for retry, and SHALL display a message indicating the request timed out.
7. IF a `POST /message` request returns an Access_Denied_Response, THEN THE Web_UI SHALL surface a re-authentication prompt and SHALL NOT display any Project-specific detail from the response.
8. IF a `POST /message` request returns an HTTP 429 naming an exceeded limit, THEN THE Web_UI SHALL display the named limit to the user and SHALL keep the submitted prompt text available for retry.

### Requirement 3: Live Activity Stream over SSE

**User Story:** As a builder user, I want to watch the agent's reasoning, tool actions, and file changes stream live, so that I can follow the build as it happens.

#### Acceptance Criteria

1. WHEN a Project_Session is opened, THE Web_UI SHALL open an SSE connection to `GET /events` for that Project_Session authorized with the Bearer_Token within 2 seconds of the Project_Session view rendering.
2. IF the SSE connection request to `/events` is rejected due to a missing, expired, or invalid Bearer_Token, THEN THE Web_UI SHALL display an authorization-failure message indicating re-authentication is required and SHALL NOT open the Activity_Stream view.
3. WHEN an Activity_Stream SSE_Frame carrying streamed reasoning or tool-action content is received, THE Web_UI SHALL append the content to the Activity_Stream view in ascending order of each frame's monotonic sequence identifier, and SHALL render each frame within 500 milliseconds of receipt.
4. WHEN an SSE_Frame carrying a file Diff is received, THE Web_UI SHALL render the Diff with added lines and removed lines visually distinguished by a persistent, non-color-only indicator (for example a `+` or `-` prefix marker) in addition to any color styling.
5. WHEN the SSE connection to `/events` drops, THE Web_UI SHALL attempt to reconnect at intervals not exceeding 5 seconds for up to a maximum of 10 consecutive attempts.
6. IF the SSE connection to `/events` has not been re-established after 10 consecutive reconnection attempts, THEN THE Web_UI SHALL display a connection-lost message indicating the stream is disconnected and SHALL provide a manual reconnect control.
7. WHEN the SSE connection to `/events` is re-established, THE Web_UI SHALL render the current-state frames the Builder_Server replays, including the current Preview_Status, Work_Mode, Session_Header, Workspace_Experience, Theme, and any pending Confirm_Prompt.
8. IF an SSE_Frame of type `error` is received, THEN THE Web_UI SHALL display the frame's generic user message and its correlation id and SHALL NOT display any raw error cause, stack trace, or internal diagnostic detail.
9. WHERE an SSE_Frame exceeds 1,048,576 bytes or carries a type not in the Web_UI's set of recognized frame types, THE Web_UI SHALL discard the frame without rendering it and SHALL keep the Activity_Stream SSE connection open.

### Requirement 4: Preview pane

**User Story:** As a builder user, I want a live preview of my app beside the activity feed, so that I can see the effect of the build immediately.

#### Acceptance Criteria

1. WHEN a `preview_status` SSE_Frame with status `ready` and a non-empty `url` is received, THE Web_UI SHALL display the running Preview at that `url` in the Preview_Pane within 1 second of frame receipt, replacing any prior loading indicator or Preview content.
2. IF a `preview_status` SSE_Frame with status `ready` is received with a missing or empty `url`, THEN THE Web_UI SHALL retain the previously displayed Preview_Pane state and display an error indication that the ready Preview URL was unavailable.
3. WHILE the most recent Preview_Status is `loading`, THE Web_UI SHALL display a preview-loading indicator in the Preview_Pane and SHALL suppress display of any previously rendered Preview content.
4. WHEN a `preview_status` SSE_Frame with status `showing_prior` is received, THE Web_UI SHALL display a visible indicator that the Preview_Pane is showing a prior Project state, and WHERE the frame includes a non-empty safe cause summary THE Web_UI SHALL display that summary text.
5. WHEN a `preview_status` SSE_Frame with status `error` or `persistent_failure` is received, THE Web_UI SHALL display a failure-state indication in the Preview_Pane and, WHERE the frame includes a non-empty safe cause summary, SHALL display that summary text.
6. WHERE a received `preview_status` SSE_Frame reports `restartOffered` as true, THE Web_UI SHALL present a restart control that, WHEN activated by the user, calls `POST /preview/restart`.
7. WHILE a Project_Session is open, THE Web_UI SHALL poll `GET /preview` every 5 seconds to detect a dead Preview that is not pushed over SSE.
8. WHEN a `GET /preview` poll response reports a non-live Preview, THE Web_UI SHALL update the Preview_Pane status to a failure-state indication within 1 second of receiving the response.
9. IF a `GET /preview` poll request fails to return a response within 5 seconds or returns a non-success result, THEN THE Web_UI SHALL retain the last known Preview_Pane status and continue polling on the next interval.
10. WHERE a Project has a `mobile` Target and the backend supplies mobile connection details including a non-empty connection URL, THE Web_UI SHALL display the connection URL as selectable text and a scannable QR code encoding that URL in the Preview_Pane.
11. THE Web_UI SHALL render the Preview inside a same-origin container consistent with the Builder_Server's `frame-ancestors 'none'` policy.

### Requirement 5: Confirm-class command approvals

**User Story:** As a builder user, I want to approve or deny risky commands the agent proposes, so that nothing destructive runs without my consent.

#### Acceptance Criteria

1. WHEN a `confirm_request` SSE_Frame is received, THE Web_UI SHALL display the confirm prompt with its approve and deny controls.
2. WHEN a user approves or denies a Confirm_Prompt, THE Web_UI SHALL send the decision to `POST /confirm` carrying the frame's request id and the Bearer_Token.
3. WHILE a Confirm_Prompt is unanswered, THE Web_UI SHALL keep the prompt visible so that the user can act before the backend's fail-closed timeout elapses.
4. WHEN the Web_UI reconnects to `/events` and the Builder_Server replays a still-pending Confirm_Prompt, THE Web_UI SHALL re-display that prompt.
5. IF a `POST /confirm` request returns an Access_Denied_Response, THEN THE Web_UI SHALL surface a re-authentication prompt and SHALL NOT disclose Project-specific detail.

### Requirement 6: Browser OIDC login

**User Story:** As a user, I want to log in with GitHub or Google in the browser, so that I never have to copy and paste a bearer token by hand.

#### Acceptance Criteria

1. WHILE no valid Bearer_Token is held in the Token_Store, THE Web_UI SHALL present a login control that, when activated, navigates the browser to `GET /auth/login` within 500 milliseconds of activation.
2. WHEN the browser returns to the `/auth/callback` destination and the Builder_Server responds with an HTTP 200 Bearer_Token payload containing non-empty `token`, non-empty `accountId`, and an ISO-8601 `expiresAt` timestamp, THE Web_UI SHALL store all three of `token`, `accountId`, and `expiresAt` in the Token_Store as a single atomic write.
3. IF the `/auth/callback` HTTP 200 payload is missing any of `token`, `accountId`, or `expiresAt`, or `expiresAt` is not a valid future ISO-8601 timestamp, THEN THE Web_UI SHALL discard the payload without writing to the Token_Store, SHALL display a generic login-failed message, and SHALL return the user to the login control.
4. WHILE a Bearer_Token is present in the Token_Store, THE Web_UI SHALL attach the `Authorization: Bearer <token>` header to every subsequent gated API request and to the `/events` SSE connection.
5. IF the `/auth/callback` response is an Access_Denied_Response, THEN THE Web_UI SHALL display a generic login-failed message and SHALL return the user to the login control without writing any value to the Token_Store.
6. IF the `/auth/callback` response is an HTTP 400 carrying a login-protocol `code`, THEN THE Web_UI SHALL display a generic login-failed message that excludes the raw `code` value and SHALL present a control that restarts the Login_Flow.
7. WHEN the current time reaches or exceeds the stored `expiresAt`, OR a gated request returns an Access_Denied_Response, THE Web_UI SHALL remove all stored fields (`token`, `accountId`, `expiresAt`) from the Token_Store and SHALL return the user to the login control within 1 second.
8. THE Web_UI SHALL rely on the Builder_Server's cookie-bound `state` for login CSRF protection and SHALL NOT send a PKCE code verifier in any Login_Flow request.
9. WHEN a user activates a logout control, THE Web_UI SHALL remove all stored fields (`token`, `accountId`, `expiresAt`) from the Token_Store and SHALL return the user to the login control within 1 second.

### Requirement 7: Project creation and selection

**User Story:** As a builder user, I want to create a project by choosing its category and origin, so that I can start building from a blank project, a template, a GitHub import, or a fork.

#### Acceptance Criteria

1. THE Web_UI SHALL present a project-creation form offering a Target_Category selection of `web`, `full-stack-web`, `mobile`, or `multi-target` and a Project_Origin selection of `blank`, `template`, `github-import`, or `fork`.
2. WHEN a user submits the project-creation form with a supported Target_Category and Project_Origin, THE Web_UI SHALL call `POST /projects` with the selected values and the Bearer_Token.
3. WHEN `POST /projects` returns HTTP 201 with a created project id, THE Web_UI SHALL open the core builder screen for that Project_Session.
4. IF `POST /projects` returns an HTTP 400 validation error, THEN THE Web_UI SHALL display the specific validation message and SHALL keep the form editable.
5. IF `POST /projects` returns an HTTP 429 naming an exceeded limit, THEN THE Web_UI SHALL display the named limit and SHALL keep the form editable.
6. WHERE the selected Project_Origin is `template`, THE Web_UI SHALL let the user select an available Template before submission.
7. WHERE the selected Project_Origin is `github-import`, THE Web_UI SHALL collect the source repository reference before submission.
8. WHERE the selected Project_Origin is `fork`, THE Web_UI SHALL let the user select an accessible source Project before submission.

### Requirement 8: Workspace Experience switching

**User Story:** As a builder user, I want to switch between workspace layouts, so that I can use the arrangement that fits my task and my device.

#### Acceptance Criteria

1. THE Web_UI SHALL present a control to select a Workspace_Experience among `kiro-style`, `vibe-first`, `technical-workbench`, `mobile-command-center`, and `custom`.
2. WHEN a user selects a Workspace_Experience, THE Web_UI SHALL call `POST /workspace-experience` with the selected experience and the Bearer_Token.
3. WHEN a `workspace_experience` SSE_Frame is received, THE Web_UI SHALL rearrange the visible surfaces to match the frame's layout descriptor and SHALL NOT alter Project data, the Theme, the Work_Mode, or any other setting.
4. WHERE a received `workspace_experience` frame carries an `attribution` credit, THE Web_UI SHALL display that credit within the corresponding layout.
5. WHEN the Web_UI first loads for a User_Account that has selected no Workspace_Experience, THE Web_UI SHALL render the default Workspace_Experience reported by `GET /workspace-experience`.
6. WHERE the selected Workspace_Experience is `custom`, THE Web_UI SHALL let the user arrange the surfaces and save the arrangement via `POST /workspace-experience`.

### Requirement 9: Theme rendering and preview-then-commit

**User Story:** As a builder user, I want to see and change my color theme and have it visibly render, so that the named palettes that exist as data actually appear on screen.

#### Acceptance Criteria

1. WHEN a `theme` SSE_Frame is received, THE Web_UI SHALL apply the frame's Palette to the rendered surface within 200 milliseconds of receipt so that every surface element styled by the Palette reflects the new Palette values.
2. THE Web_UI SHALL present a control that allows the user to select any one of the eight catalog Themes defined for the current Workspace_Experience.
3. WHEN a user selects a Theme in preview mode, THE Web_UI SHALL call `POST /theme` with `action` `preview` and SHALL apply the returned `previewed` Palette to the rendered surface without recording the Theme as committed.
4. WHEN a user commits a previewed Theme, THE Web_UI SHALL call `POST /theme` with `action` `commit` and SHALL apply the returned committed Palette to the rendered surface and record it as the last committed Theme.
5. WHEN a user cancels a Theme preview or navigates away from the preview without committing, THE Web_UI SHALL revert the rendered surface to the Palette of the last committed Theme within 200 milliseconds.
6. IF a `POST /theme` request returns an HTTP 400 response with code `unsupported_theme`, THEN THE Web_UI SHALL keep the last committed Theme's Palette applied to the rendered surface and SHALL display a message indicating the selected Theme is unsupported.
7. IF a `POST /theme` request fails to return a response within 5 seconds or returns any HTTP status other than 200 (excluding the `unsupported_theme` case in criterion 6), THEN THE Web_UI SHALL keep the last committed Theme's Palette applied to the rendered surface and SHALL display a message indicating the Theme change could not be completed.
8. WHEN the Web_UI first renders a Workspace_Experience for which the User_Account has committed no Theme, THE Web_UI SHALL call `GET /theme` and SHALL apply the default Theme's Palette reported for that experience as the last committed Theme.

### Requirement 10: Work Mode display and switching

**User Story:** As a builder user, I want to see and change my work mode in the header, so that I can choose whether the agent builds directly, plans first, or blends the two.

#### Acceptance Criteria

1. WHILE a Project_Session is open, THE Web_UI SHALL display the active Work_Mode in the Session_Header.
2. WHEN a `session_header` or `work_mode` SSE_Frame is received, THE Web_UI SHALL update the displayed active Work_Mode and its offered choices to match the frame.
3. THE Web_UI SHALL present a control in the Session_Header to switch the Work_Mode among the offered choices `vibe`, `spec`, and `hybrid`.
4. WHEN a user switches the Work_Mode, THE Web_UI SHALL call `POST /work-mode` with the selected mode and the Bearer_Token.
5. WHEN the Web_UI first opens a new Project_Session, THE Web_UI SHALL display `vibe` as the active Work_Mode until a differing frame is received.

### Requirement 11: Mobile Command Center usability on a phone

**User Story:** As a user on a phone, I want a usable mobile layout, so that I can drive builds from my Android device where the platform runs via Termux.

#### Acceptance Criteria

1. WHERE the active Workspace_Experience is `mobile-command-center`, THE Web_UI SHALL render the prompt box, the Activity_Stream, and the Preview_Pane in a single-column, touch-operable layout.
2. THE Web_UI SHALL render on a viewport width of 360 CSS pixels without horizontal scrolling of the primary content column.
3. THE Web_UI SHALL size the prompt-submit, confirm-approve, confirm-deny, and Work_Mode-switch controls to be operable by touch on a phone.
4. WHILE running on a phone-width viewport, THE Web_UI SHALL keep the active Work_Mode visible in the Session_Header.

### Requirement 12: Provider selection settings

**User Story:** As a builder user, I want to choose the model provider in settings, so that the agent runs turns against the provider I want.

#### Acceptance Criteria

1. THE Web_UI SHALL present a settings screen that displays the available model providers reported by the backend.
2. WHEN a user selects a model provider, THE Web_UI SHALL submit the selection to the backend provider-selection endpoint with the Bearer_Token.
3. WHEN the backend confirms a provider selection, THE Web_UI SHALL display the active provider in the settings screen.
4. IF a provider-selection request returns an error, THEN THE Web_UI SHALL display the error and SHALL leave the previously active provider selected.

### Requirement 13: Connectors management

**User Story:** As a builder user, I want to manage connectors in the UI, so that my project can integrate external services without hand-editing secrets.

#### Acceptance Criteria

1. THE Web_UI SHALL present a connectors screen listing the available Connector_Catalog entries grouped by Connector_Category.
2. WHEN a user configures a Connector, THE Web_UI SHALL submit the connector configuration to the backend connector endpoint with the Bearer_Token.
3. WHEN a user enters a Secret value for a Connector, THE Web_UI SHALL transmit the Secret only over the authorized request and SHALL NOT display the stored Secret value back in plaintext after submission.
4. WHEN the backend reports a Connector as bound to the Project, THE Web_UI SHALL display the Connector's bound state.

### Requirement 14: Skill library and memory management

**User Story:** As a builder user, I want to view and manage my skills and memory, so that I control the context the agent uses and can keep it editable and owned.

#### Acceptance Criteria

1. THE Web_UI SHALL present a skill-library screen listing the Stocked_Skills and the User_Account's User_Skills reported by the backend.
2. WHEN a user adds or imports a User_Skill, THE Web_UI SHALL submit the Skill to the backend skill endpoint with the Bearer_Token.
3. THE Web_UI SHALL present a memory screen that lists the Project_Memory and Global_Memory entries reported by the backend and displays the active Memory_Mode.
4. WHEN a user edits or prunes a Memory_Entry, THE Web_UI SHALL submit the change to the backend memory endpoint with the Bearer_Token.
5. WHEN a user changes the Memory_Mode among `auto`, `manual`, and `off`, THE Web_UI SHALL submit the selected Memory_Mode to the backend.

### Requirement 15: Build, deploy, export, lock-in audit, and sharing

**User Story:** As a builder user, I want to build, deploy, export, audit, and share my project from the UI, so that I can ship and move my work without leaving the browser.

#### Acceptance Criteria

1. WHEN a user invokes a build, THE Web_UI SHALL submit the build request to the backend build endpoint with the Bearer_Token and SHALL display the build outcome.
2. WHEN a user invokes a deploy, THE Web_UI SHALL submit the deploy request to the backend deploy endpoint with the Bearer_Token and SHALL display the deploy outcome.
3. WHEN a user invokes an export, THE Web_UI SHALL request the Project_Export from the backend export endpoint with the Bearer_Token and SHALL provide the exported package to the user as a download.
4. WHEN a user invokes a lock-in audit, THE Web_UI SHALL request the Lockin_Audit from the backend and SHALL display the reported lock-in signals.
5. WHEN a user creates a Share_Link, THE Web_UI SHALL request the Share_Link from the backend sharing endpoint with the Bearer_Token and SHALL display the resulting URL for copying.
6. IF any of these requests returns an Access_Denied_Response, THEN THE Web_UI SHALL surface a re-authentication prompt and SHALL NOT disclose Project-specific detail.

### Requirement 16: Non-disclosing error handling

**User Story:** As a security-conscious operator, I want the UI to honor the backend's non-disclosing denials, so that the front-end never leaks resource existence or internal detail.

#### Acceptance Criteria

1. WHEN the Web_UI receives an Access_Denied_Response for any request, THE Web_UI SHALL display a single generic access-denied indication and SHALL NOT infer or display whether a Project or resource exists.
2. WHEN the Web_UI receives an `error` SSE_Frame, THE Web_UI SHALL display only the generic user message and correlation id it carries.
3. THE Web_UI SHALL NOT persist the Bearer_Token in a location readable by another origin.
