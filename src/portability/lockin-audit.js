/**
 * LOCKIN_AUDIT (spec Task 27.2, Req 11.1, 11.2, 11.3, 11.9, 11.10, 11.11, 11.12, 11.13).
 *
 * createLockinAudit scans a Project's full file state for vendor / platform
 * LOCK-IN SIGNALS and reports each detected signal with file path + line-number
 * evidence, or reports none found. A file it cannot scan is reported as an
 * UNVERIFIED SURFACE (never silently omitted). A signal found in
 * AI_App_Builder-generated code is treated as a DEFECT to fix, not a feature.
 *
 * ─── CONCEPT / METHODOLOGY CREDIT (READ THIS) ─────────────────────────────
 * The detection CONCEPT and — crucially — the specific FALSE-POSITIVE lessons
 * are RE-IMPLEMENTED here in Node, adapted from the vendored Guard/Devendor
 * skill's reference detector:
 *
 *     agent-skills-lockin/vendor-lockin-guard/scripts/detect-lockin.sh
 *
 * That upstream script is the authoritative CONCEPT source (its signal set and
 * its hard-won FP traps: match the CONSTRUCT not the vocabulary — no bare
 * `amplitude` physics-variable, no `Badge` prose word, no whole-tree grep on an
 * empty match, no importFrom next-line miss; and exclude non-interesting paths
 * by testing the PATH only, never by a substring of the matched line). We do NOT
 * shell out to that script at runtime, and we do NOT modify the upstream repo —
 * it must remain independently usable. The detection is a pure in-process Node
 * re-implementation so the audit is hermetic and testable.
 *
 * ─── SIGNAL SET (each finding carries { signal, severity, file, line, evidence }) ──
 *   telemetry     package-qualified telemetry/analytics SDK imports (posthog-js,
 *                 posthog-node, @posthog/, mixpanel-browser, @amplitude/,
 *                 amplitude-js, @segment/, analytics-node, @sentry/, react-ga,
 *                 gtag(, googletagmanager) — NOT a bare `amplitude` word.
 *   collector     hardcoded collector/beacon endpoints
 *                 https?://host/(events|collect|track|beacon|ingest).
 *   platform-host hardcoded platform-host literals (the injected platformHosts,
 *                 and an optional vendorPattern).
 *   enforcement   importFrom/mustImport/requiredImports keys whose VALUE names
 *                 the vendor, in *.json / *rc / *.config.* — scoped to the
 *                 mandate key's value (same OR next line), never the whole file.
 *   hash-manifest "<path>.(ts|tsx|js|mjs)": "<64-hex>" entries in *.json.
 *   injected-ui   JSX construct <([A-Z][A-Za-z0-9]*)?(Badge|Watermark|PoweredBy|
 *                 MadeWith|Feedback|Branding) in *.tsx/*.jsx/*.vue/*.svelte —
 *                 the JSX construct, never the prose word.
 *   undeclared-host  outbound host literals not declared/allowlisted.
 *   unused-env    env vars declared in .env.template/.example/.sample but read
 *                 nowhere in the tree.
 *
 * ─── SLOs / LIMITS MEASURED AGAINST THE INJECTED CLOCK ────────────────────
 * The 120s audit SLO (Req 11.10) is measured against the injected `now()` clock,
 * NEVER a real wait; an over-budget audit ABORTS with AUDIT_TIMEOUT. The
 * configurable file-count limit (default 10,000, Req 11.9) is shared with
 * Project_Export via ./file-count.js; an over-limit Project is REPORTED as
 * excess (FILE_COUNT_EXCEEDED), never silently truncated.
 *
 * ─── READ-ONLY SUB-AGENT MODE (Req 11.2, OPTIONAL) ────────────────────────
 * The audit MAY run as a read-only sub-agent. The pure in-process detector is
 * the DEFAULT/primary path so tests stay hermetic; when a caller opts in
 * (options.readOnlySubagent) the audit drives plumby's read-only sub-agent seam
 * THROUGH src/engine/plumby.js (subagentTools / spawnSubagentTool — already
 * re-exported there). It performs NO writes, and this module imports NO plumby
 * package directly (the boundary invariant).
 *
 * Conventions: a composing factory createLockinAudit({...deps}) returning
 * Object.freeze({...}); dependency injection for the clock (`now`) and every
 * collaborator; structured { ok:true|false, code, message } results for expected
 * failures (never throw on a handled failure path). Node stdlib only; no new
 * dependency.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, requireNumber, fail } from '../model/validate.js';
import { decodeTreeEntry } from '../persistence/tree-codec.js';
import {
  DEFAULT_FILE_COUNT_LIMIT,
  requireFileCountLimit,
  checkFileCount,
} from './file-count.js';

/** The 120s Lockin_Audit SLO (Req 11.10). Measured against the injected clock. */
export const AUDIT_SLO_MS = 120_000;

