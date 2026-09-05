/**
 * THE GENERATION GUARDRAIL (spec subtask 7.1, Req 9.7, 10.4, 11.4, 11.5).
 *
 * The PRIMARY mechanism that keeps secrets out of generated source is that the
 * platform references secrets BY NAME (env-var references) and injects the
 * VALUES at runtime through the Sandbox environment (see secret-store.js +
 * container-backend env injection). This module is the SECONDARY safety net
 * (Req 11.5): a pure, deterministic scan that catches any literal credential
 * value or hardcoded platform host that WOULD otherwise be written into a source
 * file, rewrites it into an env-var reference, and RECORDS every substitution in
 * a user-visible report.
 *
 * It is intentionally pure (no I/O, no state): it takes content (or a map of
 * files), the known secret VALUES (keyed by env-var NAME), and the set of
 * platform hosts, and returns the rewritten content/files plus a report array.
 */

import { requireArray, fail } from '../model/validate.js';

/** The env-var name a platform-host literal is rewritten to reference. */
export const PLATFORM_HOST_ENV_NAME = 'PLATFORM_HOST';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The env-var reference a substituted literal becomes. We use the JS
 * `process.env.NAME` form — the deterministic, language-agnostic-enough default
 * for the generated Node surface. (Callers wanting `${NAME}` shell form can wrap
 * the report themselves; the important guarantee is the literal is GONE.)
 */
function envReference(name) {
  return `process.env.${name}`;
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack` and replace each
 * with `replacement`. Returns { content, occurrences }.
 */
function replaceAllCount(haystack, needle, replacement) {
  if (needle === '') return { content: haystack, occurrences: 0 };
  const re = new RegExp(escapeRegExp(needle), 'g');
  let occurrences = 0;
  const content = haystack.replace(re, () => {
    occurrences += 1;
    return replacement;
  });
  return { content, occurrences };
}

/**
 * Scan a single file's content and substitute every known secret value and
 * platform host with an env-var reference, recording each substitution.
 *
 * @param {string} file        the file path/name (for the report)
 * @param {string} content     the generated source content
 * @param {Array<{name,value}>} secrets   known secrets ({ name, value })
 * @param {string[]} platformHosts        known platform host literals
 * @returns {{ content:string, report:Array<object> }}
 */
function scanContent(file, content, secrets, platformHosts) {
  let out = String(content);
  const report = [];

  // Secrets first: replace the longest values first so a value that contains
  // another value is handled before its substring (deterministic ordering).
  const orderedSecrets = [...secrets].sort((a, b) => b.value.length - a.value.length);
  for (const { name, value } of orderedSecrets) {
    if (typeof value !== 'string' || value === '') continue;
    const res = replaceAllCount(out, value, envReference(name));
    if (res.occurrences > 0) {
      out = res.content;
      report.push({ file, name, kind: 'secret', occurrences: res.occurrences });
    }
  }

  // Platform hosts: replace the longest host first (foo.example.com before
  // example.com) so a more-specific host is not partially clobbered.
  const orderedHosts = [...platformHosts].sort((a, b) => b.length - a.length);
  for (const host of orderedHosts) {
    if (typeof host !== 'string' || host === '') continue;
    const res = replaceAllCount(out, host, envReference(PLATFORM_HOST_ENV_NAME));
    if (res.occurrences > 0) {
      out = res.content;
      report.push({
        file,
        name: PLATFORM_HOST_ENV_NAME,
        kind: 'platform-host',
        occurrences: res.occurrences,
      });
    }
  }

  return { content: out, report };
}

/**
 * Normalize the `secrets` input into an array of { name, value } pairs. Accepts
 * either that array directly, or a plain { NAME: value } map.
 */
function normalizeSecrets(secrets) {
  if (secrets == null) return [];
  if (Array.isArray(secrets)) {
    return secrets.map((s) => {
      if (!s || typeof s.name !== 'string' || !ENV_NAME_RE.test(s.name)) {
        fail('generationGuardrail', `each secret needs a valid env-var name, got ${JSON.stringify(s?.name)}`);
      }
      return { name: s.name, value: String(s.value ?? '') };
    });
  }
  if (typeof secrets === 'object') {
    return Object.entries(secrets).map(([name, value]) => {
      if (!ENV_NAME_RE.test(name)) {
        fail('generationGuardrail', `secret name must be a valid env-var name, got ${JSON.stringify(name)}`);
      }
      return { name, value: String(value ?? '') };
    });
  }
  fail('generationGuardrail', 'secrets must be an array of {name,value} or a {NAME:value} map');
  return [];
}

/**
 * scanAndSubstitute — the guardrail entry point.
 *
 * Call it EITHER with a single `content` string, or with a `files` map of
 * { path: content }. Returns the rewritten content/files plus a flat `report`
 * array of every substitution ({ file, name, kind:'secret'|'platform-host',
 * occurrences }). Content with no known secret / host is returned unchanged with
 * an empty report.
 *
 * @param {object} args
 * @param {string} [args.content]                 a single file's content
 * @param {Object<string,string>} [args.files]    a { path: content } map
 * @param {Array<{name,value}>|Object} [args.secrets]  known secrets
 * @param {string[]} [args.platformHosts]         known platform host literals
 * @returns {{ content?:string, files?:object, report:Array<object> }}
 */
export function scanAndSubstitute({ content, files, secrets, platformHosts = [] } = {}) {
  const secretList = normalizeSecrets(secrets);
  const hosts = requireArray('generationGuardrail', 'platformHosts', platformHosts).filter(
    (h) => typeof h === 'string' && h !== '',
  );

  if (files != null) {
    if (typeof files !== 'object' || Array.isArray(files)) {
      fail('generationGuardrail', 'files must be a { path: content } map');
    }
    const outFiles = {};
    const report = [];
    for (const [file, body] of Object.entries(files)) {
      const res = scanContent(file, body, secretList, hosts);
      outFiles[file] = res.content;
      report.push(...res.report);
    }
    return { files: outFiles, report };
  }

  if (typeof content !== 'string') {
    fail('generationGuardrail', 'provide either a content string or a files map');
  }
  const res = scanContent('<content>', content, secretList, hosts);
  return { content: res.content, report: res.report };
}
