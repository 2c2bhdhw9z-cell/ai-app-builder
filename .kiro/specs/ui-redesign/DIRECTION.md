# Direction (decided, not open for review)

## What went wrong with the first pass

`design.md` as originally written scoped this as **presentation only** — "restyled,
CSS only," same header, same chat column, same right-hand preview panel. That is a
repaint, not the rewrite that was asked for. It also inherited the layout every AI
builder ships (chat left, preview right), which is itself part of why the product
reads as generic.

The five desktop concepts that followed were the second mistake: 1280px layouts with
keyboard shortcuts, three-pane editors, and a zoomable canvas, for a platform that
runs on Android via Termux and whose owner builds from a phone.

## The decision

**Phone-first, canvas-plus-sheet (concept M1). Desktop is derived from it, not
designed separately.**

- The **running app owns the screen.** It is not a panel beside a transcript.
- The agent lives in a **draggable bottom sheet** with three detents: a one-line
  status peek, a half sheet with the compose surface and recent activity, and a full
  sheet for the whole stream, diffs, and confirmations.
- **Input is not a shrunken textarea.** Voice (hold to talk) is a first-class input,
  a scrollable row of context-aware one-tap suggestion chips handles the common
  turns, and typing is the fallback rather than the default.
- **Confirmations are full-width buttons** inside thumb reach, never a small target.
- **Desktop** keeps the same information hierarchy: the app still owns the surface,
  and the sheet becomes a docked side rail at wide viewports. Same components, same
  state, one breakpoint decision.

## What this means for scope

This is a **rewrite of the view layer**, not a stylesheet swap:

- The five existing Workspace Experience geometries and the `views/layout.js` region
  renderer are replaced by the canvas + sheet shell with a single derived wide-screen
  arrangement.
- The view modules are rewritten, not restyled.
- The transport, state, and auth layers (`api.js`, `sse.js`, `store.js`,
  `token-store.js`, `auth.js`) stay as they are. They are sound and they are not the
  problem.
- Backend contracts remain fixed: no endpoint, SSE frame type, or palette catalog
  change.

## What carries forward from the first pass

The token work in `design.md` was the one genuinely correct part and it survives
intact, because it is a system rather than a layout:

- The nine themeable palette keys stay the single source of truth, with every other
  token derived from them, so `web-ui` Property 26 holds verbatim.
- The **WCAG AA body-text defect is still the first thing fixed.** Body text is
  painted with `--color-accent` today, so it fails AA on four of eight themes
  (pastel-pasture 2.15:1, morning-dew 2.36:1, summer-sunset 2.63:1,
  peach-popsicle 2.14:1). That fix is independent of layout and lands first.
- The type, space, radius, elevation, and motion scales carry over unchanged.

## Requirements that constrain this

Unchanged and still binding: no runtime dependency, no build step, CSP
`script-src 'self'` / `style-src 'self'` with no inline script or style, themes
applied through the CSSOM, 360px with no horizontal overflow, touch targets at or
above 44px, and the non-color-only diff marker.
