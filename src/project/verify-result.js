/**
 * verify-result.js — the shared verify-seam result parser (Req 20.1).
 *
 * The plumby verify contract is TEXT whose FIRST line is 'verdict: PASS' or
 * 'verdict: FAIL'; callers may instead hand back an already-structured
 * VerifyResult-shaped object. Both the ProjectManager (runGeneration) and the
 * Self-Healing controller must interpret a verify result the SAME way, so the
 * single parser lives here and BOTH modules import it — no duplicated parser can
 * drift out of agreement.
 *
 * THE PLUMBY BOUNDARY: this helper never imports the plumby package. It only
 * shapes a raw verify seam value (text or object) into the model VerifyResult
 * via createVerifyResult (src/model/deployment.js). The verify seam itself is
 * injected by the caller (its production wiring wraps plumby verifyTool through
 * src/engine/plumby.js).
 */

import { createVerifyResult, VERIFY_VERDICTS } from '../model/deployment.js';

/**
 * Normalize a verify seam result into a VerifyResult record (createVerifyResult,
 * VERIFY_VERDICTS). The plumby verify contract is TEXT beginning with
 * 'verdict: PASS' or 'verdict: FAIL'; we parse that. A caller may instead pass
 * an already-structured VerifyResult-shaped object, which we accept directly.
 *
 * @param {string|object} raw
 * @returns {object} VerifyResult
 */
export function normalizeVerifyResult(raw) {
  // Already a structured result (has a verdict): validate through the model.
  if (raw && typeof raw === 'object' && typeof raw.verdict === 'string') {
    return createVerifyResult({
      verdict: raw.verdict,
      exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : (raw.verdict === 'PASS' ? 0 : 1),
      failureLines: typeof raw.failureLines === 'string' ? raw.failureLines : '',
      outputTail: typeof raw.outputTail === 'string' ? raw.outputTail : '',
    });
  }

  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  // The contract: the text BEGINS with 'verdict: PASS' or 'verdict: FAIL'.
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  const pass = /^verdict:\s*PASS\b/i.test(firstLine);
  const fail_ = /^verdict:\s*FAIL\b/i.test(firstLine);
  const verdict = pass ? VERIFY_VERDICTS[0] : fail_ ? VERIFY_VERDICTS[1] : VERIFY_VERDICTS[1];

  // Best-effort exit-code parse ("exit code: <n>"), default 0 on PASS / 1 on FAIL.
  let exitCode = verdict === 'PASS' ? 0 : 1;
  const m = /exit code:\s*(-?\d+)/i.exec(text);
  if (m) exitCode = Number.parseInt(m[1], 10);

  // On FAIL, capture the output tail (everything after the verdict line) so the
  // caller can report the failure without reinterpreting it.
  const outputTail = verdict === 'FAIL' ? text : '';
  const failureLines = verdict === 'FAIL' ? firstLine : '';

  return createVerifyResult({ verdict, exitCode, failureLines, outputTail });
}
