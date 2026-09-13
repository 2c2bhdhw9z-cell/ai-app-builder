# UI Rewrite — The Plan

**Status:** direction agreed and visually approved. Implementation partly started.
**Authoritative.** Where this document and `design.md` / `requirements.md` /
`tasks.md` disagree, **this document wins** — those were written for an earlier,
wrong scope and are marked as superseded in the relevant sections below.

---

## 1. What this is

One app. One login. One project. Inside it, **the mode you are in swaps the entire
interface**, not the arrangement of panels on a shared screen.

The analogy that matters: a camera app switching from Photo to Video. Same app,
same camera, same library — but the controls genuinely change because you are doing
a different kind of work.

Switching mode mid-build resets **nothing**: same files, same conversation history,
same running preview, same connectors, same deploys.

## 2. How the earlier attempts were wrong

Recorded because the failure repeated four times and the reason is worth keeping.

| Attempt | What was built | Why it was wrong |
|---|---|---|
| 1 | A CSS token system over the existing screen | A repaint. The spec literally said "presentation only" |
| 2 | Five desktop structural concepts | Desktop-only, for a platform used from a phone |
| 3 | Four phone concepts, then the Stage (canvas + sheet) | Still one screen with a mode toggle in a header |
| 4 | Six visual styles | Right variable at last, but still one screen |

The actual misunderstanding: **"mode" was treated as a segmented control on a shared
screen.** It is not. Vibe and IDE are different interfaces for the same project. Also
wrong throughout: the preview was pinned beside the agent. It belongs on its own
full-bleed screen.

## 3. The three surfaces

### 3.1 Vibe mode — the Bolt / Rork / Base44 / Lovable feel

Approved screens: `modes/vibe-1-start.png`, `modes/vibe-2-thread.png`.

- **Start:** a centred "What are we building today?" with **one** large input and
  starter cards. No panel furniture, no toolbar of controls. Describing the app *is*
  the interface.
- **Thread:** the user's message, then the agent's reply in plain language. Tool
  calls **collapse** into a single expandable "Changed 3 files" row rather than
  scrolling past as noise.
- **The built app arrives as a screenshot card** with an Open button. The app is a
  result you are handed, not a panel you stare at.
- Register: warm, confident, minimal chrome, large type.

### 3.2 IDE mode — the Kiro / Cursor feel

Approved screens: `modes/ide-1-desktop.png`, `modes/ide-2-phone.png`,
`modes/ide-3-auto.png`.

- Activity bar, file tree with **new = green / modified = amber** markers, editor
  tabs with dirty dots.
- Real syntax highlighting. Diffs shown **inline** in the gutter and the code body,
  not in a separate pane.
- Agent panel: tool calls as compact pills (`products.jsx +2 −1`), approval cards,
  and the autonomy control (§3.4).
- Full status bar: run state, changed count, line/column, context %, language.
- On a phone (430px) the same product keeps code as the surface and drops the agent
  into a bottom sheet.

### 3.3 Preview — its own screen

Approved screen: `modes/vibe-3-preview.png`.

- Full bleed. Browser-style chrome with the URL and a reload.
- Reachable from **either** mode; in IDE it is also a tab.
- Bottom switch: Preview / Chat / Files.
- **Never** docked beside the agent. This was the single most repeated mistake.

### 3.4 Autonomy (IDE mode)

Approved screen: `modes/ide-3-auto.png`.

- `Ask` / `Auto` / `Full` segmented control in the agent header.
- While running: the **live plan** — completed steps with checks, the current step,
  and pending steps — plus a **Stop** button.
- Auto-approved commands are named explicitly in the transcript
  ("Auto-approved 2 safe commands: `npm run lint`, `npm test`").
- **Destructive commands stop and ask even on `Full`.** Autonomy speeds up safe work;
  it must not silently widen blast radius. Flagged as revisitable if the user wants
  it configurable, but this is the default.
- Run state appears in the status bar so autonomy is never invisible.

## 4. The compose bar — present in every mode

Approved screens: `modes/compose-1-vibe.png`, `modes/compose-2-models.png`,
`modes/compose-3-attach.png`.

One component, reused. Contents:

1. **Model selector.** A pill showing the active model; opens a picker.
2. **Context gauge.** A small square that fills from the bottom, shifting
   green → amber → red. Shown beside the model pill, and **per model** inside the
   picker with token counts (`76k / 200k`, `38% full`).
   - It is labelled an **estimate derived from the running transcript**, not a billed
     figure. That is the honest claim and the copy must keep saying so.
   - A model near its limit warns that it will compact soon.
3. **Attachments.** A `+` opening camera / video / photos / files, plus a **recents**
   strip. Staged attachments appear as thumbnails above the input, each removable.
4. **Voice.** Hold-to-talk, first-class, because typing a paragraph on a phone is
   miserable.
