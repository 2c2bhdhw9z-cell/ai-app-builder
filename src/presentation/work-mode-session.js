/**
 * THE PER-SESSION WORK_MODE (spec Task 32, Req 28, Property 21).
 *
 * Holds a single Project Session's ACTIVE Work_Mode as pure interaction-FLOW
 * state — the mode that shapes only how the Builder Server frames the NEXT
 * turn's prompt/flow (vibe = describe-and-build, spec = plan/requirements-first,
 * hybrid = a blend). A new Session defaults to `vibe` (Req 28.3). It mirrors the
 * composing-factory conventions of the presentation layer (Tasks 19-31): a
 * factory `createWorkModeSession({ mode, now })` that returns a FROZEN handle,
 * an INJECTED clock `now`, structured `{ ok:false, code, message }` results, and
 * NO state change on failure.
 *
 * NON-MUTATION (Req 28.6, Property 21): this module holds ONLY the active mode
 * string and a pending switch target. It has NO reference to — and NO method
 * that can touch — source code, agent state, Project data, Snapshots, models,
 * Skills, Connectors, permissions, Project_Origin, Theme, or
 * Workspace_Experience. There is no code path from `applySwitch` (the ONLY
 * mutator) to any of those: a confirmed switch reshapes only the next turn's
 * flow and preserves ALL Project state unchanged. The switch is STRUCTURALLY
 * incapable of mutating anything but the mode string, exactly as the Task-31
 * Workspace_Experience store structurally cannot mutate non-layout state.
 *
 * CONFIRM-GATING (Req 28.5): `requestSwitch(target)` validates the target and
 * mints a pending switch WITHOUT applying it — a switch is only PENDING until an
 * explicit confirmation. The Builder Server routes that pending switch through
 * the EXISTING confirm surface (POST /confirm) and calls `applySwitch(target)`
 * only when the user approves. An out-of-enum target is rejected outright with
 * the current mode left in effect (Req 28.7) and mints no confirm.
 *
 * PLUMBY BOUNDARY: this module imports the data model/enums only (Node stdlib
 * only otherwise); it never imports the plumby package.
 */

import { randomUUID } from 'node:crypto';

import { isValidWorkMode, DEFAULT_WORK_MODE, Work_Mode } from '../model/enums.js';

const MODEL = 'WorkModeSession';

/**
 * Create a per-Session Work_Mode holder.
 *
 * @param {object} [args]
 * @param {string} [args.mode]  the initial active mode. An unselected/omitted
 *   mode normalizes to DEFAULT_WORK_MODE ('vibe', Req 28.3); an out-of-enum
 *   initial mode is normalized to the default too (defensive read) rather than
 *   throwing.
 * @param {() => Date} [args.now]  injected clock (default () => new Date()).
 * @returns {object} handle (frozen)
 */
export function createWorkModeSession({ mode, now = () => new Date() } = {}) {
  // Constructor normalizes an unselected/omitted OR out-of-enum initial mode to
  // the documented default (Req 28.3). No throwing on a defensive read.
  let currentMode = isValidWorkMode(mode) ? mode : DEFAULT_WORK_MODE;

  /** The pending switch target awaiting confirmation, or null. */
  let pendingTarget = null;

  /** current(): the active Work_Mode string. */
  function current() {
    return currentMode;
  }

  /**
   * creationChoices(): the frozen list of exactly the three offerable modes at
   * Session creation (Req 28.2). A fresh copy so a caller cannot mutate the enum.
   */
  function creationChoices() {
    return Object.freeze([...Work_Mode]);
  }

  /**
   * requestSwitch(target): validate a requested switch target (Req 28.5/28.7).
   * An out-of-enum target returns { ok:false, code:'unsupported_work_mode' } and
   * LEAVES the current mode unchanged — it mints NO confirm (Req 28.7). A valid
   * target returns { ok:true, target, requestId } and records the pending target
   * WITHOUT applying it: a switch is only pending until confirmed (Req 28.5).
   */
  function requestSwitch(target) {
    if (!isValidWorkMode(target)) {
      // Reject WITHOUT changing anything; the current mode stays in effect.
      return {
        ok: false,
        code: 'unsupported_work_mode',
        message: `${MODEL}: unsupported Work_Mode ${JSON.stringify(target)}`,
      };
    }
    const requestId = randomUUID();
    pendingTarget = { requestId, target };
    return { ok: true, target, requestId };
  }

  /**
   * applySwitch(target): the ONLY method that mutates the active mode. Called by
   * the Builder Server AFTER an explicit user confirmation resolves TRUE. Sets
   * the active mode to `target` and clears any pending switch. An out-of-enum
   * target is refused with the current mode left in effect (defensive; the
   * server only reaches here for a confirmed valid target). Returns
   * { ok:true, mode:target, at }. Reshapes only the next turn's flow — it holds
   * only the mode string and CANNOT touch any Project state (Req 28.6).
   */
  function applySwitch(target) {
    if (!isValidWorkMode(target)) {
      return {
        ok: false,
        code: 'unsupported_work_mode',
        message: `${MODEL}: unsupported Work_Mode ${JSON.stringify(target)}`,
      };
    }
    currentMode = target;
    pendingTarget = null;
    return { ok: true, mode: target, at: now().toISOString() };
  }

  /** pending(): the pending switch target awaiting confirmation, or null. */
  function pending() {
    return pendingTarget ? { ...pendingTarget } : null;
  }

  return Object.freeze({
    current,
    creationChoices,
    requestSwitch,
    applySwitch,
    pending,
  });
}
