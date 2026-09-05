/**
 * Observability tests (node --test), spec Task 12.6/12.7*, Req 25.2, 25.3, 24.4.
 *
 * Covers:
 *   (a) reportError returns a correlationId + a GENERIC userMessage, and records
 *       a correlated operational log entry with the SAME correlationId;
 *   (b) the recorded `cause` is redacted of any secret value (and the userMessage
 *       carries the correlationId but NO secret/internal detail);
 *   (c) operational metrics/events are emitted for the four failure-prone
 *       subsystems (sandbox provisioning, generation turns, builds, deployments),
 *       routed through the redactor;
 *   (d) a Builder-Server turn error surfaces a user-facing `error` frame on the
 *       SSE stream carrying the correlationId (and correlated to the log entry).
 *
 * Mutation guard: with the central redactor neutered to a no-op passthrough, the
 * 'no plaintext secret in the recorded error entry' assertion FAILS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createObservability,
  createAuditLog,
  createRedactor,
  OPERATIONAL_SUBSYSTEMS,
} from '../src/ops/index.js';
import { AUDIT_EVENTS } from '../src/auth/audit.js';
import { createBuilderServer } from '../src/server/index.js';
import { createAuthService } from '../src/auth/index.js';

const SECRET = 'sk-live-77aa33bb99cc00dd';

// ---------------------------------------------------------- reportError

test('reportError returns { correlationId, userMessage } and records a correlated entry', () => {
  const redactor = createRedactor({ secretValues: [SECRET] });
  const log = createAuditLog({ redactor, now: () => 5 });
  const obs = createObservability({ auditLog: log, redactor, now: () => 5 });

  const { correlationId, userMessage } = obs.reportError(
    { id: 'acct-1' },
    'generation.turn',
    new Error(`upstream failed with token ${SECRET}`),
  );

  assert.ok(typeof correlationId === 'string' && correlationId.length > 0);
  assert.equal(typeof userMessage, 'string');
  // The user-facing message carries the correlationId so it correlates to the log.
  assert.ok(userMessage.includes(correlationId), 'userMessage carries the correlationId');
  // ...and NOTHING about the cause / secret.
  assert.ok(!userMessage.includes(SECRET), 'no secret in the user-facing message');
  assert.ok(!userMessage.includes('upstream failed'), 'no internal cause detail in the message');

  const errors = log.ofType(AUDIT_EVENTS.OPERATIONAL_ERROR);
  assert.equal(errors.length, 1);
  const [entry] = errors;
  // CORRELATION: the returned id matches the recorded entry's id.
  assert.equal(entry.correlationId, correlationId, 'the recorded entry uses the same correlationId');
  assert.equal(entry.accountId, 'acct-1');
  assert.equal(entry.op, 'generation.turn');
  // The recorded cause is redacted of the secret value.
  assert.ok(!JSON.stringify(entry).includes(SECRET), 'no plaintext secret in the recorded error entry');
});

test('reportError shapes non-Error causes and tolerates a null account', () => {
  const redactor = createRedactor({});
  const log = createAuditLog({ redactor, now: () => 1 });
  const obs = createObservability({ auditLog: log, redactor, now: () => 1 });

  const r1 = obs.reportError('acct-str', 'build', 'plain string cause');
  const r2 = obs.reportError(null, 'deployment', { code: 'E_DEPLOY' });

  const errors = log.ofType(AUDIT_EVENTS.OPERATIONAL_ERROR);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].accountId, 'acct-str');
  assert.equal(errors[0].cause, 'plain string cause');
  assert.equal(errors[1].accountId, null, 'a pre-auth failure records accountId=null');
  assert.deepEqual(errors[1].cause, { code: 'E_DEPLOY' });
  assert.ok(r1.correlationId !== r2.correlationId, 'each error gets its own id');
});

test('MUTATION GUARD: a no-op redactor lets a plaintext secret survive in the error entry', () => {
  const noopRedactor = { redact: (x) => x };
  const log = createAuditLog({ redactor: noopRedactor, now: () => 1 });
  const obs = createObservability({ auditLog: log, redactor: noopRedactor, now: () => 1 });
  obs.reportError({ id: 'a' }, 'build', new Error(`boom ${SECRET}`));
  const [entry] = log.ofType(AUDIT_EVENTS.OPERATIONAL_ERROR);
  assert.ok(
    JSON.stringify(entry).includes(SECRET),
    'with a no-op redactor the plaintext secret survives (the guarded assertion would flip)',
  );
});

// ---------------------------------------------------------- metrics / events

test('emitMetric + emitOperationalEvent cover the four subsystems and route through the redactor', () => {
  const redactor = createRedactor({ secretValues: [SECRET] });
  const log = createAuditLog({ redactor, now: () => 3 });
  const metrics = [];
  const obs = createObservability({
    auditLog: log,
    redactor,
    now: () => 3,
    metricsSink: (m) => metrics.push(m),
  });

  // The four failure-prone subsystems are named in the export.
  assert.deepEqual(
    [...OPERATIONAL_SUBSYSTEMS].sort(),
    ['build', 'deployment', 'generation_turn', 'sandbox_provisioning'].sort(),
  );

  for (const subsystem of OPERATIONAL_SUBSYSTEMS) {
    obs.emitMetric(`${subsystem}.latency_ms`, { subsystem, value: 42, note: `ok ${SECRET}` });
    obs.emitOperationalEvent({ type: 'operational.event', subsystem, outcome: 'ok' });
  }

  assert.equal(metrics.length, OPERATIONAL_SUBSYSTEMS.length, 'one metric per subsystem');
  for (const m of metrics) {
    assert.ok(!JSON.stringify(m).includes(SECRET), 'metric fields are redacted');
  }
  const opEvents = log.ofType('operational.event');
  assert.equal(opEvents.length, OPERATIONAL_SUBSYSTEMS.length, 'one op event per subsystem');

  assert.throws(() => obs.emitMetric('', {}), TypeError, 'a metric needs a name');
});

test('createObservability requires a redactor', () => {
  assert.throws(() => createObservability({}), TypeError);
});

// -------------------------------------------- Builder Server error frame

/** A fake IdP verifier mapping any idToken to a stable subject. */
function fakeIdp(subject = 'user-1') {
  return {
    async verifyIdToken(idToken) {
      if (!idToken) throw new Error('no token');
      return { provider: 'github', subject: `${subject}:${idToken}` };
    },
  };
}

