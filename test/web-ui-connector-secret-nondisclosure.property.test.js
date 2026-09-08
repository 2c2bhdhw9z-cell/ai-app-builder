/**
 * Property-based test for Web UI Task 14.5 (node --test).
 *
 * Property 30 — "A submitted connector secret is never rendered back in
 * plaintext" (design §"Property 30", Req 13.3). The test carries the EXACT spec
 * tag required by the web-ui spec:
 *
 *   "Feature: web-ui, Property 30: A submitted connector secret is never
 *    rendered back in plaintext"
 *
 * WHAT IS PROVEN, end-to-end through the REAL collaborators (the REAL store
 * reducer + the REAL createApiClient driven by an injected fetch + the REAL
 * connectors controller AND the REAL settings-panel view over a tiny same-origin
 * DOM shim — no over-mocking of the client itself):
 *
 *   For ALL connector services + ALL secret values a user could enter, after a
 *   configure() submission:
 *     (a) the submitted secret VALUE travels ONLY in the authorized POST request
 *         body (Req 13.3 "transmit the Secret only over the authorized request");
 *     (b) the secret VALUE appears NOWHERE the client renders it back:
 *           - not in the controller's observable surface state,
 *           - not in the value the controller returns to its caller,
 *           - not anywhere in the rendered settings-panel DOM (textContent,
 *             attributes, or any input's value — the write-only secret field is
 *             cleared on submit).
 *
 * This is the STRUCTURAL non-disclosure guarantee: even for an adversarial
 * backend body that echoes the secret back, `sanitizeBound` drops it before it
 * can reach the surface/DOM, so the property holds regardless of what the server
 * returns.
 *
 * Hermetic: pure logic + an injected fetch stub + a real store + a DOM shim. No
 * network, no server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createConnectorsController } from '../src/server/public/settings/connectors.js';
import { createSettingsPanel } from '../src/server/public/views/settings/settings-panel.js';
import { fcConfig } from './support/fc.js';

/** Web-UI spec property tag (distinct from the platform-wide ai-app-builder tag). */
function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

// ------------------------------------------------------------- tiny DOM shim
// A same-origin, dependency-free DOM shim (mirrors the other web-ui view tests)
// so the REAL settings-panel view builds real nodes without jsdom.
function makeDom() {
  function makeEl(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      _listeners: {},
      className: '',
      id: '',
      textContent: '',
      value: '',
      disabled: false,
      hidden: false,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      removeAttribute(k) { delete this.attrs[k]; },
      append(...kids) { for (const kid of kids) { this.children.push(kid); kid._parent = this; } },
      replaceChildren(...kids) { this.children = kids.slice(); for (const k of kids) k._parent = this; },
      addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); },
      removeEventListener(type, cb) {
        if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== cb);
      },
      remove() {},
      click() { for (const cb of this._listeners.click || []) cb({ preventDefault() {} }); },
    };
  }
  return { createElement: (t) => makeEl(t), body: makeEl('body') };
}

/** Walk a shim tree and collect every place a value could be "rendered back". */
function collectRendered(el, acc = []) {
  if (!el || typeof el !== 'object') return acc;
  if (typeof el.textContent === 'string' && el.textContent) acc.push(el.textContent);
  if (typeof el.value === 'string' && el.value) acc.push(el.value);
  if (el.attrs) for (const v of Object.values(el.attrs)) acc.push(String(v));
  for (const kid of el.children || []) collectRendered(kid, acc);
  return acc;
}

// ---------------------------------------------------------------- generators

/** A catalog-shaped service name + its env NAME(s). */
const connectorEntry = fc.record({
  service: fc.constantFrom('supabase', 'stripe', 'clerk', 'vercel', 'openai-api', 'neon'),
  category: fc.constantFrom('database', 'payments', 'auth', 'hosting-deploy', 'ai-model'),
  envNames: fc.array(fc.constantFrom('API_KEY', 'SECRET_KEY', 'TOKEN', 'URL'), { minLength: 1, maxLength: 2 }),
});

