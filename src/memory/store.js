/**
 * THE MEMORY STORE (spec Task 24.1 + 24.2, Req 14, Properties 16/17/18).
 *
 * ai-app-builder's transparent, user-controlled, bounded memory. Two scopes,
 * both HUMAN-READABLE files on disk with NO hidden or non-exportable state
 * (Req 14.13, Property 17):
 *
 *   - Project_Memory (Req 14.1): scoped to one Project, written INSIDE that
 *     Project's exportable tree at `layout.exportableMemoryPath(projectId)`, so
 *     it is persisted with the Project by the existing PersistenceStore and
 *     restored when the Project is reopened — no separate persistence path.
 *   - Global_Memory (Req 14.2): scoped to a User_Account across all their
 *     Projects, written under `layout.controlGlobalMemoryRoot(ownerId)`
 *     (out-of-tree control-plane, human-readable).
 *
 * A store instance is addressed by (scope, key): `projectStore(projectId)` and
 * `globalStore(ownerId)` each return a handle bound to one on-disk location. The
 * on-disk file is the SOLE source of truth: every field of every MemoryEntry
 * {id, scope, kind, text, createdAt, origin} and the MemoryStoreMeta {scope,
 * mode, capBytes, capEntries} is reproduced verbatim, so `export()` is just
 * "read the file" with nothing omitted. Records are built with the REAL
 * createMemoryEntry / createMemoryStoreMeta models (src/model/memory.js).
 *
 * SEAM DISCIPLINE (contribution conventions):
 *   - `summarize` is an INJECTED seam. The default is a PURE, structured
 *     summarizer over the overflow entries — NEVER a live model call. Tests
 *     inject fakes. It produces named fields DECISIONS / PREFERENCES /
 *     CONVENTIONS / CORRECTIONS grouped by entry kind.
 *   - `now` is an INJECTED clock so timestamps are hermetic.
 *   - `notify` is an INJECTED user-notification sink (memory-full in manual,
 *     eviction-occurred in auto, bad-summary-preserved).
 *   - Writes are ATOMIC (temp file + fsync + rename); a failed write leaves no
 *     partial state. All results are structured `{ ok:false, code, message }`.
 *   - The plumby boundary (src/engine/plumby.js) is untouched; this module
 *     imports Node stdlib + the data models only.
 *
 * THE CAP + SUMMARIZE-AND-EVICT ALGORITHM (design.md §11, Req 14.7-14.10):
 * Memory_Cap binds on EITHER capBytes OR capEntries (default 64 KiB / 200,
 * overridable via AAB_MEMORY_CAP_BYTES / AAB_MEMORY_CAP_ENTRIES or ctor args).
 * When an automatic add would exceed a cap, behavior follows Memory_Mode:
 *   - `off`    : add nothing automatically (only addUser); addAuto returns
 *                { ok:false, code:'memory_off' } (Property 18).
 *   - `manual` : allow auto adds until a cap is reached; once at/over cap,
 *                FREEZE — stop adding, notify the user, require manual prune;
 *                addAuto returns { ok:false, code:'memory_full', notified:true }.
 *                Never summarize/evict.
 *   - `auto`   : run summarize-and-evict:
 *                (1) sort oldest -> newest,
 *                (2) keep the newest KEEP_RECENT (default 20) verbatim,
 *                (3) structured-summarize the oldest overflow,
 *                (4) replace them with ONE synthetic 'summary' entry,
 *                (5) if still over EITHER bound, evict the oldest summarized
 *                    content first (never the recent verbatim tail),
 *                (6) persist. Store is then <= capBytes AND <= capEntries
 *                    (Property 16). The user is notified eviction happened.
 * SAFEGUARD (never destroy history on a bad summary): if the summarizer returns
 * empty/blank/garbage, NOTHING is evicted or replaced — prior entries are left
 * unchanged, the incoming entry is not added if it cannot fit, the user is
 * notified, and addAuto returns { ok:false, code:'summary_failed',
 * preserved:true, notified:true } (a distinct, testable path).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  createMemoryEntry,
  createMemoryStoreMeta,
  MEMORY_STORE_DEFAULTS,
  MEMORY_ENTRY_KINDS,
} from '../model/memory.js';
import { isValidMemoryMode } from '../model/enums.js';

const MODEL = 'MemoryStore';

/** Default number of newest entries kept verbatim on eviction (design.md §11). */
export const DEFAULT_KEEP_RECENT = 20;

