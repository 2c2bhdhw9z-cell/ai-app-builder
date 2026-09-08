/**
 * Unit tests for Web UI Task 14.6 (node --test).
 *
 * Coverage (design §"Controllers — settings/*.js" / §"Views — settings",
 * Req 12.1, 12.3, 12.4, 13.1, 13.4, 14.1, 14.3, 15.3, 15.6) — exercising the
 * REAL controllers + the REAL settings-panel view over a same-origin DOM shim,
 * driven by a recording/scripted fetch through the REAL api client. No
 * over-mocking of the client.
 *
 *   - Req 12.1/12.3/12.4: provider — list renders the available providers +
 *     active one; a confirmed selection displays the now-active provider; a
 *     failed selection leaves the previously active provider selected.
 *   - Req 13.1/13.4: connectors — the catalog is listed grouped by category and
 *     a bound connector's bound state displays.
 *   - Req 14.1: skills — the stocked + user skills list renders; add submits with
 *     the Bearer.
 *   - Req 14.3: memory — the project/global entries + active Memory_Mode render;
 *     a mode change submits.
 *   - Req 15.3: export — invoking export requests the package and provides it as
 *     a download (the injected download seam fires with the package bytes).
 *   - Req 15.6: a 401 on any lifecycle op surfaces a re-auth prompt and discloses
 *     NO project-specific detail (the adversarial 401 body never appears).
 *
 * Every gated submit is asserted to carry the `Authorization: Bearer` header.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/server/public/store.js';
import { createApiClient } from '../src/server/public/api.js';
import { createProviderController, PROVIDER_MESSAGES } from '../src/server/public/settings/provider.js';
import { createConnectorsController, groupByCategory } from '../src/server/public/settings/connectors.js';
import { createSkillsController } from '../src/server/public/settings/skills.js';
import { createMemoryController, MEMORY_MODES } from '../src/server/public/settings/memory.js';
import { createLifecycleController, LIFECYCLE_MESSAGES } from '../src/server/public/settings/lifecycle.js';
import { createSettingsPanel, SETTINGS_DOM } from '../src/server/public/views/settings/settings-panel.js';

const BEARER = 'tok-14-6';

// ------------------------------------------------------------- tiny DOM shim
function makeDom() {
  function makeEl(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      options: [],
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
      append(...kids) {
        for (const kid of kids) {
          this.children.push(kid);
          if (this.tagName === 'SELECT' && kid.tagName === 'OPTION') this.options.push(kid);
          kid._parent = this;
        }
      },
      replaceChildren(...kids) {
        this.children = kids.slice();
        if (this.tagName === 'SELECT') this.options = kids.filter((k) => k.tagName === 'OPTION');
        for (const k of kids) k._parent = this;
      },
      addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); },
      removeEventListener(type, cb) {
        if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== cb);
      },
      remove() {},
      click() { for (const cb of (this._listeners.click || []).slice()) cb({ preventDefault() {} }); },
    };
  }
  return { createElement: (t) => makeEl(t), body: makeEl('body') };
}

/** Find the first descendant with a given id. */
function byId(el, id, acc = { hit: null }) {
  if (!el || acc.hit) return acc.hit;
  if (el.id === id) { acc.hit = el; return el; }
  for (const kid of el.children || []) byId(kid, id, acc);
  return acc.hit;
}

/** Collect all descendants' text into one string. */
function allText(el, acc = []) {
  if (!el) return acc;
  if (el.textContent) acc.push(el.textContent);
  for (const kid of el.children || []) allText(kid, acc);
  return acc;
}

/** A scripted fetch: `script(url, init)` returns { status, body }. */
function scriptedApi(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const { status, body } = script(url, init) || { status: 200, body: {} };
    return { status, async json() { return body; }, async blob() { return body; }, async text() { return String(body); } };
  };
  return { calls, api: createApiClient({ getToken: () => BEARER, fetchImpl }) };
}

// ==================================================================== PROVIDER

test('12.1/12.3 provider: list renders available providers + active; a confirmed selection shows the active provider', async () => {
  const store = createStore();
  const { calls, api } = scriptedApi((url, init) => {
    if (init && init.method === 'GET') return { status: 200, body: { providers: [{ id: 'anthropic' }, { id: 'gemini' }], active: 'anthropic' } };
    return { status: 200, body: { active: JSON.parse(init.body).provider } };
  });
  const provider = createProviderController({ store, api });
  await provider.list();

  const doc = makeDom();
  const panel = createSettingsPanel({ doc, store, controllers: { provider } });
  panel.render();

  const active = byId(panel.el, SETTINGS_DOM.providerActive);
  assert.match(active.textContent, /anthropic/, 'the active provider is displayed');
  const select = byId(panel.el, SETTINGS_DOM.providerSelect);
  assert.deepEqual(select.options.map((o) => o.value), ['anthropic', 'gemini'], 'available providers listed');

  // Select gemini and confirm — the active provider updates + Bearer sent.
  const out = await provider.select('gemini');
  assert.equal(out.ok, true);
  assert.equal(out.active, 'gemini');
  panel.render();
  assert.match(byId(panel.el, SETTINGS_DOM.providerActive).textContent, /gemini/, 'confirmed provider shown active');
  const post = calls.find((c) => c.init.method === 'POST');
  assert.equal(post.init.headers.authorization, `Bearer ${BEARER}`, 'selection carries the Bearer');
});

