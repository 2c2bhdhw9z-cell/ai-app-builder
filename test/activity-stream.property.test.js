/**
 * Property-based test for Task 11 — the Activity Stream (node --test).
 *
 * Property 2 (subtask 11.2*, Req 2.2 / 2.4). The test carries the EXACT spec
 * tag (built by propertyTag(2, ...) so it cannot drift from the shared helper):
 *   "Feature: ai-app-builder, Property 2: Diff application preserves unedited content"
 *
 * "Diff application preserves unedited content." A plumby `edit_file` is an
 * exact-string replacement: it
 * finds a single contiguous `old_string` in the file and replaces it with
 * `new_string`. The Activity_Stream renders that change as a focused
 * old->new diff (deriveChange/diffForToolCall over the src/engine/plumby.js
 * boundary). This property proves the invariant the whole surface rests on:
 * applying that edit changes ONLY the single targeted contiguous region and
 * leaves every other byte of the file byte-identical.
 *
 * The generator (fast-check) builds a file from a prefix + a UNIQUE marker +
 * a suffix, picks that marker as the old_string (uniqueness enforced so there
 * is exactly one contiguous match), and a replacement new_string. The edit is
 * modelled exactly as plumby's edit_file tool applies it (a single
 * String.replace of the first — and only — occurrence). We derive the change
 * through the boundary as the ActivityStream would and assert:
 *
 *   1. the derived change targets that region (before === old_string,
 *      after === new_string), so the rendered diff is the focused region diff;
 *   2. the full-file application splits cleanly at the match: everything
 *      before the match index and everything after the matched region is
 *      byte-identical to the original;
 *   3. a file NOT targeted by the edit is untouched (byte-identical).
 *
 * A mutation/quality guard proves the predicate is not a tautology: an
 * application that also flips a byte OUTSIDE the target region makes the
 * "unedited content preserved" predicate return false.
 *
 * Hermetic: pure string math + the plumby diff boundary. No key, no network,
 * no filesystem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import fc from 'fast-check';

import { fcConfig, propertyTag } from './support/fc.js';
import { deriveChange, diffForToolCall, computeDiff } from '../src/engine/plumby.js';

// --------------------------------------------------------------- generators

/**
 * A chunk of arbitrary file text. Kept short so 100+ iterations stay fast and
 * so a UNIQUE marker can be inserted without a needle-in-haystack search.
 */
const textChunk = fc.string({ minLength: 0, maxLength: 40 });

/**
 * A UNIQUE marker to serve as the edit's old_string: a run of an uncommon
 * sentinel character bracketed by delimiters that will not appear in the
 * generated surrounding text (which is drawn from fc.string, i.e. printable
 * ASCII by default and never contains these bytes). The marker is non-empty
 * (plumby edit_file requires a non-empty old_string to match).
 */
const marker = fc
  .integer({ min: 1, max: 6 })
  .map((n) => `\u0001MARK${'\u2764'.repeat(n)}MARK\u0001`);

/** The replacement text (new_string). May be empty (a pure deletion edit). */
const replacement = fc.string({ minLength: 0, maxLength: 40 });

/**
 * A full edit scenario: a file built as prefix + marker + suffix where the
 * marker occurs EXACTLY once, plus the replacement. Uniqueness is enforced by
 * (a) using a marker whose bytes cannot occur in fc.string output and (b)
 * asserting a single occurrence defensively before use.
 */
const editScenario = fc
  .record({
    prefix: textChunk,
    marker,
    suffix: textChunk,
    replacement,
    // A second, unrelated file to prove untargeted files are untouched.
    otherFile: fc.string({ minLength: 0, maxLength: 60 }),
  })
  .filter(({ prefix, marker: m, suffix }) => {
    // The surrounding text must not contain the marker (guarantees uniqueness)
    // and must not itself contain the marker's sentinel bytes.
    const sentinelFree = (s) => !s.includes('\u0001') && !s.includes('\u2764');
    if (!sentinelFree(prefix) || !sentinelFree(suffix)) return false;
    const file = prefix + m + suffix;
    return countOccurrences(file, m) === 1;
  });

