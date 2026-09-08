/**
 * build/deploy ENGINE tests (node --test) — the REAL boundaries behind the
 * previously inert `buildBoundary` / `deployBoundary` seams of
 * src/project/build-service.js, plus their live wiring.
 *
 * WHAT IS PROVEN HERE, AND HOW HONESTLY:
 *
 *  (a) REAL, no fake in the loop: `resolveBuildCommand`, `logTail`, the artifact
 *      bundle codec and the published-site manifest key set are PURE functions and
 *      are tested directly.
 *  (b) REAL SandboxManager, REAL BuildService, REAL StorageLayout on a REAL temp
 *      filesystem — only the container CLI is faked, the same seam every other
 *      sandbox test injects. The fake backend MIRRORS PRODUCTION: it refuses any
 *      network mode a plain CLI backend cannot enforce (so a composition that
 *      selected `filtered` would fail here exactly as it fails in production), and
 *      it "runs" the build by writing into the project's bind mount — so the real
 *      output detection, the real bundling and the real artifact write all execute.
 *  (c) REAL on-disk state: a successful build writes a REAL Deployment_Artifact
 *      file under the per-OWNER control path, and a successful deploy writes a REAL
 *      release directory the publisher then really serves.
 *  (d) REAL HTTP: the composed runtime is driven through a REAL Builder_Server on a
 *      real port with real fetch, including the published-site route.
 *  (e) CLOCK-DRIVEN, never waited: the 300s build SLO and the 120s deploy SLO are
 *      measured against an injected manual clock.
 *
 * WHAT ONLY A REAL CONTAINER HOST CAN PROVE: that the runtime accepts the emitted
 * argv, that `npm run <script>` resolves a generated project's toolchain inside the
 * image, and that a real framework build writes into one of the conventional output
 * directories. No test here claims a container ran.
 *
 * MUTATION SENSITIVITY (each key assertion flips if the guarantee is reverted):
 * a missing build script refused rather than faked; a failed build surfacing the
 * exit status + a BOUNDED tail and writing NO artifact; the over-SLO build
 * producing no artifact; a publish producing a servable URL; a FAILED publish
 * leaving the previous release byte-for-byte unchanged; an unlisted/traversal path
 * and a wrong signature serving nothing; /settings/build + /settings/deploy being
 * reachable but closed to an unauthenticated and to a non-owner caller.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createContainerBuild,
  resolveBuildCommand,
  buildScriptPreference,
  logTail,
  encodeArtifactBundle,
  decodeArtifactBundle,
  isSafeRelativePath,
  OUTPUT_DIR_PREFERENCE,
  REFUSED_EXIT_STATUS,
  TIMED_OUT_EXIT_STATUS,
  ARTIFACT_BUNDLE_VERSION,
} from '../src/project/container-build.js';
import {
  createSelfHostedDeploy,
  manifestEntriesFor,
  publishedContentType,
  PUBLISHED_PATH_PREFIX,
  PUBLISHABLE_TARGETS,
} from '../src/project/self-hosted-deploy.js';
import { createBuildService, BUILD_SLO_MS } from '../src/project/build-service.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createSandboxManager } from '../src/sandbox/sandbox-manager.js';
import { createCommandGuard } from '../src/sandbox/command-guard.js';
import { classifyCommand, createScriptedProvider } from '../src/engine/plumby.js';
import { createBuilderServer, securityHeaders, publishedSiteHeaders } from '../src/server/builder-server.js';
import { createAuthService } from '../src/auth/index.js';
import { composeProjectRuntime, platformSecretSet } from '../src/server/compose-runtime.js';
import { composePlatformOps } from '../src/ops/index.js';

// ---------------------------------------------------------------- test helpers

const OWNER = 'owner-engine';
const PROJECT = 'proj-engine';

/** A manual ms clock: every SLO below is measured against this, never a real wait. */
function manualClock(start = Date.UTC(2026, 2, 3, 12, 0, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    return t;
  };
  return now;
}

function tempDir(prefix = 'aab-engine-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A FAKE container backend with the REAL backend's shape, which "runs" a command by
 * invoking `script(spec)` — normally writing build output into the project's bind
 * mount, exactly as a real build inside the container would.
 *
 * IT MUST FAIL WHERE PRODUCTION FAILS. A plain CLI backend cannot install per-host
 * firewall rules, so it declares supportsEgressFiltering:false and REFUSES every
 * network mode but 'none'. A fake that accepted 'filtered' would hide a composition
 * that denies every command in production (the hazard called out in
 * test/runtime-wiring.test.js).
 */
function fakeBackend({ script } = {}) {
  const runs = [];
  return {
    bin: 'fake-docker',
    image: 'fake:latest',
    runs,
    supportsEgressFiltering: false,
    supportsServices: true,
    isAvailable: async () => true,
    canLaunch: async () => true,
    async runOneShot(spec) {
      runs.push(spec);
      if (spec.network !== 'none') {
        throw new Error(`egress filtering unsupported: refusing network mode ${spec.network}`);
      }
      const result = typeof script === 'function' ? await script(spec) : {};
      return {
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        limitsApplied: true,
        limitsSupported: true,
        degraded: false,
        ...result,
      };
    },
    async remove() {
      return { removed: true };
    },
    async reapOrphans() {
      return { reaped: [], failed: [], skipped: [] };
    },
    async startService(spec) {
      const publish = Array.isArray(spec.publish) ? spec.publish : [];
      if (publish.length > 0 && spec.network === 'none') throw new Error('published ports require a routable network');
      return { ok: true, containerId: 'fake-1', code: 0, stdout: '', stderr: '', timedOut: false, limitsApplied: true, degraded: false };
    },
    async serviceStatus() {
      return { ok: true, exists: true, running: true, exitCode: null };
    },
    async serviceLogs() {
      return { ok: true, logs: '' };
    },
    async stopService() {
      return { ok: true, stopped: true };
    },
  };
}

/** Write a file (creating parents) inside a tree. */
function writeIn(root, rel, contents) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
}

