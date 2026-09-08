/**
 * Unit test for the file/tool panel surface (node --test) — platform Req 27.2,
 * 27.8; web-ui Req 3.4.
 *
 * The file/tool panel is one of the five builder surfaces a Workspace_Experience
 * arranges (Req 27.2) and the sidebar of the Technical Workbench (Req 27.8). It
 * has NO backend route of its own: it derives everything from the REAL
 * Activity_Stream frames the client already receives. These tests drive the REAL
 * frame dispatcher (frames.js) into the REAL store with REAL tool_call/tool_result
 * frame shapes and assert:
 *
 *   - the touched-file list is derived from the diff frames' actual `path`s, with
 *     edit counts and +/- line counts computed from the REAL markers;
 *   - tool activity is listed from the tool frames;
 *   - with NO activity the panel reports an EXPLICIT empty state and invents no
 *     file listing;
 *   - selecting a file shows that file's LATEST change with its persistent
 *     markers (Req 3.4), and selection is local (it dispatches nothing).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, ACTIONS } from '../src/server/public/store.js';
import { createFrameDispatcher } from '../src/server/public/frames.js';
import {
  filePanelViewModel,
  createFilePanelView,
  FILE_PANEL_MESSAGES,
  FILE_PANEL_DOM,
} from '../src/server/public/views/file-panel.js';

// ------------------------------------------------------------- tiny DOM shim
function makeDom() {
  function makeEl(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      _listeners: {},
      className: '',
      id: '',
      textContent: '',
      hidden: false,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      append(...kids) { for (const kid of kids) { this.children.push(kid); if (kid) kid._parent = this; } },
      replaceChildren(...kids) { this.children = kids; for (const k of kids) if (k) k._parent = this; },
      addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); },
      removeEventListener() {},
      remove() {},
      click() { for (const cb of this._listeners.click || []) cb({ type: 'click' }); },
    };
  }
  return { createElement: (t) => makeEl(t), createTextNode: (t) => ({ text: String(t) }) };
}
function byId(root, id) {
  if (root && root.id === id) return root;
  for (const kid of (root && root.children) || []) {
    const found = byId(kid, id);
    if (found) return found;
  }
  return null;
}
function collect(root, pred, acc = []) {
  if (root && pred(root)) acc.push(root);
  for (const kid of (root && root.children) || []) collect(kid, pred, acc);
  return acc;
}
function textOf(node) {
  if (!node) return '';
  let out = node.textContent || '';
  for (const kid of node.children || []) out += textOf(kid);
  return out;
}

/** A REAL tool_call diff frame (plumby's line model, as frames.js expects). */
function diffFrame(path, lines, extra = {}) {
  return {
    type: 'tool_call',
    name: 'write_file',
    summary: `write ${path}`,
    diff: { path, lines, ...extra },
  };
}

/** Feed frames through the REAL dispatcher so the store holds REAL items. */
function seed(frames) {
  const store = createStore();
  store.dispatch({ type: ACTIONS.SESSION_OPEN, projectId: 'proj-files' });
  const dispatcher = createFrameDispatcher({ store });
  for (const frame of frames) dispatcher.dispatch(frame);
  return store;
}

// ------------------------------------------------------------- empty state

test('with no activity the file panel shows an EXPLICIT empty state and invents no files', () => {
  const store = seed([]);
  const vm = filePanelViewModel(store.getState());

  assert.deepEqual(vm.files, [], 'no files are invented');
  assert.deepEqual(vm.tools, [], 'no tool activity is invented');
  assert.equal(vm.empty, true);
  assert.equal(vm.emptyMessage, FILE_PANEL_MESSAGES.empty);
  assert.match(vm.emptyMessage, /No files yet/, 'the empty state says so honestly');
  assert.equal(vm.selected, null);

  const doc = makeDom();
  const view = createFilePanelView({ doc, store });
  const empty = byId(view.el, FILE_PANEL_DOM.empty);
  assert.equal(empty.hidden, false, 'the empty state is rendered');
  assert.equal(empty.textContent, FILE_PANEL_MESSAGES.empty);
  assert.equal(byId(view.el, FILE_PANEL_DOM.files).children.length, 0, 'no file rows');
});

// ------------------------------------------------- derived from real frames