/** The human-readable on-disk file name for a memory store (one per address). */
export const MEMORY_FILE = 'memory.json';

/**
 * The structured-summary field labels, in order, grouped by entry kind
 * (design.md §11). A 'user'/'summary' entry folds into DECISIONS as generic
 * context so nothing is lost. These are the named fields the summarizer emits.
 */
const SUMMARY_FIELDS = Object.freeze([
  { label: 'DECISIONS', kinds: ['decision', 'summary', 'user'] },
  { label: 'PREFERENCES', kinds: ['preference'] },
  { label: 'CONVENTIONS', kinds: ['convention'] },
  { label: 'CORRECTIONS', kinds: ['correction'] },
]);

/**
 * The DEFAULT structured summarizer: a PURE function over the overflow entries.
 * It groups the entries by kind into the named fields DECISIONS / PREFERENCES /
 * CONVENTIONS / CORRECTIONS and renders a compact, human-readable gist. It makes
 * NO model call. Returns a plain string (empty when there is nothing to
 * summarize, which the caller treats as a bad/empty summary and refuses to act
 * on — protecting history).
 *
 * @param {Array<object>} entries overflow MemoryEntries (oldest -> newest)
 * @returns {string} structured gist
 */
export function defaultStructuredSummarize(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return '';

  const sections = [];
  for (const { label, kinds } of SUMMARY_FIELDS) {
    const texts = list
      .filter((e) => kinds.includes(e.kind))
      .map((e) => (typeof e.text === 'string' ? e.text.trim() : ''))
      .filter((t) => t !== '');
    if (texts.length === 0) continue;
    const bullets = texts.map((t) => `- ${t}`).join('\n');
    sections.push(`${label}:\n${bullets}`);
  }
  return sections.join('\n\n');
}

/**
 * Resolve the effective caps + keepRecent from ctor overrides, then env
 * (AAB_MEMORY_CAP_BYTES / AAB_MEMORY_CAP_ENTRIES), falling back to
 * MEMORY_STORE_DEFAULTS. Ctor overrides win over env; env wins over defaults.
 */
function resolveCaps({ capBytes, capEntries, keepRecent, env }) {
  const source = env ?? process.env ?? {};
  const fromEnvBytes = parsePositiveInt(source.AAB_MEMORY_CAP_BYTES);
  const fromEnvEntries = parsePositiveInt(source.AAB_MEMORY_CAP_ENTRIES);
  return {
    capBytes:
      parsePositiveInt(capBytes) ?? fromEnvBytes ?? MEMORY_STORE_DEFAULTS.capBytes,
    capEntries:
      parsePositiveInt(capEntries) ?? fromEnvEntries ?? MEMORY_STORE_DEFAULTS.capEntries,
    keepRecent: parseNonNegativeInt(keepRecent) ?? DEFAULT_KEEP_RECENT,
  };
}

function parsePositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

function parseNonNegativeInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return undefined;
}

/** Normalize a notify sink (function or { notify } / { record }) to a fn. */
function toNotifySink(sink) {
  if (typeof sink === 'function') return sink;
  if (sink && typeof sink === 'object') {
    if (typeof sink.notify === 'function') return (e) => sink.notify(e);
    if (typeof sink.record === 'function') return (e) => sink.record(e);
  }
  return () => {};
}