/**
 * A whole REAL engine over a temp dir: real layout, real SandboxManager (fake CLI),
 * the real container build boundary, the real self-hosted publisher, and the REAL
 * BuildService composed over both, with a per-OWNER artifact path exactly as the
 * production composition does.
 */
function makeEngine({ script, now = manualClock(), packageJson, ownerOf } = {}) {
  const { dir, cleanup } = tempDir();
  const layout = createStorageLayout(dir);
  const backend = fakeBackend({ script });
  const sandboxManager = createSandboxManager({
    layout,
    backend,
    // Explicit, like the production composition: an empty allowlist selects total
    // deny ('none'), the only mode a plain CLI backend can honestly enforce.
    config: { packageRegistryHosts: [] },
  });
  const tree = layout.exportableProjectTree(PROJECT);
  fs.mkdirSync(tree, { recursive: true });
  if (packageJson !== null) {
    writeIn(tree, 'package.json', JSON.stringify(packageJson ?? { name: 'app', scripts: { build: 'node build.js' } }));
  }

  const containerBuild = createContainerBuild({ layout, sandboxManager, now, nowIso: () => new Date(now()).toISOString() });
  const publisher = createSelfHostedDeploy({
    layout,
    ownerOf: ownerOf ?? ((projectId) => (projectId === PROJECT ? OWNER : null)),
    signingKey: 'a-published-signing-key-of-at-least-32-chars',
    now,
  });
  const commandGuard = createCommandGuard({ manager: sandboxManager, classify: classifyCommand });
  const service = createBuildService({
    layout,
    buildBoundary: containerBuild.build,
    deployBoundary: publisher.deploy,
    commandGuard,
    now,
    artifactPathFor: ({ projectId, target }) => layout.controlBuildArtifactPath(OWNER, projectId, target),
  });

  return { dir, cleanup, layout, backend, sandboxManager, containerBuild, publisher, service, tree, now };
}

/** A build script that writes `files` into the mount's `dist/` and exits 0. */
function distWriter(files) {
  return (spec) => {
    for (const [rel, contents] of Object.entries(files)) writeIn(path.join(spec.mountSource, 'dist'), rel, contents);
    return { code: 0, stdout: 'built\n' };
  };
}

/** sha256 of every file under `root`, plus the target of any symlink. */
function digestTree(root) {
  const out = {};
  const walk = (absolute, prefix) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(absolute, entry.name);
      if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(full, rel);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root, '');
  return out;
}

// ==================================================== resolveBuildCommand (pure)

test('resolveBuildCommand prefers the target-specific script, then plain build, and always runs it through npm', () => {
  const specific = resolveBuildCommand({
    packageJson: { scripts: { 'build:web': 'vite build', build: 'echo generic' } },
    target: 'web',
  });
  assert.equal(specific.ok, true);
  assert.equal(specific.script, 'build:web', 'a target-specific script must win for a multi-target project');
  // The script BODY is never spliced into a command — npm interprets it in the box.
  assert.deepEqual(specific.command, ['npm', 'run', 'build:web']);

  const generic = resolveBuildCommand({ packageJson: { scripts: { build: 'tsc' } }, target: 'backend' });
  assert.equal(generic.script, 'build');
  assert.deepEqual(generic.command, ['npm', 'run', 'build']);
  assert.deepEqual(buildScriptPreference('backend'), ['build:backend', 'build']);
});

test('resolveBuildCommand REFUSES honestly rather than fabricating a build', () => {
  // No package.json at all.
  const none = resolveBuildCommand({ packageJson: null, target: 'web' });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_PACKAGE_JSON');

  // A manifest with no build script — the headline refusal.
  const noScript = resolveBuildCommand({ packageJson: { scripts: { test: 'node --test' } }, target: 'web' });
  assert.equal(noScript.ok, false);
  assert.equal(noScript.code, 'NO_BUILD_SCRIPT');
  assert.match(noScript.message, /REFUSED/);

  // A blank script body is not a usable build command.
  assert.equal(resolveBuildCommand({ packageJson: { scripts: { build: '   ' } }, target: 'web' }).ok, false);

  // mobile has its own queue-aware build service.
  assert.equal(resolveBuildCommand({ packageJson: { scripts: { build: 'x' } }, target: 'mobile' }).code, 'MOBILE_NOT_SUPPORTED_HERE');
  assert.equal(resolveBuildCommand({ packageJson: { scripts: { build: 'x' } }, target: 'toaster' }).code, 'INVALID_TARGET');

  // Declared dependencies with nothing installed is named, not left to fail deep in npm.
  const uninstalled = resolveBuildCommand({
    packageJson: { dependencies: { vite: '^5' }, scripts: { build: 'vite build' } },
    target: 'web',
    hasNodeModules: false,
  });
  assert.equal(uninstalled.code, 'DEPENDENCIES_NOT_INSTALLED');
  // ...and installing them clears it.
  assert.equal(
    resolveBuildCommand({
      packageJson: { dependencies: { vite: '^5' }, scripts: { build: 'vite build' } },
      target: 'web',
      hasNodeModules: true,
    }).ok,
    true,
  );
  // A project with no dependencies at all still builds without node_modules.
  assert.equal(resolveBuildCommand({ packageJson: { scripts: { build: 'node b.js' } }, target: 'web' }).ok, true);
});