test('12.4 provider: a failed selection leaves the previously active provider selected + shows the error', async () => {
  const store = createStore();
  const { api } = scriptedApi((url, init) => {
    if (init && init.method === 'GET') return { status: 200, body: { providers: [{ id: 'anthropic' }, { id: 'gemini' }], active: 'anthropic' } };
    return { status: 400, body: { error: 'nope', code: 'unsupported_provider' } };
  });
  const provider = createProviderController({ store, api });
  await provider.list();
  const out = await provider.select('gemini');
  assert.equal(out.ok, false);
  // Req 12.4: previously active provider stays selected/active.
  assert.equal(provider.getState().active, 'anthropic', 'previously active provider stays active');
  assert.equal(provider.getState().selected, 'anthropic', 'previously active provider stays selected');
  // A non-disclosing notice is shown.
  assert.equal(store.getState().session.notice.message, PROVIDER_MESSAGES.UNSUPPORTED);
});

// ================================================================== CONNECTORS

test('13.1 connectors: the catalog is grouped by category (pure + rendered)', async () => {
  const catalog = [
    { service: 'supabase', category: 'database', envNames: ['SUPABASE_URL'] },
    { service: 'neon', category: 'database', envNames: ['NEON_DATABASE_URL'] },
    { service: 'stripe', category: 'payments', envNames: ['STRIPE_SECRET_KEY'] },
  ];
  const groups = groupByCategory(catalog);
  assert.deepEqual(groups.map((g) => g.category), ['database', 'payments']);
  assert.equal(groups[0].entries.length, 2);

  const store = createStore();
  const { api } = scriptedApi(() => ({ status: 200, body: { catalog, bound: [] } }));
  const connectors = createConnectorsController({ store, api });
  await connectors.list();
  const doc = makeDom();
  const panel = createSettingsPanel({ doc, store, controllers: { connectors } });
  panel.render();
  const text = allText(byId(panel.el, SETTINGS_DOM.connectorsSection)).join(' ');
  assert.match(text, /database/);
  assert.match(text, /payments/);
  assert.match(text, /supabase/);
});

test('13.4 connectors: a bound connector displays its bound state (name-only)', async () => {
  const store = createStore();
  const { api } = scriptedApi(() => ({
    status: 200,
    body: {
      catalog: [{ service: 'stripe', category: 'payments', envNames: ['STRIPE_SECRET_KEY'] }],
      bound: [{ service: 'stripe', category: 'payments', status: 'active', secretRefs: ['STRIPE_SECRET_KEY'] }],
    },
  }));
  const connectors = createConnectorsController({ store, api });
  await connectors.list();
  const doc = makeDom();
  const panel = createSettingsPanel({ doc, store, controllers: { connectors } });
  panel.render();
  const bound = byId(panel.el, `${SETTINGS_DOM.connectorBoundPrefix}stripe`);
  assert.equal(bound.getAttribute('data-bound'), 'true', 'bound connector marked bound');
  assert.match(bound.textContent, /STRIPE_SECRET_KEY/, 'bound state names the env NAME only');
});

// ====================================================================== SKILLS

test('14.1 skills: stocked + user skills list; add submits with the Bearer', async () => {
  const store = createStore();
  const { calls, api } = scriptedApi((url, init) => {
    if (init && init.method === 'GET') {
      return { status: 200, body: { stocked: [{ name: 'debugger', description: 'debug' }], user: [{ name: 'user/mine' }] } };
    }
    return { status: 200, body: { skill: { name: JSON.parse(init.body).name } } };
  });
  const skills = createSkillsController({ store, api });
  await skills.list();
  const doc = makeDom();
  const panel = createSettingsPanel({ doc, store, controllers: { skills } });
  panel.render();
  assert.match(allText(byId(panel.el, SETTINGS_DOM.skillsStocked)).join(' '), /debugger/);
  assert.match(allText(byId(panel.el, SETTINGS_DOM.skillsUser)).join(' '), /user\/mine/);

  const out = await skills.addSkill({ name: 'user/new', body: 'do a thing' });
  assert.equal(out.ok, true);
  const post = calls.find((c) => c.init.method === 'POST');
  assert.equal(post.init.headers.authorization, `Bearer ${BEARER}`, 'add carries the Bearer');
  assert.ok(skills.getState().user.some((s) => s.name === 'user/new'), 'added skill appears in the user list');
});

// ====================================================================== MEMORY

