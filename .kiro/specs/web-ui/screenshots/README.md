# Web UI screenshots

Rendered with the **real shipped `src/server/public/styles.css`** rules and the
**real view class names** the client builds (`.shell`, `.session-header`,
`.activity`, `.confirm`, `.prompt`, `.preview`, `.projects__form`, `.settings*`),
seeded with sample session content. Themes are applied exactly as `theme.js` does
it — by setting the nine `--color-*` custom properties on the document root.

| File | What it shows |
|---|---|
| `new-01-builder-light.png` | The chat-first builder, Light theme: sticky slim header (Work Mode switch, layout + theme pickers, Settings), the conversation/activity column with a colour+symbol diff, a confirm-command card, the compose box, and the preview panel with restart + phone URL. |
| `new-02-builder-dark.png` | The same screen, Dark theme — only the nine palette variables changed. |
| `new-03-mobile-360.png` | Mobile Command Center at a 360px phone width: one column, preview folded into the flow, Work Mode still visible. Verified programmatically: no horizontal overflow at 360px. |
| `new-04-create-project.png` | Create-project form: target category, origin (blank / template / github-import / fork) with the origin-specific field shown. |
| `new-05-settings.png` | Settings: model provider, connectors (secret masked — only the variable name is retained), memory + mode, and build / deploy / export / lock-in-audit / share. |
| `checkpoint-1-builder-light.png` | **Superseded.** The earlier pre-redesign layout, kept for comparison. |

## Honest limits

- These are **not** screenshots of a live running server. This sandbox has no
  container runtime and the headless browser cannot reach a local port, so the
  real stylesheet and real markup are rendered with sample content instead of
  live agent output.
- What a real host would additionally prove: streamed agent output arriving over
  SSE, a real preview iframe serving a built app, and a deployed site answering.
- There is **no login screen shown** because no login *view* module exists yet —
  `auth.js` owns the flow and the shell gates on whether a token is held, but a
  dedicated sign-in screen was never built. Nothing here invents one.
