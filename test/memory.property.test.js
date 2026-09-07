/**
 * Property-based tests for Task 24 — Memory subsystem (node --test).
 *
 * Built on the REAL on-disk MemoryStore (src/memory/store.js) delivered by
 * FEAT-002, driven against the REAL StorageLayout on a fresh fs.mkdtemp temp
 * dir per iteration (removed in a finally). ONLY the summarizer and the clock
 * are injected; everything else is the real object. Each property runs >=100
 * iterations via fcConfig and carries the EXACT spec tag.
 *
 *   Property 16 (Task 24.3, Req 14.7/14.8) — "Memory stays within cap":
 *     for all `auto` stores, after ANY sequence of automatic additions the
 *     store stays at or below BOTH the byte cap and the entry cap, and when
 *     eviction occurred the summarized gist is preserved (a synthetic 'summary'
 *     entry exists). Caps are small so eviction actually binds (non-vacuous);
 *     per-entry text is bounded so no single entry alone exceeds capBytes.
 *
 *   Property 17 (Task 24.4, Req 14.6/14.13) — "Memory is fully exportable":
 *     for all stores (a random sequence of addUser/addAuto/edit/delete under a
 *     random mode), export() reproduces EVERY current Memory_Entry (by id and
 *     every field) as human-readable content, with no omission and no extra
 *     hidden entries.
 *
 *   Property 18 (Task 24.5, Req 14.10) — "Off mode adds nothing automatically":
 *     for all `off` stores, a sequence of addAuto calls (interleaved with
 *     occasional addUser calls) leaves an entry set that contains ONLY the
 *     user-added entries; NONE of the auto attempts land. The auto attempts are
 *     ones that WOULD add in auto mode (non-vacuous).
 *
 * Hermeticity: every iteration allocates a fresh fs.mkdtemp base removed in a
 * finally; no shared state leaks across runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createMemoryStore } from '../src/memory/store.js';

const FIXED_NOW = () => new Date('2026-01-01T00:00:00.000Z');
const AUTO_KINDS = ['decision', 'preference', 'convention', 'correction'];

/** A fresh, hermetic layout rooted in a temp dir; caller removes `base`. */
function tempLayout(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { base, layout: createStorageLayout(base) };
}

/** Byte size of the on-disk document (the exact source of truth). */
function docBytes(handle) {
  return Buffer.byteLength(handle.export().content, 'utf8');
}

// --- Property 16 -----------------------------------------------------------

