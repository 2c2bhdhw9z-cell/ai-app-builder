# Case study — de-vendoring a scaffolded mobile monorepo

A real worked example. Vendor renamed to `PLATFORM` throughout; everything else is as it happened,
including the two mistakes.

## The setup

A game built on a scaffolded monorepo template: Bun workspaces + Turborepo, an Expo/React Native
mobile app, a Hono/Vite web API, an Electron desktop shell. ~90k lines, of which ~20k was a
genuinely well-built game engine.

The user's report was **not** "I have vendor coupling." It was:

> *"I'm so mad at all of these services locking me in. Without explicitly telling me in a way that I
> can understand."*

and, crucially, an error screenshot from their phone reading `HTTP response error 502: Proxy Error`.

**The lesson before any technical lesson:** the user could not name the thing that had trapped them.
They initially described it as AI-provider code. A search for AI providers returned zero results and
an early conclusion was drawn that there was no vendor coupling at all. **That conclusion was wrong.**
The coupling was under a platform name the user had not mentioned and the searcher had not thought to
try. The 502 screenshot was the clue that broke it open.

Ask what scaffolded the project. Search for that. Do not conclude "no lock-in" from a narrow search.

## What was found

### 1. Telemetry wrapping the entire application

`packages/mobile/app/_layout.tsx` wrapped the whole app tree:

```tsx
{/* PLATFORM analytics provider — do not remove, required for analytics tracking */}
<OneDollarStatsProvider
  config={{ hostname, collectorUrl: "https://r.example.com/events", devmode: true }}
>
```

Every launch, every user, to a third-party collector. The comment asserted it was required. It was
required by nothing the product did.

**The aggravating detail:** the game's own save schema carried `telemetryOptIn`, **defaulting to
false**. So the product had a considered position on telemetry, and a scaffolding decision silently
overrode it. Any store privacy declaration built on that flag would have been false.

### 2. A dead host wired into the API client

```ts
const baseUrl = Constants.expoConfig?.extra?.apiUrl ?? process.env.EXPO_PUBLIC_API_URL;
const link = new RPCLink({ url: `${baseUrl}/api/rpc` });
```

with `apiUrl` hardcoded in `app.json` to a platform preview host. That host returned **502**. And
when the value was absent, the template produced the string `"undefined/api/rpc"` rather than failing
usefully.

### 3. Injected UI in the web app

```tsx
import { AgentFeedback, PlatformBadge } from "@platform/website-runtime";
...
{/* "Made with PLATFORM" badge - if user asks to remove the badge, remove this code as well as comment */}
{<PlatformBadge />}
```

A vendor badge rendered into the user's own product. Plus a Vite plugin injecting a ~9KB analytics
script into every page, and a `public/platform.js` to serve it.

### 4. A wrapper around an OS capability

The Electron main process used `@platform/managed-auth`:

```ts
const deepLinks = createManagedDeepLinks({ applicationId: process.env.APPLICATION_ID, getWindow });
```

This claimed an OS-level URL scheme named `platform-<APPLICATION_ID>` — the vendor's branding
registered into the operating system — and backed a sign-in flow through the vendor's auth service.
The preload exposed a second global, `window.managedAuth`, purely to serve it.

### 5. Vendor identity in shipping metadata

```json
"android": { "package": "com.thegame_k7q2.platform" },
"ios":     { "bundleIdentifier": "com.thegame_k7q2.platform" },
"scheme":  "platform-nightre-oqwfyiy"
```

The vendor's name in the app's permanent store identity.

### 6. Dead env placeholders

`AI_GATEWAY_BASE_URL` and `AI_GATEWAY_API_KEY` — declared, never read by any source file.

## The enforcement layer — the part that matters

This is why the user believed they were trapped. The project's convention checker contained rules
whose **only** function was to fail the build if vendor code was removed:

