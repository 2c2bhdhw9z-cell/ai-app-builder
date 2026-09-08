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
      // A `ready` frame that arrives with a missing/empty url must NOT replace
      // the shown preview; instead the prior state is retained and this flag is
      // raised so the view shows a "ready URL unavailable" error (Req 4.2). It
      // is cleared by any subsequent frame that resolves the preview state.
      urlUnavailable: false,
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

  // ---- Activity_Stream + SSE frame-driven actions (Task 4.2) ----------
  // Append one normalized Activity_Stream item, ordered by monotonic seq
  // (Req 3.3). A duplicate seq is ignored so a replay never double-renders.
  ACTIVITY_APPENDED: 'activity/appended',
  // Reset the Activity_Stream (e.g. on a fresh session open).
  ACTIVITY_CLEARED: 'activity/cleared',

  // Apply a preview_status frame (Req 4.1–4.6). Task 4 mirrored the frame so a
  // reconnect replay shows the current preview state; Task 5 makes the reducer
  // honor the full lifecycle semantics (ready-empty-url retain, loading
  // suppression, failure cause, restart offer).
  PREVIEW_STATUS_SET: 'preview/statusSet',

  // Set the mobile connection URL for the Preview_Pane (Req 4.10). Carried by a
  // preview_mobile frame or the liveness poll's served.mobile detail.
  PREVIEW_MOBILE_SET: 'preview/mobileSet',

  // Work_Mode / Session_Header frame application (Req 10.1, 10.2).
  WORK_MODE_SET: 'workMode/set',

  // Workspace_Experience frame application — LAYOUT ONLY (Req 8.3, 8.4).
  WORKSPACE_EXPERIENCE_SET: 'workspace/experienceSet',

  // Pending confirm add / clear, keyed by requestId (Req 5.3, 5.4).
  CONFIRM_ADDED: 'confirm/added',
  CONFIRM_CLEARED: 'confirm/cleared',
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

    // ---- Activity_Stream ordered append (Req 3.3) -----------------------
    case ACTIONS.ACTIVITY_APPENDED: {
      const item = action.item;
      // Defensive: an item without a usable normalized shape is ignored. The
      // frame dispatcher (frames.js) is what builds well-formed items; this
      // guard just keeps the reducer total.
      if (!item || typeof item !== 'object') return state;

      const seq = typeof item.seq === 'number' && Number.isFinite(item.seq) ? item.seq : null;

      // De-duplicate by seq (Req 3.7 replay must not double-render): a frame
      // whose seq is already present is a no-op (SAME state ref, no notify).
      if (seq !== null && state.session.activity.some((a) => a.seq === seq)) {
        return state;
      }

      // Insert so the activity array stays sorted strictly ascending by seq
      // (Req 3.3), regardless of arrival order. Items without a seq (defensive)
      // are appended at the end in arrival order. A stable insertion (find the
      // first strictly-greater seq) keeps equal-less items ahead.
      const next = state.session.activity.slice();
      if (seq === null) {
        next.push(item);
      } else {
        let idx = next.length;
        for (let i = 0; i < next.length; i += 1) {
          const s = typeof next[i].seq === 'number' ? next[i].seq : Infinity;
          if (s > seq) {
            idx = i;
            break;
          }
        }
        next.splice(idx, 0, item);
      }

      const highest =
        seq !== null
          ? state.session.lastSeq === null
            ? seq
            : Math.max(state.session.lastSeq, seq)
          : state.session.lastSeq;

      return {
        ...state,
        session: { ...state.session, activity: next, lastSeq: highest },
      };
    }

    case ACTIONS.ACTIVITY_CLEARED:
      return {
        ...state,
        session: { ...state.session, activity: [], lastSeq: null },
      };

    // ---- preview_status frame (Req 4.1–4.6) -----------------------------
    // The single reducer that applies a preview_status frame — from an SSE
    // frame (frames.js) OR the 5s liveness poll (preview-poll.js), which tags
    // itself source:'poll'. The lifecycle semantics the requirements demand
    // are honored HERE so they are pure and property-testable:
    //
    //   - ready + non-empty url  -> becomes { status:'ready', url }, replacing
    //     any prior loading indicator / content, urlUnavailable cleared (4.1).
    //   - ready + missing/empty url -> RETAIN the prior preview state entirely
    //     (status, url, snapshotId, showingPrior) and raise urlUnavailable so
    //     the view shows a "ready URL unavailable" error (4.2). This is the one
    //     status that does NOT overwrite the shown state.
    //   - loading -> status:'loading'; the view suppresses previously rendered
    //     content while loading (4.3). url is cleared to null so nothing stale
    //     is shown behind the loading indicator.
    //   - showing_prior / error / persistent_failure -> set the status +
    //     showingPrior + a SAFE cause summary iff the frame carried a non-empty
    //     one (4.4, 4.5); url is retained for showing_prior (a prior state IS
    //     shown) and cleared for error/persistent_failure.
    //   - restartOffered rides through verbatim so the view offers the restart
    //     control exactly when the frame reports it (4.6).
    case ACTIONS.PREVIEW_STATUS_SET: {
      const p = action.preview ?? {};
      const prev = state.preview;
      const status = typeof p.status === 'string' ? p.status : prev.status;
      const frameUrl = typeof p.url === 'string' ? p.url : '';
      const hasUsableUrl = frameUrl !== '';
      const source = p.source === 'poll' ? 'poll' : 'sse';
      // Only a SAFE single-line cause summary is ever stored (Req 3.8/4.4/4.5).
      // A whitespace-only cause counts as ABSENT so the view shows no summary.
      const cause = typeof p.cause === 'string' && p.cause.trim() !== '' ? p.cause : null;
      const restartOffered = p.restartOffered === true;

      // Req 4.2: a ready frame WITHOUT a usable url retains the prior state and
      // only raises the url-unavailable error indication. Nothing else changes,
      // except restartOffered (a frame may still offer a restart) and source.
      if (status === 'ready' && !hasUsableUrl) {
        return {
          ...state,
          preview: {
            ...prev,
            urlUnavailable: true,
            restartOffered,
            source,
          },
        };
      }

      const next = {
        ...prev,
        status,
        showingPrior: p.showingPrior === true,
        cause,
        restartOffered,
        source,
        urlUnavailable: false,
      };

      if (status === 'ready') {
        // Req 4.1: replace any prior loading indicator/content with the ready url.
        next.url = frameUrl;
        if ('snapshotId' in p) {
          next.snapshotId = typeof p.snapshotId === 'string' ? p.snapshotId : null;
        }
      } else if (status === 'loading') {
        // Req 4.3: loading suppresses previously rendered content — drop the url
        // so nothing stale shows behind the loading indicator.
        next.url = null;
      } else if (status === 'showing_prior') {
        // A prior project state IS being shown, so retain the last url unless
        // the frame supplies one; showingPrior is asserted for the indicator.
        next.url = 'url' in p ? (hasUsableUrl ? frameUrl : null) : prev.url;
        next.showingPrior = true;
        if ('snapshotId' in p) {
          next.snapshotId = typeof p.snapshotId === 'string' ? p.snapshotId : null;
        }
      } else {
        // error | persistent_failure | any other terminal status: no live
        // preview is shown, so clear the url. snapshotId follows the frame.
        next.url = 'url' in p ? (hasUsableUrl ? frameUrl : null) : null;
        if ('snapshotId' in p) {
          next.snapshotId = typeof p.snapshotId === 'string' ? p.snapshotId : null;
        }
      }

      return { ...state, preview: next };
    }

    // ---- mobile connection details (Req 4.10) ---------------------------
    // A preview_mobile frame (or the poll surfacing served.mobile) carries the
    // mobile connection URL. We store ONLY a non-empty url under preview.mobile
    // so the view renders it as selectable text + a scannable QR; an absent or
    // empty url clears it.
    case ACTIONS.PREVIEW_MOBILE_SET: {
      const url = typeof action.url === 'string' ? action.url.trim() : '';
      return {
        ...state,
        preview: {
          ...state.preview,
          mobile: url !== '' ? { url } : null,
        },
      };
    }

    // ---- work_mode / session_header frame (Req 10.1, 10.2) --------------
    case ACTIONS.WORK_MODE_SET:
      return {
        ...state,
        workMode: {
          active: typeof action.active === 'string' ? action.active : state.workMode.active,
          choices: Array.isArray(action.choices)
            ? [...action.choices]
            : state.workMode.choices,
        },
      };

    // ---- workspace_experience frame — LAYOUT ONLY (Req 8.3, 8.4) --------
    case ACTIONS.WORKSPACE_EXPERIENCE_SET:
      // INVARIANT (Req 8.3): applying a workspace_experience frame changes the
      // layout slice ONLY. It MUST NOT touch theme, workMode, session, preview,
      // or auth — even if the action carelessly carried such fields, only the
      // three layout fields below are read.
      return {
        ...state,
        workspace: {
          experience:
            typeof action.experience === 'string'
              ? action.experience
              : state.workspace.experience,
          layout: action.layout ?? state.workspace.layout,
          attribution:
            typeof action.attribution === 'string' && action.attribution !== ''
              ? action.attribution
              : null,
        },
      };

    // ---- pending confirm add / clear (Req 5.3, 5.4) ---------------------
    case ACTIONS.CONFIRM_ADDED: {
      const requestId = action.requestId;
      if (typeof requestId !== 'string' || requestId === '') return state;
      // Idempotent re-display on replay (Req 5.4): re-adding the SAME requestId
      // with an equal payload is a no-op so a reconnect does not churn state.
      const existing = state.session.pendingConfirms[requestId];
      const payload = action.payload ?? null;
      if (existing !== undefined && shallowEqualConfirm(existing, payload)) {
        return state;
      }
      return {
        ...state,
        session: {
          ...state.session,
          pendingConfirms: { ...state.session.pendingConfirms, [requestId]: payload },
        },
      };
    }

    case ACTIONS.CONFIRM_CLEARED: {
      const requestId = action.requestId;
      if (
        typeof requestId !== 'string' ||
        state.session.pendingConfirms[requestId] === undefined
      ) {
        return state;
      }
      const nextConfirms = { ...state.session.pendingConfirms };
      delete nextConfirms[requestId];
      return {
        ...state,
        session: { ...state.session, pendingConfirms: nextConfirms },
      };
    }

    default:
      return state;
  }
}

// ------------------------------------------------------------------ Helpers

/**
 * Shallow-equal two confirm payloads on the SAFE display fields only. Used so a
 * reconnect replay that re-delivers an identical pending confirm is an
 * idempotent no-op (Req 5.4) rather than a state churn.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function shallowEqualConfirm(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return (
    a.requestId === b.requestId &&
    a.command === b.command &&
    a.category === b.category &&
    a.reason === b.reason
  );
}

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

/** The ordered Activity_Stream items (ascending by seq) (Req 3.3). */
export function selectActivity(state) {
  return state.session.activity;
}

/** The current SSE connection status of the open session (Req 3.2, 3.6). */
export function selectConnection(state) {
  return state.session.connection;
}

/** The full preview slice (Req 4.1–4.10). */
export function selectPreview(state) {
  return state.preview;
}

/** The mobile connection details `{ url } | null` for the Preview_Pane (Req 4.10). */
export function selectPreviewMobile(state) {
  return state.preview.mobile;
}
