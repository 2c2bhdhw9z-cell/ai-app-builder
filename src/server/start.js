/**
 * start.js — the PRODUCTION entry point (boot-readiness, Task 21).
 *
 * The platform was fully built out (Tasks 1-20) but had no runnable process: no
 * code path constructed the Builder Server and called `.listen()` for a real
 * deployment, and there was no `start` script. This module is that missing
 * production wiring, and NOTHING more — it does not add product scope. It:
 *
 *   1. Composes the platform-operations spine through the EXISTING composition
 *      root (src/ops/compose.js) rather than hand-wiring modules, so audit /
 *      observability / redaction are the SAME wired instances a real run needs.
 *   2. Constructs a LIVE plumby provider through the engine boundary
 *      (src/engine/plumby.js) — never importing the plumby package directly —
 *      so the default agent path is usable. Provider construction is offline;
 *      an API key is only required when a turn actually runs.
 *   3. Builds the Builder Server via the EXISTING createBuilderServer factory
 *      (src/server/builder-server.js) and calls its EXISTING
 *      `listen(port, host)` helper — the factory's own defaults (ephemeral port
 *      + 127.0.0.1 loopback, which the tests rely on) are LEFT UNCHANGED. The
 *      env-driven 0.0.0.0/PORT binding lives HERE, in the entry point, by
 *      passing a resolved host/port into listen().
 *
 * Reachability: a container needs the server bound to a routable interface, not
 * loopback, so `resolveBindConfig` defaults HOST to 0.0.0.0 and reads PORT
 * (default 8080) and HOST from the environment. The bound address is logged on
 * startup so a deploy log shows where it is listening.
 *
 * Everything here reads from an INJECTED env / logger / server-factory so the
 * wiring is unit-testable without binding a public interface or hitting the
 * network. Uses Node stdlib only (process.env via the injected env); adds no
 * runtime dependency.
 */

import { createBuilderServer } from './builder-server.js';
import { createAuthService } from '../auth/index.js';
import { resolveIdpVerifier, createFailClosedIdpVerifier } from '../auth/oidc-verifier.js';
import { resolveLoginFlow } from '../auth/login-flow.js';
import { composePlatformOps } from '../ops/index.js';
import {
  createAnthropicProvider,
  createGeminiProvider,
  createOpenRouterProvider,
} from '../engine/plumby.js';

/** The port a container host / uptime check can assume when PORT is unset. */
export const DEFAULT_PORT = 8080;

/**
 * The FAIL-CLOSED IdP verifier, re-exported from the auth subsystem where it now
 * lives beside the REAL verifiers it is the safe fallback for
 * (src/auth/oidc-verifier.js). Kept exported here because this entry point is
 * where "what happens when identity is unconfigured" is decided.
 */
export { createFailClosedIdpVerifier };

/**
 * The default bind host. 0.0.0.0 (all interfaces) so the server is reachable
 * from OUTSIDE a container — the loopback default of createBuilderServer.listen
 * is correct for hermetic tests but unreachable in a deployment.
 */
export const DEFAULT_HOST = '0.0.0.0';

/**
 * Resolve the { port, host } to bind from an environment map. PURE and
 * injectable so a test can prove PORT/HOST are threaded through without binding
 * a public interface. An out-of-range or non-numeric PORT falls back to the
 * default rather than binding an unexpected port.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {{ port: number, host: string }}
 */
export function resolveBindConfig(env = process.env) {
  const rawPort = env.PORT;
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    const parsed = Number(rawPort);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      port = parsed;
    }
  }

  const host = env.HOST && env.HOST.trim() !== '' ? env.HOST.trim() : DEFAULT_HOST;

  return { port, host };
}

/**
 * Build the LIVE plumby provider selected by PLUMBY_PROVIDER (anthropic |
 * gemini | openrouter; default anthropic), through the engine boundary. Each
 * factory reads its API key from the environment lazily, so construction is
 * offline and never throws for a missing key — the key is only needed when a
 * turn runs.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 */
export function resolveProvider(env = process.env) {
  const kind = (env.PLUMBY_PROVIDER ?? 'anthropic').toLowerCase();
  switch (kind) {
    case 'gemini':
      return createGeminiProvider();
    case 'openrouter':
      return createOpenRouterProvider();
    case 'anthropic':
    default:
      return createAnthropicProvider();
  }
}

