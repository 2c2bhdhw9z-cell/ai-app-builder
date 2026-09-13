# Requirements Document

Scope owner is `PLAN.md`. This document states the requirements in EARS form.
Earlier content describing a region grid, five per-experience geometries, or a
canvas-plus-sheet shell was **deleted**, not annotated, so it cannot mislead.

## Introduction

The Web UI is being rewritten as **three surfaces over one shared project**: Vibe,
IDE, and Preview. The mode a user is in selects which surface is mounted; it does not
rearrange a shared screen. Switching mode resets nothing.

The backend is a **fixed contract**. Its HTTP + SSE surface, auth, project lifecycle,
preview pipeline and non-disclosing error behaviour are consumed unchanged and are
specified by the `web-ui` spec, which remains authoritative for backend behaviour
only.

Two pieces are already built, tested, and are inputs rather than deliverables: the
derived colour engine (`deriveDecisions`) and the token scales. The WCAG AA body-text
defect they fixed is closed.

### Constraints carried deliberately

- **No new dependency.** No CSS framework, build step, bundler or preprocessor.
  Vanilla CSS and vanilla ES modules; `fast-check` stays the only devDependency.
- **CSP** `script-src 'self'` / `style-src 'self'` / `font-src 'self'`. No inline
  script or style, no inline handlers, no external origin. Themes apply through the
  CSSOM.
- **Phone-first.** 360px with no horizontal overflow; touch targets ≥44px.
- **All eight catalogue themes plus arbitrary user palettes** must render correctly.

### Accessibility scope statement

Computed contrast is machine-checkable and is enforced. It is **not** conformance.
Full WCAG validation requires manual testing with assistive technologies and expert
accessibility review.

## Glossary

- **Mode**: The selected surface — `vibe`, `ide`, or `preview`. Presentation state
  only; never sent to the backend.
- **Surface**: A complete interface mounted by the mode router. Reads shared state and
  renders; never owns project state.
- **Compose_Bar**: The shared input component hosted by Vibe and IDE, carrying the
  text input, voice, model selector, Context_Gauge and Attachments.
- **Context_Gauge**: The indicator of how full a model's context window is, drawn as a
  square filling bottom-up whose colour band shifts as it fills.
- **Attachment**: A user-supplied image, video or file staged for the next turn.
- **Autonomy_Level**: One of `ask`, `auto`, `full`, governing how often the agent
  stops for approval.
- **Destructive_Command**: A command that deletes data, rewrites history, or affects a
  shared or production system.
- **Palette**: The nine themeable colour inputs. Every other colour derives from them.
- **Derived_Token**: Any colour token that is a pure function of the Palette.

## Requirements

### Requirement 1: Mode switching preserves everything

**User Story:** As a builder, I want to switch between vibe and the editor without
losing my place, so that the mode is a lens on my project rather than a restart.

#### Acceptance Criteria

1. THE Mode SHALL select which Surface is mounted and SHALL NOT rearrange a shared screen.
2. WHEN a user switches Mode, THE system SHALL preserve the project files, the conversation history, the preview lifecycle state, and any in-flight turn.
3. THE Mode SHALL be presentation state only and SHALL NOT be transmitted to the backend.
4. WHILE a turn is in flight, THE system SHALL allow a Mode switch without cancelling the turn or dropping the SSE connection.
5. A Surface SHALL read shared state and SHALL NOT own project state.

### Requirement 2: The compose bar is shared

**User Story:** As a builder, I want the same input controls wherever I am, so that I
do not relearn the interface per mode.

#### Acceptance Criteria

1. THE Compose_Bar SHALL be a single component hosted by both the Vibe and IDE Surfaces.
2. THE Compose_Bar SHALL present a text input, a hold-to-talk voice control, a model selector, a Context_Gauge, and an Attachments control.
3. WHERE the host Surface is IDE, THE Compose_Bar SHALL additionally present the Autonomy_Level state.
4. THE Compose_Bar SHALL size every interactive control to at least 44 CSS pixels in both dimensions.
5. IF a submission is empty after trimming, THEN THE Compose_Bar SHALL reject it, retain any entered text, and request prompt text.

### Requirement 3: Model selection and context reporting

**User Story:** As a builder, I want to see which model I am using and how full its
context is, so that I know when quality will degrade or compaction will happen.

#### Acceptance Criteria