/**
 * Paths that are never interesting — matched against the PATH ONLY (never
 * against matched source text), mirroring detect-lockin.sh's EXCLUDES so a
 * finding can never be suppressed by a substring of its own matched line.
 * A skipped known-excluded path is a DELIBERATE exclusion, NOT an unverified
 * surface (Req 11.12).
 */
const EXCLUDED_PATH_RE =
  /(^|\/)node_modules\/|(^|\/)\.git\/|\.lock$|(^|\/)dist\/|(^|\/)build\/|(^|\/)\.next\/|(^|\/)\.expo\/|(^|\/)coverage\//;

/** Lockfiles excluded wholesale (their own basenames). */
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
]);

/**
 * Telemetry / analytics SDK import forms — PACKAGE-QUALIFIED on purpose. A bare
 * `amplitude` word (a physics variable) must NOT fire; the import form is what
 * indicates an SDK (detect-lockin.sh FP lesson).
 */
const TELEMETRY_RE =
  /onedollarstats|posthog-js|posthog-node|@posthog\/|mixpanel-browser|@amplitude\/|amplitude-js|@segment\/|analytics-node|@sentry\/|react-ga|gtag\(|googletagmanager/;

/** Hardcoded collector / event endpoints. */
const COLLECTOR_RE = /https?:\/\/[a-z0-9.-]+\/(events?|collect|track|beacon|ingest)\b/i;

/**
 * Hash-protection manifest entry: "<path>.(ts|tsx|js|mjs)": "<64-hex>". These
 * are files you are BLOCKED from editing.
 */
const HASH_MANIFEST_RE = /"[^"]+\.(?:ts|tsx|js|mjs)"\s*:\s*"[a-f0-9]{64}"/i;

/**
 * Injected badge / watermark / feedback COMPONENT — a JSX construct, never the
 * prose word. The prefix before the suffix is OPTIONAL so the exactly-named
 * forms (<Badge/>, <PoweredBy/>, <Watermark/>) are caught too.
 */
const INJECTED_UI_RE =
  /<([A-Z][A-Za-z0-9]*)?(Badge|Watermark|PoweredBy|MadeWith|Feedback|Branding)\b/;

/** The import-mandate keys whose VALUE naming a vendor is an enforcement rule. */
const MANDATE_KEY_RE = /"(importFrom|mustImport|requiredImports)"/;

/** File extensions the enforcement (convention/lint) detector scans. */
const ENFORCEMENT_EXT_RE = /\.(json|config\.(?:js|ts|cjs|mjs|json))$/i;

/** JSX-bearing file extensions the injected-UI detector scans. */
const JSX_EXT_RE = /\.(tsx|jsx|vue|svelte)$/i;

/** Source file extensions the telemetry / collector detectors scan. */
const SOURCE_EXT_RE = /\.(ts|tsx|js|mjs|cjs|jsx)$/i;

/** Env-template basenames whose declared-but-unread vars are a signal. */
const ENV_TEMPLATE_BASENAMES = new Set(['.env.template', '.env.example', '.env.sample']);

