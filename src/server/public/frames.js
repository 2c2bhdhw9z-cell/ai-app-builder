/*
 * frames.js — the recognized-frame registry + frame-dispatch reducer
 * (spec Task 4.2; design §"SSE frame handling (recognized frame-type
 *  registry)", Req 3.3, 3.4, 3.7, 3.8, 3.9, 16.2).
 *
 * This module is the SINGLE place that maps a raw SSE frame (already parsed
 * from a `data:` line by sse.js) onto store actions. It owns three concerns:
 *
 *   1. A CLOSED set of recognized frame `type`s (RECOGNIZED_TYPES). Anything
 *      outside the set — or over the 1 MiB size cap — is dropped without
 *      rendering and WITHOUT closing the connection (Req 3.9). sse.js enforces
 *      the size cap on the wire; `isRecognizedType`/`dispatchFrame` enforce the
 *      type gate so a frame that slips through is still inert.
 *
 *   2. Normalization of Activity_Stream frames (reasoning / assistant text /
 *      tool activity) into an ordered `ActivityItem { seq, kind, ... }` and,
 *      for a file diff carried on a tool_call frame, into `hunks` where each
 *      line carries `{ marker:'+'|'-'|' ', text }` so the +/- prefix is DATA,
 *      not merely a CSS color (Req 3.4). The Activity_Stream is ordered by a
 *      monotonic `seq`; because the backend Activity frames from plumby's
 *      `toViewEvent` carry NO seq of their own, `createFrameDispatcher` assigns
 *      a client-side monotonic seq derived from arrival order — UNLESS the
 *      frame already carries a numeric `seq` (which a test or a future backend
 *      may supply), in which case that seq is honored so ordering is by the
 *      frame's own identifier (Req 3.3).
 *
 *   3. The non-disclosing `error` frame projection: an `error` frame is read
 *      for ONLY `message` + `correlationId` — never any raw `cause`, `stack`,
 *      `detail`, secret, or id smuggled alongside (Req 3.8, 16.2).
 *
 * It is DOM-free and dependency-free vanilla ES module code so it imports and
 * runs verbatim under `node --test`, adds no runtime dependency, and touches
 * `plumby` not at all (it consumes the already-projected SAFE frames the server
 * broadcasts). The pure helpers (`normalizeActivityItem`, `diffToHunks`,
 * `safeErrorFrame`, `classifyFrame`) are exported so property tests drive the
 * REAL projection rather than a stand-in.
 */

import { ACTIONS } from './store.js';

/** The hard per-frame size cap; a frame at or over this is dropped (Req 3.9). */
export const MAX_FRAME_BYTES = 1_048_576;

/**
 * The three diff-line kinds plumby's diff model emits, mapped to the persistent
 * NON-COLOR textual marker the Activity_Stream renders (Req 3.4). This is the
 * single source of truth for the marker so the view and the tests agree.
 * @type {Readonly<Record<string,'+'|'-'|' '>>}
 */
export const DIFF_MARKERS = Object.freeze({
  added: '+',
  removed: '-',
  unchanged: ' ',
});

/**
 * The Activity_Stream frame `type`s (plumby `toViewEvent` projections) that
 * become ordered ActivityItems. These are the reasoning/text/tool-activity
 * frames the Activity_Stream view renders in seq order.
 * @type {ReadonlySet<string>}
 */
export const ACTIVITY_TYPES = new Set([
  'reasoning_start',
  'reasoning_delta',
  'reasoning_end',
  'assistant_text_start',
  'text_delta',
  'assistant_text',
  'tool_call',
  'tool_result',
  'model_request',
  'model_response',
  'context_status',
  'iteration_cap',
  'provider_error',
  'provider_retry',
  'aborted',
  'compaction_start',
  'compaction_done',
  'compaction_error',
  'compaction_skipped',
  'subagent_event',
]);

/**
 * The CLOSED set of recognized frame types (Req 3.9). It is the union of the
 * Activity_Stream types above and the typed control/state frames the server
 * broadcasts (see design's registry table). A frame whose `type` is NOT in this
 * set is discarded without rendering and without mutating state.
 * @type {ReadonlySet<string>}
 */
export const RECOGNIZED_TYPES = new Set([
  ...ACTIVITY_TYPES,
  'preview_status',
  'preview_mobile',
  'confirm_request',
  'confirm_timeout',
  'error',
  'work_mode',
  'session_header',
  'workspace_experience',
  'theme',
  'turn_state',
  'turn_start',
  'turn_done',
]);

