/**
 * Integration tests for Task 11 — the Activity Stream (node --test), Req 4.1,
 * 4.2, 4.3, 4.5, 4.6.
 *
 * These exercise the Activity_Stream END TO END over the REAL Builder Server
 * SSE surface: a REAL plumby agent on the scripted provider (keyless, offline,
 * via test/support/scripted-agent.js) emits genuine core loop events
 * (text_delta, tool_call, tool_result, assistant_text) through the server's
 * session.onEvent, which maps them with createActivityStream().toFrame and
 * broadcasts the frames to an SSE client. The client parses the frames exactly
 * as a browser would (the same harness plumby's web tests and
 * builder-server.test.js use) and asserts:
 *
 *   (a) text_delta frames are STREAMED and arrive BEFORE the turn-completion
 *       frame (Req 4.1);
 *   (b) tool_call frames appear in OCCURRENCE ORDER for a scripted sequence that
 *       includes load_skill among read_file / bash / grep / glob / edit_file
 *       (Req 4.2, load_skill explicitly per the spec);
 *   (c) a file-modifying tool_call (edit_file / write_file) carries an inline
 *       DIFF in its frame (Req 4.3);
 *   (d) a turn-completion indicator frame (turn_done) is emitted at turn end
 *       (Req 4.5);
 *   (e) an over-cap tool_result (content longer than RESULT_PREVIEW_CHARS) is
 *       TRUNCATED with a truncated flag + fullLength (Req 4.6);
 *   (f) a BINARY write_file surfaces a 'binary file (N bytes)' indicator rather
 *       than a corrupting text line-diff (the FEAT-002 binary guard, end to end).
 *
 * Everything is hermetic: the AuthService uses a fake IdP to mint a REAL
 * session token, the agent runs on the scripted provider (no key, no network),
 * and each test allocates its own fs.mkdtemp project tree removed in a finally.
 * plumby is consumed ONLY through src/engine/plumby.js and the support helpers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';
import { createScriptedAgent } from './support/scripted-agent.js';
import {
  RESULT_PREVIEW_CHARS,
  defaultTools,
  spawnSubagentTool,
  loadSkillTool,
} from '../src/engine/plumby.js';

// ---------------------------------------------------------------- test harness

/** A fake IdP verifier: any idToken maps to a stable subject. */
function fakeIdp(subject = 'user-1') {
  return {
    async verifyIdToken(idToken) {
      if (!idToken) throw new Error('no token');
      return { provider: 'github', subject: `${subject}:${idToken}` };
    },
  };
}

/** Construct an AuthService and mint a real session token for one account. */
async function authWithToken(idToken = 'tok') {
  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { account } = await authService.authenticate({ idToken });
  const session = authService.scopeSession(account);
  return { authService, token: session.token };
}

/**
 * A Builder Server agentFactory that builds a REAL plumby agent on the scripted
 * provider. The server calls the factory with { cwd, onEvent, ... }; we forward
 * BOTH the given cwd and onEvent to createScriptedAgent so the genuine loop
 * emits its events through the server's session.onEvent (the ActivityStream
 * mapping). The scripted `turns` drive a deterministic event sequence.
 *
 * The server resolves a cwd from its SandboxManager/StorageLayout (or falls
 * back to process.cwd() when neither is injected). These hermetic tests instead
 * pin the agent to a caller-owned temp project tree so the real read/edit/write
 * tools act on known files — so we pass `projectCwd` explicitly and ignore the
 * server-provided cwd.
 *
 * @param {Array<object|Function>} turns  scripted turns
 * @param {string} projectCwd             the temp project tree the tools act on
 * @returns {Function} an agentFactory
 */
function scriptedAgentFactory(turns, projectCwd) {
  return ({ onEvent }) => createScriptedAgent({ turns, cwd: projectCwd, onEvent });
}

/** Start a server on an ephemeral port; returns base URL + close(). */
async function startServer(opts) {
  const server = createBuilderServer(opts);
  const { port, host } = await server.listen(0, '127.0.0.1');
  return { server, base: `http://${host}:${port}`, close: () => server.close() };
}

/** Open an SSE stream for a project. */
async function openEvents(base, projectId, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return fetch(`${base}/events?projectId=${encodeURIComponent(projectId)}`, { headers });
}

/**
 * Read decoded SSE frames from a Response body until `predicate(frames)` holds
 * or the deadline passes. Returns the parsed data frames IN ORDER (the order
 * they arrived on the wire), which is exactly what the ordering assertions
 * below depend on.
 */
async function readFramesUntil(res, predicate, { timeoutMs = 3000 } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), deadline - Date.now())),
    ]);
    if (chunk.timeout || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            frames.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore non-JSON keepalive */
          }
        }
      }
    }
    if (predicate(frames)) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  return frames;
}

