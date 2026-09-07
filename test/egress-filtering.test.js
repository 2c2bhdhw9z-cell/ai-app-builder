/**
 * Registry-only egress filtering tests (node --test).
 *
 * THE BEHAVIOR UNDER TEST. `AAB_SANDBOX_EGRESS` had only two settings and neither
 * allowed a dependency install: `none` gave `--network none` (commands run, no
 * network, so `npm install` cannot work) and `registry` produced the
 * NETWORK_FILTERED sentinel, which the plain CLI backend refuses — denying EVERY
 * command in every sandbox. This adds the filtering-capable path: an `--internal`
 * docker network with no route out, plus one allowlisting proxy that is the only
 * way out, so a sandbox can reach the package registry and nothing else.
 *
 * WHAT IS PROVEN, AND HOW HONESTLY:
 *
 *  (a) REAL, no fake in the loop: the proxy program is SPAWNED AS A REAL NODE
 *      PROCESS and driven with REAL HTTP requests and a REAL CONNECT tunnel against
 *      a REAL upstream server, so every allow/deny decision is measured. The
 *      allowlist sanitizer is a pure function tested directly.
 *  (b) REAL backend, fake CLI: the argv and the ordering of the setup are produced
 *      by the REAL filtering backend delegating to the REAL base backend, with only
 *      `exec` faked — the same seam every other sandbox test injects.
 *  (c) REAL SandboxManager: the headline test drives the real manager end to end and
 *      asserts a connector-bearing project's command now RUNS on the enforced
 *      network instead of being denied.
 *
 * WHAT ONLY A REAL CONTAINER HOST CAN PROVE: that `--internal` truly severs the
 * route, that the runtime's embedded DNS resolves the proxy's container name on an
 * internal network, and that a real `npm install` completes through the proxy while
 * an off-allowlist host stays unreachable. No test here claims a container ran.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

import {
  createFilteringContainerBackend,
  DEFAULT_EGRESS_NETWORK_PREFIX,
  DEFAULT_PROXY_CONTAINER,
} from '../src/sandbox/filtering-container-backend.js';
import {
  EGRESS_PROXY_SRC,
  proxyEnvFor,
  proxyContainerEnv,
  sanitizeProxyAllowlist,
  allowlistFingerprint,
  ALLOWLIST_LABEL,
  DEFAULT_PROXY_PORT,
  ALLOWED_CONNECT_PORTS,
} from '../src/sandbox/egress-proxy.js';
import {
  createContainerBackend,
  NETWORK_DENY_ALL,
  NETWORK_FILTERED,
} from '../src/sandbox/container-backend.js';
import { createSandboxManager } from '../src/sandbox/sandbox-manager.js';
import { createStorageLayout } from '../src/storage/layout.js';
import { createConnectorBinding } from '../src/model/connector.js';

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// --------------------------------------------------------------------- helpers

/** Ask the OS for a free TCP port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * A scripted CLI fake recording every argv. Defaults describe a healthy host with
 * no pre-existing proxy; individual tests override single verbs.
 */
function cliFake({ overrides = {} } = {}) {
  const calls = [];
  const envs = [];
  /**
   * A tiny STATEFUL model of the runtime: a detached `run -d --name X` makes X
   * inspectable as running (with the labels it was given), and `rm` removes it.
   * A stateless fake reported the proxy as absent immediately after starting it,
   * which made every second exec look like a dead-proxy rebuild — the fake has to
   * model this much to test adoption and revalidation at all.
   */
  const containers = new Map();
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, signal: null });
  const err = (stderr) => ({ code: 1, stdout: '', stderr, timedOut: false, signal: null });

  const exec = async (bin, args, opts) => {
    calls.push(args);
    envs.push(opts?.childEnv);
    const verb = args[0] === 'network' ? `network ${args[1]}` : args[0];
    if (overrides[verb]) return overrides[verb](args, opts, containers);

    if (verb === 'run' && args.includes('-d')) {
      const name = args[args.indexOf('--name') + 1];
      const labels = {};
      for (let i = 0; i < args.length - 1; i += 1) {
        if (args[i] === '--label') {
          const [k, ...v] = args[i + 1].split('=');
          labels[k] = v.join('=');
        }
      }
      containers.set(name, { running: true, exitCode: 0, labels });
      return ok(`cid-${name}\n`);
    }
    if (verb === 'rm') {
      containers.delete(args.at(-1));
      return ok();
    }
    if (verb === 'inspect') {
      const name = args.at(-1);
      const c = containers.get(name);
      if (!c) return err('no such object');
      const format = args[args.indexOf('--format') + 1] ?? '';
      if (format.includes(ALLOWLIST_LABEL)) return ok(`${c.labels[ALLOWLIST_LABEL] ?? ''}\n`);
      return ok(`${c.running} ${c.exitCode}\n`);
    }
    if (verb === 'network inspect') return err('no such network');
    // The proxy's listen banner, so the readiness wait completes immediately.
    if (verb === 'logs') return ok('aab-egress proxy listening on 0.0.0.0:3128 allowing [x]\n');
    return ok('cid\n');
  };
  return {
    exec,
    calls,
    /** The modelled runtime state, so a test can kill a container out from under us. */
    containers,
    /** The verbs, in order, for asserting SETUP ORDERING. */
    verbs: () => calls.map((a) => (a[0] === 'network' ? `network ${a[1]}` : a[0])),
    /** The argv of the last sandbox `run --rm` (the one-shot command). */
    lastOneShot: () => [...calls].reverse().find((a) => a[0] === 'run' && a.includes('--rm')),
    /** The argv of the last `run -d` (a service, i.e. the proxy). */
    lastService: () => [...calls].reverse().find((a) => a[0] === 'run' && a.includes('-d')),
    /** The childEnv passed alongside the last sandbox `run --rm`. */
    lastOneShotEnv: () => {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        if (calls[i][0] === 'run' && calls[i].includes('--rm')) return envs[i];
      }
      return undefined;
    },
  };
}

