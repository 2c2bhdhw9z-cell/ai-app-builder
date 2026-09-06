/**
 * Package_Manager tests (node --test) — spec Task 19.2, Req 17.1–17.5.
 *
 * The Package_Manager (src/sandbox/package-manager.js) is the thin COMPOSING
 * layer that turns "the Builder_Agent added a dependency to the manifest, now
 * install it" into a contained, classifier-gated install. These tests follow
 * the repo's testing discipline and exercise REAL collaborators, not mocks of
 * the very seams under test:
 *   - a REAL CommandGuard (createCommandGuard from src/sandbox/command-guard.js)
 *     driven by the REAL plumby classifier (classifyCommand re-exported through
 *     THE plumby boundary at src/engine/plumby.js — NOT stubbed). So
 *     'npm install <spec>' genuinely classifies allow, 'npm publish' genuinely
 *     classifies confirm, and 'rm -rf / --no-preserve-root' genuinely refuses;
 *   - a REAL on-disk manifest under a REAL StorageLayout (createStorageLayout on
 *     an fs.mkdtempSync tmp dir), read/written by the module's default node:fs
 *     seams — so "manifest restored to prior bytes" is asserted against actual
 *     bytes on disk, and "exposes no partial deps" is asserted against the real
 *     exportable tree;
 *   - a FAKE SandboxManager `manager` implementing ONLY exec(projectId, command,
 *     {timeoutMs, signal}) and returning the REAL exec denial contract shape
 *     (see src/sandbox/sandbox-manager.js: { stdout, stderr, exitCode:number|null,
 *     denied, deniedReason:'launch-failure'|'timeout'|null, timedOut, signal,
 *     projectId, ... }). The fake is a spy so we can assert exec CALL COUNTS and
 *     the exact opts (timeoutMs) threaded down. The 300s ceiling is driven by an
 *     INJECTED CLOCK + the fake's boundary-timeout contract, never real waiting.
 *
 * MUTATION SENSITIVITY (documented for the reviewer — which assertion flips if
 * the corresponding behavior is reverted):
 *   - manifest-restore-on-failure: the INSTALL-FAILURE and INSTALL-TIMEOUT tests
 *     seed the manifest with PRIOR bytes, let install apply the addition (so the
 *     on-disk manifest genuinely differs mid-install), then assert the file is
 *     read back BYTE-FOR-BYTE equal to the prior bytes after the non-success.
 *     Deleting restoreManifest() on the failure/timeout path leaves the added
 *     dependency on disk, so `assert.equal(after, priorBytes)` flips to fail.
 *   - no-partial-deps: the INSTALL-FAILURE and INSTALL-TIMEOUT tests give the
 *     fake exec a side effect that WRITES a partial node_modules/<pkg>/index.js
 *     AND a package-lock.json into the read-write-mounted exportable tree (as a
 *     real `npm install` does) BEFORE returning the failure/timeout contract,
 *     then assert those artifacts are GONE after install() returns (tree lists
 *     only package.json). Reverting the Issue-1 cleanup leaves the artifacts on
 *     disk, so both the directory-listing and the existsSync assertions flip.
 *     A companion test writes a PRE-EXISTING node_modules and asserts it is
 *     preserved (only install-created paths are cleaned); the SUCCESS test
 *     asserts the installed deps PERSIST (cleanup must not run on success).
 *   - classifier-denied-cancels-cleanly: the CLASSIFIER-DENIED (refuse) and
 *     CONFIRM-DENIED tests assert the fake manager.exec was NEVER called
 *     (spy count === 0) AND the on-disk manifest equals the prior bytes. The
 *     refuse case asserts code === 'CLASSIFIER_DENIED'; the confirm-consent-
 *     denied case asserts code === 'CONFIRM_DENIED' (Issue 3 — the classifier
 *     answered 'confirm', so the denial is NOT misattributed to the classifier).
 *     Removing the denial short-circuit would let exec run (count becomes 1)
 *     and/or leave the manifest changed — both flip.
 *   - timeout-via-injected-clock: the INSTALL-TIMEOUT test uses an injected `now`
 *     counter and a fake exec returning { exitCode:null, denied:true,
 *     deniedReason:'timeout', timedOut:true } with NO real waiting; it asserts
 *     installTimeoutMs was threaded as opts.timeoutMs into exec, code ===
 *     'INSTALL_TIMEOUT', and (default) that the ceiling equals
 *     DEFAULT_INSTALL_TIMEOUT_MS. Reverting the timeout mapping (treating a
 *     timeout as success, or dropping the timeoutMs thread-through) flips these.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPackageManager, DEFAULT_INSTALL_TIMEOUT_MS } from '../src/sandbox/package-manager.js';
import { createCommandGuard } from '../src/sandbox/command-guard.js';
import { createStorageLayout } from '../src/storage/layout.js';

// ---------------------------------------------------------------- fakes/helpers

const PROJECT_ID = 'proj-1';

/**
 * A FAKE SandboxManager exposing ONLY exec(projectId, command, {timeoutMs,
 * signal}). It is a spy: every call is recorded (so we can assert the call
 * COUNT and the exact opts threaded down) and it returns a frozen result in the
 * REAL exec denial-contract shape. `result` is merged over the contract's
 * defaults so a test can model exit 0 (success), a non-zero exit (the command's
 * OWN failure, denied:false), or the boundary TIMEOUT contract.
 */
