/**
 * THE COMMAND GUARD — the fail-closed SURFACE GATE in front of the
 * Isolation_Boundary (spec Task 6, Req 8.7–8.10 and 22.1–22.7; Property 5).
 *
 * The boundary is NOT the gate. SandboxManager.exec (src/sandbox/sandbox-manager.js)
 * confines EVERY command byte-for-byte identically and never consults the
 * classifier — an `allow` and a `refuse` command are contained the same way.
 * The CommandGuard is the SEPARATE, classifier-DEPENDENT gate that decides
 * WHETHER a command reaches exec at all. It composes plumby's PURE classifier
 * (re-exported through the plumby boundary at src/engine/plumby.js) and NEVER
 * reimplements classification.
 *
 * THE GATE, in order:
 *   1. classify the command under a fail-closed 10s ceiling. A classifier that
 *      is missing, throws, or does not answer in time is treated as `refuse` —
 *      the command is NOT executed (Req 8.8, 22.5).
 *   2. branch on the verdict:
 *        refuse  -> never call exec; state unchanged (Req 8.9, 22.3; Property 5).
 *        confirm -> emit a confirm_request on a clean seam and await consent
 *                   under a <=60s ceiling; execute only on an explicit grant,
 *                   otherwise deny with state unchanged (Req 8.10, 22.4).
 *        allow   -> call manager.exec and map its denial contract (Req 8.7).
 *   3. a sub-agent (subAgent:true) is a read-only delegate: confirm-class AND
 *      refuse-class are blocked WITHOUT execution; only allow-class proceeds
 *      (Req 22.6). This mirrors plumby's read-only sub-agent policy / its
 *      subagentTools bundle, which live behind the plumby boundary.
 *   4. captured stdout/stderr are truncated per stream to 64 KB of BYTES with a
 *      single notice line naming the omitted byte count (Req 22.7).
 *
 * The guard consumes exec's frozen denial contract and never relabels it: a
 * launch-failure/timeout is `denied` (the boundary refused/killed); a non-zero
 * in-box exit is the command's OWN failure (executed:true, denied:false) and is
 * NEVER mistaken for a boundary refusal.
 *
 * Factory pattern mirrors createSandboxManager / createContainerBackend: it
 * returns a frozen object.
 */

import { fail } from '../model/validate.js';
// Compose plumby's PURE classifier through THE plumby boundary. Never import
// from the plumby package directly here; never reimplement classification.
import { classifyCommand as defaultClassify } from '../engine/plumby.js';

/** Default per-stream truncation ceiling: 64 KB measured in BYTES (utf8). */
export const DEFAULT_TRUNCATE_LIMIT_BYTES = 65536;
/** Default fail-closed classification ceiling. */
export const DEFAULT_CLASSIFY_TIMEOUT_MS = 10_000;
/** Default consent ceiling for a confirm-class command. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * Truncate a single output stream to `limitBytes` measured in BYTES (utf8),
 * NOT characters. If the stream fits, it is returned unchanged. If it exceeds
 * the limit, exactly the first `limitBytes` bytes are retained (backed off to a
 * safe UTF-8 boundary so a multibyte sequence is never split) and a notice is
 * appended ON ITS OWN LINE naming the number of bytes omitted.
 *
 * @param {string} text
 * @param {number} [limitBytes=65536]
 * @returns {string}
 */
export function truncateStream(text, limitBytes = DEFAULT_TRUNCATE_LIMIT_BYTES) {
  if (typeof text !== 'string' || text === '') return text ?? '';
  const buf = Buffer.from(text, 'utf8');
  const totalBytes = buf.length;
  if (totalBytes <= limitBytes) return text;

  // Back the cut point off any position that lands in the MIDDLE of a UTF-8
  // multibyte sequence: a continuation byte matches 0b10xxxxxx (0x80–0xBF). We
  // walk left from `limitBytes` until we are at a lead byte / ASCII boundary,
  // so the retained slice is always valid UTF-8 and <= limitBytes.
  let cut = limitBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  const kept = buf.subarray(0, cut).toString('utf8');
  const omitted = totalBytes - cut;
  return `${kept}\n[output truncated: ${omitted} bytes omitted]`;
}

