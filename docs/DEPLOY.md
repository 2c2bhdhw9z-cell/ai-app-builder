# Deploying ai-app-builder

How to get from "the process boots and answers `/healthz`" to "I can log in from
my phone and drive a build".

The platform is **fail-closed by default**: an unconfigured deploy starts, serves
the unauthenticated health probe, and denies every login. Nothing below can make
it *accidentally* open — a missing or malformed variable keeps it shut and says so
in the startup log.

## Quick start

```bash
npm ci                # or: npm install
PORT=8080 HOST=0.0.0.0 npm start
curl -fsS http://localhost:8080/healthz    # -> {"status":"ok"}
```

At this point the auth-gated routes (`/message`, `/events`, `/confirm`,
`/projects`, `/work-mode`, `/preview`) all return `401` and `/auth/login` is not
routed at all. That is correct and intentional. Configure identity to open it.

## Environment variables

### Binding

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | TCP port. A non-numeric or out-of-range value falls back to the default. |
| `HOST` | `0.0.0.0` | Bind address. The default is all interfaces, so the server is reachable from outside a container. |

### Identity / login (`OIDC_*`)

Login is enabled only when **every** required variable below is present and
valid. Anything else logs `identity: LOGIN DISABLED — <reason>` and leaves
`/auth/login` unrouted.

| Variable | Required | Purpose |
|---|---|---|
| `OIDC_PROVIDER` | yes | `github` or `google`. Unset or `none` disables login. |
| `OIDC_CLIENT_ID` | yes | OAuth client id from the provider. |
| `OIDC_CLIENT_SECRET` | yes | OAuth client secret. Never commit this; inject it at runtime. |
| `OIDC_REDIRECT_URI` | yes | The callback URL registered with the provider, ending in `/auth/callback`. Must be `https://` — or `http://` on loopback for local development. A plaintext non-loopback value is **refused**, because it would expose the login cookie and the authorization code. |
| `OIDC_SCOPE` | no | Overrides the provider default (`read:user` for GitHub, `openid email` for Google). |
| `OIDC_ISSUER` | no | Override the expected `iss`. Must be `https://` and must be set **together with** `OIDC_JWKS_URI`. |
| `OIDC_JWKS_URI` | no | Override the signing-key endpoint. Same rules as `OIDC_ISSUER`. |
| `OIDC_STATE_SIGNING_KEY` | no | HMAC key for the login `state`. Without it a random key is generated per process, so a restart invalidates logins that are mid-flight (the user just retries) and two replicas reject each other's states. Set it for a multi-replica or restart-tolerant deploy. **Must be at least 32 characters** — a shorter value is ignored (falling back to the random per-process key) rather than used as a weak secret. Generate with `openssl rand -base64 32`. |

### Storage

| Variable | Default | Purpose |
|---|---|---|
| `AAB_DATA_DIR` | `~/.ai-app-builder/data` | **Durability-critical — mount a volume here.** Holds both the exportable Project trees (each Project's sandbox mount, i.e. the agent's working directory) and the control plane (project registry, snapshots, secrets, presentation settings). The default is deliberately *outside* the server's own source tree; a relative value is resolved against the process cwd. Losing this directory loses every Project. |

### Sandbox / container runtime

| Variable | Default | Purpose |
|---|---|---|
| `CONTAINER_BIN` | `docker` | Container CLI. Set to `podman` on a podman host. Not probed at boot, so the server still starts (and `/healthz` still answers) on a host with no runtime — the failure surfaces as a `503` from `POST /projects` instead. One consequence of not probing: containers left behind by a crashed previous process are **not** reaped at startup (per-project orphan cleanup still happens on release). Run `docker ps -a --filter label=aab.sandbox` after an unclean restart if you want to check. |
| `SANDBOX_IMAGE` | `node:22-slim` | Image each Project sandbox runs. |
| `AAB_SANDBOX_EGRESS` | `none` | Sandbox network posture. `none` = no network at all: commands run, but nothing can reach the network (so **`npm install` cannot work**). `registry` = allow the package-registry hosts, which requires per-host egress filtering that the CLI container backend **cannot** enforce — it fails closed, refusing every command. Only choose `registry` with a filtering-capable backend. Any unrecognized value falls back to `none`. |