function fakeManager(result = {}, opts = {}) {
  const calls = [];
  const { onExec } = opts;
  return {
    calls,
    exec: async (projectId, command, execOpts) => {
      calls.push({ projectId, command, opts: execOpts });
      // A real install writes node_modules/ + a lockfile straight into the
      // read-write-mounted exportable tree. `onExec` lets a test model that
      // side effect BEFORE the exec contract is returned, so the no-partial-deps
      // assertions are meaningful (they would pass trivially if exec wrote
      // nothing). See the INSTALL-FAILURE / INSTALL-TIMEOUT tests.
      if (typeof onExec === 'function') onExec();
      return Object.freeze({
        stdout: '',
        stderr: '',
        exitCode: 0,
        denied: false,
        deniedReason: null,
        timedOut: false,
        signal: null,
        projectId,
        network: 'none',
        workspacePath: '/box',
        mountSource: '/src',
        limitsApplied: null,
        ...result,
      });
    },
  };
}

/** A fresh tmp StorageLayout + the manifest path for PROJECT_ID. */
function freshLayout(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-pkgmgr-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const layout = createStorageLayout(baseDir);
  const treeRoot = layout.exportableProjectTree(PROJECT_ID);
  const manifestPath = path.join(treeRoot, 'package.json');
  return { baseDir, layout, treeRoot, manifestPath };
}

/** Seed the manifest on disk with the given contents; return the bytes. */
function seedManifest(manifestPath, contents) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, contents, 'utf8');
  return contents;
}

