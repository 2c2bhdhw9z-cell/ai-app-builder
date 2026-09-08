/**
 * Builder Server SETTINGS surface tests (spec Task 14/15, Req 12-15).
 *
 * Exercises the REAL builder-server harness end-to-end (ephemeral port + node's
 * global fetch, the REAL gate/auth from createAuthService + a real minted
 * session token) with the REAL (or lightweight-real) backend service
 * collaborators injected — no mocks of the settings surfaces themselves. Every
 * route is driven exactly as the client controllers (src/server/public/
 * settings/*.js) drive it, and each success/denial/absence case is asserted:
 *
 *   - GET  /settings/provider      -> { providers, active }
 *   - POST /settings/provider      -> { active }  (400 on unsupported)
 *   - GET  /settings/connectors    -> { catalog, bound }
 *   - POST /settings/connectors    -> { bound }   (secret NEVER echoed)
 *   - GET  /settings/skills        -> { stocked, user }
 *   - POST /settings/skills        -> { skill }
 *   - GET  /settings/memory        -> { project, global, mode }
 *   - POST /settings/memory        -> { project, global, mode }
 *   - POST /settings/build         -> { outcome, ... }
 *   - POST /settings/deploy        -> { outcome, ... }
 *   - GET  /settings/export        -> a downloadable package (blob)
 *   - GET  /settings/lockin-audit  -> { findings, clean }
 *   - POST /settings/share         -> { url }
 *
 * Also proves: (a) a submitted connector secret is NOT present anywhere in the
 * response; (b) each route denies a missing/invalid token with the identical
 * non-disclosing 401 ACCESS_DENIED; (c) with the backing service NOT injected,
 * the route is not enabled (405). The agent's send() throws, so a settings POST
 * that ever enqueued a turn would fail — state.sends stays 0 throughout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService, createAuthorizer, createShareLinkStore, createShareLinkService } from '../src/auth/index.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createSecretStore } from '../src/secrets/secret-store.js';
import {
  createConnectorService,
  createConnectorBindingStore,
  createConnectorsSteeringWriter,
} from '../src/connectors/index.js';
import { createSkillLibrary } from '../src/skills/library.js';
import { createMemoryStore } from '../src/memory/store.js';
import { createProjectExport, createLockinAudit } from '../src/portability/index.js';
import { createProviderResolver } from '../src/server/provider-resolver.js';

// ---------------------------------------------------------------- test harness

const DENIED = { error: 'access denied' };

/** A fake IdP verifier: any idToken maps to a stable subject. */
function fakeIdp(subject = 'user-1') {
  return {
    async verifyIdToken(idToken) {
      if (!idToken) throw new Error('no token');
      return { provider: 'github', subject: `${subject}:${idToken}` };
    },
  };
}

/** Construct an AuthService and mint a real session token for one account. */
async function authWithToken(idToken = 'tok') {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { account } = await authService.authenticate({ idToken });
  const session = authService.scopeSession(account);
  return { authService, account, token: session.token };
}

/**
 * A fake agent whose send() RECORDS + THROWS — a settings POST must NEVER
 * enqueue a loop turn, so send() must never fire. `sends` stays 0.
 */
function noTurnAgentFactory(state) {
  return () => ({
    agent: {
      cwd: '/tmp/project',
      async send() {
        state.sends += 1;
        throw new Error('agent.send must never be called by a settings POST');
      },
    },
  });
}

/** Start a server on an ephemeral port; returns base URL + close(). */
async function startServer(opts) {
  const server = createBuilderServer(opts);
  const { port, host } = await server.listen(0, '127.0.0.1');
  return { server, base: `http://${host}:${port}`, close: () => server.close() };
}

