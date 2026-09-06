/**
 * self-healing.js — the Self-Healing controller (spec Task 17.1, Req 20.1-20.11).
 *
 * When plumby `verify` FAILs on a generation/refinement turn, the Self-Healing
 * controller runs a BOUNDED, OBSERVABLE, CANCELLATION-AWARE verify-driven loop:
 * it feeds the failure lines + output tail back to the Builder_Agent, asks for a
 * correction, re-runs verify, and repeats — stopping the INSTANT verify PASSes,
 * at a strict max-attempt cap, or early when the SAME failure keeps recurring
 * (an oscillation "signature" it refuses to retry variations of). On any stop
 * WITHOUT a PASS it reports the unresolved output + the full attempt history and
 * leaves the files editable so the user can intervene. On a PASS it reports the
 * resolution + attempts + corrective diffs and commits a turn-pass Snapshot.
 *
 * THE PLUMBY BOUNDARY (hard invariant): this module NEVER imports the plumby
 * package. It REUSES plumby verify (via the injected `verify` seam) and the
 * Builder_Agent loop (via the injected `agentFactory`) — it reimplements
 * NEITHER. Both arrive only as DI seams, exactly as src/project/project-manager.js
 * wires them (production wiring reaches plumby through src/engine/plumby.js).
 *
 * THE "DO NOT HEAL WHEN THE USER IS MID-EDIT" SAFEGUARD is expressed by the SEAM,
 * not by state inspection here: heal() is invoked ONLY from the generation /
 * refinement COMPLETION path (ProjectManager.runGeneration on a verify FAIL),
 * never from an in-flight user edit. Nothing calls heal() mid-edit, so the
 * controller cannot fire against a tree the user is actively editing.
 *
 * OFFLINE / HERMETIC: every time bound and every wait is measured against the
 * injected `now` clock; no real sleeps. The whole loop is verifiable offline via
 * the scripted-provider harness (test/support/scripted-agent.js) plus spy/counter
 * fakes for the verify + agentFactory seams. The injected `now` clock stamps an
 * `at` timestamp on every per-attempt history record and observability event, so
 * heal visibility is time-ordered against the SAME injected clock the rest of the
 * pipeline uses (no wall-clock reads inside the loop).
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock and every collaborator; structured { ok:true|false, code?, ... }
 * results for expected rejections (the controller never throws on an expected
 * path — a verify seam throwing is REPORTED as VERIFY_UNAVAILABLE, not rethrown).
 */

import { createHash } from 'node:crypto';

import { fail } from '../model/validate.js';
import { VERIFY_VERDICTS } from '../model/deployment.js';
import { normalizeVerifyResult } from './verify-result.js';

/** Inclusive floor/ceiling for the configurable max-attempt cap (Req 20.5). */
export const MAX_ATTEMPTS_FLOOR = 1;
export const MAX_ATTEMPTS_CEILING = 10;

/** Self-Healing config defaults (Req 20.5: enabled by default, 3 attempts). */
export const HEAL_CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  maxAttempts: 3,
});

/**
 * Build a stable, normalized failure SIGNATURE from a FAIL VerifyResult (Req
 * 20.8). The signature identifies "the SAME recurring error" across attempts so
 * the loop can stop early rather than retry variations of an unfixable failure.
 *
 * NORMALIZATION (documented): we hash the exitCode plus the failure lines and a
 * normalized output tail with the VOLATILE bits stripped so that two runs of the
 * identical error compare EQUAL even though their raw text differs run-to-run:
 *   - absolute filesystem paths          -> '<path>'
 *   - hex object ids / addresses (0x..)  -> '<hex>'
 *   - long digit runs (PIDs/ports/offs)  -> '<num>'
 *   - ISO-8601 timestamps                -> '<ts>'
 *   - clock times (HH:MM:SS[.mmm])       -> '<time>'
 *   - carriage returns + trailing WS     -> collapsed
 *
 * OVER-NORMALIZATION GUARD (Req 20.8 — "the same error recurring"): we do NOT
 * blanket-collapse ALL multi-digit numbers, because a short numeric error/status
 * code or line number is frequently the ONLY discriminator between two GENUINELY
 * different failures (e.g. HTTP 404 vs 500, or a compile error on line 12 vs 87).
 * Collapsing those would hash two distinct failures equal and trigger a PREMATURE
 * 'oscillation' stop that abandons a still-progressing fix. So the two fields are
 * normalized at DIFFERENT strengths:
 *   - `failureLines` (the discriminating summary) preserves SHORT numeric tokens
 *     (1..3 digits — status/error codes, line numbers) and only collapses LONG
 *     runs (4+ digits — PIDs, ports, byte offsets that vary per run);
 *   - `outputTail` (noisy scrollback) collapses ALL multi-digit runs (2+), since
 *     it carries the volatile pid/port/offset noise we explicitly want to ignore.
 * The result is a short hex digest, so signatures are cheap to compare and store.
 *
 * @param {object} verifyResult  a VerifyResult ({ verdict, exitCode, failureLines, outputTail })
 * @returns {string} a stable signature (hex digest)
 */