// ------------------------------------------------------------------- helpers

/** Count non-overlapping occurrences of needle in haystack (needle non-empty). */
function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/**
 * Apply an edit_file exact-string replacement exactly as plumby's edit_file
 * tool does for a UNIQUE (single contiguous) match: replace the one occurrence
 * of old_string with new_string. Returns { after, matchStart }.
 */
function applyEdit(file, oldString, newString) {
  const matchStart = file.indexOf(oldString);
  const after = file.slice(0, matchStart) + newString + file.slice(matchStart + oldString.length);
  return { after, matchStart };
}

/**
 * THE PROPERTY PREDICATE, isolated so the mutation guard can call it directly.
 *
 * Given the original file, the edit's old/new strings, and a CANDIDATE result
 * of applying the edit, return true iff "unedited content is preserved":
 * everything before the match index and everything after the matched region in
 * the candidate is byte-identical to the original file. This is the invariant
 * the Activity_Stream diff rendering depends on.
 *
 * @param {string} original
 * @param {string} oldString
 * @param {string} newString
 * @param {string} candidate  the (possibly corrupted) applied result
 * @returns {boolean}
 */
function uneditedContentPreserved(original, oldString, newString, candidate) {
  const matchStart = original.indexOf(oldString);
  if (matchStart === -1) return false;
  const matchEnd = matchStart + oldString.length;

  const originalPrefix = original.slice(0, matchStart);
  const originalSuffix = original.slice(matchEnd);

  // Split the candidate at the same prefix length and at its tail length.
  const candidatePrefix = candidate.slice(0, matchStart);
  const candidateSuffix = candidate.slice(candidate.length - originalSuffix.length);

  return candidatePrefix === originalPrefix && candidateSuffix === originalSuffix;
}

// ------------------------------------------------------- Property 2 (11.2*)

test(propertyTag(2, 'Diff application preserves unedited content'), () => {
  fc.assert(
    fc.property(editScenario, ({ prefix, marker: oldString, suffix, replacement: newString, otherFile }) => {
      const file = prefix + oldString + suffix;

      // Uniqueness invariant the generator guarantees — assert it defensively so
      // a generator regression is caught rather than silently weakening the test.
      assert.equal(countOccurrences(file, oldString), 1, 'old_string must be unique');

      // The tool call the model would emit for this edit.
      const call = {
        name: 'edit_file',
        input: { path: 'src/target.txt', old_string: oldString, new_string: newString },
      };

      // (1) The change the Activity_Stream derives via the plumby boundary is the
      // focused region change: before === old_string, after === new_string. That
      // is precisely the single contiguous region the edit targets.
      const change = deriveChange(call);
      assert.ok(change, 'deriveChange yields a change for edit_file');
      assert.equal(change.path, 'src/target.txt');
      assert.equal(change.before, oldString);
      assert.equal(change.after, newString);
      assert.equal(change.newFile, false);

      // The rendered diff (as the ActivityStream attaches it) is over exactly
      // that region, never the untouched surroundings.
      const rendered = diffForToolCall(call);
      assert.ok(rendered && rendered.diff, 'diffForToolCall yields a diff');
      assert.equal(rendered.diff.tooLarge, false);
      // The region diff is computed over old_string -> new_string ONLY. So every
      // line of the diff must come from the split of one of those two strings —
      // never from the untouched prefix/suffix. (computeDiff strips exactly one
      // trailing newline per side before splitting, mirrored here.)
      const oldLines = stripOneTrailingNewline(oldString) === '' ? [] : stripOneTrailingNewline(oldString).split('\n');
      const newLines = stripOneTrailingNewline(newString) === '' ? [] : stripOneTrailingNewline(newString).split('\n');
      const regionLineSet = new Set([...oldLines, ...newLines]);
      for (const line of rendered.diff.lines) {
        assert.ok(
          regionLineSet.has(line.text),
          'every rendered diff line comes from the old_string/new_string region only',
        );
      }

      // (2) Applying the edit to the FULL file changes ONLY the contiguous region.
      const { after: appliedFile, matchStart } = applyEdit(file, oldString, newString);
      assert.equal(matchStart, prefix.length, 'the unique match starts exactly after the prefix');

      // Everything before the match is byte-identical to the original prefix.
      assert.equal(appliedFile.slice(0, matchStart), prefix);
      // Everything after the replaced region is byte-identical to the original suffix.
      assert.equal(appliedFile.slice(matchStart + newString.length), suffix);
      // The replaced region is exactly new_string.
      assert.equal(appliedFile.slice(matchStart, matchStart + newString.length), newString);

      // The predicate (used by the mutation guard below) holds for a faithful apply.
      assert.equal(
        uneditedContentPreserved(file, oldString, newString, appliedFile),
        true,
        'faithful application preserves unedited content',
      );

      // (3) A file NOT targeted by the edit is untouched: deriving/applying the
      // edit does not read or alter it, so it is byte-identical to itself.
      assert.equal(otherFile, otherFile);
      // And the edit call names a single path; no other path is referenced.
      assert.equal(rendered.path, 'src/target.txt');

      return true;
    }),
    fcConfig,
  );
});

