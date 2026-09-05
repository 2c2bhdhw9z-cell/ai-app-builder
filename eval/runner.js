/**
 * The ai-app-builder eval RUNNER.
 *
 * It mirrors plumby/eval/runner.js: it constructs the REAL agent via the plumby
 * boundary (createAgent), points it at an isolated fs.mkdtemp temp dir holding a
 * case's fixture, runs the task, and scores an OBJECTIVE automated check. Only
 * the MODEL is swapped out — tests inject a scripted provider (no key, no
 * network) — while the loop, tools, permission model, and truncation are the
 * production path.
 *
 * The runner is PROVIDER-AGNOSTIC by design: it never resolves a provider
 * itself, it takes a `providerFor(case)` factory. That seam lets the harness's
 * own correctness be proven with the scripted provider while a real quality
 * measurement can use a real model.
 *
 * Safety and isolation guarantees, per case:
 *   - a fresh fs.mkdtemp temp dir, ALWAYS removed in a finally (even on throw);
 *   - a hard iteration cap (no runaway loop can burn the budget);
 *   - a NON-INTERACTIVE, safe bash policy — no confirm hook, so confirm-class
 *     commands are DENIED by default;
 *   - one case's failure never aborts the suite: a throw becomes a failing
 *     result whose detail is the error message.
 *
 * The objective check runs commands through node's child_process (NOT the
 * permission guard): a check is the harness's own assertion, not an agent tool
 * call, so it is not subject to the permission model.
 *
 * This is the shape the later toolchain-backed property tests will reuse.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createAgent,
  buildSystemPrompt,
  defaultTools,
  spawnSubagentTool,
  subagentTools,
} from '../src/engine/plumby.js';

const execFileAsync = promisify(execFile);

/** A sane default iteration cap for an eval run: enough to work, bounded. */
export const DEFAULT_EVAL_MAX_ITERATIONS = 25;

/** How long a single check command may run inside a fixture, in ms. */
const CHECK_TIMEOUT_MS = 60_000;

/** Clamp a detail string so a huge stderr never blows up a report. */
const DETAIL_MAX_CHARS = 20_000;
function clampDetail(detail) {
  const text = String(detail ?? '');
  if (text.length <= DETAIL_MAX_CHARS) return text;
  const dropped = text.length - DETAIL_MAX_CHARS;
  return `${text.slice(0, DETAIL_MAX_CHARS)}\n… [${dropped} more chars truncated]`;
}

/**
 * Run a single eval case against the REAL agent in an isolated temp dir.
 *
 * @param {object} args
 * @param {object} args.case                            the eval case (id, setup, prompt, check)
 * @param {(evalCase: object) => object} args.providerFor  returns the provider to drive this case
 * @param {number} [args.maxIterations]                 hard cap (case.maxIterations wins if set)
 * @param {(event: object) => void} [args.onEvent]      forwarded to the agent
 * @returns {Promise<{ id, pass, detail, stopReason, iterations, error }>}
 */
export async function runCase({ case: evalCase, providerFor, maxIterations, onEvent }) {
  const id = evalCase?.id ?? 'unknown';

  // Everything from here is guarded: a failure in setup, the agent run, or the
  // check is recorded as a failing result, never allowed to abort the suite.
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), `aab-eval-${safeSlug(id)}-`));
  } catch (error) {
    return failingResult(id, `could not create temp dir: ${error?.message ?? error}`, error);
  }

  try {
    if (typeof evalCase.setup === 'function') {
      await evalCase.setup(dir);
    }

    const provider = providerFor(evalCase);
    if (!provider) {
      throw new Error(`providerFor(${id}) returned no provider`);
    }

    const cap = evalCase.maxIterations ?? maxIterations ?? DEFAULT_EVAL_MAX_ITERATIONS;

    // The SAME assembly the surface uses: the full default toolset plus the
    // spawn_subagent tool, the real system prompt built for this cwd, and the
    // same provider re-used for any sub-agent. The bash policy is left at its
    // safe default (no confirm hook, bashPolicy undefined) so confirm-class
    // commands are denied.
    const agent = createAgent({
      provider,
      cwd: dir,
      system: buildSystemPrompt({ cwd: dir }),
      tools: [...defaultTools, spawnSubagentTool],
      subagentProvider: provider,
      subagentTools,
      maxIterations: cap,
      onEvent,
    });

    const result = await agent.send(evalCase.prompt);

    // The objective check. It runs commands in the fixture through
    // child_process — NOT through the permission guard: a check is the
    // harness's own assertion, not an agent tool call.
    const exec = (command, opts = {}) =>
      execFileAsync('sh', ['-c', command], {
        cwd: dir,
        timeout: opts.timeout ?? CHECK_TIMEOUT_MS,
        signal: opts.signal,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

    let checkResult;
    try {
      checkResult = await evalCase.check({ dir, result, exec });
    } catch (error) {
      return failingResult(id, `check threw: ${error?.message ?? error}`, error, result);
    }

    return {
      id,
      pass: checkResult?.pass === true,
      detail: clampDetail(checkResult?.detail ?? ''),
      stopReason: result.stopReason,
      iterations: result.iterations,
      error: result.error ? String(result.error?.message ?? result.error) : null,
    };
  } catch (error) {
    return failingResult(id, `case errored: ${error?.message ?? error}`, error);
  } finally {
    // Always clean up, even on throw. Best-effort: a cleanup failure must not
    // mask the real result.
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Run a whole suite of cases. Never lets one case abort the rest.
 *
 * @param {object} args
 * @param {Array<object>} args.cases
 * @param {(evalCase: object) => object} args.providerFor
 * @param {number} [args.maxIterations]
 * @param {(event: object) => void} [args.onEvent]
 * @returns {Promise<Array<{ id, pass, detail, stopReason, iterations, error }>>}
 */
export async function runSuite({ cases = [], providerFor, maxIterations, onEvent }) {
  const results = [];
  for (const evalCase of cases) {
    // runCase already guards itself, but wrap once more so a truly unexpected
    // throw (e.g. providerFor itself blowing up) still becomes a result.
    try {
      results.push(await runCase({ case: evalCase, providerFor, maxIterations, onEvent }));
    } catch (error) {
      results.push(
        failingResult(evalCase?.id ?? 'unknown', `runner errored: ${error?.message ?? error}`, error),
      );
    }
  }
  return results;
}

/** A failing per-case result with a clamped detail and any diagnostics from the run. */
function failingResult(id, detail, error, result) {
  return {
    id,
    pass: false,
    detail: clampDetail(detail),
    stopReason: result?.stopReason ?? null,
    iterations: result?.iterations ?? 0,
    error: error ? String(error?.message ?? error) : null,
  };
}

/** Make an id safe for a temp-dir suffix. */
function safeSlug(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'case';
}
