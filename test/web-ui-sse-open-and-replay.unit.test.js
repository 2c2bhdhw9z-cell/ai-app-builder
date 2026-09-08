/**
 * Unit tests for Web UI Task 4.9 (node --test).
 *
 * Two behaviors, each against the shipping code:
 *
 *   (A) "SSE opens within 2s of session open" (Req 3.1). With a fake clock, the
 *       connect() call issues the /events open attempt WITHOUT waiting on any
 *       timer — i.e. the open is scheduled at t=0, well inside the 2,000 ms
 *       budget — and reaches OPEN. We assert the fetch to /events happened
 *       before any timer advanced (no reconnect delay was consumed to open).
 *
 *   (B) "On re-establish, each replayed slice is applied" (Req 3.7). When the
 *       stream (re)connects, the server replays current-state frames
 *       (turn_state, preview_status, workspace_experience, theme, work_mode,
 *       session_header, pending confirm_request). Feeding those replay frames
 *       through the SAME onFrame → dispatcher path applies each slice to the
 *       REAL store — proving replay and live handling share one code path.
 *
 * REAL COLLABORATORS. The REAL createSseClient (injected fetch + fake clock +
 * AbortController), the REAL connectActivityStream wiring, the REAL frame
 * dispatcher, and the REAL store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSseClient, SSE_STATUS } from '../src/server/public/sse.js';
import { createStore } from '../src/server/public/store.js';
import { connectActivityStream } from '../src/server/public/views/activity-stream.js';

class FakeAbortController {
  constructor() {
    this.signal = { aborted: false };
  }
  abort() {
    this.signal.aborted = true;
  }
}

/** A fake clock that records scheduled delays and only fires when drained. */
function fakeClock() {
  let id = 1;
  const timers = new Map();
  const scheduled = [];
  return {
    scheduled,
    setTimeout: (cb, delay) => {
      const t = id++;
      timers.set(t, cb);
      scheduled.push(delay);
      return t;
    },
    clearTimeout: (t) => timers.delete(t),
    fired: () => scheduled.length,
  };
}

/**
 * Build a getReader()-style body that delivers the given replay frames and then
 * STAYS OPEN (a real SSE stream does not EOF after the replay — it keeps
 * streaming live frames). After the chunks are drained, `read()` returns a
 * promise that never resolves, so the client remains OPEN rather than treating
 * an EOF as a drop.
 */
