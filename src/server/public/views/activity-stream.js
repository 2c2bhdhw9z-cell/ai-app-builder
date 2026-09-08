/*
 * views/activity-stream.js — the live Activity_Stream view + SSE session wiring
 * (spec Task 4.3; design §"Views — views/activity-stream.js", Req 3.1, 3.2,
 *  3.3, 3.4, 3.6).
 *
 * A thin DOM renderer over the store's Activity_Stream slice and the SSE
 * client's connection status. It renders the ordered activity items (the store
 * keeps them ascending by seq, Req 3.3), draws each diff line with its
 * PERSISTENT non-color textual marker (`+` / `-` / ` `) taken from the
 * normalized `hunks` so the marker is DATA in the DOM, not merely a CSS color
 * (Req 3.4), and surfaces the connection state: an `unauthorized` open shows a
 * re-authentication message and does NOT render the stream (Req 3.2); a `lost`
 * connection shows a connection-lost message plus a manual reconnect control
 * that calls `reconnectNow()` (Req 3.6).
 *
 * The SSE→store wiring lives here too: `connectActivityStream` opens the stream
 * for a session (within 2s of the view rendering, Req 3.1 — it connects
 * synchronously on mount, well inside the budget), routes every frame through
 * the frame dispatcher (frames.js), and mirrors the SSE status into the store's
 * connection slice so the view (and any other subscriber) reacts. Live and
 * replayed frames share the one dispatch path (Req 3.7).
 *
 * CSP hygiene (Req 1.4): every node is built with the DOM API — NO innerHTML,
 * NO inline handlers, NO inline <style>. The +/- markers and any color come
 * from the palette-driven stylesheet via classes; the marker glyph itself is
 * real text content. The pure projection (`activityViewModel`, `renderDiffText`)
 * is exported so a `node --test` asserts the view's decisions without a browser.
 */

import { ACTIONS, selectActivity, selectConnection } from '../store.js';
import { SSE_STATUS } from '../sse.js';
import { createFrameDispatcher } from '../frames.js';

/** Stable DOM ids/classes so the view is greppable and styleable. */
export const ACTIVITY_DOM = Object.freeze({
  rootClass: 'activity',
  list: 'activity-list',
  status: 'activity-status',
  reconnect: 'activity-reconnect',
  itemClass: 'activity__item',
  diffLineClass: 'activity__diff-line',
  markerClass: 'activity__diff-marker',
});

/** Client-authored, non-disclosing connection messages (Req 3.2, 3.6). */
export const ACTIVITY_MESSAGES = Object.freeze({
  connecting: 'Connecting to the activity stream\u2026',
  reconnecting: 'Reconnecting\u2026',
  unauthorized: 'Your session expired. Please sign in again to view activity.',
  lost: 'The activity stream is disconnected.',
});

/**
 * Pure view-model over the store slice. Decides whether the stream body renders
 * (it does NOT while unauthorized — Req 3.2), what connection message to show,
 * and whether the manual reconnect control is offered (only when lost or
 * unauthorized — Req 3.6). Exported for DOM-free testing.
 *
 * @param {object} state
 * @returns {{ items: any[], connection: string, showStream: boolean, statusMessage: string, showReconnect: boolean }}
 */
export function activityViewModel(state) {
  const connection = selectConnection(state);
  const items = selectActivity(state);
  const showStream = connection !== SSE_STATUS.UNAUTHORIZED;
  let statusMessage = '';
  if (connection === SSE_STATUS.CONNECTING) statusMessage = ACTIVITY_MESSAGES.connecting;
  else if (connection === SSE_STATUS.RECONNECTING) statusMessage = ACTIVITY_MESSAGES.reconnecting;
  else if (connection === SSE_STATUS.UNAUTHORIZED) statusMessage = ACTIVITY_MESSAGES.unauthorized;
  else if (connection === SSE_STATUS.LOST) statusMessage = ACTIVITY_MESSAGES.lost;
  const showReconnect =
    connection === SSE_STATUS.LOST || connection === SSE_STATUS.UNAUTHORIZED;
  return { items, connection, showStream, statusMessage, showReconnect };
}

/**
 * Render a normalized diff item's hunks to plain text lines, each PREFIXED with
 * its persistent marker (Req 3.4). Pure and exported so a test asserts every
 * added line starts with '+' and every removed line with '-' regardless of any
 * styling. Returns an array of `{ marker, text, line }` where `line` is the
 * marker-prefixed string the DOM shows.
 *
 * @param {{ hunks: Array<{ marker: string, text: string }> }} diff
 * @returns {Array<{ marker: string, text: string, line: string }>}
 */
export function renderDiffText(diff) {
  const hunks = diff && Array.isArray(diff.hunks) ? diff.hunks : [];
  return hunks.map((h) => {
    const marker = typeof h.marker === 'string' ? h.marker : ' ';
    const text = typeof h.text === 'string' ? h.text : '';
    return { marker, text, line: `${marker}${text}` };
  });
}

/**
 * Create and mount the Activity_Stream view.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {{ getState: Function, subscribe: Function }} opts.store
 * @param {{ reconnectNow: Function }} [opts.sse]  the SSE client (for the manual reconnect control)
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void }}
 */
