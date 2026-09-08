/**
 * container-build.js — a REAL build behind the existing `buildBoundary` seam of
 * src/project/build-service.js (Req 18.1, 18.3, 18.5).
 *
 * WHAT THIS REPLACES. `build-service.js` already implements the build LIFECYCLE
 * for real — real `createDeploymentArtifact` records, real artifact bytes written
 * to a real control-plane file, the 300s SLO measured on the injected clock, a
 * non-zero exit mapped to BUILD_FAILED with no artifact. But its ONE actual work
 * boundary was inert: `defaultBuildBoundary` synthesized `{ exitStatus: 0, bytes:
 * 'artifact:<id>:<target>' }` and launched nothing, so a caller was handed a
 * "Deployment_Artifact" whose bytes were a placeholder string. This module
 * implements the SAME seam for real:
 *
 *     build({ projectId, target, timeoutMs, signal })
 *        -> { exitStatus, artifactPath?, bytes?, stderr?, ... }
 *
 * so `createBuildService` is untouched and the two implementations are
 * interchangeable — exactly how `container-dev-server.js` gave the previously
 * inert Dev_Server seam a real implementation.
 *
 * HOW IT WORKS, and what is real about it:
 *   1. The build command is resolved from the PROJECT's own package.json by the
 *      PURE `resolveBuildCommand` (fully testable without a container).
 *   2. It runs as `npm run <script>` INSIDE the project's Isolation_Boundary via
 *      `SandboxManager.exec` — the same one-shot container, the same project-only
 *      bind mount, the same deny-by-default egress and the same requested cgroup
 *      limits as every other command. A build NEVER runs on the host, and the
 *      script BODY is never spliced into a command: npm interprets it inside the
 *      container, exactly as a developer would run it (the same safety note as
 *      container-dev-server's dev-command resolution).
 *   3. On exit 0 the built OUTPUT directory is located by convention and packaged
 *      into a self-describing artifact BUNDLE (see encodeArtifactBundle) which
 *      build-service writes to disk as the artifact's real bytes. The bundle holds
 *      the ACTUAL built file bytes, so a deploy can publish them.
 *   4. Every refusal is STRUCTURED and HONEST — a project with no build script, no
 *      build output, or uninstalled declared dependencies is refused with a named
 *      reason and a non-zero exit, never a fabricated success.
 *   5. Every failure carries a BOUNDED, redaction-safe log tail (mirroring how
 *      container-dev-server attaches a container log tail), so build-service's
 *      BUILD_FAILED message explains the cause without dumping unbounded output.
 *
 * WHY THE HOST-SIDE READS ARE SAFE. The project's package.json, its node_modules
 * presence and its build output are read from the host side of the SAME bind mount
 * the container writes through (`layout.exportableProjectTree(projectId)`). Those
 * are READ-ONLY inspections of one project's own tree — nothing from the tree is
 * ever executed on the host.
 *
 * WHAT ONLY A REAL CONTAINER HOST CAN PROVE (it cannot be proven in this build
 * sandbox, which has no container runtime): that the runtime accepts the emitted
 * argv, that `npm run <script>` resolves and runs the project's toolchain in the
 * image, and that a given generated project's build script writes into one of the
 * conventional output directories. Everything ABOVE the runtime CLI — command
 * resolution, every refusal, the boundary call and its timeout/denial mapping, log
 * tailing, output detection, bundling and its size ceilings — is exercised here
 * against injected fakes and a real temp filesystem.
 *
 * THE PLUMBY BOUNDARY: this module never imports the plumby package.
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock, the boundary and every fs seam; structured results rather than throws.
 */

import fs from 'node:fs';
import path from 'node:path';

import { fail, requireString } from '../model/validate.js';
import { isValidTarget } from '../model/enums.js';

/**
 * npm scripts a build is started from, in preference order, given a Target. The
 * TARGET-SPECIFIC name wins so a multi-target project that declares `build:web`
 * and `build:backend` builds the right one; a plain `build` is the fallback.
 *
 * Deliberately SHORT. There is no `compile`/`bundle`/`prepare` guessing: running
 * some other script and calling the result a build is how you end up publishing
 * whatever happened to be lying around.
 */