/**
 * Whether a value is a plain, non-null object (not an array).
 * @param {unknown} v
 */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Whether a frame is recognized: a plain object with a string `type` in the
 * closed set. A frame with no/other `type` is unrecognized (Req 3.9).
 * @param {unknown} frame
 * @returns {boolean}
 */
export function isRecognizedType(frame) {
  return isObject(frame) && typeof frame.type === 'string' && RECOGNIZED_TYPES.has(frame.type);
}

/**
 * The coarse classification a frame maps to, for the dispatcher and tests:
 *   'activity' | 'control' | 'unrecognized'.
 * An oversized frame is 'unrecognized' regardless of type (Req 3.9); the caller
 * (sse.js) normally drops oversized frames before they reach here, but this is
 * belt-and-suspenders so `classifyFrame` alone is a total, safe predicate.
 *
 * @param {unknown} frame
 * @param {number} [byteLength]  optional serialized size, if already known
 * @returns {'activity'|'control'|'unrecognized'}
 */
export function classifyFrame(frame, byteLength) {
  if (typeof byteLength === 'number' && byteLength >= MAX_FRAME_BYTES) return 'unrecognized';
  if (!isRecognizedType(frame)) return 'unrecognized';
  return ACTIVITY_TYPES.has(frame.type) ? 'activity' : 'control';
}

/**
 * Convert a tool_call frame's `.diff` line model into hunks whose EACH line
 * carries a persistent textual marker (Req 3.4). plumby's diff lines are
 * `{ type:'unchanged'|'added'|'removed', text, oldLine, newLine }`; we project
 * each to `{ marker, text }` with the marker taken from DIFF_MARKERS. An
 * unknown line type defaults to the neutral space marker so the projection is
 * total and never throws.
 *
 * @param {object|null|undefined} diff  the tool_call frame's `.diff`
 * @returns {{ path: string, newFile: boolean, binary: boolean, hunks: Array<{ marker:'+'|'-'|' ', text: string }>, truncated: boolean, truncationNotice: (string|null), tooLarge: boolean, tooLargeNotice: (string|null), notice: (string|null) }|null}
 */
export function diffToHunks(diff) {
  if (!isObject(diff)) return null;

  // A degraded BINARY write_file (from activity-stream.js) carries no line
  // model — surface it as a binary change with no hunks so the view shows the
  // notice rather than an empty diff.
  if (diff.binary === true) {
    return {
      path: typeof diff.path === 'string' ? diff.path : '',
      newFile: false,
      binary: true,
      hunks: [],
      truncated: false,
      truncationNotice: null,
      tooLarge: false,
      tooLargeNotice: null,
      notice: typeof diff.notice === 'string' ? diff.notice : null,
    };
  }

  const lines = Array.isArray(diff.lines) ? diff.lines : [];
  const hunks = lines.map((line) => {
    const marker = DIFF_MARKERS[line?.type] ?? DIFF_MARKERS.unchanged;
    return { marker, text: typeof line?.text === 'string' ? line.text : '' };
  });

  return {
    path: typeof diff.path === 'string' ? diff.path : '',
    newFile: diff.newFile === true,
    binary: false,
    hunks,
    truncated: diff.truncated === true,
    truncationNotice: typeof diff.truncationNotice === 'string' ? diff.truncationNotice : null,
    tooLarge: diff.tooLarge === true,
    tooLargeNotice: typeof diff.tooLargeNotice === 'string' ? diff.tooLargeNotice : null,
    notice: null,
  };
}

/**
 * Normalize one Activity_Stream frame into an ordered ActivityItem. The `seq`
 * is supplied by the caller (the dispatcher assigns a monotonic client-side seq
 * unless the frame carries its own numeric seq — see createFrameDispatcher).
 *
 * The item carries a small, view-oriented shape:
 *   { seq, type, kind:'reasoning'|'text'|'tool'|'diff'|'status', text?, name?,
 *     summary?, diff?, notice?, ... }
 * A tool_call frame that carries a `.diff` is normalized to kind 'diff' with the
 * marker-bearing `hunks` (Req 3.4); a tool_call without a diff stays kind
 * 'tool'. Reasoning/text deltas keep their `text`.
 *
 * Only SAFE, already-projected fields are copied — this consumes the SAFE
 * frames the server broadcast; it never reads a raw cause/stack.
 *
 * @param {object} frame     a recognized Activity_Stream frame
 * @param {number} seq       the monotonic sequence id to stamp
 * @returns {{ seq: number, type: string, kind: string, [k: string]: any }}
 */
