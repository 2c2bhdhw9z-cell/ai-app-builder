/*
 * settings/settings-state.js — a tiny observable surface-state holder shared by
 * the settings controllers (spec Task 14; design §"Controllers — settings/*.js").
 *
 * Each settings surface (provider, connectors, skills, memory, lifecycle) has a
 * little bit of screen-local state — the fetched list, the active/bound values,
 * an in-flight flag — that the shell's SHARED store deliberately does not model
 * (the shared store mirrors the fixed backend contracts; the settings surfaces
 * consume assumed-contract endpoints and are the last delivery stage). Rather
 * than each controller reinventing a subscribe/notify loop, they all use this
 * one small helper.
 *
 * It is intentionally minimal and mirrors the shared store's contract shape
 * (getState / subscribe / a mutation) so views feel identical:
 *   - getState()      → the current frozen-ish snapshot object (a shallow copy).
 *   - subscribe(cb)   → cb() is invoked after every state change; returns an
 *                       unsubscribe fn. (No selector — settings surfaces are
 *                       small enough that a whole-surface re-render is fine.)
 *   - set(patch)      → shallow-merge a patch and notify subscribers. A no-op
 *                       patch (nothing actually changes by reference/value on
 *                       the shallow keys) still notifies, keeping the helper
 *                       dead simple; callers only call set() when something did.
 *
 * DOM-free and dependency-free so it imports cleanly under `node --test`.
 */

/**
 * Create an observable surface-state holder.
 *
 * @param {object} [initial]  the initial state object
 * @returns {{ getState: () => object, subscribe: (cb: Function) => (() => void), set: (patch: object) => object }}
 */
export function createSettingsState(initial = {}) {
  let state = { ...initial };
  /** @type {Set<Function>} */
  const subscribers = new Set();

  function getState() {
    return state;
  }

  function set(patch) {
    if (patch && typeof patch === 'object') {
      state = { ...state, ...patch };
    }
    for (const cb of subscribers) {
      try {
        cb(state);
      } catch {
        // A misbehaving subscriber must not break other subscribers or the
        // controller flow.
      }
    }
    return state;
  }

  function subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    subscribers.add(cb);
    return function unsubscribe() {
      subscribers.delete(cb);
    };
  }

  return { getState, subscribe, set };
}