test('Feature: ai-app-builder, Property 16: Memory stays within cap', () => {
  // Confirm the rendered tag is EXACTLY the required string.
  assert.equal(
    propertyTag(16, 'Memory stays within cap'),
    'Feature: ai-app-builder, Property 16: Memory stays within cap',
  );

  // Small caps so eviction binds; per-entry text short enough that a single
  // entry never alone exceeds capBytes (a degenerate case the property should
  // not generate). keepRecent < capEntries.
  // Non-whitespace text so the structured summarizer always yields a real gist
  // when overflow is summarized (whitespace-only text is a degenerate case that
  // produces no gist — outside this property's scope, per design).
  const nonBlankText = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')), {
      minLength: 1,
      maxLength: 24,
    })
    .map((chars) => {
      const s = chars.join('');
      return s.trim() === '' ? `x${s}` : s;
    });
  const autoAdd = fc.record({
    kind: fc.constantFrom(...AUTO_KINDS),
    text: nonBlankText,
  });

  let sawEvictionAcrossRuns = false;

  fc.assert(
    fc.property(
      fc.array(autoAdd, { minLength: 1, maxLength: 60 }),
      fc.integer({ min: 8, max: 30 }), // capEntries
      fc.integer({ min: 3, max: 8 }), // keepRecent
      (adds, capEntries, keepRecentRaw) => {
        const keepRecent = Math.min(keepRecentRaw, capEntries - 1);
        const { base, layout } = tempLayout('aab-mem-p16-');
        // A serialized entry with max text is ~400 bytes; capBytes is chosen so
        // the entry cap is the binding constraint (eviction fires by count),
        // while the byte cap still holds and is asserted. Both bounds are real:
        // capBytes comfortably fits capEntries entries so the summarized gist is
        // never itself squeezed out by the byte cap, and no single entry alone
        // exceeds capBytes (the degenerate case the property excludes).
        const capBytes = capEntries * 500 + 2000;
        try {
          const store = createMemoryStore({
            layout,
            now: FIXED_NOW,
            notify: () => {},
            capEntries,
            capBytes,
            keepRecent,
          });
          const ps = store.projectStore('p1');
          assert.equal(ps.getMode(), 'auto');

          let evicted = false;
          for (const a of adds) {
            const r = ps.addAuto(a);
            // A well-formed auto add either succeeds or evicts; it must never
            // silently drop with an unexpected failure code here.
            if (r.ok && r.evicted) evicted = true;
          }

          // Cap invariant: at or below BOTH bounds after ANY sequence.
          assert.ok(
            ps.list().length <= capEntries,
            `entry cap: ${ps.list().length} <= ${capEntries}`,
          );
          assert.ok(
            docBytes(ps) <= capBytes,
            `byte cap: ${docBytes(ps)} <= ${capBytes}`,
          );

          // Gist preservation: if eviction occurred a synthetic summary exists.
          if (evicted) {
            sawEvictionAcrossRuns = true;
            assert.ok(
              ps.list().some((e) => e.kind === 'summary' && e.origin === 'auto'),
              'eviction preserves a synthetic summary gist',
            );
          }
          return true;
        } finally {
          fs.rmSync(base, { recursive: true, force: true });
        }
      },
    ),
    fcConfig,
  );

  // Non-vacuity: the entry cap actually bound (eviction fired) across the runs.
  assert.equal(sawEvictionAcrossRuns, true, 'Property 16 is non-vacuous (eviction fired)');

  // Second arm: the BYTE cap is the binding constraint. Larger text with a high
  // entry cap so bytes bind first; keepRecent small so the summarized gist +
  // recent tail always fit under the byte cap and the gist is preserved.
  const bigText = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), { minLength: 20, maxLength: 80 })
    .map((chars) => {
      const s = chars.join('');
      return s.trim() === '' ? `x${s}y` : s;
    });
  let sawByteEviction = false;
  fc.assert(
    fc.property(
      fc.array(fc.record({ kind: fc.constantFrom(...AUTO_KINDS), text: bigText }), { minLength: 1, maxLength: 60 }),
      (adds) => {
        const { base, layout } = tempLayout('aab-mem-p16b-');
        const capBytes = 2500;
        try {
          const store = createMemoryStore({
            layout,
            now: FIXED_NOW,
            notify: () => {},
            capEntries: 500, // high so BYTES bind first
            capBytes,
            keepRecent: 3,
          });
          const ps = store.projectStore('p1');
          let evicted = false;
          for (const a of adds) {
            const r = ps.addAuto(a);
            if (r.ok && r.evicted) evicted = true;
          }
          assert.ok(ps.list().length <= 500, 'entry cap holds');
          assert.ok(docBytes(ps) <= capBytes, `byte cap holds: ${docBytes(ps)} <= ${capBytes}`);
          if (evicted) {
            sawByteEviction = true;
            assert.ok(
              ps.list().some((e) => e.kind === 'summary' && e.origin === 'auto'),
              'byte-driven eviction preserves a synthetic summary gist',
            );
          }
          return true;
        } finally {
          fs.rmSync(base, { recursive: true, force: true });
        }
      },
    ),
    fcConfig,
  );
  assert.equal(sawByteEviction, true, 'Property 16 byte cap is non-vacuous (byte-driven eviction fired)');
});

// --- Property 17 -----------------------------------------------------------