export function buildScriptPreference(target) {
  return Object.freeze([`build:${target}`, 'build']);
}

/**
 * Conventional build-output directories, in preference order. A project whose
 * build writes somewhere else is REFUSED (NO_BUILD_OUTPUT) rather than having an
 * arbitrary directory published in its place.
 */
export const OUTPUT_DIR_PREFERENCE = Object.freeze(['dist', 'build', 'out']);

/** Exit status used for a structured REFUSAL (as opposed to a script that ran and failed). */
export const REFUSED_EXIT_STATUS = 78; // EX_CONFIG — "the configuration cannot support a build"

/** Exit status reported when the boundary killed the build at its wall-clock limit. */
export const TIMED_OUT_EXIT_STATUS = 124; // the conventional `timeout(1)` status

/** Bound on the log tail attached to a failure: lines, then bytes. */
export const DEFAULT_LOG_TAIL_LINES = 40;
export const DEFAULT_LOG_TAIL_BYTES = 4_096;

/** Ceilings on what may be packaged into one artifact bundle. */
export const DEFAULT_MAX_ARTIFACT_FILES = 5_000;
export const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

/** The artifact bundle format tag. Bumped if the shape ever changes. */
export const ARTIFACT_BUNDLE_VERSION = 'aab-artifact/1';

/**
 * Resolve HOW to build a Target — a PURE function over the project's own
 * package.json, so the whole decision is testable without a container.
 *
 * The command is always an ARGV VECTOR and the script BODY is never interpolated
 * into it: we emit `npm run <name>`, so untrusted generated content is interpreted
 * by npm INSIDE the container and never by a host shell.
 *
 * @param {object} [args]
 * @param {object|null} [args.packageJson]  parsed package.json, or null if absent
 * @param {string} [args.target]            a Target — `web`/`backend`/`shared`
 * @param {boolean} [args.hasNodeModules]   is a dependency tree installed?
 * @returns {{ ok:true, script:string, command:string[] }
 *          | { ok:false, code:string, message:string }}
 */
export function resolveBuildCommand({ packageJson, target, hasNodeModules = false } = {}) {
  if (typeof target !== 'string' || !isValidTarget(target)) {
    return {
      ok: false,
      code: 'INVALID_TARGET',
      message: `Target ${JSON.stringify(target)} is not one of web/backend/mobile/shared`,
    };
  }
  // A mobile build needs the Expo/EAS toolchain and a queue-aware execution
  // timeout — that is the mobile build service, not this boundary. build-service
  // refuses it first; this is the same refusal, stated at the boundary too.
  if (target === 'mobile') {
    return {
      ok: false,
      code: 'MOBILE_NOT_SUPPORTED_HERE',
      message: 'mobile builds go through the mobile build service, not the container build boundary',
    };
  }
  if (!packageJson || typeof packageJson !== 'object') {
    return {
      ok: false,
      code: 'NO_PACKAGE_JSON',
      message:
        'the project has no readable package.json, so there is no build command to run; ' +
        'refusing rather than reporting a build that never happened',
    };
  }

  const scripts =
    packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
  const script = buildScriptPreference(target).find(
    (name) => typeof scripts[name] === 'string' && scripts[name].trim() !== '',
  );
  if (!script) {
    return {
      ok: false,
      code: 'NO_BUILD_SCRIPT',
      message:
        `the project's package.json declares none of [${buildScriptPreference(target).join(', ')}], ` +
        'so there is no build to run. A build is REFUSED rather than reported as succeeded.',
    };
  }

  // A declared dependency tree that was never installed makes the build fail deep
  // inside npm with a message about a missing binary. Say the actual thing instead:
  // this is actionable, and it is checkable before spending a container launch.
  if (declaresDependencies(packageJson) && hasNodeModules !== true) {
    return {
      ok: false,
      code: 'DEPENDENCIES_NOT_INSTALLED',
      message:
        'the project declares dependencies but has no installed node_modules, so ' +
        `\`npm run ${script}\` cannot resolve its toolchain. Install the project's ` +
        'dependencies first (the Package_Manager path), then build.',
    };
  }

  return { ok: true, script, command: ['npm', 'run', script] };
}

/** Does this package.json declare any dependency at all? */
function declaresDependencies(packageJson) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = packageJson?.[field];
    if (deps && typeof deps === 'object' && Object.keys(deps).length > 0) return true;
  }
  return false;
}

