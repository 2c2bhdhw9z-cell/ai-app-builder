/*
 * settings/connectors.js — the connectors settings controller (spec Task 14.2;
 * design §"Controllers — settings/*.js", Req 13.1–13.4).
 *
 * This is the feature logic behind the connectors screen. It:
 *   - list()   → GET the Connector_Catalog entries grouped by Connector_Category
 *                plus each connector's bound state (Req 13.1, 13.4).
 *   - configure(service, secrets) → POST the connector configuration with the
 *                Bearer (Req 13.2). The Secret value is transmitted ONLY over
 *                this authorized request and is NEVER retained in the surface
 *                state and NEVER returned to the caller (Req 13.3, design
 *                Property 30). After submission the surface shows the bound
 *                state only — never the plaintext secret.
 *
 * ─── THE SECRET NON-DISCLOSURE INVARIANT (Req 13.3 / Property 30) ──────────
 * The whole point of this controller is that a submitted secret value cannot be
 * read back. It is enforced STRUCTURALLY, not by scanning:
 *   1. The secret map handed to configure() is JSON-serialized straight into
 *      the request body and then goes out of scope — it is never copied into
 *      `surface` state, never stashed on the returned result, and never logged.
 *   2. The success/refresh path reads back ONLY the backend's bound-state view
 *      (service, category, status, and the env-var NAMEs — reference-by-NAME,
 *      the exact posture the backend's ConnectorService/steering writer use),
 *      which by contract carries NO secret VALUES.
 *   3. `sanitizeBound()` copies through only that safe, name-only shape, so even
 *      if a backend body ever echoed a value it would be dropped here before it
 *      reached the surface state the view renders.
 *
 * ─── ASSUMED CONTRACT (honest note) ───────────────────────────────────────
 * The Builder_Server exposes NO connectors HTTP route today — connector
 * management lives in the backend ConnectorService (src/connectors/) with a
 * capture seam, SecretStore, and ConnectorBindingStore, none of it HTTP-surfaced.
 * Per the spec, this controller is written against a DOCUMENTED/ASSUMED contract
 * that mirrors those real service shapes, and does NOT add or modify any backend
 * route:
 *
 *   GET  /settings/connectors                         (Bearer gated)
 *     200 → { catalog: [{ service, category, captureKind, envNames:[...] }...],
 *             bound:   [{ service, category, status, secretRefs:[NAME...] }...] }
 *   POST /settings/connectors  body { service, secrets: { NAME: value } }  (Bearer gated)
 *     200 → { bound: { service, category, status, secretRefs:[NAME...] } }
 *     400 → { error, code? }                            (unknown/capture failed)
 *     401 → (non-disclosing denial; body discarded by api.js)
 *
 * The catalog + bound shapes mirror src/connectors/catalog.js (service /
 * category / captureKind / envNames) and the ConnectorBinding (service / status
 * 'active'|'removed' / secretRefs = NAMES only). No secret value ever appears in
 * a GET body by contract.
 *
 * DOM-free and dependency-free: `store` + gated `api` are INJECTED so the whole
 * controller runs under `node --test` with the REAL store + REAL api client.
 */

import { ACTIONS } from '../store.js';
import { RESULT } from '../api.js';
import { createSettingsState } from './settings-state.js';

/** Client-authored, non-disclosing notice text. */
export const CONNECTOR_MESSAGES = Object.freeze({
  REAUTH: 'Your session expired. Please sign in again.',
  UNSUPPORTED: 'That connector could not be configured.',
  RATE_LIMITED: 'A usage limit was reached.',
  ERROR: 'The connector could not be configured.',
  BOUND: 'Connector configured.',
});

/**
 * Copy through ONLY the safe, name-only bound-state fields (Req 13.3). Any
 * secret VALUE a body might carry is dropped here — the surface only ever holds
 * service/category/status + the env-var NAMEs (secretRefs), never a value.
 * @param {any} b
 * @returns {{ service: string, category: string|null, status: string, secretRefs: string[] }|null}
 */
export function sanitizeBound(b) {
  if (!b || typeof b !== 'object') return null;
  const service = typeof b.service === 'string' ? b.service : null;
  if (!service) return null;
  const secretRefs = Array.isArray(b.secretRefs)
    ? b.secretRefs.filter((n) => typeof n === 'string')
    : [];
  return {
    service,
    category: typeof b.category === 'string' ? b.category : null,
    status: typeof b.status === 'string' ? b.status : 'active',
    secretRefs,
  };
}

/**
 * Group flat catalog entries by Connector_Category for the grouped display
 * (Req 13.1). Pure and exported so the view + tests share one grouping rule.
 * @param {Array<{ service: string, category: string }>} catalog
 * @returns {Array<{ category: string, entries: object[] }>}
 */
export function groupByCategory(catalog) {
  const list = Array.isArray(catalog) ? catalog : [];
  const order = [];
  const byCat = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof entry.category !== 'string') continue;
    if (!byCat.has(entry.category)) {
      byCat.set(entry.category, []);
      order.push(entry.category);
    }
    byCat.get(entry.category).push(entry);
  }
  return order.map((category) => ({ category, entries: byCat.get(category) }));
}

