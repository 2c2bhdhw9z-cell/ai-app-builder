/*
 * store.js — the Web UI's single observable client-side state store
 * (spec Task 2.1; design §"State store", Req 2.5, 9.3, 9.4, 9.5).
 *
 * This is the one place client state lives. Views subscribe to slices; feature
 * controllers mutate through named actions dispatched here. Centralizing the
 * state is what makes the harder cross-cutting behaviors correct and testable
 * in isolation: the SSE "replay current state on reconnect" merge, the preview
 * poll overriding a stale status, the running-turn concurrency gate, and the
 * theme preview-then-commit/revert state machine.
 *
 * It is deliberately DOM-free and dependency-free vanilla ES module code:
 *   - no import of any browser global, so it runs verbatim under `node --test`;
 *   - no runtime dependency added to the package (anti-lock-in: the client is
 *     no-build vanilla ES modules);
 *   - the reducer is a PURE function of (state, action) -> state, exported so
 *     property tests exercise the REAL reducer rather than a stand-in double.
 *
 * None of this state is server-authoritative — it mirrors what the fixed
 * backend contracts report. The store never touches the network itself; the
 * transport layer (api.js / sse.js / preview-poll.js) dispatches actions into
 * it.
 */

// ------------------------------------------------------------- Data models

/**
 * The nine palette keys a Theme carries, in a stable order. Mirrors the
 * backend THEME_CATALOG palette shape (src/model/enums.js). Applying a palette
 * later sets one `--color-<key>` CSS custom property per key on the document
 * root; the store only holds the values.
 * @type {readonly string[]}
 */
export const PALETTE_KEYS = Object.freeze([
  'background',
  'surface',
  'accent',
  'button',
  'badge',
  'statusInfo',
  'statusSuccess',
  'statusWarning',
  'statusError',
]);

/** The three Work_Mode values; `vibe` is the default for a new session. */
export const WORK_MODES = Object.freeze(['vibe', 'spec', 'hybrid']);

/**
 * Build the initial client state. A factory (not a shared frozen singleton) so
 * each store — and each test — starts from an independent, mutation-free tree.
 * @returns {object}
 */
export function initialState() {
  return {
    // Token presence only — the actual TokenRecord lives in the Token_Store
    // (Task 8). The store mirrors whether a token is held so gated views can
    // react without reading the secret.
    auth: { hasToken: false, accountId: null },

    session: {
      projectId: null,
      // connecting | open | reconnecting | lost | unauthorized | idle
      connection: 'idle',
      reconnectAttempts: 0, // 0..10
      submitInFlight: false, // gates a 2nd /message (Req 2.5)
      pendingPromptText: '', // retained across timeout/429 (Req 2.6, 2.8)
      lastSeq: null, // highest rendered monotonic sequence id (Req 3.3)
      activity: [], // ordered reasoning/tool/diff items
      // requestId -> confirm payload; pending confirms (Req 5.3, 5.4)
      pendingConfirms: {},
      // A user-facing, non-disclosing notice slice (e.g. timeout, rate-limit,
      // re-auth). Controllers set this; views render it. Never carries raw
      // backend detail from a 401 body.
      notice: null,
    },

    preview: {
      status: 'loading', // loading|ready|showing_prior|error|persistent_failure
      url: null,
      snapshotId: null,
      showingPrior: false,
      cause: null, // safe single-line summary only
      restartOffered: false,
      mobile: null, // { url } -> QR + selectable text
      source: 'sse', // 'sse' | 'poll'
    },

    theme: {
      catalog: {}, // { [themeId]: { id, displayName, base, palette } }
      committedTheme: null, // last committed theme id (Req 9.4)
      committedPalette: null, // applied baseline; revert target (Req 9.5)
      previewedTheme: null, // uncommitted preview id (Req 9.3)
      previewedPalette: null, // uncommitted preview palette (never committed)
      workspaceExperience: null, // theme is committed per (account, experience)
    },

    workspace: {
      experience: null, // one of the five, or null before bootstrap
      layout: null, // LayoutDescriptor from the frame
      attribution: null, // rendered when present (Req 8.4)
    },

    workMode: {
      active: 'vibe', // defaults to 'vibe' for a new session (Req 10.5)
      choices: [...WORK_MODES], // offered choices from the frame (Req 10.2)
    },
  };
}

// ------------------------------------------------------------------ Actions

/**
 * The closed set of action types the reducer understands. Kept as an exported
 * frozen map so controllers dispatch by name and typos surface as no-ops that
 * are easy to grep. Only the actions this task's slices need are defined;
 * later tasks extend this set alongside their controllers.
 */