/** A generic outbound URL host literal (for the undeclared-host detector). */
const OUTBOUND_URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;

/**
 * Local / loopback / private hosts are NOT outbound — a template that boots a
 * server on 127.0.0.1/localhost is not phoning home. Excluded from the
 * undeclared-host detector so a clean generated project stays clean.
 */
function isLocalHost(host) {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^127\./.test(host)
  );
}

/** Whether a *rc-style filename is a convention/lint config (e.g. .eslintrc). */
function isRcConfig(rel) {
  const base = rel.split('/').pop() ?? '';
  return /^\..*rc(\.[a-z]+)?$/i.test(base) || /rc\.json$/i.test(base);
}

/** A monotonic-ish default clock (ms). Overridable for deterministic tests. */
function defaultNow() {
  return Date.now();
}

/**
 * The default read seam: walk the on-disk exportable project tree and return a
 * { relPath: contents } map using the SAME text/binary contract as
 * tree-codec.decodeTreeEntry — text as a utf8 String, binary as a Buffer — and
 * NEVER reading the project's Git repo (.git). Returns {} when nothing exists.
 */
function defaultReadTree(root) {
  const tree = {};
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const ent of ents) {
      if (ent.name === '.git') continue; // SnapshotStore's repo, not a tree file
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        tree[rel] = decodeTreeEntry(fs.readFileSync(full));
      }
    }
  };
  walk(root);
  return tree;
}

/** True when a path is a deliberate exclusion (never an unverified surface). */
function isExcludedPath(rel) {
  if (EXCLUDED_PATH_RE.test(rel)) return true;
  const base = rel.split('/').pop() ?? '';
  return LOCKFILE_BASENAMES.has(base);
}

