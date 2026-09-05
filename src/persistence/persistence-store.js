/**
 * THE PERSISTENCE STORE (spec subtask 8.1, Req 19.1, 19.2, 19.9).
 *
 * A PersistenceStore durably writes a Project's file state (a plain map
 * { relPath: contents }) to disk, and reads the most recent persisted state
 * back. It is the "files on disk in the Project's repository" surface of
 * Req 19.9: the persisted files live INSIDE the exportable project tree
 * (layout.exportableProjectTree(projectId)) — that tree IS the project's
 * repository and is what an export produces. Snapshot metadata never lands
 * here; that is the SnapshotStore's out-of-tree registry.
 *
 * IDLE DEBOUNCE (Req 19.1): a Session mutates the project tree many times in a
 * burst. Rather than write on every keystroke, persist() SCHEDULES a durable
 * write that fires once the change has been idle for `debounceMs` (default and
 * ceiling 2000ms). Each new persist() within the window coalesces onto the same
 * pending write and refreshes the deadline. Tests do NOT sleep 2s: they inject a
 * `now` clock and call flush() (or persistNow()) to force the pending write
 * synchronously, and can advance the injected clock to prove the 2s budget.
 *
 * ATOMIC, DURABLE WRITES (Req 19.1, 19.2): each file is written to a temp file
 * in the same directory and then renamed over the destination, so a crash
 * mid-write cannot corrupt an already-persisted file. If a write fails, the last
 * successfully persisted state is retained UNCHANGED (we never delete or
 * truncate the previous good tree on failure) and persist()/flush() return a
 * structured { ok:false, error } — matching the codebase's result-object idiom —
 * rather than throwing past the API contract.
 *
 * The actual per-tree write is delegated to a `writeTree` seam so tests can
 * inject a failing writer to exercise the last-good-state retention path.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireString, fail } from '../model/validate.js';

/** The idle-persistence budget ceiling from Req 19.1: within 2 seconds. */
export const MAX_DEBOUNCE_MS = 2000;

/** A monotonic-ish default clock (ms). Overridable for deterministic tests. */
function defaultNow() {
  return Date.now();
}

/**
 * Validate that a projectTree is a plain { relPath: string } map with safe,
 * in-tree relative paths (no absolute paths, no traversal). Returns normalized
 * entries [[relPath, contents], ...].
 */
function normalizeTree(model, projectTree) {
  if (projectTree === null || typeof projectTree !== 'object' || Array.isArray(projectTree)) {
    fail(model, 'projectTree must be a plain object map { relPath: contents }');
  }
  const entries = [];
  for (const [rel, contents] of Object.entries(projectTree)) {
    if (typeof rel !== 'string' || rel.trim() === '') {
      fail(model, `projectTree key must be a non-empty relative path, got ${JSON.stringify(rel)}`);
    }
    if (path.isAbsolute(rel)) {
      fail(model, `projectTree path must be relative, got ${JSON.stringify(rel)}`);
    }
    const norm = path.normalize(rel);
    if (norm === '..' || norm.startsWith(`..${path.sep}`) || norm.split(/[\\/]/).includes('..')) {
      fail(model, `projectTree path must not escape the project tree, got ${JSON.stringify(rel)}`);
    }
    // Contract: file contents are TEXT (utf8 strings). The read-back paths
    // (readPersistedTree) decode as utf8, so a Buffer of non-utf8 bytes would
    // not round-trip byte-exact. Rather than silently corrupt non-utf8 input we
    // reject non-strings, keeping the persist->read contract honest (text-only).
    if (typeof contents !== 'string') {
      fail(model, `projectTree[${JSON.stringify(rel)}] must be a string (file contents are utf8 text)`);
    }
    entries.push([norm, contents]);
  }
  return entries;
}

/**
 * The default tree writer: materialize the tree atomically under `treeRoot`.
 *
 * Strategy for durability + last-good-state retention:
 *   - Write each file to a sibling temp file, fsync, then rename over the
 *     destination (atomic replace on POSIX). A crash mid-write leaves either the
 *     old file or the fully-written new file, never a torn file.
 *   - Prune files that are no longer in the tree so readPersistedTree round-trips
 *     the exact map — but NEVER prune the project's Git repo (.git), which the
 *     SnapshotStore owns and which lives at the root of this same tree.
 *   - If any step throws, it propagates to the caller (createPersistenceStore),
 *     which converts it into a structured error WITHOUT having deleted the prior
 *     good tree first (we only rename-in new content; pruning happens last).
 */
