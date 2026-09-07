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

### Model provider

The agent needs a model provider. Construction is offline, so a missing key does
not stop the server from booting — it fails when a turn actually runs.

| Variable | Purpose |
|---|---|
| `PLUMBY_PROVIDER` | `anthropic` (default), `gemini`, or `openrouter`. |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` | The key for the selected provider. |

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

## Known follow-ups

- **PKCE / OIDC `nonce` are not implemented.** This is a confidential client
  (client secret, server-side exchange over TLS, registered redirect URI), and
  login CSRF is covered by the cookie-bound `state`. The residual gap PKCE would
  close is *authorization-code injection*: someone who obtains your authorization
  code (referrer leakage, an open redirector, a proxy log) could present it from
  their own browser. Adding it is additive, not a redesign.
- **Single instance assumed.** Accounts, sessions and the login-state key are
  in-process. Behind a load balancer, either pin sessions to one instance or set
  `OIDC_STATE_SIGNING_KEY` and accept that accounts/sessions are still per-process.

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