/**
 * Reduce captured output to a BOUNDED tail: the last `lines` lines, then capped at
 * `bytes` BYTES (cut back to a UTF-8 boundary), with a notice naming what was
 * dropped. Optionally routed through a redactor first, so a Secret that a build
 * script echoed cannot travel into a surfaced failure cause.
 *
 * PURE and exported so the bound is testable directly.
 *
 * @param {string|string[]} output
 * @param {object} [opts]
 * @param {number} [opts.lines]
 * @param {number} [opts.bytes]
 * @param {(text:string)=>string} [opts.redact]
 * @returns {string}
 */
export function logTail(output, { lines = DEFAULT_LOG_TAIL_LINES, bytes = DEFAULT_LOG_TAIL_BYTES, redact } = {}) {
  const joined = (Array.isArray(output) ? output : [output])
    .map((part) => (typeof part === 'string' ? part : ''))
    .filter((part) => part !== '')
    .join('\n');
  if (joined === '') return '';

  const redacted = typeof redact === 'function' ? String(redact(joined)) : joined;
  const allLines = redacted.split('\n');
  const kept = allLines.length > lines ? allLines.slice(allLines.length - lines) : allLines;
  let text = kept.join('\n');
  if (allLines.length > lines) {
    text = `[log tail: ${allLines.length - lines} earlier lines omitted]\n${text}`;
  }

  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= bytes) return text;
  // Keep the END of the output (that is where a build failure explains itself),
  // backing the cut off any UTF-8 continuation byte so the slice stays valid.
  let cut = buf.length - bytes;
  while (cut < buf.length && (buf[cut] & 0xc0) === 0x80) cut += 1;
  return `[log tail: ${cut} earlier bytes omitted]\n${buf.subarray(cut).toString('utf8')}`;
}

/**
 * Encode collected build output into the artifact BUNDLE that becomes the
 * Deployment_Artifact's real bytes.
 *
 * WHY A BUNDLE. `build-service` writes ONE artifact file from the boundary's
 * `bytes`, and a deploy has to be able to publish the ACTUAL built files. So the
 * artifact is a self-describing JSON document carrying every built file's relative
 * path plus its content — `utf8` for text and `base64` for binary, decided by an
 * exact round-trip test rather than by extension. Sorted by path, so two builds of
 * identical output produce identical artifact bytes.
 *
 * PURE, and the format is owned here (see decodeArtifactBundle for the reader).
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.target
 * @param {string} args.outputDir            the detected output dir, relative to the tree
 * @param {Array<{path:string, bytes:Buffer}>} args.files
 * @param {string} [args.builtAt]            ISO timestamp
 * @returns {string} the artifact bytes (JSON)
 */
export function encodeArtifactBundle({ projectId, target, outputDir, files, builtAt }) {
  const entries = [...(files ?? [])]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      const buf = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(String(file.bytes ?? ''), 'utf8');
      const asUtf8 = buf.toString('utf8');
      const isText = Buffer.from(asUtf8, 'utf8').equals(buf);
      return isText
        ? { path: file.path, encoding: 'utf8', content: asUtf8 }
        : { path: file.path, encoding: 'base64', content: buf.toString('base64') };
    });
  return JSON.stringify({
    version: ARTIFACT_BUNDLE_VERSION,
    projectId,
    target,
    outputDir,
    builtAt: builtAt ?? null,
    fileCount: entries.length,
    files: entries,
  });
}

/**
 * Decode an artifact bundle produced by encodeArtifactBundle. NEVER throws: an
 * unreadable/foreign artifact is a structured failure, because a deploy must be
 * able to refuse one without crashing.
 *
 * Every entry path is validated as a RELATIVE, traversal-free POSIX path here, so
 * a consumer materializing the bundle cannot be walked out of its target directory
 * even if the artifact file were tampered with on disk.
 *
 * @param {string} text
 * @returns {{ ok:true, bundle:object, files:Array<{path:string, bytes:Buffer}> }
 *          | { ok:false, code:string, message:string }}
 */
