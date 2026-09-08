/*
 * settings/provider.js — the provider-selection settings controller (spec Task
 * 14.1; design §"Controllers — settings/*.js", Req 12.1–12.4).
 *
 * This is the feature logic behind the settings screen that lets a user choose
 * the builder's model provider. It turns a provider selection into a gated
 * submit and maps every transport outcome onto a next step:
 *
 *   - list()   → GET the available providers reported by the backend + the
 *                currently active provider (Req 12.1).
 *   - select() → POST the chosen provider with the Bearer (api.js attaches it),
 *                and on confirm display the now-active provider (Req 12.2, 12.3).
 *   - on error → display the error and LEAVE the previously active provider
 *                selected (Req 12.4) — the local surface state's `active` and
 *                `selected` are NOT advanced on a failed selection.
 *
 * ─── ASSUMED CONTRACT (honest note) ───────────────────────────────────────
 * The Builder_Server (src/server/builder-server.js) exposes NO provider-
 * selection HTTP route today — provider resolution lives behind the plumby
 * boundary (createAnthropicProvider / Gemini / OpenRouter) and is selected by
 * config, not an HTTP surface. Per the spec ("where a specific settings
 * endpoint's exact shape is not pinned, use the same api.js tagged-result
 * contract and non-disclosing error handling the other surfaces use"), this
 * controller is written against a DOCUMENTED/ASSUMED contract and does NOT add
 * or modify any backend route:
 *
 *   GET  /settings/provider                       (Bearer gated)
 *     200 → { providers: [{ id, label? }...], active: <id|null> }
 *   POST /settings/provider  body { provider }     (Bearer gated)
 *     200 → { active: <id> }                        (confirmed active provider)
 *     400 → { error, code? }                        (unsupported provider)
 *     429 → { error, limit, ... }                   (rate/quota)
 *     401 → (non-disclosing denial; body discarded by api.js)
 *
 * It uses the IDENTICAL api.js tagged-result contract and non-disclosing error
 * posture as every other surface, so the day a real route lands it needs only a
 * shape confirmation, not a rewrite.
 *
 * The controller owns its own small OBSERVABLE surface state (the provider list,
 * the active provider, the pending selection, and a submit-in-flight flag) so
 * the view can render/re-render without threading provider data through the
 * shared store. Cross-cutting, non-disclosing NOTICES (re-auth, error) still go
 * through the shared store's session.notice, exactly like the other controllers.
 *
 * DOM-free and dependency-free: `store` + gated `api` are INJECTED so the whole
 * controller runs under `node --test` with the REAL store reducer and the REAL
 * api client (driven by an injected fetch), never a stand-in double.
 */

import { ACTIONS } from '../store.js';
import { RESULT } from '../api.js';
import { createSettingsState } from './settings-state.js';

/** Client-authored, non-disclosing notice text. Exported so the view + tests
 *  reference the same strings. None carries a backend body field. */
export const PROVIDER_MESSAGES = Object.freeze({
  REAUTH: 'Your session expired. Please sign in again.',
  UNSUPPORTED: 'That provider is unavailable.',
  RATE_LIMITED: 'A usage limit was reached.',
  ERROR: 'The provider could not be changed.',
});

/**
 * Create the provider-selection controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function }} deps.store  the REAL store
 * @param {{ request: Function }} deps.api                          the REAL api client
 * @returns {{
 *   getState: () => object,
 *   subscribe: (cb: Function) => (() => void),
 *   list: () => Promise<{ ok: boolean, result?: object }>,
 *   select: (provider: string) => Promise<{ ok: boolean, reason?: string, active?: string, result?: object }>,
 * }}
 */
export function createProviderController({ store, api } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createProviderController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createProviderController requires an api client with request()');
  }

  // The controller's own observable surface state (Req 12.1/12.3/12.4).
  const surface = createSettingsState({
    providers: [], // [{ id, label? }]
    active: null, // the currently active provider id (Req 12.3)
    selected: null, // the user's pending selection (mirrors `active` after confirm)
    inFlight: false,
  });

  /**
   * Read the available providers + the active provider (Req 12.1). A denied/
   * failed read leaves the surface list empty and sets a generic notice for a
   * denial (so the login gate can react) but never discloses anything.
   * @returns {Promise<{ ok: boolean, result?: object }>}
   */
  async function list() {
    const result = await api.request('GET', '/settings/provider');
    if (result.kind === RESULT.OK && result.data && typeof result.data === 'object') {
      const providers = Array.isArray(result.data.providers) ? result.data.providers : [];
      const active = typeof result.data.active === 'string' ? result.data.active : null;
      surface.set({ providers, active, selected: active });
      return { ok: true, result };
    }
    if (result.kind === RESULT.DENIED) {
      store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: PROVIDER_MESSAGES.REAUTH });
    }
    return { ok: false, result };
  }

  /**
   * Select/switch the model provider (Req 12.2). POSTs the chosen provider with
   * the Bearer; on confirm displays the now-active provider (Req 12.3); on any
   * error displays the error and LEAVES the previously active provider selected
   * (Req 12.4) — the surface `active`/`selected` are unchanged on failure.
   *
   * @param {string} provider  the chosen provider id
   * @returns {Promise<{ ok: boolean, reason?: string, active?: string, result?: object }>}
   */
  async function select(provider) {
    surface.set({ inFlight: true });
    const result = await api.request('POST', '/settings/provider', { body: { provider } });

    switch (result.kind) {
      case RESULT.OK: {
        // The backend confirms the active provider; prefer the confirmed value,
        // falling back to the requested one if the body omits it.
        const active =
          result.data && typeof result.data.active === 'string' ? result.data.active : provider;
        surface.set({ active, selected: active, inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        return { ok: true, active, result };
      }
      case RESULT.VALIDATION:
      case RESULT.PROTOCOL:
        // Req 12.4: display the error, leave the previously active selected.
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'validation', message: PROVIDER_MESSAGES.UNSUPPORTED });
        return { ok: false, reason: 'validation', result };
      case RESULT.RATE_LIMITED: {
        surface.set({ inFlight: false });
        const named = typeof result.limit === 'string' && result.limit ? result.limit : null;
        store.dispatch({
          type: ACTIONS.NOTICE_SET,
          kind: 'rateLimited',
          message: PROVIDER_MESSAGES.RATE_LIMITED,
          limit: named,
        });
        return { ok: false, reason: 'rateLimited', result };
      }
      case RESULT.DENIED:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: PROVIDER_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied', result };
      default:
        // Req 12.4: on error, leave the previously active provider selected.
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: PROVIDER_MESSAGES.ERROR });
        return { ok: false, reason: 'error', result };
    }
  }

  return {
    getState: surface.getState,
    subscribe: surface.subscribe,
    list,
    select,
  };
}