function defaultWriteTree(treeRoot, entries) {
  fs.mkdirSync(treeRoot, { recursive: true });

  const written = new Set();
  for (const [rel, contents] of entries) {
    const dest = path.join(treeRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dest);
    written.add(path.resolve(dest));
  }

  // Prune stale files (present on disk but not in the new tree). Done LAST so a
  // failure above cannot leave us having deleted good state. The project's Git
  // repo (.git) is never pruned — it is the SnapshotStore's, not a tree file.
  pruneStale(treeRoot, treeRoot, written);
}

/** Recursively delete files under `dir` whose resolved path is not in `keep`. */
function pruneStale(treeRoot, dir, keep) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // The project's Git repository is owned by the SnapshotStore; leave it.
      if (path.resolve(full) === path.resolve(treeRoot, '.git') || ent.name === '.git') continue;
      pruneStale(treeRoot, full, keep);
      // Remove now-empty dirs (best-effort).
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch {
        /* keep going */
      }
    } else if (!keep.has(path.resolve(full))) {
      try {
        fs.rmSync(full, { force: true });
      } catch {
        /* best-effort prune */
      }
    }
  }
}

/**
 * Create a PersistenceStore.
 *
 * @param {object} args
 * @param {object} args.layout          a StorageLayout (src/storage/layout.js)
 * @param {string} [args.ownerId]       owning account id; defaults to 'default'
 * @param {() => number} [args.now]     injectable clock (ms) for deterministic tests
 * @param {number} [args.debounceMs]    idle debounce budget (<= 2000); default 2000
 * @param {(treeRoot: string, entries: [string, string][]) => void} [args.writeTree]
 *        injectable atomic tree writer (default materializes files on disk);
 *        entries carry utf8-string contents (the store rejects non-string input)
 * @param {(fn: () => void, ms: number) => any} [args.setTimer]  injectable scheduler (default setTimeout)
 * @param {(handle: any) => void} [args.clearTimer]              injectable canceller (default clearTimeout)
 * @param {(projectId: string, error: object) => void} [args.onError]
 *        OPTIONAL error sink invoked when an AUTOMATIC (debounce-timer-path)
 *        persist fails. Because the timer fires with no caller to observe the
 *        { ok:false, error } result, this callback is how a failed idle persist
 *        (Req 19.1 auto-path) surfaces its structured error (Req 19.2). The
 *        pending state and last-good state are retained so a later flush retries.
 * @param {(projectId: string, result: object) => void} [args.onPersist]
 *        OPTIONAL observer invoked on EVERY timer-path persist attempt with the
 *        full result object ({ ok:true|false, ... }), so callers can react to
 *        automatic success as well as failure. Never invoked for explicit
 *        persist/flush/persistNow calls (those return the result directly).
 * @returns {object} store (frozen)
 */
