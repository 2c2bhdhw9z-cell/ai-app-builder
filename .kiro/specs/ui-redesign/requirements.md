# Requirements Document

## Introduction

This document specifies the requirements for the **UI Redesign** — a total rewrite of the **visual layer** of the `ai-app-builder` Web UI. The user's assessment of the shipped interface was "it looks like AI slop," and the diagnosis in the accompanying design document confirms a structural cause rather than a set of taste errors: the shipped stylesheet defines fifteen CSS custom properties in total (nine palette colors and six geometry values), with **no** foreground color token, **no** type scale, **no** elevation, **no** motion, **no** spacing scale, **no** radius hierarchy, and **no** border or interaction-state vocabulary.

One consequence is a defect, not a preference. Because `body` text is painted with `--color-accent`, body-text contrast is governed by the theme's accent-on-background ratio, and **body text fails WCAG AA on four of the eight shipped themes**: `pastel-pasture` (2.15:1), `morning-dew` (2.36:1), `summer-sunset` (2.63:1), and `peach-popsicle` (2.14:1). Fixing the design system fixes that failure as a side effect of introducing a real foreground token.

The chosen visual direction is **Precise Technical Instrument**: neutrals carry the layout, the palette accents it, separation is by hairline rather than fill, elevation means "floats" and has three levels, monospace is semantic rather than decorative, motion is short and only explains state change, and density is rhythm rather than scale.

This work is **presentation only**. Every functional contract the `web-ui` spec defines — SSE frame types, the endpoint surface, auth and Bearer_Token behavior, preview polling, project lifecycle, and non-disclosing error handling — is a **fixed contract** consumed unchanged. No endpoint, frame type, palette catalog entry, or layout descriptor is modified, and no new user-facing setting or persisted preference is introduced.

### Constraints carried deliberately

- **No new dependencies.** `ai-app-builder` ships zero runtime dependencies; `fast-check` is its only devDependency. The redesign MUST NOT add a runtime dependency, a devDependency, a CSS framework, a build step, a bundler, or a preprocessor. Vanilla CSS and vanilla ES modules only.
- **CSP.** The Builder_Server sends `default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`, `font-src 'self'`, `frame-ancestors 'none'`. No inline `<script>`, no inline `<style>`, no inline event handlers, and no external origin — so no webfont CDN. Themes MUST continue to be applied through the CSSOM on `document.documentElement`.
- **The nine-token themeable contract is preserved, not widened.** `web-ui` Requirement 9 and design Property 26 lock the themeable surface to exactly nine `--color-*` custom properties mapping 1:1 onto `THEME_CATALOG` palette keys. Property 26 is a *completeness* assertion, not an *exclusivity* assertion, so the redesign keeps those nine as the only themeable input and **derives** every other token from them.
- **Phone is required.** Usable at a 360 CSS pixel viewport width with no horizontal overflow of the primary content column, and touch targets at or above 44 CSS pixels.
- **All eight themes and all five Workspace Experiences must keep rendering correctly.**

### Accessibility scope statement

Computed contrast ratios are machine-checkable and are enforced by the properties in the design document. They are **not** conformance. Full WCAG validation requires manual testing with assistive technologies and expert accessibility review, and this document does not claim to substitute for either.

## Glossary

