/**
 * refinement.js — the ITERATIVE-REFINEMENT ROUTER (spec Task 16.1, Req 2.1-2.7).
 *
 * A refinement is a FOLLOW-UP turn on an EXISTING Project. Unlike createProject
 * (which mints a new Project and, on the first turn, generates a tree from
 * scratch), a refinement must:
 *
 *   - edit ONLY files that already live INSIDE the existing Project's tree, via
 *     plumby's edit_file EXACT-STRING replacement against a single contiguous
 *     target (Req 2.1, 2.2) — never create a new Project, never regenerate the
 *     whole tree;
 *   - preserve every byte OUTSIDE the edited region (Req 2.4) — this is
 *     delegated to plumby's replaceOnce, which slices around the matched span;
 *   - render the applied change as a visual Diff within 2s (Req 2.3), reusing
 *     the SAME pure computeDiff plumby / the activity stream use;
 *   - surface the three edit_file failure contracts with the Project left
 *     byte-for-byte UNCHANGED (Req 2.5, 2.6, 2.7):
 *        zero-match / multi-match target -> 'not uniquely located' (target file unchanged)
 *        missing file                    -> 'file not found'       (all files unchanged)
 *        no actionable / no-op change     -> 'no changes applied'   (files unchanged)
 *
 * THE PLUMBY BOUNDARY: this module NEVER imports the plumby package. It consumes
 * plumby's editFileTool and computeDiff ONLY through injection — the production
 * wiring passes the seams re-exported from src/engine/plumby.js. The router does
 * NOT reimplement exact-string matching; it drives editFileTool.handler and MAPS
 * its ToolError codes to the spec report strings.
 *
 * HOW edit_file's refusals give us the "unchanged" guarantee: editFileTool runs
 * ALL of its refusal checks (containment, read-before-edit, existence, match
 * count, no-op) and only writes AFTER they all pass (verified in
 * plumby/src/tools/edit_file.js). So a refused SINGLE edit inherently leaves the
 * file untouched. For a MULTI-edit batch, an earlier edit may already have
 * written before a later edit fails, so the router captures each targeted file's
 * pre-image up front and RESTORES the already-applied files on any failure,
 * making the whole refinement all-or-nothing (Req 2.6).
 *
 * Conventions: a factory returning Object.freeze({...}); dependency injection for
 * the clock and every collaborator; structured { ok:true|false, code?, report? }
 * results for the expected failure paths (the router never throws on an expected
 * edit_file refusal). Timing SLOs are measured against the injected `now` clock.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The visual-diff budget from Req 2.3: a refinement's diff renders within 2s. */
export const DIFF_SLO_MS = 2000;

/**
 * Map an edit_file ToolError code to the spec report contract. Returns a
 * structured rejection { ok:false, code, report, toolCode, message } or null
 * when the code is not one the router maps (an unexpected error re-throws).
 */
function mapToolError(err) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  switch (code) {
    // Missing file: edit_file changes an EXISTING file; a missing target leaves
    // ALL project files unchanged (Req 2.6).
    case 'not_found':
      return {
        ok: false,
        code: 'FILE_NOT_FOUND',
        report: 'file not found',
        toolCode: code,
        message: err.message,
      };
    // Zero matches ('not_found_string') OR more than one match ('ambiguous'):
    // the target is not UNIQUELY located, so the edit is refused and the TARGET
    // file is left unchanged (Req 2.5).
    case 'not_found_string':
    case 'ambiguous':
      return {
        ok: false,
        code: 'NOT_UNIQUELY_LOCATED',
        report: 'not uniquely located',
        toolCode: code,
        message: err.message,
      };
    // A no-op edit (old_string === new_string) changes nothing (Req 2.7).
    case 'noop':
      return {
        ok: false,
        code: 'NO_CHANGES_APPLIED',
        report: 'no changes applied',
        toolCode: code,
        message: err.message,
      };
    default:
      return null;
  }
}

/**
 * Normalize the caller's edit shape. The router accepts `edit` (single) or
 * `edits` (array); each edit is { path, oldString, newString, replaceAll? }.
 * Returns an array (possibly empty).
 */
function normalizeEdits({ edit, edits }) {
  if (Array.isArray(edits)) return edits.slice();
  if (edit !== undefined && edit !== null) return [edit];
  return [];
}