/** Drive one turn: open SSE, POST the message, collect frames until turn_done. */
async function runTurn({ base, token, projectId, text = 'go' }) {
  const events = await openEvents(base, projectId, token);
  assert.equal(events.status, 200);
  const framesP = readFramesUntil(events, (f) => f.some((x) => x.type === 'turn_done'));

  const res = await fetch(`${base}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId, text }),
  });
  assert.equal(res.status, 202);

  return framesP;
}

/** Allocate a hermetic temp project directory; caller removes it. */
function freshProjectDir(prefix = 'aab-activity-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Index of the first frame satisfying pred, or -1. */
function indexOfFrame(frames, pred) {
  return frames.findIndex(pred);
}

// ----------------------------------------------------------------------- tests

test('text_delta frames are streamed and arrive BEFORE the turn-completion frame (Req 4.1)', async () => {
  const { authService, token } = await authWithToken();
  const cwd = freshProjectDir();
  // A single final text turn: the scripted provider streams the text as
  // text_delta chunks, then the loop ends -> the server broadcasts turn_done.
  const turns = [{ text: 'Here is the plan, streamed in pieces for the browser.' }];
  const { base, close } = await startServer({
    authService,
    agentFactory: scriptedAgentFactory(turns, cwd),
  });
  try {
    const frames = await runTurn({ base, token, projectId: 'proj-stream' });

    const firstDelta = indexOfFrame(frames, (f) => f.type === 'text_delta');
    const turnDone = indexOfFrame(frames, (f) => f.type === 'turn_done');
    assert.ok(firstDelta !== -1, 'at least one text_delta frame streamed');
    assert.ok(turnDone !== -1, 'a turn_done frame was emitted');
    assert.ok(firstDelta < turnDone, 'text_delta arrives BEFORE turn_done');

    // The concatenated deltas reconstruct the model's text (the streaming
    // contract), and it streamed as multiple chunks (more than one delta).
    const deltas = frames.filter((f) => f.type === 'text_delta');
    assert.ok(deltas.length > 1, 'text streamed as multiple chunks');
    const joined = deltas.map((d) => d.text).join('');
    assert.equal(joined, 'Here is the plan, streamed in pieces for the browser.');

    // turn_done reports success.
    assert.ok(frames.some((f) => f.type === 'turn_done' && f.ok === true), 'turn_done ok:true');
  } finally {
    await close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('tool_call frames appear in occurrence order including load_skill (Req 4.2)', async () => {
  const { authService, token } = await authWithToken();
  const cwd = freshProjectDir();

  // Seed the project tree so the read-only tools have something real to act on,
  // and register a real skill so load_skill succeeds against ctx.skills.
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
  const skillDir = path.join(cwd, '.plumby', 'skills', 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo\ndescription: a demo skill\n---\nDo the demo thing.\n',
    'utf8',
  );

  // A tool-call turn (which stops with tool_use so the loop runs the tools),
  // followed by a final text turn that ends the turn. The tools are ordered
  // read_file -> grep -> glob -> load_skill -> bash so we can assert order.
  const toolSequence = [
    { name: 'read_file', input: { path: 'notes.txt' } },
    { name: 'grep', input: { pattern: 'beta', path: '.' } },
    { name: 'glob', input: { pattern: '*.txt' } },
    { name: 'load_skill', input: { name: 'demo' } },
    { name: 'bash', input: { command: 'echo hello' } },
  ];
  const turns = [{ toolCalls: toolSequence }, { text: 'done' }];

  const { base, close } = await startServer({
    authService,
    // The default toolset must be present so read_file/grep/glob/bash resolve;
    // createScriptedAgent defaults to defaultTools + spawn_subagent, which
    // includes load_skill only if it is in defaultTools — pass tools explicitly
    // to guarantee load_skill is registered.
    agentFactory: ({ onEvent }) => makeAgentWithSkill({ cwd, onEvent, turns }),
  });
  try {
    const frames = await runTurn({ base, token, projectId: 'proj-tools' });

    const toolCalls = frames.filter((f) => f.type === 'tool_call').map((f) => f.name);
    // The Activity_Stream must present the tool calls in the SAME order the
    // agent made them.
    assert.deepEqual(
      toolCalls,
      ['read_file', 'grep', 'glob', 'load_skill', 'bash'],
      'tool_call frames stream in occurrence order, including load_skill',
    );

    // load_skill is explicitly present per the spec.
    assert.ok(toolCalls.includes('load_skill'), 'load_skill tool call surfaced');
  } finally {
    await close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a file-modifying tool_call carries an inline diff, and the turn completes (Req 4.3, 4.5)', async () => {
  const { authService, token } = await authWithToken();
  const cwd = freshProjectDir();

  // Seed a file so edit_file's exact-string match succeeds and the tool runs.
  fs.writeFileSync(path.join(cwd, 'app.js'), 'const port = 3000;\nstart(port);\n', 'utf8');

  const turns = [
    {
      toolCalls: [
        {
          name: 'edit_file',
          input: { path: 'app.js', old_string: 'const port = 3000;', new_string: 'const port = 8080;' },
        },
      ],
    },
    { text: 'edited' },
  ];

  const { base, close } = await startServer({
    authService,
    agentFactory: scriptedAgentFactory(turns, cwd),
  });
  try {
    const frames = await runTurn({ base, token, projectId: 'proj-edit' });

    const editFrame = frames.find((f) => f.type === 'tool_call' && f.name === 'edit_file');
    assert.ok(editFrame, 'edit_file tool_call frame streamed');
    // Req 4.3: the file change renders as an INLINE DIFF attached to the frame.
    assert.ok(editFrame.diff, 'edit_file frame carries a diff');
    assert.equal(editFrame.diff.path, 'app.js');
    assert.equal(editFrame.diff.tooLarge, false);
    // The diff is the focused old->new region: a removed line and an added line.
    const removed = editFrame.diff.lines.filter((l) => l.type === 'removed').map((l) => l.text);
    const added = editFrame.diff.lines.filter((l) => l.type === 'added').map((l) => l.text);
    assert.deepEqual(removed, ['const port = 3000;']);
    assert.deepEqual(added, ['const port = 8080;']);
    // It is NOT flagged binary (this is a text edit).
    assert.notEqual(editFrame.diff.binary, true);

    // Req 4.5: a turn-completion indicator is emitted at turn end.
    assert.ok(frames.some((f) => f.type === 'turn_done' && f.ok === true), 'turn_done at turn end');
  } finally {
    await close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('an over-cap tool_result is truncated with a truncated flag and fullLength (Req 4.6)', async () => {
  const { authService, token } = await authWithToken();
  const cwd = freshProjectDir();

  // Write a file whose contents exceed RESULT_PREVIEW_CHARS so read_file returns
  // an over-cap tool_result the ActivityStream must clip and flag.
  const overCap = 'x'.repeat(RESULT_PREVIEW_CHARS + 500);
  fs.writeFileSync(path.join(cwd, 'big.txt'), overCap, 'utf8');

  const turns = [
    { toolCalls: [{ name: 'read_file', input: { path: 'big.txt' } }] },
    { text: 'read it' },
  ];

  const { base, close } = await startServer({
    authService,
    agentFactory: scriptedAgentFactory(turns, cwd),
  });
  try {
    const frames = await runTurn({ base, token, projectId: 'proj-bigresult' });

    const result = frames.find((f) => f.type === 'tool_result' && f.name === 'read_file');
    assert.ok(result, 'read_file tool_result frame streamed');
    assert.equal(result.truncated, true, 'over-cap result is flagged truncated');
    assert.equal(result.content.length, RESULT_PREVIEW_CHARS, 'preview clipped to the cap');
    assert.ok(
      result.fullLength > RESULT_PREVIEW_CHARS,
      'fullLength reports the true size beyond the cap',
    );
  } finally {
    await close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a binary write_file degrades to a "binary file (N bytes)" indicator, not a text diff (FEAT-002 guard)', async () => {
  const { authService, token } = await authWithToken();
  const cwd = freshProjectDir();

  // Binary content: raw bytes that are NOT valid utf8 (a PNG-ish header with a
  // NUL and high bytes). The ActivityStream must detect this BEFORE plumby's
  // diff stringifies it and degrade gracefully.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);

  const turns = [
    { toolCalls: [{ name: 'write_file', input: { path: 'logo.png', content: bytes } }] },
    { text: 'wrote binary' },
  ];

  const { base, close } = await startServer({
    authService,
    agentFactory: scriptedAgentFactory(turns, cwd),
  });
  try {
    const frames = await runTurn({ base, token, projectId: 'proj-binary' });

    const writeFrame = frames.find((f) => f.type === 'tool_call' && f.name === 'write_file');
    assert.ok(writeFrame, 'write_file tool_call frame streamed');
    assert.ok(writeFrame.diff, 'binary write_file frame still surfaces a file-change indicator');
    // The degraded indicator: binary flag, byteLength, and the exact notice.
    assert.equal(writeFrame.diff.binary, true, 'flagged binary');
    assert.equal(writeFrame.diff.path, 'logo.png');
    assert.equal(writeFrame.diff.byteLength, bytes.length, 'byteLength is the true byte count');
    assert.equal(writeFrame.diff.notice, `binary file (${bytes.length} bytes)`, 'exact notice');
    // It must NOT carry a text line-diff (no line model for arbitrary bytes).
    assert.equal(writeFrame.diff.lines, undefined, 'no misleading text line-diff for binary content');
  } finally {
    await close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- local helpers

/**
 * Build a scripted plumby agent whose toolset EXPLICITLY includes load_skill
 * (alongside the default tools + spawn_subagent) and whose known skills include
 * a `demo` skill loaded from the project tree, so a scripted `load_skill` call
 * resolves. Mirrors the scripted-agent helper but with an explicit tool list
 * and skills wired, since the ordering test needs load_skill registered.
 */
function makeAgentWithSkill({ cwd, onEvent, turns }) {
  // load_skill is NOT in plumby's defaultTools (it is advertised only when a
  // skill exists), so register it explicitly here alongside the default tools +
  // spawn_subagent. That guarantees the ordering test's load_skill call is a
  // real, registered tool in occurrence order — per the spec's explicit ask.
  return createScriptedAgent({
    turns,
    cwd,
    onEvent,
    tools: [...defaultTools, spawnSubagentTool, loadSkillTool],
  });
}