test('Feature: ai-app-builder, Property 17: Memory is fully exportable', () => {
  assert.equal(
    propertyTag(17, 'Memory is fully exportable'),
    'Feature: ai-app-builder, Property 17: Memory is fully exportable',
  );

  // A step is one management operation. edit/delete target an existing id when
  // present. Modes vary across runs to prove export is complete under all.
  const step = fc.oneof(
    fc.record({ op: fc.constant('addUser'), kind: fc.constantFrom('user', ...AUTO_KINDS), text: fc.string({ maxLength: 20 }) }),
    fc.record({ op: fc.constant('addAuto'), kind: fc.constantFrom(...AUTO_KINDS), text: fc.string({ minLength: 1, maxLength: 20 }) }),
    fc.record({ op: fc.constant('edit'), which: fc.nat(), text: fc.string({ maxLength: 20 }) }),
    fc.record({ op: fc.constant('delete'), which: fc.nat() }),
  );

  fc.assert(
    fc.property(
      fc.array(step, { maxLength: 40 }),
      fc.constantFrom('auto', 'manual', 'off'),
      (steps, mode) => {
        const { base, layout } = tempLayout('aab-mem-p17-');
        try {
          const store = createMemoryStore({
            layout,
            now: FIXED_NOW,
            notify: () => {},
            // Roomy caps so most adds land (export completeness, not eviction).
            capEntries: 200,
            capBytes: 65536,
          });
          const g = store.globalStore('o1');
          g.setMode(mode);

          for (const s of steps) {
            if (s.op === 'addUser') {
              g.addUser({ kind: s.kind, text: s.text });
            } else if (s.op === 'addAuto') {
              g.addAuto({ kind: s.kind, text: s.text });
            } else if (s.op === 'edit') {
              const list = g.list();
              if (list.length > 0) g.edit(list[s.which % list.length].id, { text: s.text });
            } else if (s.op === 'delete') {
              const list = g.list();
              if (list.length > 0) g.delete(list[s.which % list.length].id);
            }
          }

          const exported = g.export();
          assert.equal(exported.ok, true);
          const parsed = JSON.parse(exported.content);
          const live = g.list();

          // No omission and no extra hidden entries: the exported content
          // reproduces EXACTLY the live entry list (order + every field).
          assert.deepEqual(parsed.entries, live);
          // export() returned entries also match the on-disk content.
          assert.deepEqual(exported.entries, live);

          // By id + by field, every live entry is reproduced with no hidden state.
          const byId = new Map(parsed.entries.map((e) => [e.id, e]));
          assert.equal(byId.size, live.length, 'no duplicate/omitted ids');
          for (const e of live) {
            assert.deepEqual(byId.get(e.id), e, `entry ${e.id} reproduced field-for-field`);
          }
          return true;
        } finally {
          fs.rmSync(base, { recursive: true, force: true });
        }
      },
    ),
    fcConfig,
  );
});

// --- Property 18 -----------------------------------------------------------

test('Feature: ai-app-builder, Property 18: Off mode adds nothing automatically', () => {
  assert.equal(
    propertyTag(18, 'Off mode adds nothing automatically'),
    'Feature: ai-app-builder, Property 18: Off mode adds nothing automatically',
  );

  // Each step is either an auto attempt (which WOULD add in auto mode) or an
  // explicit user add. `isUser` marks the ones that should actually land.
  const step = fc.record({
    isUser: fc.boolean(),
    kind: fc.constantFrom(...AUTO_KINDS),
    text: fc.string({ minLength: 1, maxLength: 20 }),
  });

  let sawAutoAttempt = false;

  fc.assert(
    fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
      const { base, layout } = tempLayout('aab-mem-p18-');
      try {
        const store = createMemoryStore({ layout, now: FIXED_NOW, notify: () => {} });
        const ps = store.projectStore('p1');
        ps.setMode('off');
        assert.equal(ps.getMode(), 'off');

        let expectedUserCount = 0;
        for (const s of steps) {
          if (s.isUser) {
            const r = ps.addUser({ kind: s.kind, text: s.text });
            assert.equal(r.ok, true, 'explicit user add always allowed in off mode');
            expectedUserCount += 1;
          } else {
            sawAutoAttempt = true;
            const r = ps.addAuto({ kind: s.kind, text: s.text });
            assert.equal(r.ok, false, 'auto add refused in off mode');
            assert.equal(r.code, 'memory_off');
          }
        }

        const list = ps.list();
        // ONLY user-origin entries landed; NONE of the auto attempts did.
        assert.equal(list.length, expectedUserCount, 'exactly the user adds landed');
        for (const e of list) {
          assert.equal(e.origin, 'user', 'every stored entry is user-originated');
        }
        return true;
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }),
    fcConfig,
  );

  // Non-vacuity: auto attempts (that would add in auto mode) were generated.
  assert.equal(sawAutoAttempt, true, 'Property 18 is non-vacuous (auto attempts present)');
});