function normalizeFailureText(text, { collapseShortNumbers }) {
  const normalized = String(text ?? '')
    .replace(/\r/g, '')
    // ISO-8601 timestamps (2024-01-02T03:04:05.678Z and friends).
    .replace(/\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?/g, '<ts>')
    // Clock times HH:MM:SS(.mmm).
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    // Absolute POSIX / Windows paths.
    .replace(/(?:[A-Za-z]:)?(?:\/[\w.\-@ ]+)+\/?/g, '<path>')
    .replace(/[A-Za-z]:\\(?:[\w.\-@ ]+\\?)+/g, '<path>')
    // Hex ids / addresses.
    .replace(/0x[0-9a-fA-F]+/g, '<hex>');

  // Digit-run collapse: ALL multi-digit runs for the noisy outputTail, but only
  // LONG (4+) runs for failureLines so short error/status/line codes survive as
  // discriminators (see the OVER-NORMALIZATION GUARD note above).
  const withNums = collapseShortNumbers
    ? normalized.replace(/\b\d{2,}\b/g, '<num>')
    : normalized.replace(/\b\d{4,}\b/g, '<num>');

  return withNums
    // Collapse trailing whitespace per line and blank runs.
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function failureSignatureOf(verifyResult) {
  const vr = verifyResult ?? {};
  const exitCode = typeof vr.exitCode === 'number' ? vr.exitCode : '';
  const failureLines = normalizeFailureText(vr.failureLines, { collapseShortNumbers: false });
  const outputTail = normalizeFailureText(vr.outputTail, { collapseShortNumbers: true });

  return createHash('sha256')
    .update(`${exitCode}\u0000${failureLines}\u0000${outputTail}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Compose the correction prompt handed to the Builder_Agent for an attempt (Req
 * 20.3): supply the failing verify output — the failure lines AND the output
 * tail — plus the caller's original message for context, so the agent has what
 * it needs to correct the error.
 */
function buildCorrectionPrompt({ verifyResult, message, attempt }) {
  const parts = [
    `The previous attempt failed verification (attempt ${attempt}). ` +
      `Fix the errors below and make the project pass verification.`,
  ];
  if (typeof message === 'string' && message.trim() !== '') {
    parts.push(`\nOriginal request:\n${message.trim()}`);
  }
  if (verifyResult?.failureLines) {
    parts.push(`\nFailure:\n${verifyResult.failureLines}`);
  }
  if (verifyResult?.outputTail) {
    parts.push(`\nVerification output:\n${verifyResult.outputTail}`);
  }
  return parts.join('\n');
}

/**
 * Create a Self-Healing controller.
 *
 * @param {object} args
 * @param {Function} args.agentFactory  builds the Builder_Agent for a correction
 *        turn (plumby via the engine boundary) — the SAME seam shape the
 *        ProjectManager uses: agentFactory({ projectId, sandbox, project }) ->
 *        an agent (or { agent }) with a cancellation-aware send(text,{signal}).
 * @param {Function} args.verify        the verify seam; returns plumby-verify TEXT
 *        ('verdict: PASS'/'verdict: FAIL' ...) OR a VerifyResult-shaped object.
 * @param {object} [args.snapshotStore] OPTIONAL SnapshotStore; onTurnComplete is
 *        reused on a healed PASS so a healed green turn commits a 'turn-pass'
 *        Snapshot exactly like any PASS turn (design decision (b)).
 * @param {object} [args.persistenceStore] OPTIONAL PersistenceStore (reserved).
 * @param {object} [args.observability] OPTIONAL Observability; emitOperationalEvent
 *        / emitMetric surface per-attempt heal visibility on the Activity Stream.
 * @param {object} [args.quotaManager]  OPTIONAL QuotaManager; observeUsage is fed
 *        the sustained-failed-build abuse signal on give-up (Task-12 seam).
 * @param {() => number} [args.now]     injectable ms clock. Default Date.now.
 * @param {number} [args.defaultMaxAttempts]  default cap (3), validated to 1..10.
 * @returns {object} controller (frozen)
 */
export function createSelfHealingController({
  agentFactory,
  verify,
  snapshotStore,
  persistenceStore,
  observability,
  quotaManager,
  now = () => Date.now(),
  defaultMaxAttempts = HEAL_CONFIG_DEFAULTS.maxAttempts,
} = {}) {
  const model = 'SelfHealingController';
  if (typeof agentFactory !== 'function') fail(model, 'agentFactory must be a function');
  if (typeof verify !== 'function') fail(model, 'verify must be a function');
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');

  /**
   * Resolve + VALIDATE the effective config (Req 20.5). maxAttempts must be an
   * integer within the inclusive 1..10 range; an out-of-range value is REJECTED
   * with a structured error rather than silently coerced past the boundary (the
   * boundary is a real, tested reject). enabled defaults true.
   *
   * @returns {{ ok:true, enabled:boolean, maxAttempts:number }
   *          | { ok:false, code:'INVALID_CONFIG', message:string }}
   */
  function resolveConfig(config = {}) {
    const enabled = config.enabled === undefined ? HEAL_CONFIG_DEFAULTS.enabled : config.enabled === true;
    const rawMax = config.maxAttempts === undefined ? defaultMaxAttempts : config.maxAttempts;
    if (typeof rawMax !== 'number' || !Number.isInteger(rawMax)) {
      return { ok: false, code: 'INVALID_CONFIG', message: 'maxAttempts must be an integer' };
    }
    if (rawMax < MAX_ATTEMPTS_FLOOR || rawMax > MAX_ATTEMPTS_CEILING) {
      return {
        ok: false,
        code: 'INVALID_CONFIG',
        message: `maxAttempts must be within the inclusive range ${MAX_ATTEMPTS_FLOOR}..${MAX_ATTEMPTS_CEILING}, got ${rawMax}`,
      };
    }
    return { ok: true, enabled, maxAttempts: rawMax };
  }

  /**
   * Emit a per-attempt operational event + metric, when observability is
   * injected. `at` is stamped from the injected `now` clock so heal events are
   * time-ordered against the same clock the rest of the pipeline uses.
   */
  function emitAttempt({ projectId, attempt, verdict, signature, at }) {
    if (!observability) return;
    if (typeof observability.emitOperationalEvent === 'function') {
      observability.emitOperationalEvent({
        type: 'self_heal_attempt',
        subsystem: 'build',
        projectId,
        attempt,
        verdict,
        signature,
        at,
      });
    }
    if (typeof observability.emitMetric === 'function') {
      observability.emitMetric('self_heal.attempt', { subsystem: 'build', projectId, attempt, verdict, at });
    }
  }

  /** Feed the sustained-failed-build abuse signal on give-up, when a QuotaManager is injected. */
  function reportGiveUp({ sandbox, project, attempts }) {
    if (!quotaManager || typeof quotaManager.observeUsage !== 'function') return;
    const sandboxId = sandbox?.projectId ?? project?.sandboxId ?? project?.id;
    quotaManager.observeUsage(sandboxId, {
      failedBuilds: attempts,
      projectId: project?.id,
      reason: 'sustained-failed-build',
    });
  }

  /**
   * Run the injected verify seam and normalize it, catching a seam that throws
   * or yields no usable verdict into a structured VERIFY_UNAVAILABLE report (Req
   * 20.2 — report the cause, leave files unchanged). Returns either
   * { ok:true, verifyResult } or a VERIFY_UNAVAILABLE report.
   */
  async function safeVerify({ project, sandbox }) {
    let raw;
    try {
      raw = await verify({ projectId: project.id, sandbox, project });
    } catch (err) {
      return {
        ok: false,
        code: 'VERIFY_UNAVAILABLE',
        message: `verify could not produce a verdict: ${err?.message ?? String(err)}`,
        filesUnchanged: true,
      };
    }
    // A verify seam that returns nothing usable (null/undefined/empty) cannot
    // produce a verdict — report the cause, do NOT loop (Req 20.2).
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      return {
        ok: false,
        code: 'VERIFY_UNAVAILABLE',
        message: 'verify produced no usable verdict',
        filesUnchanged: true,
      };
    }
    return { ok: true, verifyResult: normalizeVerifyResult(raw) };
  }

  /**
   * heal({ project, sandbox, verifyResult, projectTree?, message?, signal?, config? })
   * — engaged when a verify verdict is FAIL. See the module header for the loop
   * contract. All outcomes are structured results (never a throw on an expected
   * path):
   *
   *   - disabled (Req 20.6):     { ok:false, verdict:'FAIL', reason:'disabled', attempts:0, verifyResult, editable:true }
   *   - verify-unavailable (20.2): { ok:false, code:'VERIFY_UNAVAILABLE', message, filesUnchanged:true }
   *   - cancelled:               { ok:false, code:'CANCELLED', reason:'cancelled', attempts, editable:true, history }
   *   - PASS (20.7/20.11):       { ok:true,  verdict:'PASS', attempts, verifyResult, diffs, snapshot?, history }
   *   - oscillation (20.8):      { ok:false, verdict:'FAIL', reason:'oscillation', attempts, verifyResult, ..., editable:true, history }
   *   - max-attempts (20.9/20.10): { ok:false, verdict:'FAIL', reason:'max-attempts', attempts, verifyResult, ..., editable:true, history }
   *   - invalid config (20.5):   { ok:false, code:'INVALID_CONFIG', message }
   */
  async function heal({ project, sandbox, verifyResult, projectTree, message, signal, config } = {}) {
    if (!project || typeof project.id !== 'string') {
      return { ok: false, code: 'PROJECT_REQUIRED', message: 'a project record is required' };
    }

    // Config validation FIRST (Req 20.5) — a bad cap is a structured reject.
    const cfg = resolveConfig(config);
    if (!cfg.ok) return cfg;

    // (a) Disabled: report the failing VerifyResult and attempt NO correction
    //     (Req 20.6). Files are left editable.
    if (!cfg.enabled) {
      return {
        ok: false,
        verdict: 'FAIL',
        reason: 'disabled',
        attempts: 0,
        verifyResult,
        failureLines: verifyResult?.failureLines,
        outputTail: verifyResult?.outputTail,
        editable: true,
      };
    }

    // The incoming verdict MUST be a usable FAIL. If no usable FAIL VerifyResult
    // was handed in, treat it as verify-cannot-produce (Req 20.2) — no agent turn.
    if (!verifyResult || typeof verifyResult.verdict !== 'string') {
      return {
        ok: false,
        code: 'VERIFY_UNAVAILABLE',
        message: 'no usable initial verify verdict was provided to heal',
        filesUnchanged: true,
      };
    }

    // (b) Capture the initial failure signature so a recurrence is detected.
    let currentResult = verifyResult;
    const seenSignatures = new Set([failureSignatureOf(currentResult)]);
    const history = [
      {
        attempt: 0,
        verdict: currentResult.verdict,
        signature: failureSignatureOf(currentResult),
        failureLines: currentResult.failureLines,
        at: now(),
      },
    ];
    emitAttempt({ projectId: project.id, attempt: 0, verdict: currentResult.verdict, signature: history[0].signature, at: history[0].at });

    const diffs = [];

    // (c) LOOP up to maxAttempts.
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
      // Cancellation check FIRST each iteration: an already-aborted signal stops
      // the loop cleanly with NO further agent/verify calls.
      if (signal && signal.aborted) {
        return cancelled({ attempts: attempt - 1, currentResult, history });
      }

      // Delegate a correction turn to the Builder_Agent (via the injected seam).
      const built = agentFactory({ projectId: project.id, sandbox, project });
      const agent = built && built.agent ? built.agent : built;
      if (!agent || typeof agent.send !== 'function') {
        return { ok: false, code: 'AGENT_UNAVAILABLE', message: 'agentFactory did not yield an agent with send()' };
      }

      const prompt = buildCorrectionPrompt({ verifyResult: currentResult, message, attempt });
      let sendResult;
      try {
        sendResult = await agent.send(prompt, { signal });
      } catch (err) {
        // A thrown abort (some agents reject on an aborted signal) is treated as
        // cancellation; any other throw is a structured GENERATION_FAILED.
        if (signal && signal.aborted) {
          return cancelled({ attempts: attempt - 1, currentResult, history });
        }
        return { ok: false, code: 'GENERATION_FAILED', message: err?.message ?? String(err), attempts: attempt - 1, editable: true, history };
      }
      // plumby's agent.send returns stopReason:'aborted' when the signal aborted.
      if (sendResult && sendResult.stopReason === 'aborted') {
        return cancelled({ attempts: attempt - 1, currentResult, history });
      }
      // Record the corrective diff for this attempt if the agent exposes one.
      const diff = sendResult && (sendResult.diff ?? sendResult.diffs);
      if (diff !== undefined) diffs.push({ attempt, diff });

      // Re-check cancellation AFTER the agent turn resolves but BEFORE the
      // re-verify: an abort that lands during/after the agent turn must NOT
      // trigger one more verify — stop cleanly with the same CANCELLED result.
      if (signal && signal.aborted) {
        return cancelled({ attempts: attempt - 1, currentResult, history });
      }

      // Re-run verify after the attempt (Req 20.4). A verify seam that cannot
      // produce a verdict inside the loop stops cleanly (Req 20.2 applies to a
      // re-verify too): report VERIFY_UNAVAILABLE with the attempt count.
      const reverify = await safeVerify({ project, sandbox });
      if (!reverify.ok) {
        return { ...reverify, attempts: attempt, history };
      }
      currentResult = reverify.verifyResult;
      const signature = failureSignatureOf(currentResult);
      history.push({ attempt, verdict: currentResult.verdict, signature, failureLines: currentResult.failureLines, at: now() });
      emitAttempt({ projectId: project.id, attempt, verdict: currentResult.verdict, signature, at: history[history.length - 1].at });

      // On PASS: STOP immediately (Req 20.7). Do NOT run another agent turn.
      if (currentResult.verdict === VERIFY_VERDICTS[0]) {
        return finalizePass({ project, projectTree, verifyResult: currentResult, attempts: attempt, diffs, history });
      }

      // On FAIL: if the signature was seen before, this is an oscillation —
      // STOP EARLY, do NOT retry variations (Req 20.8).
      if (seenSignatures.has(signature)) {
        reportGiveUp({ sandbox, project, attempts: attempt });
        return giveUp({ reason: 'oscillation', attempts: attempt, currentResult, history });
      }
      seenSignatures.add(signature);
      // Otherwise record the attempt and continue.
    }

    // (d) Reached the cap without a PASS (Req 20.9/20.10): report unresolved
    //     output + attempt count/history, leave files editable, feed the abuse
    //     signal, commit NO snapshot.
    reportGiveUp({ sandbox, project, attempts: cfg.maxAttempts });
    return giveUp({ reason: 'max-attempts', attempts: cfg.maxAttempts, currentResult, history });
  }

  /**
   * PASS outcome (Req 20.7/20.11): report resolution + attempts + corrective
   * diffs, and REUSE snapshotStore.onTurnComplete so a healed green turn commits
   * a 'turn-pass' Snapshot exactly like any PASS turn — only when projectTree +
   * snapshotStore are provided (mirrors runGeneration's guard). Snapshot logic is
   * NOT reinvented here.
   */
  function finalizePass({ project, projectTree, verifyResult, attempts, diffs, history }) {
    let snapshot;
    if (snapshotStore && typeof snapshotStore.onTurnComplete === 'function' && projectTree !== undefined) {
      snapshot = snapshotStore.onTurnComplete({ projectId: project.id, projectTree, verifyResult });
    }
    return {
      ok: true,
      verdict: 'PASS',
      attempts,
      verifyResult,
      diffs,
      ...(snapshot !== undefined ? { snapshot } : {}),
      history,
    };
  }

  /**
   * GIVE-UP outcome (Req 20.9/20.10): surface the captured failure output + the
   * full attempt history so the user can intervene, leave files editable, commit
   * NO snapshot. `reason` is 'max-attempts' (cap) or 'oscillation' (repeat).
   */
  function giveUp({ reason, attempts, currentResult, history }) {
    return {
      ok: false,
      verdict: 'FAIL',
      reason,
      attempts,
      verifyResult: currentResult,
      failureLines: currentResult?.failureLines,
      outputTail: currentResult?.outputTail,
      editable: true,
      history,
    };
  }

  /**
   * Cancellation outcome: abort cleanly with a structured result and NO further
   * agent/verify calls. Files are left editable.
   */
  function cancelled({ attempts, currentResult, history }) {
    return {
      ok: false,
      code: 'CANCELLED',
      reason: 'cancelled',
      attempts,
      verifyResult: currentResult,
      editable: true,
      history,
    };
  }

  return Object.freeze({
    heal,
    resolveConfig,
    failureSignatureOf,
    normalizeVerifyResult,
    MAX_ATTEMPTS_FLOOR,
    MAX_ATTEMPTS_CEILING,
    HEAL_CONFIG_DEFAULTS,
  });
}