- **Design_System**: The complete set of tokens, scales, and rules specified by this document, comprising the derived color layers, the type scale, the space scale, the radius hierarchy, the elevation levels, the motion values, and the density profiles.
- **Palette_Input**: One of the nine themeable CSS custom properties (`--color-background`, `--color-surface`, `--color-accent`, `--color-button`, `--color-badge`, `--color-statusInfo`, `--color-statusSuccess`, `--color-statusWarning`, `--color-statusError`) set from a Theme's Palette. The only themeable input in the Design_System and the single source of truth for every Derived_Token.
- **Derived_Token**: Any CSS custom property in the Design_System that is not a Palette_Input. Every Derived_Token is a pure function of the nine Palette_Inputs.
- **Derived_Decision**: A Derived_Token whose value requires branching on a color's relative luminance and is therefore computed in JavaScript by `deriveDecisions` and emitted by `applyPalette`. The twelve Derived_Decisions are `--ink`, `--paper`, `--shadow-color`, and the nine `--on-*` tokens.
- **Derived_Gradation**: A Derived_Token expressed purely in CSS as a `color-mix()` over Palette_Inputs and Derived_Decisions, with no JavaScript involvement.
- **Anchor**: One of the two neutral extremes `--ink` (dark) and `--paper` (light), each derived per-Palette by nudging a near-black or near-white a bounded amount toward the Palette's own `background` hue subject to a contrast floor.
- **Polarity**: The derived light-or-dark character of a Palette, computed from the relative luminance of its `background` and exposed to CSS as the `data-polarity` attribute.
- **Density_Profile**: One of the two rhythm profiles `compact` and `comfortable`, selected in CSS from the existing `data-experience` attribute, which alter gaps and interior padding only and never the type scale, the space scale, or the touch-target floor.
- **Elevation_Level**: One of exactly three shadow treatments — `--elev-0` (in-plane), `--elev-1` (a resting panel edge), `--elev-2` (has left the plane and blocks the user).
- **Token_Block**: The single `:root` block, positioned above the first `.shell {` rule in the stylesheet, which is the only location in the stylesheet permitted to contain a raw color literal.
- **Accent_Job**: The single most important action or active state on a given screen, which is the only element permitted to carry `--color-accent` as a fill on that screen.
- **Workspace_Experience**: As defined by the `web-ui` spec — one of `kiro-style`, `vibe-first`, `technical-workbench`, `mobile-command-center`, or `custom`.
- **Theme**: As defined by the `web-ui` spec — one of `light`, `dark`, `pastel-pasture`, `out-there`, `paranormal-purple`, `morning-dew`, `summer-sunset`, or `peach-popsicle`.

## Requirements

### Requirement 1: A derived token system that preserves the nine-token themeable contract

**User Story:** As the platform owner, I want a real design system that does not widen the themeable surface, so that the interface gains typography, depth, and state vocabulary without breaking the existing theme contract or requiring any backend change.

#### Acceptance Criteria

1. THE Design_System SHALL treat the nine Palette_Inputs as the only themeable input and SHALL derive every Derived_Token from those nine values.
2. WHEN `applyPalette` is invoked with a Palette, THE Design_System SHALL set all nine Palette_Inputs to that Palette's corresponding values, preserving `web-ui` design Property 26 verbatim.
3. WHEN `applyPalette` is invoked with a Palette, THE Design_System SHALL additionally emit the twelve Derived_Decisions and SHALL set the `data-polarity` attribute on the same target.
4. THE Design_System SHALL compute `deriveDecisions` as a pure function of the Palette, such that two invocations with equal Palettes produce equal results and no output depends on prior state, invocation order, or the DOM.
5. THE Design_System SHALL derive Polarity from the relative luminance of the Palette's `background` value and SHALL NOT require any additional field on the theme frame or any client-side duplicate of `THEME_CATALOG`.
6. THE Design_System SHALL confine every raw color literal in the stylesheet to the Token_Block, and every stylesheet rule below the first `.shell {` SHALL reference colors only through `var()`.
7. THE Design_System SHALL introduce no new themeable input, no new theme frame field, and no change to `THEME_CATALOG`.
8. WHERE a Palette presents adversarial input — including a `background` and `surface` within one percent relative luminance of each other, or a fill at mid relative luminance — THE Design_System SHALL still produce a usable interface rather than a result tuned only to the eight shipped Themes.

### Requirement 2: Readable body text on every theme

**User Story:** As a user of any of the eight themes, I want body text I can actually read, so that the four pastel themes stop being unreadable and text stops being rendered in the accent color.

#### Acceptance Criteria