// ================================================================= logTail (pure)

test('logTail is bounded by BOTH lines and bytes, keeps the END, and can be redacted', () => {
  const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const tailed = logTail(many, { lines: 5, bytes: 10_000 });
  assert.match(tailed, /line 99$/, 'the end of the output is what explains a failure');
  assert.match(tailed, /95 earlier lines omitted/);
  assert.equal(tailed.split('\n').length, 6, '5 kept lines plus the notice');

  const long = 'x'.repeat(5_000);
  const capped = logTail(long, { lines: 40, bytes: 100 });
  assert.ok(Buffer.byteLength(capped, 'utf8') < 300, 'a byte ceiling must apply even to one huge line');
  assert.match(capped, /earlier bytes omitted/);

  // A multibyte tail is never cut mid-sequence.
  const multibyte = '€'.repeat(500);
  assert.ok(logTail(multibyte, { lines: 40, bytes: 51 }).includes('€'));
  assert.ok(!logTail(multibyte, { lines: 40, bytes: 51 }).includes('\ufffd'), 'no replacement char: the cut respects UTF-8');

  // The redactor seam is applied before any bounding.
  assert.match(logTail('token=hunter2 failed', { redact: (t) => t.replace('hunter2', '[REDACTED]') }), /\[REDACTED\]/);
  assert.equal(logTail(''), '');
  assert.equal(logTail([undefined, '']), '');
});

// ======================================================== artifact bundle (pure)

test('the artifact bundle round-trips text AND binary, deterministically, and rejects unsafe paths', () => {
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x10]);
  const files = [
    { path: 'b/app.js', bytes: Buffer.from('console.log(1)', 'utf8') },
    { path: 'index.html', bytes: Buffer.from('<h1>hi</h1>', 'utf8') },
    { path: 'a/logo.png', bytes: binary },
  ];
  const encoded = encodeArtifactBundle({ projectId: PROJECT, target: 'web', outputDir: 'dist', files, builtAt: 'T' });
  // Deterministic: the same output produces the same artifact bytes regardless of order.
  assert.equal(encoded, encodeArtifactBundle({ projectId: PROJECT, target: 'web', outputDir: 'dist', files: [...files].reverse(), builtAt: 'T' }));

  const decoded = decodeArtifactBundle(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.bundle.version, ARTIFACT_BUNDLE_VERSION);
  assert.deepEqual(decoded.files.map((f) => f.path), ['a/logo.png', 'b/app.js', 'index.html']);
  assert.ok(decoded.files[0].bytes.equals(binary), 'binary content survives byte-for-byte');
  assert.equal(decoded.files[2].bytes.toString('utf8'), '<h1>hi</h1>');

  // A tampered artifact is refused, never partially materialized.
  assert.equal(decodeArtifactBundle('not json').code, 'ARTIFACT_UNPARSEABLE');
  assert.equal(decodeArtifactBundle(JSON.stringify({ version: 'other', files: [] })).code, 'ARTIFACT_UNSUPPORTED');
  const traversal = JSON.stringify({
    version: ARTIFACT_BUNDLE_VERSION,
    files: [{ path: '../../escape.sh', encoding: 'utf8', content: 'x' }],
  });
  assert.equal(decodeArtifactBundle(traversal).code, 'ARTIFACT_UNSAFE_PATH');
  assert.equal(isSafeRelativePath('a/b.css'), true);
  for (const bad of ['../x', '/abs', 'a//b', 'a/./b', 'c:/x', 'a\\b', 'nul\0l', '']) {
    assert.equal(isSafeRelativePath(bad), false, `${JSON.stringify(bad)} must not be a safe relative path`);
  }
});

// ============================================== REAL build through REAL services

test('a successful build runs INSIDE the Isolation_Boundary and writes a REAL per-owner artifact', async () => {
  const now = manualClock();
  const engine = makeEngine({ now, script: distWriter({ 'index.html': '<h1>v1</h1>', 'assets/app.js': 'console.log(1)' }) });
  try {
    const result = await engine.service.build({ projectId: PROJECT, target: 'web' });
    assert.equal(result.ok, true, result.message);

    // It really ran through the boundary, as an ARGV VECTOR, in a container whose
    // mount is EXACTLY this project's tree and whose network is total-deny.
    assert.equal(engine.backend.runs.length, 1);
    const run = engine.backend.runs[0];
    assert.deepEqual(run.command, ['npm', 'run', 'build']);
    assert.equal(run.mountSource, engine.layout.exportableProjectTree(PROJECT));
    assert.equal(run.network, 'none');
    assert.equal(run.timeoutMs, BUILD_SLO_MS, 'the build SLO is threaded down to the boundary');

    // A REAL Deployment_Artifact record...
    assert.equal(result.artifact.targetKind, 'web');
    assert.equal(result.artifact.exitStatus, 0);
    // ...whose bytes are a REAL file, under the PER-OWNER control path.
    const expectedPath = engine.layout.controlBuildArtifactPath(OWNER, PROJECT, 'web');
    assert.equal(result.artifactPath, expectedPath);
    assert.ok(fs.existsSync(expectedPath), 'the artifact bytes must be a real file on disk');
    assert.ok(expectedPath.includes(`${path.sep}${OWNER}${path.sep}`), 'artifacts are keyed by owner, not pooled');
    assert.equal(engine.layout.isInsideExportTree(expectedPath), false, 'a build product must never enter an exportable tree');

    // ...and they carry the ACTUAL built bytes, not a placeholder string.
    const bundle = decodeArtifactBundle(fs.readFileSync(expectedPath, 'utf8'));
    assert.equal(bundle.ok, true);
    assert.deepEqual(bundle.files.map((f) => f.path), ['assets/app.js', 'index.html']);
    assert.equal(bundle.files[1].bytes.toString('utf8'), '<h1>v1</h1>');
    assert.equal(bundle.bundle.outputDir, 'dist');
    assert.deepEqual(engine.service.artifactFor(PROJECT, 'web'), result.artifact);
  } finally {
    engine.cleanup();
  }
});

