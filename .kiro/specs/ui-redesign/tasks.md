# Implementation Plan: UI Rewrite

> Rewritten to match `PLAN.md`. The previous plan targeted a stylesheet restyle of
> one shared screen and is discarded. `PLAN.md` is authoritative for scope.

## Overview

Build the three surfaces agreed in `PLAN.md`: **Vibe mode**, **IDE mode**, and
**Preview** as its own screen — over one shared project, with a shared compose bar,
IDE autonomy, and user-switchable colours.

Ordered so the shared foundations land first and the phone-primary surface (Vibe)
lands before the denser IDE.

### Starting state (verified)

- Branch `ui-redesign-spec`. Suite: **1043 tests, 1035 pass, 0 fail, 8 skipped**.
- **Built and keep:** `deriveDecisions()` in `theme.js` (the derived colour engine,
  pure and DOM-free), `applyDerivedDecisions()` kept separate so the shipped
  Property 26 exactness assertion still holds, the WCAG AA body-text fix, and the
  token scales in `styles.css`.
- **Built and superseded:** `views/stage.js` and its stylesheet rules. Wrong model —
  one screen with the preview pinned beside the agent.
- **Deleted:** `views/layout.js` (region grid) and three tests that asserted it.
- **Untouched and reused:** `store.js`, `api.js`, `sse.js`, `router.js`, `auth.js`,
  `token-store.js`, `builder.js`, `confirm.js`, `preview.js`, `preview-poll.js`,
  `qr.js`, `work-mode.js`, `workspace.js`, the settings controllers.

### Constraints on every task

No runtime dependency, no build step, no bundler, no preprocessor. Vanilla CSS and
vanilla ES modules; `fast-check` stays the only devDependency. CSP `script-src 'self'`
/ `style-src 'self'` / `font-src 'self'` — no inline script or style, no inline
handlers, no external origin. 360px with no horizontal overflow, touch targets ≥44px.
All eight catalogue themes plus arbitrary user palettes must render correctly. Diff
markers stay textual. Backend contracts are fixed unless a task explicitly calls out
a needed change.

## Tasks

- [ ] 1. Mode router over shared project state
  - [ ] 1.1 Add Vibe / IDE / Preview as real routes
    - Extend `router.js` with the three surfaces; mount each lazily; keep one store
    - Retire `views/stage.js` and its stylesheet rules
    - _PLAN §1, §3_
  - [ ] 1.2 Prove switching modes resets nothing
    - Files, conversation history, live preview, in-flight turn and SSE stream all survive a mode switch
    - _PLAN §1_
  - [ ]* 1.3 Property test: mode is presentation only
    - For any sequence of mode switches, project state is unchanged
    - _PLAN §1_

- [ ] 2. The shared compose bar
  - [ ] 2.1 Build the component used by both modes
    - Text input, hold-to-talk, submit; staged-attachment thumbnails with remove
    - _PLAN §4_
  - [ ] 2.2 Model selector and picker
    - Pill plus a picker listing models with per-model context and token counts
    - _PLAN §4.1, §4.2_
  - [ ] 2.3 Context gauge component
    - Square filling bottom-up, green → amber → red; three sizes; copy states it is an estimate from the transcript, never a billed figure
    - _PLAN §4.2_
  - [ ] 2.4 Attachments
    - Camera / video / photos / files plus recents. **Calls out** whether a new upload endpoint is needed (PLAN §9)
    - _PLAN §4.3_
  - [ ]* 2.5 Property tests for the gauge and picker
    - Fill fraction and colour band are correct for any token/limit pair; never exceeds 100%; degrades when a limit is unknown
    - _PLAN §4.2_

- [ ] 3. Vibe mode
  - [ ] 3.1 Start screen
    - Centred prompt, one large input, starter cards. No panel furniture
    - _PLAN §3.1_
  - [ ] 3.2 Thread
    - User message, plain-language reply, tool calls collapsed into one expandable "Changed N files" row
    - _PLAN §3.1_
  - [ ] 3.3 App result card
    - Screenshot card with an Open button that routes to Preview
    - _PLAN §3.1_

- [ ] 4. Preview as its own screen
  - [ ] 4.1 Full-bleed preview route
    - Browser-style chrome, URL, reload; bottom Preview / Chat / Files switch; reachable from both modes
    - Reuses the existing preview controller, poll and QR modules unchanged
    - _PLAN §3.3_