/** A fresh fs.mkdtemp StorageLayout + cleanup. */
function mkLayout(prefix = 'aab-settings-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, layout: createStorageLayout(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** GET a JSON route with a Bearer token. */
async function getJson(base, route, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${base}${route}`, { headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text, res };
}

/** POST a JSON route with a Bearer token. */
async function postJson(base, route, token, payload) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(payload ?? {}) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text, res };
}

/** A REAL ProviderResolver over an injected fake plumby seam (no env dependency). */
function mkProviderResolver() {
  const providers = {
    anthropic: { defaultModel: 'claude-x' },
    gemini: { defaultModel: 'gemini-x' },
    openrouter: { defaultModel: 'or-x' },
  };
  const describeProviders = () => ({
    anthropic: { available: true, model: 'claude-x' },
    gemini: { available: false, reason: 'GEMINI_API_KEY is not set' },
    openrouter: { available: false, reason: 'OPENROUTER_API_KEY is not set' },
  });
  return createProviderResolver({ env: {}, providers, describeProviders });
}

/** A REAL ConnectorService + its binding store over one layout. */
function mkConnectors(layout, ownerId) {
  const secretStore = createSecretStore({ layout, ownerId });
  const bindingStore = createConnectorBindingStore({ layout, ownerId });
  const steeringWriter = createConnectorsSteeringWriter({ layout });
  // The capture seam is supplied PER-CALL by the route from the POST body; the
  // service-level default is never used here but must be a function.
  const connectorService = createConnectorService({
    secretStore,
    bindingStore,
    steeringWriter,
    capture: () => ({ ok: false, reason: 'failed' }),
  });
  return { connectorService, connectorBindingStore: bindingStore, secretStore };
}

// ----------------------------------------------------------- provider (Req 12)

test('GET/POST /settings/provider: lists providers + active, selects a provider, rejects an unsupported one', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    providerResolver: mkProviderResolver(),
  });
  try {
    // GET: the supported providers + the env-order default active provider.
    const list = await getJson(base, '/settings/provider', token);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.providers, ['anthropic', 'gemini', 'openrouter']);
    assert.equal(list.body.active, 'anthropic');

    // POST a supported provider -> { active } confirmed.
    const sel = await postJson(base, '/settings/provider', token, { provider: 'openrouter' });
    assert.equal(sel.status, 200);
    assert.equal(sel.body.active, 'openrouter');
    // GET now reflects the selection.
    const after = await getJson(base, '/settings/provider', token);
    assert.equal(after.body.active, 'openrouter');

    // POST an unsupported provider -> 400, prior active left in effect.
    const bad = await postJson(base, '/settings/provider', token, { provider: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'UNSUPPORTED_PROVIDER');
    assert.equal(bad.body.active, 'openrouter', 'the previously active provider is left selected');

    assert.equal(state.sends, 0);
  } finally {
    await close();
  }
});

// --------------------------------------------------------- connectors (Req 13)

test('GET/POST /settings/connectors: catalog + bound; a submitted secret is NEVER echoed anywhere in the response', async () => {
  const { authService, account, token } = await authWithToken();
  const { layout, cleanup } = mkLayout();
  const { connectorService, connectorBindingStore } = mkConnectors(layout, account.id);
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    connectorService,
    connectorBindingStore,
  });
  try {
    // GET: a flat catalog the client groups + an (empty) bound list.
    const list = await getJson(base, '/settings/connectors', token);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.catalog) && list.body.catalog.length > 0);
    const stripe = list.body.catalog.find((c) => c.service === 'stripe');
    assert.ok(stripe && stripe.category === 'payments' && Array.isArray(stripe.envNames));
    assert.deepEqual(list.body.bound, []);

    // POST: configure stripe with a secret. The secret VALUE must never come back.
    const SECRET = 'sk_live_SUPERSECRET_VALUE_9f3a';
    const conf = await postJson(base, '/settings/connectors', token, {
      service: 'stripe',
      projectId: 'proj-c',
      secrets: { STRIPE_SECRET_KEY: SECRET },
    });
    assert.equal(conf.status, 200);
    assert.equal(conf.body.bound.service, 'stripe');
    assert.deepEqual(conf.body.bound.secretRefs, ['STRIPE_SECRET_KEY'], 'only the env-var NAME is surfaced');
    // The secret VALUE appears NOWHERE in the raw response text (Req 13.3).
    assert.ok(!conf.text.includes(SECRET), 'the submitted secret value is not present in the response body');

    // GET bound now lists the active binding (name-only) for that project.
    const after = await getJson(base, '/settings/connectors?projectId=proj-c', token);
    assert.equal(after.status, 200);
    const bound = after.body.bound.find((b) => b.service === 'stripe');
    assert.ok(bound && bound.status === 'active');
    assert.deepEqual(bound.secretRefs, ['STRIPE_SECRET_KEY']);
    assert.ok(!after.text.includes(SECRET), 'no secret value in the bound listing either');

    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

// ------------------------------------------------------------- skills (Req 14)

test('GET/POST /settings/skills: lists stocked + user skills, adds a User_Skill', async () => {
  const { authService, token } = await authWithToken();
  const { layout, cleanup } = mkLayout();
  const skillLibrary = createSkillLibrary({ layout });
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    skillLibrary,
  });
  try {
    const list = await getJson(base, '/settings/skills', token);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.stocked));
    assert.deepEqual(list.body.user, []);

    const add = await postJson(base, '/settings/skills', token, {
      name: 'my-skill',
      description: 'A skill that does a thing.',
      body: '# My Skill\nDo the thing.',
    });
    assert.equal(add.status, 200);
    assert.equal(add.body.skill.name, 'my-skill');
    assert.equal(add.body.skill.description, 'A skill that does a thing.');

    // GET now lists the user skill.
    const after = await getJson(base, '/settings/skills', token);
    assert.ok(after.body.user.some((s) => s.name === 'my-skill'));

    // A validation rejection (missing description) is a structured 400.
    const bad = await postJson(base, '/settings/skills', token, { name: 'x', body: 'b' });
    assert.equal(bad.status, 400);
    assert.ok(typeof bad.body.code === 'string');

    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

// ------------------------------------------------------------- memory (Req 14)

test('GET/POST /settings/memory: reads scopes + mode, sets mode, edits and prunes a global entry', async () => {
  const { authService, account, token } = await authWithToken();
  const { layout, cleanup } = mkLayout();
  const memoryStore = createMemoryStore({ layout });
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    memoryStore,
  });
  try {
    // Seed a real global entry via the REAL store so edit/prune have a target.
    const seeded = memoryStore.globalStore(account.id).addUser({ kind: 'decision', text: 'prefer tabs' });
    assert.equal(seeded.ok, true);
    const id = seeded.entry.id;

    const view = await getJson(base, '/settings/memory', token);
    assert.equal(view.status, 200);
    assert.deepEqual(view.body.project, [], 'no projectId -> empty project scope');
    assert.ok(view.body.global.some((e) => e.id === id && e.text === 'prefer tabs'));
    assert.equal(view.body.mode, 'auto');

    // Set the Memory_Mode.
    const mode = await postJson(base, '/settings/memory', token, { op: 'mode', mode: 'manual' });
    assert.equal(mode.status, 200);
    assert.equal(mode.body.mode, 'manual');

    // Edit the entry.
    const edit = await postJson(base, '/settings/memory', token, { op: 'edit', scope: 'global', id, text: 'prefer spaces' });
    assert.equal(edit.status, 200);
    assert.ok(edit.body.global.some((e) => e.id === id && e.text === 'prefer spaces'));

    // An invalid mode is a structured 400.
    const badMode = await postJson(base, '/settings/memory', token, { op: 'mode', mode: 'bogus' });
    assert.equal(badMode.status, 400);
    assert.equal(badMode.body.code, 'invalid_mode');

    // Prune the entry.
    const prune = await postJson(base, '/settings/memory', token, { op: 'prune', scope: 'global', id });
    assert.equal(prune.status, 200);
    assert.ok(!prune.body.global.some((e) => e.id === id), 'the pruned entry is gone');

    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

// ------------------------------------------------ build / deploy (Req 15.1/15.2)

test('POST /settings/build + /settings/deploy: surface the injected lifecycle outcome (per-project, authorized)', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  const calls = [];
  const projectLifecycle = {
    build({ projectId }) {
      calls.push(['build', projectId]);
      return { outcome: 'succeeded', summary: 'built ok' };
    },
    deploy({ projectId, service }) {
      calls.push(['deploy', projectId, service]);
      return { outcome: 'succeeded', url: 'https://example.test/app', summary: 'deployed' };
    },
  };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    projectLifecycle,
  });
  try {
    const build = await postJson(base, '/settings/build', token, { projectId: 'proj-b' });
    assert.equal(build.status, 200);
    assert.equal(build.body.outcome, 'succeeded');
    assert.equal(build.body.summary, 'built ok');

    const deploy = await postJson(base, '/settings/deploy', token, { projectId: 'proj-b', service: 'vercel' });
    assert.equal(deploy.status, 200);
    assert.equal(deploy.body.outcome, 'succeeded');
    assert.equal(deploy.body.url, 'https://example.test/app');

    assert.deepEqual(calls, [['build', 'proj-b'], ['deploy', 'proj-b', 'vercel']]);
    assert.equal(state.sends, 0);
  } finally {
    await close();
  }
});

// ------------------------------------------------------------- export (Req 15.3)

test('GET /settings/export: returns a downloadable package the client reads as a blob', async () => {
  const { authService, token } = await authWithToken();
  const { layout, cleanup } = mkLayout();
  // A REAL ProjectExport over an injected read seam (no on-disk tree needed).
  const projectExporter = createProjectExport({
    layout,
    readTree: () => ({ 'src/index.js': "console.log('hi');\n", 'README.md': '# App\n' }),
  });
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    projectExporter,
  });
  try {
    const res = await fetch(`${base}/settings/export?projectId=proj-x`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename=".*proj-x.*"/);
    // The client reads it as a blob; here we parse the package JSON and confirm
    // the exported files round-trip losslessly.
    const pkg = JSON.parse(await res.text());
    assert.equal(pkg.files['src/index.js'].data, "console.log('hi');\n");
    assert.equal(pkg.files['README.md'].data, '# App\n');
    assert.ok(typeof pkg.envTemplate === 'string');

    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

// -------------------------------------------------------- lockin-audit (Req 15.4)

test('GET /settings/lockin-audit: reports findings + clean over the project tree', async () => {
  const { authService, token } = await authWithToken();
  const { layout, cleanup } = mkLayout();
  const state = { sends: 0 };

  // A clean tree -> clean:true, no findings.
  const cleanAudit = createLockinAudit({ layout, readTree: () => ({ 'src/app.ts': 'export const x = 1;\n' }) });
  const clean = await startServer({ authService, agentFactory: noTurnAgentFactory(state), lockinAudit: cleanAudit });
  try {
    const res = await getJson(clean.base, '/settings/lockin-audit?projectId=proj-a', token);
    assert.equal(res.status, 200);
    assert.equal(res.body.clean, true);
    assert.deepEqual(res.body.findings, []);
  } finally {
    await clean.close();
  }

  // A tree with a telemetry import -> a finding, clean:false.
  const dirtyAudit = createLockinAudit({
    layout,
    readTree: () => ({ 'src/track.ts': "import posthog from 'posthog-js';\n" }),
  });
  const dirty = await startServer({ authService, agentFactory: noTurnAgentFactory(state), lockinAudit: dirtyAudit });
  try {
    const res = await getJson(dirty.base, '/settings/lockin-audit?projectId=proj-a', token);
    assert.equal(res.status, 200);
    assert.equal(res.body.clean, false);
    assert.ok(res.body.findings.some((f) => f.signal === 'telemetry'));
    assert.equal(state.sends, 0);
  } finally {
    await dirty.close();
    cleanup();
  }
});

// -------------------------------------------------------------- share (Req 15.5)

test('POST /settings/share: mints a read-only Share_Link and returns a copyable url', async () => {
  const { authService, account, token } = await authWithToken();
  const { layout, cleanup } = mkLayout();
  const store = createShareLinkStore({ layout, ownerId: account.id });
  const authorizer = createAuthorizer();
  // The requester owns proj-s (owner === the authenticated account).
  const projectResolver = (projectId) => (projectId === 'proj-s' ? { id: 'proj-s', ownerId: account.id } : null);
  const shareLinkService = createShareLinkService({ store, authorizer, projectResolver });
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    shareLinkService,
    shareLinkBaseUrl: 'https://share.example.test',
    // The per-project gate authorizes via the same resolver -> owner match.
    projectResolver,
  });
  try {
    const res = await postJson(base, '/settings/share', token, { projectId: 'proj-s' });
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.url === 'string' && res.body.url.startsWith('https://share.example.test/'));
    // A real link was persisted (a fresh store over the same layout reads one).
    assert.ok(createShareLinkStore({ layout, ownerId: account.id }).list().length >= 1);

    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

// -------------------------------------------- authn denial on EVERY route (7.x)

test('every /settings route denies a MISSING token and an INVALID token with the identical non-disclosing 401', async () => {
  const { authService, account } = await authWithToken();
  const { layout, cleanup } = mkLayout();
  const { connectorService, connectorBindingStore } = mkConnectors(layout, account.id);
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    providerResolver: mkProviderResolver(),
    connectorService,
    connectorBindingStore,
    skillLibrary: createSkillLibrary({ layout }),
    memoryStore: createMemoryStore({ layout }),
    projectExporter: createProjectExport({ layout, readTree: () => ({}) }),
    lockinAudit: createLockinAudit({ layout, readTree: () => ({}) }),
    projectLifecycle: { build: () => ({ outcome: 'succeeded' }), deploy: () => ({ outcome: 'succeeded' }) },
    shareLinkService: {
      share: () => ({ ok: true, link: { token: 't', url: 'https://x/t' } }),
    },
  });
  try {
    const cases = [
      ['GET', '/settings/provider'],
      ['POST', '/settings/provider'],
      ['GET', '/settings/connectors'],
      ['POST', '/settings/connectors'],
      ['GET', '/settings/skills'],
      ['POST', '/settings/skills'],
      ['GET', '/settings/memory'],
      ['POST', '/settings/memory'],
      ['POST', '/settings/build'],
      ['POST', '/settings/deploy'],
      ['GET', '/settings/export?projectId=p'],
      ['GET', '/settings/lockin-audit?projectId=p'],
      ['POST', '/settings/share'],
    ];
    for (const [method, route] of cases) {
      for (const auth of [undefined, 'Bearer not-a-real-token']) {
        const headers = { 'content-type': 'application/json' };
        if (auth) headers.authorization = auth;
        const res = await fetch(`${base}${route}`, {
          method,
          headers,
          ...(method === 'POST' ? { body: JSON.stringify({ projectId: 'p', provider: 'anthropic' }) } : {}),
        });
        assert.equal(res.status, 401, `${method} ${route} (${auth ?? 'no token'}) is denied`);
        assert.deepEqual(await res.json(), DENIED, `${method} ${route} returns the non-disclosing body`);
      }
    }
    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

// ------------------------------------- absence: no service injected => 405 route off

test('with NO settings services injected, every /settings route is NOT enabled (405) and behaviour is unchanged', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  const { base, close } = await startServer({ authService, agentFactory: noTurnAgentFactory(state) });
  try {
    const cases = [
      ['GET', '/settings/provider'],
      ['POST', '/settings/provider'],
      ['GET', '/settings/connectors'],
      ['POST', '/settings/connectors'],
      ['GET', '/settings/skills'],
      ['POST', '/settings/skills'],
      ['GET', '/settings/memory'],
      ['POST', '/settings/memory'],
      ['POST', '/settings/build'],
      ['POST', '/settings/deploy'],
      ['GET', '/settings/export?projectId=p'],
      ['GET', '/settings/lockin-audit?projectId=p'],
      ['POST', '/settings/share'],
    ];
    for (const [method, route] of cases) {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        ...(method === 'POST' ? { body: JSON.stringify({ projectId: 'p' }) } : {}),
      });
      assert.equal(res.status, 405, `${method} ${route} is not routed without its service`);
    }
    assert.equal(state.sends, 0);
  } finally {
    await close();
  }
});