/** Read the manifest back (or null if absent). */
function readManifest(manifestPath) {
  try {
    return fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write a partial dependency artifact into the exportable tree — a
 * node_modules/<pkg>/index.js AND a package-lock.json — modeling what a real
 * `npm install` materializes into the read-write mount before it fails/times
 * out. Used as the fake exec side effect so the no-partial-deps assertions
 * actually have something to assert against (Issue 2).
 */
function writePartialDeps(treeRoot, pkg = 'left-pad') {
  const modDir = path.join(treeRoot, 'node_modules', pkg);
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'index.js'), 'module.exports = () => {};\n', 'utf8');
  fs.writeFileSync(path.join(treeRoot, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
}

/** List the exportable tree's entries (top level) — used to prove no partial deps. */
function listTree(treeRoot) {
  try {
    return fs.readdirSync(treeRoot).sort();
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

const PRIOR_MANIFEST = `${JSON.stringify(
  { name: 'app', version: '1.0.0', dependencies: { 'left-pad': '^1.0.0' } },
  null,
  2,
)}\n`;

/** An injected clock: returns successive values from `ticks`, last value sticks. */
function fakeClock(ticks) {
  let i = 0;
  return () => {
    const v = ticks[Math.min(i, ticks.length - 1)];
    i += 1;
    return v;
  };
}

// ---------------------------------------------------------------- (1) CLASSIFIER-DENIED (refuse)

test('CLASSIFIER-DENIED (Req 17.5): a refuse-class command cancels cleanly — exec never runs, manifest unchanged', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  const prior = seedManifest(manifestPath, PRIOR_MANIFEST);

  const manager = fakeManager({ exitCode: 0 }); // must never be reached
  const guard = createCommandGuard({ manager }); // REAL guard + REAL classifier
  const pm = createPackageManager({
    layout,
    commandGuard: guard,
    // Force the install command to a genuinely refuse-class string. The REAL
    // plumby classifier rates this 'refuse', so the guard blocks it BEFORE exec.
    packageManagerCommand: () => 'rm -rf / --no-preserve-root',
  });

  const res = await pm.install({ projectId: PROJECT_ID, packageSpec: 'evil-pkg' });

  // (a) exec was NEVER called — the install was cancelled before touching the box.
  assert.equal(manager.calls.length, 0, 'refuse-class must never reach the Sandbox exec');
  // (b) on-disk manifest bytes equal the prior bytes (addition reverted).
  assert.equal(readManifest(manifestPath), prior, 'manifest must be restored to prior bytes');
  // (c) structured denial report citing the classifier.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'CLASSIFIER_DENIED');
  assert.equal(res.manifestRestored, true);
  assert.equal(res.outcome, 'refuse');
  assert.ok(res.reason, 'the classifier reason is reported');
  // no partial deps: only the manifest lives in the exportable tree.
  assert.deepEqual(listTree(treeRoot), ['package.json']);
});

// ---------------------------------------------------------------- (2) CONFIRM-DENIED

test('CONFIRM-DENIED (Req 17.5): a confirm-class command with consent denied cancels — exec never runs, manifest unchanged', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  const prior = seedManifest(manifestPath, PRIOR_MANIFEST);

  const manager = fakeManager({ exitCode: 0 }); // must never be reached
  const guard = createCommandGuard({ manager }); // REAL confirm path
  const pm = createPackageManager({
    layout,
    commandGuard: guard,
    // 'npm publish' genuinely classifies 'confirm' under the real classifier.
    packageManagerCommand: () => 'npm publish',
  });

  // Consent explicitly denied -> the guard does not execute.
  const res = await pm.install({
    projectId: PROJECT_ID,
    packageSpec: 'left-pad',
    onConfirmRequest: () => false,
  });

  assert.equal(manager.calls.length, 0, 'confirm-denied must never reach exec');
  assert.equal(readManifest(manifestPath), prior, 'manifest must be restored to prior bytes');
  assert.equal(res.ok, false);
  // Issue 3: a consent denial of a confirm-class command is NOT a classifier
  // denial (the classifier answered 'confirm'); it carries its own code so the
  // denial cause is not misattributed to the Permission_Classifier.
  assert.equal(res.code, 'CONFIRM_DENIED');
  assert.equal(res.outcome, 'confirm');
  assert.match(res.message, /consent was denied/);
  assert.equal(res.manifestRestored, true);
  assert.deepEqual(listTree(treeRoot), ['package.json']);
});

// ---------------------------------------------------------------- (3) INSTALL-FAILURE

test('INSTALL-FAILURE (Req 17.3): allow-class command, non-zero exit — output reported, manifest restored, no partial deps', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  const prior = seedManifest(manifestPath, PRIOR_MANIFEST);

  // The command executed inside the box but the installer failed (denied:false).
  // Its side effect writes a PARTIAL node_modules + lockfile into the read-write-
  // mounted exportable tree BEFORE the failure contract is returned, exactly as a
  // real `npm install` that 404s partway through would (Issue 2). The cleanup
  // added for Issue 1 must remove these on the non-success path.
  const manager = fakeManager(
    {
      exitCode: 1,
      denied: false,
      stdout: '',
      stderr: 'npm ERR! 404 Not Found - GET https://registry/does-not-exist',
    },
    { onExec: () => writePartialDeps(treeRoot) },
  );
  const guard = createCommandGuard({ manager });
  const pm = createPackageManager({ layout, commandGuard: guard });

  const res = await pm.install({ projectId: PROJECT_ID, packageSpec: 'does-not-exist' });

  // The command DID execute (allow-class), exactly once, through the guard.
  assert.equal(manager.calls.length, 1, 'allow-class runs exec exactly once');
  assert.match(manager.calls[0].command, /npm install does-not-exist/);

  // (a) failure reported, installer stderr surfaced.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INSTALL_FAILED');
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /npm ERR! 404 Not Found/);

  // (b) manifest RESTORED to the prior bytes (the addition reverted).
  assert.equal(readManifest(manifestPath), prior, 'manifest restored on failure');
  // (c) no partial dep files: the partial node_modules AND lockfile the install
  // wrote into the tree are GONE — only the restored manifest remains. This flips
  // to fail if the Issue-1 cleanup is reverted (the artifacts would survive).
  assert.deepEqual(listTree(treeRoot), ['package.json']);
  assert.equal(fs.existsSync(path.join(treeRoot, 'node_modules')), false, 'partial node_modules removed');
  assert.equal(fs.existsSync(path.join(treeRoot, 'package-lock.json')), false, 'partial lockfile removed');
});