1. THE Design_System SHALL provide a dedicated foreground token for body text and SHALL NOT use `--color-accent` as the color of body text.
2. WHEN deriving the foreground for any of the nine Palette_Input fills, THE Design_System SHALL select whichever Anchor scores the higher WCAG contrast ratio against that fill.
3. THE Design_System SHALL render body text on the page background at a contrast ratio of at least 4.5:1 for every one of the eight shipped Themes, including `pastel-pasture`, `morning-dew`, `summer-sunset`, and `peach-popsicle`, each of which currently fails.
4. THE Design_System SHALL render body text on the secondary surface at a contrast ratio of at least 4.5:1 for every one of the eight shipped Themes.
5. WHERE an arbitrary Palette is supplied, THE Design_System SHALL render body text on both the background and the secondary surface at a contrast ratio of at least 4.5:1.
6. WHEN an Anchor is hue-nudged toward the Palette's `background`, THE Design_System SHALL keep the resulting contrast ratio at or above the 4.5:1 floor and SHALL NOT allow the nudge to reduce contrast below a fixed bounded tolerance of the un-nudged neutral.
7. THE Design_System SHALL provide graded secondary and subtle text tokens derived from the body foreground, so that de-emphasized content is expressed by gradation rather than by hue.

### Requirement 3: Type scale and typography

**User Story:** As a builder user reading dense agent output, I want type that establishes hierarchy and distinguishes literals from prose, so that I can scan a build log without everything reading at the same authority.

#### Acceptance Criteria

1. THE Design_System SHALL define a fixed type scale of at least seven steps, each carrying a size and a line height, and every text rule in the stylesheet SHALL reference a step of that scale rather than an ad-hoc size.
2. THE Design_System SHALL define named font-weight tokens and SHALL express emphasis through weight and scale step rather than through color.
3. THE Design_System SHALL define exactly two font families: a UI family and a monospace family.
4. THE Design_System SHALL apply the monospace family semantically to literals — paths, commands, diff lines, and URLs — and SHALL NOT apply it to prose.
5. THE Design_System SHALL load a self-hosted variable font as the primary UI family from a same-origin asset, satisfying the Builder_Server's `font-src 'self'` policy, and SHALL NOT reference any external font origin.
6. THE Design_System SHALL specify a system font stack fallback behind the self-hosted font and SHALL render a complete and correct interface when the font asset never loads.
7. WHEN the self-hosted font asset is unavailable, slow, or blocked, THE Design_System SHALL render immediately in the fallback stack via `font-display: swap` without a material layout shift.
8. WHERE the self-hosted font asset is added, THE Design_System SHALL register it in the Builder_Server's static asset allow-list and its content-type map, and in the CSP integration test's asset path list.

### Requirement 4: Spacing and radius systems

**User Story:** As a builder user, I want consistent rhythm and a sense of which surfaces are which, so that the interface stops reading as one undifferentiated stack of identical rounded boxes.

#### Acceptance Criteria

1. THE Design_System SHALL define a space scale of at least eight steps on a consistent base unit, and every margin, padding, and gap in the stylesheet SHALL reference a step of that scale.
2. THE Design_System SHALL define a radius hierarchy of at least four steps and SHALL assign radius by surface role rather than applying one value uniformly.
3. THE Design_System SHALL separate adjacent surfaces using a derived hairline border as the default device.
4. THE Design_System SHALL reserve filled surface treatments for content that is a genuinely distinct object, and SHALL NOT express routine grouping as a filled card.
5. THE Design_System SHALL provide derived surface-step tokens so that inset and selected states are expressed by a bounded shift from the parent surface.

### Requirement 5: Elevation

**User Story:** As a builder user, I want urgent things to visibly float above the page, so that a command awaiting my approval is distinguishable from static content.

#### Acceptance Criteria

1. THE Design_System SHALL define exactly three Elevation_Levels and SHALL NOT define any further shadow treatment.
2. THE Design_System SHALL derive the elevation shadow color from the dark Anchor rather than from pure black, so that elevation sits within the active Theme.
3. THE Design_System SHALL apply the highest Elevation_Level to exactly one component — the confirm-command surface — because it is the only surface that blocks the user.
4. THE Design_System SHALL use only the three defined Elevation_Level tokens as `box-shadow` values in the stylesheet.

### Requirement 6: Motion

**User Story:** As a builder user, I want interactions to acknowledge me without the interface becoming animated, so that state changes are legible and nothing distracts from a running build.

#### Acceptance Criteria

