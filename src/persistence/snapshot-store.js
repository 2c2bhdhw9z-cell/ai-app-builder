/**
 * THE SNAPSHOT STORE (spec subtask 8.2, Req 19.3-19.8).
 *
 * A SnapshotStore records atomic, content-addressed Snapshots of a Project's
 * full file state as Git commits in the PROJECT'S OWN repository, and restores
 * the tree at any Snapshot deterministically and idempotently. It also encodes
 * the resume rules (Req 19.5, 19.6) and the turn-trigger policy (design decision
 * (b), Req 19.3 + 20.7).
 *
 * WHERE STATE LIVES (the storage split, src/storage/layout.js):
 *   - The Git working tree AND the Git repository (.git) live INSIDE the
 *     exportable project tree (layout.exportableProjectTree(projectId)). That
 *     tree IS "the Project's repository" (Req 19.9) and is what an export
 *     produces, so it is legitimate for its .git to sit at the tree root.
 *   - The Snapshot REGISTRY (the list of committed Snapshot records:
 *     { id: gitSha, projectId, parentId?, createdAt, trigger }) is control-plane
 *     bookkeeping and is written OUT-OF-TREE at
 *     layout.controlSnapshotRegistryPath(ownerId, projectId), asserted with
 *     layout.assertOutsideExportTrees so it can never enter an exported tree.
 *
 * GIT SAFETY (critical): every git invocation is scoped with cwd = the project's
 * own storage dir. This store NEVER runs git against the ai-app-builder repo's
 * own .git. Because there may be no global git user identity, every commit pins
 * an explicit committer/author identity via `git -c user.name/user.email` AND
 * the GIT_AUTHOR / GIT_COMMITTER env vars, so commits never depend on host config.
 *
 * CONTENT-ADDRESSING & DETERMINISM: snapshotId is the Git commit SHA. Commit
 * SHAs depend on author/committer name+email+timestamp, so we do NOT assert SHA
 * reproducibility; instead restore-equality is asserted on the RESTORED TREE
 * CONTENT. restore() checks out the exact commit tree and cleans untracked
 * residue, so repeated restores converge to identical bytes (Req 19.7, idempotent).
 *
 * ATOMICITY (Req 19.3, 19.4): a Snapshot is either fully recorded or not at all.
 * We stage + commit; if any git step fails we return a structured error and do
 * NOT append to the registry, so the most recent COMPLETE Snapshot is retained.
 * git itself makes the ref update atomic (the commit object + ref move together).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { requireString, requireOneOf, fail } from '../model/validate.js';
import { createSnapshot, SNAPSHOT_TRIGGERS } from '../model/project.js';
import { VERIFY_VERDICTS } from '../model/deployment.js';

/** The deterministic committer/author identity pinned on every commit. */
export const SNAPSHOT_IDENTITY = Object.freeze({
  name: 'AI App Builder',
  email: 'snapshots@ai-app-builder.local',
});

/**
 * The default git seam: run the git CLI with cwd scoped to the project's own
 * storage dir and an identity pinned via -c flags + GIT_* env. Returns trimmed
 * stdout. Throws on non-zero exit (callers convert to structured errors).
 */
function makeDefaultGit() {
  return function git(cwd, args, { allowFail = false } = {}) {
    const idArgs = [
      '-c', `user.name=${SNAPSHOT_IDENTITY.name}`,
      '-c', `user.email=${SNAPSHOT_IDENTITY.email}`,
    ];
    try {
      const out = execFileSync('git', [...idArgs, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: SNAPSHOT_IDENTITY.name,
          GIT_AUTHOR_EMAIL: SNAPSHOT_IDENTITY.email,
          GIT_COMMITTER_NAME: SNAPSHOT_IDENTITY.name,
          GIT_COMMITTER_EMAIL: SNAPSHOT_IDENTITY.email,
          // Keep behavior independent of any host/global/system config surprises.
          GIT_CONFIG_NOSYSTEM: '1',
        },
      });
      return { ok: true, stdout: (out ?? '').toString().trim() };
    } catch (err) {
      if (allowFail) {
        return { ok: false, stdout: (err.stdout ?? '').toString().trim(), stderr: (err.stderr ?? '').toString().trim(), error: err };
      }
      throw err;
    }
  };
}

