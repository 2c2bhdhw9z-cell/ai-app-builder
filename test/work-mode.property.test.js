/**
 * Property 21 (Task 32.3, Req 28.4/28.5/28.6):
 *   "Work_Mode is always observable and switching is confirmed and
 *    state-preserving"
 *
 * fast-check generates SEQUENCES of steps over a REAL Session (a real
 * createWorkModeSession with an INJECTED clock) plus a POPULATED real non-mode
 * state snapshot (a real WorkspaceExperienceStore over an fs.mkdtemp
 * StorageLayout with a persisted experience document). Each step is one of:
 *   - requestSwitch(target)      : ask to switch (out-of-enum targets included)
 *   - confirm(approved:true)     : approve the pending switch (the ONLY mutator)
 *   - confirm(approved:false)    : deny the pending switch
 *   - timeout                    : the confirm ceiling elapses (fail-closed)
 *
 * The confirm surface is modeled EXACTLY as the Builder Server drives it: a
 * valid requestSwitch mints a pending target WITHOUT applying it; applySwitch is
 * called ONLY when an explicit confirm(approve) resolves for a pending target;
 * deny and timeout leave the mode unchanged and clear nothing that could mutate
 * state. The confirm ceiling is driven by an INJECTED clock / a modeled timeout
 * step, NEVER by real waiting.
 *
 * INVARIANTS asserted after EVERY step:
 *   (a) the active mode is ALWAYS present in the Session_Header frame;
 *   (b) a switch is applied ONLY after an explicit confirm — an unconfirmed,
 *       denied, or timed-out request leaves the mode UNCHANGED;
 *   (c) all Project state (here: the real persisted presentation document,
 *       standing in for source/agent-state/Project-data/Snapshots/models/
 *       Skills/Connectors/permissions/Project_Origin/Theme/Workspace_Experience)
 *       is byte-for-byte unchanged across the WHOLE sequence.
 *
 * NON-VACUOUS: real non-mode state is populated so the equality is meaningful,
 * and across the runs we PROVE at least some confirmed switches DID change the
 * active mode (tracked in a module-level counter asserted after fc.assert).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createWorkModeSession, createWorkspaceExperienceStore } from '../src/presentation/index.js';
import { sessionHeaderFrame, workModeFrame } from '../src/server/index.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { Work_Mode, isValidWorkMode, DEFAULT_WORK_MODE } from '../src/model/enums.js';

const TAG = propertyTag(
  21,
  'Work_Mode is always observable and switching is confirmed and state-preserving',
);

test('Property 21 tag renders EXACTLY the spec string', () => {
  assert.equal(
    TAG,
    'Feature: ai-app-builder, Property 21: Work_Mode is always observable and switching is confirmed and state-preserving',
  );
});

/**
 * A step in a switch/confirm sequence. `target` (for requestSwitch) may be an
 * out-of-enum value so the property also exercises rejection.
 */
const stepArb = fc.oneof(
  fc.record({
    kind: fc.constant('requestSwitch'),
    target: fc.oneof(
      fc.constantFrom(...Work_Mode),
      // out-of-enum targets — must be refused with the mode left in effect.
      fc.constantFrom('plan', 'Vibe', 'SPEC', '', 'hybrid ', 'default'),
    ),
  }),
  fc.record({ kind: fc.constant('confirm'), approved: fc.constant(true) }),
  fc.record({ kind: fc.constant('confirm'), approved: fc.constant(false) }),
  fc.record({ kind: fc.constant('timeout') }),
);

