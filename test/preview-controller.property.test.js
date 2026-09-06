/**
 * Property 3 — Preview reflects committed state (spec subtask 18.3; design
 * §"Property 3", Req 3.1, 3.3, 3.4).
 *
 * PROPERTY: for ALL sequences of committed Snapshots (each with a buildOk flag)
 * interleaved with uncommitted edits, the served Preview content ALWAYS
 * corresponds to the most-recently SUCCESSFULLY-BUILT COMMITTED Snapshot, and
 * NEVER to any uncommitted intermediate edit.
 *
 * MODEL: we drive the PreviewController through a generated op sequence:
 *   - 'edit'   -> markBuilding(...) with a WIP id that must NEVER become served
 *   - 'commit' -> publish({ snapshotId, buildOk }) where buildOk decides whether
 *                 the commit builds; a failing build must RETAIN the prior good
 *                 served snapshot (decision (d), Req 3.4).
 * A parallel oracle tracks, independently of the controller, the expected served
 * snapshot: the id of the most recent commit whose buildOk was true (or null
 * before any successful build). After each op we assert the controller's served
 * snapshot equals the oracle AND that it is never one of the uncommitted WIP ids.
 *
 * OFFLINE SEAM: a fake Dev_Server (launches nothing) + an injected clock; no real
 * process/container/network. >=100 iterations via fcConfig.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createPreviewController } from '../src/project/preview-controller.js';
import { fcConfig, propertyTag } from './support/fc.js';

/** A fake Dev_Server seam: records nothing beyond a success handle; inert. */
function fakeDevServer() {
  return {
    start(args) {
      return { ok: true, url: `http://preview.local/${args?.projectId}`, startedAt: 'T0' };
    },
    stop() {
      return { ok: true, stopped: true };
    },
    isRunning() {
      return true;
    },
  };
}

/** A monotonic injected ms clock; no real wait. */
function clock() {
  let t = 0;
  return () => (t += 1);
}

test(propertyTag(3, 'Preview reflects committed state'), () => {
  // Each op is either an uncommitted edit or a committed snapshot (build ok/fail).
  const opArb = fc.oneof(
    fc.record({ kind: fc.constant('edit') }),
    fc.record({ kind: fc.constant('commit'), buildOk: fc.boolean() }),
  );

  fc.assert(
    fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
      const pc = createPreviewController({ devServer: fakeDevServer(), now: clock() });
      const projectId = 'proj-prop-3';
      pc.start({ projectId, sandbox: {}, targetCategory: 'web' });

      // Oracle: the expected served snapshot id is the most recent COMMIT whose
      // build succeeded. Uncommitted edits never change it.
      let expectedServed = null;
      const wipIds = new Set(); // every uncommitted edit id — must never be served.
      let commitSeq = 0;
      let editSeq = 0;

      for (const op of ops) {
        if (op.kind === 'edit') {
          editSeq += 1;
          const wipId = `wip-${editSeq}`;
          wipIds.add(wipId);
          pc.markBuilding({ projectId, snapshotId: wipId });
        } else {
          commitSeq += 1;
          const snapshotId = `snap-${commitSeq}`;
          pc.publish({ projectId, snapshotId, buildOk: op.buildOk });
          // A SUCCESSFUL build advances the served snapshot; a FAILED build
          // retains the prior good one (Req 3.4).
          if (op.buildOk) expectedServed = snapshotId;
        }

        const served = pc.servedPreview(projectId);
        // Property 3: served ALWAYS equals the most-recent successfully-built
        // committed snapshot.
        assert.equal(served.snapshotId, expectedServed);
        // And NEVER an uncommitted intermediate edit.
        assert.ok(
          served.snapshotId === null || !wipIds.has(served.snapshotId),
          'served preview must never be an uncommitted edit',
        );
        // When a broken commit sits atop a prior good one, the surface indicates
        // a prior state is shown.
        if (served.snapshotId !== null && served.buildError) {
          assert.equal(served.showingPrior, true);
        }
      }
    }),
    fcConfig,
  );
});