export function normalizeActivityItem(frame, seq) {
  const type = frame.type;
  const base = { seq, type };

  switch (type) {
    case 'reasoning_delta':
      return { ...base, kind: 'reasoning', text: typeof frame.text === 'string' ? frame.text : '' };
    case 'reasoning_start':
    case 'reasoning_end':
      return { ...base, kind: 'reasoning', text: '' };

    case 'text_delta':
    case 'assistant_text':
      return { ...base, kind: 'text', text: typeof frame.text === 'string' ? frame.text : '' };
    case 'assistant_text_start':
      return { ...base, kind: 'text', text: '' };

    case 'tool_call': {
      const hunks = diffToHunks(frame.diff);
      if (hunks) {
        return {
          ...base,
          kind: 'diff',
          name: typeof frame.name === 'string' ? frame.name : '',
          summary: typeof frame.summary === 'string' ? frame.summary : '',
          diff: hunks,
        };
      }
      return {
        ...base,
        kind: 'tool',
        name: typeof frame.name === 'string' ? frame.name : '',
        summary: typeof frame.summary === 'string' ? frame.summary : '',
      };
    }

    case 'tool_result':
      return {
        ...base,
        kind: 'tool',
        content: typeof frame.content === 'string' ? frame.content : '',
        truncated: frame.truncated === true,
        notice: typeof frame.notice === 'string' ? frame.notice : null,
      };

    default:
      // A recognized-but-generic activity frame (model_request, context_status,
      // provider_retry, …). Surface it as a neutral status line carrying only a
      // safe one-line summary if the frame provides one.
      return {
        ...base,
        kind: 'status',
        text:
          typeof frame.message === 'string'
            ? frame.message
            : typeof frame.reason === 'string'
              ? frame.reason
              : '',
      };
  }
}

/**
 * Project an `error` frame onto the ONLY two fields the UI may show: a generic
 * `message` and a `correlationId` (Req 3.8, 16.2). ANY other field on the frame
 * — cause, stack, detail, secret, projectId, path, existence hints — is
 * deliberately NOT read, so there is structurally no path by which it reaches
 * the store or the DOM. Missing fields become safe empty strings.
 *
 * @param {object} frame  an `error` frame (possibly carrying adversarial extras)
 * @returns {{ message: string, correlationId: string }}
 */
export function safeErrorFrame(frame) {
  const src = isObject(frame) ? frame : {};
  return {
    message: typeof src.message === 'string' ? src.message : '',
    correlationId: typeof src.correlationId === 'string' ? src.correlationId : '',
  };
}

/**
 * Create the frame dispatcher. It maps each recognized frame onto store
 * dispatches and returns a small result describing what it did — so sse.js and
 * the tests can observe the dispatch decision without inspecting the store.
 *
 * Monotonic seq: Activity_Stream frames the backend sends carry no seq, so the
 * dispatcher assigns a client-side monotonic seq (a counter that only ever
 * increases). When a frame DOES carry a finite numeric `seq`, that value is
 * honored (and the counter advances past it) so ordering follows the frame's
 * own identifier — this is what lets Property 5 shuffle/duplicate seqs and still
 * assert ascending render order (Req 3.3). Duplicate seqs are de-duplicated by
 * the store's ACTIVITY_APPENDED reducer.
 *
 * @param {object} deps
 * @param {{ dispatch: Function, getState?: Function }} deps.store  the REAL store
 * @param {{ onFrame?: (frame: object) => void }} [deps.hooks]  optional side-hooks
 * @returns {{ dispatch: (frame: unknown, meta?: { byteLength?: number }) => { kind: 'activity'|'control'|'unrecognized', seq?: number } }}
 */
