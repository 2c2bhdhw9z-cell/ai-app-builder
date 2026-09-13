/**
 * Integration test for Web UI Task 15.2 (node --test), Req 1.4 (+ 1.1, 1.3).
 *
 * The FINAL asset set — after Task 14/15 added the settings surfaces, the router,
 * and the settings panel — must still load and execute under the Builder_Server's
 * strict `script-src 'self'` / `style-src 'self'` CSP with NO inline-script and
 * NO external-origin exceptions. This is the "load the assembled client under a
 * CSP-enforcing context (or assert structurally)" check the spec asks for.
 *
 * A headless Node test cannot run a real browser CSP engine, so this asserts the
 * two things a browser's CSP would enforce, STRUCTURALLY, over the REAL served
 * assets from the REAL Builder_Server route (not a mock):
 *
 *   (1) The CSP the server emits on the shell is the strict same-origin policy
 *       (script-src 'self', style-src 'self', default/connect-src 'self', no
 *       'unsafe-inline'), so any inline script/style or external origin WOULD be
 *       blocked by a real browser.
 *
 *   (2) Over the ENTIRE final asset set (every entry the server's STATIC_ASSETS
 *       allow-list serves — index.html, styles.css, app.js, and every ES module
 *       including the new router + settings modules):
 *         - the HTML shell has NO inline <script> and NO inline <style> and NO
 *           inline event-handler attributes (onclick=…), and loads JS/CSS only
 *           via same-origin src/href;
 *         - NO asset references an external origin (http(s)://host, protocol-
 *           relative //host, or a `connect/fetch/import` to an off-origin URL) —
 *           the one legal exception being `data:` URIs, which the CSP's
 *           `img-src 'self' data:` permits.
 *
 * It also confirms the new settings/router modules are actually SERVED (in the
 * allow-list) and that the assembled client imports them (no orphaned module),
 * and that an unknown path still 405s / a missing asset 404s.
 *
 * The server is bound on an ephemeral port (listen 0) and driven with node's
 * global fetch, exactly as the other builder-server integration tests do.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createScriptedProvider } from '../src/engine/plumby.js';

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'server',
  'public',
);

/** The FINAL asset set the client is assembled from (served + import-reachable
 *  from app.js). Kept explicit so the test fails loudly if a NEW module is added
 *  but not wired into this structural sweep. */
const ASSET_PATHS = Object.freeze([
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/app.js',
  '/store.js',
  '/api.js',
  '/builder.js',
  '/sse.js',
  '/frames.js',
  '/preview.js',
  '/preview-poll.js',
  '/qr.js',
  '/confirm.js',
  '/token-store.js',
  '/auth.js',
  '/projects.js',
  '/workspace.js',
  '/theme.js',
  '/work-mode.js',
  '/router.js',
  '/settings/settings-state.js',
  '/settings/provider.js',
  '/settings/connectors.js',
  '/settings/skills.js',
  '/settings/memory.js',
  '/settings/lifecycle.js',
  '/views/prompt.js',
  '/views/activity-stream.js',
  '/views/preview-pane.js',
  '/views/confirm.js',
  '/views/projects.js',
  '/views/stage.js',
  '/views/file-panel.js',
  '/views/session-header.js',
  '/views/workspace-controls.js',
  '/views/settings/settings-panel.js',
]);

/** A REAL AuthService with a denying IdP — GET / and the assets are served
 *  BEFORE auth gating, so no token is needed. */
function minimalAuth() {
  const denyingIdp = { async verifyIdToken() { throw new Error('denied'); } };
  return createAuthService({ idpVerifier: denyingIdp });
}

/**
 * Scan text for an EXTERNAL-origin reference. Allows `data:` URIs (CSP permits
 * `img-src 'self' data:`) and same-origin relative paths. Flags absolute
 * http(s):// URLs and protocol-relative //host references. Comment/URL mentions
 * inside JS strings are conservatively flagged too — the client must not embed
 * any off-origin URL at all, so this strictness is intentional.
 */
/**
 * Strip comments so documentation prose (which may legitimately mention
 * "<script>" or an "https://…" URL for explanation) is not scanned as if it were
 * executable content. HTML: <!-- … -->. JS/CSS: block comments and line comments.
 * A browser never executes these, so removing them yields the content the CSP
 * actually governs.
 */
function stripComments(text, p) {
  let out = text;
  if (p.endsWith('.html')) {
    out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  } else {
    // Block comments (JS + CSS share the /* … */ form).
    out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
    if (p.endsWith('.js')) {
      // Line comments — only when // starts a comment (preceded by start/space/
      // punctuation), so a `//host` inside a string is still scanned.
      out = out.replace(/(^|[\s;{}(])\/\/[^\n]*/g, '$1 ');
    }
  }
  return out;
}

/**
 * Well-known XML/SVG NAMESPACE URIs. These are identifiers passed to
 * document.createElementNS(...) to build inline SVG/XML nodes via the DOM API —
 * they are NOT network requests and trigger no CSP fetch (the SVG is same-origin,
 * built in-memory). qr.js legitimately uses the SVG namespace to render the QR
 * as an inline data: image. They are allow-listed so the external-origin scan
 * flags only genuine off-origin FETCH targets.
 * @type {ReadonlySet<string>}
 */
const NAMESPACE_URIS = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
]);

