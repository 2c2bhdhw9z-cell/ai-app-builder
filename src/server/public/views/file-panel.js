/*
 * views/file-panel.js — the file/tool panel surface (Req 27.2, 27.8; design
 *  §"Views", Req 3.4).
 *
 * Req 27.2 names "file and tool panels" as one of the builder surfaces a
 * Workspace_Experience arranges, and Req 27.8 puts that panel ALONGSIDE the
 * editor in the Technical Workbench. This module is that surface.
 *
 * HONEST DATA SOURCE — no invented backend route, no fake files. Everything this
 * panel shows is derived from what the client ALREADY knows: the store's
 * Activity_Stream slice (`session.activity`), whose normalized items are the
 * frames the Builder_Server broadcast (frames.js `normalizeActivityItem`):
 *
 *   - FILES: every item of kind 'diff' carries `diff.path` — the real path the
 *     agent touched — plus its marker-bearing hunks. The panel lists those paths
 *     (deduplicated, most-recently-touched first) with the number of edits and
 *     the added/removed line counts computed from the REAL markers.
 *   - TOOLS: every item of kind 'tool' carries the tool `name`/`summary` the
 *     server broadcast; those are listed as the tool-activity section.
 *   - SELECTED FILE: the most recent diff for the selected path, rendered with
 *     its persistent `+`/`-`/` ` markers (Req 3.4) — the same marker data the
 *     Activity_Stream renders, not a re-derived guess.
 *
 * If the client has seen NO diff/tool activity yet, the panel says so
 * EXPLICITLY (an empty state) rather than inventing a file tree: the client
 * genuinely does not know the project's files until the agent reports touching
 * them. Nothing here fabricates a listing.
 *
 * Selection is LOCAL view state (never a store dispatch), so operating the panel
 * cannot touch the Theme, Work_Mode, Project data, or any other slice.
 *
 * CSP hygiene (Req 1.4): DOM API only — NO innerHTML, NO inline handlers, NO
 * inline <style>; colors come from the palette-driven `--color-*` properties.
 * The pure projection (`filePanelViewModel`) is exported for DOM-free testing.
 */

import { selectActivity } from '../store.js';
import { renderDiffText } from './activity-stream.js';

/** Stable DOM ids/classes so the surface is greppable and styleable. */
export const FILE_PANEL_DOM = Object.freeze({
  rootClass: 'file-panel',
  files: 'file-panel-files',
  tools: 'file-panel-tools',
  empty: 'file-panel-empty',
  detail: 'file-panel-detail',
  fileClass: 'file-panel__file',
  toolClass: 'file-panel__tool',
});

/** Client-authored, honest copy. No path/secret is invented or guessed. */
export const FILE_PANEL_MESSAGES = Object.freeze({
  filesHeading: 'Files touched this session',
  toolsHeading: 'Tool activity',
  // The honest empty state: the client has not been told about any file yet.
  empty: 'No files yet. Files appear here as the agent edits them in this session.',
  noTools: 'No tool activity yet.',
  noSelection: 'Select a file to see its latest change.',
});

/**
 * Pure projection over the store's activity slice.
 *
 * @param {object} state           the store state
 * @param {string|null} [selectedPath]  the locally selected path, if any
 * @returns {{
 *   files: Array<{ path: string, edits: number, added: number, removed: number,
 *                  lastSeq: number, newFile: boolean, binary: boolean }>,
 *   tools: Array<{ seq: number, label: string }>,
 *   empty: boolean,
 *   emptyMessage: string,
 *   selected: { path: string, lines: Array<{ marker: string, text: string, line: string }>,
 *               binary: boolean, notice: (string|null) }|null,
 * }}
 */