### Resource quotas

All optional; each must be a positive integer or it is ignored.

| Variable | Default | Purpose |
|---|---|---|
| `AAB_MAX_CONCURRENT_SANDBOXES` | 64 | Global concurrent-sandbox ceiling, counted as the sandboxes *in use* within `AAB_SANDBOX_IDLE_MS` (see below). Deliberately below the SandboxManager's internal capacity of 256: setting it *equal* to that capacity is a trap, because the quota denies at `current >= max` before the acquire that would trigger LRU eviction, so the count could never fall. |
| `AAB_SANDBOX_IDLE_MS` | `900000` (15 min) | How long a sandbox boundary may sit unused before it is reclaimed. **This is what makes the ceiling recoverable.** Nothing releases a boundary on the success path (a create takes one, and so does the first turn), so without reclamation the count only grows and the ceiling would become permanent until a restart. Lower it to recycle capacity faster; raise it to keep sandboxes warm longer. A boundary with a command in flight is never reclaimed, and completion counts as use, so this does not have to exceed your longest command — but values below a few seconds will churn sandboxes between turns for no benefit. |
| `AAB_MAX_CONCURRENT_SANDBOXES_PER_ACCOUNT` | unset (no per-account limit) | Enables the Req 23 anti-starvation ceiling. **Set this on any multi-tenant deploy:** without it, one account can consume the entire global allowance. Note it costs a registry lookup per live sandbox on the create/turn path. |
| `AAB_MAX_TOTAL_PROJECTS` | 50 | Per-account total-Project ceiling. |

Known limitation: at exactly the global ceiling, a turn on a project that already
holds a sandbox is also refused, because the quota seam receives no per-project
context and so cannot exclude the requester. Idle reclamation clears this within
`AAB_SANDBOX_IDLE_MS` rather than requiring a restart.

### Model provider

The agent needs a model provider. Construction is offline, so a missing key does
not stop the server from booting — it fails when a turn actually runs.

| Variable | Purpose |
|---|---|
| `PLUMBY_PROVIDER` | `anthropic` (default), `gemini`, or `openrouter`. |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) / `OPENROUTER_API_KEY` | The key for the selected provider. |
| `AAB_MODEL` | Optional. Pins the model the default agent path builds with, instead of the provider's default. |

## Setting up the provider

### GitHub

1. **Settings → Developer settings → OAuth Apps → New OAuth App.**
2. Authorization callback URL: `https://<your-host>/auth/callback`.
3. Export `OIDC_PROVIDER=github`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and
   `OIDC_REDIRECT_URI` (matching the URL above exactly).

GitHub OAuth Apps issue no `id_token`, so identity comes from the code exchange
followed by one userinfo lookup. The **immutable numeric user id** becomes the
subject, so renaming your GitHub account does not change your platform identity.

### Google

1. Google Cloud console → **APIs & Services → Credentials → OAuth client ID**
   (type: Web application).
2. Authorized redirect URI: `https://<your-host>/auth/callback`.
3. Export `OIDC_PROVIDER=google` plus the same three variables.

Google is real OIDC: the returned `id_token` is verified cryptographically —
RSA signature against the published JWKS, an algorithm allow-list that excludes
`none` and HMAC, and exact `iss`/`aud` plus `exp`/`nbf`/`iat` and `sub` checks.

## Logging in

1. Open `https://<your-host>/auth/login` in a browser. You are redirected to the
   provider, and a short-lived `HttpOnly` cookie binds the login to that browser.
2. Approve access. The provider redirects back to `/auth/callback`.
3. The response is JSON: `{ "token": "...", "tokenType": "Bearer", ... }`.
4. Send that token on every gated request:
   `Authorization: Bearer <token>`.

The token is a signed session token bound to one account. It is returned with
`Cache-Control: no-store` and is never written to a cookie.

## Running it on a server

Two supported shapes. Both need a container runtime on the host, because Project
sandboxes are launched by shelling out to a container CLI.

### Option A — directly on the VM under systemd (recommended)

Simplest, and the privilege situation is the most obvious: the process uses the
host's own `docker`, so there is no socket to pass into anything.