// ---------------------------------------------------------------- (4) INSTALL-TIMEOUT (injected clock)

test('INSTALL-TIMEOUT (Req 17.3): boundary timeout via INJECTED clock — timeoutMs threaded, output reported, manifest restored', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  const prior = seedManifest(manifestPath, PRIOR_MANIFEST);

  // The boundary's wall-clock reaper fired at the ceiling: exitCode null,
  // denied true, deniedReason 'timeout', timedOut true — NO real waiting here.
  const manager = fakeManager(
    {
      exitCode: null,
      denied: true,
      deniedReason: 'timeout',
      timedOut: true,
      stderr: 'installer output at kill: still resolving...',
    },
    // The reaper fired mid-install: a partial node_modules + lockfile were
    // already written into the read-write-mounted tree before the kill (Issue 2).
    { onExec: () => writePartialDeps(treeRoot) },
  );
  const guard = createCommandGuard({ manager });
  // Injected clock advances 0 -> 300000 so durationMs is derived from it, not
  // from real wall-clock time.
  const pm = createPackageManager({
    layout,
    commandGuard: guard,
    now: fakeClock([0, DEFAULT_INSTALL_TIMEOUT_MS]),
    // installTimeoutMs left as default so we can assert the DEFAULT ceiling.
  });

  // The package manager's ceiling is the DEFAULT 300s value.
  assert.equal(pm.installTimeoutMs, DEFAULT_INSTALL_TIMEOUT_MS);
  assert.equal(DEFAULT_INSTALL_TIMEOUT_MS, 300_000);

  const res = await pm.install({ projectId: PROJECT_ID, packageSpec: 'slow-pkg' });

  // installTimeoutMs was threaded as opts.timeoutMs into exec (the 300s ceiling).
  assert.equal(manager.calls.length, 1);
  assert.equal(manager.calls[0].opts.timeoutMs, DEFAULT_INSTALL_TIMEOUT_MS);

  // timeout classified as INSTALL_TIMEOUT, installer output reported.
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INSTALL_TIMEOUT');
  assert.equal(res.timedOut, true);
  assert.match(res.stderr, /installer output at kill/);
  // durationMs derived from the injected clock (300000 - 0).
  assert.equal(res.durationMs, DEFAULT_INSTALL_TIMEOUT_MS);

  // manifest restored + no partial deps: the partial node_modules + lockfile the
  // reaped install wrote are GONE (Issue 1 cleanup on the timeout path).
  assert.equal(readManifest(manifestPath), prior, 'manifest restored on timeout');
  assert.deepEqual(listTree(treeRoot), ['package.json']);
  assert.equal(fs.existsSync(path.join(treeRoot, 'node_modules')), false, 'partial node_modules removed on timeout');
  assert.equal(fs.existsSync(path.join(treeRoot, 'package-lock.json')), false, 'partial lockfile removed on timeout');
});

