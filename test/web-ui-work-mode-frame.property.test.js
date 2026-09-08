/**
 * Property-based test for Web UI Task 12.2 (node --test).
 *
 * Property 29 — "A Work_Mode / session_header frame sets the displayed mode and
 * choices" (design §"Property 29", Req 10.2). Exact spec tag:
 *
 *   "Feature: web-ui, Property 29: A Work_Mode / session_header frame sets the
 *    displayed mode and choices"
 *
 * WHAT IS PROVEN, through the REAL store reducer + the REAL work-mode apply path
 * + the REAL Session_Header view-model (no over-mocking): for ANY `work_mode`
 * frame ({ mode, choices }) or `session_header` frame ({ workMode,
 * workModeChoices }), the header's displayed active mode and offered choices
 * equal the frame's mode/choices. Both frame shapes are covered, since the
 * backend broadcasts BOTH (workModeFrame + sessionHeaderFrame) with the same
 * meaning under different key names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createStore } from '../src/server/public/store.js';
import { applyWorkModeFrame, WORK_MODE_OPTIONS } from '../src/server/public/work-mode.js';
import { sessionHeaderViewModel } from '../src/server/public/views/session-header.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

const mode = fc.constantFrom(...WORK_MODE_OPTIONS);
/** A non-empty subset (ordered) of the three modes, as an offered choice set. */
const choices = fc
  .subarray([...WORK_MODE_OPTIONS], { minLength: 1 })
  .filter((c) => c.length > 0);

/** A work_mode frame: { type:'work_mode', mode, choices }. */
const workModeFrame = fc.record({ mode, choices }).map((f) => ({
  type: 'work_mode',
  mode: f.mode,
  choices: f.choices,
}));

/** A session_header frame: { type:'session_header', workMode, workModeChoices }. */
const sessionHeaderFrame = fc.record({ mode, choices }).map((f) => ({
  type: 'session_header',
  workMode: f.mode,
  workModeChoices: f.choices,
}));

const anyFrame = fc.oneof(workModeFrame, sessionHeaderFrame);

// ------------------------------------------------------ Property 29 (Task 12.2)

test(
  webUiTag(29, 'A Work_Mode / session_header frame sets the displayed mode and choices'),
  () => {
    fc.assert(
      fc.property(anyFrame, (frame) => {
        const store = createStore();
        applyWorkModeFrame(store, frame);

        // The frame's intended active mode + choices, regardless of key naming.
        const expectedMode = frame.type === 'work_mode' ? frame.mode : frame.workMode;
        const expectedChoices = frame.type === 'work_mode' ? frame.choices : frame.workModeChoices;

        // The store slice reflects the frame.
        const wm = store.getState().workMode;
        assert.equal(wm.active, expectedMode, 'store active mode == frame mode');
        assert.deepEqual(wm.choices, expectedChoices, 'store choices == frame choices');

        // The header's DISPLAYED mode + choices equal the frame's (Req 10.2).
        const vm = sessionHeaderViewModel(store.getState());
        assert.equal(vm.active, expectedMode, 'displayed active mode == frame mode');
        assert.deepEqual(vm.choices, expectedChoices, 'displayed choices == frame choices');
        return true;
      }),
      fcConfig,
    );
  },
);

// -------------------------------------------- Mutation / test-quality guard

test('Property 29 guard: a differing frame changes the displayed mode', () => {
  const store = createStore();
  assert.equal(sessionHeaderViewModel(store.getState()).active, 'vibe', 'defaults to vibe');
  applyWorkModeFrame(store, { type: 'work_mode', mode: 'spec', choices: ['vibe', 'spec', 'hybrid'] });
  assert.equal(sessionHeaderViewModel(store.getState()).active, 'spec', 'frame moved it to spec');
  applyWorkModeFrame(store, { type: 'session_header', workMode: 'hybrid', workModeChoices: ['hybrid'] });
  assert.equal(sessionHeaderViewModel(store.getState()).active, 'hybrid', 'session_header frame moved it to hybrid');
});