test('a project with no build script is REFUSED, launches nothing, and produces NO artifact', async () => {
  const engine = makeEngine({ packageJson: { name: 'app', scripts: { test: 'node --test' } } });
  try {
    const result = await engine.service.build({ projectId: PROJECT, target: 'web' });
    assert.equal(result.ok, false, 'a build that cannot happen must never report success');
    assert.equal(result.code, 'BUILD_FAILED');
    assert.equal(result.exitStatus, REFUSED_EXIT_STATUS);
    assert.match(result.message, /NO_BUILD_SCRIPT/);
    assert.equal(engine.backend.runs.length, 0, 'a refusal must not spend a container launch');
    assert.equal(engine.service.artifactFor(PROJECT, 'web'), null);
    assert.equal(fs.existsSync(engine.layout.controlBuildArtifactPath(OWNER, PROJECT, 'web')), false);
  } finally {
    engine.cleanup();
  }
});

test('a build that exits 0 but writes no conventional output directory is REFUSED', async () => {
  const engine = makeEngine({ script: () => ({ code: 0, stdout: 'nothing to do\n' }) });
  try {
    const result = await engine.service.build({ projectId: PROJECT, target: 'web' });
    assert.equal(result.ok, false);
    assert.match(result.message, /NO_BUILD_OUTPUT/);
    assert.match(result.message, new RegExp(OUTPUT_DIR_PREFERENCE.join('.*')));
    assert.equal(engine.service.artifactFor(PROJECT, 'web'), null);
  } finally {
    engine.cleanup();
  }
});