export function filePanelViewModel(state, selectedPath = null) {
  const items = Array.isArray(selectActivity(state)) ? selectActivity(state) : [];

  /** @type {Map<string, any>} */
  const byPath = new Map();
  /** @type {Map<string, object>} */
  const latestDiff = new Map();
  const tools = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const seq = typeof item.seq === 'number' ? item.seq : 0;

    if (item.kind === 'diff' && item.diff && typeof item.diff.path === 'string' && item.diff.path !== '') {
      const path = item.diff.path;
      const hunks = Array.isArray(item.diff.hunks) ? item.diff.hunks : [];
      let added = 0;
      let removed = 0;
      for (const hunk of hunks) {
        if (hunk && hunk.marker === '+') added += 1;
        else if (hunk && hunk.marker === '-') removed += 1;
      }
      const entry = byPath.get(path) || {
        path,
        edits: 0,
        added: 0,
        removed: 0,
        lastSeq: seq,
        newFile: false,
        binary: false,
      };
      entry.edits += 1;
      entry.added += added;
      entry.removed += removed;
      entry.lastSeq = Math.max(entry.lastSeq, seq);
      entry.newFile = entry.newFile || item.diff.newFile === true;
      entry.binary = entry.binary || item.diff.binary === true;
      byPath.set(path, entry);
      // Keep the LATEST diff per path for the selected-file view.
      const prior = latestDiff.get(path);
      if (!prior || seq >= (typeof prior.seq === 'number' ? prior.seq : 0)) {
        latestDiff.set(path, { seq, diff: item.diff });
      }
      continue;
    }

    if (item.kind === 'tool') {
      const label =
        (typeof item.summary === 'string' && item.summary !== '' && item.summary) ||
        (typeof item.name === 'string' && item.name !== '' && item.name) ||
        (typeof item.content === 'string' && item.content !== '' && item.content) ||
        '';
      if (label !== '') tools.push({ seq, label });
    }
  }

  // Most recently touched first — the ordering a developer expects in a file
  // panel that reflects a live session.
  const files = [...byPath.values()].sort((a, b) => b.lastSeq - a.lastSeq || a.path.localeCompare(b.path));

  let selected = null;
  const wanted =
    typeof selectedPath === 'string' && latestDiff.has(selectedPath)
      ? selectedPath
      : null;
  if (wanted) {
    const { diff } = latestDiff.get(wanted);
    selected = {
      path: wanted,
      binary: diff.binary === true,
      notice:
        (typeof diff.notice === 'string' && diff.notice !== '' && diff.notice) ||
        (diff.truncated === true && typeof diff.truncationNotice === 'string' ? diff.truncationNotice : null) ||
        (diff.tooLarge === true && typeof diff.tooLargeNotice === 'string' ? diff.tooLargeNotice : null) ||
        null,
      lines: diff.binary === true ? [] : renderDiffText(diff),
    };
  }

  return {
    files,
    tools,
    empty: files.length === 0 && tools.length === 0,
    emptyMessage: FILE_PANEL_MESSAGES.empty,
    selected,
  };
}

/**
 * Create and mount the file/tool panel surface.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {{ getState: Function, subscribe: Function }} opts.store
 * @returns {{ el: HTMLElement, render: () => void, destroy: () => void, select: (p: string|null) => void }}
 */