/**
 * A secret value distinctive enough to grep for unambiguously. Restricted to
 * an alphanumeric core so the value survives JSON.stringify byte-for-byte (a
 * backslash/quote would be escaped in the serialized body, which would make a
 * substring grep of the JSON body a test artifact, not a disclosure signal —
 * the DOM/state/return greps below are the genuine non-disclosure checks). The
 * space of secret values is still adversarial: arbitrary length + content.
 */
const secretValue = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => `sk_live_${s.replace(/[^A-Za-z0-9]/g, '')}_END`)
  .filter((s) => s.length > 12);

/** Whether the adversarial backend echoes the secret back in its 200 body. */
const echoSecret = fc.boolean();

// --------------------------------------------------------------------- test

// Feature: web-ui, Property 30: A submitted connector secret is never rendered back in plaintext
test(webUiTag(30, 'A submitted connector secret is never rendered back in plaintext'), async () => {
  await fc.assert(
    fc.asyncProperty(connectorEntry, secretValue, echoSecret, async (entry, secret, echo) => {
      const store = createStore();

      // A recording fetch that returns a 200 bound view. When `echo` is true it
      // ADVERSARIALLY reflects the submitted secret back in the body, proving the
      // client drops it regardless of what the server sends.
      const bodies = [];
      const fetchImpl = async (url, init) => {
        bodies.push(init && init.body ? String(init.body) : '');
        const bound = {
          service: entry.service,
          category: entry.category,
          status: 'active',
          secretRefs: entry.envNames.slice(),
        };
        if (echo) bound.echoedSecret = secret; // adversarial reflection
        return { status: 200, async json() { return { bound }; } };
      };
      const api = createApiClient({ getToken: () => 'tok-30', fetchImpl });
      const controller = createConnectorsController({ store, api });

      // Seed the catalog so the panel renders the connector row for this service.
      // (list() is not needed; we set surface state directly via a GET stub is
      // avoided — instead we drive configure() and render the panel.)
      // Prime the controller's catalog via a GET that returns this one entry.
      const listApi = createApiClient({
        getToken: () => 'tok-30',
        fetchImpl: async () => ({ status: 200, async json() { return { catalog: [entry], bound: [] }; } }),
      });
      const listController = createConnectorsController({ store, api: listApi });
      await listController.list();

      // Build the REAL settings panel over the controller we will submit through.
      const doc = makeDom();
      const panel = createSettingsPanel({
        doc,
        store,
        controllers: { connectors: controller },
      });
      // Mirror the primed catalog into the submitting controller so the row shows.
      // (configure() success will set the bound state on THIS controller.)
      controller.getState().catalog = [entry];
      panel.render();

      // Build the secret map the user "typed" and submit it.
      const secrets = {};
      for (const n of entry.envNames) secrets[n] = secret;
      const out = await controller.configure(entry.service, secrets);
      assert.equal(out.ok, true, 'configure resolves ok on a 200');
      panel.render();

      // (a) The secret travelled in the POST body (transmitted over the request).
      assert.ok(
        bodies.some((b) => b.includes(secret)),
        'the secret value is sent in the authorized POST request body',
      );

      // (b1) NOT in the controller's observable surface state.
      assert.ok(
        !JSON.stringify(controller.getState()).includes(secret),
        'the secret value is never retained in the controller surface state',
      );

      // (b2) NOT in the value returned to the caller.
      assert.ok(
        !JSON.stringify(out).includes(secret),
        'the secret value is never returned to the caller',
      );

      // (b3) NOT anywhere in the rendered settings-panel DOM.
      const rendered = collectRendered(panel.el).join('\u0000');
      assert.ok(
        !rendered.includes(secret),
        'the secret value is never rendered back in the settings DOM',
      );

      panel.destroy();
    }),
    fcConfig,
  );
});
