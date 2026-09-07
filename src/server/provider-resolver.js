/**
 * provider-resolver.js — the ProviderResolver (spec Task 25.1, Req 21.1-21.6).
 *
 * This selects the BUILDER'S OWN model provider and model — the thing that runs
 * the Builder_Agent for a Session. It is a thin composing layer over plumby's
 * CANONICAL resolution seams (PROVIDERS / describeProviders / keyNameFor),
 * reached ONLY through the engine boundary (src/engine/plumby.js) so the
 * three-repo separation is preserved and the supported-provider set + env order
 * always match plumby instead of being duplicated here.
 *
 * DISTINCTNESS (Req 21.1, mirrors the note in connector-service.js): this is
 * NOT the src/connectors `ai-model` Connector. That Connector is a service the
 * GENERATED APP calls (capture -> Secret -> binding -> steering). The
 * ProviderResolver picks which provider/model the PLATFORM uses to drive the
 * Builder_Agent. They are deliberately separate concerns: this module imports
 * NOTHING from src/connectors and never touches the connector subsystem.
 *
 * start.js DECISION: src/server/start.js keeps its existing resolveProvider(env)
 * (PLUMBY_PROVIDER -> a live factory, default anthropic) UNCHANGED. That is the
 * lowest-risk option and test/server-start.test.js continues to assert it. This
 * resolver is the fuller, Session-aware layer that adds explicit provider/model
 * selection, env-order default resolution, and no-credential reporting on top of
 * plumby's seams. It does not replace start.js's boot wiring.
 *
 * MODEL VALIDATION (Req 21.4): providers expose NO static SUPPORTED_MODELS list;
 * model support is a network provider.listModels() catalogue fetch, which is not
 * available offline. Model validation therefore goes through an INJECTABLE
 * `validateModel({ provider, model }) -> boolean` seam supplied by the caller
 * (tests inject a fake catalogue). When no seam is provided, an explicit model
 * is accepted (we cannot prove it wrong offline) and the provider's own
 * defaultModel is always a safe accept.
 *
 * CONTRACT: a factory createProviderResolver({...deps}) returning
 * Object.freeze({...}); structured { ok, code?, message? } results; NEVER throws
 * on a handled failure (it REPORTS it); and NO-STATE-CHANGE-ON-FAILURE — a
 * rejected select() (21.3/21.4) and a no-credential resolve() (21.6) both leave
 * the Session's provider/model exactly as they were, so no turn config is ever
 * corrupted. A non-ok resolve() is the signal that NO turn may start. Adds no
 * dependency; imports no plumby package directly (the boundary invariant).
 */

import {
  PROVIDERS as REAL_PROVIDERS,
  describeProviders as realDescribeProviders,
  keyNameFor,
} from '../engine/plumby.js';

/**
 * Create the ProviderResolver.
 *
 * @param {object} [deps]
 * @param {Record<string,string|undefined>} [deps.env=process.env]  the environment
 *        whose API keys decide which providers are available.
 * @param {(opts:{env:object})=>object} [deps.describeProviders]  plumby's seam,
 *        defaulted to the REAL one through the boundary (tests may inject a fake).
 * @param {object} [deps.providers]  plumby's PROVIDERS map (source of the
 *        supported-provider set and the env-resolution order); defaulted to the
 *        REAL one through the boundary.
 * @param {(args:{provider:string,model:string})=>boolean} [deps.validateModel]
 *        the INJECTABLE model-validation seam (Req 21.4). Optional.
 * @param {() => number} [deps.now=Date.now]  injectable ms clock.
 * @returns {object} a frozen ProviderResolver
 */