/** Byte size of the persisted document (the exact on-disk source of truth). */
function documentByteSize(doc) {
  return Buffer.byteLength(serializeDocument(doc), 'utf8');
}

/**
 * Serialize a { meta, entries } document to human-readable JSON text. Pretty-
 * printed (2-space) so a user can read/edit/export the file directly, with a
 * trailing newline. Every field of meta and of every entry is reproduced, so
 * export = read this file with nothing omitted (Property 17).
 */
export function serializeDocument({ meta, entries }) {
  return `${JSON.stringify({ meta, entries }, null, 2)}\n`;
}

/**
 * Create the Memory Store.
 *
 * @param {object} args
 * @param {object} args.layout  a StorageLayout; supplies exportableMemoryPath(projectId)
 *   (Project_Memory, in-tree) and controlGlobalMemoryRoot(ownerId) (Global_Memory).
 * @param {() => Date} [args.now]  injected clock (default () => new Date()).
 * @param {(entries:Array<object>) => string} [args.summarize]  injected structured
 *   summarizer over the overflow entries (default defaultStructuredSummarize; NEVER
 *   a live model call).
 * @param {Function|{notify:Function}|{record:Function}} [args.notify]  user-notification sink.
 * @param {number} [args.capBytes]  cap override (env AAB_MEMORY_CAP_BYTES, else 65536).
 * @param {number} [args.capEntries]  cap override (env AAB_MEMORY_CAP_ENTRIES, else 200).
 * @param {number} [args.keepRecent]  newest entries kept verbatim on eviction (default 20).
 * @param {object} [args.env]  env source for cap overrides (default process.env).
 * @returns {object} store (frozen)
 */