test('the touched-file list is derived from the REAL diff frames (paths, edits, +/- counts)', () => {
  const store = seed([
    diffFrame('src/app.js', [
      { type: 'added', text: 'const a = 1;' },
      { type: 'unchanged', text: 'export default a;' },
    ]),
    { type: 'tool_result', content: 'ran 12 tests', truncated: false },
    diffFrame('src/app.js', [
      { type: 'added', text: 'const b = 2;' },
      { type: 'removed', text: 'const a = 1;' },
    ]),
    diffFrame('README.md', [{ type: 'added', text: '# Title' }], { newFile: true }),
  ]);

  const vm = filePanelViewModel(store.getState());

  assert.deepEqual(
    vm.files.map((f) => f.path).sort(),
    ['README.md', 'src/app.js'],
    'exactly the paths the diff frames named',
  );
  // Most recently touched first.
  assert.equal(vm.files[0].path, 'README.md', 'most recently touched leads the list');

  const app = vm.files.find((f) => f.path === 'src/app.js');
  assert.equal(app.edits, 2, 'both edits to the same path are counted once as one file');
  assert.equal(app.added, 2, 'added lines counted from the real + markers');
  assert.equal(app.removed, 1, 'removed lines counted from the real - markers');
  assert.equal(app.newFile, false);

  const readme = vm.files.find((f) => f.path === 'README.md');
  assert.equal(readme.newFile, true, 'a new file is reported as new');

  // The tool section reflects the real tool frames (the write_file calls carry a
  // diff, so they are files; the tool_result is tool activity).
  assert.ok(
    vm.tools.some((t) => t.label === 'ran 12 tests'),
    'tool output appears in the tool section',
  );
  assert.equal(vm.empty, false);

  // Rendered: one row per file, with the honest counts.
  const doc = makeDom();
  const view = createFilePanelView({ doc, store });
  const rows = collect(view.el, (n) => n.getAttribute && n.getAttribute('data-path') && n.tagName === 'LI');
  assert.equal(rows.length, 2, 'one row per touched file');
  assert.equal(byId(view.el, FILE_PANEL_DOM.empty).hidden, true, 'no empty state when files exist');
  const appRow = rows.find((r) => r.getAttribute('data-path') === 'src/app.js');
  assert.match(textOf(appRow), /2 edits/, 'the row shows the real edit count');
  assert.match(textOf(appRow), /\+2/, 'and the real added-line count');
  assert.match(textOf(appRow), /-1/, 'and the real removed-line count');
});

test('a binary diff frame is reported as binary, not as fabricated lines', () => {
  const store = seed([
    {
      type: 'tool_call',
      name: 'write_file',
      summary: 'write logo.png',
      diff: { path: 'assets/logo.png', binary: true, notice: 'binary file not shown' },
    },
  ]);
  const vm = filePanelViewModel(store.getState(), 'assets/logo.png');
  assert.equal(vm.files[0].binary, true);
  assert.equal(vm.files[0].added, 0);
  assert.deepEqual(vm.selected.lines, [], 'no lines are invented for a binary change');
  assert.equal(vm.selected.notice, 'binary file not shown');
});

// ------------------------------------------------------ selection behaviour

test('selecting a file shows its LATEST change with persistent +/- markers, and dispatches nothing', () => {
  const store = seed([
    diffFrame('src/app.js', [{ type: 'added', text: 'first' }]),
    diffFrame('src/app.js', [
      { type: 'removed', text: 'first' },
      { type: 'added', text: 'second' },
    ]),
  ]);

  const vm = filePanelViewModel(store.getState(), 'src/app.js');
  assert.equal(vm.selected.path, 'src/app.js');
  assert.deepEqual(
    vm.selected.lines.map((l) => l.line),
    ['-first', '+second'],
    'the latest diff, each line carrying its persistent marker (Req 3.4)',
  );

  // An unknown path selects nothing rather than inventing a view.
  assert.equal(filePanelViewModel(store.getState(), 'nope.js').selected, null);

  // Through the view: clicking a file row selects it WITHOUT any dispatch.
  const doc = makeDom();
  const view = createFilePanelView({ doc, store });
  const before = store.getState();
  const button = collect(
    view.el,
    (n) => n.tagName === 'BUTTON' && n.getAttribute('data-path') === 'src/app.js',
  )[0];
  assert.ok(button, 'the file row is a real control');
  button.click();

  assert.strictEqual(store.getState(), before, 'selection is local view state — no dispatch at all');
  const detail = byId(view.el, FILE_PANEL_DOM.detail);
  assert.match(textOf(detail), /src\/app\.js/, 'the selected file is shown');
  assert.match(textOf(detail), /\+second/, 'with its marker-prefixed latest change');
});