- [ ] 5. IDE mode
  - [ ] 5.1 Shell: activity bar, file tree, editor tabs
    - New = green, modified = amber; dirty dots on tabs
    - _PLAN §3.2_
  - [ ] 5.2 Code view with syntax highlighting
    - No dependency: a small tokenizer for the languages the builder emits
    - _PLAN §3.2_
  - [ ] 5.3 Inline diff
    - Gutter and body, textual `+`/`-` preserved
    - _PLAN §3.2, §8_
  - [ ] 5.4 Agent panel
    - Tool pills, approval cards, autonomy control host
    - _PLAN §3.2_
  - [ ] 5.5 Status bar
    - Run state, changed count, line/column, context %, language
    - _PLAN §3.2_
  - [ ] 5.6 Phone form
    - Code stays the surface; agent becomes a bottom sheet at 430px and below
    - _PLAN §3.2, §8_

- [ ] 6. Autonomy
  - [ ] 6.1 Ask / Auto / Full control
    - _PLAN §3.4_
  - [ ] 6.2 Live plan with Stop
    - Completed / current / pending steps; Stop halts before the next step
    - _PLAN §3.4_
  - [ ] 6.3 Safe-command auto-approval
    - Auto-approved commands named explicitly in the transcript; **destructive commands still stop and ask even on Full**
    - _PLAN §3.4_
  - [ ]* 6.4 Property test: autonomy never widens blast radius
    - For any autonomy level, a destructive command still requires explicit approval
    - _PLAN §3.4_

- [ ] 7. Theming UI over the existing engine
  - [ ] 7.1 Palette picker
    - The eight catalogue themes, applied live through the existing CSSOM path
    - _PLAN §5_
  - [ ] 7.2 Custom palette editor
    - Nine inputs the user can set; everything else derives; live preview then commit
    - _PLAN §5_
  - [ ]* 7.3 Property test: user palettes stay readable
    - Any user-authored palette holds body-text contrast at or above WCAG AA, reusing the shipped derivation properties
    - _PLAN §5_

- [ ] 8. Context estimation
  - [ ] 8.1 Real per-model token accounting behind the gauge
    - Replace the estimate with real accounting where available; keep the honest label where it is not. **Calls out** any backend change needed (PLAN §9)
    - _PLAN §4.2, §9_

## Task Dependency Graph

Execution waves — same wave means no dependency between them.

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "2.3"] },
    { "id": 3, "tasks": ["2.2", "2.4", "2.5"] },
    { "id": 4, "tasks": ["3.1", "4.1", "7.1"] },
    { "id": 5, "tasks": ["3.2", "7.2", "7.3"] },
    { "id": 6, "tasks": ["3.3", "5.1"] },
    { "id": 7, "tasks": ["5.2", "5.5"] },
    { "id": 8, "tasks": ["5.3", "5.4"] },
    { "id": 9, "tasks": ["5.6", "6.1"] },
    { "id": 10, "tasks": ["6.2", "6.3"] },
    { "id": 11, "tasks": ["6.4", "8.1"] }
  ]
}
```

Task 1 gates everything: without the mode router there is nowhere to mount a surface.
The compose bar (2) precedes both modes because both consume it. Vibe (3) and Preview
(4) come before IDE (5) because Vibe is the primary surface on a phone. Theming (7)
is independent of the modes and can proceed in parallel once the router exists.

## Notes

- **`PLAN.md` is authoritative.** `design.md` and `requirements.md` carry a
  superseded-in-part banner: their colour system and scales are valid, their layout
  content is not.
- **The colour work is done and should not be redone.** `deriveDecisions()` is pure,
  tested at 200 runs per property, and verified across 200,000 random palettes. Task 7
  is the UI over it, not a reimplementation.
- **Keep `applyPalette` and `applyDerivedDecisions` separate.** The shipped
  `web-ui-theme-palette.property.test.js` asserts *exactly* nine properties on the
  surface. Merging them breaks a shipped contract.
- **Carry the deleted tests' invariants forward.** No 360px overflow, touch sizing,
  palette-driven colour, CSP cleanliness — currently held by
  `test/ui-redesign-stage.test.js`, which retires with the Stage. Move them, do not
  drop them.
- **Honesty in the context gauge copy is a requirement, not a nicety.** Until task 8
  lands it is an estimate from the transcript and must say so.
- **Four open questions** are listed in `PLAN.md` §9 and should be answered as their
  tasks come up, not guessed at.
