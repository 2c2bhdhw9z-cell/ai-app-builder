/**
 * THE PACKAGE MANAGER — dependency install INSIDE the Sandbox (spec Task 19.1,
 * Req 17.1–17.5).
 *
 * The Builder_Agent adds a dependency to the project's manifest and then invokes
 * the Package_Manager to install it. This module is the thin, COMPOSING layer
 * that turns that intent into a contained, classifier-gated install, reusing the
 * EXISTING seams rather than reinventing any of them:
 *
 *   - CLASSIFICATION + THE GATE: every package command is routed through the
 *     injected CommandGuard (src/sandbox/command-guard.js). The guard is the
 *     single point that runs plumby's PURE classifier (via the plumby boundary
 *     at src/engine/plumby.js) and, on `allow`, hands the command to the
 *     SandboxManager boundary underneath it. There is NO path in this module
 *     that reaches SandboxManager.exec without going through the guard (Req 17.4).
 *
 *   - CONTAINMENT: the install runs INSIDE the project's Isolation_Boundary (the
 *     same one-shot boundary the build / Dev_Server use), so a dependency
 *     installed on the SUCCESS path is resolvable to the build/Dev_Server with
 *     no extra step (Req 17.1/17.2). The boundary bind-mounts the project's
 *     EXPORTABLE tree read-write at /workspace (see sandbox-manager.js
 *     mountSource = layout.exportableProjectTree(projectId) and
 *     container-backend.js's read-write bind), so a real `npm install` writes
 *     node_modules/ and the lockfile STRAIGHT INTO the exportable tree. That is
 *     what makes a successful install resolvable with no extra step — but it
 *     also means a FAILED / TIMED-OUT / DENIED install can leave partially
 *     materialized dependency artifacts behind. To honor Req 17.3 ("expose no
 *     partially installed dependency files to the build"), this module SNAPSHOTS
 *     the dependency-output paths (node_modules + the known lockfiles) before
 *     the install and, on ANY non-success, removes any that the install created
 *     (paths absent before install) so no partial deps remain. The manifest is
 *     restored to its prior bytes in the same step.
 *
 *   - MANIFEST PERSISTENCE: the manifest is the project's package.json-style
 *     file inside the exportable project tree
 *     (layout.exportableProjectTree(projectId) joined with manifestRelPath). It
 *     is read/written through injectable readManifest / writeManifest seams whose
 *     defaults use node:fs with an atomic temp-file-then-rename write, mirroring
 *     the durability of persistence-store.js's defaultWriteTree.
 *
 * THE INSTALL CONTRACT (Req 17.1–17.5), in order:
 *   1. SNAPSHOT the prior manifest bytes from disk (the exact bytes to restore).
 *   2. APPLY the Builder_Agent's addition — write the new manifest (full new
 *      contents, or a package spec merged into `dependencies`) to disk, so the
 *      on-disk manifest already reflects the addition when install begins.
 *   3. ROUTE the install command through commandGuard.run under the 300s ceiling.
 *   4. DENIED (classifier refuse / blocked / confirm-denied — command did NOT
 *      execute): CANCEL — restore the manifest to the prior bytes, clean any
 *      dependency artifacts the install created, expose no partial deps, return
 *      { ok:false, code:'CLASSIFIER_DENIED'|'CONFIRM_DENIED', ... } (Req 17.5).
 *   5. FAILED / TIMED OUT (command executed but non-zero exit, or the boundary's
 *      wall-clock reaper fired at the ceiling): REPORT the installer output,
 *      restore the manifest, clean any partial dependency artifacts, expose no
 *      partial deps, return { ok:false, code:'INSTALL_FAILED'|'INSTALL_TIMEOUT',
 *      ... } (Req 17.3).
 *   6. SUCCESS (executed, exitCode 0): keep the new manifest, return
 *      { ok:true, ... } (Req 17.1/17.2).
 *
 * Conventions (mirroring src/project/self-healing.js and src/sandbox/sandbox-manager.js):
 * a factory createX({...deps}) returning Object.freeze({...}); DI for the clock
 * (`now`) and every collaborator; structured { ok:true|false, code?, message? }
 * results for expected rejections (this module never throws on an expected path —
 * a denial / failure / timeout is REPORTED, not rethrown). Adds NO dependency.
 */

import fs from 'node:fs';
import path from 'node:path';

import { fail, requireString } from '../model/validate.js';

