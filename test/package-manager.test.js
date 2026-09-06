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
 *   - no-partial-deps: the same two tests assert the exportable project tree
 *     contains ONLY the restored manifest — no node_modules / dep files. If the
 *     module ever persisted partial deps to the exportable tree, the directory
 *     listing assertion flips.
 *   - classifier-denied-cancels-cleanly: the CLASSIFIER-DENIED (refuse) and
 *     CONFIRM-DENIED tests assert the fake manager.exec was NEVER called
 *     (spy count === 0) AND the on-disk manifest equals the prior bytes AND
 *     code === 'CLASSIFIER_DENIED'. Removing the denial short-circuit would let
 *     exec run (count becomes 1) and/or leave the manifest changed — both flip.
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
function fakeManager(result = {}) {
  const calls = [];
  return {
    calls,
    exec: async (projectId, command, opts) => {
      calls.push({ projectId, command, opts });
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
  assert.equal(res.code, 'CLASSIFIER_DENIED');
  assert.equal(res.outcome, 'confirm');
  assert.equal(res.manifestRestored, true);
  assert.deepEqual(listTree(treeRoot), ['package.json']);
});

// ---------------------------------------------------------------- (3) INSTALL-FAILURE

test('INSTALL-FAILURE (Req 17.3): allow-class command, non-zero exit — output reported, manifest restored, no partial deps', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  const prior = seedManifest(manifestPath, PRIOR_MANIFEST);

  // The command executed inside the box but the installer failed (denied:false).
  const manager = fakeManager({
    exitCode: 1,
    denied: false,
    stdout: '',
    stderr: 'npm ERR! 404 Not Found - GET https://registry/does-not-exist',
  });
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
  // (c) no partial dep files: only the restored manifest lives in the tree.
  assert.deepEqual(listTree(treeRoot), ['package.json']);
});

// ---------------------------------------------------------------- (4) INSTALL-TIMEOUT (injected clock)

test('INSTALL-TIMEOUT (Req 17.3): boundary timeout via INJECTED clock — timeoutMs threaded, output reported, manifest restored', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  const prior = seedManifest(manifestPath, PRIOR_MANIFEST);

  // The boundary's wall-clock reaper fired at the ceiling: exitCode null,
  // denied true, deniedReason 'timeout', timedOut true — NO real waiting here.
  const manager = fakeManager({
    exitCode: null,
    denied: true,
    deniedReason: 'timeout',
    timedOut: true,
    stderr: 'installer output at kill: still resolving...',
  });
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

  // manifest restored + no partial deps.
  assert.equal(readManifest(manifestPath), prior, 'manifest restored on timeout');
  assert.deepEqual(listTree(treeRoot), ['package.json']);
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

// ---------------------------------------------------------------- (5) SUCCESS

test('SUCCESS (Req 17.1/17.2): allow-class command, exit 0 — new manifest kept, exec ran once through the guard', async (t) => {
  const { layout, treeRoot, manifestPath } = freshLayout(t);
  seedManifest(manifestPath, PRIOR_MANIFEST);

  const manager = fakeManager({ exitCode: 0, denied: false, stdout: 'added 1 package' });
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
  // still only the manifest in the exportable tree (no partial deps written).
  assert.deepEqual(listTree(treeRoot), ['package.json']);
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
