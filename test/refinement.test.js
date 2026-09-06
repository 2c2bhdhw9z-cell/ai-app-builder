/**
 * RefinementRouter failure-mode + happy-path tests (spec Task 16.2*, Req 2.5,
 * 2.6, 2.7). Node's built-in test runner + node:assert/strict.
 *
 * A refinement is a follow-up turn on an EXISTING Project: it must edit ONLY
 * files inside that project via plumby's edit_file exact-string replacement,
 * preserve every unedited byte, render the change as a diff within 2s, and
 * surface the three edit_file failure contracts with the project left
 * byte-for-byte UNCHANGED. These tests drive the ROUTER (src/project/refinement.js)
 * through the REAL seams: the real plumby editFileTool and the real computeDiff,
 * both imported through the src/engine/plumby.js boundary, against a REAL temp
 * on-disk project tree under os.tmpdir(). No plumby package import here — the
 * router consumes it via injection, exactly as production wires it.
 *
 * Everything is HERMETIC and OFFLINE, exactly as context.json mandates:
 *   - a fresh temp project tree via fs.mkdtempSync(os.tmpdir()), removed in a
 *     finally (mirrors test/project-manager.test.js + test/persistence.test.js);
 *   - an INJECTED, stepping `now` clock so the <=2s diff bound is observable
 *     WITHOUT a real wall-clock wait (a live end-to-end container refinement is
 *     NOT runnable offline, so the 2s bound is measured against this injected
 *     clock, never a real timer);
 *   - EVERY failure/no-op test reads the target file (and, for missing-file /
 *     batch atomicity, the WHOLE tree) back from disk and compares the bytes to
 *     a captured pre-image — not merely asserting the returned result object.
 *
 * The single-region-preservation invariant these lean on is Property 2 —
 * "Feature: ai-app-builder, Property 2: Diff application preserves unedited
 * content" (delivered as a fast-check property in Task 11,
 * test/activity-stream.property.test.js). We do NOT add a second property here;
 * the happy-path test is a concrete, on-disk instance of that same invariant
 * routed through the real editFileTool.
 *
 * MUTATION SENSITIVITY (documented for the reviewer) — concrete mutations each
 * test would catch:
 *   - Mapping plumby's 'ambiguous' (>1 match) to a SUCCESS, or to a different
 *     report string, flips the multi-match test (report !== 'not uniquely
 *     located' and/or the file's bytes would change).
 *   - Mapping 'not_found_string' (zero matches) to anything but 'not uniquely
 *     located' flips the zero-match test.
 *   - A router that regenerates / writes a fresh file on a missing target
 *     (instead of reporting 'file not found' and touching nothing) flips the
 *     missing-file test's whole-tree byte-unchanged assertion.
 *   - Treating a no-op edit (old === new) as success, or not short-circuiting an
 *     empty/no-actionable edits list to 'no changes applied', flips the two
 *     no-op cases.
 *   - Dropping the all-or-nothing batch RESTORE (applying the first edit and
 *     leaving it written when a later edit fails) flips the batch-atomicity test:
 *     the first file would differ from its pre-image.
 *   - Reporting diffMs from a real wall clock instead of the injected `now`, or
 *     not measuring it at all, flips the diffMs bound / step assertions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { createRefinementRouter, DIFF_SLO_MS } from '../src/project/index.js';
import { editFileTool, computeDiff } from '../src/engine/plumby.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createPersistenceStore } from '../src/persistence/index.js';

// ---------------------------------------------------------------- test harness

/**
 * A fresh temp project tree under os.tmpdir(), seeded with `files`
 * ({ relPath: contents }). Returns { root, cleanup } — always call cleanup in a
 * finally so real file I/O stays hermetic.
 */
function tempTree(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-refine-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Snapshot the WHOLE tree as { relPath: bytes } so a failure test can prove
 * EVERY file is byte-for-byte unchanged, not just the named target.
 */
function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        out[rel] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  walk(root);
  return out;
}

/**
 * A stepping/mutable injected clock: each call to now() returns the current
 * value and then advances it by `step` ms. That makes the diff-measurement
 * window deterministic and observable WITHOUT a real timer — the router calls
 * now() once before and once after the diff loop, so with step=1 the measured
 * diffMs is exactly the number of now() calls inside the window.
 */
function steppingClock(startMs = 1_000, step = 1) {
  let t = startMs;
  return {
    now: () => {
      const v = t;
      t += step;
      return v;
    },
    peek: () => t,
  };
}

/** Build a router over the REAL plumby seams with an injected clock. */
function makeRouter(now) {
  return createRefinementRouter({ editFileTool, computeDiff, now });
}