/**
 * Create a SnapshotStore.
 *
 * @param {object} args
 * @param {object} args.layout       a StorageLayout with exportableProjectTree +
 *                                   controlSnapshotRegistryPath + assertOutsideExportTrees
 * @param {string} [args.ownerId]    owning account id; defaults to 'default'
 * @param {() => string} [args.now]  injectable ISO-timestamp clock for createdAt
 * @param {Function} [args.git]      injectable git runner (default: real git CLI)
 * @param {object} [args.persistenceStore]  optional PersistenceStore used by resume()
 *                                          for the "no snapshot yet" rule (Req 19.6)
 * @returns {object} store (frozen)
 */
export function createSnapshotStore({
  layout,
  ownerId = 'default',
  now = () => new Date().toISOString(),
  git = makeDefaultGit(),
  persistenceStore = null,
} = {}) {
  const model = 'SnapshotStore';
  if (
    !layout ||
    typeof layout.exportableProjectTree !== 'function' ||
    typeof layout.controlSnapshotRegistryPath !== 'function' ||
    typeof layout.assertOutsideExportTrees !== 'function'
  ) {
    fail(model, 'layout with exportableProjectTree/controlSnapshotRegistryPath/assertOutsideExportTrees is required');
  }
  requireString(model, 'ownerId', ownerId);
  if (typeof now !== 'function') fail(model, 'now must be a function returning an ISO timestamp');
  if (typeof git !== 'function') fail(model, 'git must be a function');

  function treeRootFor(projectId) {
    return layout.exportableProjectTree(projectId);
  }

  /** The out-of-tree registry path, proven outside every export tree. */
  function registryPathFor(projectId) {
    const p = layout.controlSnapshotRegistryPath(ownerId, projectId);
    layout.assertOutsideExportTrees(p, 'snapshot-registry');
    return p;
  }

  /** Load the snapshot registry (array of Snapshot records) or [] if none. */
  function loadRegistry(projectId) {
    const p = registryPathFor(projectId);
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }

  /** Persist the registry atomically (temp file + rename), out-of-tree. */
  function saveRegistry(projectId, records) {
    const p = registryPathFor(projectId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, p);
  }

  /** Ensure the project's own Git repo exists at the export-tree root. */
  function ensureRepo(root) {
    fs.mkdirSync(root, { recursive: true });
    const gitDir = path.join(root, '.git');
    if (!fs.existsSync(gitDir)) {
      git(root, ['init', '-q']);
      // Pin a stable default branch name so behavior is host-config independent.
      git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { allowFail: true });
    }
  }

  /** The current HEAD sha, or undefined when the repo has no commits yet. */
  function headSha(root) {
    const res = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
    return res.ok && res.stdout ? res.stdout : undefined;
  }

  /**
   * Materialize the given projectTree into `root`, replacing any tracked/working
   * files so the committed tree is EXACTLY the passed tree. Preserves .git.
   */
  function materializeTree(root, entries) {
    // Remove existing working-tree files (except .git) so deletions in the new
    // tree are reflected. This mirrors "the Snapshot captures the full file state".
    for (const ent of safeReaddir(root)) {
      if (ent === '.git') continue;
      fs.rmSync(path.join(root, ent), { recursive: true, force: true });
    }
    for (const [rel, contents] of entries) {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const buf = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
      fs.writeFileSync(dest, buf);
    }
  }

  function safeReaddir(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  /**
   * Validate + normalize a projectTree map into [[relPath, contents]] entries.
   * Shares the same in-tree/relative-path safety rules as the PersistenceStore.
   */
  function normalizeTree(projectTree) {
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
      if (norm === '.git' || norm.startsWith(`.git${path.sep}`)) {
        fail(model, 'projectTree must not contain a .git entry (reserved for the snapshot repo)');
      }
      if (typeof contents !== 'string' && !Buffer.isBuffer(contents)) {
        fail(model, `projectTree[${JSON.stringify(rel)}] must be a string or Buffer`);
      }
      entries.push([norm, contents]);
    }
    return entries;
  }

  /** Read the working-tree file map (excluding .git) as { relPath: utf8 }. */
  function readWorkingTree(root) {
    const tree = {};
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '.git') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile()) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          tree[rel] = fs.readFileSync(full, 'utf8');
        }
      }
    };
    try {
      walk(root);
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) throw err;
    }
    return tree;
  }

  /**
   * commitSnapshot(projectId, projectTree, { trigger }) -> { ok, snapshotId } |
   * { ok:false, error }  (Req 19.3, 19.4).
   */
  function commitSnapshot(projectId, projectTree, { trigger } = {}) {
    requireString(model, 'projectId', projectId);
    requireOneOf(model, 'trigger', trigger, SNAPSHOT_TRIGGERS);
    const entries = normalizeTree(projectTree);
    const root = treeRootFor(projectId);

    let parentId;
    try {
      ensureRepo(root);
      parentId = headSha(root);
      materializeTree(root, entries);
      git(root, ['add', '-A']);
      // Commit. --allow-empty so a no-op change still produces a Snapshot.
      git(root, ['commit', '-q', '--allow-empty', '-m', `snapshot: ${trigger}`]);
    } catch (err) {
      // Req 19.4: discard the partial. The commit was not created (the failure
      // happened before/at commit), so HEAD is unchanged and the most recent
      // COMPLETE snapshot is retained. Reset the index/working residue best-effort.
      try {
        git(root, ['reset', '-q', '--hard', 'HEAD'], { allowFail: true });
      } catch {
        /* repo may have no HEAD yet; nothing to reset to */
      }
      return {
        ok: false,
        projectId,
        error: {
          kind: 'snapshot-failure',
          message: `failed to record snapshot for project ${projectId}: ${err?.message ?? err}`,
          cause: err,
        },
      };
    }

    const sha = headSha(root);
    if (!sha) {
      return {
        ok: false,
        projectId,
        error: { kind: 'snapshot-failure', message: 'commit produced no HEAD sha' },
      };
    }

    // Build the Snapshot record via the EXISTING model and append it out-of-tree.
    let record;
    try {
      record = createSnapshot({
        id: sha,
        projectId,
        parentId: parentId,
        createdAt: now(),
        trigger,
      });
      const registry = loadRegistry(projectId);
      registry.push(record);
      saveRegistry(projectId, registry);
    } catch (err) {
      return {
        ok: false,
        projectId,
        error: {
          kind: 'snapshot-registry-failure',
          message: `commit ${sha} recorded but registry update failed: ${err?.message ?? err}`,
          cause: err,
          snapshotId: sha,
        },
      };
    }

    return { ok: true, projectId, snapshotId: sha, snapshot: record };
  }

  /**
   * restore(projectId, snapshotId) -> { ok:true, projectTree } | { ok:false, error }
   * (Req 19.7, 19.8, Property 6). Deterministic + idempotent.
   */
  function restore(projectId, snapshotId) {
    requireString(model, 'projectId', projectId);
    requireString(model, 'snapshotId', snapshotId);
    const root = treeRootFor(projectId);

    // Req 19.8: verify the snapshot exists BEFORE touching the working tree.
    const inRegistry = loadRegistry(projectId).some((r) => r.id === snapshotId);
    if (!inRegistry) {
      return {
        ok: false,
        projectId,
        error: {
          kind: 'restore-missing',
          message: `snapshot ${snapshotId} is not in the registry for project ${projectId}`,
        },
      };
    }
    if (!fs.existsSync(path.join(root, '.git'))) {
      return {
        ok: false,
        projectId,
        error: { kind: 'restore-unreadable', message: `no git repository for project ${projectId}` },
      };
    }
    // Confirm it is a real commit object whose tree is readable.
    const exists = git(root, ['cat-file', '-e', `${snapshotId}^{commit}`], { allowFail: true });
    if (!exists.ok) {
      return {
        ok: false,
        projectId,
        error: {
          kind: 'restore-unreadable',
          message: `snapshot ${snapshotId} is missing or its stored file state is unreadable`,
        },
      };
    }

    // Only now mutate the working tree: hard-reset to the commit and remove any
    // untracked residue so repeated restores converge to identical bytes.
    try {
      git(root, ['reset', '-q', '--hard', snapshotId]);
      git(root, ['clean', '-q', '-fd']);
    } catch (err) {
      return {
        ok: false,
        projectId,
        error: {
          kind: 'restore-unreadable',
          message: `failed to restore snapshot ${snapshotId}: ${err?.message ?? err}`,
          cause: err,
        },
      };
    }

    return { ok: true, projectId, snapshotId, projectTree: readWorkingTree(root) };
  }

  /** listSnapshots(projectId): registry records, newest-first. */
  function listSnapshots(projectId) {
    requireString(model, 'projectId', projectId);
    return [...loadRegistry(projectId)].reverse();
  }

  /** latestSnapshot(projectId): most recent complete Snapshot, or null. */
  function latestSnapshot(projectId) {
    const all = loadRegistry(projectId);
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /**
   * resume(projectId) (Req 19.5, 19.6): if the project has >=1 complete Snapshot,
   * restore the MOST RECENT one; else restore the most recent persisted file
   * state via the PersistenceStore.readPersistedTree.
   */
  function resume(projectId) {
    requireString(model, 'projectId', projectId);
    const latest = latestSnapshot(projectId);
    if (latest) {
      const res = restore(projectId, latest.id);
      if (res.ok) return { ok: true, projectId, source: 'snapshot', snapshotId: latest.id, projectTree: res.projectTree };
      return res;
    }
    if (persistenceStore && typeof persistenceStore.readPersistedTree === 'function') {
      return {
        ok: true,
        projectId,
        source: 'persisted',
        projectTree: persistenceStore.readPersistedTree(projectId),
      };
    }
    return {
      ok: false,
      projectId,
      error: {
        kind: 'resume-empty',
        message: `project ${projectId} has no snapshot and no PersistenceStore was provided to read persisted state`,
      },
    };
  }

  /**
   * onTurnComplete({ projectId, projectTree, verifyResult }) — the turn-trigger
   * policy (design decision (b), Req 19.3 + 20.7): commit a 'turn-pass' Snapshot
   * IFF verifyResult.verdict === 'PASS'; do NOT commit on FAIL. This is a PURE
   * decision over a passed-in verify result — it never calls plumby verify
   * (that wiring is the Self-Healing task).
   */
  function onTurnComplete({ projectId, projectTree, verifyResult } = {}) {
    requireString(model, 'projectId', projectId);
    if (!verifyResult || typeof verifyResult.verdict !== 'string') {
      fail(model, 'verifyResult with a verdict is required');
    }
    const pass = verifyResult.verdict === VERIFY_VERDICTS[0]; // 'PASS'
    if (!pass) {
      return { ok: true, projectId, committed: false, verdict: verifyResult.verdict };
    }
    const res = commitSnapshot(projectId, projectTree, { trigger: 'turn-pass' });
    return { ...res, committed: res.ok, verdict: verifyResult.verdict };
  }

  /** Explicit user save: commit a Snapshot with trigger 'explicit'. */
  function commitExplicit(projectId, projectTree) {
    return commitSnapshot(projectId, projectTree, { trigger: 'explicit' });
  }

  return Object.freeze({
    ownerId,
    commitSnapshot,
    commitExplicit,
    restore,
    resume,
    listSnapshots,
    latestSnapshot,
    onTurnComplete,
  });
}