export function decodeArtifactBundle(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (err) {
    return { ok: false, code: 'ARTIFACT_UNPARSEABLE', message: `artifact bytes are not a bundle: ${err?.message ?? err}` };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== ARTIFACT_BUNDLE_VERSION) {
    return {
      ok: false,
      code: 'ARTIFACT_UNSUPPORTED',
      message: `artifact bundle version ${JSON.stringify(parsed?.version ?? null)} is not ${ARTIFACT_BUNDLE_VERSION}`,
    };
  }
  if (!Array.isArray(parsed.files)) {
    return { ok: false, code: 'ARTIFACT_UNSUPPORTED', message: 'artifact bundle has no files array' };
  }

  const files = [];
  for (const entry of parsed.files) {
    const rel = entry?.path;
    if (typeof rel !== 'string' || rel === '' || !isSafeRelativePath(rel)) {
      return {
        ok: false,
        code: 'ARTIFACT_UNSAFE_PATH',
        message: `artifact bundle entry ${JSON.stringify(rel ?? null)} is not a safe relative path`,
      };
    }
    if (entry.encoding !== 'utf8' && entry.encoding !== 'base64') {
      return {
        ok: false,
        code: 'ARTIFACT_UNSUPPORTED',
        message: `artifact bundle entry ${JSON.stringify(rel)} has unsupported encoding ${JSON.stringify(entry.encoding)}`,
      };
    }
    files.push({
      path: rel,
      bytes: Buffer.from(String(entry.content ?? ''), entry.encoding === 'base64' ? 'base64' : 'utf8'),
    });
  }
  return { ok: true, bundle: parsed, files };
}

/**
 * A relative POSIX path with no traversal, no absolute root, no NUL and no drive
 * token. Exported because both the bundler and the publisher depend on it.
 */
export function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  if (rel.includes('\0') || rel.includes('\\') || rel.includes(':')) return false;
  if (rel.startsWith('/')) return false;
  const parts = rel.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Default: read + parse a project's package.json from the host side of its tree. */