export function createProviderResolver({
  env = process.env,
  describeProviders = realDescribeProviders,
  providers = REAL_PROVIDERS,
  validateModel,
  now = () => Date.now(),
} = {}) {
  if (typeof describeProviders !== 'function') {
    throw new TypeError('ProviderResolver: describeProviders must be a function');
  }
  if (!providers || typeof providers !== 'object') {
    throw new TypeError('ProviderResolver: providers must be the plumby PROVIDERS map');
  }
  if (validateModel !== undefined && typeof validateModel !== 'function') {
    throw new TypeError('ProviderResolver: validateModel, when supplied, must be a function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('ProviderResolver: now must be a function returning milliseconds');
  }

  // The supported provider names, in plumby's insertion order. Derived from
  // PROVIDERS so it always matches plumby (Req 21.1) and never hardcoded.
  const supported = Object.keys(providers);

  // Session-scoped selection. Starts UNSELECTED so resolve() falls back to the
  // env-order default until select() is called (Req 21.5).
  const session = { provider: null, model: null };

  /** Immutable snapshot of the current selection (Req 21.2). */
  function snapshot() {
    return Object.freeze({ provider: session.provider, model: session.model });
  }

  /**
   * select — choose the builder's provider (and optionally model) for every
   * turn started AFTER this call, until changed (Req 21.1, 21.2). Rejects an
   * unsupported provider (Req 21.3) or an unsupported model (Req 21.4) WITHOUT
   * mutating any Session state.
   *
   * @param {object} params
   * @param {string} params.provider  one of PROVIDERS keys (anthropic|gemini|openrouter)
   * @param {string} [params.model]   optional model id; defaults to the provider's defaultModel
   * @returns {object} a frozen structured result
   */
  function select(params = {}) {
    const { provider, model } = params;

    // Req 21.3 — unsupported provider: reject, NAME it, Session UNCHANGED.
    if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(providers, provider)) {
      const named = typeof provider === 'string' ? JSON.stringify(provider) : String(provider);
      return Object.freeze({
        ok: false,
        code: 'UNSUPPORTED_PROVIDER',
        message: `unsupported provider ${named}; supported providers are ${supported.join(', ')}; selection unchanged`,
      });
    }

    const cfg = providers[provider];
    const resolvedModel =
      typeof model === 'string' && model.trim() !== '' ? model.trim() : cfg.defaultModel;

    // Req 21.4 — unsupported model: validate through the injectable seam. When
    // no seam is provided we cannot prove an explicit model wrong offline, so we
    // accept it (the defaultModel is always a safe accept). If the seam rejects,
    // leave BOTH provider AND model UNCHANGED (Req 21.4 requires provider
    // unchanged too).
    if (typeof validateModel === 'function' && validateModel({ provider, model: resolvedModel }) !== true) {
      return Object.freeze({
        ok: false,
        code: 'UNSUPPORTED_MODEL',
        message: `model ${JSON.stringify(resolvedModel)} is not supported by provider ${JSON.stringify(provider)}; selection unchanged`,
      });
    }

    // SUCCESS — atomically set provider AND model.
    session.provider = provider;
    session.model = resolvedModel;
    return Object.freeze({ ok: true, provider, model: resolvedModel, at: now() });
  }

  /**
   * resolve — the value a turn should use (Req 21.2, 21.5, 21.6).
   *
   *   - With an explicit selection: return it (origin 'selection').
   *   - With no selection: pick the FIRST provider in plumby's env order whose
   *     describeProviders entry is available (Req 21.5), using that entry's
   *     model. The order is derived from PROVIDERS, never hardcoded.
   *   - With no available provider: report the missing credential naming a
   *     provider and its env var, mutate NOTHING, and signal that no turn may
   *     start via ok:false (Req 21.6).
   *
   * @returns {object} a frozen structured result
   */
  function resolve() {
    if (session.provider !== null) {
      return Object.freeze({
        ok: true,
        provider: session.provider,
        model: session.model,
        origin: 'selection',
      });
    }

    const described = describeProviders({ env });

    // First provider in plumby's insertion order with an available credential.
    for (const name of supported) {
      const entry = described?.[name];
      if (entry && entry.available === true) {
        const model =
          typeof entry.model === 'string' && entry.model.trim() !== ''
            ? entry.model
            : providers[name].defaultModel;
        return Object.freeze({
          ok: true,
          provider: name,
          model,
          origin: 'env-order',
        });
      }
    }

    // Req 21.6 — no credential anywhere: name a provider and its env var, reuse
    // plumby's own `reason` string, and DO NOT start a turn (ok:false gates it).
    const first = supported[0];
    const reason = described?.[first]?.reason ?? `${keyNameFor(first)} is not set in this server's environment`;
    return Object.freeze({
      ok: false,
      code: 'NO_CREDENTIAL',
      provider: first,
      message: `no provider has an available credential; ${reason}; no turn started`,
    });
  }

  /**
   * current / getSelection — the current Session selection snapshot (Req 21.2).
   * Returns { provider:null, model:null } until a successful select(). A rejected
   * select() and a no-credential resolve() both leave this unchanged.
   *
   * @returns {{ provider: string|null, model: string|null }}
   */
  function current() {
    return snapshot();
  }

  return Object.freeze({
    select,
    resolve,
    current,
    getSelection: current,
    supportedProviders: Object.freeze([...supported]),
  });
}