/** Race a promise against a timer; resolves to `timeoutValue` if it wins. */
function withTimeout(promise, ms, timeoutValue) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), ms);
    // Do not keep the event loop alive purely for this guard timer.
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        return { settled: true, value };
      },
      (error) => {
        clearTimeout(timer);
        return { settled: true, error };
      },
    ),
    timeout.then((value) => ({ settled: false, value })),
  ]);
}

let requestCounter = 0;
/** Monotonic-ish request id for confirm_request correlation. */
function nextRequestId() {
  requestCounter += 1;
  return `cg-${Date.now().toString(36)}-${requestCounter}`;
}

/**
 * Create a CommandGuard.
 *
 * @param {object} args
 * @param {object} args.manager                 a SandboxManager (must have exec)
 * @param {(cmd:string)=>{outcome,category,reason}} [args.classify]  defaults to
 *        plumby's classifyCommand via the engine boundary
 * @param {number} [args.confirmTimeoutMs=60000]
 * @param {number} [args.classifyTimeoutMs=10000]
 * @param {(req:object)=>(Promise<boolean>|boolean)} [args.onConfirmRequest]
 *        the default consent seam (a run-level override takes precedence)
 * @param {number} [args.truncateLimitBytes=65536]
 * @returns {object} guard (frozen)
 */