```bash
# Oracle Cloud ARM (Ubuntu). Node 20+ and a container runtime:
sudo apt-get update && sudo apt-get install -y docker.io git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# Both checkouts must be siblings — package.json uses file:../plumby
git clone https://github.com/<owner>/plumby.git
git clone https://github.com/<owner>/ai-app-builder.git
cd ai-app-builder && npm ci --omit=dev

# The service user needs to reach the container runtime:
sudo usermod -aG docker "$USER"   # log out/in for this to take effect
```

`/etc/systemd/system/ai-app-builder.service`:

```ini
[Unit]
Description=ai-app-builder
After=network-online.target docker.service
Wants=network-online.target

[Service]
WorkingDirectory=/home/ubuntu/ai-app-builder
EnvironmentFile=/etc/ai-app-builder.env
ExecStart=/usr/bin/node src/server/start.js
Restart=always
User=ubuntu
# The data directory holds project secrets, the registry and snapshots, and the
# stores write under the process umask — so restrict it rather than leaving it
# 0755/0644 readable by every other local account on the box.
UMask=0077

[Install]
WantedBy=multi-user.target
```

Put every variable from the tables above in `/etc/ai-app-builder.env`
(`chmod 600` — it holds your client secret and model API key). **For this systemd shape only**, set `HOST=127.0.0.1` there as well, so the only
public entrance is the TLS terminator below. The `0.0.0.0` default exists for the
container case, where a loopback bind is unreachable through `-p` — so if you reuse
this env file for Option B, that recipe overrides it with `-e HOST=0.0.0.0`. Then:

```bash
sudo systemctl enable --now ai-app-builder
curl -fsS http://localhost:8080/healthz
journalctl -u ai-app-builder -f     # shows the identity posture on startup
```

### Option B — in a container

**Build context is the parent directory**, because `plumby` is a `file:../plumby`
sibling and a context rooted at this repo cannot see it:

```bash
cd /path/containing/both-checkouts
docker build -f ai-app-builder/Dockerfile -t ai-app-builder .
```

```bash
# The data directory MUST be a host bind mount at the SAME path as in the
# container — see the explanation below; a named volume silently breaks sandboxes.
sudo mkdir -p /var/lib/ai-app-builder
sudo chown 1000:1000 /var/lib/ai-app-builder   # uid 1000 = the image's `node` user
sudo chmod 700 /var/lib/ai-app-builder

docker run -d --name ai-app-builder \
  --restart unless-stopped \
  --init \
  -p 127.0.0.1:8080:8080 \
  --env-file /etc/ai-app-builder.env \
  -e HOST=0.0.0.0 \
  -v /var/lib/ai-app-builder:/var/lib/ai-app-builder \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  ai-app-builder
```

- `-p 127.0.0.1:8080:8080` — publishes to **loopback only**, so the reverse proxy
  below is the sole public entrance. Plain `-p 8080:8080` binds every host
  interface via DNAT rules that a host firewall like `ufw` does **not** filter,
  which would serve the whole authenticated API — and its bearer tokens — in
  cleartext next to your HTTPS listener.
- `-e HOST=0.0.0.0` — **required**, and it must come after `--env-file`. The
  shared env file sets `HOST=127.0.0.1` for the systemd shape, which is wrong
  inside a container: the server would bind the *container's* loopback, the
  published port would have nothing to connect to, and the `HEALTHCHECK` — which
  probes container-local loopback — would still report `(healthy)` next to a port
  that refuses every connection. Loopback-only exposure is achieved by the publish
  address above, not by the bind address.
- `-v /var/lib/ai-app-builder:/var/lib/ai-app-builder` — **an identical-path host
  bind mount, not a named volume, and this is not a style preference.** When the
  platform launches a Project sandbox it passes its own `AAB_DATA_DIR` paths as the
  *host* side of the sandbox's `-v` flag. Those paths are resolved by the daemon you
  mounted the socket of — the **host's** daemon — so they must exist at that exact
  path on the host. With a named volume they do not: docker helpfully creates empty
  root-owned directories instead, every sandbox gets a blank `/workspace`, the agent
  writes somewhere the platform never reads, and **commands still exit 0**, so
  nothing surfaces the fault. The `chown 1000:1000` above is required for the same
  reason the volume is: a bind mount keeps the host's ownership, and the image's
  build-time `chown` only seeds *named* volumes, so without it the non-root user
  cannot write.
