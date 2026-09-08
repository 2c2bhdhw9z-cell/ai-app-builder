/*
 * sse.js — the Activity_Stream SSE client (spec Task 4.1; design §"Transport
 *  layer — sse.js", Req 3.1, 3.2, 3.5, 3.6, 3.7, 3.9, 6.4).
 *
 * This is one of only three modules that touch the network (api / sse /
 * preview-poll). It owns the `/events` connection: opening it, parsing the
 * Server-Sent-Events wire, reconnecting within bounds, and surfacing status and
 * parsed frames to the caller.
 *
 * WHY A fetch()-BASED READER, NOT `EventSource`. A native `EventSource` CANNOT
 * set an `Authorization` header, but `/events` is a gated route that requires
 * `Authorization: Bearer <token>` (Req 3.1, 6.4). So we open the stream with
 * `fetch(..., { headers: { authorization: 'Bearer …', accept:
 * 'text/event-stream' }, signal })` and read `response.body` as a streaming
 * `ReadableStream`, parsing the `data:` / `retry:` lines ourselves. The Bearer
 * is read through the SAME injected token seam api.js uses (`getToken`), never
 * imported — so the real Token_Store (Task 8) wires in without touching this
 * file.
 *
 * BOUNDED RECONNECT (Req 3.5, 3.6). On a drop we retry with a delay CAPPED at
 * ≤5,000 ms, for at most 10 CONSECUTIVE automatic attempts. After the 10th
 * failed attempt we stop and emit `status:'lost'`, and the view shows a manual
 * reconnect control. `reconnectNow()` resets the attempt counter and reconnects
 * immediately (the manual path). A successful open resets the counter so a
 * later drop gets a fresh budget of 10.
 *
 * AUTH FAILURE ON OPEN (Req 3.2). A `401` opening the stream emits
 * `status:'unauthorized'` and does NOT flow into the connected/frame path, so
 * the Activity_Stream view is not opened; the view shows a re-auth message.
 *
 * REPLAY (Req 3.7). On every (re)connect the server replays current-state
 * frames (turn_state, preview_status, workspace_experience, theme, work_mode,
 * session_header, pending confirm_request) as ordinary `data:` frames on the
 * same stream. They therefore flow through the SAME `onFrame` path as live
 * frames — replay and live handling share one code path with no special-casing.
 *
 * FRAME HYGIENE (Req 3.9). A single `data:` payload whose serialized size is
 * ≥ 1,048,576 bytes, or whose parsed `type` is not recognized, is DROPPED — not
 * delivered to `onFrame`, no state mutated — while the connection stays OPEN.
 * The size check is on the raw bytes BEFORE JSON.parse so a giant frame is
 * cheap to reject; the type check delegates to frames.js's recognized set.
 *
 * TESTABILITY. `fetch`, the timer functions, and `AbortController` are all
 * INJECTED (defaulting to the browser globals), so the whole reconnect
 * scheduler, the SSE parser, and the hygiene gate run deterministically under
 * `node --test` with a fake clock and a scripted fetch — no real network, no
 * real timers, no browser.
 */

import { MAX_FRAME_BYTES, isRecognizedType } from './frames.js';

/** Reconnect bounds (Req 3.5, 3.6). */
export const MAX_RECONNECT_DELAY_MS = 5_000;
export const MAX_RECONNECT_ATTEMPTS = 10;

/** The status vocabulary emitted via onStatus. */
export const SSE_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  LOST: 'lost',
  UNAUTHORIZED: 'unauthorized',
  CLOSED: 'closed',
});

/**
 * Compute the reconnect delay for a given (1-based) attempt number. A capped
 * exponential-ish backoff: attempt 1 → 500ms, doubling, but NEVER exceeding
 * MAX_RECONNECT_DELAY_MS (Req 3.5). Exported and pure so the property test can
 * assert the ≤5s bound directly across all attempt numbers.
 *
 * @param {number} attempt  1-based consecutive attempt number
 * @returns {number} delay in ms, in [0, MAX_RECONNECT_DELAY_MS]
 */
export function reconnectDelay(attempt) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const base = 500 * 2 ** (n - 1);
  return Math.min(base, MAX_RECONNECT_DELAY_MS);
}

/**
 * A minimal SSE line parser. Server-Sent-Events frames are separated by a blank
 * line; within a frame, `data:` lines accumulate (joined by '\n') and a
 * `retry:` line updates the reconnection hint. Comment lines (starting ':') are
 * ignored. This class is fed raw decoded chunks via `push(chunk)` and calls the
 * provided callbacks per completed frame; exported for direct unit testing.
 */
export class SseParser {
  /**
   * @param {object} handlers
   * @param {(data: string) => void} handlers.onData   called with the joined data payload of a completed frame
   * @param {(ms: number) => void} [handlers.onRetry]  called when a `retry:` hint is parsed
   */
  constructor({ onData, onRetry } = {}) {
    this._onData = typeof onData === 'function' ? onData : () => {};
    this._onRetry = typeof onRetry === 'function' ? onRetry : () => {};
    this._buffer = '';
    this._dataLines = [];
  }

