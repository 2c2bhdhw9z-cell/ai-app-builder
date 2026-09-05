/**
 * dev-server.js — the Dev_Server process-launch SEAM (spec subtask 13.2, Req 1.3).
 *
 * A Dev_Server is the long-running development server a Project's Preview is
 * served from once a generation turn verifies PASS. In production it launches an
 * actual process/container inside the project's Isolation_Boundary and exposes a
 * Preview URL. Starting it is the last step of the generation -> verify ->
 * Dev_Server pipeline; the <=60s "Preview available after Dev_Server start" bound
 * (Req 1.3) is an SLO measured against an INJECTED CLOCK, never a real wait.
 *
 * WHY THIS IS ONLY A SEAM HERE (offline environment constraint): a real
 * long-running Dev_Server process, a real container, and a real Preview CANNOT
 * run in this offline/repository-access-only environment (no docker daemon, no
 * image pulls, no live processes, no external HTTP). So the ProjectManager takes
 * an INJECTED `devServer` abstraction with the stable shape:
 *
 *     start({ projectId, sandbox, targetCategory }) -> { ok, url?, startedAt? }
 *     stop(projectId)                               -> { ok, stopped }
 *
 * and the DEFAULT implementation below is SEAM-ONLY: it NEVER launches a real
 * process. It records intent (that a start was requested for a project, with a
 * synthesized preview url + startedAt from the injected clock) so the pipeline
 * and its SLO are fully observable and testable with fakes. A production
 * composition swaps in a real launcher behind this exact interface without
 * touching the ProjectManager.
 *
 * Conventions: a factory returning Object.freeze({...}) with dependency
 * injection for the clock; structured { ok, ... } results.
 */

import { requireString, fail } from '../model/validate.js';

/**
 * Create the default (seam-only) Dev_Server launcher.
 *
 * This implementation is deliberately inert: it does NOT spawn a process or a
 * container (impossible offline). It records that a start was requested for a
 * project and returns a structured handle with a synthesized preview url and a
 * startedAt drawn from the injected clock, so callers can observe the
 * start-time SLO deterministically. `stop` forgets the record. Both are
 * idempotent.
 *
 * @param {object} [args]
 * @param {() => string} [args.now]  injectable ISO-timestamp clock for startedAt
 * @param {(projectId:string)=>string} [args.urlFor]  injectable preview-url
 *        synthesizer (default: a loopback placeholder). NEVER a live endpoint
 *        here — a real Preview cannot be served offline.
 * @returns {object} devServer seam (frozen)
 */
export function createDevServer({
  now = () => new Date().toISOString(),
  urlFor = (projectId) => `http://preview.local/${projectId}`,
} = {}) {
  const model = 'DevServer';
  if (typeof now !== 'function') fail(model, 'now must be a function returning an ISO timestamp');
  if (typeof urlFor !== 'function') fail(model, 'urlFor must be a function');

  /** Live "running" dev servers, keyed by projectId. Seam-only bookkeeping. */
  const running = new Map();

  /**
   * start({ projectId, sandbox, targetCategory }) — record intent to start the
   * Dev_Server for a project. SEAM-ONLY: launches nothing. Returns
   * { ok:true, url, startedAt } so the caller can measure the start SLO against
   * the injected clock. Idempotent: starting an already-started project returns
   * the existing handle.
   *
   * @returns {{ ok:true, url:string, startedAt:string } | { ok:false, code:string, message:string }}
   */
  function start({ projectId, sandbox, targetCategory } = {}) {
    requireString(model, 'projectId', projectId);
    const existing = running.get(projectId);
    if (existing) return { ok: true, url: existing.url, startedAt: existing.startedAt };
    const startedAt = now();
    const url = urlFor(projectId);
    const record = { projectId, url, startedAt, targetCategory: targetCategory ?? null };
    running.set(projectId, record);
    return { ok: true, url, startedAt };
  }

  /**
   * stop(projectId) — forget the recorded Dev_Server for a project. Idempotent:
   * stopping a project that was never started is success.
   */
  function stop(projectId) {
    requireString(model, 'projectId', projectId);
    const stopped = running.delete(projectId);
    return { ok: true, stopped };
  }

  /** Introspection: is the Dev_Server recorded as running for a project? */
  function isRunning(projectId) {
    requireString(model, 'projectId', projectId);
    return running.has(projectId);
  }

  return Object.freeze({ start, stop, isRunning });
}