// Also assert a custom installTimeoutMs is threaded through (thread-through is
// not hard-coded to the default).
test('INSTALL-TIMEOUT: a custom installTimeoutMs is threaded to exec as timeoutMs', async (t) => {
  const { layout, manifestPath } = freshLayout(t);
  seedManifest(manifestPath, PRIOR_MANIFEST);

  const manager = fakeManager({
    exitCode: null,
    denied: true,
    deniedReason: 'timeout',
    timedOut: true,
    stderr: 'killed',
  });
  const guard = createCommandGuard({ manager });
  const pm = createPackageManager({
    layout,
    commandGuard: guard,
    installTimeoutMs: 42_000,
    now: fakeClock([0, 42_000]),
  });

  const res = await pm.install({ projectId: PROJECT_ID, packageSpec: 'slow-pkg' });
  assert.equal(manager.calls[0].opts.timeoutMs, 42_000);
  assert.equal(res.code, 'INSTALL_TIMEOUT');
});

// ------------------------------------------------ NO-PARTIAL-DEPS: only install-created artifacts are cleaned

test('INSTALL-FAILURE: a PRE-EXISTING node_modules is preserved — only artifacts the install created are cleaned', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  const prior = seedManifest(manifestPath, PRIOR_MANIFEST);

  // The Builder_Agent already had a node_modules with an existing dep BEFORE
  // this install. The failed install then adds a NEW package's files + a
  // lockfile. Cleanup must remove ONLY what this install created, never the
  // pre-existing node_modules content.
  const existingDir = path.join(treeRoot, 'node_modules', 'already-here');
  fs.mkdirSync(existingDir, { recursive: true });
  fs.writeFileSync(path.join(existingDir, 'index.js'), 'module.exports = 1;\n', 'utf8');

  const manager = fakeManager(
    {
      exitCode: 1,
      denied: false,
      stderr: 'npm ERR! 404 Not Found',
    },
    {
      onExec: () => {
        // The install materializes a NEW package into the same node_modules and
        // writes a fresh lockfile.
        const newDir = path.join(treeRoot, 'node_modules', 'does-not-exist');
        fs.mkdirSync(newDir, { recursive: true });
        fs.writeFileSync(path.join(newDir, 'index.js'), 'module.exports = 2;\n', 'utf8');
        fs.writeFileSync(path.join(treeRoot, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
      },
    },
  );
  const guard = createCommandGuard({ manager });
  const pm = createPackageManager({ layout, commandGuard: guard });

  const res = await pm.install({ projectId: PROJECT_ID, packageSpec: 'does-not-exist' });

  assert.equal(res.code, 'INSTALL_FAILED');
  assert.equal(readManifest(manifestPath), prior, 'manifest restored on failure');
  // The PRE-EXISTING node_modules content survives (node_modules pre-existed the
  // install, so it is not one of the paths the install created).
  assert.equal(
    fs.existsSync(path.join(treeRoot, 'node_modules', 'already-here', 'index.js')),
    true,
    'pre-existing node_modules content preserved',
  );
  // The lockfile did NOT exist before the install, so it is removed.
  assert.equal(fs.existsSync(path.join(treeRoot, 'package-lock.json')), false, 'install-created lockfile removed');
});

// ---------------------------------------------------------------- (5) SUCCESS

test('SUCCESS (Req 17.1/17.2): allow-class command, exit 0 — new manifest kept, exec ran once through the guard', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  seedManifest(manifestPath, PRIOR_MANIFEST);

  // On SUCCESS the install's node_modules + lockfile MUST persist to the
  // exportable tree so the dependency is resolvable to the build/Dev_Server with
  // no extra step (Req 17.1/17.2). Model the successful install writing them and
  // assert the cleanup does NOT run on the success path.
  const manager = fakeManager(
    { exitCode: 0, denied: false, stdout: 'added 1 package' },
    { onExec: () => writePartialDeps(treeRoot, 'right-pad') },
  );
  const guard = createCommandGuard({ manager });
  const pm = createPackageManager({
    layout,
    commandGuard: guard,
    now: fakeClock([1000, 4000]),
  });

  const res = await pm.install({ projectId: PROJECT_ID, packageSpec: 'right-pad@^2.0.0' });

  // exec ran exactly once, through the guard, with the allow-class command.
  assert.equal(manager.calls.length, 1, 'allow-class runs exec exactly once');
  assert.match(manager.calls[0].command, /npm install right-pad@\^2\.0\.0/);

  // success contract.
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /added 1 package/);
  assert.equal(res.durationMs, 3000); // 4000 - 1000, from the injected clock

  // the NEW manifest (with the added dependency) remains on disk — NOT restored.
  const onDisk = readManifest(manifestPath);
  assert.notEqual(onDisk, PRIOR_MANIFEST, 'success keeps the new manifest, not the prior one');
  const parsed = JSON.parse(onDisk);
  assert.equal(parsed.dependencies['right-pad'], '^2.0.0');
  assert.equal(parsed.dependencies['left-pad'], '^1.0.0'); // prior dep preserved
  // On success the installed deps PERSIST (Req 17.1/17.2 — resolvable with no
  // extra step): the success path must NOT run the non-success cleanup.
  assert.equal(fs.existsSync(path.join(treeRoot, 'node_modules', 'right-pad', 'index.js')), true, 'installed node_modules kept on success');
  assert.equal(fs.existsSync(path.join(treeRoot, 'package-lock.json')), true, 'lockfile kept on success');
  assert.deepEqual(listTree(treeRoot), ['node_modules', 'package-lock.json', 'package.json']);
});

// ---------------------------------------------------------------- ROUTING (Req 17.4)

test('ROUTING (Req 17.4): refuse yields exec-count 0 while allow yields exec-count 1 — no un-gated path to exec', async (t) => {
  const { layout, manifestPath } = freshLayout(t);
  seedManifest(manifestPath, PRIOR_MANIFEST);

  // refuse verdict -> exec must not run.
  const refuseManager = fakeManager({ exitCode: 0 });
  const refusePm = createPackageManager({
    layout,
    commandGuard: createCommandGuard({ manager: refuseManager }),
    packageManagerCommand: () => 'rm -rf / --no-preserve-root',
  });
  await refusePm.install({ projectId: PROJECT_ID, packageSpec: 'x' });
  assert.equal(refuseManager.calls.length, 0, 'refuse -> exec count 0');

  // allow verdict -> exec runs exactly once.
  const allowManager = fakeManager({ exitCode: 0 });
  const allowPm = createPackageManager({
    layout,
    commandGuard: createCommandGuard({ manager: allowManager }),
  });
  await allowPm.install({ projectId: PROJECT_ID, packageSpec: 'left-pad' });
  assert.equal(allowManager.calls.length, 1, 'allow -> exec count 1');
});