function replayBody(frames) {
  const chunks = [': connected\n', 'retry: 2000\n\n', ...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`)];
  let i = 0;
  return {
    getReader() {
      return {
        read: async () => {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return new Promise(() => {}); // stream stays open (no EOF)
        },
        cancel: async () => {},
      };
    },
  };
}

/** Pump microtasks until the async body reader has fully drained. */
async function pump(n = 80) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

test('Task 4.9 (A): SSE opens the /events stream at t=0, within the 2s budget (fake clock)', async () => {
  const clock = fakeClock();
  let openedUrl = null;
  let openedAtTimerCount = null;

  const client = createSseClient({
    getToken: () => 'tok',
    AbortControllerImpl: FakeAbortController,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    fetchImpl: async (url) => {
      openedUrl = url;
      // Capture how many reconnect timers had been scheduled BEFORE this open:
      // a first open must not consume any reconnect delay (it opens immediately,
      // far inside the 2,000ms budget of Req 3.1).
      openedAtTimerCount = clock.fired();
      return { status: 200, body: replayBody([]) };
    },
  });

  const statuses = [];
  client.onStatus((s) => statuses.push(s));

  client.connect('proj-123');
  // Allow the synchronous kickoff's microtasks to settle.
  await pump();

  assert.ok(openedUrl, 'the /events stream was opened');
  assert.ok(openedUrl.includes('/events?projectId=proj-123'), 'opened the correct events URL');
  assert.equal(openedAtTimerCount, 0, 'opened without consuming any reconnect delay (t=0)');
  assert.equal(client.getStatus(), SSE_STATUS.OPEN, 'reached OPEN');
  assert.ok(statuses.includes(SSE_STATUS.CONNECTING), 'emitted connecting first');
  assert.ok(statuses.includes(SSE_STATUS.OPEN), 'emitted open');
});

test('Task 4.9 (B): on (re)establish, each replayed current-state frame is applied to the store', async () => {
  const store = createStore();

  // The server's reconnection frame set (see handleEvents): turn_state, a
  // preview_status, a workspace_experience, a theme (committed), work_mode,
  // session_header, and a pending confirm_request.
  const replay = [
    { type: 'turn_state', running: true },
    { type: 'preview_status', status: 'ready', url: 'http://localhost:9000/', snapshotId: 'snap-1' },
    { type: 'workspace_experience', experience: 'technical-workbench', layout: { id: 'tw', regions: [] }, attribution: 'Layout inspired by classic IDEs' },
    { type: 'theme', theme: 'dark', palette: { background: '#000000', surface: '#111111', accent: '#22aaff', button: '#3366cc', badge: '#8844aa', statusInfo: '#2299dd', statusSuccess: '#22aa55', statusWarning: '#ddaa22', statusError: '#dd3333' }, previewed: false, workspaceExperience: 'technical-workbench' },
    { type: 'work_mode', mode: 'spec', choices: ['vibe', 'spec', 'hybrid'] },
    { type: 'session_header', workMode: 'spec', workModeChoices: ['vibe', 'spec', 'hybrid'] },
    { type: 'confirm_request', requestId: 'req-42', command: 'rm -rf build', category: 'destructive', reason: 'clean build dir' },
  ];

  const client = createSseClient({
    getToken: () => 'tok',
    AbortControllerImpl: FakeAbortController,
    setTimeoutImpl: (cb) => { void cb; return 0; },
    clearTimeoutImpl: () => {},
    fetchImpl: async () => ({ status: 200, body: replayBody(replay) }),
  });

  // Wire the real SSE→store path used on session open.
  const wiring = connectActivityStream({ store, sse: client, projectId: 'proj-9' });
  await pump();

  const state = store.getState();

  // turn_state running -> submit gated in flight (Req 2.5, 3.7)
  assert.equal(state.session.submitInFlight, true, 'turn_state running applied');
  // preview_status ready with url applied
  assert.equal(state.preview.status, 'ready', 'preview status applied');
  assert.equal(state.preview.url, 'http://localhost:9000/', 'preview url applied');
  assert.equal(state.preview.snapshotId, 'snap-1', 'preview snapshotId applied');
  // workspace_experience -> layout only, attribution surfaced
  assert.equal(state.workspace.experience, 'technical-workbench', 'workspace experience applied');
  assert.equal(state.workspace.attribution, 'Layout inspired by classic IDEs', 'attribution applied');
  // theme committed applied to committed slice (previewed:false)
  assert.equal(state.theme.committedTheme, 'dark', 'committed theme applied');
  assert.equal(state.theme.committedPalette.background, '#000000', 'committed palette applied');
  assert.equal(state.theme.previewedTheme, null, 'a committed frame set no preview');
  // work_mode / session_header -> active mode + choices
  assert.equal(state.workMode.active, 'spec', 'work mode applied');
  assert.deepEqual(state.workMode.choices, ['vibe', 'spec', 'hybrid'], 'work mode choices applied');
  // pending confirm re-displayed keyed by requestId (Req 5.4)
  assert.ok(state.session.pendingConfirms['req-42'], 'pending confirm applied');
  assert.equal(state.session.pendingConfirms['req-42'].command, 'rm -rf build', 'confirm payload applied');
  // connection mirrored to open
  assert.equal(state.session.connection, SSE_STATUS.OPEN, 'connection mirrored to open');

  wiring.disconnect();
});

test('Task 4.9 (B): a failed open mirrors a reconnecting status into the store connection slice', async () => {
  const store = createStore();
  const clock = fakeClock();
  const client = createSseClient({
    getToken: () => 'tok',
    AbortControllerImpl: FakeAbortController,
    setTimeoutImpl: clock.setTimeout, // records the reconnect delay; never auto-fires
    clearTimeoutImpl: clock.clearTimeout,
    fetchImpl: async () => ({ status: 500, body: null }),
  });
  const wiring = connectActivityStream({ store, sse: client, projectId: 'p' });
  await pump();

  // A failed open schedules a bounded reconnect and mirrors 'reconnecting' into
  // the store connection slice (Req 3.5/3.6 surface state).
  assert.equal(
    store.getState().session.connection,
    SSE_STATUS.RECONNECTING,
    'connection slice reflects reconnecting after a failed open',
  );
  // The scheduled reconnect delay is within the 5s cap.
  assert.ok(clock.scheduled.length >= 1, 'a reconnect was scheduled');
  assert.ok(clock.scheduled.every((d) => d <= 5000), 'scheduled delay within cap');

  // A user disconnect stops the loop and mirrors 'closed'. (No pending timer
  // fires — the fake clock only records; and disconnect bumps the generation so
  // any late callback is inert.)
  wiring.disconnect();
  assert.equal(store.getState().session.connection, SSE_STATUS.CLOSED, 'disconnect mirrors closed');
});