/**
 * Create the connectors controller.
 *
 * @param {object} deps
 * @param {{ getState: Function, dispatch: Function }} deps.store  the REAL store
 * @param {{ request: Function }} deps.api                          the REAL api client
 * @returns {{
 *   getState: () => object,
 *   subscribe: (cb: Function) => (() => void),
 *   groups: () => Array<{ category: string, entries: object[] }>,
 *   list: () => Promise<{ ok: boolean, result?: object }>,
 *   configure: (service: string, secrets: object) => Promise<{ ok: boolean, reason?: string, result?: object }>,
 * }}
 */
export function createConnectorsController({ store, api } = {}) {
  if (!store || typeof store.dispatch !== 'function' || typeof store.getState !== 'function') {
    throw new TypeError('createConnectorsController requires a store with getState/dispatch');
  }
  if (!api || typeof api.request !== 'function') {
    throw new TypeError('createConnectorsController requires an api client with request()');
  }

  // Surface state holds ONLY name-only data — never a secret value (Req 13.3).
  const surface = createSettingsState({
    catalog: [], // [{ service, category, captureKind, envNames:[...] }]
    bound: {}, // service -> { service, category, status, secretRefs:[NAME...] }
    inFlight: false,
  });

  /** Merge a sanitized bound record into the surface's bound map by service. */
  function upsertBound(rec) {
    const safe = sanitizeBound(rec);
    if (!safe) return;
    const bound = { ...surface.getState().bound, [safe.service]: safe };
    surface.set({ bound });
  }

  /**
   * List the catalog (grouped by the view) + current bound state (Req 13.1, 13.4).
   * @returns {Promise<{ ok: boolean, result?: object }>}
   */
  async function list() {
    const result = await api.request('GET', '/settings/connectors');
    if (result.kind === RESULT.OK && result.data && typeof result.data === 'object') {
      const catalog = Array.isArray(result.data.catalog) ? result.data.catalog : [];
      const boundArr = Array.isArray(result.data.bound) ? result.data.bound : [];
      const bound = {};
      for (const b of boundArr) {
        const safe = sanitizeBound(b);
        if (safe) bound[safe.service] = safe;
      }
      surface.set({ catalog, bound });
      return { ok: true, result };
    }
    if (result.kind === RESULT.DENIED) {
      store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: CONNECTOR_MESSAGES.REAUTH });
    }
    return { ok: false, result };
  }

  /**
   * Configure a connector (Req 13.2, 13.3, 13.4). The `secrets` map is sent over
   * the authorized POST and then goes out of scope — it is NEVER retained in
   * surface state nor returned. On success the surface records only the safe,
   * name-only bound state (Req 13.4). The RETURNED result deliberately omits the
   * secret and the raw backend `data` beyond the sanitized bound view, so a
   * caller cannot read the value back either (Req 13.3 / Property 30).
   *
   * @param {string} service           a catalog service name
   * @param {Record<string,string>} secrets  { NAME: value } captured from the user
   * @returns {Promise<{ ok: boolean, reason?: string, result?: object }>}
   */
  async function configure(service, secrets) {
    surface.set({ inFlight: true });
    // The secret map is serialized into the body here and not held anywhere.
    const result = await api.request('POST', '/settings/connectors', {
      body: { service, secrets: secrets && typeof secrets === 'object' ? secrets : {} },
    });

    switch (result.kind) {
      case RESULT.OK: {
        // Read back ONLY the safe bound view — never a value (Req 13.3, 13.4).
        const bound = result.data && result.data.bound ? result.data.bound : { service };
        upsertBound(bound);
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_CLEARED });
        // The returned result carries the SANITIZED bound record only — no
        // secret, no raw body — so the plaintext value cannot be read back.
        return { ok: true, bound: sanitizeBound(bound), reason: undefined };
      }
      case RESULT.VALIDATION:
      case RESULT.PROTOCOL:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'validation', message: CONNECTOR_MESSAGES.UNSUPPORTED });
        return { ok: false, reason: 'validation' };
      case RESULT.RATE_LIMITED: {
        surface.set({ inFlight: false });
        const named = typeof result.limit === 'string' && result.limit ? result.limit : null;
        store.dispatch({
          type: ACTIONS.NOTICE_SET,
          kind: 'rateLimited',
          message: CONNECTOR_MESSAGES.RATE_LIMITED,
          limit: named,
        });
        return { ok: false, reason: 'rateLimited' };
      }
      case RESULT.DENIED:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'reauth', message: CONNECTOR_MESSAGES.REAUTH });
        return { ok: false, reason: 'denied' };
      default:
        surface.set({ inFlight: false });
        store.dispatch({ type: ACTIONS.NOTICE_SET, kind: 'error', message: CONNECTOR_MESSAGES.ERROR });
        return { ok: false, reason: 'error' };
    }
  }

  return {
    getState: surface.getState,
    subscribe: surface.subscribe,
    groups: () => groupByCategory(surface.getState().catalog),
    list,
    configure,
  };
}