/** The 300s install ceiling (Req 17.1). Passed as timeoutMs to the guard/boundary. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

/**
 * The dependency-output paths a package install materializes into the tree,
 * relative to the manifest's directory: the installed-modules directory and the
 * known lockfiles across npm/yarn/pnpm. These are the artifacts that must NOT be
 * left behind on a non-success install (Req 17.3). Because the boundary bind-
 * mounts the exportable tree read-write, a real install writes these straight
 * into the exportable tree, so on any non-success we remove the ones the install
 * created (i.e. that did not exist before it ran).
 */
export const DEPENDENCY_OUTPUT_PATHS = Object.freeze([
  'node_modules',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

/**
 * Validate a manifestRelPath as a SINGLE SAFE RELATIVE path (same rule as the
 * StorageLayout / SandboxManager: no absolute path, no traversal). A relative
 * path with intermediate directories is allowed (e.g. 'packages/app/package.json'),
 * but no component may be '..' and it may not be absolute — so the resolved
 * manifest can never escape the project's exportable tree.
 */
function requireSafeRelPath(relPath) {
  requireString('PackageManager', 'manifestRelPath', relPath);
  if (path.isAbsolute(relPath)) {
    fail('PackageManager', `manifestRelPath must be relative, got ${JSON.stringify(relPath)}`);
  }
  const parts = relPath.split(/[\\/]+/);
  if (parts.some((p) => p === '..')) {
    fail('PackageManager', `manifestRelPath must not contain a '..' segment, got ${JSON.stringify(relPath)}`);
  }
  return relPath;
}

/** Whether a filesystem path exists (best-effort; any stat error -> false). */
function pathExists(absPath) {
  try {
    fs.accessSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default manifest reader: return the file's utf8 contents, or null when the
 * manifest does not yet exist (a project may not have a manifest before its
 * first dependency is added). Any other read error propagates.
 */
function defaultReadManifest(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Default manifest writer: atomic + durable, mirroring persistence-store.js's
 * defaultWriteTree — mkdir -p the parent, write to a sibling temp file, fsync,
 * then rename over the destination so a crash mid-write cannot corrupt an
 * already-persisted manifest.
 */
function defaultWriteManifest(absPath, contents) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, absPath);
}

/**
 * Default install-command builder. `npm install <packageSpec>` when a spec is
 * given, else a bare `npm install` (install everything the manifest declares).
 * A caller can override per-call via `command`, or swap the whole builder via
 * the factory's `packageManagerCommand` seam.
 */
function defaultPackageManagerCommand({ packageSpec }) {
  const spec = typeof packageSpec === 'string' ? packageSpec.trim() : '';
  return spec === '' ? 'npm install' : `npm install ${spec}`;
}

/**
 * Merge a package spec (name or name@version) into a manifest's `dependencies`.
 * Used when the caller supplies a `packageSpec` but not a full `manifestUpdate`:
 * it models "the Builder_Agent adds the dependency to the manifest" by adding
 * the entry to dependencies and serializing the manifest back to JSON.
 *
 * @param {string|null} priorContents  the current manifest bytes (or null)
 * @param {string} packageSpec         'name' or 'name@range'
 * @returns {string} the new manifest contents (JSON)
 */
function applyPackageSpecToManifest(priorContents, packageSpec) {
  let manifest;
  try {
    manifest = priorContents ? JSON.parse(priorContents) : {};
  } catch {
    fail(
      'PackageManager',
      'existing manifest is not valid JSON; supply an explicit manifestUpdate to install from a package spec',
    );
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('PackageManager', 'existing manifest must be a JSON object');
  }
  // Split name@range on the LAST '@' after the (optional) scope, so
  // '@scope/pkg@^1.2.3' -> name '@scope/pkg', range '^1.2.3', and a bare
  // '@scope/pkg' / 'pkg' -> range '*'.
  const spec = packageSpec.trim();
  const at = spec.lastIndexOf('@');
  const hasRange = at > 0; // > 0 so a leading '@' (scope) is not treated as a version sep
  const name = hasRange ? spec.slice(0, at) : spec;
  const range = hasRange ? spec.slice(at + 1) : '*';
  const deps = { ...(manifest.dependencies ?? {}) };
  deps[name] = range;
  const next = { ...manifest, dependencies: deps };
  // 2-space indent + trailing newline, matching conventional package.json style.
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * Create a Package_Manager.
 *
 * @param {object} args
 * @param {object} args.layout        a StorageLayout — supplies exportableProjectTree(projectId)
 * @param {object} args.commandGuard  a CommandGuard (src/sandbox/command-guard.js) with run()
 * @param {string} [args.manifestRelPath='package.json']  manifest path relative to the project tree
 * @param {() => number} [args.now]   injectable clock (ms) for durationMs (default Date.now)
 * @param {number} [args.installTimeoutMs=300000]  the wall-clock ceiling threaded to the guard/boundary
 * @param {(absPath:string)=>(string|null)} [args.readManifest]   manifest reader seam (default node:fs)
 * @param {(absPath:string, contents:string)=>void} [args.writeManifest]  manifest writer seam (default node:fs, atomic)
 * @param {(args:{packageSpec?:string, projectId:string})=>string} [args.packageManagerCommand]  install-command builder
 * @param {Function|{record:Function}} [args.observability]  OPTIONAL observability sink (event) => void / { record }
 * @param {Function|{record:Function}} [args.audit]          OPTIONAL audit sink (event) => void / { record }
 * @returns {object} package manager (frozen)
 */
export function createPackageManager({
  layout,
  commandGuard,
  manifestRelPath = 'package.json',
  now = Date.now,
  installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  readManifest = defaultReadManifest,
  writeManifest = defaultWriteManifest,
  packageManagerCommand = defaultPackageManagerCommand,
  observability,
  audit,
} = {}) {
  if (!layout || typeof layout.exportableProjectTree !== 'function') {
    fail('PackageManager', 'layout with exportableProjectTree(projectId) is required');
  }
  if (!commandGuard || typeof commandGuard.run !== 'function') {
    fail('PackageManager', 'commandGuard with run(projectId, command, opts) is required');
  }
  if (typeof now !== 'function') {
    fail('PackageManager', 'now must be a function returning milliseconds');
  }
  if (typeof installTimeoutMs !== 'number' || !Number.isFinite(installTimeoutMs) || installTimeoutMs <= 0) {
    fail('PackageManager', 'installTimeoutMs must be a positive number');
  }
  if (typeof readManifest !== 'function' || typeof writeManifest !== 'function') {
    fail('PackageManager', 'readManifest and writeManifest must be functions');
  }
  if (typeof packageManagerCommand !== 'function') {
    fail('PackageManager', 'packageManagerCommand must be a function');
  }

  const safeRelPath = requireSafeRelPath(manifestRelPath);

  // Normalize the optional observability/audit seams into record(event) fns
  // (no-op when absent), mirroring toAuditSink's accepted shapes.
  const emitObservability = toRecordSink(observability);
  const emitAudit = toRecordSink(audit);

  /** Resolve the manifest's absolute path inside THIS project's exportable tree. */
  function manifestPathFor(projectId) {
    const treeRoot = layout.exportableProjectTree(projectId);
    return path.join(treeRoot, safeRelPath);
  }

  /**
   * install — the single entry point (Req 17.1–17.5).
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} [params.packageSpec]        the dependency to add ('name' | 'name@range')
   * @param {string} [params.manifestUpdate]     the FULL new manifest contents (overrides packageSpec merge)
   * @param {string} [params.priorManifest]      OPTIONAL prior manifest bytes (defaults to reading disk)
   * @param {string|string[]} [params.command]   OPTIONAL explicit install command (overrides the builder)
   * @param {AbortSignal} [params.signal]
   * @param {boolean} [params.subAgent]          route as a read-only sub-agent command (guard policy)
   * @param {(req:object)=>(Promise<boolean>|boolean)} [params.onConfirmRequest]  consent seam for confirm-class
   * @returns {Promise<object>} a frozen structured result
   */
  async function install(params = {}) {
    const { projectId, packageSpec, manifestUpdate, command, signal, subAgent, onConfirmRequest } = params;
    requireString('PackageManager', 'projectId', projectId);

    const absPath = manifestPathFor(projectId);

    // (1) SNAPSHOT the prior manifest bytes (the exact bytes to restore to). A
    // caller-supplied priorManifest wins (lets a caller pin the pre-addition
    // bytes explicitly); otherwise read the current on-disk contents.
    const priorManifest =
      typeof params.priorManifest === 'string' ? params.priorManifest : readManifest(absPath);

    // (2) APPLY the Builder_Agent's addition: compute the new manifest bytes
    // (full new contents, or the package spec merged into dependencies) and
    // write them to disk, so the on-disk manifest already reflects the addition
    // when the install begins (Req 17.1 "adds to the manifest, THEN invokes").
    let newManifest;
    let manifestChanged;
    if (typeof manifestUpdate === 'string') {
      newManifest = manifestUpdate;
      manifestChanged = true;
    } else if (typeof packageSpec === 'string' && packageSpec.trim() !== '') {
      newManifest = applyPackageSpecToManifest(priorManifest, packageSpec);
      manifestChanged = true;
    } else {
      // No manifest change to apply — install from the manifest as-is (bare
      // `npm install`). The prior contents ARE the current contents, so this is
      // a true no-op: do NOT rewrite the manifest with its own bytes (Issue 4).
      newManifest = priorManifest;
      manifestChanged = false;
    }
    if (manifestChanged && typeof newManifest === 'string') {
      writeManifest(absPath, newManifest);
    }

    // (2a) SNAPSHOT which dependency-output paths already exist BEFORE the
    // install runs. The boundary bind-mounts the exportable tree read-write, so
    // a real install writes node_modules/ + a lockfile straight into it; on any
    // non-success we must remove ONLY the artifacts this install created (paths
    // absent before it ran), never a pre-existing node_modules/lockfile the
    // Builder_Agent already had. Paths are resolved relative to the manifest's
    // own directory so a nested manifest (e.g. packages/app/package.json) cleans
    // the right tree.
    const manifestDir = path.dirname(absPath);
    const depOutputAbsPaths = DEPENDENCY_OUTPUT_PATHS.map((rel) => path.join(manifestDir, rel));
    const preexistingDepPaths = new Set(depOutputAbsPaths.filter((p) => pathExists(p)));

    /**
     * Cancel the install's on-disk footprint so the exportable tree is exactly
     * what it was before install began (Req 17.3/17.5). TWO parts:
     *
     *   (a) MANIFEST: restore the manifest to its prior snapshotted bytes,
     *       reverting the Builder_Agent's addition. When there was NO prior
     *       manifest (null) and this install created one, revert to "no
     *       manifest" by removing the file. When the manifest was not changed
     *       (bare install no-op), there is nothing to restore.
     *   (b) DEPENDENCY ARTIFACTS: the boundary bind-mounts the exportable tree
     *       read-write, so a real `npm install` writes node_modules/ + a
     *       lockfile straight into it and a failed/timed-out/denied run can
     *       leave those partially materialized. Remove any dependency-output
     *       path that this install CREATED (was absent before it ran), leaving
     *       any pre-existing node_modules/lockfile the Builder_Agent already had
     *       untouched. This is what "expose no partially installed dependency
     *       files to the build" means against the real read-write mount.
     */
    function restoreManifest() {
      if (manifestChanged && typeof priorManifest === 'string') {
        writeManifest(absPath, priorManifest);
      } else if (manifestChanged && typeof newManifest === 'string') {
        // We created a manifest where none existed; revert to "no manifest".
        try {
          fs.rmSync(absPath, { force: true });
        } catch {
          /* best-effort revert; the tree exposes no dep files regardless */
        }
      }
      cleanPartialDeps();
    }

    /**
     * Remove dependency-output artifacts this install created (paths that were
     * absent before it ran). Best-effort + recursive: a partial node_modules is
     * a directory tree. Never touches a path that pre-existed the install.
     */
    function cleanPartialDeps() {
      for (const depPath of depOutputAbsPaths) {
        if (preexistingDepPaths.has(depPath)) continue;
        if (!pathExists(depPath)) continue;
        try {
          fs.rmSync(depPath, { recursive: true, force: true });
        } catch {
          /* best-effort clean; do not throw from the restore/cancel path */
        }
      }
    }

    // (2b) Build the install command (caller override > factory builder).
    const installCommand =
      command !== undefined ? command : packageManagerCommand({ packageSpec, projectId });

    // (3) ROUTE through the CommandGuard — the SINGLE point that runs plumby's
    // classifier and, on allow, runs the install INSIDE the SandboxManager
    // boundary. The 300s ceiling is threaded as timeoutMs so the boundary's
    // wall-clock reaper (deniedReason 'timeout') can fire.
    const startedAt = now();
    const guardResult = await commandGuard.run(projectId, installCommand, {
      timeoutMs: installTimeoutMs,
      signal,
      subAgent,
      onConfirmRequest,
    });
    const durationMs = Math.max(0, now() - startedAt);

    const outcome = guardResult?.outcome ?? 'refuse';
    const category = guardResult?.category ?? null;
    const classifyReason = guardResult?.classifyReason ?? guardResult?.reason ?? null;
    const executed = guardResult?.executed === true;

    // (4) DENIED path (Req 17.5): the command did NOT execute — a refuse verdict,
    // a blocked command (fail-closed / sub-agent policy), or a confirm-class
    // command whose consent was denied. CANCEL the install: restore the manifest
    // and expose no partial deps. Nothing in the Sandbox or manifest changed.
    if (!executed) {
      restoreManifest();
      // Distinguish a CONSENT denial of a confirm-class command from a
      // classifier (refuse / blocked / fail-closed) denial (Issue 3). In the
      // confirm case the classifier DID answer — it returned 'confirm' — and the
      // denial originated from the consent gate, not from the Permission_
      // Classifier. Req 17.5 is about a command "denied by the classifier"; a
      // consent denial is a different gate, so it gets its own code/message.
      const confirmDenied = outcome === 'confirm';
      const code = confirmDenied ? 'CONFIRM_DENIED' : 'CLASSIFIER_DENIED';
      const message = confirmDenied
        ? `package command requires confirmation and consent was denied${
            classifyReason ? ` (${classifyReason})` : ''
          }; install cancelled and manifest restored`
        : `package command denied by the classifier (${outcome}${
            classifyReason ? `: ${classifyReason}` : ''
          }); install cancelled and manifest restored`;
      const result = Object.freeze({
        ok: false,
        code,
        outcome,
        category,
        reason: classifyReason,
        manifestRestored: true,
        durationMs,
        message,
      });
      emitAudit({ type: 'package.install.denied', projectId, code, outcome, category, reason: classifyReason });
      emitObservability({ type: 'package.install', projectId, ok: false, code, outcome, durationMs });
      return result;
    }

    // The command executed inside the boundary. Read its output + status.
    const stdout = guardResult?.stdout ?? '';
    const stderr = guardResult?.stderr ?? '';
    const exitCode = typeof guardResult?.exitCode === 'number' ? guardResult.exitCode : null;
    const timedOut = guardResult?.timedOut === true || guardResult?.deniedReason === 'timeout';

    // (5) FAILURE / TIMEOUT path (Req 17.3): the command executed but did not
    // succeed. REPORT the installer output, RESTORE the manifest, and expose no
    // partial deps — restoreManifest() reverts the manifest AND removes any
    // dependency-output artifacts (node_modules / lockfile) this install created
    // in the read-write-mounted exportable tree.
    if (timedOut || exitCode !== 0) {
      restoreManifest();
      const code = timedOut ? 'INSTALL_TIMEOUT' : 'INSTALL_FAILED';
      const result = Object.freeze({
        ok: false,
        code,
        exitCode,
        stdout,
        stderr,
        timedOut,
        manifestRestored: true,
        durationMs,
        message: timedOut
          ? `package install exceeded the ${installTimeoutMs}ms ceiling; run killed, manifest restored`
          : `package install failed (exit ${exitCode}); manifest restored`,
      });
      emitAudit({ type: 'package.install.failed', projectId, code, exitCode, timedOut });
      emitObservability({ type: 'package.install', projectId, ok: false, code, exitCode, timedOut, durationMs });
      return result;
    }

    // (6) SUCCESS path (Req 17.1/17.2): executed with exitCode 0. The dependency
    // is installed inside the Sandbox within the ceiling and resolvable to the
    // build/Dev_Server (same boundary). KEEP the new manifest — do NOT restore.
    const result = Object.freeze({
      ok: true,
      manifest: typeof newManifest === 'string' ? newManifest : priorManifest,
      stdout,
      stderr,
      exitCode: 0,
      durationMs,
      message: 'package installed inside the Sandbox',
    });
    emitAudit({ type: 'package.install.succeeded', projectId, durationMs });
    emitObservability({ type: 'package.install', projectId, ok: true, code: 'INSTALLED', exitCode: 0, durationMs });
    return result;
  }

  return Object.freeze({
    install,
    manifestPathFor,
    installTimeoutMs,
    manifestRelPath: safeRelPath,
  });
}

/**
 * Normalize an OPTIONAL observability/audit sink into a record(event) fn.
 * Accepts: undefined/null (no-op), a bare function, or an object with a
 * record(event) method. Mirrors auth/audit.js's toAuditSink accepted shapes but
 * is local so this module adds no cross-subsystem coupling for an optional seam.
 */
function toRecordSink(sink) {
  if (sink === undefined || sink === null) return () => {};
  if (typeof sink === 'function') return (event) => sink(event);
  if (typeof sink.record === 'function') return (event) => sink.record(event);
  fail('PackageManager', 'observability/audit sink must be a function or an object with a record(event) method');
  return () => {};
}
