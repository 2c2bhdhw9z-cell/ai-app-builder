/**
 * Property-based test for Web UI Task 4.5 (node --test).
 *
 * Property 6 — "Diffs carry a persistent non-color marker per line"
 * (design §"Property 6", Req 3.4). Exact spec tag:
 *
 *   "Feature: web-ui, Property 6: Diffs carry a persistent non-color marker per
 *    line"
 *
 * PROPERTY. For ANY file-diff frame, EVERY rendered added line begins with a
 * `+` textual marker and EVERY removed line with a `-` textual marker (and an
 * unchanged line with a space), independent of any color styling. The marker is
 * DATA in the projection (`hunks[i].marker`) and in the rendered line string,
 * not merely a CSS class/color.
 *
 * REAL COLLABORATORS. Drives the REAL diff normalizer (`diffToHunks` /
 * `normalizeActivityItem` from frames.js) and the REAL view text projection
 * (`renderDiffText` from views/activity-stream.js) — the same code the browser
 * renders through. The input is a plumby-shaped tool_call `.diff` line model
 * ({ type:'unchanged'|'added'|'removed', text }).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { diffToHunks, normalizeActivityItem, DIFF_MARKERS } from '../src/server/public/frames.js';
import { renderDiffText } from '../src/server/public/views/activity-stream.js';
import { fcConfig } from './support/fc.js';

function webUiTag(n, title) {
  return `Feature: web-ui, Property ${n}: ${title}`;
}

/** A plumby-shaped diff line: { type, text, oldLine, newLine }. */
const diffLine = fc.record({
  type: fc.constantFrom('added', 'removed', 'unchanged'),
  text: fc.string({ maxLength: 40 }),
});

/** A tool_call frame carrying a `.diff` line model. */
const toolCallDiffFrame = fc.record({
  type: fc.constant('tool_call'),
  name: fc.constantFrom('write_file', 'edit_file'),
  summary: fc.string({ maxLength: 20 }),
  diff: fc.record({
    path: fc.string({ minLength: 1, maxLength: 20 }),
    newFile: fc.boolean(),
    lines: fc.array(diffLine, { minLength: 0, maxLength: 30 }),
    stats: fc.constant({ added: 0, removed: 0, unchanged: 0 }),
    truncated: fc.constant(false),
  }),
});

test(webUiTag(6, 'Diffs carry a persistent non-color marker per line'), () => {
  fc.assert(
    fc.property(toolCallDiffFrame, (frame) => {
      // Normalize exactly as the dispatcher does, then render exactly as the
      // view does — the two shipping code paths, no stand-ins.
      const item = normalizeActivityItem(frame, 0);
      assert.equal(item.kind, 'diff', 'a tool_call with a diff normalizes to a diff item');

      const hunks = item.diff.hunks;
      assert.equal(hunks.length, frame.diff.lines.length, 'one hunk per source line');

      const rendered = renderDiffText(item.diff);
      assert.equal(rendered.length, frame.diff.lines.length, 'one rendered line per source line');

      for (let i = 0; i < frame.diff.lines.length; i += 1) {
        const srcType = frame.diff.lines[i].type;
        const expectedMarker = DIFF_MARKERS[srcType];
        // (a) the marker is present as DATA in the normalized hunk
        assert.equal(hunks[i].marker, expectedMarker, `hunk ${i} carries the ${srcType} marker`);
        // (b) the rendered line STRING begins with the marker glyph
        assert.equal(
          rendered[i].line[0],
          expectedMarker,
          `rendered line ${i} begins with the ${srcType} marker`,
        );
        assert.ok(rendered[i].line.startsWith(expectedMarker), 'line prefixed by marker');
        // (c) an added line -> '+', a removed line -> '-'
        if (srcType === 'added') assert.equal(rendered[i].marker, '+');
        if (srcType === 'removed') assert.equal(rendered[i].marker, '-');
      }
      return true;
    }),
    fcConfig,
  );
});

test('Property 6 guard: the three markers are exactly + / - / space', () => {
  assert.equal(DIFF_MARKERS.added, '+');
  assert.equal(DIFF_MARKERS.removed, '-');
  assert.equal(DIFF_MARKERS.unchanged, ' ');
  // An unknown line type degrades to the neutral marker, never throws.
  const h = diffToHunks({ path: 'x', lines: [{ type: 'weird', text: 'q' }] });
  assert.equal(h.hunks[0].marker, ' ');
});