/** Read SSE frames from a Response body until predicate is satisfied. */
async function readFramesUntil(res, predicate, { timeoutMs = 2000 } = {}) {
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
            /* ignore keepalive */
          }
        }
      }
    }
    if (predicate(frames)) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return frames;
}

test('a platform-level turn error surfaces a user-facing error frame carrying the correlationId', async () => {
  const redactor = createRedactor({ secretValues: [SECRET] });
  const log = createAuditLog({ redactor, now: () => 1 });
  const observability = createObservability({ auditLog: log, redactor, now: () => 1 });

  const authService = createAuthService({ idpVerifier: fakeIdp() });
  const { account } = await authService.authenticate({ idToken: 'tok' });
  const session = authService.scopeSession(account);
  const token = session.token;

  // A fake agent whose turn throws a platform-level error carrying a secret.
  const agentFactory = ({ onEvent }) => ({
    agent: {
      async send() {
        onEvent({ type: 'assistant_text', text: 'working', streamed: false });
        throw new Error(`sandbox provisioning failed with token ${SECRET}`);
      },
    },
  });

  const server = createBuilderServer({ authService, agentFactory, observability });
  const { port, host } = await server.listen(0, '127.0.0.1');
  const base = `http://${host}:${port}`;
  const projectId = 'proj-err';

  try {
    // Open the SSE stream first so the error frame is captured.
    const evRes = await fetch(`${base}/events?projectId=${projectId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const framesPromise = readFramesUntil(evRes, (f) => f.some((x) => x.type === 'turn_done' && x.ok === false));

    // Kick off a turn that will fail.
    const msgRes = await fetch(`${base}/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, text: 'go' }),
    });
    assert.equal(msgRes.status, 202);

    const frames = await framesPromise;
    const errorFrame = frames.find((f) => f.type === 'error');
    assert.ok(errorFrame, 'an error frame is broadcast');
    assert.ok(typeof errorFrame.correlationId === 'string' && errorFrame.correlationId.length > 0);
    assert.ok(errorFrame.message.includes(errorFrame.correlationId), 'user message carries the correlationId');
    assert.ok(!JSON.stringify(errorFrame).includes(SECRET), 'no raw secret in the SSE error frame');

    // The frame's correlationId matches the recorded operational entry.
    const [entry] = log.ofType(AUDIT_EVENTS.OPERATIONAL_ERROR);
    assert.ok(entry, 'an operational error entry was recorded');
    assert.equal(entry.correlationId, errorFrame.correlationId, 'SSE frame correlates to the log entry');
    assert.equal(entry.accountId, account.id);
    assert.ok(!JSON.stringify(entry).includes(SECRET), 'no plaintext secret in the recorded entry');
  } finally {
    await server.close();
  }
});