export const ACTIONS = Object.freeze({
  // auth / token presence
  TOKEN_SET: 'token/set',
  TOKEN_CLEARED: 'token/cleared',

  // session / running turn (Req 2.5, 2.6, 2.8)
  SESSION_OPEN: 'session/open',
  SESSION_CLOSE: 'session/close',
  SUBMIT_STARTED: 'submit/started',
  SUBMIT_ENDED: 'submit/ended',
  PROMPT_TEXT_SET: 'prompt/textSet',
  NOTICE_SET: 'notice/set',
  NOTICE_CLEARED: 'notice/cleared',
  CONNECTION_SET: 'connection/set',

  // theme preview/commit/cancel (Req 9.3–9.5)
  THEME_CATALOG_SET: 'theme/catalogSet',
  THEME_PREVIEWED: 'theme/previewed', // previewed:true frame — never touches committed
  THEME_COMMITTED: 'theme/committed', // committed frame / read — overwrites committed
  THEME_PREVIEW_CANCELLED: 'theme/previewCancelled', // revert to committed
});

// ------------------------------------------------------------------ Reducer

/**
 * The pure reducer: (state, action) -> nextState. Never mutates its input; it
 * returns a new top-level object with only the touched slices replaced. Unknown
 * action types return the SAME state reference (so subscribers are not notified
 * for a no-op) — this is what lets `dispatch` skip notification cheaply.
 *
 * Exported so property/unit tests drive the real reducer directly.
 *
 * @param {object} state
 * @param {{ type: string, [k: string]: any }} action
 * @returns {object}
 */
export function reducer(state, action) {
  switch (action?.type) {
    // ---- token presence -------------------------------------------------
    case ACTIONS.TOKEN_SET:
      return {
        ...state,
        auth: { hasToken: true, accountId: action.accountId ?? null },
      };

    case ACTIONS.TOKEN_CLEARED:
      return { ...state, auth: { hasToken: false, accountId: null } };

    // ---- session / running turn ----------------------------------------
    case ACTIONS.SESSION_OPEN:
      // Opening a session resets the per-session running-turn/activity slice
      // but preserves token/theme/workspace. A NEW session defaults Work_Mode
      // to 'vibe' until a differing frame arrives (Req 10.5).
      return {
        ...state,
        session: {
          ...initialState().session,
          projectId: action.projectId ?? null,
          connection: 'connecting',
        },
        workMode: { active: 'vibe', choices: [...WORK_MODES] },
      };

    case ACTIONS.SESSION_CLOSE:
      return { ...state, session: { ...initialState().session } };

    case ACTIONS.CONNECTION_SET:
      return {
        ...state,
        session: {
          ...state.session,
          connection: action.connection,
          reconnectAttempts:
            typeof action.reconnectAttempts === 'number'
              ? action.reconnectAttempts
              : state.session.reconnectAttempts,
        },
      };

    case ACTIONS.SUBMIT_STARTED: {
      // Concurrency gate (Req 2.5): a submit while one is already in flight is a
      // NO-OP — it must not clobber the in-flight state or re-arm anything. The
      // caller (builder controller) is responsible for not issuing the network
      // call; the store refuses to represent two concurrent in-flight turns.
      if (state.session.submitInFlight) return state;
      return {
        ...state,
        session: {
          ...state.session,
          submitInFlight: true,
          // The trimmed text being sent is retained so a timeout/429 can offer
          // it back for retry (Req 2.6, 2.8).
          pendingPromptText:
            typeof action.promptText === 'string'
              ? action.promptText
              : state.session.pendingPromptText,
          notice: null,
        },
      };
    }

    case ACTIONS.SUBMIT_ENDED:
      // End the in-flight turn (turn done, timeout, or error). Re-enables submit
      // by clearing the gate. `retainText` (default true) keeps pendingPromptText
      // for retry on timeout/429; a successful completion may clear it.
      return {
        ...state,
        session: {
          ...state.session,
          submitInFlight: false,
          pendingPromptText:
            action.retainText === false ? '' : state.session.pendingPromptText,
        },
      };

    case ACTIONS.PROMPT_TEXT_SET:
      return {
        ...state,
        session: { ...state.session, pendingPromptText: String(action.text ?? '') },
      };

    case ACTIONS.NOTICE_SET:
      // A generic, non-disclosing user notice. `kind` classifies it (e.g.
      // 'timeout' | 'rateLimited' | 'reauth' | 'error'); `message` is a safe,
      // client-authored string. Any named limit rides in `limit` (Req 2.8/7.5).
      return {
        ...state,
        session: {
          ...state.session,
          notice: {
            kind: action.kind ?? 'error',
            message: action.message ?? '',
            limit: action.limit ?? null,
          },
        },
      };

    case ACTIONS.NOTICE_CLEARED:
      return { ...state, session: { ...state.session, notice: null } };

    // ---- theme preview / commit / cancel -------------------------------
    case ACTIONS.THEME_CATALOG_SET:
      return {
        ...state,
        theme: {
          ...state.theme,
          catalog: action.catalog ?? state.theme.catalog,
          workspaceExperience:
            action.workspaceExperience ?? state.theme.workspaceExperience,
        },
      };

    case ACTIONS.THEME_PREVIEWED:
      // INVARIANT (Req 9.3): a previewed frame writes previewedTheme/Palette
      // ONLY and MUST NOT touch committedTheme/committedPalette. Even if the
      // action carelessly carries a `committed*` field, it is ignored here.
      return {
        ...state,
        theme: {
          ...state.theme,
          previewedTheme: action.themeId ?? null,
          previewedPalette: normalizePalette(action.palette),
          // committedTheme / committedPalette intentionally UNCHANGED.
        },
      };

    case ACTIONS.THEME_COMMITTED:
      // INVARIANT (Req 9.4): only a committed frame/read overwrites the
      // committed theme+palette. Committing also clears any active preview so
      // the surface baseline and the preview state agree.
      return {
        ...state,
        theme: {
          ...state.theme,
          committedTheme: action.themeId ?? state.theme.committedTheme,
          committedPalette: normalizePalette(action.palette) ?? state.theme.committedPalette,
          previewedTheme: null,
          previewedPalette: null,
        },
      };

    case ACTIONS.THEME_PREVIEW_CANCELLED:
      // INVARIANT (Req 9.5): cancelling/navigating away reverts to committed —
      // it drops the preview and leaves committed untouched. Re-applying the
      // committed palette to the surface is the view's job; the store just
      // clears the preview so `committedPalette` is the active baseline again.
      return {
        ...state,
        theme: { ...state.theme, previewedTheme: null, previewedPalette: null },
      };

    default:
      return state;
  }
}