5. In IDE mode the same bar additionally carries the autonomy state.

## 5. Theming — user-switchable colours

This is a **first-class requirement**, and the hard part is already built.

- Users can switch palettes and set **their own** colours, not only pick from a fixed
  catalogue.
- The engine derives **every** other colour from nine inputs: text, muted text,
  borders, surface steps, hover/active, shadows, diff washes, focus rings.
- Already shipped and tested (§6): readable text contrast holds on **200,000 random
  palettes**, worst case exactly at the WCAG AA floor.
- Still to build: the **picker UI** and a **custom palette editor**.

## 6. What is already built and working

On branch `ui-redesign-spec`. Suite: **1043 tests, 1035 pass, 0 fail, 8 skipped.**

| Item | State |
|---|---|
| `deriveDecisions(palette)` in `theme.js` — the derived colour engine | **Done, tested.** Pure, DOM-free |
| WCAG AA body-text defect fix | **Done.** Was `body { color: var(--color-accent) }`, failing AA on 4 of 8 themes (pastel-pasture 2.15:1, morning-dew 2.36:1, summer-sunset 2.63:1, peach-popsicle 2.14:1). Now 15:1+ on all eight |
| `applyDerivedDecisions()` kept separate from `applyPalette()` | **Done.** The shipped Property 26 test asserts *exactly* nine properties, so the derived layer had to be a separate call. No shipped test was edited |
| `test/ui-redesign-derive-decisions.property.test.js` | **Done.** 9 property tests, 200 runs each |
| `styles.css` token system: type/space/radius/elevation/motion scales | **Done and reusable** |
| `views/layout.js` (region grid) | **Deleted** |
| `views/stage.js` (canvas + sheet) | **Deleted.** Wrong model — one screen with the preview pinned beside the agent |
| `styles.css` stage/sheet layout rules | **Deleted** alongside it |
| Vibe mode, IDE mode, Preview screen | **Not built.** Approved as designs only |
| Compose bar, model picker, context gauge, attachments | **Not built** |
| Autonomy control | **Not built** |
| Theme picker / custom palette editor | **Not built** |

Deleted tests, replaced deliberately rather than skipped, because they asserted the
removed region architecture: `web-ui-layout-geometry.test.js`,
`web-ui-workspace-regions.test.js`,
`web-ui-mobile-command-center.integration.test.js`. Their surviving invariants
(no 360px overflow, touch sizing, palette-driven colour, CSP, textual diff markers)
are re-asserted in `test/ui-redesign-shell.test.js` and **must carry into the real
surfaces** rather than retiring with the interim shell.

`views/shell.js` is an interim vertical stack, labelled temporary in its own header,
that exists only to keep the client mountable until task 1.1 lands. It is not a
layout system and should be replaced, not extended.

## 7. Build order

1. **Mode router.** Vibe / IDE / Preview as real routes over shared project state.
   Prove that switching resets nothing.
2. **Compose bar** as one shared component: model selector, context gauge,
   attachments, voice. Used by both modes.
3. **Vibe mode:** start screen → thread → app card.
4. **Preview** as its own full-bleed screen, reachable from both modes.
5. **IDE mode:** tree, tabs, syntax highlighting, inline diff, agent panel.
6. **Autonomy:** Ask / Auto / Full, live plan, Stop, safe-command auto-approval with
   destructive commands still gated.
7. **Theming UI:** palette picker plus custom colour editor over the existing engine.
8. **Context estimation:** real token accounting per model behind the gauge.

Order rationale: 1 and 2 are shared foundations, and Vibe is the primary surface for
a phone user, so it lands before the denser IDE.

## 8. Constraints that still hold

- **Phone-first.** 360px with no horizontal overflow; touch targets ≥44px. The
  platform runs on Android via Termux and the owner builds from a phone.
- **No runtime dependencies.** No CSS framework, no build step, no bundler,
  no preprocessor. Vanilla CSS and vanilla ES modules. `fast-check` stays the only
  devDependency.
- **CSP:** `script-src 'self'`, `style-src 'self'`, `font-src 'self'`. No inline
  script or style, no inline handlers, no external origin. Themes apply through the
  CSSOM.
- **All eight catalogue themes keep working**, plus arbitrary user palettes.
- **Non-colour-only status.** Diff markers stay textual `+`/`-`.
- **Backend contracts are fixed** unless a feature genuinely requires a change, in
  which case it gets called out rather than assumed. Attachments and real token
  accounting are the two likely places this will come up.

## 9. Open, deliberately not decided yet

- Whether attachments need a new upload endpoint, or ride an existing one.
- Where real per-model token counts come from (the gauge is presented as an estimate
  precisely because this is unresolved).
- Whether `Full` autonomy should be able to include destructive commands.
- Whether the eight-theme catalogue stays fixed once users can author palettes.