export function createPersistenceStore({
  layout,
  ownerId = 'default',
  now = defaultNow,
  debounceMs = MAX_DEBOUNCE_MS,
  writeTree = defaultWriteTree,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  onError = null,
  onPersist = null,
} = {}) {
  const model = 'PersistenceStore';
  if (!layout || typeof layout.exportableProjectTree !== 'function') {
    fail(model, 'layout with exportableProjectTree is required');
  }
  requireString(model, 'ownerId', ownerId);
  if (typeof now !== 'function') fail(model, 'now must be a function returning ms');
  if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0) {
    fail(model, 'debounceMs must be a non-negative finite number');
  }
  if (debounceMs > MAX_DEBOUNCE_MS) {
    fail(model, `debounceMs must be <= ${MAX_DEBOUNCE_MS} (the 2s idle budget)`);
  }
  if (typeof writeTree !== 'function') fail(model, 'writeTree must be a function');
  if (onError !== null && typeof onError !== 'function') fail(model, 'onError must be a function');
  if (onPersist !== null && typeof onPersist !== 'function') fail(model, 'onPersist must be a function');

  /**
   * Per-project pending write state:
   *   { entries, deadline, timer, lastGood }  keyed by projectId.
   * `entries` is the latest coalesced tree to write; `deadline` the injected-clock
   * time by which the write must be durable; `timer` the scheduler handle.
   */
  const pending = new Map();

  function treeRootFor(projectId) {
    return layout.exportableProjectTree(projectId);
  }

  /** Force the pending durable write for a project NOW. Returns a result object. */
  function persistNow(projectId) {
    requireString(model, 'projectId', projectId);
    const state = pending.get(projectId);
    if (!state) {
      return { ok: true, projectId, durable: true, wrote: false };
    }
    if (state.timer !== undefined && state.timer !== null) {
      clearTimer(state.timer);
      state.timer = null;
    }
    const root = treeRootFor(projectId);
    try {
      writeTree(root, state.entries);
    } catch (err) {
      // Req 19.2: retain the last successfully persisted state unchanged and
      // return a structured persistence error. We keep the pending state so a
      // later retry can still flush it, and we do NOT clear lastGood.
      return {
        ok: false,
        projectId,
        error: {
          kind: 'persistence-failure',
          message: `failed to persist project ${projectId}: ${err?.message ?? err}`,
          cause: err,
        },
      };
    }
    // Success: this tree is now the last good state. Clear the pending write.
    pending.delete(projectId);
    return { ok: true, projectId, durable: true, wrote: true };
  }

  /**
   * persist(projectId, projectTree): schedule a durable write of the tree within
   * the idle budget (Req 19.1). Coalesces onto any pending write and refreshes
   * the deadline. Returns { ok:true, scheduled:true, deadline } — the durable
   * write completes on flush()/persistNow() or when the debounce timer fires.
   */
  function persist(projectId, projectTree) {
    requireString(model, 'projectId', projectId);
    const entries = normalizeTree(model, projectTree);

    const existing = pending.get(projectId);
    if (existing && existing.timer !== undefined && existing.timer !== null) {
      clearTimer(existing.timer);
    }
    const deadline = now() + debounceMs;
    const state = existing ?? {};
    state.entries = entries;
    state.deadline = deadline;
    // The timer flushes the durable write once the change has been idle. Unlike
    // the explicit persist/flush/persistNow paths, NO caller observes this
    // result, so we route it to the optional sinks: onPersist for every timer
    // attempt, onError for a failed one. On failure persistNow retains the
    // pending state and last-good state, so a later flush can still retry.
    state.timer = debounceMs === 0 ? null : setTimer(() => {
      const result = persistNow(projectId);
      if (typeof onPersist === 'function') {
        try {
          onPersist(projectId, result);
        } catch {
          /* an observer must never break the persistence path */
        }
      }
      if (result && result.ok === false && typeof onError === 'function') {
        try {
          onError(projectId, result.error);
        } catch {
          /* an error sink must never break the persistence path */
        }
      }
    }, debounceMs);
    pending.set(projectId, state);

    if (debounceMs === 0) {
      // No debounce window: persist immediately.
      return persistNow(projectId);
    }
    return { ok: true, projectId, scheduled: true, deadline };
  }

  /**
   * flush([projectId]): force pending durable writes NOW (used by tests and by
   * a clean shutdown). With no argument, flushes every pending project. Returns
   * the per-project result (single) or an array of results (all).
   */
  function flush(projectId) {
    if (projectId !== undefined) {
      return persistNow(projectId);
    }
    const results = [];
    for (const id of [...pending.keys()]) {
      results.push(persistNow(id));
    }
    return results;
  }

  /** Whether a project has an unflushed (scheduled but not durable) write. */
  function hasPending(projectId) {
    requireString(model, 'projectId', projectId);
    return pending.has(projectId);
  }

  /**
   * readPersistedTree(projectId): load the most recent persisted file state back
   * as a { relPath: contents(utf8) } map (Req 19.6, Property 4). Returns {} when
   * nothing has been persisted yet. Never reads the project's Git repo (.git).
   */
  function readPersistedTree(projectId) {
    requireString(model, 'projectId', projectId);
    const root = treeRootFor(projectId);
    const tree = {};
    const walk = (dir) => {
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        if (err && err.code === 'ENOENT') return;
        throw err;
      }
      for (const ent of ents) {
        if (ent.name === '.git') continue; // SnapshotStore's repo, not a tree file
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          tree[rel] = fs.readFileSync(full, 'utf8');
        }
      }
    };
    walk(root);
    return tree;
  }

  return Object.freeze({
    ownerId,
    debounceMs,
    persist,
    persistNow,
    flush,
    hasPending,
    readPersistedTree,
  });
}