// ------------------------------------------------------- zero-match (Req 2.5)

test('zero-match target -> not uniquely located, file byte-for-byte unchanged', async () => {
  const { root, cleanup } = tempTree({ 'src/app.js': 'export const a = 1;\nexport const b = 2;\n' });
  try {
    const target = path.join(root, 'src/app.js');
    const before = fs.readFileSync(target, 'utf8'); // captured pre-image

    const router = makeRouter(steppingClock().now);
    const res = await router.applyRefinement({
      treeRoot: root,
      edit: { path: 'src/app.js', oldString: 'export const zzz = 99;', newString: 'export const zzz = 100;' },
    });

    assert.equal(res.ok, false, 'a zero-match edit is refused');
    assert.equal(res.report, 'not uniquely located');
    assert.equal(res.code, 'NOT_UNIQUELY_LOCATED');
    assert.equal(res.toolCode, 'not_found_string', 'zero matches maps from plumby not_found_string');

    // The file on disk is byte-for-byte identical to the captured pre-image.
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------- multi-match (Req 2.5)

test('multi-match target -> not uniquely located, file byte-for-byte unchanged', async () => {
  // 'value' appears twice; without replace_all the edit is ambiguous.
  const { root, cleanup } = tempTree({ 'src/dup.js': 'const value = 1;\nconst value = 2;\n' });
  try {
    const target = path.join(root, 'src/dup.js');
    const before = fs.readFileSync(target, 'utf8');

    const router = makeRouter(steppingClock().now);
    const res = await router.applyRefinement({
      treeRoot: root,
      // replace_all intentionally NOT set, so >1 match must be refused.
      edit: { path: 'src/dup.js', oldString: 'value', newString: 'VALUE' },
    });

    assert.equal(res.ok, false, 'a >1-match edit is refused');
    assert.equal(res.report, 'not uniquely located');
    assert.equal(res.code, 'NOT_UNIQUELY_LOCATED');
    assert.equal(res.toolCode, 'ambiguous', '>1 match maps from plumby ambiguous');

    assert.equal(fs.readFileSync(target, 'utf8'), before, 'the ambiguous target is untouched');
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------ missing file (Req 2.6)

test('missing file -> file not found, ALL project files byte-for-byte unchanged', async () => {
  const { root, cleanup } = tempTree({
    'src/app.js': 'export const a = 1;\n',
    'README.md': '# Project\n',
  });
  try {
    const treeBefore = snapshotTree(root); // whole-tree pre-image

    const router = makeRouter(steppingClock().now);
    const res = await router.applyRefinement({
      treeRoot: root,
      edit: { path: 'src/does-not-exist.js', oldString: 'foo', newString: 'bar' },
    });

    assert.equal(res.ok, false, 'an edit to a missing file is refused');
    assert.equal(res.report, 'file not found');
    assert.equal(res.code, 'FILE_NOT_FOUND');
    assert.equal(res.toolCode, 'not_found');

    // EVERY file in the tree is byte-for-byte unchanged, and no new file was
    // created (the router must not regenerate / write a fresh file).
    const treeAfter = snapshotTree(root);
    assert.deepEqual(treeAfter, treeBefore, 'the whole tree is unchanged after a missing-file refinement');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------- no-op (Req 2.7)

test('no-op refinement (old === new) -> no changes applied, files unchanged', async () => {
  const { root, cleanup } = tempTree({ 'src/app.js': 'export const a = 1;\n' });
  try {
    const treeBefore = snapshotTree(root);

    const router = makeRouter(steppingClock().now);
    const res = await router.applyRefinement({
      treeRoot: root,
      edit: { path: 'src/app.js', oldString: 'export const a = 1;', newString: 'export const a = 1;' },
    });

    assert.equal(res.ok, false, 'a no-op edit is refused');
    assert.equal(res.report, 'no changes applied');
    assert.equal(res.code, 'NO_CHANGES_APPLIED');

    assert.deepEqual(snapshotTree(root), treeBefore, 'a no-op leaves every file unchanged');
  } finally {
    cleanup();
  }
});

test('no-op refinement (empty / no actionable edits) -> no changes applied, files unchanged', async () => {
  const { root, cleanup } = tempTree({ 'src/app.js': 'export const a = 1;\n' });
  try {
    const treeBefore = snapshotTree(root);
    const router = makeRouter(steppingClock().now);

    // (b) An empty edits list — nothing to change.
    const empty = await router.applyRefinement({ treeRoot: root, edits: [] });
    assert.equal(empty.ok, false, 'an empty edits list is refused');
    assert.equal(empty.report, 'no changes applied');
    assert.equal(empty.code, 'NO_CHANGES_APPLIED');

    // The tree is untouched by the no-actionable-change path.
    assert.deepEqual(snapshotTree(root), treeBefore, 'an empty refinement leaves every file unchanged');
  } finally {
    cleanup();
  }
});

// ----------------------------------------- happy path: diff within 2s (Req 2.3)

/**
 * Concrete, on-disk instance of Property 2 ("Diff application preserves unedited
 * content", Task 11 / test/activity-stream.property.test.js): routed through the
 * REAL editFileTool, a unique-target edit changes ONLY the matched region and
 * leaves every other line byte-for-byte identical. It also proves the diff is
 * computed via the REAL computeDiff and that diffMs is measured against the
 * INJECTED clock and is within the 2s SLO. The 2s bound is asserted against the
 * injected clock, NOT a real wall-clock wait, because a live refinement cannot
 * run offline.
 */
test('happy path: successful single-target edit preserves unedited bytes and diffs within 2s', async () => {
  const original = [
    'export function greet(name) {',
    '  return "hello " + name;',
    '}',
    '',
    'export const VERSION = "1.0.0";',
    '',
  ].join('\n');
  const { root, cleanup } = tempTree({ 'src/greet.js': original });
  try {
    const target = path.join(root, 'src/greet.js');

    const clock = steppingClock(1_000, 1);
    const router = makeRouter(clock.now);
    assert.equal(router.DIFF_SLO_MS, 2000, 'the 2s diff SLO is surfaced');
    assert.equal(DIFF_SLO_MS, 2000);

    const res = await router.applyRefinement({
      treeRoot: root,
      edit: {
        path: 'src/greet.js',
        oldString: '  return "hello " + name;',
        newString: '  return "hi " + name + "!";',
      },
    });

    assert.equal(res.ok, true, 'a unique-target edit succeeds');
    assert.deepEqual(res.changedPaths, ['src/greet.js']);

    // Only the targeted region changed; every other line is byte-identical.
    const after = fs.readFileSync(target, 'utf8');
    const expected = [
      'export function greet(name) {',
      '  return "hi " + name + "!";',
      '}',
      '',
      'export const VERSION = "1.0.0";',
      '',
    ].join('\n');
    assert.equal(after, expected);

    // Prove the surrounding lines are preserved verbatim (the Property 2
    // invariant, concretely): the only line that differs is the edited one.
    const beforeLines = original.split('\n');
    const afterLines = after.split('\n');
    assert.equal(beforeLines.length, afterLines.length, 'no lines added or removed for an in-place line edit');
    const changedIdx = beforeLines.reduce((acc, l, i) => (l !== afterLines[i] ? [...acc, i] : acc), []);
    assert.deepEqual(changedIdx, [1], 'exactly one line (the target) changed');

    // The diff is the REAL computeDiff shape (lines + stats) reflecting the
    // added/removed lines of the region.
    assert.equal(res.diffs.length, 1);
    const { path: diffPath, diff } = res.diffs[0];
    assert.equal(diffPath, 'src/greet.js');
    assert.equal(diff.tooLarge, false);
    assert.ok(Array.isArray(diff.lines) && diff.lines.length > 0, 'the diff has lines');
    assert.equal(diff.stats.added, 1, 'one line added');
    assert.equal(diff.stats.removed, 1, 'one line removed');
    // The new line is present as an 'added' entry; the old as a 'removed' entry.
    assert.ok(diff.lines.some((l) => l.type === 'added' && l.text === '  return "hi " + name + "!";'));
    assert.ok(diff.lines.some((l) => l.type === 'removed' && l.text === '  return "hello " + name;'));

    // diffMs is measured against the INJECTED clock (start = now() before the
    // diff loop, end = now() after it). With a 1ms step it is a small, positive,
    // deterministic value — and always well within the 2s SLO.
    assert.equal(typeof res.diffMs, 'number');
    assert.ok(res.diffMs >= 0, 'diffMs is non-negative');
    assert.ok(res.diffMs <= DIFF_SLO_MS, `diffMs (${res.diffMs}) is within the ${DIFF_SLO_MS}ms bound`);
    // Exactly the two now() calls around the single-file diff window => 1ms.
    assert.equal(res.diffMs, 1, 'diffMs reflects the injected clock, not a wall clock');
  } finally {
    cleanup();
  }
});

// ------------------------------------------ batch atomicity: all-or-nothing (Req 2.6)

test('batch atomicity: a later missing-file edit fails the whole refinement and restores the first file', async () => {
  const fileAOriginal = 'export const a = 1;\nexport const keep = true;\n';
  const { root, cleanup } = tempTree({ 'src/a.js': fileAOriginal });
  try {
    const treeBefore = snapshotTree(root); // whole-tree pre-image (only src/a.js)

    const router = makeRouter(steppingClock().now);
    const res = await router.applyRefinement({
      treeRoot: root,
      edits: [
        // FIRST edit would succeed on its own (unique match in src/a.js).
        { path: 'src/a.js', oldString: 'export const a = 1;', newString: 'export const a = 42;' },
        // SECOND edit targets a file that does not exist -> the whole refinement
        // must fail 'file not found' AND the first edit must be rolled back.
        { path: 'src/missing.js', oldString: 'foo', newString: 'bar' },
      ],
    });

    assert.equal(res.ok, false, 'the batch fails because a later edit targets a missing file');
    assert.equal(res.report, 'file not found');
    assert.equal(res.code, 'FILE_NOT_FOUND');

    // ALL-OR-NOTHING: the first file was restored to its pre-image, so the whole
    // tree is byte-for-byte unchanged and no partial application leaked through.
    const treeAfter = snapshotTree(root);
    assert.deepEqual(treeAfter, treeBefore, 'a failed batch leaves every file unchanged (first edit rolled back)');
    assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), fileAOriginal);
  } finally {
    cleanup();
  }
});

// -------- audit C3: a partial refinement must NOT delete the rest of the tree

/**
 * REGRESSION for audit C3 (data loss). A refinement that edits ONE file, with no
 * caller-supplied full projectTree, must leave every OTHER persisted file intact
 * on disk. Drives the REAL RefinementRouter + REAL PersistenceStore + REAL
 * StorageLayout + REAL plumby editFileTool against a real 5-file project tree.
 *
 * MUTATION SENSITIVITY: revert the fix (call persistenceStore.persist(projectId,
 * {only the changed file}) — the pre-fix behaviour) and persist()'s pruneStale
 * deletes the four unedited files, so `readPersistedTree` returns only the edited
 * file and this test fails. It also fails if persistPartial were made to prune.
 */
test('C3: a single-file refinement with no full tree leaves the other files intact on disk', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-refine-c3-'));
  const projectId = 'proj-c3';
  const layout = createStorageLayout(base);
  // debounceMs 0 makes persist/persistPartial durable immediately (no timer).
  const persistenceStore = createPersistenceStore({ layout, ownerId: 'owner-c3', debounceMs: 0 });
  try {
    const treeRoot = layout.exportableProjectTree(projectId);

    // Seed a 5-file project and persist it as the COMPLETE tree (the full write).
    const fullTree = {
      'README.md': '# demo\n',
      'index.js': 'export const version = 1;\n',
      'lib/util.js': 'export const util = () => 42;\n',
      'package.json': '{ "name": "demo" }\n',
      'src/app.js': 'export const app = "start";\n',
    };
    const full = persistenceStore.persist(projectId, fullTree);
    assert.equal(full.ok, true);
    assert.deepEqual(
      Object.keys(persistenceStore.readPersistedTree(projectId)).sort(),
      ['README.md', 'index.js', 'lib/util.js', 'package.json', 'src/app.js'],
    );

    // A follow-up refinement edits ONE line of ONE file, supplying NO projectTree.
    const router = createRefinementRouter({ editFileTool, computeDiff, persistenceStore });
    const res = await router.applyRefinement({
      treeRoot,
      projectId,
      edit: { path: 'index.js', oldString: 'export const version = 1;', newString: 'export const version = 2;' },
    });
    assert.equal(res.ok, true, 'the single-file refinement succeeds');
    assert.equal(res.persisted, true, 'the change is persisted');
    assert.deepEqual(res.changedPaths, ['index.js']);

    // THE INVARIANT: all five files still exist on disk; only index.js changed.
    const after = persistenceStore.readPersistedTree(projectId);
    assert.deepEqual(
      Object.keys(after).sort(),
      ['README.md', 'index.js', 'lib/util.js', 'package.json', 'src/app.js'],
      'the four unedited files are NOT deleted by a partial refinement',
    );
    assert.equal(after['index.js'], 'export const version = 2;\n', 'the edited file has the new content');
    assert.equal(after['README.md'], '# demo\n', 'an unedited file is byte-for-byte intact');
    assert.equal(after['lib/util.js'], 'export const util = () => 42;\n');
    assert.equal(after['package.json'], '{ "name": "demo" }\n');
    assert.equal(after['src/app.js'], 'export const app = "start";\n');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