/** A filtering backend whose readiness wait does not spend real time. */
function makeFiltering({ exec, ...rest }) {
  return createFilteringContainerBackend({
    allowedHosts: ['registry.npmjs.org'],
    exec,
    sleep: async () => {},
    ...rest,
  });
}

/** The per-project network name for a project label, as the backend derives it. */
const NET_P1 = `${DEFAULT_EGRESS_NETWORK_PREFIX}-p1`;

/** Flag value from an argv vector, e.g. flag(args,'--network'). */
function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * All `-e NAME` env references in an argv vector, counting only the RUNTIME flags.
 * Everything after the image belongs to the command, and the proxy's own command is
 * `node -e <source>` — so scanning the whole vector would report the program text
 * as an environment variable.
 */
function envRefs(args, image = 'node:22-slim') {
  const end = args.indexOf(image) === -1 ? args.length : args.indexOf(image);
  const out = [];
  for (let i = 0; i < end - 1; i += 1) if (args[i] === '-e') out.push(args[i + 1]);
  return out.sort();
}

const BASE = path.join(os.tmpdir(), `aab-egress-${process.pid}`);

/** Same shape test/sandbox.test.js uses, so the real allowlist derivation runs. */
function activeBinding(host) {
  return {
    ...createConnectorBinding({
      connector: { service: 'svc', category: 'database', captureKind: 'api-key' },
      secretRefs: ['SECRET_NAME'],
      status: 'active',
    }),
    host,
  };
}

// ================================================== the allowlist sanitizer (pure)

test('sanitizeProxyAllowlist normalizes hosts and strips everything host-local', () => {
  assert.deepEqual(
    sanitizeProxyAllowlist(['https://registry.npmjs.org/some/path', 'REGISTRY.NPMJS.ORG', 'api.example.com:443']),
    ['api.example.com', 'registry.npmjs.org'],
    'hosts are normalized, lower-cased, de-duplicated and sorted',
  );

  // The proxy is the ONE component with real egress, so an allowlisted metadata or
  // private-range target would be a credential-exfiltration path THROUGH it. These
  // must be impossible to configure, however they arrive.
  const forbidden = [
    'localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::1',
    '169.254.169.254', 'metadata.google.internal',
    'host.docker.internal', 'host.containers.internal',
    '10.1.2.3', '192.168.1.1', '172.16.0.1',
    // ALTERNATE ENCODINGS of 127.0.0.1. These satisfy the DNS-label grammar, so
    // without an explicit rule they survived the forbidden-host filter and could be
    // allowlisted — then matched on the CONNECT path, which does not go through URL
    // canonicalization the way the forward path does.
    '2130706433', '0177.0.0.1', '017700000001', '0x7f000001',
  ];
  assert.deepEqual(sanitizeProxyAllowlist(forbidden), [], 'no host-local target may be allowlisted');
  // ...and a forbidden host mixed in with a good one does not smuggle itself in.
  assert.deepEqual(sanitizeProxyAllowlist(['registry.npmjs.org', '169.254.169.254']), ['registry.npmjs.org']);
  assert.deepEqual(sanitizeProxyAllowlist(['', '   ', 'not a host at all!']), []);
});

test('proxyEnvFor points the whole toolchain at the proxy, and validates its inputs', () => {
  const env = proxyEnvFor({ proxyHost: 'aab-egress-proxy', proxyPort: 3128 });
  const url = 'http://aab-egress-proxy:3128';
  // Both cases, because the ecosystem is inconsistent about which it reads.
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) {
    assert.equal(env[name], url, `${name} must point at the proxy`);
  }
  // NO_PROXY covers only loopback, so nothing else can bypass the proxy.
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.ok(!env.NO_PROXY.includes('*'), 'a wildcard NO_PROXY would disable filtering entirely');

  assert.throws(() => proxyEnvFor({ proxyHost: '' }), /proxyHost/);
  assert.throws(() => proxyEnvFor({ proxyHost: 'p', proxyPort: 0 }), /proxyPort/);
  assert.throws(() => proxyEnvFor({ proxyHost: 'p', proxyPort: 70_000 }), /proxyPort/);
});

test('proxyContainerEnv passes the sanitized allowlist to the proxy', () => {
  const env = proxyContainerEnv({ allowedHosts: ['registry.npmjs.org', '127.0.0.1'], proxyPort: 3128 });
  assert.equal(env.AAB_EGRESS_ALLOWLIST, 'registry.npmjs.org', 'loopback must not reach the proxy allowlist');
  assert.equal(env.AAB_EGRESS_PORT, '3128');
  assert.equal(env.AAB_EGRESS_CONNECT_PORTS, undefined, 'the restrictive default applies unless overridden');
  assert.equal(ALLOWED_CONNECT_PORTS.includes(443), true);
  assert.equal(ALLOWED_CONNECT_PORTS.includes(22), false, 'a tunnel must not reach arbitrary services');
});

// ============================================== the proxy itself, LIVE over HTTP

/**
 * Run the REAL proxy program as a real process, with a real upstream behind it.
 * Loopback is used as the "allowed host" here deliberately: the proxy reads its
 * allowlist from the environment, and the separate sanitizer test above proves
 * loopback can never get INTO that allowlist in production.
 */