export function createMemoryStore({
  layout,
  now = () => new Date(),
  summarize = defaultStructuredSummarize,
  notify,
  capBytes,
  capEntries,
  keepRecent,
  env,
} = {}) {
  if (
    !layout ||
    typeof layout.exportableMemoryPath !== 'function' ||
    typeof layout.controlGlobalMemoryRoot !== 'function'
  ) {
    throw new TypeError(
      `${MODEL}: layout with exportableMemoryPath(projectId) and controlGlobalMemoryRoot(ownerId) is required`,
    );
  }

  const caps = resolveCaps({ capBytes, capEntries, keepRecent, env });
  const emitNotify = toNotifySink(notify);
  const summarizeFn = typeof summarize === 'function' ? summarize : defaultStructuredSummarize;

  /** Notify the user and stamp the notification with the injected clock. */
  function notifyUser(event) {
    emitNotify({ ...event, at: now().toISOString() });
    return true;
  }

  // --- address resolution -------------------------------------------------

  /** Resolve the on-disk directory + file for a (scope, key) address. */
  function resolveAddress(scope, key) {
    if (scope === 'project') {
      const dir = layout.exportableMemoryPath(key);
      return { scope, dir, file: path.join(dir, MEMORY_FILE) };
    }
    // 'global'
    const dir = layout.controlGlobalMemoryRoot(key);
    return { scope, dir, file: path.join(dir, MEMORY_FILE) };
  }

  // --- persistence (atomic; human-readable) --------------------------------

  /**
   * Read the on-disk document for an address. A missing file yields a fresh
   * document with default meta for that scope (mode 'auto' by default, Req 14.3).
   */
  function readDocument(addr) {
    let raw;
    try {
      raw = fs.readFileSync(addr.file, 'utf8');
    } catch {
      return {
        meta: createMemoryStoreMeta({
          scope: addr.scope,
          mode: MEMORY_STORE_DEFAULTS.mode,
          capBytes: caps.capBytes,
          capEntries: caps.capEntries,
        }),
        entries: [],
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${MODEL}: corrupt memory file at ${addr.file}: ${err.message}`);
    }
    // Rebuild through the REAL models so a hand-edited file that is invalid
    // fails loudly rather than silently corrupting the store.
    const meta = createMemoryStoreMeta({
      scope: addr.scope,
      mode: parsed?.meta?.mode ?? MEMORY_STORE_DEFAULTS.mode,
      capBytes: caps.capBytes,
      capEntries: caps.capEntries,
    });
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries.map((e) => createMemoryEntry({ ...e, scope: addr.scope }))
      : [];
    return { meta, entries };
  }

  /** Write the document atomically (temp file + fsync + rename). */
  function writeDocument(addr, doc) {
    const text = serializeDocument(doc);
    try {
      fs.mkdirSync(addr.dir, { recursive: true });
      const tmp = `${addr.file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, Buffer.from(text, 'utf8'));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, addr.file);
    } catch (err) {
      return { ok: false, code: 'write_failed', message: `${MODEL}: could not write memory: ${err.message}` };
    }
    return { ok: true };
  }

  // --- entry construction --------------------------------------------------

  /** Build a validated MemoryEntry for this address from partial input. */
  function buildEntry(addr, { id, kind, text, origin }) {
    return createMemoryEntry({
      id: typeof id === 'string' && id.trim() !== '' ? id : `mem-${crypto.randomUUID()}`,
      scope: addr.scope,
      kind,
      text,
      createdAt: now().toISOString(),
      origin,
    });
  }

  // --- cap math ------------------------------------------------------------

  /** True when a { meta, entries } document is within BOTH caps. */
  function withinCaps(doc) {
    return (
      doc.entries.length <= doc.meta.capEntries &&
      documentByteSize(doc) <= doc.meta.capBytes
    );
  }

  /** Entries sorted oldest -> newest (by createdAt, then original order). */
  function sortedOldestFirst(entries) {
    return entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const ta = Date.parse(a.e.createdAt);
        const tb = Date.parse(b.e.createdAt);
        if (ta !== tb) return ta - tb;
        return a.i - b.i;
      })
      .map(({ e }) => e);
  }

  /**
   * The summarize-and-evict algorithm (design.md §11). Given the FULL candidate
   * entry list (existing + the incoming entry) that violates a cap, returns
   * either { ok:true, entries } (a new bounded entry list) or a structured
   * failure. Pure w.r.t. disk — the caller persists.
   */
  function summarizeAndEvict(addr, meta, candidate) {
    const ordered = sortedOldestFirst(candidate);
    const keepRecentN = Math.min(caps.keepRecent, ordered.length);
    const recentTail = keepRecentN > 0 ? ordered.slice(ordered.length - keepRecentN) : [];
    const overflow = ordered.slice(0, ordered.length - keepRecentN);

    // (3) structured-summarize the oldest overflow.
    let gist = '';
    if (overflow.length > 0) {
      try {
        gist = summarizeFn(overflow);
      } catch {
        gist = '';
      }
    }
    const gistText = typeof gist === 'string' ? gist.trim() : '';

    // SAFEGUARD: a bad/empty summary must NEVER destroy history. When there IS
    // overflow to summarize but the summary is empty/blank, refuse to act.
    if (overflow.length > 0 && gistText === '') {
      return { ok: false, code: 'summary_failed', preserved: true };
    }

    // (4) replace the overflow with ONE synthetic 'summary' entry.
    let next = [...recentTail];
    if (overflow.length > 0) {
      const summaryEntry = buildEntry(addr, {
        kind: 'summary',
        text: gistText,
        origin: 'auto',
      });
      // The summary is the OLDEST content now (it stands in for evicted history),
      // so it sits before the verbatim recent tail.
      next = [summaryEntry, ...recentTail];
    }

    // (5) if STILL over either bound, evict the oldest SUMMARIZED content first
    // (never the recent verbatim tail) until BOTH bounds hold.
    let doc = { meta, entries: next };
    while (!withinCaps(doc) && doc.entries.length > 0) {
      // The recent verbatim tail is protected: only drop entries that are not
      // part of the kept tail. Since the summary (if any) sits at the front, we
      // drop from the front. Never drop below the recent tail.
      if (doc.entries.length <= recentTail.length) break;
      doc = { meta, entries: doc.entries.slice(1) };
    }

    // If even the protected tail alone exceeds a bound, evict oldest of the tail
    // too (bytes bound may still bind on very large recent entries) — Property 16
    // requires the store end within BOTH bounds.
    while (!withinCaps(doc) && doc.entries.length > 1) {
      doc = { meta, entries: doc.entries.slice(1) };
    }

    return { ok: true, entries: doc.entries };
  }

  // --- public operations (each bound to a resolved address) ----------------

  function makeHandle(addr) {
    /** Read the full current state (entries + meta) from disk. */
    function read() {
      const doc = readDocument(addr);
      return { ok: true, scope: addr.scope, meta: doc.meta, entries: doc.entries };
    }

    /** list(): all current entries (Req 14.5 view surface). */
    function list() {
      return readDocument(addr).entries;
    }

    /** getMode(): the store's current Memory_Mode. */
    function getMode() {
      return readDocument(addr).meta.mode;
    }

    /**
     * setMode(mode): change the Memory_Mode. Applies ONLY to subsequent memory
     * management — existing entries are never rewritten (Req 14.11). Validated
     * via isValidMemoryMode.
     */
    function setMode(mode) {
      if (!isValidMemoryMode(mode)) {
        return { ok: false, code: 'invalid_mode', message: `${MODEL}: invalid Memory_Mode ${JSON.stringify(mode)}` };
      }
      const doc = readDocument(addr);
      const meta = createMemoryStoreMeta({
        scope: addr.scope,
        mode,
        capBytes: doc.meta.capBytes,
        capEntries: doc.meta.capEntries,
      });
      const written = writeDocument(addr, { meta, entries: doc.entries });
      if (!written.ok) return written;
      return { ok: true, mode, at: now().toISOString() };
    }

    /**
     * addAuto(entry): an AUTOMATIC add by the Builder_Agent. Obeys Memory_Mode
     * (Req 14.4/14.9/14.10). `entry` = { kind, text, id? }; origin is forced to
     * 'auto'.
     */
    function addAuto(entry = {}) {
      const doc = readDocument(addr);
      const mode = doc.meta.mode;

      // 'off': add NOTHING automatically (Property 18).
      if (mode === 'off') {
        return { ok: false, code: 'memory_off', message: `${MODEL}: Memory_Mode is 'off'; only explicit user entries are stored` };
      }

      let candidateEntry;
      try {
        candidateEntry = buildEntry(addr, {
          id: entry.id,
          kind: entry.kind,
          text: entry.text,
          origin: 'auto',
        });
      } catch (err) {
        return { ok: false, code: 'invalid_entry', message: `${MODEL}: ${err.message}` };
      }

      const candidate = [...doc.entries, candidateEntry];
      const candidateDoc = { meta: doc.meta, entries: candidate };

      // Within caps: just add.
      if (withinCaps(candidateDoc)) {
        const written = writeDocument(addr, candidateDoc);
        if (!written.ok) return written;
        return { ok: true, entry: candidateEntry, evicted: false };
      }

      // At/over cap. Behavior depends on the mode.
      if (mode === 'manual') {
        // FREEZE: stop adding, notify, require manual prune. No summarize/evict.
        const notified = notifyUser({
          type: 'memory-full',
          scope: addr.scope,
          message: `${MODEL}: memory is full (Memory_Mode 'manual'); prune entries to add more`,
        });
        return { ok: false, code: 'memory_full', notified, message: `${MODEL}: memory is full; manual pruning required` };
      }

      // mode === 'auto': summarize-and-evict.
      const result = summarizeAndEvict(addr, doc.meta, candidate);
      if (!result.ok && result.code === 'summary_failed') {
        // NEVER destroy history on a bad/empty summary. Leave prior state; do
        // not add the incoming entry (it could not fit); notify.
        const notified = notifyUser({
          type: 'bad-summary-preserved',
          scope: addr.scope,
          message: `${MODEL}: summarization produced no gist; history preserved and the new entry was not added`,
        });
        return { ok: false, code: 'summary_failed', preserved: true, notified, message: `${MODEL}: summarization failed; history preserved` };
      }

      const nextDoc = { meta: doc.meta, entries: result.entries };
      const written = writeDocument(addr, nextDoc);
      if (!written.ok) return written;

      const kept = new Set(result.entries.map((e) => e.id));
      const evictedCount = doc.entries.filter((e) => !kept.has(e.id)).length;
      const notified = notifyUser({
        type: 'eviction-occurred',
        scope: addr.scope,
        evictedCount,
        message: `${MODEL}: memory reached its cap; older entries were summarized and evicted`,
      });
      // The incoming entry is "added" iff it survived into the persisted set.
      const added = kept.has(candidateEntry.id);
      return { ok: true, entry: added ? candidateEntry : null, evicted: true, evictedCount, notified };
    }

    /**
     * addUser(entry): an EXPLICIT user add. Always allowed under EVERY mode at
     * ANY time (Req 14.5/14.10) — sets origin 'user'. Does NOT auto-evict; if it
     * would exceed a cap it is still stored (the user asked for it), but we
     * notify when the store is now over cap so the surface can prompt a prune.
     */
    function addUser(entry = {}) {
      const doc = readDocument(addr);
      let userEntry;
      try {
        userEntry = buildEntry(addr, {
          id: entry.id,
          kind: entry.kind ?? 'user',
          text: entry.text,
          origin: 'user',
        });
      } catch (err) {
        return { ok: false, code: 'invalid_entry', message: `${MODEL}: ${err.message}` };
      }
      const nextDoc = { meta: doc.meta, entries: [...doc.entries, userEntry] };
      const written = writeDocument(addr, nextDoc);
      if (!written.ok) return written;
      const overCap = !withinCaps(nextDoc);
      if (overCap) {
        notifyUser({
          type: 'memory-full',
          scope: addr.scope,
          message: `${MODEL}: memory is over its cap after a user add; prune to keep automatic management healthy`,
        });
      }
      return { ok: true, entry: userEntry, overCap };
    }

    /** edit(id, { text?, kind? }): update a single entry in place (Req 14.5). */
    function edit(id, changes = {}) {
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, code: 'missing_id', message: `${MODEL}: an entry id is required` };
      }
      const doc = readDocument(addr);
      const idx = doc.entries.findIndex((e) => e.id === id);
      if (idx === -1) {
        return { ok: false, code: 'not_found', message: `${MODEL}: no Memory_Entry with id ${JSON.stringify(id)}` };
      }
      const current = doc.entries[idx];
      let updated;
      try {
        updated = createMemoryEntry({
          ...current,
          text: changes.text !== undefined ? changes.text : current.text,
          kind: changes.kind !== undefined ? changes.kind : current.kind,
        });
      } catch (err) {
        return { ok: false, code: 'invalid_entry', message: `${MODEL}: ${err.message}` };
      }
      const entries = doc.entries.slice();
      entries[idx] = updated;
      const written = writeDocument(addr, { meta: doc.meta, entries });
      if (!written.ok) return written;
      return { ok: true, entry: updated };
    }

    /** delete(id): remove a single entry (Req 14.5). Idempotent-ish. */
    function del(id) {
      if (typeof id !== 'string' || id.trim() === '') {
        return { ok: false, code: 'missing_id', message: `${MODEL}: an entry id is required` };
      }
      const doc = readDocument(addr);
      const entries = doc.entries.filter((e) => e.id !== id);
      if (entries.length === doc.entries.length) {
        return { ok: false, code: 'not_found', message: `${MODEL}: no Memory_Entry with id ${JSON.stringify(id)}` };
      }
      const written = writeDocument(addr, { meta: doc.meta, entries });
      if (!written.ok) return written;
      return { ok: true, deleted: id };
    }

    /**
     * prune(predicateOrIds): manual pruning under ANY mode (Req 14.12). Accepts
     * an array of ids to remove, or a predicate (entry) => boolean that returns
     * true for entries to KEEP.
     */
    function prune(predicateOrIds) {
      const doc = readDocument(addr);
      let entries;
      if (Array.isArray(predicateOrIds)) {
        const ids = new Set(predicateOrIds);
        entries = doc.entries.filter((e) => !ids.has(e.id));
      } else if (typeof predicateOrIds === 'function') {
        entries = doc.entries.filter((e) => Boolean(predicateOrIds(e)));
      } else {
        return { ok: false, code: 'invalid_prune', message: `${MODEL}: prune requires an array of ids or a keep-predicate` };
      }
      const removed = doc.entries.length - entries.length;
      const written = writeDocument(addr, { meta: doc.meta, entries });
      if (!written.ok) return written;
      return { ok: true, removed, remaining: entries.length };
    }

    /**
     * export(): the COMPLETE human-readable content (Req 14.6/14.13, Property
     * 17). This is exactly the on-disk source of truth — no hidden state — so a
     * caller can write it to a file verbatim. Returns { ok, content, meta,
     * entries } where `content` is the serialized document text.
     */
    function exportMemory() {
      const doc = readDocument(addr);
      return {
        ok: true,
        scope: addr.scope,
        meta: doc.meta,
        entries: doc.entries,
        content: serializeDocument(doc),
      };
    }

    return Object.freeze({
      scope: addr.scope,
      read,
      list,
      getMode,
      setMode,
      addAuto,
      addUser,
      edit,
      delete: del,
      prune,
      export: exportMemory,
    });
  }

  /** projectStore(projectId): the Project_Memory handle (in-tree). */
  function projectStore(projectId) {
    return makeHandle(resolveAddress('project', projectId));
  }

  /** globalStore(ownerId): the Global_Memory handle (out-of-tree control-plane). */
  function globalStore(ownerId) {
    return makeHandle(resolveAddress('global', ownerId));
  }

  /**
   * deleteAccountData(userAccountId): the RetentionService seam
   * (src/ops/retention.js), covering BOTH Project_Memory and Global_Memory.
   *
   * Global_Memory: remove the owner's global-memory root outright.
   * Project_Memory: it lives INSIDE each exportable project tree and is
   * physically removed by persistenceStore.deleteProjectTree during project
   * deletion (which the RetentionService performs per-project before calling
   * this seam), so there is no separate per-owner project-memory root to remove
   * here — it is covered by project-tree deletion. We report BOTH categories so
   * the retention completeness contract is satisfied. Idempotent.
   */
  function deleteAccountData(userAccountId) {
    if (typeof userAccountId !== 'string' || userAccountId.trim() === '') {
      return { ok: false, code: 'invalid_owner', message: `${MODEL}: userAccountId must be a non-empty string` };
    }
    const globalRoot = layout.controlGlobalMemoryRoot(userAccountId);
    try {
      fs.rmSync(globalRoot, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, code: 'delete_failed', message: `${MODEL}: could not delete global memory: ${err.message}` };
    }
    return {
      ok: true,
      deleted: ['Project_Memory', 'Global_Memory'],
      ownerId: userAccountId,
      // Project_Memory is removed with each project's exportable tree by the
      // PersistenceStore during project deletion; Global_Memory root removed here.
      projectMemory: 'covered-by-project-tree-deletion',
      at: now().toISOString(),
    };
  }

  return Object.freeze({
    caps: Object.freeze({ ...caps }),
    entryKinds: MEMORY_ENTRY_KINDS,
    projectStore,
    globalStore,
    deleteAccountData,
  });
}