export function createFrameDispatcher({ store, hooks = {} } = {}) {
  if (!store || typeof store.dispatch !== 'function') {
    throw new TypeError('createFrameDispatcher requires a store with dispatch');
  }

  // The client-side monotonic sequence counter. Starts below zero so the first
  // assigned seq is 0.
  let seqCounter = -1;

  /** Next monotonic seq, honoring a frame's own numeric seq when present. */
  function nextSeq(frame) {
    const own = isObject(frame) && typeof frame.seq === 'number' && Number.isFinite(frame.seq)
      ? frame.seq
      : null;
    if (own !== null) {
      if (own > seqCounter) seqCounter = own;
      return own;
    }
    seqCounter += 1;
    return seqCounter;
  }

  function dispatch(frame, meta = {}) {
    const cls = classifyFrame(frame, meta.byteLength);
    if (cls === 'unrecognized') {
      // Dropped: render nothing, mutate no state (Req 3.9). The connection stays
      // open — that is sse.js's concern; this function simply does nothing.
      return { kind: 'unrecognized' };
    }

    if (cls === 'activity') {
      const seq = nextSeq(frame);
      const item = normalizeActivityItem(frame, seq);
      store.dispatch({ type: ACTIONS.ACTIVITY_APPENDED, item });
      if (typeof hooks.onFrame === 'function') hooks.onFrame(frame);
      return { kind: 'activity', seq };
    }

    // ---- control / state frames ----
    switch (frame.type) {
      case 'preview_status':
        store.dispatch({
          type: ACTIONS.PREVIEW_STATUS_SET,
          preview: {
            status: frame.status,
            // Preserve the url key semantics: present-but-empty vs absent matter
            // to the Task-5 reducers; forward what the frame carried.
            ...(('url' in frame) ? { url: frame.url } : {}),
            ...(('snapshotId' in frame) ? { snapshotId: frame.snapshotId } : {}),
            showingPrior: frame.showingPrior === true,
            cause: typeof frame.cause === 'string' ? frame.cause : null,
            restartOffered: frame.restartOffered === true,
            source: 'sse',
          },
        });
        break;

      case 'work_mode':
        store.dispatch({
          type: ACTIONS.WORK_MODE_SET,
          active: frame.mode,
          choices: Array.isArray(frame.choices) ? frame.choices : undefined,
        });
        break;

      case 'session_header':
        // The header frame names the same active mode + choices under the
        // workMode/workModeChoices keys (Req 10.1, 10.2).
        store.dispatch({
          type: ACTIONS.WORK_MODE_SET,
          active: frame.workMode,
          choices: Array.isArray(frame.workModeChoices) ? frame.workModeChoices : undefined,
        });
        break;

      case 'workspace_experience':
        // LAYOUT ONLY (Req 8.3): forward only experience/layout/attribution.
        store.dispatch({
          type: ACTIONS.WORKSPACE_EXPERIENCE_SET,
          experience: frame.experience,
          layout: frame.layout,
          attribution: typeof frame.attribution === 'string' ? frame.attribution : null,
        });
        break;

      case 'theme':
        // A previewed:true frame writes previewedTheme/Palette ONLY; a committed
        // frame overwrites committed (the store enforces both invariants). Task
        // 4 wires the frame → store mapping; the theme controller (Task 11) owns
        // the catalog/preview/commit user flow.
        if (frame.previewed === true) {
          store.dispatch({
            type: ACTIONS.THEME_PREVIEWED,
            themeId: frame.theme,
            palette: frame.palette,
          });
        } else {
          store.dispatch({
            type: ACTIONS.THEME_COMMITTED,
            themeId: frame.theme,
            palette: frame.palette,
          });
        }
        break;

      case 'confirm_request':
        store.dispatch({
          type: ACTIONS.CONFIRM_ADDED,
          requestId: frame.requestId,
          payload: {
            requestId: typeof frame.requestId === 'string' ? frame.requestId : '',
            command: typeof frame.command === 'string' ? frame.command : '',
            category: typeof frame.category === 'string' ? frame.category : '',
            reason: typeof frame.reason === 'string' ? frame.reason : '',
          },
        });
        break;

      case 'confirm_timeout':
        store.dispatch({ type: ACTIONS.CONFIRM_CLEARED, requestId: frame.requestId });
        break;

      case 'error': {
        // NON-DISCLOSING (Req 3.8, 16.2): read ONLY message + correlationId. The
        // safe projection is surfaced as a session notice; no raw field escapes.
        const safe = safeErrorFrame(frame);
        store.dispatch({
          type: ACTIONS.NOTICE_SET,
          kind: 'error',
          message: safe.message,
          correlationId: safe.correlationId,
        });
        break;
      }

      case 'turn_state':
        // The running-turn indicator (Req 2.5, 3.7). A running turn keeps the
        // in-flight gate; a not-running turn ends it (retaining any pending
        // prompt text so a reconnect mid-idle does not wipe the input).
        if (frame.running === true) {
          store.dispatch({ type: ACTIONS.SUBMIT_STARTED });
        } else {
          store.dispatch({ type: ACTIONS.SUBMIT_ENDED, retainText: true });
        }
        break;

      case 'turn_start':
        store.dispatch({ type: ACTIONS.SUBMIT_STARTED });
        break;

      case 'turn_done':
        store.dispatch({ type: ACTIONS.SUBMIT_ENDED, retainText: false });
        break;

      default:
        // Unreachable: classifyFrame already vetted the type. Keep total.
        return { kind: 'unrecognized' };
    }

    if (typeof hooks.onFrame === 'function') hooks.onFrame(frame);
    return { kind: 'control' };
  }

  return { dispatch };
}