/**
 * Create a RefinementRouter.
 *
 * @param {object} args
 * @param {object} args.editFileTool   plumby's editFileTool (via src/engine/plumby.js);
 *        the router calls editFileTool.handler(input, ctx). Injected so tests can
 *        drive the REAL tool or a spy. The router NEVER imports plumby directly.
 * @param {Function} args.computeDiff  plumby's computeDiff (via src/engine/plumby.js),
 *        computeDiff(oldText, newText, opts?) -> { lines, stats, ... }. Reused for
 *        the <=2s visual diff; NOT reimplemented.
 * @param {object} [args.persistenceStore] OPTIONAL PersistenceStore
 *        (persist/flush); when injected, a successful refinement persists the
 *        updated tree durably. Its ABSENCE leaves behavior working (codebase idiom).
 * @param {object} [args.snapshotStore]   OPTIONAL SnapshotStore (onTurnComplete);
 *        when injected with a verifyResult, a successful refinement REUSES the
 *        existing turn-pass snapshot policy — snapshot logic is NOT reinvented.
 * @param {() => number} [args.now]    injectable ms clock for the 2s diff bound.
 *        Default Date.now.
 * @returns {object} router (frozen)
 */
export function createRefinementRouter({
  editFileTool,
  computeDiff,
  persistenceStore,
  snapshotStore,
  now = () => Date.now(),
} = {}) {
  const model = 'RefinementRouter';
  if (!editFileTool || typeof editFileTool.handler !== 'function') {
    throw new TypeError(`${model}: editFileTool with handler(input, ctx) is required`);
  }
  if (typeof computeDiff !== 'function') {
    throw new TypeError(`${model}: computeDiff must be a function`);
  }
  if (typeof now !== 'function') {
    throw new TypeError(`${model}: now must be a function returning ms`);
  }

  /**
   * Read a targeted file's ORIGINAL bytes as utf8. Returns { exists, content }.
   * A missing file yields { exists:false }; the pre-image is what the diff is
   * computed against and what a batch restore rewrites on failure.
   */
  function readOriginal(absPath) {
    try {
      return { exists: true, content: fs.readFileSync(absPath, 'utf8') };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { exists: false, content: null };
      throw err;
    }
  }

  /**
   * applyRefinement({ project?, treeRoot, edit | edits, projectTree?, verifyResult?, signal? })
   *
   * Route a refinement's edit(s) through plumby's edit_file against files in the
   * EXISTING Project tree (treeRoot). treeRoot is the Project's exportable tree
   * root (layout.exportableProjectTree(projectId)) used as the edit_file ctx.cwd,
   * so edit_file's containment guarantees every edit stays INSIDE the Project —
   * never a new Project, never a regen.
   *
   * For each edit { path, oldString, newString, replaceAll? }:
   *   1. read the file's ORIGINAL bytes first (pre-image for the diff and for
   *      the batch restore; also lets us know it exists before editing);
   *   2. pre-seed ctx = { cwd: treeRoot, readFiles: new Set([resolvedTargetPath]) }
   *      — edit_file refuses an unread file with code 'unread_edit'; the router
   *      legitimately supplies the read-before-edit ledger because it read the
   *      file itself in step 1;
   *   3. call await editFileTool.handler({ path, old_string, new_string, replace_all }, ctx).
   *
   * On any edit_file refusal the ToolError is mapped to a report contract and,
   * for a multi-edit batch, the already-applied files are RESTORED from their
   * captured pre-images so the whole refinement is all-or-nothing.
   *
   * On success the visual Diff is computed per changed file via computeDiff and
   * elapsed is measured around it against the injected clock.
   *
   * @returns {Promise<
   *   { ok:true, changedPaths:string[], diffs:{path,diff}[], diffMs:number, persisted?:boolean, snapshot?:object }
   *   | { ok:false, code:string, report:string, path?:string, toolCode?:string, message?:string }>}
   */
  async function applyRefinement({ treeRoot, edit, edits, projectId, projectTree, verifyResult, signal } = {}) {
    if (typeof treeRoot !== 'string' || treeRoot.trim() === '') {
      return { ok: false, code: 'TREE_ROOT_REQUIRED', report: 'no changes applied', message: 'a treeRoot is required' };
    }
    const root = path.resolve(treeRoot);
    const list = normalizeEdits({ edit, edits });

    // No actionable change (Req 2.7): an empty edits list, or every edit being a
    // no-op (oldString === newString) or lacking a target path, means there is
    // nothing to change. Report 'no changes applied', files unchanged.
    const actionable = list.filter(
      (e) => e && typeof e.path === 'string' && e.path.trim() !== '' && e.oldString !== e.newString,
    );
    if (actionable.length === 0) {
      return {
        ok: false,
        code: 'NO_CHANGES_APPLIED',
        report: 'no changes applied',
        message: 'the refinement referenced no actionable edit',
      };
    }

    // Capture the pre-image of every targeted file up front so a batch can be
    // rolled back to byte-for-byte its starting state if a later edit fails.
    // Keyed by resolved absolute path; records { path, resolved, original,
    // existed, applied } where `applied` flips true once edit_file writes it.
    const targets = [];
    for (const e of actionable) {
      const resolved = path.resolve(root, e.path);
      const pre = readOriginal(resolved);
      targets.push({
        edit: e,
        resolved,
        original: pre.content,
        existed: pre.exists,
        applied: false,
      });
    }

    /**
     * Restore every already-applied file in this batch to its captured
     * pre-image, so a partially-applied multi-edit refinement leaves the tree
     * byte-for-byte unchanged (Req 2.6). A single-edit refinement never enters
     * here because edit_file refuses BEFORE writing, but the restore is correct
     * for it too (nothing is `applied`). Best-effort: a restore failure must not
     * mask the original edit_file error.
     */
    function restoreApplied() {
      for (const t of targets) {
        if (!t.applied) continue;
        try {
          if (t.existed) {
            fs.writeFileSync(t.resolved, t.original, 'utf8');
          } else {
            // The file did not exist before this batch — edit_file only edits
            // existing files, so this cannot happen, but guard anyway.
            fs.rmSync(t.resolved, { force: true });
          }
        } catch {
          /* best-effort restore; do not mask the original failure */
        }
      }
    }

    // Apply each edit in order through plumby's edit_file (exact-string).
    for (const t of targets) {
      const { edit: e } = t;
      // Pre-seed the read-before-edit ledger with the RESOLVED absolute path the
      // tool computes (path.resolve(cwd, path)), matching edit_file's ctx.readFiles
      // lookup key. This is legitimate: the router read the file in readOriginal.
      const ctx = { cwd: root, readFiles: new Set([t.resolved]) };
      const input = {
        path: e.path,
        old_string: e.oldString,
        new_string: e.newString,
        ...(e.replaceAll === true ? { replace_all: true } : {}),
      };
      try {
        await editFileTool.handler(input, ctx);
        t.applied = true;
      } catch (err) {
        const mapped = mapToolError(err);
        if (mapped === null) {
          // An UNEXPECTED tool error (bad_input, unread_edit, path_escape,
          // is_directory, permission): restore any partial batch, then re-throw
          // so the caller sees the genuine fault rather than a silent swallow.
          restoreApplied();
          throw err;
        }
        // An EXPECTED refusal mapped to a report contract. Restore any files an
        // earlier edit in this batch already applied so the failure's
        // "unchanged" guarantee holds for EVERY project file.
        restoreApplied();
        return { ...mapped, path: e.path };
      }
    }

    // SUCCESS: compute the visual Diff for each changed file, measuring elapsed
    // around the diff computation against the injected clock so the <=2s bound
    // (Req 2.3) is observable. The pre-image is the captured original; the
    // post-image is read back from disk (edit_file wrote it).
    const start = now();
    const diffs = [];
    const changedPaths = [];
    for (const t of targets) {
      const oldText = t.existed ? t.original : '';
      const newText = fs.readFileSync(t.resolved, 'utf8');
      const diff = computeDiff(oldText, newText);
      const rel = path.relative(root, t.resolved).split(path.sep).join('/');
      diffs.push({ path: rel, diff });
      changedPaths.push(rel);
    }
    const diffMs = now() - start;

    const result = { ok: true, changedPaths, diffs, diffMs };

    // Persist the applied change durably when a PersistenceStore is injected,
    // mirroring how project-manager.populateOrigin persists (persist + flush).
    // Build the updated { relPath: contents } map from the files we just changed
    // (merged onto any caller-supplied projectTree so the persisted tree stays
    // complete). Persistence is OPTIONAL — its absence leaves the refinement
    // working (codebase idiom).
    if (persistenceStore && typeof persistenceStore.persist === 'function' && typeof projectId === 'string') {
      const tree = { ...(projectTree && typeof projectTree === 'object' ? projectTree : {}) };
      for (const t of targets) {
        const rel = path.relative(root, t.resolved).split(path.sep).join('/');
        tree[rel] = fs.readFileSync(t.resolved, 'utf8');
      }
      persistenceStore.persist(projectId, tree);
      const flushed = typeof persistenceStore.flush === 'function' ? persistenceStore.flush(projectId) : { ok: true };
      result.persisted = !(flushed && flushed.ok === false);
    }

    // Commit a turn-pass snapshot by REUSING the injected SnapshotStore policy
    // (never reinvented), mirroring project-manager.runGeneration on PASS. Only
    // when a verifyResult is supplied and a projectTree is known.
    if (
      snapshotStore &&
      typeof snapshotStore.onTurnComplete === 'function' &&
      verifyResult !== undefined &&
      projectTree !== undefined &&
      typeof projectId === 'string'
    ) {
      result.snapshot = snapshotStore.onTurnComplete({ projectId, projectTree, verifyResult });
    }

    return result;
  }

  return Object.freeze({
    applyRefinement,
    DIFF_SLO_MS,
  });
}