test('14.3 memory: project/global entries + active Memory_Mode render; a mode change submits with the Bearer', async () => {
  const store = createStore();
  const { calls, api } = scriptedApi((url, init) => {
    if (init && init.method === 'GET') {
      return { status: 200, body: { project: [{ id: 'p1', text: 'proj note' }], global: [{ id: 'g1', text: 'glob note' }], mode: 'manual' } };
    }
    return { status: 200, body: { mode: JSON.parse(init.body).mode } };
  });
  const memory = createMemoryController({ store, api });
  await memory.list();
  const doc = makeDom();
  const panel = createSettingsPanel({ doc, store, controllers: { memory } });
  panel.render();
  assert.equal(byId(panel.el, SETTINGS_DOM.memoryMode).value, 'manual', 'active Memory_Mode displayed');
  assert.match(allText(byId(panel.el, SETTINGS_DOM.memoryProject)).join(' '), /proj note/);
  assert.match(allText(byId(panel.el, SETTINGS_DOM.memoryGlobal)).join(' '), /glob note/);
  assert.deepEqual([...MEMORY_MODES], ['auto', 'manual', 'off']);

  const out = await memory.setMode('off');
  assert.equal(out.ok, true);
  assert.equal(memory.getState().mode, 'off');
  const post = calls.find((c) => c.init.method === 'POST');
  assert.equal(post.init.headers.authorization, `Bearer ${BEARER}`, 'mode change carries the Bearer');
  assert.equal(JSON.parse(post.init.body).op, 'mode');
});

// =================================================================== LIFECYCLE

test('15.3 export: invoking export requests the package and provides it as a download', async () => {
  const store = createStore();
  const pkgBytes = { fake: 'zip-bytes' };
  const { calls, api } = scriptedApi(() => ({ status: 200, body: pkgBytes }));
  let downloaded = null;
  const lifecycle = createLifecycleController({ store, api, download: (pkg) => { downloaded = pkg; } });
  const out = await lifecycle.export('proj-42', 'my-export.zip');
  assert.equal(out.ok, true);
  assert.ok(downloaded, 'the download seam fired (Req 15.3)');
  assert.equal(downloaded.blob, pkgBytes, 'the download carries the exported package bytes');
  assert.equal(downloaded.filename, 'my-export.zip');
  assert.equal(lifecycle.getState().exported, true);
  // The export request carried the Bearer.
  assert.equal(calls[0].init.headers.authorization, `Bearer ${BEARER}`, 'export carries the Bearer');
});

test('15.1 build/deploy: submit with the Bearer + display the outcome', async () => {
  const store = createStore();
  const { calls, api } = scriptedApi((url) => {
    if (url.includes('/settings/build')) return { status: 200, body: { outcome: 'succeeded', summary: 'built ok' } };
    return { status: 200, body: { outcome: 'deployed', url: '/live/app' } };
  });
  const lifecycle = createLifecycleController({ store, api, download: () => {} });
  const b = await lifecycle.build('p1');
  assert.equal(b.ok, true);
  assert.equal(lifecycle.getState().build.outcome, 'succeeded');
  const d = await lifecycle.deploy('p1');
  assert.equal(d.ok, true);
  assert.equal(lifecycle.getState().deploy.outcome, 'deployed');
  for (const c of calls) assert.equal(c.init.headers.authorization, `Bearer ${BEARER}`);
});

test('15.6 a 401 on a lifecycle op surfaces a re-auth prompt and discloses NO project detail', async () => {
  const store = createStore();
  // An ADVERSARIAL 401 body embedding a project id / path / existence hint.
  const adversarial = {
    error: 'access denied',
    projectId: 'secret-project-777',
    path: '/home/owner/projects/secret-project-777',
    exists: true,
  };
  const { api } = scriptedApi(() => ({ status: 401, body: adversarial }));
  const lifecycle = createLifecycleController({ store, api, download: () => {} });

  for (const op of ['build', 'deploy', 'audit', 'share']) {
    store.dispatch({ type: 'notice/cleared' });
    const out = await (op === 'build' || op === 'deploy' || op === 'share'
      ? lifecycle[op]('secret-project-777')
      : lifecycle.audit('secret-project-777'));
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'denied', `${op} maps a 401 to denied`);
    const notice = store.getState().session.notice;
    assert.equal(notice.kind, 'reauth', `${op} surfaces a re-auth notice`);
    assert.equal(notice.message, LIFECYCLE_MESSAGES.REAUTH);
    // No adversarial field value leaks into the notice.
    const serialized = JSON.stringify(notice);
    assert.ok(!serialized.includes('secret-project-777'), `${op}: no project id leaks`);
    assert.ok(!serialized.includes('/home/owner'), `${op}: no path leaks`);
  }

  // export (blob) 401 too.
  store.dispatch({ type: 'notice/cleared' });
  const eo = await lifecycle.export('secret-project-777');
  assert.equal(eo.ok, false);
  assert.equal(eo.reason, 'denied');
  assert.ok(!JSON.stringify(store.getState().session.notice).includes('secret-project-777'), 'export: no project id leaks');
});