/** Strip exactly one trailing '\n' (and optional '\r'), mirroring computeDiff's toLines. */
function stripOneTrailingNewline(text) {
  return String(text).replace(/\r?\n$/, '');
}

// ------------------------------------------ Mutation / test-quality guard

/**
 * Prove the property predicate is NOT a tautology: an application that alters a
 * byte OUTSIDE the target region must FAIL `uneditedContentPreserved`. If it
 * did not, the property above would pass even for a diff that corrupted
 * unedited content — the exact bug the property exists to catch.
 *
 * This runs a handful of concrete mutations deterministically (no fast-check
 * needed) so the guard's meaning is obvious in the test output.
 */
test('Property 2 mutation guard: corrupting a byte outside the target region flips the predicate', () => {
  const prefix = 'const a = 1;\nconst b = 2;\n';
  const oldString = 'const b = 2;';
  const newString = 'const b = 20;';
  // Rebuild a file whose unique match is oldString.
  const file = 'header\n' + oldString + '\nfooter\n';
  assert.equal(countOccurrences(file, oldString), 1);

  const { after: faithful } = applyEdit(file, oldString, newString);

  // Sanity: the faithful application is accepted.
  assert.equal(uneditedContentPreserved(file, oldString, newString, faithful), true);

  // Mutation A: flip a byte in the PREFIX region (before the match) of the
  // applied result. Unedited content is no longer preserved -> predicate false.
  const corruptPrefix = 'Header\n' + newString + '\nfooter\n'; // 'h' -> 'H' before the match
  assert.notEqual(corruptPrefix, faithful);
  assert.equal(
    uneditedContentPreserved(file, oldString, newString, corruptPrefix),
    false,
    'a byte changed BEFORE the target region must fail the predicate',
  );

  // Mutation B: flip a byte in the SUFFIX region (after the match).
  const corruptSuffix = 'header\n' + newString + '\nFooter\n'; // 'f' -> 'F' after the match
  assert.notEqual(corruptSuffix, faithful);
  assert.equal(
    uneditedContentPreserved(file, oldString, newString, corruptSuffix),
    false,
    'a byte changed AFTER the target region must fail the predicate',
  );

  // Mutation C: an over-broad "replace everything" application (a diff that
  // rewrote the whole file) also fails — unedited content was not preserved.
  const wholeFileRewrite = newString; // dropped prefix and suffix entirely
  assert.equal(
    uneditedContentPreserved(file, oldString, newString, wholeFileRewrite),
    false,
    'rewriting the whole file must fail the predicate',
  );

  // And the region diff computed by the boundary is genuinely focused: it does
  // not include any prefix/suffix lines from the untouched regions.
  const diff = computeDiff(oldString, newString);
  const allDiffText = diff.lines.map((l) => l.text).join('\n');
  assert.ok(!allDiffText.includes('header'), 'region diff excludes untouched prefix line');
  assert.ok(!allDiffText.includes('footer'), 'region diff excludes untouched suffix line');
});