export function createFilePanelView({ doc, store }) {
  const root = doc.createElement('section');
  root.className = FILE_PANEL_DOM.rootClass;
  root.setAttribute('aria-label', 'Files and tools');

  const filesHeading = doc.createElement('h2');
  filesHeading.className = 'file-panel__heading';
  filesHeading.textContent = FILE_PANEL_MESSAGES.filesHeading;

  const empty = doc.createElement('p');
  empty.id = FILE_PANEL_DOM.empty;
  empty.className = 'file-panel__empty';
  empty.setAttribute('role', 'status');
  empty.hidden = true;

  const files = doc.createElement('ul');
  files.id = FILE_PANEL_DOM.files;
  files.className = 'file-panel__list';

  const detail = doc.createElement('div');
  detail.id = FILE_PANEL_DOM.detail;
  detail.className = 'file-panel__detail';

  const toolsHeading = doc.createElement('h2');
  toolsHeading.className = 'file-panel__heading';
  toolsHeading.textContent = FILE_PANEL_MESSAGES.toolsHeading;

  const tools = doc.createElement('ul');
  tools.id = FILE_PANEL_DOM.tools;
  tools.className = 'file-panel__list';

  root.append(filesHeading, empty, files, detail, toolsHeading, tools);

  /** LOCAL selection state — never a store dispatch. */
  let selectedPath = null;

  function select(path) {
    selectedPath = typeof path === 'string' && path !== '' ? path : null;
    render();
  }

  /** Build one file row: a touch-sized selector plus the real edit counts. */
  function buildFile(file) {
    const li = doc.createElement('li');
    li.className = FILE_PANEL_DOM.fileClass;
    li.setAttribute('data-path', file.path);

    const button = doc.createElement('button');
    button.className = 'file-panel__file-button';
    button.setAttribute('type', 'button');
    button.setAttribute('data-path', file.path);
    button.setAttribute('aria-pressed', selectedPath === file.path ? 'true' : 'false');
    button.textContent = file.path;
    button.addEventListener('click', () => select(file.path));

    const meta = doc.createElement('span');
    meta.className = 'file-panel__file-meta';
    const parts = [`${file.edits} ${file.edits === 1 ? 'edit' : 'edits'}`];
    if (file.binary) parts.push('binary');
    else parts.push(`+${file.added}`, `-${file.removed}`);
    if (file.newFile) parts.push('new');
    meta.textContent = parts.join(' \u00b7 ');

    li.append(button, meta);
    return li;
  }

  /** Apply the pure view-model to the DOM. Idempotent full re-render. */
  function render() {
    const vm = filePanelViewModel(store.getState(), selectedPath);

    // The honest empty state — shown instead of any invented listing.
    empty.textContent = vm.empty ? vm.emptyMessage : '';
    empty.hidden = !vm.empty;

    files.replaceChildren();
    for (const file of vm.files) files.append(buildFile(file));
    files.hidden = vm.files.length === 0;

    detail.replaceChildren();
    if (vm.selected) {
      const path = doc.createElement('p');
      path.className = 'file-panel__detail-path';
      path.textContent = vm.selected.path;
      detail.append(path);
      if (vm.selected.notice) {
        const notice = doc.createElement('p');
        notice.className = 'file-panel__detail-notice';
        notice.textContent = vm.selected.notice;
        detail.append(notice);
      }
      if (!vm.selected.binary) {
        const pre = doc.createElement('pre');
        pre.className = 'file-panel__diff';
        for (const { marker, text } of vm.selected.lines) {
          const line = doc.createElement('span');
          line.className = 'file-panel__diff-line';
          line.setAttribute('data-marker', marker);
          const markerEl = doc.createElement('span');
          markerEl.className = 'file-panel__diff-marker';
          markerEl.textContent = marker;
          const textEl = doc.createElement('span');
          textEl.className = 'file-panel__diff-text';
          textEl.textContent = text;
          line.append(markerEl, textEl);
          pre.append(line, doc.createTextNode('\n'));
        }
        detail.append(pre);
      }
    } else if (vm.files.length > 0) {
      const hint = doc.createElement('p');
      hint.className = 'file-panel__detail-hint';
      hint.textContent = FILE_PANEL_MESSAGES.noSelection;
      detail.append(hint);
    }

    tools.replaceChildren();
    if (vm.tools.length === 0) {
      const none = doc.createElement('li');
      none.className = FILE_PANEL_DOM.toolClass;
      none.textContent = FILE_PANEL_MESSAGES.noTools;
      tools.append(none);
    } else {
      for (const tool of vm.tools) {
        const li = doc.createElement('li');
        li.className = FILE_PANEL_DOM.toolClass;
        li.setAttribute('data-seq', String(tool.seq));
        li.textContent = tool.label;
        tools.append(li);
      }
    }
  }

  const unsub = store.subscribe((s) => s.session.activity, render);
  render();

  function destroy() {
    unsub();
    root.remove();
  }

  return { el: root, render, destroy, select };
}