async function withLiveProxy({ allowlist, connectPorts, allowPrivate = true }, body) {
  const upstreamPort = await freePort();
  // Both the forward path and CONNECT are bound by the permitted-port list, and the
  // upstream here is necessarily on an ephemeral port. Permit it by default so the
  // plumbing can be exercised; a caller that is TESTING the port restriction passes
  // `connectPorts` explicitly to override this.
  const ports = connectPorts ?? `80,443,${upstreamPort}`;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    // Echo back what the ORIGIN actually received, so header handling is observable.
    res.end(
      `upstream saw ${req.method} ${req.url} host=${req.headers.host} ` +
        `proxy-authorization=${req.headers['proxy-authorization'] ? 'present' : 'absent'}`,
    );
  });
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

  const proxyPort = await freePort();
  const child = spawn(process.execPath, ['-e', EGRESS_PROXY_SRC], {
    env: {
      ...process.env,
      AAB_EGRESS_ALLOWLIST: allowlist,
      AAB_EGRESS_PORT: String(proxyPort),
      AAB_EGRESS_CONNECT_PORTS: ports,
      // The upstream in these tests is necessarily on loopback, which the proxy's
      // resolved-address check refuses by default. That default is asserted in its
      // own test below; here we opt out so the FORWARDING and TUNNEL plumbing can be
      // exercised against a real server.
      ...(allowPrivate ? { AAB_EGRESS_ALLOW_PRIVATE_ADDRESSES: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => {
    log += String(d);
  });
  child.stderr.on('data', (d) => {
    log += String(d);
  });

  // Wait for the real listener.
  for (let i = 0; i < 100; i += 1) {
    if (/proxy listening/.test(log)) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  try {
    return await body({ proxyPort, upstreamPort, logs: () => log, child });
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => upstream.close(r));
  }
}

/** Issue a real proxy-style request (absolute-form request line). */
function proxyGet({ proxyPort, targetHost, targetPort, path: p = '/' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://${targetHost}:${targetPort}${p}`,
        headers: { host: `${targetHost}:${targetPort}` },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Issue a real CONNECT and report the status line. */
function proxyConnect({ proxyPort, target }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, tunnelled: true });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => resolve({ status: res.statusCode, tunnelled: false, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('(live) the proxy FORWARDS an allowlisted host and DENIES everything else', async () => {
  await withLiveProxy({ allowlist: '127.0.0.1' }, async ({ proxyPort, upstreamPort, logs }) => {
    const allowed = await proxyGet({ proxyPort, targetHost: '127.0.0.1', targetPort: upstreamPort, path: '/pkg' });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /upstream saw GET \/pkg/, 'an allowlisted request must actually reach the upstream');

    // A host that is NOT on the allowlist is refused — deny by default.
    const denied = await proxyGet({ proxyPort, targetHost: 'evil.example.com', targetPort: 80 });
    assert.equal(denied.status, 403);
    assert.match(denied.body, /not on the sandbox egress allowlist/);
    assert.match(logs(), /DENY evil\.example\.com/, 'a denial must be logged so it is diagnosable');
    assert.match(logs(), /ALLOW 127\.0\.0\.1/);
  });
});

test('(live) an EMPTY allowlist denies everything — a lost config must not mean allow-all', async () => {
  await withLiveProxy({ allowlist: '' }, async ({ proxyPort, upstreamPort }) => {
    const res = await proxyGet({ proxyPort, targetHost: '127.0.0.1', targetPort: upstreamPort });
    assert.equal(res.status, 403, 'with nothing allowlisted, nothing may pass');
  });
});

test('(live) a near-miss hostname is denied — matching is exact, not by suffix', async () => {
  await withLiveProxy({ allowlist: 'registry.npmjs.org' }, async ({ proxyPort }) => {
    for (const host of ['evil-registry.npmjs.org', 'registry.npmjs.org.evil.com', 'xregistry.npmjs.org']) {
      const res = await proxyGet({ proxyPort, targetHost: host, targetPort: 80 });
      assert.equal(res.status, 403, `${host} must not be treated as the allowlisted host`);
    }
  });
});

test('(live) CONNECT tunnels an allowlisted host, and refuses a non-tunnellable port', async () => {
  // With the DEFAULT port list (443/80 only), a tunnel to any other port is refused
  // even for an allowlisted host — an allowlisted host must not become a
  // general-purpose TCP relay.
  await withLiveProxy({ allowlist: '127.0.0.1', connectPorts: '443,80' }, async ({ proxyPort, upstreamPort }) => {
    assert.equal((await proxyConnect({ proxyPort, target: `127.0.0.1:${upstreamPort}` })).status, 403);
    assert.equal(
      (await proxyConnect({ proxyPort, target: '127.0.0.1:22' })).status,
      403,
      'a tunnel must never reach ssh',
    );
    // The SAME bound applies to the plain-HTTP forward path. Without it an
    // allowlisted host was reachable on ANY port over the forward path, so the
    // tunnel's port restriction was only half the boundary.
    const forward = await proxyGet({ proxyPort, targetHost: '127.0.0.1', targetPort: upstreamPort });
    assert.equal(forward.status, 403, 'the forward path must be bound by the same port list');
    assert.match(forward.body, /port .* is not permitted/);
  });

  // With the port permitted, the tunnel is established end to end and real bytes
  // flow through it — proving we pipe raw TCP rather than terminating it.
  const upstreamPort = await freePort();
  const echo = net.createServer((sock) => sock.pipe(sock));
  await new Promise((r) => echo.listen(upstreamPort, '127.0.0.1', r));
  try {
    await withLiveProxy(
      { allowlist: '127.0.0.1', connectPorts: String(upstreamPort) },
      async ({ proxyPort }) => {
        const tunnelled = await new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `127.0.0.1:${upstreamPort}` });
          req.on('connect', (res, socket) => {
            let got = '';
            socket.on('data', (d) => {
              got += String(d);
              if (got.includes('ping')) {
                socket.destroy();
                resolve({ status: res.statusCode, got });
              }
            });
            socket.write('ping');
          });
          req.on('response', (res) => resolve({ status: res.statusCode, got: '' }));
          req.on('error', reject);
          req.end();
        });
        assert.equal(tunnelled.status, 200, 'an allowlisted host on a permitted port must tunnel');
        assert.match(tunnelled.got, /ping/, 'raw bytes must flow through the tunnel unmodified');
      },
    );
  } finally {
    await new Promise((r) => echo.close(r));
  }
});

test('(live) an allowlisted name that resolves to a NON-PUBLIC address is still refused', async () => {
  // A hostname allowlist alone is not enough: this proxy is the one component with
  // real egress, so an allowlisted name that resolves inward (split-horizon DNS, a
  // hijacked record, a mirror pointing at the metadata address) would be exactly the
  // SSRF path the allowlist exists to prevent. `allowPrivate:false` is the DEFAULT
  // posture; the other live tests opt out of it only to reach a loopback upstream.
  // Uses a NAME (`localhost`), not a literal: a literal IP never goes through DNS,
  // so the resolver hook is not consulted for one — literals are instead blocked at
  // CONFIGURATION time by sanitizeProxyAllowlist, which is asserted separately.
  // Together the two cover both shapes.
  await withLiveProxy({ allowlist: 'localhost', allowPrivate: false }, async ({ proxyPort, upstreamPort, logs }) => {
    const res = await proxyGet({ proxyPort, targetHost: 'localhost', targetPort: upstreamPort });
    assert.equal(res.status, 502, 'the connection must fail on the address check, not be forwarded');
    assert.match(logs(), /resolves only to non-public addresses/, 'the reason must be logged');
    assert.ok(!/upstream saw/.test(res.body), 'the request must never reach the upstream');
  });

  // With the override on, the SAME request is forwarded — an on-prem registry on a
  // private address is a legitimate deployment, which is why the check is
  // overridable, and why it defaults to off.
  await withLiveProxy({ allowlist: 'localhost', allowPrivate: true }, async ({ proxyPort, upstreamPort }) => {
    assert.equal((await proxyGet({ proxyPort, targetHost: 'localhost', targetPort: upstreamPort })).status, 200);
  });
});

test('(live) an absolute-form https:// request is refused, never downgraded to cleartext', async () => {
  // The module's integrity claim is that TLS is never terminated and never
  // downgraded. Servicing absolute-form https:// would mean issuing a CLEARTEXT
  // request on the sandbox's behalf for a URL that asked for TLS.
  await withLiveProxy({ allowlist: '127.0.0.1' }, async ({ proxyPort, upstreamPort, logs }) => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, method: 'GET', path: `https://127.0.0.1:${upstreamPort}/x` },
        (r) => {
          let body = '';
          r.on('data', (d) => {
            body += d;
          });
          r.on('end', () => resolve({ status: r.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 400);
    assert.match(res.body, /must use CONNECT/);
    assert.ok(!/ALLOW/.test(logs().split('\n').filter((l) => l.includes('https')).join('')), 'it must not be logged as allowed');
  });
});

test('(live) the Host header cannot redirect the connection away from the allowlisted origin', async () => {
  await withLiveProxy({ allowlist: '127.0.0.1' }, async ({ proxyPort, upstreamPort }) => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          method: 'GET',
          path: `http://127.0.0.1:${upstreamPort}/p`,
          // A disagreeing Host, plus a hop-by-hop header that must not be forwarded.
          headers: { host: 'evil.example.com', 'proxy-authorization': 'Basic secret' },
        },
        (r) => {
          let body = '';
          r.on('data', (d) => {
            body += d;
          });
          r.on('end', () => resolve({ status: r.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200, 'the request goes to the allowlisted origin from the request line');
    // The origin sees the authority we actually connected to, not the forged Host,
    // and never sees the proxy credentials.
    assert.match(res.body, new RegExp(`host=127\\.0\\.0\\.1:${upstreamPort}`), 'Host must match the real origin');
    assert.match(res.body, /proxy-authorization=absent/, 'hop-by-hop headers must be stripped');
  });
});

test('(live) a malformed proxy request is rejected without killing the proxy', async () => {
  await withLiveProxy({ allowlist: '127.0.0.1' }, async ({ proxyPort, upstreamPort, child }) => {
    // A relative-form request line is not a proxy request at all.
    const bad = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: '/not-absolute' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(bad, 400);
    // Still alive and still filtering afterwards.
    assert.equal((await proxyGet({ proxyPort, targetHost: '127.0.0.1', targetPort: upstreamPort })).status, 200);
    assert.equal(child.exitCode, null, 'the proxy must survive a malformed request');
  });
});

// ==================================== the filtering backend: setup + translation

test('the filtering backend declares the capability the plain one cannot', () => {
  const plain = createContainerBackend({ exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, signal: null }) });
  assert.equal(plain.supportsEgressFiltering, false);
  assert.deepEqual(plain.permittedNetworks, ['none'], 'a plain backend launches into total-deny only');

  const filtering = makeFiltering({ exec: cliFake().exec });
  assert.equal(filtering.supportsEgressFiltering, true);
  assert.deepEqual(filtering.allowedHosts, ['registry.npmjs.org']);
  assert.equal(filtering.networkPrefix, DEFAULT_EGRESS_NETWORK_PREFIX);
  assert.equal(filtering.proxyName, DEFAULT_PROXY_CONTAINER);
  assert.equal(filtering.proxyPort, DEFAULT_PROXY_PORT);
});

test('a filtered exec builds the enforcement plane IN ORDER, then runs on the internal network', async () => {
  const fake = cliFake();
  const backend = makeFiltering({ exec: fake.exec });

  const res = await backend.runOneShot({
    name: 'aab-sbx-p1-abc',
    labelValue: 'aab-sbx-p1',
    mountSource: '/data/p1/tree',
    command: ['npm', 'install'],
    network: NETWORK_FILTERED,
  });
  assert.equal(res.code, 0, 'a filtered command must RUN, where the plain backend denied it');

  // Ordering is the correctness property: the network must exist before the proxy is
  // attached, and the proxy must be LISTENING (not merely accepted by the runtime)
  // before a sandbox that depends on it runs.
  assert.deepEqual(fake.verbs(), [
    // the shared proxy: is one there? -> start it -> wait for its listen banner
    'inspect', 'run', 'logs',
    // then this project's own internal network, attached to that proxy
    'network create', 'network connect',
    // and only then the sandbox command
    'run',
  ]);

  const create = fake.calls.find((a) => a[0] === 'network' && a[1] === 'create');
  assert.ok(create.includes('--internal'), 'the sandbox network must have NO route out — that is the deny-by-default');
  assert.equal(create.at(-1), NET_P1);
  assert.ok(
    create.includes(`aab.sandbox=${DEFAULT_PROXY_CONTAINER}`),
    'the network carries our owner label, so it is not orphaned beyond any reaper',
  );

  // The proxy runs detached on the EGRESS-CAPABLE network — the only component that
  // is supposed to have one — labelled for reaping AND with its policy fingerprint.
  const proxy = fake.lastService();
  assert.equal(flag(proxy, '--network'), 'bridge');
  assert.equal(flag(proxy, '--name'), DEFAULT_PROXY_CONTAINER);
  assert.ok(proxy.includes(`aab.sandbox=${DEFAULT_PROXY_CONTAINER}`));
  assert.ok(
    proxy.includes(`${ALLOWLIST_LABEL}=${allowlistFingerprint(['registry.npmjs.org'])}`),
    'the proxy records WHICH allowlist it enforces, so adoption can verify it',
  );
  assert.deepEqual(envRefs(proxy), ['AAB_EGRESS_ALLOWLIST', 'AAB_EGRESS_PORT']);
  assert.ok(!proxy.includes('-v'), 'the proxy must not mount any project tree');
  assert.ok(proxy.includes('--memory'), 'the component every project routes through must have limits');

  // The SANDBOX runs on its own internal network with the proxy variables injected.
  const sandbox = fake.lastOneShot();
  assert.equal(flag(sandbox, '--network'), NET_P1);
  assert.ok(!sandbox.includes('bridge'), 'the sandbox must never touch an egress-capable network');
  assert.deepEqual(envRefs(sandbox), [
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
    'npm_config_https_proxy', 'npm_config_proxy',
  ]);
  assert.deepEqual(sandbox.slice(-2), ['npm', 'install']);
  // The stable project label survives, so per-project orphan reaping can match it.
  assert.equal(flag(sandbox, '--label'), 'aab.sandbox=aab-sbx-p1');
});

test('EACH PROJECT gets its OWN internal network, so sandboxes cannot reach each other', async () => {
  // A single shared internal network would put every project's container in one L2
  // domain — reachable on all ports, with peer names resolvable via the runtime's
  // embedded DNS. `--network none` gave no peers at all, and egress.js states no
  // lateral peer access is ever produced, so sharing would widen the isolation
  // boundary while narrowing egress.
  const fake = cliFake();
  const backend = makeFiltering({ exec: fake.exec });
  const run = (project) =>
    backend.runOneShot({
      name: `aab-sbx-${project}-x`,
      labelValue: `aab-sbx-${project}`,
      mountSource: `/d/${project}`,
      command: ['true'],
      network: NETWORK_FILTERED,
    });

  await run('projectA');
  await run('projectB');

  const nets = fake.calls
    .filter((a) => a[0] === 'run' && a.includes('--rm'))
    .map((a) => flag(a, '--network'));
  assert.deepEqual(nets, [`${DEFAULT_EGRESS_NETWORK_PREFIX}-projectA`, `${DEFAULT_EGRESS_NETWORK_PREFIX}-projectB`]);
  assert.notEqual(nets[0], nets[1], 'two projects must never share one internal network');

  // ...and the single proxy is attached to BOTH, so it stays the only path out.
  const attached = fake.calls.filter((a) => a[0] === 'network' && a[1] === 'connect').map((a) => a[2]);
  assert.deepEqual(attached, nets);
  assert.equal(fake.calls.filter((a) => a[0] === 'run' && a.includes('-d')).length, 1, 'one proxy serves all projects');
});

test('the plane is built ONCE across concurrent and repeated filtered execs', async () => {
  const fake = cliFake();
  const backend = makeFiltering({ exec: fake.exec });
  const spec = { name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED };

  // Concurrent: N execs must not race to create the same network/container.
  await Promise.all([backend.runOneShot(spec), backend.runOneShot(spec), backend.runOneShot(spec)]);
  await backend.runOneShot(spec);

  assert.equal(fake.verbs().filter((v) => v === 'network create').length, 1, 'the network is created once');
  assert.equal(fake.calls.filter((a) => a[0] === 'run' && a.includes('-d')).length, 1, 'the proxy is started once');
  assert.equal(fake.calls.filter((a) => a[0] === 'run' && a.includes('--rm')).length, 4, 'every command still runs');
});

test('an EXISTING network is adopted only after its Internal flag is VERIFIED', async () => {
  // THE FAIL-OPEN THIS CLOSES. `--internal` is a CREATION flag: when the name is
  // already taken, `network create` fails and the flag is discarded with the error.
  // Adopting blindly meant a pre-existing ROUTABLE network of the same name became
  // the sandbox network and restored full egress, with no signal anywhere.
  const taken = { code: 1, stdout: '', stderr: 'network with name x already exists', timedOut: false, signal: null };

  // (a) exists AND is internal -> adopted, and the command runs.
  const good = cliFake({
    overrides: {
      'network create': async () => taken,
      'network inspect': async () => ({ code: 0, stdout: 'true\n', stderr: '', timedOut: false, signal: null }),
    },
  });
  const okBackend = makeFiltering({ exec: good.exec });
  const ran = await okBackend.runOneShot({
    name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED,
  });
  assert.equal(ran.code, 0);
  assert.ok(
    good.calls.some((a) => a[0] === 'network' && a[1] === 'inspect' && a.includes('{{.Internal}}')),
    'the existing network MUST be inspected, not trusted',
  );

  // (b) exists but is NOT internal -> the command is DENIED.
  const routable = cliFake({
    overrides: {
      'network create': async () => taken,
      'network inspect': async () => ({ code: 0, stdout: 'false\n', stderr: '', timedOut: false, signal: null }),
    },
  });
  const badBackend = makeFiltering({ exec: routable.exec });
  await assert.rejects(
    () => badBackend.runOneShot({ name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED }),
    /already exists but is NOT internal/,
  );
  assert.equal(routable.lastOneShot(), undefined, 'a routable network must never carry a sandbox');
});

test('a running proxy is adopted only when its allowlist MATCHES the current policy', async () => {
  // Adopting on the NAME alone meant an allowlist change — including a REMOVAL, i.e.
  // a revocation — never took effect, and any container of that name became the
  // component every sandbox's traffic was pointed at.
  const spec = { name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED };

  // A proxy already running with the CURRENT policy -> reused, nothing started.
  const match = cliFake();
  match.containers.set(DEFAULT_PROXY_CONTAINER, {
    running: true,
    exitCode: 0,
    labels: { [ALLOWLIST_LABEL]: allowlistFingerprint(['registry.npmjs.org']) },
  });
  await makeFiltering({ exec: match.exec }).runOneShot(spec);
  assert.equal(match.calls.filter((a) => a[0] === 'run' && a.includes('-d')).length, 0, 'a matching proxy is reused');

  // A proxy running a DIFFERENT policy (e.g. a host has since been revoked) must be
  // replaced, or the revocation would never take effect.
  const drift = cliFake();
  drift.containers.set(DEFAULT_PROXY_CONTAINER, {
    running: true,
    exitCode: 0,
    labels: { [ALLOWLIST_LABEL]: allowlistFingerprint(['registry.npmjs.org', 'api.stripe.com']) },
  });
  await makeFiltering({ exec: drift.exec }).runOneShot(spec);
  assert.ok(drift.calls.some((a) => a[0] === 'rm'), 'a proxy enforcing a different allowlist must be removed');
  assert.equal(drift.calls.filter((a) => a[0] === 'run' && a.includes('-d')).length, 1, 'and replaced with current policy');

  // An UNLABELLED container that merely has the right NAME is not trusted either.
  const squatter = cliFake();
  squatter.containers.set(DEFAULT_PROXY_CONTAINER, { running: true, exitCode: 0, labels: {} });
  await makeFiltering({ exec: squatter.exec }).runOneShot(spec);
  assert.ok(squatter.calls.some((a) => a[0] === 'rm'), 'a container is not the egress policy just because of its name');
});

test('a stale exited proxy is removed and replaced', async () => {
  const stale = cliFake();
  stale.containers.set(DEFAULT_PROXY_CONTAINER, { running: false, exitCode: 1, labels: {} });
  const backend = makeFiltering({ exec: stale.exec });
  assert.equal(
    (await backend.runOneShot({ name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED })).code,
    0,
  );
  assert.ok(stale.calls.some((a) => a[0] === 'rm'), 'the exited container holds the name and must be removed');
  assert.equal(stale.calls.filter((a) => a[0] === 'run' && a.includes('-d')).length, 1);
});

test('a proxy that never starts LISTENING denies the command', async () => {
  // startService returns when the runtime accepted `run -d`, not when the Node
  // process inside bound its socket. Without the readiness wait, the first install
  // after a cold plane failed with a connection error rather than a policy decision.
  const fake = cliFake({
    overrides: { logs: async () => ({ code: 0, stdout: 'crashing\n', stderr: '', timedOut: false, signal: null }) },
  });
  const backend = makeFiltering({ exec: fake.exec, readyAttempts: 3 });
  await assert.rejects(
    () => backend.runOneShot({ name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED }),
    /did not start listening/,
  );
  assert.equal(fake.lastOneShot(), undefined, 'nothing may run against a proxy that is not up');
  assert.ok(fake.calls.some((a) => a[0] === 'rm'), 'the non-listening proxy is torn down');
});

test('a plane whose proxy has DIED since is rebuilt, not trusted from cache', async () => {
  const fake = cliFake();
  const backend = makeFiltering({ exec: fake.exec });
  const spec = { name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED };

  await backend.runOneShot(spec);
  assert.equal(fake.calls.filter((a) => a[0] === 'run' && a.includes('-d')).length, 1);
  const connectsBefore = fake.calls.filter((a) => a[0] === 'network' && a[1] === 'connect').length;

  // An admin removes it, or a reaper collects it. A cached success is not proof.
  fake.containers.delete(DEFAULT_PROXY_CONTAINER);

  await backend.runOneShot(spec);
  assert.equal(
    fake.calls.filter((a) => a[0] === 'run' && a.includes('-d')).length,
    2,
    'a dead proxy must be rebuilt, not left with no path out',
  );
  assert.ok(
    fake.calls.filter((a) => a[0] === 'network' && a[1] === 'connect').length > connectsBefore,
    'the NEW proxy container must be re-attached to the project network',
  );
});

test('total-deny passes straight through, identically to the plain backend', async () => {
  const fake = cliFake();
  const backend = makeFiltering({ exec: fake.exec });
  await backend.runOneShot({ name: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_DENY_ALL });

  assert.deepEqual(fake.verbs(), ['run'], 'a no-network command must not build an egress plane it does not use');
  const args = fake.lastOneShot();
  assert.equal(flag(args, '--network'), 'none');
  assert.deepEqual(envRefs(args), [], 'no proxy variables leak into a no-network sandbox');
});

// ============================================================ fail-closed paths

test('a plane that cannot be built DENIES the command instead of running it unfiltered', async () => {
  const cases = [
    {
      what: 'the internal network cannot be created',
      overrides: { 'network create': async () => ({ code: 1, stdout: '', stderr: 'permission denied', timedOut: false, signal: null }) },
      expect: /could not create internal network/,
    },
    {
      what: 'the proxy will not start',
      overrides: {
        run: async (args) =>
          args.includes('-d')
            ? { code: 125, stdout: '', stderr: 'no such image', timedOut: false, signal: null }
            : { code: 0, stdout: '', stderr: '', timedOut: false, signal: null },
      },
      expect: /could not start the egress proxy/,
    },
    {
      what: 'the proxy cannot be attached to the internal network',
      overrides: { 'network connect': async () => ({ code: 1, stdout: '', stderr: 'network not found', timedOut: false, signal: null }) },
      expect: /could not attach/,
    },
  ];

  for (const { what, overrides, expect } of cases) {
    const fake = cliFake({ overrides });
    const backend = makeFiltering({ exec: fake.exec });
    await assert.rejects(
      () => backend.runOneShot({ name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['npm', 'install'], network: NETWORK_FILTERED }),
      (err) => {
        assert.match(err.message, /fail-closed/, `${what}: the refusal must say it failed closed`);
        assert.match(err.message, expect, `${what}: the reason must be specific`);
        return true;
      },
    );
    // The decisive part: NO sandbox command was launched.
    assert.equal(fake.lastOneShot(), undefined, `${what}: no command may run without an enforcement plane`);
  }
});

test('a half-built plane is torn down rather than left claiming success', async () => {
  const fake = cliFake({
    overrides: { 'network connect': async () => ({ code: 1, stdout: '', stderr: 'nope', timedOut: false, signal: null }) },
  });
  const backend = makeFiltering({ exec: fake.exec });
  await assert.rejects(() => backend.runOneShot({ name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED }));
  // The network created moments earlier must not be left orphaned either.
  assert.ok(
    fake.calls.some((a) => a[0] === 'network' && a[1] === 'rm' && a.includes(NET_P1)),
    'a network created for a plane that failed must be removed',
  );
});

test('a failed plane is RETRIED on the next exec — including when the CLI THREW', async () => {
  for (const mode of ['returns-failure', 'throws']) {
    let failing = true;
    const fake = cliFake({
      overrides: {
        'network create': async () => {
          if (!failing) return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
          // A THROWN failure is the case that used to be cached forever: the
          // rejected promise stayed in the plane cache and every later filtered
          // exec re-threw it, denying everything until a process restart.
          if (mode === 'throws') throw new Error('EAGAIN spawn docker');
          return { code: 1, stdout: '', stderr: 'transient', timedOut: false, signal: null };
        },
      },
    });
    const backend = makeFiltering({ exec: fake.exec });
    const spec = { name: 'aab-sbx-p1-x', labelValue: 'aab-sbx-p1', mountSource: '/d', command: ['true'], network: NETWORK_FILTERED };

    await assert.rejects(() => backend.runOneShot(spec), /fail-closed/, `${mode}: must fail closed`);
    failing = false;
    assert.equal(
      (await backend.runOneShot(spec)).code,
      0,
      `${mode}: a transient setup failure must not wedge the sandbox forever`,
    );
  }
});

test('the filtering backend refuses to exist with nothing to allow', () => {
  const fake = cliFake();
  assert.throws(() => createFilteringContainerBackend({ allowedHosts: [], exec: fake.exec }), /at least one usable host/);
  assert.throws(() => createFilteringContainerBackend({ exec: fake.exec }), /at least one usable host/);
  // An allowlist of ONLY forbidden hosts sanitizes to empty — which must be an
  // error, not an accidental allow-all or a silent deny-all.
  assert.throws(
    () => createFilteringContainerBackend({ allowedHosts: ['127.0.0.1', '169.254.169.254'], exec: fake.exec }),
    /at least one usable host/,
  );
  assert.throws(
    () => createFilteringContainerBackend({ allowedHosts: ['registry.npmjs.org'], networkPrefix: 'bad name!', exec: fake.exec }),
    /invalid container\/network name/,
  );
});

test('the base backend can never be told to launch into the FILTERED sentinel', () => {
  // 'filtered' names a capability, not a network. Permitting it would emit
  // `--network filtered` to the runtime, which is meaningless.
  assert.throws(
    () => createContainerBackend({ permittedNetworks: ['none', NETWORK_FILTERED] }),
    /cannot be a permitted network/,
  );
});

test('an unenforceable network is still refused, and the sandbox never joins a general network', async () => {
  const fake = cliFake();
  const backend = makeFiltering({ exec: fake.exec });
  // The delegate is permitted EXACTLY total-deny plus its own internal network, so
  // a mistranslation cannot attach a sandbox to the default bridge.
  for (const network of ['bridge', 'host', 'private', 'aab-preview']) {
    await assert.rejects(
      () => backend.runOneShot({ name: 'n', mountSource: '/d', command: ['true'], network }),
      /egress filtering not supported by this backend/,
      `${network} must not be launchable for a sandbox command`,
    );
  }
  assert.equal(fake.lastOneShot(), undefined, 'nothing launched');
});

test('caller secrets survive the translation, but they cannot OVERRIDE the egress control', async () => {
  const fake = cliFake();
  const backend = makeFiltering({ exec: fake.exec });
  await backend.runOneShot({
    name: 'aab-sbx-p1-x',
    labelValue: 'aab-sbx-p1',
    mountSource: '/d',
    command: ['npm', 'install'],
    network: NETWORK_FILTERED,
    env: { STRIPE_KEY: 'sk_live_x', HTTP_PROXY: 'http://attacker:8080', NO_PROXY: '*' },
  });
  const sandbox = fake.lastOneShot();
  assert.ok(envRefs(sandbox).includes('STRIPE_KEY'), 'injected secrets must not be dropped by the translation');
  // Name-only references: the secret VALUE must never appear in argv.
  assert.ok(!sandbox.join(' ').includes('sk_live_x'), 'a secret value must never reach the command line');

  // ASSERTED ON THE VALUES, not the names. Env values travel in the runner's
  // childEnv, never in argv, so an argv-only assertion could not tell which side of
  // the merge won — and the proxy settings are a security control, so a
  // project-named secret must not be able to redirect or disable them.
  const childEnv = fake.lastOneShotEnv();
  assert.equal(childEnv.STRIPE_KEY, 'sk_live_x', 'the secret value still reaches the runtime');
  assert.equal(childEnv.HTTP_PROXY, 'http://aab-egress-proxy:3128', 'the enforcement setting must win');
  assert.equal(childEnv.NO_PROXY, 'localhost,127.0.0.1', 'a wildcard NO_PROXY must not disable filtering');
});

// =================================== through the REAL SandboxManager (the headline)

test('a project with a populated allowlist now RUNS its command, where it used to be DENIED', async () => {
  // THE BEHAVIOR CHANGE. With the plain backend, a non-empty allowlist selects
  // NETWORK_FILTERED, which it refuses — so every command was denied before launch
  // and `npm install` was impossible in ANY posture. Same real manager, same real
  // allowlist derivation, filtering backend: the command runs, on the enforced
  // network, with the proxy variables in place.
  const layout = createStorageLayout(BASE);
  const fake = cliFake();
  const filtering = makeFiltering({ exec: fake.exec });
  const manager = createSandboxManager({
    layout,
    backend: filtering,
    config: { packageRegistryHosts: ['registry.npmjs.org'] },
    bindingsFor: () => [activeBinding('api.stripe.com')],
  });

  const handle = manager.acquire('p1');
  assert.ok(handle.egress.allowedHosts.includes('registry.npmjs.org'));
  assert.equal(handle.egress.denyByDefault, true);

  const result = await manager.exec('p1', 'npm install');
  assert.notEqual(result.denied, true, `the command must RUN, got ${JSON.stringify(result)}`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.network, NETWORK_FILTERED, 'the manager still REQUESTS filtered egress');
  assert.equal(flag(fake.lastOneShot(), '--network'), NET_P1, 'and it is enforced by this project\'s internal network');
  // The manager's STABLE per-project label reaches the container, so the
  // per-project orphan cleanup release() performs can actually match it.
  assert.equal(flag(fake.lastOneShot(), '--label'), 'aab.sandbox=aab-sbx-p1');

  // The same manager against the PLAIN backend still denies — the mutation check
  // that this test is measuring the new backend and not something incidental.
  const plain = createContainerBackend({
    exec: async () => ({ code: 0, stdout: 'should-not-run', stderr: '', timedOut: false, signal: null }),
  });
  const denying = createSandboxManager({
    layout,
    backend: plain,
    config: { packageRegistryHosts: ['registry.npmjs.org'] },
  });
  denying.acquire('p2');
  const denied = await denying.exec('p2', 'npm install');
  assert.equal(denied.denied, true, 'the plain backend must still fail closed');
  assert.equal(denied.deniedReason, 'launch-failure');

  fs.rmSync(BASE, { recursive: true, force: true });
});

test('rawExec is a plumbing escape hatch that can never launch a container', async () => {
  const calls = [];
  const backend = createContainerBackend({
    exec: async (bin, args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null };
    },
  });
  await backend.rawExec(['network', 'ls']);
  assert.deepEqual(calls, [['network', 'ls']]);

  // AN ALLOWLIST, NOT A DENYLIST. Denying run/create/exec looked sufficient and was
  // not: docker's MANAGEMENT form sails past it, and so do `start` and `cp` — which
  // is arbitrary host-filesystem access as the daemon user. Since rawExec is on the
  // backend's public surface, the guard has to mean what it says.
  const mustRefuse = [
    ['run', '--privileged', 'alpine'],
    ['create', 'alpine'],
    ['exec', 'x', 'sh'],
    ['container', 'run', '--network', 'host', '--privileged', '-v', '/:/host', 'alpine', 'sh'],
    ['container', 'create', 'alpine'],
    ['container', 'exec', 'x', 'sh'],
    ['start', 'somecontainer'],
    ['cp', '/etc/shadow', 'x:/tmp/s'],
    ['build', '.'],
    ['login', '-u', 'x'],
  ];
  for (const args of mustRefuse) {
    await assert.rejects(() => backend.rawExec(args), /rawExec refuses/, `rawExec must refuse: ${args.join(' ')}`);
  }
  await assert.rejects(() => backend.rawExec([]), /non-empty array/);
  assert.equal(calls.length, 1, 'no refused call may reach the runtime');
});
