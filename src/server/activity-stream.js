/**
 * activity-stream.js — the ActivityStream mapping (spec Task 11.1).
 *
 * This is ai-app-builder's pure consumer of plumby's core loop `onEvent`
 * stream: given a single core event it returns the JSON-serialisable
 * Activity_Stream frame the Builder Server broadcasts over SSE, or null for an
 * event the surface has nothing to show for. Like plumby's own
 * src/web/events.js it is deliberately PURE — no http, no DOM — so the mapping
 * logic is unit-testable and cannot regress silently, while the server stays a
 * thin transport.
 *
 * WHY THIS EXISTS RATHER THAN A DIRECT toViewEvent CALL. plumby already owns
 * the hard, shared per-event logic: streamed reasoning/text ordering
 * (text_delta before the turn completes), tool calls in occurrence order, the
 * tool_result preview cap (RESULT_PREVIEW_CHARS = 4000) with truncated /
 * fullLength, and an inline diff attached to write_file / edit_file
 * (edit_file focused old->new, write_file full-content "new file"), including
 * loud truncation and too-large notices. We reuse ALL of that verbatim through
 * the src/engine/plumby.js boundary — reimplementing it would be a fork.
 *
 * The ONE thing plumby's diff.js cannot do is a BINARY write_file. Binary files
 * are now first-class in the project tree (see src/persistence/tree-codec.js),
 * but plumby's deriveChange/computeDiff do `String(input.content ?? '')`, which
 * corrupts a Buffer (and any non-utf8 bytes) into replacement characters and
 * then renders a meaningless, misleading line diff. So this layer detects a
 * binary write_file BEFORE delegating and degrades it to a compact
 * `{ path, binary: true, byteLength, notice: 'binary file (N bytes)' }`
 * indicator — the change is still surfaced as a file modification, just without
 * a corrupting text diff. This guard lives HERE, never in plumby.
 *
 * A normal text write_file / edit_file is untouched: it flows straight through
 * toViewEvent and renders the real diff exactly as before.
 *
 * One other additive rule (Req 4.6): toViewEvent clips an over-cap tool_result
 * to RESULT_PREVIEW_CHARS and sets truncated:true + fullLength, but attaches no
 * human-readable notice for tool OUTPUT (only diffs get a ready-to-render
 * notice). This layer composes a `notice` string from the shown/total counts so
 * the surface can state that output was omitted, leaving the existing
 * truncated/fullLength/content fields exactly as plumby set them.
 */

import { toViewEvent } from '../engine/plumby.js';

/**
 * Create an ActivityStream mapper.
 *
 * @param {object} [opts]
 * @param {(path: string) => (string|Buffer|null|undefined)} [opts.readFileSync]
 *        optional filesystem reader forwarded to toViewEvent so a write_file
 *        that OVERWRITES an existing file renders as a real before/after diff
 *        rather than an all-green "new file". Purely optional; omitted in tests
 *        that drive a scripted agent with no real tree. Mirrors the second
 *        `options` argument toViewEvent already supports.
 * @returns {{ toFrame: (event: object) => (object|null) }}
 */
export function createActivityStream(opts = {}) {
  const options = {};
  if (typeof opts.readFileSync === 'function') options.readFileSync = opts.readFileSync;

  return { toFrame: (event) => toActivityFrame(event, options) };
}

/**
 * Map a single core loop event to an Activity_Stream frame.
 *
 * Delegates every per-event decision to plumby's toViewEvent (so ordering, the
 * tool_result preview cap, and text/edit diffs are inherited unchanged), then
 * applies the one ai-app-builder-specific rule plumby lacks: a binary
 * write_file is degraded to a non-corrupting "binary file (N bytes)" indicator
 * instead of a text line-diff.
 *
 * Returns null for events the surface shows nothing for (exactly as toViewEvent
 * does), so the server can simply skip them.
 *
 * @param {object} event   a core onEvent event
 * @param {object} [options]  forwarded to toViewEvent (e.g. { readFileSync })
 * @returns {object|null}
 */