test('a FAILED build surfaces the exit status plus a BOUNDED log tail, and writes NO artifact', async () => {
  const noise = Array.from({ length: 500 }, (_, i) => `webpack noise ${i}`).join('\n');
  const engine = makeEngine({
    script: () => ({ code: 2, stdout: noise, stderr: `${noise}\nERROR: Cannot find module 'missing'` }),
  });
  try {
    const result = await engine.service.build({ projectId: PROJECT, target: 'web' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BUILD_FAILED');
    assert.equal(result.exitStatus, 2, "the script's own exit status is reported, not a synthetic one");
    assert.match(result.message, /Cannot find module 'missing'/, 'the CAUSE must reach the caller');
    assert.match(result.message, /earlier lines omitted/, 'the tail must be bounded, not the whole log');
    assert.ok(result.message.length < 5_000, `a failure cause must stay bounded (was ${result.message.length})`);
    assert.equal(engine.service.artifactFor(PROJECT, 'web'), null);
    assert.equal(fs.existsSync(engine.layout.controlBuildArtifactPath(OWNER, PROJECT, 'web')), false, 'a failed build must leave no artifact');
  } finally {
    engine.cleanup();
  }
});

test('a build killed at the boundary limit reports a timed-out status; over-SLO on the clock yields BUILD_TIMEOUT and no artifact', async () => {
  const now = manualClock();
  // The boundary itself killed the run (SandboxManager's wall-clock reaper), AND the
  // injected clock crossed the 300s SLO — the two independent guarantees.
  const engine = makeEngine({
    now,
    script: () => {
      now.advance(BUILD_SLO_MS + 1);
      return { code: null, stdout: '', stderr: 'killed', timedOut: true };
    },
  });
  try {
    // The boundary's own mapping first, in isolation.
    const boundary = await engine.containerBuild.build({ projectId: PROJECT, target: 'web', timeoutMs: 1_000 });
    assert.equal(boundary.exitStatus, TIMED_OUT_EXIT_STATUS);
    assert.equal(boundary.code, 'BUILD_TIMED_OUT');
    assert.equal(boundary.timedOut, true);

    // ...and through the service, where the SLO verdict is the clock's.
    const result = await engine.service.build({ projectId: PROJECT, target: 'web' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BUILD_TIMEOUT');
    assert.ok(result.buildMs > BUILD_SLO_MS);
    assert.equal(engine.service.artifactFor(PROJECT, 'web'), null);
    assert.equal(fs.existsSync(engine.layout.controlBuildArtifactPath(OWNER, PROJECT, 'web')), false);
  } finally {
    engine.cleanup();
  }
});

test('a build denied at the Isolation_Boundary is reported as a denial, not as the script failing', async () => {
  const engine = makeEngine();
  try {
    // A backend that cannot enforce the requested network refuses the launch, and
    // SandboxManager turns that into denied:true / deniedReason:'launch-failure'.
    const sandboxManager = createSandboxManager({
      layout: engine.layout,
      backend: fakeBackend(),
      // A populated allowlist selects 'filtered', which the plain CLI backend (and
      // this fake, mirroring it) refuses — exactly as in production.
      config: { packageRegistryHosts: ['registry.npmjs.org'] },
    });
    const boundary = createContainerBuild({ layout: engine.layout, sandboxManager });
    const result = await boundary.build({ projectId: PROJECT, target: 'web', timeoutMs: 1_000 });
    assert.equal(result.code, 'BUILD_DENIED');
    assert.notEqual(result.exitStatus, 0);
    assert.match(result.stderr, /denied the build/);
  } finally {
    engine.cleanup();
  }
});

// ============================================ REAL self-hosted publish + serving

test('manifestEntriesFor serves exactly what was built — index routes, no listings', () => {
  const entries = manifestEntriesFor([
    { path: 'index.html' },
    { path: 'about/index.html' },
    { path: 'assets/app.js' },
    { path: '../escape' },
  ]);
  assert.equal(entries['/'], 'index.html');
  assert.equal(entries['/index.html'], 'index.html');
  assert.equal(entries['/about/'], 'about/index.html');
  assert.equal(entries['/about'], 'about/index.html');
  assert.equal(entries['/assets/app.js'], 'assets/app.js');
  // A directory with no index.html gets NO key at all: no listing is ever served.
  assert.equal(Object.hasOwn(entries, '/assets/'), false);
  assert.equal(Object.hasOwn(entries, '/../escape'), false, 'an unsafe path is dropped, never keyed');
  assert.equal(publishedContentType('a/b.css'), 'text/css; charset=utf-8');
  assert.equal(publishedContentType('a/b.unknown'), 'application/octet-stream', 'an unknown type is never sniffed');
});

test('a deploy publishes the artifact to a per-owner control path and returns a URL that really serves it', async () => {
  const now = manualClock();
  const engine = makeEngine({ now, script: distWriter({ 'index.html': '<h1>v1</h1>', 'assets/app.js': 'let x=1', 'logo.png': Buffer.from([1, 2, 3]) }) });
  try {
    const built = await engine.service.build({ projectId: PROJECT, target: 'web' });
    assert.equal(built.ok, true);

    const deployed = await engine.service.deploy({ projectId: PROJECT, artifact: built.artifact, destination: 'self-hosted' });
    assert.equal(deployed.ok, true, deployed.message);
    assert.equal(deployed.url, engine.publisher.urlFor({ ownerId: OWNER, projectId: PROJECT, target: 'web' }));
    assert.ok(deployed.url.startsWith(`${PUBLISHED_PATH_PREFIX}/${PROJECT}/web/`), deployed.url);
    assert.equal(engine.service.deployedUrl(PROJECT, 'web'), deployed.url);

    // The published release is REAL, on disk, out of every exportable tree, per owner.
    const siteDir = engine.layout.controlPublishedSitePath(OWNER, PROJECT, 'web');
    assert.equal(engine.layout.isInsideExportTree(siteDir), false);
    assert.ok(siteDir.includes(`${path.sep}${OWNER}${path.sep}`));
    const current = fs.realpathSync(path.join(siteDir, 'current'));
    assert.equal(fs.readFileSync(path.join(current, 'index.html'), 'utf8'), '<h1>v1</h1>');
    assert.ok(fs.readFileSync(path.join(current, 'logo.png')).equals(Buffer.from([1, 2, 3])), 'binary output survives publish');

    // ...and the read side really serves it, by manifest key.
    const signature = engine.publisher.signatureFor({ ownerId: OWNER, projectId: PROJECT, target: 'web' });
    const root = engine.publisher.lookup({ projectId: PROJECT, target: 'web', signature, requestPath: '/' });
    assert.equal(root.ok, true);
    assert.equal(root.body.toString('utf8'), '<h1>v1</h1>');
    assert.equal(root.contentType, 'text/html; charset=utf-8');
    assert.equal(engine.publisher.lookup({ projectId: PROJECT, target: 'web', signature, requestPath: '/assets/app.js' }).contentType, 'text/javascript; charset=utf-8');
  } finally {
    engine.cleanup();
  }
});

test('a published site discloses NOTHING for a bad signature, an unlisted path, a traversal or an unknown project', async () => {
  const engine = makeEngine({ script: distWriter({ 'index.html': 'ok', 'assets/app.js': 'x' }) });
  try {
    const built = await engine.service.build({ projectId: PROJECT, target: 'web' });
    await engine.service.deploy({ projectId: PROJECT, artifact: built.artifact });
    const signature = engine.publisher.signatureFor({ ownerId: OWNER, projectId: PROJECT, target: 'web' });

    const miss = (over) => engine.publisher.lookup({ projectId: PROJECT, target: 'web', signature, requestPath: '/', ...over });
    // The capability is the whole access control: one wrong hex nibble serves nothing.
    const wrong = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    assert.deepEqual(miss({ signature: wrong }), { ok: false });
    assert.deepEqual(miss({ signature: 'not-hex' }), { ok: false });
    assert.deepEqual(miss({ signature: signature.slice(0, 8) }), { ok: false }, 'a truncated signature must not be accepted');
    // Traversal cannot work: the path is only ever a manifest KEY.
    assert.deepEqual(miss({ requestPath: '/../../../../etc/passwd' }), { ok: false });
    assert.deepEqual(miss({ requestPath: '/../manifest.json' }), { ok: false });
    // No directory listing, and no key that the publish did not record.
    assert.deepEqual(miss({ requestPath: '/assets/' }), { ok: false });
    assert.deepEqual(miss({ requestPath: '/nope.html' }), { ok: false });
    // Prototype keys cannot resolve through the manifest object.
    assert.deepEqual(miss({ requestPath: '/__proto__' }), { ok: false });
    assert.deepEqual(miss({ requestPath: '/constructor' }), { ok: false });
    // Malformed / unknown identifiers, and a project that resolves to no owner.
    assert.deepEqual(miss({ projectId: '../other' }), { ok: false });
    assert.deepEqual(miss({ projectId: 'not-a-project' }), { ok: false });
    assert.deepEqual(miss({ target: 'backend' }), { ok: false });
    assert.deepEqual(miss({ requestPath: '/index.html\0' }), { ok: false });
    // The one legitimate request still works, so the misses above are not vacuous.
    assert.equal(miss({}).ok, true);
  } finally {
    engine.cleanup();
  }
});

test('a FAILED publish leaves the PREVIOUSLY deployed release byte-for-byte unchanged', async () => {
  const now = manualClock();
  let version = '<h1>v1</h1>';
  const engine = makeEngine({ now, script: (spec) => distWriter({ 'index.html': version })(spec) });
  try {
    const first = await engine.service.build({ projectId: PROJECT, target: 'web' });
    const deployed = await engine.service.deploy({ projectId: PROJECT, artifact: first.artifact });
    assert.equal(deployed.ok, true);

    const siteDir = engine.layout.controlPublishedSitePath(OWNER, PROJECT, 'web');
    const before = digestTree(siteDir);
    const signature = engine.publisher.signatureFor({ ownerId: OWNER, projectId: PROJECT, target: 'web' });
    const servedBefore = engine.publisher.lookup({ projectId: PROJECT, target: 'web', signature, requestPath: '/' }).body;

    // A second build produces v2, then its artifact is CORRUPTED on disk (a torn
    // write, a truncated copy) — the publish must fail without touching the live site.
    version = '<h1>v2</h1>';
    const second = await engine.service.build({ projectId: PROJECT, target: 'web' });
    assert.equal(second.ok, true);
    fs.writeFileSync(second.artifactPath, '{"version":"aab-artifact/1","files":[{"path":"ok.html"');

    const failed = await engine.service.deploy({ projectId: PROJECT, artifact: second.artifact });
    assert.equal(failed.ok, false, 'a corrupted artifact must not publish');
    assert.equal(failed.code, 'DEPLOY_FAILED');
    assert.equal(failed.priorUrl, deployed.url, 'the prior deployed URL is reported unchanged');
    assert.equal(engine.service.deployedUrl(PROJECT, 'web'), deployed.url);

    // THE GUARANTEE: the site directory is byte-for-byte what it was.
    assert.deepEqual(digestTree(siteDir), before, 'a failed publish must not change one byte of the live release');
    const servedAfter = engine.publisher.lookup({ projectId: PROJECT, target: 'web', signature, requestPath: '/' }).body;
    assert.equal(servedAfter.toString('utf8'), servedBefore.toString('utf8'));
    assert.equal(servedAfter.toString('utf8'), '<h1>v1</h1>', 'the previous release is still the one being served');

    // And a subsequent GOOD publish of v2 does swap it in atomically.
    const third = await engine.service.build({ projectId: PROJECT, target: 'web' });
    const ok = await engine.service.deploy({ projectId: PROJECT, artifact: third.artifact });
    assert.equal(ok.ok, true);
    assert.equal(
      engine.publisher.lookup({ projectId: PROJECT, target: 'web', signature, requestPath: '/' }).body.toString('utf8'),
      '<h1>v2</h1>',
    );
    assert.equal(ok.url, deployed.url, 'the capability URL is stable across releases');
  } finally {
    engine.cleanup();
  }
});

test('the deploy boundary refuses a vendor destination and a non-servable Target instead of faking either', async () => {
  const engine = makeEngine({ script: distWriter({ 'index.html': 'ok' }) });
  try {
    const built = await engine.service.build({ projectId: PROJECT, target: 'web' });

    // An external hosting provider is a FUTURE adapter behind this same seam.
    const vendor = await engine.service.deploy({ projectId: PROJECT, artifact: built.artifact, destination: 'vercel' });
    assert.equal(vendor.ok, false);
    assert.match(vendor.message, /UNSUPPORTED_DESTINATION/);
    assert.match(vendor.message, /future adapter behind this same deployBoundary seam/);
    assert.equal(engine.service.deployedUrl(PROJECT, 'web'), null, 'a refused destination must deploy nothing');

    // A static publish cannot honestly serve a backend Target.
    const backendish = await engine.publisher.deploy({ projectId: PROJECT, artifact: { targetKind: 'backend', path: built.artifactPath } });
    assert.equal(backendish.ok, false);
    assert.equal(backendish.code, 'TARGET_NOT_PUBLISHABLE');
    assert.deepEqual([...PUBLISHABLE_TARGETS], ['web', 'shared']);

    // An unregistered project has no per-owner location to publish under.
    const orphan = createSelfHostedDeploy({ layout: engine.layout, ownerOf: () => null, signingKey: 'x'.repeat(32) });
    assert.equal((await orphan.deploy({ projectId: PROJECT, artifact: built.artifact })).code, 'NO_OWNER');
  } finally {
    engine.cleanup();
  }
});

// ================================================ the published-site HTTP route

test('publishedSiteHeaders only ever ADDS to the baseline policy (a published document cannot run script on our origin)', () => {
  const baseline = securityHeaders()['content-security-policy'];
  const headers = publishedSiteHeaders(baseline);
  assert.ok(headers['content-security-policy'].startsWith(baseline), 'every baseline directive must survive verbatim');
  assert.match(headers['content-security-policy'], /; sandbox$/, 'the sandbox directive is what blocks generated script');
  assert.equal(headers['cache-control'], 'no-store');
  assert.match(headers['x-robots-tag'], /noindex/);
});

// ======================================== the composed runtime, end to end (HTTP)

/** A composed runtime over a temp dir with a fake, output-writing container backend. */
function makeRuntime({ dir, now = manualClock(), env = {}, script } = {}) {
  const composed = composePlatformOps({ secretProvider: platformSecretSet(env) });
  const runtime = composeProjectRuntime({
    composed,
    env: { AAB_DATA_DIR: dir, ...env },
    now,
    createBackend: () => fakeBackend({ script }),
  });
  return { composed, runtime, now };
}

/** A real server over a composed runtime, plus a helper to mint real sessions. */
async function startServer({ runtime, composed }) {
  const authService = createAuthService({
    idpVerifier: {
      async verifyIdToken(idToken) {
        if (!idToken) throw new Error('no token');
        return { provider: 'github', subject: idToken };
      },
    },
    auditSink: composed.auditLog,
  });
  const api = createBuilderServer({
    authService,
    provider: createScriptedProvider([]),
    observability: composed.observability,
    ...runtime.serverOptions(),
  });
  const { port, host } = await api.listen(0, '127.0.0.1');
  async function login(subject) {
    const { account } = await authService.authenticate({ idToken: subject });
    return { token: authService.scopeSession(account).token, account };
  }
  return { api, login, base: `http://${host}:${port}`, close: () => api.close() };
}

function post(base, token, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /settings/build + /settings/deploy are REACHABLE in the live composition and really build + publish', async () => {
  const { dir, cleanup } = tempDir('aab-wire-');
  const { runtime, composed } = makeRuntime({
    dir,
    script: (spec) => {
      writeIn(path.join(spec.mountSource, 'dist'), 'index.html', '<h1>deployed</h1>');
      writeIn(path.join(spec.mountSource, 'dist'), 'app.js', 'console.log("live")');
      return { code: 0, stdout: 'built\n' };
    },
  });
  const srv = await startServer({ runtime, composed });
  try {
    // The wiring itself: the engine is composed and offered to the server.
    assert.equal(Object.hasOwn(runtime.serverOptions(), 'projectLifecycle'), true, 'the real engine must be injected');
    assert.equal(Object.hasOwn(runtime.serverOptions(), 'publishedSites'), true);

    const alice = await srv.login('alice');
    const created = await post(srv.base, alice.token, '/projects', { description: 'a todo app', targetCategory: 'web', origin: 'blank' });
    assert.equal(created.status, 201);
    const projectId = (await created.json()).id;

    // Give the project a buildable manifest with no dependencies, so the build is
    // deterministic and does not depend on template content.
    writeIn(runtime.layout.exportableProjectTree(projectId), 'package.json', JSON.stringify({ name: 'app', scripts: { build: 'node build.js' } }));

    const build = await post(srv.base, alice.token, '/settings/build', { projectId });
    assert.equal(build.status, 200, 'build must no longer be 405 — the engine is real now');
    const builtBody = await build.json();
    assert.equal(builtBody.outcome, 'succeeded', JSON.stringify(builtBody));
    assert.match(builtBody.summary, /built the web Target/);
    // A REAL artifact, under the REAL owner's control path.
    const artifactPath = runtime.layout.controlBuildArtifactPath(alice.account.id, projectId, 'web');
    assert.ok(fs.existsSync(artifactPath), 'the live composition must write a real artifact');

    const deploy = await post(srv.base, alice.token, '/settings/deploy', { projectId });
    assert.equal(deploy.status, 200);
    const deployBody = await deploy.json();
    assert.equal(deployBody.outcome, 'deployed', JSON.stringify(deployBody));
    assert.ok(deployBody.url.startsWith('/live/'), deployBody.url);
    // Only the safe { outcome, summary, url } crosses the wire.
    assert.deepEqual(Object.keys(deployBody).sort(), ['outcome', 'summary', 'url']);

    // THE POINT: the returned URL actually serves the built bytes.
    const served = await fetch(`${srv.base}${deployBody.url}`);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), '<h1>deployed</h1>');
    assert.equal(served.headers.get('content-type'), 'text/html; charset=utf-8');
    // ...under a policy that ADDS sandboxing to the baseline, so generated script
    // cannot execute on the platform origin and read the Web UI's session storage.
    assert.match(served.headers.get('content-security-policy'), /; sandbox$/);
    assert.ok(served.headers.get('content-security-policy').startsWith(securityHeaders()['content-security-policy']));
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff', 'the baseline headers still apply');

    const asset = await fetch(`${srv.base}${deployBody.url}app.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'console.log("live")');

    // No listing, no unlisted file, no traversal, no wrong capability.
    for (const suffix of ['nope.html', '%2e%2e%2fmanifest.json', '%2e%2e%2f%2e%2e%2f']) {
      const miss = await fetch(`${srv.base}${deployBody.url}${suffix}`);
      assert.equal(miss.status, 404, `${suffix} must not be served`);
      assert.equal(await miss.text(), 'not found');
    }
    const forged = deployBody.url.replace(/\/[0-9a-f]{32}\/$/, '/00000000000000000000000000000000/');
    assert.equal((await fetch(`${srv.base}${forged}`)).status, 404, 'a forged capability serves nothing');
    assert.equal((await fetch(`${srv.base}/live/${projectId}/web`)).status, 404, 'a URL with no capability serves nothing');
    assert.equal((await fetch(`${srv.base}/live/`)).status, 404);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('the build/deploy routes stay closed to an unauthenticated caller and to a non-owner (same non-disclosing 401)', async () => {
  const { dir, cleanup } = tempDir('aab-wire-auth-');
  const { runtime, composed } = makeRuntime({ dir, script: () => ({ code: 0 }) });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const bob = await srv.login('bob');
    assert.notEqual(alice.account.id, bob.account.id);
    const created = await post(srv.base, alice.token, '/projects', { description: 'a todo app', targetCategory: 'web', origin: 'blank' });
    const projectId = (await created.json()).id;

    for (const route of ['/settings/build', '/settings/deploy']) {
      // No token at all.
      const anon = await post(srv.base, null, route, { projectId });
      assert.equal(anon.status, 401, `${route} must not be drivable by an unauthenticated caller`);
      assert.deepEqual(await anon.json(), { error: 'access denied' });

      // A valid session on SOMEONE ELSE'S project — identical, non-disclosing 401.
      const other = await post(srv.base, bob.token, route, { projectId });
      assert.equal(other.status, 401);
      assert.deepEqual(await other.json(), { error: 'access denied' });

      // A garbage token is indistinguishable from either.
      const bogus = await post(srv.base, 'not-a-token', route, { projectId });
      assert.equal(bogus.status, 401);
      assert.deepEqual(await bogus.json(), { error: 'access denied' });
    }

    // Nothing was built or published for anyone by those rejected requests.
    assert.equal(fs.existsSync(runtime.layout.controlBuildArtifactPath(alice.account.id, projectId, 'web')), false);
    assert.equal(fs.existsSync(runtime.layout.controlBuildArtifactPath(bob.account.id, projectId, 'web')), false);
  } finally {
    await srv.close();
    cleanup();
  }
});

test('the live adapter maps a refusal to a NON-SUCCESS outcome with a safe reason, never a fake success', async () => {
  const { dir, cleanup } = tempDir('aab-wire-refuse-');
  const { runtime, composed } = makeRuntime({ dir, script: () => ({ code: 0 }) });
  const srv = await startServer({ runtime, composed });
  try {
    const alice = await srv.login('alice');
    const created = await post(srv.base, alice.token, '/projects', { description: 'a todo app', targetCategory: 'web', origin: 'blank' });
    const projectId = (await created.json()).id;
    // A project with no build script at all.
    writeIn(runtime.layout.exportableProjectTree(projectId), 'package.json', JSON.stringify({ name: 'app', scripts: {} }));

    const build = await post(srv.base, alice.token, '/settings/build', { projectId });
    assert.equal(build.status, 200);
    const body = await build.json();
    assert.notEqual(body.outcome, 'succeeded');
    assert.equal(body.outcome, 'failed');
    assert.match(body.summary, /NO_BUILD_SCRIPT/);
    assert.ok(body.summary.length <= 300, 'a surfaced reason stays bounded');
    assert.equal(Object.hasOwn(body, 'url'), false);

    // Deploying without a build is refused with an actionable reason.
    const deploy = await post(srv.base, alice.token, '/settings/deploy', { projectId });
    assert.equal(deploy.status, 200);
    const deployBody = await deploy.json();
    assert.equal(deployBody.outcome, 'failed');
    assert.match(deployBody.summary, /run a build first/);

    // An unregistered project resolves to no owner: refused, not written anywhere.
    const unknown = await post(srv.base, alice.token, '/settings/build', { projectId: 'no-such-project' });
    assert.equal(unknown.status, 401, 'an unresolvable project is denied at the gate, disclosing nothing');
  } finally {
    await srv.close();
    cleanup();
  }
});

test('two accounts building the same-named Target never share a directory (per-owner isolation)', async () => {
  const { dir, cleanup } = tempDir('aab-wire-owners-');
  const { runtime, composed } = makeRuntime({
    dir,
    script: (spec) => {
      writeIn(path.join(spec.mountSource, 'dist'), 'index.html', `<h1>${path.basename(spec.mountSource)}</h1>`);
      return { code: 0 };
    },
  });
  const srv = await startServer({ runtime, composed });
  try {
    const accounts = [];
    for (const who of ['alice', 'bob']) {
      const session = await srv.login(who);
      const created = await post(srv.base, session.token, '/projects', { description: 'a todo app', targetCategory: 'web', origin: 'blank' });
      const projectId = (await created.json()).id;
      writeIn(runtime.layout.exportableProjectTree(projectId), 'package.json', JSON.stringify({ name: who, scripts: { build: 'node b.js' } }));
      assert.equal((await (await post(srv.base, session.token, '/settings/build', { projectId })).json()).outcome, 'succeeded');
      const deployed = await (await post(srv.base, session.token, '/settings/deploy', { projectId })).json();
      assert.equal(deployed.outcome, 'deployed');
      accounts.push({ ...session, projectId, url: deployed.url });
    }

    const [a, b] = accounts;
    for (const { account, projectId } of accounts) {
      assert.ok(fs.existsSync(runtime.layout.controlBuildArtifactPath(account.id, projectId, 'web')));
      assert.ok(fs.existsSync(path.join(runtime.layout.controlPublishedSitePath(account.id, projectId, 'web'), 'current')));
    }
    // Distinct owner directories, and distinct capability URLs.
    assert.notEqual(
      runtime.layout.controlPublishedSitePath(a.account.id, a.projectId, 'web'),
      runtime.layout.controlPublishedSitePath(b.account.id, b.projectId, 'web'),
    );
    assert.notEqual(a.url, b.url);
    // Each URL serves ONLY its own project's bytes.
    assert.equal((await (await fetch(`${srv.base}${a.url}`)).text()).includes(a.projectId), true);
    assert.equal((await (await fetch(`${srv.base}${b.url}`)).text()).includes(b.projectId), true);
  } finally {
    await srv.close();
    cleanup();
  }
});