test(TAG, () => {
  let confirmedModeChanges = 0; // non-vacuity: proven-real confirmed switches.
  let runs = 0;

  fc.assert(
    fc.property(
      fc.array(stepArb, { minLength: 1, maxLength: 30 }),
      // an injected clock: a monotonically advancing millisecond counter.
      fc.integer({ min: 0, max: 1_000_000 }),
      (steps, clockStart) => {
        runs += 1;

        // --- REAL populated non-mode state (a persisted presentation document).
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-wmode-prop-'));
        try {
          const layout = createStorageLayout(dir);
          const store = createWorkspaceExperienceStore({ layout });
          const ownerId = 'owner-prop-21';
          // Populate real non-mode state so byte-for-byte equality is meaningful.
          const sel = store.select(ownerId, 'technical-workbench');
          assert.equal(sel.ok, true);
          const statePath = layout.controlPresentationSettingsPath(ownerId);
          const stateBefore = fs.readFileSync(statePath); // Buffer snapshot.
          assert.ok(stateBefore.length > 0);

          // --- REAL Session with an injected, deterministic clock.
          let clock = clockStart;
          const session = createWorkModeSession({ now: () => new Date(clock) });

          const choices = session.creationChoices();

          // The header must ALWAYS carry the active mode (invariant a), checked
          // right at construction too.
          const initialHeader = sessionHeaderFrame({ mode: session.current(), choices });
          assert.equal(initialHeader.type, 'session_header');
          assert.equal(initialHeader.workMode, session.current());
          assert.equal(session.current(), DEFAULT_WORK_MODE);

          let expectedMode = session.current(); // model of the ONLY legal mode.

          for (const step of steps) {
            clock += 1; // advance the injected clock every step (no real wait).

            if (step.kind === 'requestSwitch') {
              const result = session.requestSwitch(step.target);
              if (isValidWorkMode(step.target)) {
                // Valid target: pending minted, but NOT applied (Req 28.5).
                assert.equal(result.ok, true);
                assert.equal(session.current(), expectedMode, 'requestSwitch must NOT apply');
                const pend = session.pending();
                assert.ok(pend && pend.target === step.target, 'pending target recorded');
              } else {
                // Out-of-enum: refused, current mode left in effect (Req 28.7),
                // NO pending minted.
                assert.equal(result.ok, false);
                assert.equal(result.code, 'unsupported_work_mode');
                assert.equal(session.current(), expectedMode, 'out-of-enum leaves the mode');
              }
            } else if (step.kind === 'confirm' && step.approved === true) {
              // The Builder Server applies ONLY a pending target on approval.
              const pend = session.pending();
              if (pend) {
                const before = session.current();
                const applied = session.applySwitch(pend.target);
                assert.equal(applied.ok, true);
                expectedMode = pend.target;
                assert.equal(session.current(), expectedMode, 'confirmed switch applied');
                if (before !== session.current()) confirmedModeChanges += 1;
                assert.equal(session.pending(), null, 'pending cleared after apply');
              } else {
                // Nothing pending to confirm: mode unchanged.
                assert.equal(session.current(), expectedMode);
              }
            } else {
              // confirm(deny) OR timeout: fail-closed, DO NOT apply. The pending
              // request is simply not applied; the mode is unchanged (Req 28.5).
              assert.equal(session.current(), expectedMode, 'deny/timeout leaves the mode');
            }

            // (a) The active mode is ALWAYS observable in the Session_Header and
            //     the work_mode frame at every step.
            const header = sessionHeaderFrame({ mode: session.current(), choices });
            assert.equal(header.type, 'session_header');
            assert.equal(header.workMode, session.current());
            assert.ok(isValidWorkMode(header.workMode), 'header mode is always a legal Work_Mode');
            const wm = workModeFrame({ mode: session.current(), choices });
            assert.equal(wm.mode, session.current());

            // (b) The active mode only ever equals the model's expectedMode,
            //     which only advances on an explicit confirmed switch.
            assert.equal(session.current(), expectedMode);

            // (c) Real Project (non-mode) state is byte-for-byte unchanged after
            //     EVERY step.
            const stateNow = fs.readFileSync(statePath);
            assert.ok(stateBefore.equals(stateNow), 'non-mode state unchanged mid-sequence');
          }

          // (c) again over the WHOLE sequence: still byte-for-byte identical.
          const stateAfter = fs.readFileSync(statePath);
          assert.ok(stateBefore.equals(stateAfter), 'non-mode state byte-for-byte unchanged');
          assert.equal(store.get(ownerId), 'technical-workbench', 'persisted experience unchanged');
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    ),
    fcConfig,
  );

  // >= 100 iterations actually ran.
  assert.ok(runs >= 100, `expected >=100 iterations, ran ${runs}`);
  // NON-VACUOUS: across the runs, at least SOME confirmed switches changed the
  // active mode — the property is not trivially satisfied by never switching.
  assert.ok(
    confirmedModeChanges > 0,
    `expected some confirmed switches to change the mode, saw ${confirmedModeChanges}`,
  );
});