  /** Feed a decoded string chunk; emits completed frames as they close. */
  push(chunk) {
    this._buffer += chunk;
    // Normalize CRLF to LF so line splitting is uniform.
    let idx;
    // Process complete lines; a line ends at '\n'. The trailing partial line
    // stays in the buffer for the next chunk.
    // eslint-disable-next-line no-cond-assign
    while ((idx = this._buffer.indexOf('\n')) !== -1) {
      let line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._handleLine(line);
    }
  }

  _handleLine(line) {
    if (line === '') {
      // Blank line: dispatch the accumulated frame (if any data was gathered).
      if (this._dataLines.length > 0) {
        const data = this._dataLines.join('\n');
        this._dataLines = [];
        this._onData(data);
      }
      return;
    }
    if (line.startsWith(':')) return; // comment (e.g. ": connected")
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // strip one leading space
    if (field === 'data') {
      this._dataLines.push(value);
    } else if (field === 'retry') {
      const ms = Number.parseInt(value, 10);
      if (Number.isFinite(ms) && ms >= 0) this._onRetry(ms);
    }
    // Other fields (event, id) are not used by this client.
  }
}

/**
 * Create the SSE client.
 *
 * @param {object} [deps]
 * @param {() => (string|null|undefined)} [deps.getToken]  Bearer seam (as in api.js)
 * @param {typeof fetch} [deps.fetchImpl]                  defaults to globalThis.fetch
 * @param {typeof AbortController} [deps.AbortControllerImpl]  defaults to globalThis.AbortController
 * @param {(cb: Function, ms: number) => any} [deps.setTimeoutImpl]   injectable timer
 * @param {(id: any) => void} [deps.clearTimeoutImpl]      injectable timer clear
 * @param {string} [deps.baseUrl]                          origin prefix (default same-origin)
 * @returns {{
 *   connect: (projectId: string) => void,
 *   disconnect: () => void,
 *   reconnectNow: () => void,
 *   onFrame: (handler: (frame: object) => void) => (() => void),
 *   onStatus: (handler: (status: string) => void) => (() => void),
 *   getStatus: () => string,
 *   getAttempts: () => number,
 * }}
 */