- `-v /var/run/docker.sock:...` + `--group-add` — what lets the platform launch
  Project sandboxes at all. **Read this before you do it:** access to the host's
  docker socket is root-equivalent *on the host*, so the container is not a security
  boundary against itself. Omit both (and the bind mount can then be a named volume)
  if you want a surface-only instance and accept that `POST /projects` returns
  `503`. Build with `--build-arg WITH_CONTAINER_CLI=false` to leave the CLI out too.
- `--init` — so signals reach the server and orphaned sandbox processes are reaped;
  the platform spawns container CLI children continuously.
- `--restart unless-stopped` — matches `Restart=always` in the systemd unit, so the
  container comes back after a host reboot.

### Reverse proxy / TLS

`OIDC_REDIRECT_URI` must be `https://` for any non-loopback deploy (the login
cookie's `Secure` attribute and the authorization code both depend on it), so put
a TLS terminator in front and forward to `127.0.0.1:8080`. Caddy is two lines:

```
your-host.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Then set `OIDC_REDIRECT_URI=https://your-host.example.com/auth/callback` and
register exactly that URL with your identity provider.

## Known follow-ups

- **No real Preview is served.** The Preview *lifecycle* is wired and reachable —
  `GET /preview` and `POST /preview/restart` answer, status frames stream on the
  session SSE, and publish-on-commit is enforced — but the DevServer behind it
  (`src/project/dev-server.js`) is a documented inert seam: it records intent and
  synthesizes a `http://preview.local/<id>` placeholder, launching nothing. A
  client therefore receives a preview URL that serves no content. Making the
  preview real means implementing a live dev server behind that existing seam.
- **`AAB_SANDBOX_EGRESS=none` means package installs cannot work.** The CLI
  container backend cannot enforce per-host egress filtering, so the only postures
  available are "no network" (commands run) or "filtered" (which that backend
  refuses outright). A build that needs `npm install` needs a filtering-capable
  backend behind the existing `createContainerBackend` seam.
- **Orphan containers are not reaped at startup.** Deliberate: probing the
  container runtime during boot would stop `/healthz` from answering on a host
  without one. Per-project cleanup still happens on release.
- **Single instance assumed.** Accounts, sessions and the login-state key are
  in-process. Behind a load balancer, either pin sessions to one instance or set
  `OIDC_STATE_SIGNING_KEY` — and note that accounts and sessions are still
  per-process regardless.
- **PKCE / OIDC `nonce` are not implemented.** This is a confidential client
  (client secret, server-side exchange over TLS, registered redirect URI), and
  login CSRF is covered by the cookie-bound `state`. The residual gap PKCE would
  close is *authorization-code injection*: someone who obtains your authorization
  code (referrer leakage, an open redirector, a proxy log) could present it from
  their own browser. Adding it is additive, not a redesign.

## What is verified automatically, and what is not

`npm test` is fully hermetic — no network, no API key, no container. The login
wiring is covered by real cryptography (real RSA keypairs, real `node:crypto`),
the real `AuthService`/`IdentityManager`/`SessionManager`, and a real HTTP server
on a real port, with **only the IdP network calls and the clock faked**.

Consequently these are proven here:

- an `id_token` that is tampered with, unsigned, HMAC-confused, wrong-audience,
  wrong-issuer, expired, or signed by an unpublished key is **rejected**;
- an unconfigured / partially configured / plaintext-callback environment
  **denies every login**;
- a login `state` without its browser cookie, replayed, expired, forged, or
  ambiguous is **rejected**;
- a completed callback yields a token that **opens a gated route**.

These still require a real deploy with real credentials to prove:

- that the provider accepts your `OIDC_CLIENT_ID` and `OIDC_REDIRECT_URI`, and
  that the live redirect round-trip completes in a real browser;
- that a real model provider key authorizes a real turn;
- that a real container runtime enforces the sandbox limits.