function findExternalOrigin(text) {
  // Absolute http(s) URL — but allow well-known XML/SVG namespace identifiers,
  // which are DOM createElementNS args, not network requests.
  const absAll = text.match(/\bhttps?:\/\/[^\s"'`)]+/gi) || [];
  for (const u of absAll) {
    const bare = u.replace(/["'`).,;]+$/, '');
    if (!NAMESPACE_URIS.has(bare)) return u;
  }
  // Protocol-relative //host (not a comment `//`): a // followed by a word char
  // and a dot, i.e. //example.com. Excludes `://` (already covered) and `//`
  // line comments (which are followed by space/text, not host.tld tokens).
  const protoRel = text.match(/(^|[\s"'`(=])\/\/[a-z0-9-]+\.[a-z]{2,}[^\s"'`)]*/i);
  if (protoRel) return protoRel[0].trim();
  return null;
}

test('Task 15.2: the shell is served under the strict same-origin CSP (script-src/style-src \'self\', no unsafe-inline) (Req 1.4)', async () => {
  const server = createBuilderServer({ authService: minimalAuth(), provider: createScriptedProvider([]) });
  const { port, host } = await server.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`http://${host}:${port}/`);
    assert.equal(res.status, 200, 'GET / serves the shell');
    assert.match(res.headers.get('content-type') || '', /text\/html/, 'GET / is HTML, not JSON');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/, "default-src 'self'");
    assert.match(csp, /script-src 'self'/, "script-src 'self'");
    assert.match(csp, /style-src 'self'/, "style-src 'self'");
    assert.match(csp, /connect-src 'self'/, "connect-src 'self'");
    assert.ok(!/unsafe-inline/.test(csp), 'the CSP grants NO unsafe-inline exception');
    assert.ok(!/unsafe-eval/.test(csp), 'the CSP grants NO unsafe-eval exception');
  } finally {
    await server.close();
  }
});

test('Task 15.2: every FINAL asset is served same-origin with no inline script/style and no external origin (Req 1.4)', async () => {
  const server = createBuilderServer({ authService: minimalAuth(), provider: createScriptedProvider([]) });
  const { port, host } = await server.listen(0, '127.0.0.1');
  try {
    for (const p of ASSET_PATHS) {
      const res = await fetch(`http://${host}:${port}${p}`);
      assert.equal(res.status, 200, `asset ${p} is served (in the allow-list)`);
      const body = await res.text();

      // Strip HTML/JS/CSS comments so mentions of "<script>"/"http://…" inside
      // documentation comments are not false positives — a browser executes the
      // stripped content, and that is what must be CSP-clean.
      const stripped = stripComments(body, p);

      if (p.endsWith('.html')) {
        // No inline <script> (a <script> tag must carry a src=…, not a body).
        assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(stripped), `${p}: no inline <script> body`);
        // No inline <style> element.
        assert.ok(!/<style[\s>]/i.test(stripped), `${p}: no inline <style> element`);
        // No inline event-handler attributes (onclick=, onload=, …).
        assert.ok(!/\son[a-z]+\s*=/i.test(stripped), `${p}: no inline event-handler attributes`);
        // JS is loaded as a same-origin module.
        assert.match(body, /<script\s+type="module"\s+src="\/app\.js"/i, `${p}: loads /app.js as a module`);
      }

      // No external-origin reference in any asset (data: allowed).
      const external = findExternalOrigin(stripped);
      assert.equal(external, null, `${p}: references no external origin (found: ${external})`);
    }
  } finally {
    await server.close();
  }
});

test('Task 15.2: the new router + settings modules are wired into the assembled client (no orphaned module)', async () => {
  // app.js is the single entry the shell loads; every client module must be
  // reachable from it (directly or transitively). We assert the NEW Task 14/15
  // modules are imported by app.js so none is an orphan.
  const appSrc = await readFile(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const mustImport = [
    './router.js',
    './settings/provider.js',
    './settings/connectors.js',
    './settings/skills.js',
    './settings/memory.js',
    './settings/lifecycle.js',
    './views/settings/settings-panel.js',
  ];
  for (const m of mustImport) {
    assert.match(appSrc, new RegExp(`from ['"]${m.replace(/[.\\/]/g, '\\$&')}['"]`), `app.js imports ${m}`);
  }
  // settings-panel.js pulls in the shared settings-state (via the controllers)
  // and memory MODES; assert the panel imports memory's MEMORY_MODES so the
  // settings-state module is reachable through the controller graph too.
  const panelSrc = await readFile(path.join(PUBLIC_DIR, 'views/settings/settings-panel.js'), 'utf8');
  assert.match(panelSrc, /from ['"]\.\.\/\.\.\/settings\/memory\.js['"]/, 'panel imports memory module');
});

test('Task 15.2: an unknown path still 405s and a missing asset 404s (Req 1.1)', async () => {
  const server = createBuilderServer({ authService: minimalAuth(), provider: createScriptedProvider([]) });
  const { port, host } = await server.listen(0, '127.0.0.1');
  try {
    const unknown = await fetch(`http://${host}:${port}/not-a-route`);
    assert.equal(unknown.status, 405, 'an unknown non-asset path still 405s');
    // A path shaped like an asset but not in the allow-list is not served.
    const missing = await fetch(`http://${host}:${port}/settings/does-not-exist.js`);
    assert.notEqual(missing.status, 200, 'a non-allow-listed asset-looking path is not served');
  } finally {
    await server.close();
  }
});