export function createActivityStreamView({ doc, store, sse }) {
  const root = doc.createElement('section');
  root.className = ACTIVITY_DOM.rootClass;
  root.setAttribute('aria-label', 'Activity stream');

  const status = doc.createElement('p');
  status.id = ACTIVITY_DOM.status;
  status.className = 'activity__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const reconnect = doc.createElement('button');
  reconnect.id = ACTIVITY_DOM.reconnect;
  reconnect.className = 'activity__reconnect';
  reconnect.setAttribute('type', 'button');
  reconnect.textContent = 'Reconnect';
  reconnect.hidden = true;

  const list = doc.createElement('ol');
  list.id = ACTIVITY_DOM.list;
  list.className = 'activity__list';

  root.append(status, reconnect, list);

  function onReconnect() {
    if (sse && typeof sse.reconnectNow === 'function') sse.reconnectNow();
  }
  reconnect.addEventListener('click', onReconnect);

  /** Build one activity <li>. Diffs render marker-prefixed lines (Req 3.4). */
  function buildItem(item) {
    const li = doc.createElement('li');
    li.className = ACTIVITY_DOM.itemClass;
    li.dataset.kind = item.kind ?? '';
    li.dataset.seq = String(item.seq ?? '');

    if (item.kind === 'diff' && item.diff) {
      const heading = doc.createElement('p');
      heading.className = 'activity__diff-path';
      heading.textContent = item.diff.path || item.name || 'diff';
      li.append(heading);

      if (item.diff.binary) {
        const note = doc.createElement('p');
        note.className = 'activity__diff-notice';
        note.textContent = item.diff.notice || 'binary file';
        li.append(note);
      } else {
        const pre = doc.createElement('pre');
        pre.className = 'activity__diff';
        for (const { marker, text } of renderDiffText(item.diff)) {
          const lineEl = doc.createElement('span');
          lineEl.className = ACTIVITY_DOM.diffLineClass;
          // Marker class carries the semantic (+/-/space) for styling AND the
          // glyph is real text so the distinction survives with color off.
          lineEl.dataset.marker = marker;
          const markerEl = doc.createElement('span');
          markerEl.className = ACTIVITY_DOM.markerClass;
          markerEl.textContent = marker;
          const textEl = doc.createElement('span');
          textEl.className = 'activity__diff-text';
          textEl.textContent = text;
          lineEl.append(markerEl, textEl);
          pre.append(lineEl, doc.createTextNode('\n'));
        }
        li.append(pre);
        if (item.diff.truncated && item.diff.truncationNotice) {
          const t = doc.createElement('p');
          t.className = 'activity__diff-notice';
          t.textContent = item.diff.truncationNotice;
          li.append(t);
        }
        if (item.diff.tooLarge && item.diff.tooLargeNotice) {
          const t = doc.createElement('p');
          t.className = 'activity__diff-notice';
          t.textContent = item.diff.tooLargeNotice;
          li.append(t);
        }
      }
      return li;
    }

    // Non-diff item: a text/reasoning/tool/status line.
    const p = doc.createElement('p');
    p.className = 'activity__text';
    if (item.kind === 'tool') {
      p.textContent = item.summary || item.content || item.name || '';
    } else {
      p.textContent = item.text || '';
    }
    li.append(p);
    return li;
  }

  /** Apply the pure view-model to the DOM. Idempotent full re-render. */
  function render() {
    const vm = activityViewModel(store.getState());

    if (vm.statusMessage) {
      status.textContent = vm.statusMessage;
      status.hidden = false;
    } else {
      status.textContent = '';
      status.hidden = true;
    }
    reconnect.hidden = !vm.showReconnect;

    // While unauthorized, do NOT render the stream body (Req 3.2).
    list.hidden = !vm.showStream;
    list.replaceChildren();
    if (vm.showStream) {
      for (const item of vm.items) list.append(buildItem(item));
    }
  }

  const unsubActivity = store.subscribe((s) => s.session.activity, render);
  const unsubConn = store.subscribe((s) => s.session.connection, render);
  render();

  function destroy() {
    unsubActivity();
    unsubConn();
    reconnect.removeEventListener('click', onReconnect);
    root.remove();
  }

  return { el: root, render, destroy };
}

/**
 * Wire an SSE client into an open session: route frames through the dispatcher
 * and mirror the SSE status into the store's connection slice, then open the
 * stream for `projectId` (Req 3.1 — connect on session open). Live and replayed
 * frames share the one dispatch path (Req 3.7).
 *
 * Returns a teardown that unsubscribes the hooks and disconnects the stream.
 *
 * @param {object} deps
 * @param {{ dispatch: Function, getState?: Function }} deps.store
 * @param {{ connect: Function, disconnect: Function, onFrame: Function, onStatus: Function }} deps.sse
 * @param {string} deps.projectId
 * @param {object} [deps.dispatcher]  optional injected frame dispatcher (tests)
 * @returns {{ disconnect: () => void }}
 */
export function connectActivityStream({ store, sse, projectId, dispatcher }) {
  const dispatch = dispatcher ?? createFrameDispatcher({ store });

  const offFrame = sse.onFrame((frame) => {
    dispatch.dispatch(frame);
  });
  const offStatus = sse.onStatus((status) => {
    store.dispatch({ type: ACTIONS.CONNECTION_SET, connection: status });
  });

  sse.connect(projectId);

  return {
    disconnect() {
      // Disconnect the stream FIRST so its terminal 'closed' status still flows
      // through onStatus into the store connection slice, THEN unsubscribe the
      // hooks. (Unsubscribing first would swallow the closed status.)
      sse.disconnect();
      offFrame();
      offStatus();
    },
  };
}
