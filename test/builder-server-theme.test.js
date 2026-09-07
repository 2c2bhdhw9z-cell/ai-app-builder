/**
 * Builder Server Theme surface tests (Task 33.4, Req 29.1-29.8, Property 22).
 *
 * Exercises the REAL builder-server harness (ephemeral port + node's global
 * fetch, the REAL gate/auth from createAuthService + a real minted session
 * token) with a REAL ThemeStore over an fs.mkdtemp StorageLayout and a REAL
 * WorkspaceExperienceStore (so the experience default — the theme key — is
 * resolvable). No mocks of the theme surface, and NO live browser: the SSE
 * surface is driven purely as a SEAM via fetch (open /events, read broadcast
 * frames off the stream). The agent's send() THROWS, so a theme POST that ever
 * enqueued a turn would fail — state.sends must stay 0 (theme is visuals-only).
 *
 * Covers the Task 33.4 cases, each FAILING if the fix is reverted:
 *   (1) GET /theme returns the experience default theme+palette+previewed:false;
 *   (2) POST preview broadcasts previewed:true and does NOT persist;
 *   (3) POST commit persists (a fresh store over the same layout returns it) and
 *       broadcasts previewed:false;
 *   (4) committing one experience does not change another's committed theme;
 *   (5) out-of-catalog preview OR commit -> 400 unsupported_theme, current left
 *       in effect, no persistence on preview;
 *   (6) a preceding real non-theme state snapshot (a persisted workspace-
 *       experience doc) is byte-for-byte preserved across theme ops, sends==0.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createStorageLayout } from '../src/storage/layout.js';
import {
  createThemeStore,
  createWorkspaceExperienceStore,
} from '../src/presentation/index.js';
import { THEME_CATALOG, defaultThemeFor } from '../src/model/enums.js';

// ---------------------------------------------------------------- test harness

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
 * A fake agent whose send() RECORDS that it was called and THROWS — a theme POST
 * must NEVER enqueue a loop turn, so send() must never fire. `sends` is a shared
 * counter the tests assert stays at 0 (theme is visuals-only, Req 29.6).
 */
function noTurnAgentFactory(state) {
  return ({ onEvent }) => ({
    agent: {
      cwd: '/tmp/project',
      async send() {
        state.sends += 1;
        throw new Error('agent.send must never be called by a theme POST');
      },
    },
  });
}

/** Start a server on an ephemeral port; returns base URL + close(). */
async function startServer(opts) {
  const server = createBuilderServer(opts);
  const { port, host } = await server.listen(0, '127.0.0.1');
  const base = `http://${host}:${port}`;
  return { server, base, close: () => server.close() };
}