export function createCommandGuard({
  manager,
  classify = defaultClassify,
  confirmTimeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS,
  classifyTimeoutMs = DEFAULT_CLASSIFY_TIMEOUT_MS,
  onConfirmRequest,
  truncateLimitBytes = DEFAULT_TRUNCATE_LIMIT_BYTES,
} = {}) {
  if (!manager || typeof manager.exec !== 'function') {
    fail('CommandGuard', 'manager with exec(projectId, command, opts) is required');
  }
  if (typeof classify !== 'function') {
    fail('CommandGuard', 'classify must be a function');
  }

  /**
   * Classify under a fail-closed ceiling. classifyCommand is pure/synchronous
   * so it normally answers instantly, but the guard STILL enforces the ceiling
   * and treats a classifier that is missing, throws, or does not answer within
   * classifyTimeoutMs as `refuse`. classify is wrapped in a Promise raced
   * against a timer, so a hung/injected async classifier is also covered.
   *
   * @returns {Promise<{ classification:object|null, failedClosed:boolean }>}
   */
  async function classifyFailClosed(command) {
    const outcome = await withTimeout(
      (async () => classify(command))(),
      classifyTimeoutMs,
      undefined,
    );
    if (!outcome.settled) {
      // The classifier did not answer within the ceiling.
      return { classification: null, failedClosed: true };
    }
    if (outcome.error !== undefined) {
      // The classifier threw (or was unavailable).
      return { classification: null, failedClosed: true };
    }
    const c = outcome.value;
    if (!c || typeof c.outcome !== 'string') {
      // Malformed verdict — cannot trust it. Fail closed.
      return { classification: null, failedClosed: true };
    }
    return { classification: c, failedClosed: false };
  }

  /**
   * Await consent for a confirm-class command under the 60s ceiling.
   *
   * Consent is modeled as an awaited promise the CALLER resolves (approve/deny),
   * raced against the confirm ceiling. The guard emits a confirm_request via the
   * supplied seam (run-level onConfirmRequest overrides the factory default);
   * the seam returns (or resolves to) a boolean grant. With no seam supplied,
   * or on a non-boolean answer, or on timeout, consent is DENIED (fail closed).
   *
   * @returns {Promise<{ granted:boolean, reason:string }>}
   */
  async function awaitConsent(request, seam) {
    if (typeof seam !== 'function') {
      return { granted: false, reason: `confirmation not granted within ${confirmTimeoutMs}ms` };
    }
    const outcome = await withTimeout(
      (async () => seam(request))(),
      confirmTimeoutMs,
      undefined,
    );
    if (!outcome.settled) {
      return { granted: false, reason: `confirmation not granted within ${confirmTimeoutMs}ms` };
    }
    if (outcome.error !== undefined) {
      return { granted: false, reason: 'confirmation denied' };
    }
    if (outcome.value === true) {
      return { granted: true, reason: 'confirmation granted' };
    }
    return { granted: false, reason: 'confirmation denied' };
  }

  /** Map exec's frozen denial contract into a frozen guard result. */
  function fromExecResult(classification, execResult) {
    return Object.freeze({
      outcome: 'allow',
      category: classification.category,
      classifyReason: classification.reason,
      executed: true,
      blocked: false,
      denied: execResult.denied === true,
      deniedReason: execResult.deniedReason ?? null,
      exitCode: typeof execResult.exitCode === 'number' ? execResult.exitCode : null,
      timedOut: execResult.timedOut === true,
      signal: execResult.signal ?? null,
      stdout: truncateStream(execResult.stdout ?? '', truncateLimitBytes),
      stderr: truncateStream(execResult.stderr ?? '', truncateLimitBytes),
      failedClosed: false,
    });
  }

  /**
   * run(projectId, command, opts) — the single choke point.
   *
   * @param {string} projectId
   * @param {string|string[]} command
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @param {boolean} [opts.subAgent=false]   a delegated (read-only) sub-agent command
   * @param {(req:object)=>(Promise<boolean>|boolean)} [opts.onConfirmRequest]
   *        run-level consent seam (overrides the factory default)
   * @param {number} [opts.timeoutMs]         exec wall-clock override
   * @returns {Promise<object>} a frozen structured result
   */
  async function run(projectId, command, opts = {}) {
    const { signal, subAgent = false, timeoutMs } = opts;
    const seam = opts.onConfirmRequest ?? onConfirmRequest;
    // classifyCommand accepts a string; an argv vector is joined so the pattern
    // rules see the same surface a shell would. Empty command -> allow (pure).
    const commandString = Array.isArray(command) ? command.join(' ') : command;

    // (1) FAIL-CLOSED classification.
    const { classification, failedClosed } = await classifyFailClosed(commandString);
    if (failedClosed) {
      return Object.freeze({
        outcome: 'refuse',
        category: 'unclassified',
        classifyReason: 'could not classify',
        executed: false,
        blocked: true,
        denied: false,
        deniedReason: null,
        exitCode: null,
        timedOut: false,
        signal: null,
        stdout: '',
        stderr: '',
        reason: 'could not classify',
        failedClosed: true,
      });
    }

    const { outcome, category, reason } = classification;

    // (3) Sub-agent read-only policy: block anything that is not allow-class,
    // WITHOUT execution. Mirrors plumby's read-only sub-agent policy — the
    // subagentTools bundle exposes no command execution beyond read-only work,
    // so a confirm/refuse-class command from a delegate never runs.
    if (subAgent && outcome !== 'allow') {
      return Object.freeze({
        outcome,
        category,
        classifyReason: reason,
        executed: false,
        blocked: true,
        denied: false,
        deniedReason: null,
        exitCode: null,
        timedOut: false,
        signal: null,
        stdout: '',
        stderr: '',
        reason: `read-only sub-agent policy blocks ${outcome}-class commands`,
        subAgent: true,
        failedClosed: false,
      });
    }

    // (2) refuse path: NEVER call manager.exec. State unchanged (Property 5).
    if (outcome === 'refuse') {
      return Object.freeze({
        outcome: 'refuse',
        category,
        classifyReason: reason,
        executed: false,
        blocked: true,
        denied: false,
        deniedReason: null,
        exitCode: null,
        timedOut: false,
        signal: null,
        stdout: '',
        stderr: '',
        reason,
        failedClosed: false,
      });
    }

    // (2) confirm path: emit a confirm_request and await consent (<=60s).
    if (outcome === 'confirm') {
      const requestId = nextRequestId();
      const request = Object.freeze({ requestId, projectId, command, category, reason });
      const consent = await awaitConsent(request, seam);
      if (!consent.granted) {
        return Object.freeze({
          outcome: 'confirm',
          category,
          classifyReason: reason,
          requestId,
          executed: false,
          blocked: false,
          denied: true,
          deniedReason: null,
          exitCode: null,
          timedOut: false,
          signal: null,
          stdout: '',
          stderr: '',
          reason: consent.reason,
          failedClosed: false,
        });
      }
      // Consent granted within the ceiling: proceed to the boundary.
      const execResult = await manager.exec(projectId, command, { timeoutMs, signal });
      return Object.freeze({
        ...fromExecResult(classification, execResult),
        outcome: 'confirm',
        requestId,
        confirmed: true,
      });
    }

    // (2) allow path: hand the command to the boundary and map its contract.
    const execResult = await manager.exec(projectId, command, { timeoutMs, signal });
    return fromExecResult(classification, execResult);
  }

  return Object.freeze({
    run,
    truncateStream,
    classifyTimeoutMs,
    confirmTimeoutMs,
    truncateLimitBytes,
  });
}
