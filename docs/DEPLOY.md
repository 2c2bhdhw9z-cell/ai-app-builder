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
| `CONTAINER_BIN` | `docker` | Container CLI. Set to `podman` on a podman host. Not probed at boot, so the server still starts (and `/healthz` still answers) on a host with no runtime — the failure surfaces as a `503` from `POST /projects` instead. Containers left by a crashed previous process can be cleared with `AAB_STARTUP_REAP` (see below); without it, per-project cleanup still happens on release. Inspect with `docker ps -a --filter label=aab.sandbox`. |
| `AAB_STARTUP_REAP` | `off` | Clear sandbox containers left behind by a **crashed previous process**. `off` (default): no reap. `instance` (also selected by `1`/`true`/`yes`/`on`): reap only containers stamped with **this deployment slot's** instance id — safe alongside other live instances, and the right choice for a crash-restart. `all`: reap every container carrying the `aab.sandbox` label regardless of who created it — **only** where this process is the sole platform instance using the runtime, since it will otherwise destroy a live sibling's running sandboxes. An unrecognized value falls back to `off`. The reap starts **after** the listening socket is open and is never awaited, so it cannot delay `/healthz`; a host with no container runtime is a **no-op**, not an error; and no failure in it can fail boot. |
| `AAB_INSTANCE_ID` | the hostname | This deployment slot's identity, stamped on every container we create as `aab.instance=<id>`. It is what makes "an orphan of *our* crashed predecessor" distinguishable from "a *live sibling's* container", which is what `AAB_STARTUP_REAP=instance` relies on. It must be **stable across a process restart in the same slot** and **distinct between concurrently running instances**. The hostname default is only distinct **per host or pod** — so **set this explicitly, per instance, whenever more than one instance shares a container runtime** (two units on one VM, blue/green, `hostNetwork: true`, a compose service with an explicit `hostname:`). Otherwise both instances resolve the same id and `instance` silently degrades to `all` between them. Sanitized to `[A-Za-z0-9_.-]` and truncated to 64 characters. |
| `SANDBOX_IMAGE` | `node:22-slim` | Image each Project sandbox runs. |
| `AAB_SANDBOX_EGRESS` | `none` | Sandbox network posture. `none` (default) = `--network none`: commands run, but there is no network at all, so **`npm install` cannot work**. `registry` = the sandbox may reach the package-registry hosts and **nothing else**, which makes `npm install` work without opening general egress; see *Registry-only egress* below for how that is enforced. Any unrecognized value falls back to `none`. |
| `AAB_SANDBOX_EGRESS_HOSTS` | unset | Extra hosts added to the sandbox allowlist, comma-separated (a private registry mirror, or a connector endpoint a build genuinely needs). **Only honored in `registry` mode** — in `none` there is no network to allow anything on, so these are ignored rather than quietly re-enabling egress. Host-local *literals* (loopback, RFC1918, link-local, `169.254.169.254`, `host.docker.internal`, and alternate encodings like `2130706433`) are stripped at configuration time, and a *name* that resolves to such an address is refused at connection time — the proxy is the one component with real egress, so allowlisting a metadata address through it would be a credential-exfiltration path. **This allowlist is platform-wide, not per-project** — see the caveat below. |
| `AAB_EGRESS_ALLOW_PRIVATE_ADDRESSES` | off | Read by the **egress proxy container**. Allows allowlisted names to resolve to private/loopback addresses, for a registry mirror that genuinely lives on one. This gives up the SSRF protection described below, so it is off unless you set it. |

### Registry-only egress (how `registry` is enforced)

The posture is enforced by the runtime, not asserted by us:

1. **One container network per project**, created `--internal` — it has **no route out at all**. That is the deny-by-default primitive. Per project, not shared, so sandboxes cannot reach *each other* either (containers on a shared user-defined network reach each other on every port, and the runtime's embedded DNS resolves peer container names).
2. One **allowlisting proxy** container, attached to every one of those internal networks *and* to a normal egress-capable one, making it the only path out. It matches on hostname and forwards only allowlisted hosts.
3. The sandbox container joins **its own internal network only**, with `HTTP_PROXY` / `HTTPS_PROXY` / `npm_config_proxy` pointed at the proxy. Those variables are applied *over* any project secret of the same name — they are an enforcement control, not a default.

A package install script that ignores the proxy variables gets no bypass: on an internal network there is no route, and no external DNS to find one with.

The proxy **does not terminate TLS**. An `https://` fetch arrives as `CONNECT host:443`; the host is checked and, if allowed, raw bytes are piped. So npm's certificate validation and integrity hashes stay end-to-end exactly as without a proxy, and the filtering unit is a hostname — the same granularity the allowlist is written in. An absolute-form `https://` proxy request (which no normal client sends) is **refused** rather than serviced, so a URL that asked for TLS is never downgraded to cleartext. The proxy is a stdlib-only Node program running in the **same image the sandbox already uses**, so this adds no image to pull and no dependency.

Fail-closed throughout:

- an empty allowlist refuses everything (a config that failed to arrive must not mean allow-all);
- hostname matching is **exact** — no suffix rules, so `evil-registry.npmjs.org` is not the registry;
- **both** the CONNECT and the plain-HTTP path are limited to ports 443/80, so an allowlisted host cannot be reached on some other service port;
- an allowlisted name that **resolves** to loopback, an RFC1918 range, CGNAT, multicast or `169.254.169.254` is refused *at connection time*, so a split-horizon or hijacked record cannot turn the one component with real egress into an SSRF path. Set `AAB_EGRESS_ALLOW_PRIVATE_ADDRESSES=1` (default off) only if your registry mirror genuinely lives on a private address — it gives up that protection;
- an existing network of the expected name is **inspected and required to be internal** before it is used. `--internal` is a *creation* flag, so adopting a pre-existing routable network of the same name would have silently restored full egress;
- an already-running proxy is adopted **only if its allowlist fingerprint matches** the current configuration (it is recorded as a container label). Otherwise it is replaced — so removing a host actually revokes it, and a container is not trusted merely for having the right name;
- the proxy must be **observed listening** before any sandbox that depends on it is launched;
- if any of that cannot be established, the command is **denied** rather than run with whatever networking happens to exist, and a transient failure is retried on the next command rather than cached.

Every decision is logged by the proxy, so a denial is diagnosable: `docker logs aab-egress-proxy`.

Two caveats worth knowing. The allowlist is **platform-wide, not per-project**: in `registry` mode every sandbox shares the same allowed hosts, so a connector host added via `AAB_SANDBOX_EGRESS_HOSTS` is reachable from *every* project. Deny-by-default against the open internet still holds, and projects remain isolated from each other; per-project allowlists would need a proxy per project and are a remaining follow-up. And the proxy and the per-project networks are **not** torn down by per-project cleanup — that is scoped to a project's own label and never matches the proxy. A startup reap (`AAB_STARTUP_REAP`, see above) does collect the proxy, since it carries the same `aab.sandbox` owner label and the same instance stamp; either way, the next filtered command detects it is gone and rebuilds it, so removing it by hand is safe. Note the proxy's name is fixed and a sibling instance may have adopted the one *you* created — see the reap caveats. The per-project **networks** are labelled but nothing removes them yet, so they accumulate across projects — harmless, but worth a periodic `docker network prune --filter label=aab.sandbox`.

### Preview (the served dev server)

A Preview is only real if a dev server is actually listening **and** the host can
reach it. That needs a published port, and a published port needs a routable
container network: `--network none` gives a container only a loopback interface,
so a published port has no DNAT target and could never answer. Publishing a URL
that cannot answer is exactly the failure mode this section exists to avoid, so
the backend **refuses** that combination instead of pretending.

That collides with deny-by-default egress, and the collision is real: the code a
Preview runs is generated, untrusted code, so attaching it to a routable network
grants it egress the sandbox posture otherwise withholds. **That trade is yours to
make explicitly** — it is never a default.

| Variable | Default | Purpose |
|---|---|---|
| `AAB_PREVIEW_NETWORK` | unset → **no real Preview** | The container network a Project's dev server joins. **Unset: the Dev_Server stays an inert seam** — the Preview lifecycle is wired and answers, but no container is launched and the URL is honestly reported as a `http://preview.local/<id>` placeholder that serves nothing. **Set to a network name: Previews are real** — the dev server is launched detached inside the Project's Isolation_Boundary (same bind-mounted tree, same `aab.sandbox` owner label, same requested cgroup limits as an exec container) and its port is published to the host. You choose the network, so you choose how much egress the previewed app gets; a network that permits inbound while restricting egress is the containing choice. Composition **fails loudly** if this is set but the backend cannot run service containers, rather than silently falling back to the placeholder. |
| `AAB_PREVIEW_HOST_IP` | `127.0.0.1` | Host IP previews are published on. Loopback by default so a preview is never exposed on every interface by accident. Put a reverse proxy in front of it rather than widening this. |
| `AAB_PREVIEW_CONTAINER_PORT` | `5173` | The in-container port the dev server is asked to listen on. Exported to the container as `$PORT` (with `$HOST=0.0.0.0`). Must be a valid TCP port; an out-of-range value is ignored in favour of the default. |
| `AAB_PREVIEW_PORT_RANGE` | `43000-43999` | Host ports previews may be published on, as `from-to`. A malformed or inverted range is ignored in favour of the default rather than guessed at. |

How a dev server is started, in order: the Project's `package.json` `dev`, then
`start`, then `serve` script (run as `npm run <script>` — the script *body* is
never spliced into a command, so generated content is interpreted by npm inside
the container and never by a host shell); Vite additionally gets explicit
`--host 0.0.0.0 --port $PORT` flags because it ignores `$PORT`. A project with no
dev script but an `index.html` is served by a **dependency-free stdlib static
server**, which needs no install and therefore works under `AAB_SANDBOX_EGRESS=none`.
A project with neither is refused with a structured reason. A `mobile` Target is
refused here on purpose — an Expo preview needs a device-reachable endpoint, not a
published HTTP port.

Readiness is polled against the published URL up to the 60s bound (Req 1.3). A dev
server that dies **during startup** is detected on the next poll by inspecting the
container rather than waiting the bound out; one that dies **after** it came up is
caught by a background liveness check every 10s. Either way its log tail is
attached to the failure, the container is removed, the host port is released, and
the committed snapshot from the last good commit is **retained** while the served
status drops from `served` to `committed` with a null URL — so the surface stops
advertising a URL that no longer answers.

Two limits to know about here. `PreviewController`'s own 60s *startup* bound is not
the one in force: because `start()` must return synchronously (the controller
inspects its result inline), a container-backed start reports `ready` as soon as the
launch is *requested*, and the real readiness bound is the one above. And while a
dead preview is recorded and `notifyExit` runs, **nothing pushes a status frame to
a connected client** — a client learns about it by polling `GET /preview`, not from
the session SSE. Wiring that broadcast is a remaining follow-up.

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

- ~~**No real Preview is served.**~~ **Done** — a real dev server now exists behind
  the seam (`src/project/container-dev-server.js`), launched detached inside the
  Project's Isolation_Boundary with its port published to the host, and it is
  selected by setting `AAB_PREVIEW_NETWORK` (see *Preview* above). The inert seam
  (`src/project/dev-server.js`) remains the default, so a deploy that has not made
  the network/egress decision keeps exactly the old, honest placeholder behavior
  rather than silently gaining egress. `runtime.previewMode` reports which one you
  got (`'container'` or `'inert'`).

  What is proven without a container: the emitted runtime argv (detached, published
  port, owner label, project-only mount, boundary cgroup limits, unchanged isolation
  flags), both fail-closed refusals, the dev-command decision, phase transitions,
  the clock-driven readiness bound, dead-container detection both during and after
  startup with its log tail, host-port accounting across failure/stop/reuse
  (including that a failed preview cannot free a port another project holds),
  teardown of a stop that races an in-flight launch, and — through the **real**
  `PreviewController` — that publish-on-commit reports a live URL where the inert
  seam reported a placeholder, and that a dead dev server stops being reported as
  served. The static fallback server is additionally proven by running it as a real
  process on a real port over real HTTP, including traversal, symlink-escape and
  malformed-request (NUL byte) handling.

  **What only a real container host can prove:** that the runtime accepts this argv,
  that the published port is reachable from the host, and that a given generated
  project's dev script really binds `0.0.0.0:$PORT`. To check it on a container
  host: `docker network create aab-preview`, start with
  `AAB_PREVIEW_NETWORK=aab-preview`, create a project and run a turn, then
  `GET /preview?projectId=...` and fetch the returned URL — it must serve the app,
  and `docker ps --filter label=aab.sandbox` must show the dev-server container.
- ~~**`AAB_SANDBOX_EGRESS=none` means package installs cannot work.**~~ **Done** — a
  filtering-capable backend now sits behind the same `createContainerBackend` seam
  (`src/sandbox/filtering-container-backend.js` + `src/sandbox/egress-proxy.js`), so
  `AAB_SANDBOX_EGRESS=registry` is genuinely enforceable instead of denying every
  command: an `--internal` network with no route out, plus one allowlisting proxy
  that is the only way out. `npm install` works without opening general egress. The
  default is still `none`, and deny-by-default is unchanged — the registry is an
  *allowlist entry*, not an exception to the posture. See *Registry-only egress*.

  What is proven without a container, by running the proxy as a **real process**
  driven with **real HTTP** and a **real CONNECT tunnel** against a real upstream:
  every allow/deny decision, the exact-match rule against near-miss names, the port
  bound on *both* paths, the refusal of an allowlisted name that resolves to a
  non-public address, the refusal of absolute-form `https://`, that a forged `Host`
  header cannot redirect the connection and that hop-by-hop headers are stripped,
  the empty-allowlist refusal, and survival of a malformed request. Against the real
  backend with only the CLI faked: the emitted argv; a **network per project** (so
  sandboxes cannot reach each other); setup ordering and its idempotence under
  concurrency; that an existing network is adopted only when verified internal; that
  a proxy is adopted only when its allowlist fingerprint matches; stale/exited/dead
  proxy replacement; that a proxy which never listens denies the command; every
  fail-closed path launching **nothing**; that a half-built plane is torn down;
  that a transient failure — including a **thrown** one — is retried rather than
  cached; that the delegate is permitted only total-deny plus its own internal
  networks; that caller secrets survive the translation while the proxy settings
  win; and — through the **real** `SandboxManager` — that a populated allowlist now
  runs a command where the plain backend still denies it.

  **What only a real container host can prove:** that `--internal` truly severs the
  route, that the runtime's embedded DNS resolves the proxy's container name on an
  internal network, and that a real `npm install` completes through the proxy while
  an off-allowlist host stays unreachable. To check it on a container host: start
  with `AAB_SANDBOX_EGRESS=registry`, run a turn that installs a dependency, and
  confirm `docker logs aab-egress-proxy` shows `ALLOW registry.npmjs.org` — then
  exec `curl https://example.com` in the sandbox and confirm it fails while the
  install succeeded.
- ~~**Orphan containers are not reaped at startup.**~~ **Done** — set
  `AAB_STARTUP_REAP=instance` (see above) and containers left by a crashed prior
  process in this deployment slot are cleared on boot. It stays **off by default**,
  because a reap is destructive and the safe scope depends on whether other
  instances share the runtime.

  The three properties that had kept this undone are what the implementation is
  built around, and each is tested: the reap is started **after** `listen()` resolves
  and never awaited, so `/healthz` answers while it is still running (proven by
  fetching it over real HTTP against a real server with the reap deliberately
  stalled); a host with **no container runtime is a no-op**, not an error, because
  availability is probed before any sweep is attempted; and it **cannot fail boot** —
  a throwing probe, a throwing reap, a failed container listing, a junk result and
  even a throwing logger all resolve to a structured result.

  Scoping is the safety story. `aab.sandbox` alone cannot distinguish an orphan of
  *our* crashed predecessor from a *live sibling instance's* container, so an
  unscoped sweep on a shared host would kill a neighbour's sandboxes mid-turn. Every
  container we create now also carries `aab.instance=<slot>`; at boot this process
  has created none, so anything already bearing our own id is by definition an
  orphan of a prior process in this slot. A bare `AAB_STARTUP_REAP=1` therefore
  selects `instance`, never `all` — the destructive scope has to be named.

  Three limits of the safe scope, each of which leaves containers only `all` can
  reach — and each of which is now **counted and logged** at boot rather than being
  indistinguishable from a clean host:

  - a slot that is **recreated** rather than restarted in place (a rescheduled pod,
    `docker compose up` recreating the container, `docker run` without a fixed
    `--hostname`) gets a *new* id, so its predecessor's containers are unclaimable;
  - containers created **before this feature shipped** carry no instance label at all,
    so the first restart after enabling the reap skips them — run `all` once, when you
    know no sibling is live;
  - the **egress proxy** from *Registry-only egress* has a fixed name and is adopted
    by whichever instance finds it healthy, but stays labelled with its *creator's*
    slot. So the creator's restart can remove a proxy a sibling is routing through;
    that sibling's next filtered command detects it and rebuilds it, at the cost of
    the in-flight install.

  Two things protect live work from the sweep itself: a container **this process
  launched** is never removed (the window between the socket opening and the listing
  returning is seconds wide on a cold daemon, and a request landing in it creates a
  container wearing our own id), and every candidate's instance label is
  **re-checked** before `rm -f` rather than the runtime's label filtering being taken
  on trust.

  **What only a real container host can prove:** that the runtime's label filters
  select exactly these containers and that `rm -f` collects them. To check it: kill
  the platform with `SIGKILL` while a turn is running, confirm
  `docker ps --filter label=aab.sandbox` still lists the container, restart with
  `AAB_STARTUP_REAP=instance`, and confirm the boot log reports the removal and the
  list is empty.
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