/** Split a file body into 1-indexed lines for line-number evidence (Req 11.10). */
function toLines(body) {
  return body.split('\n');
}

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the platform-host matcher: the caller-supplied platformHosts literals
 * (OR'd, escaped) plus the optional vendorPattern (a RegExp source string).
 * Returns null when there is nothing to match.
 */
function buildPlatformHostMatcher(platformHosts, vendorPattern) {
  const parts = [];
  for (const h of platformHosts) {
    if (typeof h === 'string' && h !== '') parts.push(escapeRegExp(h));
  }
  if (typeof vendorPattern === 'string' && vendorPattern !== '') {
    parts.push(vendorPattern);
  }
  if (parts.length === 0) return null;
  return new RegExp(parts.join('|'), 'i');
}

/**
 * Create a Lockin_Audit factory.
 *
 * @param {object} args
 * @param {object} [args.layout]  a StorageLayout (src/storage/layout.js) —
 *        supplies exportableProjectTree(projectId), the Project's file state to
 *        scan. Optional when the caller always passes a tree map to audit().
 * @param {() => number} [args.now]           injectable clock (ms) for the SLO.
 * @param {number} [args.fileCountLimit]      configurable maximum file-count (default 10,000, Req 11.9).
 * @param {number} [args.auditTimeoutMs]      the audit SLO budget (default 120000, Req 11.10).
 * @param {string[]} [args.platformHosts]     hardcoded platform-host literals to flag.
 * @param {string} [args.vendorPattern]       optional extra vendor RegExp source (platform-host detector).
 * @param {(root: string) => Object<string,string|Buffer>} [args.readTree]
 *        injectable read seam (default walks the on-disk exportable tree).
 * @param {object} [args.subagentSeam]  OPTIONAL read-only sub-agent seam obtained
 *        THROUGH src/engine/plumby.js (subagentTools / spawnSubagentTool). When
 *        supplied and a caller opts in, the audit may run read-only through it;
 *        the pure in-process detector remains the default/primary path.
 * @returns {object} the frozen audit factory
 */
export function createLockinAudit({
  layout = null,
  now = defaultNow,
  fileCountLimit = DEFAULT_FILE_COUNT_LIMIT,
  auditTimeoutMs = AUDIT_SLO_MS,
  platformHosts = [],
  vendorPattern = null,
  readTree = defaultReadTree,
  subagentSeam = null,
} = {}) {
  const model = 'LockinAudit';
  if (layout !== null && typeof layout.exportableProjectTree !== 'function') {
    fail(model, 'layout, when provided, must expose exportableProjectTree');
  }
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');
  requireFileCountLimit(model, fileCountLimit);
  requireNumber(model, 'auditTimeoutMs', auditTimeoutMs);
  if (auditTimeoutMs <= 0) fail(model, 'auditTimeoutMs must be a positive number of ms');
  if (!Array.isArray(platformHosts)) fail(model, 'platformHosts must be an array');
  if (vendorPattern !== null && typeof vendorPattern !== 'string') {
    fail(model, 'vendorPattern, when provided, must be a RegExp source string');
  }
  if (typeof readTree !== 'function') fail(model, 'readTree must be a function');
  if (
    subagentSeam !== null &&
    (typeof subagentSeam !== 'object' || typeof subagentSeam.spawnSubagentTool === 'undefined')
  ) {
    // The seam, if provided, must come THROUGH the plumby boundary and expose
    // the read-only sub-agent spawner. We do not require it (the in-process
    // detector is primary), but a malformed seam is rejected at the edge.
    fail(model, 'subagentSeam, when provided, must be the plumby sub-agent seam (from src/engine/plumby.js)');
  }

  const platformHostMatcher = buildPlatformHostMatcher(platformHosts, vendorPattern);

  /**
   * Declared platform/vendor hosts the undeclared-host detector treats as
   * ALLOWED (they are the platform's own hosts, flagged separately as
   * platform-host findings, not as UNDECLARED outbound). Everything else that
   * looks like an outbound host but is not declared is surfaced for review.
   */
  const declaredHosts = new Set(
    platformHosts.filter((h) => typeof h === 'string' && h !== ''),
  );

  /**
   * Run every detector across a single decoded TEXT file body. Pushes findings
   * (with 1-indexed line numbers) onto `findings`. `envReadIndex` accumulates
   * the set of env-var NAMEs referenced anywhere, for the unused-env detector.
   */
  function scanFile(rel, body, findings, envReadIndex) {
    const lines = toLines(body);

    // Record which env-var NAMEs are read anywhere (any file counts as a read),
    // so the unused-env detector can tell declared-but-unread from used.
    const envMatches = body.match(/[A-Z][A-Z0-9_]{2,}/g);
    if (envMatches) {
      for (const name of envMatches) envReadIndex.add(name);
    }

    const isSource = SOURCE_EXT_RE.test(rel);
    const isJsx = JSX_EXT_RE.test(rel);
    const isJson = /\.json$/i.test(rel);
    const isEnforcementFile = ENFORCEMENT_EXT_RE.test(rel) || isRcConfig(rel);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineNo = i + 1;

      // (1) Telemetry / analytics SDK imports — source + json (a dependency
      // manifest can name an SDK). Package-qualified: no bare `amplitude`.
      if ((isSource || isJson) && TELEMETRY_RE.test(line)) {
        findings.push({
          signal: 'telemetry',
          severity: 'high',
          file: rel,
          line: lineNo,
          evidence: line.trim(),
        });
      }

      // (2) Hardcoded collector / beacon endpoints — source files.
      if (isSource && COLLECTOR_RE.test(line)) {
        findings.push({
          signal: 'collector',
          severity: 'high',
          file: rel,
          line: lineNo,
          evidence: line.trim(),
        });
      }

      // (3) Hardcoded platform hosts — the injected literals / vendorPattern.
      if (platformHostMatcher && platformHostMatcher.test(line)) {
        findings.push({
          signal: 'platform-host',
          severity: 'high',
          file: rel,
          line: lineNo,
          evidence: line.trim(),
        });
      }

      // (5) Hash-protection manifest — *.json only.
      if (isJson && HASH_MANIFEST_RE.test(line)) {
        findings.push({
          signal: 'hash-manifest',
          severity: 'high',
          file: rel,
          line: lineNo,
          evidence: line.trim(),
        });
      }

      // (6) Injected UI / badge / watermark — JSX construct, never the prose
      // word. JSX-bearing files only.
      if (isJsx && INJECTED_UI_RE.test(line)) {
        findings.push({
          signal: 'injected-ui',
          severity: 'medium',
          file: rel,
          line: lineNo,
          evidence: line.trim(),
        });
      }

      // (7a) Undeclared outbound hosts — an outbound URL host not in the
      // platform's declared/allowlisted set (and not already a collector hit).
      // Skip json manifests (their URLs are usually registry/homepage metadata).
      if (isSource) {
        OUTBOUND_URL_RE.lastIndex = 0;
        let m;
        while ((m = OUTBOUND_URL_RE.exec(line)) !== null) {
          const host = m[1];
          if (isLocalHost(host)) continue; // loopback/private is not outbound
          const isDeclared = [...declaredHosts].some(
            (h) => host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`),
          );
          if (!isDeclared) {
            findings.push({
              signal: 'undeclared-host',
              severity: 'medium',
              file: rel,
              line: lineNo,
              evidence: host,
            });
          }
        }
      }
    }

    // (4) Enforcement lint/convention rules — importFrom/mustImport/
    // requiredImports keys whose VALUE names the vendor. Scope the vendor match
    // to the mandate key's own value on the SAME or the NEXT line (never the
    // whole file / whole tree — the detect-lockin.sh next-line + empty-match
    // FP lessons). Only meaningful when a vendorPattern is configured.
    if (isEnforcementFile && vendorPattern) {
      const vendorRe = new RegExp(vendorPattern, 'i');
      for (let i = 0; i < lines.length; i += 1) {
        if (!MANDATE_KEY_RE.test(lines[i])) continue;
        // Inspect the key's own line and the next line only (pretty-printed
        // configs put the value on the following line).
        const sameLineValue = lines[i];
        const nextLineValue = i + 1 < lines.length ? lines[i + 1] : '';
        // Scope to the portion AFTER the mandate key so an unrelated vendor
        // mention elsewhere on the line does not manufacture a finding.
        const keyIdx = sameLineValue.search(MANDATE_KEY_RE);
        const afterKey = keyIdx >= 0 ? sameLineValue.slice(keyIdx) : sameLineValue;
        const scoped = `${afterKey}\n${nextLineValue}`;
        if (vendorRe.test(scoped)) {
          const hitLine = vendorRe.test(afterKey) ? i + 1 : i + 2;
          findings.push({
            signal: 'enforcement',
            severity: 'high',
            file: rel,
            line: hitLine,
            evidence: (hitLine === i + 1 ? lines[i] : nextLineValue).trim(),
          });
        }
      }
    }
  }

  /**
   * The unused-env detector: for every env-var NAME declared in a
   * .env.template/.example/.sample file, if it is not read ANYWHERE in the tree
   * report it (declared-but-unread). Uses the accumulated envReadIndex, but a
   * name is "read" only if it appears OUTSIDE its own declaring template.
   */
  function scanUnusedEnv(textFiles, findings) {
    for (const [rel, body] of Object.entries(textFiles)) {
      const base = rel.split('/').pop() ?? '';
      if (!ENV_TEMPLATE_BASENAMES.has(base)) continue;
      const lines = toLines(body);
      for (let i = 0; i < lines.length; i += 1) {
        const m = /^([A-Z][A-Z0-9_]*)=/.exec(lines[i]);
        if (!m) continue;
        const name = m[1];
        // Is this name read anywhere OTHER than an env-template declaration?
        let readElsewhere = false;
        const nameRe = new RegExp(`\\b${escapeRegExp(name)}\\b`);
        for (const [otherRel, otherBody] of Object.entries(textFiles)) {
          const otherBase = otherRel.split('/').pop() ?? '';
          if (ENV_TEMPLATE_BASENAMES.has(otherBase)) continue; // skip declarations
          if (nameRe.test(otherBody)) {
            readElsewhere = true;
            break;
          }
        }
        if (!readElsewhere) {
          findings.push({
            signal: 'unused-env',
            severity: 'medium',
            file: rel,
            line: i + 1,
            evidence: name,
          });
        }
      }
    }
  }

  /**
   * The core in-process detection over a { relPath: contents } tree map.
   * Returns { findings, unverifiedSurfaces }. A text file is scanned; a binary
   * (Buffer) or otherwise undecodable in-scope file is reported as an
   * UNVERIFIED SURFACE (Req 11.12), never silently omitted. Excluded paths are
   * skipped as DELIBERATE exclusions (not unverified surfaces).
   */
  function detect(tree) {
    const findings = [];
    const unverifiedSurfaces = [];
    const envReadIndex = new Set();
    const textFiles = {};

    for (const [rel, contents] of Object.entries(tree)) {
      if (isExcludedPath(rel)) continue; // deliberate exclusion, not unverified
      if (typeof contents === 'string') {
        textFiles[rel] = contents;
      } else if (Buffer.isBuffer(contents)) {
        // An in-scope binary/undecodable file cannot be scanned for signals —
        // report it as an unverified surface rather than omitting it silently.
        unverifiedSurfaces.push({
          file: rel,
          reason: 'binary or undecodable content (not scannable for lock-in signals)',
        });
      } else {
        unverifiedSurfaces.push({
          file: rel,
          reason: `unreadable tree entry of type ${typeof contents}`,
        });
      }
    }

    for (const [rel, body] of Object.entries(textFiles)) {
      scanFile(rel, body, findings, envReadIndex);
    }
    scanUnusedEnv(textFiles, findings);

    return { findings, unverifiedSurfaces };
  }

  /**
   * audit(projectId, options): scan a Project for lock-in signals.
   *
   * @param {string} projectId
   * @param {object} [options]
   * @param {Object<string,string|Buffer>} [options.tree]  scan this tree map
   *        directly (for testability) instead of reading from the layout.
   * @param {boolean} [options.platformGenerated]  when true, the Project is
   *        AI_App_Builder-generated, so every finding is a DEFECT to fix
   *        (Req 11.13) — reflected via `platformGenerated:true` on each finding
   *        and in the summary.
   * @param {object} [options.priorResult]  a prior { ok:true, findings, ... }
   *        result for an INCREMENTAL re-audit (Req 11.11).
   * @param {string[]} [options.changedFiles]  the rel-paths that changed since
   *        priorResult; only these are rescanned and combined with the prior
   *        findings for the UNCHANGED files, so the combined report reflects the
   *        CURRENT Project state (a removed signal does not persist).
   * @param {boolean} [options.readOnlySubagent]  opt into running through the
   *        read-only plumby sub-agent seam (requires a configured subagentSeam).
   * @returns {{ ok:true, ... } | { ok:false, code, message }}
   */
  function audit(projectId, options = {}) {
    requireString(model, 'projectId', projectId);
    if (options === null || typeof options !== 'object') {
      fail(model, 'options must be an object');
    }
    const platformGenerated = options.platformGenerated === true;

    if (options.readOnlySubagent === true && !subagentSeam) {
      fail(model, 'readOnlySubagent requires a subagentSeam configured through the plumby boundary');
    }

    // Resolve the tree to scan: an explicit tree map (testability) or the
    // on-disk exportable tree via the layout.
    let tree;
    if (options.tree !== undefined) {
      if (options.tree === null || typeof options.tree !== 'object' || Array.isArray(options.tree)) {
        fail(model, 'options.tree must be a { relPath: contents } map');
      }
      tree = options.tree;
    } else {
      if (!layout) {
        fail(model, 'audit requires either options.tree or a configured layout');
      }
      const root = layout.exportableProjectTree(projectId);
      try {
        tree = readTree(root);
      } catch (err) {
        return {
          ok: false,
          projectId,
          code: 'READ_FAILED',
          message: `failed to read the project tree for ${projectId}: ${err?.message ?? err}`,
        };
      }
    }

    const start = now();

    // Enforce the configurable file-count limit (Req 11.9) — REPORT excess,
    // never silently truncate.
    const fc = checkFileCount(tree, fileCountLimit);
    if (!fc.ok) {
      return {
        ok: false,
        projectId,
        code: 'FILE_COUNT_EXCEEDED',
        message: `project ${projectId} has ${fc.count} files, exceeding the audit file-count limit of ${fc.limit}`,
        count: fc.count,
        limit: fc.limit,
      };
    }

    // INCREMENTAL re-audit (Req 11.11): rescan ONLY the changed files and
    // combine with the prior findings for the UNCHANGED files, so the combined
    // report reflects the CURRENT state (a removed signal must not persist).
    let findings;
    let unverifiedSurfaces;
    const prior = options.priorResult;
    const changedFiles = options.changedFiles;
    if (prior && Array.isArray(changedFiles)) {
      if (!prior.ok || !Array.isArray(prior.findings)) {
        fail(model, 'priorResult must be a successful prior audit result with findings[]');
      }
      const changedSet = new Set(changedFiles);
      // Prior findings/surfaces for files that did NOT change carry forward.
      const carriedFindings = prior.findings.filter((f) => !changedSet.has(f.file));
      const carriedSurfaces = (prior.unverifiedSurfaces ?? []).filter(
        (s) => !changedSet.has(s.file),
      );
      // Rescan ONLY the changed files present in the current tree.
      const changedTree = {};
      for (const rel of changedSet) {
        if (Object.prototype.hasOwnProperty.call(tree, rel)) changedTree[rel] = tree[rel];
      }
      const rescanned = detect(changedTree);
      findings = [...carriedFindings, ...rescanned.findings];
      unverifiedSurfaces = [...carriedSurfaces, ...rescanned.unverifiedSurfaces];
    } else {
      const detected = detect(tree);
      findings = detected.findings;
      unverifiedSurfaces = detected.unverifiedSurfaces;
    }

    // A signal in AI_App_Builder-generated code is a DEFECT to fix (Req 11.13),
    // not a feature — flag every finding and note it in the summary.
    if (platformGenerated) {
      findings = findings.map((f) => ({ ...f, platformGenerated: true }));
    }

    // 120s SLO measured against the INJECTED clock — never a real wait.
    const auditMs = now() - start;
    if (auditMs > auditTimeoutMs) {
      return {
        ok: false,
        projectId,
        code: 'AUDIT_TIMEOUT',
        message: `audit of ${projectId} exceeded the ${auditTimeoutMs}ms SLO (took ${auditMs}ms)`,
        auditMs,
      };
    }

    const clean = findings.length === 0;
    const result = {
      ok: true,
      projectId,
      findings,
      unverifiedSurfaces,
      fileCount: fc.count,
      auditMs,
      clean,
      platformGenerated,
    };
    if (platformGenerated && !clean) {
      // Req 11.13: signals in generated code are DEFECTS, surfaced explicitly.
      result.defect = true;
      result.summary =
        `${findings.length} lock-in signal(s) found in platform-generated code — ` +
        `each is a DEFECT to fix, not a feature`;
    } else {
      result.summary = clean
        ? 'no lock-in signals found'
        : `${findings.length} lock-in signal(s) found`;
    }
    return result;
  }

  return Object.freeze({
    fileCountLimit,
    auditTimeoutMs,
    /** Whether a read-only sub-agent seam is configured (Req 11.2, optional). */
    hasSubagentSeam: subagentSeam !== null,
    audit,
    /** Exposed for a caller that already holds a tree map (thin convenience). */
    detect,
  });
}