1. THE Design_System SHALL define named duration tokens and a single easing token, and no declared transition or animation duration SHALL exceed 160 milliseconds.
2. THE Design_System SHALL apply motion only to state change — hover, focus, disable, expand, and appear — and SHALL NOT animate any element on initial page load.
3. WHERE the user agent reports `prefers-reduced-motion: reduce`, THE Design_System SHALL collapse every duration to no more than 1 millisecond while keeping the resulting state change perceivable.
4. THE Design_System SHALL provide a single consistent keyboard focus treatment derived from the Palette's accent and SHALL apply it to every interactive control.

### Requirement 7: Per-experience density

**User Story:** As a builder user, I want the IDE-style workbench to be denser than the chat and phone layouts, so that each layout suits its purpose without me configuring anything.

#### Acceptance Criteria

1. THE Design_System SHALL define exactly two Density_Profiles, `compact` and `comfortable`.
2. THE Design_System SHALL select the active Density_Profile in CSS from the existing `data-experience` attribute written by `views/layout.js`.
3. THE Design_System SHALL assign `compact` to `technical-workbench` and `comfortable` to `vibe-first` and `mobile-command-center`.
4. A Density_Profile SHALL alter gaps and interior padding only and SHALL NOT alter the type scale or the space scale definitions.
5. THE Design_System SHALL introduce no new user-facing setting, no new store state, no new endpoint, and no new persisted preference in order to support Density_Profiles.
6. A Density_Profile SHALL NOT reduce any interactive control below the touch-target floor defined in Requirement 9.

### Requirement 8: Preserved layout geometries and phone behavior

**User Story:** As a builder user on a phone and on a desktop, I want all five workspace layouts to keep working after the restyle, so that a visual rewrite does not cost me the arrangements or break the 360 pixel width.

#### Acceptance Criteria

1. THE Design_System SHALL preserve all five Workspace_Experience geometries as genuinely distinct arrangements, such that every pair of experiences declares a differing grid template.
2. THE Design_System SHALL preserve the `technical-workbench` grid template regions for its sidebar, editor, and full-width dock.
3. THE Design_System SHALL render every Workspace_Experience at a 360 CSS pixel viewport width without horizontal overflow of the primary content column.
4. THE Design_System SHALL retain the box-sizing reset, the shell's horizontal overflow containment, the region minimum-width and maximum-width constraints, and the single-column collapse at the existing breakpoint.
5. THE Design_System SHALL consume the existing layout attributes — `data-experience`, `data-orientation`, `data-regions`, `data-region`, `data-role`, `data-size`, and `data-emphasis` — without requiring any change to `views/layout.js` or to `src/presentation/layouts.js`.
6. WHERE a layout descriptor carries a primary emphasis marker, THE Design_System SHALL continue to express that emphasis using the Palette's accent.

### Requirement 9: Touch targets

**User Story:** As a user driving builds from an Android phone, I want controls I can reliably tap, so that the interface is operable by touch in every layout.

#### Acceptance Criteria

1. THE Design_System SHALL size every interactive control to at least 44 CSS pixels in both dimensions.
2. THE Design_System SHALL treat the touch-target floor as invariant across both Density_Profiles and all five Workspace_Experiences.
3. WHILE rendering at a phone-width viewport, THE Design_System SHALL keep the prompt-submit, confirm-approve, confirm-deny, and Work_Mode-switch controls at or above the touch-target floor.

### Requirement 10: Non-color-only status and diff indication

**User Story:** As a user who may not perceive color differences, I want added and removed diff lines and status states distinguishable without color, so that the restyle does not make the interface less accessible than it was.

#### Acceptance Criteria

1. THE Design_System SHALL preserve the textual `+` and `-` marker rendered for diff lines and SHALL preserve the `data-marker` attribute that carries it.
2. THE Design_System SHALL treat diff color and gutter tint as additive, such that added and removed lines remain distinguishable when color is entirely absent.
3. THE Design_System SHALL express preview status using a `data-status` attribute on the preview surface, added as an attribute only with no change to what is rendered or when.
4. THE Design_System SHALL pair every status color with a non-color cue — a textual label, a marker, or a shape — and SHALL NOT convey a status by hue alone.

### Requirement 11: No new dependencies and continued CSP compliance

**User Story:** As a platform operator, I want the redesign to preserve the platform's zero-dependency, same-origin, fail-closed posture, so that a visual change cannot weaken its security or portability position.