```json
{ "name": "web-app-keeps-platform-runtime",
  "paths": "packages/web/src/web/app.tsx",
  "must": { "importFrom": ["@platform/website-runtime"] } },

{ "name": "desktop-main-creates-managed-deep-links",
  "paths": "packages/desktop/electron/main.ts",
  "must": { "importFrom": ["@platform/managed-auth/desktop/main"] } },

{ "name": "desktop-preload-exposes-managed-auth-bridge",
  "paths": "packages/desktop/electron/preload.ts",
  "must": { "importFrom": ["@platform/managed-auth/desktop/preload"] } }
```

Plus `template-managed-files-exist-*` rules requiring vendor files to be present, and a
`protected-files` lint rule holding **sha256 hashes** of every `__`-prefixed file, so editing one
failed the build.

**Remove the badge, and your build breaks.** A reasonable developer concludes the badge is
load-bearing. It is not. It is guarded. Nineteen conventions went to sixteen; the remaining sixteen
enforce real structure and were left alone.

## What replaced the wrapper

Deep links, natively, in about twenty lines:

```ts
const PROTOCOL = "yourapp";                       // vendor branding gone from the OS

function registerProtocol(): void {
  if (isDev && process.platform !== "darwin") {
    // In dev the OS must be told which executable to re-invoke, or the link opens a bare Electron.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] ?? "")]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

// macOS delivers deep links as an event, never as argv.
app.on("open-url", (event, url) => { event.preventDefault(); forward(url); });

// Windows and Linux deliver them in argv — second instance, or this one on a cold start.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", (_e, argv) => forward(deepLinkFromArgv(argv)));
  app.whenReady().then(() => { registerProtocol(); createWindow(); forward(deepLinkFromArgv(process.argv)); });
} else {
  app.quit();
}
```

And `openExternal` as plain IPC — **keeping the security check the wrapper had been hiding**:

```ts
ipcMain.handle("shell:open-external", async (_, url: string) => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  await shell.openExternal(parsed.toString());
  return true;
});
```

Without that protocol check a renderer could pass `file://` and have the OS open a local executable.
When you reimplement a wrapper, inventory what safety it was providing before you throw it away.

## The unexpected win

Removing vendor coupling **fixed a pre-existing broken typecheck**. Root cause: Vite was declared
separately by two workspace packages, giving TypeScript two distinct copies of every Vite type, so a
plugin from the hoisted copy was not assignable to the config of the nested one. Declaring the shared
build tool **once at the root** fixed it — and then exposed two real errors that had been buried
under the cascade.

Worth reporting separately so it does not look like part of the de-vendoring.

## Two mistakes made, both instructive

**Mistake 1 — concluded "no vendor code" from a narrow search.** Searched for AI-provider names
because that is what the user said, found nothing, and told the user there was nothing. There were
six categories of coupling. Fix: search for what *scaffolded* the project, not only what the user
names.

**Mistake 2 — nearly deleted the wrong dead code.** A fixed-point math module was unused by the
simulation. Classic dead code. It was also the correct implementation of a determinism property the
project *claimed* to have and did not — the simulation was calling `Math.cos`/`Math.sin` on values
that fed a cross-machine state hash, which meant honest players' recorded runs would fail server-side
revalidation and be rejected as cheating. Deleting the "dead" module would have destroyed the fix.
The correct action was to wire it in.

Fix: for every dead thing, ask whether it is abandoned or whether it is the solution nobody
connected.

## Final verification

| Check | Result |
|---|---|
| lint | clean — 0 convention violations, 0 lint errors |
| typecheck | **4/4 passing** (was failing before, unrelated) |
| engine tests | only a pre-existing perf-budget failure, present on `main` too |
| e2e | pass |
| web build | builds |
| vendor references remaining | explanatory comments only |

`main` untouched. Everything on a branch, in an unmerged PR, with the caveats spelled out.

## The takeaway

The dependencies took minutes. What made this feel impossible to the user was:

1. **The enforcement layer** — rules that punished removal.
2. **Comments asserting necessity** that were simply false.
3. **A dead host** producing an error message that named a proxy, not the platform, so it was
   unsearchable.
4. **Nobody having told them** which parts were theirs and which were rented.

Handle the enforcement first. Verify every claim in a comment. And tell the user plainly which parts
of their project are actually theirs.
