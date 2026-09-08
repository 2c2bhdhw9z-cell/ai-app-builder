/*
 * router.js — a tiny in-client view router for the chat-first shell (spec Task
 * 15.1; design §"Controllers — Router / view router", Req 1.3, 6.7, 16.1).
 *
 * The Web UI is a single same-origin document; there is no server-side routing
 * beyond the static shell. This router is the minimal, CSP-clean mechanism that
 * decides WHICH top-level surface is showing — the login gate, the builder /
 * workspace shell, or the settings panel — without any framework and without
 * touching the URL (so it needs no History API and cannot desync from the CSP's
 * form-action/base-uri). It is a small observable, exactly like the settings
 * surface state: getRoute() / subscribe(cb) / navigate(route).
 *
 * The set of routes is closed and small:
 *   - 'login'    — no valid Bearer_Token held; the login control shows.
 *   - 'builder'  — logged in; the workspace shell / builder screen shows
 *                  (project-creation gate → core builder once a session opens).
 *   - 'settings' — logged in; the settings panel shows.
 *
 * app.js derives login-vs-builder from the store's auth slice (the login gate is
 * already wired in Task 8), and this router only toggles the SETTINGS overlay on
 * top of the logged-in shell. So the effective rule the shell applies is:
 *   - not logged in → login (settings is never shown without a token, so a 401
 *     that clears the token via api.js onAccessDenied returns the user to login
 *     from the settings surface too — Req 6.7 / 16.1);
 *   - logged in + route 'settings' → settings panel;
 *   - logged in otherwise → builder/workspace shell.
 *
 * DOM-free and dependency-free so it imports cleanly under `node --test`.
 */

/** The closed set of top-level routes. */
export const ROUTES = Object.freeze(['login', 'builder', 'settings']);

/** True iff `route` is a known route. */
export function isRoute(route) {
  return ROUTES.includes(route);
}

/**
 * Create the view router.
 *
 * @param {object} [opts]
 * @param {string} [opts.initial='builder']  the initial route
 * @returns {{ getRoute: () => string, subscribe: (cb: Function) => (() => void), navigate: (route: string) => void, toggleSettings: () => void }}
 */
export function createRouter({ initial = 'builder' } = {}) {
  let route = isRoute(initial) ? initial : 'builder';
  /** @type {Set<Function>} */
  const subscribers = new Set();

  function getRoute() {
    return route;
  }

  function emit() {
    for (const cb of subscribers) {
      try {
        cb(route);
      } catch {
        // A misbehaving subscriber must not break navigation.
      }
    }
  }

  function navigate(next) {
    if (!isRoute(next) || next === route) return;
    route = next;
    emit();
  }

  /** Toggle between the settings panel and the builder shell. */
  function toggleSettings() {
    navigate(route === 'settings' ? 'builder' : 'settings');
  }

  function subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    subscribers.add(cb);
    return function unsubscribe() {
      subscribers.delete(cb);
    };
  }

  return { getRoute, subscribe, navigate, toggleSettings };
}