#### Acceptance Criteria

1. THE Design_System SHALL add no runtime dependency and no devDependency to the `ai-app-builder` package.
2. THE Design_System SHALL introduce no CSS framework, no build step, no bundler, and no preprocessor, and SHALL be authored as vanilla CSS consumed by vanilla ES modules.
3. THE Design_System SHALL load and execute under `script-src 'self'` and `style-src 'self'` with no inline `<script>`, no inline `<style>`, no inline event handler, and no external-origin reference.
4. THE Design_System SHALL continue to apply Themes by setting CSS custom properties on `document.documentElement` through the CSSOM rather than by injecting a style element.
5. THE Design_System SHALL change no endpoint, no SSE frame type, no `THEME_CATALOG` entry, and no layout descriptor.

### Requirement 12: Theme preview, commit, and revert integrity across the derived layer

**User Story:** As a builder user trying out themes, I want previewing and cancelling to leave no trace, so that the new token layer reverts as cleanly as the old one did.

#### Acceptance Criteria

1. WHEN a Theme is previewed, THE Design_System SHALL apply the previewed Palette's Palette_Inputs and all Derived_Tokens without recording the Theme as committed.
2. WHEN a Theme preview is cancelled or abandoned, THE Design_System SHALL restore all nine Palette_Inputs, all twelve Derived_Decisions, and the `data-polarity` attribute to the last committed Palette's values.
3. THE Design_System SHALL accomplish preview revert by re-applying the committed Palette through the same code path, requiring no additional bookkeeping of prior Derived_Token values.
4. WHEN a Theme is committed, THE Design_System SHALL apply the committed Palette's Palette_Inputs and all Derived_Tokens and SHALL record it as the last committed Theme.
5. IF a theme request fails or returns an unsupported theme, THEN THE Design_System SHALL keep the last committed Palette and its Derived_Tokens applied, consistent with the existing `web-ui` behavior.

### Requirement 13: Graceful degradation

**User Story:** As a user on an unusual browser or an accessibility mode, I want the interface to stay readable when parts of the design system are unavailable, so that degradation costs polish rather than legibility.

#### Acceptance Criteria

1. WHERE the user agent does not support `color-mix()`, THE Design_System SHALL supply flat fallback values for every Derived_Gradation via an `@supports` block, and body text SHALL remain readable because the Derived_Decisions are emitted by JavaScript rather than by `color-mix()`.
2. WHERE the user agent reports `forced-colors: active`, THE Design_System SHALL yield to system colors for text, borders, and focus, and SHALL replace elevation with a border because shadows are not rendered in that mode.
3. WHEN the self-hosted font asset fails to load, THE Design_System SHALL render completely and correctly in the fallback stack.
4. WHERE a Palette fill is itself at a luminance that makes it an uncomfortable background, THE Design_System SHALL adjust that fill's paired foreground rather than tinting the fill, so the Palette renders as authored while text stays legible.

### Requirement 14: Restyled surfaces and the direction rules

**User Story:** As the platform owner, I want the chosen visual direction actually applied to every shipped surface, so that the result is a coherent instrument rather than a new token file under an old skin.

#### Acceptance Criteria

1. THE Design_System SHALL restyle all nine shipped surfaces: the session header, the activity stream, the prompt and compose surface, the preview pane, the confirm card, the file panel, the project creation form, the settings screens, and the workspace controls.
2. THE Design_System SHALL permit at most one Accent_Job per screen, such that `--color-accent` marks the single most important action or active state and no other element.
3. THE Design_System SHALL render the five activity kinds — `reasoning`, `text`, `tool`, `diff`, and `status` — at visibly distinct levels of authority using the type scale, the derived text gradations, the monospace family, and the status tokens.
4. THE Design_System SHALL restyle every surface through CSS alone, with JavaScript edits limited to `deriveDecisions` and its emission in `applyPalette`, the font preload in the HTML shell, and the single `data-status` attribute on the preview surface.
5. THE Design_System SHALL leave all remaining client modules unmodified, including `app.js`, `api.js`, `sse.js`, `store.js`, `router.js`, `auth.js`, `token-store.js`, and `views/layout.js`.