// ------------------------------------------------------------------ Helpers

/**
 * Coerce a palette-like input into a plain 9-key palette object, or null when
 * absent. Only the recognized PALETTE_KEYS are copied (defensive: an SSE frame
 * could carry extra fields we must not smuggle into state). Returns null if the
 * input is not an object so callers can distinguish "no palette given".
 *
 * @param {unknown} palette
 * @returns {Record<string,string>|null}
 */
export function normalizePalette(palette) {
  if (!palette || typeof palette !== 'object') return null;
  const out = {};
  for (const key of PALETTE_KEYS) {
    if (typeof palette[key] === 'string') out[key] = palette[key];
  }
  return out;
}

// ------------------------------------------------------------------- Store

/**
 * Create an observable store around the pure reducer.
 *
 * Subscription model: `subscribe(selector, cb)` invokes `cb(selected, state)`
 * whenever the SELECTED slice changes reference between dispatches (compared
 * with Object.is). This is why the reducer returns a new object only for the
 * touched slices and the SAME state reference for unknown actions — a no-op
 * dispatch notifies nobody, and a dispatch that touches an unrelated slice does
 * not wake a subscriber watching this one. `subscribe` returns an unsubscribe
 * function. A selector defaults to identity (whole state).
 *
 * @param {object} [preloadedState] optional starting state (defaults to initialState()).
 * @returns {{ getState: () => object, dispatch: (action: object) => object, subscribe: (selector: Function, cb: Function) => (() => void) }}
 */
export function createStore(preloadedState) {
  let state = preloadedState ?? initialState();
  /** @type {Set<{ selector: Function, cb: Function, last: any }>} */
  const subscribers = new Set();

  function getState() {
    return state;
  }

  function dispatch(action) {
    const next = reducer(state, action);
    if (next === state) return state; // no-op: skip notification entirely
    const prev = state;
    state = next;
    for (const sub of subscribers) {
      const selected = sub.selector(state);
      if (!Object.is(selected, sub.last)) {
        const previous = sub.last;
        sub.last = selected;
        sub.cb(selected, state, prev, previous);
      }
    }
    return state;
  }

  function subscribe(selector, cb) {
    const sel = typeof selector === 'function' ? selector : (s) => s;
    const callback = typeof selector === 'function' ? cb : selector;
    const sub = { selector: sel, cb: callback, last: sel(state) };
    subscribers.add(sub);
    return function unsubscribe() {
      subscribers.delete(sub);
    };
  }

  return { getState, dispatch, subscribe };
}

// ------------------------------------------------------------- Selectors

/** Whether a second concurrent /message submit is currently gated (Req 2.5). */
export function selectSubmitInFlight(state) {
  return state.session.submitInFlight;
}

/** The palette currently intended as the surface baseline (committed) (Req 9.5). */
export function selectCommittedPalette(state) {
  return state.theme.committedPalette;
}

/** The active palette to render: previewed if previewing, else committed. */
export function selectActivePalette(state) {
  return state.theme.previewedPalette ?? state.theme.committedPalette;
}