1. THE Compose_Bar SHALL display the active model and SHALL open a picker listing the available models.
2. THE picker SHALL display a Context_Gauge and a token count for each listed model.
3. THE Context_Gauge SHALL render a fill fraction equal to used tokens divided by the model's limit, clamped to the range 0 to 1, and SHALL shift colour band as the fraction rises.
4. WHERE a model's context limit is unknown, THE Context_Gauge SHALL render an indeterminate state and SHALL NOT display a fabricated number.
5. THE system SHALL label context usage as an estimate derived from the running transcript and SHALL NOT present it as a billed figure.
6. WHERE a model is near its context limit, THE system SHALL indicate that compaction is imminent.
7. WHEN a user selects a different model, THE system SHALL preserve the project and the conversation.
8. IF a model selection fails, THEN THE system SHALL keep the previously active model selected and SHALL surface the failure.

### Requirement 4: Attachments

**User Story:** As a builder on a phone, I want to hand the agent a screenshot or a
file, so that I can show it what I mean instead of describing it.

#### Acceptance Criteria

1. THE Compose_Bar SHALL offer camera capture, video, photo library, and file selection, plus a list of recent items.
2. WHEN a user stages an Attachment, THE Compose_Bar SHALL display it as a thumbnail with a control to remove it before submission.
3. WHEN a turn is submitted with staged Attachments, THE system SHALL transmit them with that turn over the authorized request.
4. IF an Attachment exceeds the accepted size or type, THEN THE system SHALL reject it before upload, SHALL name the limit, and SHALL retain the entered prompt text.

### Requirement 5: Autonomy in IDE mode

**User Story:** As a builder, I want the agent to keep going without asking me at every
step, so that long work does not need babysitting — but not at the cost of safety.

#### Acceptance Criteria

1. THE IDE Surface SHALL present an Autonomy_Level control offering `ask`, `auto`, and `full`.
2. WHILE the agent is running autonomously, THE IDE Surface SHALL display the plan with each step marked completed, current, or pending, and SHALL present a stop control.
3. WHERE a command is auto-approved, THE system SHALL name that command in the transcript.
4. THE system SHALL require explicit user approval for a Destructive_Command at every Autonomy_Level, including `full`.
5. WHEN a user activates the stop control, THE system SHALL halt before beginning the next step and SHALL retain completed work.
6. WHILE the agent is running autonomously, THE IDE Surface SHALL display the run state in the status bar so that autonomy is never invisible.

### Requirement 6: User-switchable colours

**User Story:** As a user, I want to change the colours, so that the tool looks how I
want rather than how it shipped.

#### Acceptance Criteria

1. THE system SHALL derive every Derived_Token from the nine Palette inputs and SHALL introduce no additional themeable input.
2. THE system SHALL allow a user to select any catalogue Palette and to author a custom Palette by setting the nine inputs.
3. WHERE a user authors a custom Palette, THE system SHALL render body text on the background and on the secondary surface at a contrast ratio of at least 4.5:1.
4. WHEN a Palette is previewed, THE system SHALL apply it without recording it as committed.
5. WHEN a Palette preview is cancelled, THE system SHALL restore every Derived_Token to the last committed Palette by re-applying it.
6. THE system SHALL apply Palettes by setting CSS custom properties through the CSSOM and SHALL NOT inject a style element.

### Requirement 7: Platform constraints hold

**User Story:** As the platform owner, I want the rewrite to keep the project's
zero-dependency, phone-usable, accessible posture, so that a UI change cannot weaken
it.

#### Acceptance Criteria

1. THE system SHALL add no runtime dependency and no devDependency, and SHALL introduce no CSS framework, build step, bundler, or preprocessor.
2. THE system SHALL confine raw colour literals to a single token block positioned above the first shell rule, with the sole exception of the monochrome QR scaffold.
3. THE system SHALL render every Surface at a 360 CSS pixel viewport width without horizontal overflow of the primary content column.
4. THE system SHALL size every interactive control to at least 44 CSS pixels in both dimensions.
5. THE system SHALL render added and removed diff lines with a persistent textual marker so they remain distinguishable when colour is absent.
6. WHERE the user agent reports reduced-motion preference, THE system SHALL collapse every transition and animation duration to no more than 1 millisecond.
7. THE system SHALL load under `script-src 'self'` and `style-src 'self'` with no inline script, no inline style, no inline event handler, and no external-origin reference.
8. THE system SHALL change no backend endpoint, SSE frame type, or palette catalogue entry, and WHERE a feature requires a backend change THE system SHALL surface that requirement explicitly rather than assuming it.