function defaultReadPackageJson(tree) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Default: is a dependency tree installed in the project's tree? */
function defaultHasNodeModules(tree) {
  try {
    return fs.statSync(path.join(tree, 'node_modules')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Default: collect every regular file under `dir`, recursively, as
 * { path (relative, POSIX), bytes }.
 *
 * SYMLINKS ARE SKIPPED, deliberately: a link in a build output would otherwise be
 * followed and its target copied into the artifact — which is how a published
 * release ends up containing something from outside the output directory. They are
 * reported so the refusal/summary can say so rather than silently dropping files.
 */
function defaultCollectFiles(dir) {
  const files = [];
  const skippedLinks = [];
  const walk = (absolute, prefix) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(absolute, entry.name);
      if (entry.isSymbolicLink()) {
        skippedLinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (entry.isFile()) files.push({ path: rel, bytes: fs.readFileSync(full) });
    }
  };
  walk(dir, '');
  return { files, skippedLinks };
}

/** Default: does `dir` exist as a directory with at least one entry? */
function defaultNonEmptyDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Create a REAL, container-backed build implementing the `buildBoundary` seam of
 * createBuildService.
 *
 * @param {object} args
 * @param {object} args.layout   a StorageLayout — supplies exportableProjectTree,
 *        which is the HOST side of the very bind mount the container builds in.
 * @param {object} args.sandboxManager  a SandboxManager with
 *        exec(projectId, command, { timeoutMs, signal }) — THE Isolation_Boundary.
 *        REQUIRED and never defaulted: a build must not run anywhere else.
 * @param {() => number} [args.now]  injectable ms clock (buildMs reporting).
 * @param {() => string} [args.nowIso]  injectable ISO clock (bundle builtAt).
 * @param {(text:string)=>string} [args.redact]  redactor seam for log tails.
 * @param {string[]} [args.outputDirPreference]  conventional output dirs to look for.
 * @param {number} [args.maxArtifactFiles]
 * @param {number} [args.maxArtifactBytes]
 * @param {number} [args.logTailLines]
 * @param {number} [args.logTailBytes]
 * @param {(tree:string)=>object|null} [args.readPackageJson]  fs seam
 * @param {(tree:string)=>boolean} [args.hasNodeModules]       fs seam
 * @param {(dir:string)=>boolean} [args.nonEmptyDir]           fs seam
 * @param {(dir:string)=>{files:Array,skippedLinks:string[]}} [args.collectFiles]  fs seam
 * @returns {object} frozen { build, ... } — pass `build` as `buildBoundary`
 */
export function createContainerBuild({
  layout,
  sandboxManager,
  now = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  redact,
  outputDirPreference = OUTPUT_DIR_PREFERENCE,
  maxArtifactFiles = DEFAULT_MAX_ARTIFACT_FILES,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  logTailLines = DEFAULT_LOG_TAIL_LINES,
  logTailBytes = DEFAULT_LOG_TAIL_BYTES,
  readPackageJson = defaultReadPackageJson,
  hasNodeModules = defaultHasNodeModules,
  nonEmptyDir = defaultNonEmptyDir,
  collectFiles = defaultCollectFiles,
} = {}) {
  const model = 'ContainerBuild';
  if (!layout || typeof layout.exportableProjectTree !== 'function') {
    fail(model, 'a StorageLayout (with exportableProjectTree) is required');
  }
  if (!sandboxManager || typeof sandboxManager.exec !== 'function') {
    fail(model, 'a SandboxManager with exec(projectId, command, opts) is required — a build must run INSIDE the Isolation_Boundary');
  }
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');

  const tail = (output) => logTail(output, { lines: logTailLines, bytes: logTailBytes, redact });

  /** A structured refusal, shaped as the boundary contract build-service consumes. */
  function refuse({ code, message, target }) {
    return Object.freeze({
      exitStatus: REFUSED_EXIT_STATUS,
      refused: true,
      code,
      target: target ?? null,
      stderr: `${code}: ${message}`,
      message,
    });
  }

  /**
   * build({ projectId, target, timeoutMs, signal }) — the buildBoundary seam.
   *
   * Resolves the project's own build command, runs it inside the project's
   * Isolation_Boundary, and on success packages the built output into the artifact
   * bytes build-service writes to disk. Never throws on a handled path.
   *
   * @returns {Promise<object>} { exitStatus, artifactPath?, bytes?, stderr?, ... }
   */
  async function build({ projectId, target, timeoutMs, signal } = {}) {
    requireString(model, 'projectId', projectId);

    const tree = layout.exportableProjectTree(projectId);

    // (1) HOW to build — a pure decision over the project's own manifest. An
    // unreadable tree is not a crash: it means no manifest, and resolveBuildCommand
    // refuses with a structured reason.
    let packageJson = null;
    let installed = false;
    try {
      packageJson = readPackageJson(tree);
      installed = hasNodeModules(tree) === true;
    } catch {
      packageJson = null;
      installed = false;
    }
    const resolved = resolveBuildCommand({ packageJson, target, hasNodeModules: installed });
    if (resolved.ok !== true) {
      return refuse({ code: resolved.code, message: resolved.message, target });
    }

    // (2) RUN IT INSIDE THE BOUNDARY. Never on the host, and never through a host
    // shell: an argv vector goes to the container, npm interprets the script body.
    const startedAt = now();
    let exec;
    try {
      exec = await sandboxManager.exec(projectId, resolved.command, { timeoutMs, signal });
    } catch (err) {
      // exec() converts a launch failure into a structured result, so reaching here
      // is an unexpected fault. Report it as a failure with the cause, not a throw:
      // build-service maps it to BUILD_FAILED either way, and a bounded/redacted
      // message keeps an internal path out of a surfaced cause.
      return Object.freeze({
        exitStatus: 1,
        code: 'BUILD_LAUNCH_FAILED',
        script: resolved.script,
        stderr: tail(`build could not be launched inside the Isolation_Boundary: ${err?.message ?? err}`),
      });
    }
    const ranMs = Math.max(0, now() - startedAt);
    const captured = tail([exec?.stdout, exec?.stderr]);

    // The boundary itself refused or killed the run (launch-failure / wall-clock
    // timeout). That is NOT the build script's own failure, so it is labelled
    // distinctly — build-service still reports BUILD_FAILED with this cause, and a
    // caller that wants the SLO verdict reads build-service's clock-based check.
    if (exec?.denied === true) {
      const timedOut = exec.deniedReason === 'timeout' || exec.timedOut === true;
      return Object.freeze({
        exitStatus: timedOut ? TIMED_OUT_EXIT_STATUS : 1,
        code: timedOut ? 'BUILD_TIMED_OUT' : 'BUILD_DENIED',
        script: resolved.script,
        timedOut,
        ranMs,
        stderr: tail([
          timedOut
            ? `the build was killed at the ${timeoutMs ?? 'configured'}ms boundary limit`
            : `the Isolation_Boundary denied the build (${exec.deniedReason ?? 'denied'})`,
          exec.stderr,
        ]),
      });
    }

    // The script RAN inside the box and failed. Surface its exit status and the
    // bounded tail of what it printed — that is what makes a failure explainable.
    if (exec?.exitCode !== 0) {
      return Object.freeze({
        exitStatus: typeof exec?.exitCode === 'number' ? exec.exitCode : 1,
        code: 'BUILD_SCRIPT_FAILED',
        script: resolved.script,
        ranMs,
        stderr: captured || `npm run ${resolved.script} exited ${exec?.exitCode ?? 'non-zero'}`,
      });
    }

    // (3) COLLECT THE OUTPUT. A build that exits 0 but wrote nothing we can find is
    // refused, not reported as an artifact: publishing "the tree" instead would ship
    // sources (and anything else lying around) as if it were a build product.
    const outputDir = outputDirPreference.find((dir) => nonEmptyDir(path.join(tree, dir)));
    if (!outputDir) {
      return refuse({
        code: 'NO_BUILD_OUTPUT',
        target,
        message:
          `\`npm run ${resolved.script}\` exited 0 but produced none of the conventional output ` +
          `directories [${outputDirPreference.join(', ')}], so there is nothing to package as a ` +
          'Deployment_Artifact',
      });
    }

    let collected;
    try {
      collected = collectFiles(path.join(tree, outputDir));
    } catch (err) {
      return refuse({
        code: 'BUILD_OUTPUT_UNREADABLE',
        target,
        message: `the build output directory ${outputDir} could not be read: ${err?.message ?? err}`,
      });
    }
    const files = Array.isArray(collected?.files) ? collected.files : [];
    if (files.length === 0) {
      return refuse({
        code: 'NO_BUILD_OUTPUT',
        target,
        message: `the build output directory ${outputDir} contains no regular files to package`,
      });
    }
    if (files.length > maxArtifactFiles) {
      return refuse({
        code: 'ARTIFACT_TOO_MANY_FILES',
        target,
        message: `the build output has ${files.length} files, over the ${maxArtifactFiles}-file artifact ceiling`,
      });
    }
    const totalBytes = files.reduce((sum, file) => sum + (Buffer.isBuffer(file.bytes) ? file.bytes.length : 0), 0);
    if (totalBytes > maxArtifactBytes) {
      return refuse({
        code: 'ARTIFACT_TOO_LARGE',
        target,
        message: `the build output is ${totalBytes} bytes, over the ${maxArtifactBytes}-byte artifact ceiling`,
      });
    }
    for (const file of files) {
      if (!isSafeRelativePath(file.path)) {
        return refuse({
          code: 'ARTIFACT_UNSAFE_PATH',
          target,
          message: `the build output contains an unsafe relative path ${JSON.stringify(file.path)}`,
        });
      }
    }

    const bytes = encodeArtifactBundle({
      projectId,
      target,
      outputDir,
      files,
      builtAt: nowIso(),
    });

    return Object.freeze({
      exitStatus: 0,
      // build-service computes the artifact's DISK path itself; this is the
      // in-tree output directory the bytes came from, reported for diagnostics.
      artifactPath: outputDir,
      bytes,
      stderr: '',
      script: resolved.script,
      outputDir,
      fileCount: files.length,
      outputBytes: totalBytes,
      bundleBytes: Buffer.byteLength(bytes, 'utf8'),
      skippedLinks: Object.freeze([...(collected?.skippedLinks ?? [])]),
      ranMs,
      logTail: captured,
    });
  }

  return Object.freeze({
    build,
    // Exposed for tests / introspection; the decision itself is pure.
    resolveBuildCommand,
    outputDirPreference: Object.freeze([...outputDirPreference]),
    maxArtifactFiles,
    maxArtifactBytes,
  });
}