export function createSseClient(deps = {}) {
  const getToken = typeof deps.getToken === 'function' ? deps.getToken : () => null;
  const fetchImpl =
    deps.fetchImpl ?? (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  const AbortControllerImpl =
    deps.AbortControllerImpl ??
    (typeof globalThis !== 'undefined' ? globalThis.AbortController : undefined);
  const setTimeoutImpl =
    deps.setTimeoutImpl ?? (typeof globalThis !== 'undefined' ? globalThis.setTimeout : undefined);
  const clearTimeoutImpl =
    deps.clearTimeoutImpl ??
    (typeof globalThis !== 'undefined' ? globalThis.clearTimeout : undefined);
  const baseUrl = deps.baseUrl ?? '';

  /** @type {Set<Function>} */
  const frameListeners = new Set();
  /** @type {Set<Function>} */
  const statusListeners = new Set();

  let projectId = null;
  let status = SSE_STATUS.CLOSED;
  let attempts = 0; // consecutive automatic attempts since the last open
  let controller = null; // AbortController for the in-flight fetch/read
  let reconnectTimer = null;
  let closedByUser = false; // disconnect() sets this so a drop does not reconnect
  let generation = 0; // bumped on each connect/disconnect so a stale read exits

  function onFrame(handler) {
    if (typeof handler === 'function') frameListeners.add(handler);
    return () => frameListeners.delete(handler);
  }
  function onStatus(handler) {
    if (typeof handler === 'function') statusListeners.add(handler);
    return () => statusListeners.delete(handler);
  }

  function setStatus(next) {
    status = next;
    for (const cb of statusListeners) {
      try {
        cb(next);
      } catch {
        /* a listener throwing must not break the transport */
      }
    }
  }

  function emitFrame(frame) {
    for (const cb of frameListeners) {
      try {
        cb(frame);
      } catch {
        /* isolate a bad listener */
      }
    }
  }

  /**
   * Deliver one raw SSE `data:` payload through the hygiene gate then to
   * onFrame. DROP (Req 3.9), keeping the connection open, when the payload is
   * oversized or parses to an unrecognized frame. This is the SINGLE ingress for
   * BOTH live and replayed frames (Req 3.7).
   */
  function ingest(dataPayload) {
    // Size gate BEFORE parse: reject a giant frame cheaply (Req 3.9). Byte
    // length via a Blob-free measurement — count UTF-8 bytes.
    const byteLength = utf8ByteLength(dataPayload);
    if (byteLength >= MAX_FRAME_BYTES) return; // dropped, connection stays open

    let frame;
    try {
      frame = JSON.parse(dataPayload);
    } catch {
      return; // unparseable → dropped, connection stays open
    }
    if (!isRecognizedType(frame)) return; // unrecognized type → dropped

    emitFrame(frame);
  }

  /**
   * Open the stream once. Resolves (via the reconnect scheduler) — it does not
   * throw. A 401 → unauthorized (no reconnect, no frame path). A non-OK/network
   * error or a normal end-of-stream → schedule a bounded reconnect.
   */
  async function openOnce(myGeneration) {
    const token = getToken();
    if (!token) {
      // No token to attach: treat exactly like an auth failure on open (Req 3.2,
      // 6.4) — do not open the Activity_Stream view.
      setStatus(SSE_STATUS.UNAUTHORIZED);
      return;
    }

    controller = AbortControllerImpl ? new AbortControllerImpl() : null;
    const path = `${baseUrl}/events?projectId=${encodeURIComponent(projectId ?? '')}`;

    let res;
    try {
      res = await fetchImpl(path, {
        method: 'GET',
        headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
        signal: controller ? controller.signal : undefined,
      });
    } catch {
      // Network error opening the stream → a drop; schedule a bounded retry.
      if (myGeneration !== generation) return;
      scheduleReconnect();
      return;
    }

    if (myGeneration !== generation) return; // superseded by a newer connect/disconnect

    if (res.status === 401) {
      // Auth failure on open (Req 3.2): do NOT open the view; no reconnect.
      setStatus(SSE_STATUS.UNAUTHORIZED);
      return;
    }
    if (res.status < 200 || res.status >= 300 || !res.body) {
      // Any other non-2xx (or a bodyless response) is a failed open → retry.
      scheduleReconnect();
      return;
    }

    // Connected. Reset the consecutive-attempt budget (Req 3.5/3.6) and mark
    // the stream open so the view renders.
    attempts = 0;
    setStatus(SSE_STATUS.OPEN);

    const parser = new SseParser({ onData: ingest });

    try {
      await readBody(res.body, parser, () => myGeneration === generation);
    } catch {
      // A read error is a drop.
      if (myGeneration !== generation) return;
      scheduleReconnect();
      return;
    }

    // The stream ended (server closed / EOF). If the user did not close it,
    // treat as a drop and reconnect within bounds.
    if (myGeneration !== generation || closedByUser) return;
    scheduleReconnect();
  }

  /**
   * Read a ReadableStream body (or an async-iterable, for a Node/test double),
   * decoding chunks and feeding the parser until EOF or the stream is
   * superseded. Tolerates both a WHATWG ReadableStream (getReader) and an
   * async iterator (for-await), so a test can hand a simple async generator.
   */
  async function readBody(body, parser, stillCurrent) {
    const decoder = new TextDecoder();
    if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!stillCurrent()) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
        parser.push(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
      }
      return;
    }
    if (body[Symbol.asyncIterator]) {
      for await (const chunk of body) {
        if (!stillCurrent()) break;
        parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
      }
      return;
    }
    // Unknown body shape: nothing to read.
  }

  /** Schedule the next bounded automatic reconnect, or give up → 'lost'. */
  function scheduleReconnect() {
    if (closedByUser) return;
    abortInFlight();

    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      // Exhausted the 10-attempt budget (Req 3.6): stop and report lost.
      setStatus(SSE_STATUS.LOST);
      return;
    }

    attempts += 1;
    setStatus(SSE_STATUS.RECONNECTING);
    const delay = reconnectDelay(attempts);
    const myGeneration = generation;
    if (!setTimeoutImpl) {
      // No timer available (degenerate): attempt immediately.
      if (myGeneration === generation && !closedByUser) void openOnce(myGeneration);
      return;
    }
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      if (myGeneration === generation && !closedByUser) void openOnce(myGeneration);
    }, delay);
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function abortInFlight() {
    if (controller) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      controller = null;
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer != null && clearTimeoutImpl) clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  /** Open the stream for a project session (Req 3.1). */
  function connect(id) {
    projectId = id ?? null;
    closedByUser = false;
    attempts = 0;
    generation += 1;
    const myGeneration = generation;
    clearReconnectTimer();
    abortInFlight();
    setStatus(SSE_STATUS.CONNECTING);
    void openOnce(myGeneration);
  }

  /** Close the stream and stop all reconnection (a user-initiated close). */
  function disconnect() {
    closedByUser = true;
    generation += 1;
    clearReconnectTimer();
    abortInFlight();
    setStatus(SSE_STATUS.CLOSED);
  }

  /**
   * Manual reconnect (Req 3.6): reset the consecutive-attempt budget and open
   * immediately, regardless of a prior 'lost' or 'unauthorized' state.
   */
  function reconnectNow() {
    closedByUser = false;
    attempts = 0;
    generation += 1;
    const myGeneration = generation;
    clearReconnectTimer();
    abortInFlight();
    setStatus(SSE_STATUS.CONNECTING);
    void openOnce(myGeneration);
  }

  return {
    connect,
    disconnect,
    reconnectNow,
    onFrame,
    onStatus,
    getStatus: () => status,
    getAttempts: () => attempts,
  };
}

/**
 * Count the UTF-8 byte length of a string without allocating a Blob (so it runs
 * under `node --test`). Uses TextEncoder when present, else a manual count.
 * @param {string} str
 * @returns {number}
 */
export function utf8ByteLength(str) {
  const s = typeof str === 'string' ? str : String(str ?? '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  // Manual fallback (rarely hit): count code-unit bytes.
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