export function toActivityFrame(event, options = {}) {
  if (!event || typeof event !== 'object') return null;

  // A binary write_file must NOT reach toViewEvent's diffForToolCall, which
  // stringifies the content and would corrupt it. Detect it first, project the
  // rest of the tool_call frame WITHOUT the content (so no diff is computed),
  // and attach the degraded indicator ourselves.
  if (event.type === 'tool_call' && event.name === 'write_file') {
    const detected = binaryContent(event.input?.content);
    if (detected) {
      // Strip `content` for the projection so diffForToolCall derives no diff,
      // then restore the caller's original input on the returned frame so the
      // one-line summary and downstream consumers still see the real input.
      const strippedInput = { ...(event.input ?? {}) };
      delete strippedInput.content;
      const base = toViewEvent({ ...event, input: strippedInput }, options);
      if (!base) return null;
      // CRITICAL (audit H12): do NOT restore the raw binary `content` onto the
      // frame. The transport JSON-serialises the whole frame, and
      // JSON.stringify(Buffer) expands to {"type":"Buffer","data":[...]} — ~6
      // bytes of JSON per binary byte — so a multi-MB file became a giant SSE
      // frame broadcast to every client (a direct OOM path). Keep the stripped
      // input and surface the size as a scalar `contentByteLength` instead.
      base.input = { ...strippedInput, contentByteLength: detected.byteLength };
      base.diff = binaryChangeIndicator(event.input?.path, detected.byteLength);
      return base;
    }
  }

  const frame = toViewEvent(event, options);

  // Req 4.6: an over-cap tool_result must be surfaced "with a truncation notice
  // indicating output was omitted". toViewEvent clips the preview and sets
  // truncated:true + fullLength, but — unlike the diff paths, which carry a
  // ready-to-render truncationNotice/tooLargeNotice string — it attaches NO
  // human-readable notice for tool OUTPUT. So this layer composes one from the
  // shown/total character counts, additively (truncated/fullLength/content are
  // left exactly as plumby set them). Non-truncated results are untouched.
  if (frame && frame.type === 'tool_result' && frame.truncated === true) {
    const shown = typeof frame.content === 'string' ? frame.content.length : 0;
    const total = Number.isFinite(frame.fullLength) ? frame.fullLength : shown;
    const omitted = Math.max(total - shown, 0);
    frame.notice = `[truncated: ${shown} of ${total} characters shown; ${omitted} omitted]`;
  }

  return frame;
}

/**
 * Decide whether a write_file content is binary, mirroring the text-vs-binary
 * convention in src/persistence/tree-codec.js decodeTreeEntry: bytes are TEXT
 * iff re-encoding the utf8 string yields byte-identical bytes; otherwise they
 * are binary. A Buffer or Uint8Array is always treated as binary bytes; a
 * string is binary only when its bytes are not lossless utf8 (which, for a
 * JS string, cannot happen — a string is always valid utf8 — but a string
 * carrying lone surrogates is handled defensively).
 *
 * Returns null for text content, or { byteLength } for binary content.
 *
 * @param {*} content
 * @returns {{ byteLength: number }|null}
 */
function binaryContent(content) {
  // Buffer / Uint8Array: bytes given directly. These are binary unless the
  // bytes happen to be lossless utf8 text — but a write_file that hands raw
  // bytes is signalling a binary file, and rendering a text diff of arbitrary
  // bytes is exactly what corrupts. Treat any Buffer/Uint8Array as binary.
  if (Buffer.isBuffer(content)) {
    return { byteLength: content.length };
  }
  if (content instanceof Uint8Array) {
    return { byteLength: content.length };
  }

  if (typeof content === 'string') {
    // A JS string is always representable as utf8, so this is normally text.
    // Guard the pathological case (lone surrogates) the tree codec also guards:
    // if re-encoding is not byte-lossless, treat it as binary.
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.toString('utf8') === content) return null; // lossless utf8 => text
    return { byteLength: bytes.length };
  }

  // No content (or a non-string, non-bytes value): let toViewEvent handle it as
  // before — not our binary case.
  return null;
}

/**
 * The degraded file-change indicator for a binary write_file. Shaped like a
 * minimal `diff` payload so the Activity_Stream still surfaces the write as a
 * file modification, but it is explicitly flagged binary and carries NO line
 * model (there is no meaningful text diff of arbitrary bytes).
 *
 * @param {string} path
 * @param {number} byteLength
 * @returns {{ path: string, binary: true, byteLength: number, notice: string }}
 */
function binaryChangeIndicator(path, byteLength) {
  const bytes = Number.isFinite(byteLength) ? byteLength : 0;
  return {
    path: typeof path === 'string' ? path : '',
    binary: true,
    byteLength: bytes,
    notice: `binary file (${bytes} bytes)`,
  };
}