/**
 * Compose the platform and start listening on the env-resolved host/port.
 *
 * The server factory and env/logger are injected (defaulting to the real ones)
 * so a test drives the SAME code path against a real bound server on a safe
 * loopback host, and can assert the resolved host/port are threaded into
 * listen() — a mutation that ignores PORT/HOST flips that assertion.
 *
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env=process.env]
 * @param {(opts:object)=>object} [deps.createServer=createBuilderServer]
 * @param {object} [deps.idpVerifier]  override the env-resolved IdP verifier
 *        (tests inject a fake); omitted ⇒ resolveIdpVerifier(env), which is
 *        FAIL-CLOSED unless OIDC_* is fully configured.
 * @param {object} [deps.loginFlow]  override the env-resolved login flow;
 *        omitted ⇒ resolveLoginFlow(env), which is null unless OIDC_* is fully
 *        configured (so /auth/* stays unrouted).
 * @param {{ log: Function }} [deps.logger=console]
 * @returns {Promise<{ api: object, address: {port:number, host:string} }>}
 */
export async function startPlatformServer({
  env = process.env,
  createServer = createBuilderServer,
  idpVerifier,
  loginFlow,
  logger = console,
} = {}) {
  const { port, host } = resolveBindConfig(env);

  // The composition root wires ONE redactor + audit log + observability.
  const composed = composePlatformOps();

  // IDENTITY. Auth gates every non-health request, so this decides whether the
  // deployment is usable at all. A real, env-driven OIDC/OAuth verifier is built
  // from OIDC_* when it is FULLY configured; anything else (unset, unknown
  // provider, or missing credentials) yields the fail-closed verifier that
  // DENIES every attempt. The resolution is logged either way so a deploy log
  // says plainly whether login is open for business and, if not, what is missing.
  const resolvedIdp = idpVerifier
    ? { verifier: idpVerifier, configured: true, provider: null, missing: [], reason: 'injected verifier' }
    : resolveIdpVerifier(env);
  if (!resolvedIdp.configured) {
    logger.log(`ai-app-builder identity: LOGIN DISABLED — ${resolvedIdp.reason}`);
  } else if (resolvedIdp.provider) {
    logger.log(`ai-app-builder identity: ${resolvedIdp.provider} login enabled`);
  }

  const authService = createAuthService({
    idpVerifier: resolvedIdp.verifier,
    auditSink: composed.auditLog,
  });

  // LOGIN SURFACE. Without a flow, nothing on the wire can mint a session token
  // (authenticate/scopeSession are in-process only), so a configured deploy gets
  // GET /auth/login + /auth/callback. Unconfigured ⇒ null ⇒ those paths are not
  // routed at all, rather than advertising a login that cannot succeed.
  //
  // GATED ON THE VERIFIER's verdict, not re-derived from env: the two resolvers
  // would otherwise reach independent conclusions, and a deploy could route
  // /auth/* while the verifier had failed closed — logging both "LOGIN DISABLED"
  // and a callback URL, then failing every exchange. Routing a login surface now
  // IMPLIES a usable verifier.
  const flow = loginFlow ?? (resolvedIdp.configured ? resolveLoginFlow(env, { authService }) : null);
  if (flow) {
    logger.log(`ai-app-builder login callback expects redirect_uri ${flow.redirectUri}`);
  }

  const provider = resolveProvider(env);

  const api = createServer({
    authService,
    ...(flow ? { loginFlow: flow } : {}),
    provider,
    observability: composed.observability,
  });

  const address = await api.listen(port, host);
  logger.log(`ai-app-builder listening on http://${address.host}:${address.port}`);

  return { api, address };
}

/**
 * True when this module is the process entry point (invoked as `node
 * src/server/start.js` or via `npm start`), so importing it in a test does NOT
 * start a server.
 */
function isMain() {
  return (
    Array.isArray(process.argv) &&
    typeof process.argv[1] === 'string' &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href
  );
}

if (isMain()) {
  startPlatformServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`failed to start ai-app-builder: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