/** Open an SSE stream; returns the Response. */
async function openEvents(base, projectId, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/events?projectId=${encodeURIComponent(projectId)}`, { headers });
}

/**
 * Read decoded SSE frames from a Response body using a CONTINUOUS background
 * read loop. Returns { frames, stop() } — the caller stops it when done.
 */
function startFrameReader(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let stopped = false;

  (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                frames.push(JSON.parse(line.slice(6)));
              } catch {
                /* ignore non-JSON keepalive */
              }
            }
          }
        }
      }
    } catch {
      /* reader cancelled */
    }
  })();

  return {
    frames,
    async stop() {
      stopped = true;
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Wait until predicate(frames) is true or timeout; returns whether satisfied. */
async function waitFor(frames, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(frames)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate(frames);
}

/** A real ThemeStore + WorkspaceExperienceStore over one fs.mkdtemp layout. */
function mkStores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-theme-srv-'));
  const layout = createStorageLayout(dir);
  const themeStore = createThemeStore({ layout });
  const workspaceExperienceStore = createWorkspaceExperienceStore({ layout });
  return {
    dir,
    layout,
    themeStore,
    workspaceExperienceStore,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** GET /theme; returns { status, body }. */
async function getTheme(base, token, workspaceExperience) {
  const qs = workspaceExperience ? `?workspaceExperience=${encodeURIComponent(workspaceExperience)}` : '';
  const res = await fetch(`${base}/theme${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

/** POST /theme; returns { status, body }. */
async function postTheme(base, token, payload) {
  const res = await fetch(`${base}/theme`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// ----------------------------------------------------------------------- tests

test('(1) GET /theme returns the experience default theme + palette + previewed:false for a fresh account', async () => {
  const { authService, token } = await authWithToken();
  const { themeStore, workspaceExperienceStore, cleanup } = mkStores();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    themeStore,
    workspaceExperienceStore,
  });
  try {
    const { status, body } = await getTheme(base, token, 'vibe-first');
    assert.equal(status, 200);
    assert.equal(body.type, 'theme');
    assert.equal(body.workspaceExperience, 'vibe-first');
    // The documented default for vibe-first, with its real palette.
    assert.equal(body.theme, defaultThemeFor('vibe-first'));
    assert.deepStrictEqual(body.palette, THEME_CATALOG[defaultThemeFor('vibe-first')].palette);
    assert.equal(body.previewed, false);
    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

test('(2) POST /theme preview broadcasts previewed:true and does NOT persist', async () => {
  const { authService, account, token } = await authWithToken();
  const { themeStore, workspaceExperienceStore, layout, cleanup } = mkStores();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    themeStore,
    workspaceExperienceStore,
  });
  try {
    // Open a stream so the preview broadcast can be observed on the SEAM.
    const events = await openEvents(base, 'proj-2', token);
    const reader = startFrameReader(events);
    await waitFor(reader.frames, (f) => f.some((x) => x.type === 'theme'));

    const before = reader.frames.length;
    const { status, body } = await postTheme(base, token, {
      action: 'preview',
      workspaceExperience: 'vibe-first',
      theme: 'out-there',
    });
    assert.equal(status, 200);
    assert.equal(body.type, 'theme');
    assert.equal(body.theme, 'out-there');
    assert.equal(body.previewed, true, 'the preview response is flagged previewed:true');

    // A previewed:true frame was broadcast on the SSE seam.
    const gotPreview = await waitFor(reader.frames, (f) =>
      f.slice(before).some((x) => x.type === 'theme' && x.previewed === true && x.theme === 'out-there'),
    );
    assert.ok(gotPreview, 'a previewed:true theme frame was broadcast');

    // NOTHING was persisted: the store shows no commit and GET returns the prior.
    assert.deepStrictEqual(themeStore.getAllCommitted(account.id), {});
    assert.ok(!fs.existsSync(layout.controlPresentationSettingsPath(account.id)), 'preview writes nothing');
    const after = await getTheme(base, token, 'vibe-first');
    assert.equal(after.body.theme, defaultThemeFor('vibe-first'), 'GET still returns the prior/default');
    assert.equal(after.body.previewed, false);

    assert.equal(state.sends, 0);
    await reader.stop();
  } finally {
    await close();
    cleanup();
  }
});

test('(3) POST /theme commit persists (a fresh store over the same layout returns it) and broadcasts previewed:false', async () => {
  const { authService, account, token } = await authWithToken();
  const { themeStore, workspaceExperienceStore, layout, cleanup } = mkStores();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    themeStore,
    workspaceExperienceStore,
  });
  try {
    const events = await openEvents(base, 'proj-3', token);
    const reader = startFrameReader(events);
    await waitFor(reader.frames, (f) => f.some((x) => x.type === 'theme'));
    const before = reader.frames.length;

    const { status, body } = await postTheme(base, token, {
      action: 'commit',
      workspaceExperience: 'vibe-first',
      theme: 'out-there',
    });
    assert.equal(status, 200);
    assert.equal(body.theme, 'out-there');
    assert.equal(body.previewed, false, 'a commit broadcasts previewed:false');
    assert.ok(typeof body.at === 'string' && body.at.length > 0, 'commit stamps `at`');

    // A previewed:false committed frame was broadcast on the seam.
    const gotCommit = await waitFor(reader.frames, (f) =>
      f.slice(before).some((x) => x.type === 'theme' && x.previewed === false && x.theme === 'out-there'),
    );
    assert.ok(gotCommit, 'a previewed:false committed frame was broadcast');

    // Persisted: a FRESH store over the SAME layout reads it back (later Session).
    const fresh = createThemeStore({ layout });
    assert.equal(fresh.getCommitted(account.id, 'vibe-first'), 'out-there');

    // And GET now returns the committed theme.
    const after = await getTheme(base, token, 'vibe-first');
    assert.equal(after.body.theme, 'out-there');
    assert.equal(after.body.previewed, false);

    assert.equal(state.sends, 0);
    await reader.stop();
  } finally {
    await close();
    cleanup();
  }
});

test('(4) committing a theme in one experience does not change another experience', async () => {
  const { authService, account, token } = await authWithToken();
  const { themeStore, workspaceExperienceStore, layout, cleanup } = mkStores();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    themeStore,
    workspaceExperienceStore,
  });
  try {
    // Commit distinct themes for two experiences.
    assert.equal((await postTheme(base, token, {
      action: 'commit', workspaceExperience: 'vibe-first', theme: 'out-there',
    })).status, 200);
    assert.equal((await postTheme(base, token, {
      action: 'commit', workspaceExperience: 'technical-workbench', theme: 'paranormal-purple',
    })).status, 200);

    // Each experience surfaces its OWN committed theme; neither leaked.
    const vf = await getTheme(base, token, 'vibe-first');
    assert.equal(vf.body.theme, 'out-there');
    const tw = await getTheme(base, token, 'technical-workbench');
    assert.equal(tw.body.theme, 'paranormal-purple');
    // An untouched experience still surfaces its own default.
    const ks = await getTheme(base, token, 'kiro-style');
    assert.equal(ks.body.theme, defaultThemeFor('kiro-style'));

    // The store agrees (per-experience map, not a per-user value).
    const fresh = createThemeStore({ layout });
    assert.deepStrictEqual(fresh.getAllCommitted(account.id), {
      'vibe-first': 'out-there',
      'technical-workbench': 'paranormal-purple',
    });

    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

test('(5) an out-of-catalog preview OR commit returns 400 unsupported_theme, current left in effect, no persistence', async () => {
  const { authService, account, token } = await authWithToken();
  const { themeStore, workspaceExperienceStore, layout, cleanup } = mkStores();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    themeStore,
    workspaceExperienceStore,
  });
  try {
    // Establish a committed theme so the "current" a rejection preserves is a
    // non-default value.
    assert.equal((await postTheme(base, token, {
      action: 'commit', workspaceExperience: 'vibe-first', theme: 'summer-sunset',
    })).status, 200);

    // Out-of-catalog COMMIT -> 400, current left in effect.
    const badCommit = await postTheme(base, token, {
      action: 'commit', workspaceExperience: 'vibe-first', theme: 'teal',
    });
    assert.equal(badCommit.status, 400);
    assert.equal(badCommit.body.code, 'unsupported_theme');
    assert.ok(badCommit.body.current && badCommit.body.current.type === 'theme');
    assert.equal(badCommit.body.current.theme, 'summer-sunset', 'the current committed theme is reported');

    // Out-of-catalog PREVIEW -> 400, no preview, no persistence.
    const badPreview = await postTheme(base, token, {
      action: 'preview', workspaceExperience: 'vibe-first', theme: 'nope',
    });
    assert.equal(badPreview.status, 400);
    assert.equal(badPreview.body.code, 'unsupported_theme');
    assert.equal(badPreview.body.current.theme, 'summer-sunset');

    // Nothing changed on disk: still exactly the one prior committed theme.
    const fresh = createThemeStore({ layout });
    assert.deepStrictEqual(fresh.getAllCommitted(account.id), { 'vibe-first': 'summer-sunset' });
    const after = await getTheme(base, token, 'vibe-first');
    assert.equal(after.body.theme, 'summer-sunset', 'out-of-catalog rejection leaves the current theme');

    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

test('(6) a committed theme change preserves a preceding real non-theme state snapshot byte-for-byte, sends==0', async () => {
  const { authService, account, token } = await authWithToken();
  const { themeStore, workspaceExperienceStore, layout, cleanup } = mkStores();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    themeStore,
    workspaceExperienceStore,
  });
  try {
    // Populate REAL non-theme state via the workspace-experience store: a
    // persisted Workspace_Experience selection in the same presentation document.
    const sel = workspaceExperienceStore.select(account.id, 'technical-workbench');
    assert.equal(sel.ok, true);
    const statePath = layout.controlPresentationSettingsPath(account.id);

    // Snapshot the NON-THEME portion (theme ops write themesByExperience into the
    // same doc, so the invariant is: every non-theme field is byte-for-byte
    // preserved — standing in for source/agent state/Project data/models/Skills/
    // Connectors/permissions/Work_Mode/layout/Project_Origin, Req 29.6).
    function nonThemeSnapshot() {
      const doc = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      delete doc.themesByExperience;
      return Buffer.from(JSON.stringify(doc), 'utf8');
    }
    const before = nonThemeSnapshot();
    assert.ok(before.length > 0, 'a real non-theme document is on disk');

    // A preview then a commit — real theme operations over the seam.
    assert.equal((await postTheme(base, token, {
      action: 'preview', workspaceExperience: 'technical-workbench', theme: 'out-there',
    })).status, 200);
    const committed = await postTheme(base, token, {
      action: 'commit', workspaceExperience: 'technical-workbench', theme: 'paranormal-purple',
    });
    assert.equal(committed.status, 200);
    // The theme DID change (non-vacuous): the commit is real.
    assert.equal(committed.body.theme, 'paranormal-purple');

    // The non-theme state is byte-for-byte unchanged, and the workspace store
    // still reads its selection back.
    assert.ok(before.equals(nonThemeSnapshot()), 'non-theme state byte-for-byte preserved across theme ops');
    assert.equal(workspaceExperienceStore.get(account.id), 'technical-workbench');

    // No loop turn was ever enqueued by any theme op (visuals-only).
    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

test('(7) GET /theme AND POST /theme deny a MISSING token and an INVALID token with the identical non-disclosing 401 ACCESS_DENIED', async () => {
  // The authn gate on THIS surface is proven directly: every other theme case
  // sends a valid minted token, so the 401 path on /theme is otherwise never
  // exercised. This case would FAIL if the `gate(req, null)` guard were removed
  // from either handler (an accidental gate removal). The SSE surface is a SEAM
  // via fetch — NO live browser. `send()` throws, so state.sends must stay 0.
  const { authService, account, token } = await authWithToken();
  const { themeStore, workspaceExperienceStore, layout, cleanup } = mkStores();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    themeStore,
    workspaceExperienceStore,
  });
  try {
    const DENIED = { error: 'access denied' };

    // --- GET /theme with a MISSING token -> 401, non-disclosing body.
    const getNoToken = await fetch(`${base}/theme?workspaceExperience=vibe-first`);
    assert.equal(getNoToken.status, 401, 'GET /theme with no token is denied');
    assert.deepEqual(await getNoToken.json(), DENIED);

    // --- GET /theme with an INVALID/garbage token -> identical 401.
    const getBadToken = await fetch(`${base}/theme?workspaceExperience=vibe-first`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(getBadToken.status, 401, 'GET /theme with a garbage token is denied');
    assert.deepEqual(await getBadToken.json(), DENIED);

    // --- POST /theme with a MISSING token -> 401, non-disclosing body. A denied
    // POST must persist NOTHING (the store stays empty).
    const postNoToken = await fetch(`${base}/theme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'commit', workspaceExperience: 'vibe-first', theme: 'out-there' }),
    });
    assert.equal(postNoToken.status, 401, 'POST /theme with no token is denied');
    assert.deepEqual(await postNoToken.json(), DENIED);

    // --- POST /theme with an INVALID/garbage token -> identical 401.
    const postBadToken = await fetch(`${base}/theme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer garbage.token.value' },
      body: JSON.stringify({ action: 'commit', workspaceExperience: 'vibe-first', theme: 'out-there' }),
    });
    assert.equal(postBadToken.status, 401, 'POST /theme with a garbage token is denied');
    assert.deepEqual(await postBadToken.json(), DENIED);

    // A denied POST never reached the store: nothing was written on disk.
    assert.ok(
      !fs.existsSync(layout.controlPresentationSettingsPath(account.id)),
      'a denied POST persists nothing',
    );

    // Sanity: the SAME surface, with the VALID token, still works — proving the
    // 401s above are the gate acting, not a broken route.
    const ok = await getTheme(base, token, 'vibe-first');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.type, 'theme');

    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

test('(8) a REAL server-driven preview (POST /theme {action:preview}) leaves the committed theme UNCHANGED across an interleaved preview/commit sequence (server-level Property 22 preview safety + per-experience isolation)', async () => {
  // Property 22's own test models a preview as "do not call the store", so its
  // preview-safety invariant is true by construction. This case closes that gap
  // by driving previews through the REAL server surface (the same path a client
  // hits) and asserting that after each REAL preview the committed theme in the
  // store is unchanged and NOTHING was persisted by the preview — a server-side
  // regression where preview began persisting would FAIL here. The SSE surface
  // is a SEAM via fetch (NO live browser). `send()` throws -> state.sends stays 0.
  const { authService, account, token } = await authWithToken();
  const { themeStore, workspaceExperienceStore, layout, cleanup } = mkStores();
  const state = { sends: 0 };
  const { base, close } = await startServer({
    authService,
    agentFactory: noTurnAgentFactory(state),
    themeStore,
    workspaceExperienceStore,
  });
  try {
    // An in-memory model of the ONLY legal committed values, seeded with each
    // experience's default (a preview NEVER changes this; only a commit does).
    const model = {
      'vibe-first': defaultThemeFor('vibe-first'),
      'technical-workbench': defaultThemeFor('technical-workbench'),
    };

    // A sequence that INTERLEAVES real previews and commits. Each preview targets
    // a theme DIFFERENT from that experience's currently committed theme, so the
    // "unchanged" assertion is NON-VACUOUS (a persisting-preview bug would flip
    // the committed value to the previewed one).
    const seq = [
      { action: 'preview', experience: 'vibe-first', theme: 'out-there' },
      { action: 'preview', experience: 'technical-workbench', theme: 'paranormal-purple' },
      { action: 'commit', experience: 'vibe-first', theme: 'summer-sunset' },
      { action: 'preview', experience: 'vibe-first', theme: 'out-there' },
      { action: 'preview', experience: 'technical-workbench', theme: 'out-there' },
      { action: 'commit', experience: 'technical-workbench', theme: 'paranormal-purple' },
      { action: 'preview', experience: 'vibe-first', theme: 'paranormal-purple' },
    ];

    let realPreviewsToADifferentTheme = 0; // non-vacuity counter.
    let commitsThatChanged = 0;

    for (const step of seq) {
      const prior = model[step.experience];
      const res = await postTheme(base, token, {
        action: step.action,
        workspaceExperience: step.experience,
        theme: step.theme,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.type, 'theme');
      assert.equal(res.body.theme, step.theme);

      if (step.action === 'preview') {
        assert.equal(res.body.previewed, true, 'a preview response is previewed:true');
        if (step.theme !== prior) realPreviewsToADifferentTheme += 1;
        // The store's committed value for this experience is UNCHANGED by a real
        // server preview (Req 29.4). A fresh store over the same layout agrees.
        assert.equal(
          themeStore.getCommitted(account.id, step.experience),
          prior,
          'a REAL server preview did not change the committed theme',
        );
        assert.equal(
          createThemeStore({ layout }).getCommitted(account.id, step.experience),
          prior,
          'a REAL server preview persisted nothing (fresh store reads the prior)',
        );
      } else {
        assert.equal(res.body.previewed, false, 'a commit response is previewed:false');
        if (prior !== step.theme) commitsThatChanged += 1;
        model[step.experience] = step.theme;
      }

      // Per-experience isolation after EVERY step: for EVERY tracked experience
      // the store's committed value equals the model — a preview or commit to one
      // experience never leaks into another.
      for (const [exp, expected] of Object.entries(model)) {
        assert.equal(
          themeStore.getCommitted(account.id, exp),
          expected,
          `committed theme for ${exp} matches the model after a ${step.action}`,
        );
      }
    }

    // After the WHOLE sequence, the persisted committed map is EXACTLY the two
    // commits — no preview ever persisted. A FRESH store proves durability.
    assert.deepStrictEqual(createThemeStore({ layout }).getAllCommitted(account.id), {
      'vibe-first': 'summer-sunset',
      'technical-workbench': 'paranormal-purple',
    });

    // Non-vacuity: real previews to a DIFFERENT theme than the committed one were
    // exercised, and real commits actually changed a committed theme.
    assert.ok(
      realPreviewsToADifferentTheme > 0,
      `expected some real previews to a different theme, saw ${realPreviewsToADifferentTheme}`,
    );
    assert.ok(commitsThatChanged > 0, `expected some commits to change a theme, saw ${commitsThatChanged}`);

    // No loop turn was ever enqueued by any theme op (visuals-only, Req 29.6).
    assert.equal(state.sends, 0);
  } finally {
    await close();
    cleanup();
  }
});

test('with NO themeStore injected, GET/POST /theme are not routed (405)', async () => {
  const { authService, token } = await authWithToken();
  const state = { sends: 0 };
  const { base, close } = await startServer({ authService, agentFactory: noTurnAgentFactory(state) });
  try {
    const get = await fetch(`${base}/theme?workspaceExperience=vibe-first`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(get.status, 405, 'GET /theme is not routed without a themeStore');
    const post = await fetch(`${base}/theme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'commit', workspaceExperience: 'vibe-first', theme: 'out-there' }),
    });
    assert.equal(post.status, 405, 'POST /theme is not routed without a themeStore');
    assert.equal(state.sends, 0);
  } finally {
    await close();
  }
});
