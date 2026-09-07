/**
 * Memory subsystem barrel (spec Task 24.1 + 24.2, Req 14, Properties 16/17/18).
 *
 * The public seam for the MemoryStore: transparent, user-controlled, bounded
 * memory kept as HUMAN-READABLE files on disk with no hidden or non-exportable
 * state. Two scopes composed from a StorageLayout (src/storage/layout.js):
 * Project_Memory lives INSIDE the exportable project tree (persisted/restored
 * with the Project by the existing PersistenceStore) and Global_Memory lives
 * out-of-tree under the per-owner control-plane root.
 *
 * SEAM DISCIPLINE: the summarizer used by the auto summarize-and-evict path is
 * an INJECTED seam whose default (defaultStructuredSummarize) is a PURE
 * structured summarizer over the overflow entries — NEVER a live model call —
 * and time is driven by an INJECTED clock. This keeps the cap/evict behavior
 * hermetic and testable, mirroring the rest of the platform's factory
 * conventions (injected clock + sinks, structured results, atomic writes).
 *
 * DELETION SURFACE (Task 12.3 / Req 24.4): the store exposes
 * deleteAccountData(userAccountId) covering BOTH Project_Memory and
 * Global_Memory, which the RetentionService (src/ops/retention.js) composes on
 * account deletion.
 */

export {
  createMemoryStore,
  defaultStructuredSummarize,
  serializeDocument,
  DEFAULT_KEEP_RECENT,
  MEMORY_FILE,
} from './store.js';
