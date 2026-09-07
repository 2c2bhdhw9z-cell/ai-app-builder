/**
 * egress-proxy.js — the ALLOWLISTING EGRESS PROXY that makes deny-by-default
 * egress *usable* (follow-up to spec Task 5 / Req 8.4, 17.1).
 *
 * THE PROBLEM. The sandbox posture has only ever had two settings, and neither
 * lets a build install its dependencies:
 *
 *   - `AAB_SANDBOX_EGRESS=none` (the default): `--network none`. Commands run, but
 *     there is no network at all, so `npm install` cannot work.
 *   - `AAB_SANDBOX_EGRESS=registry`: a populated allowlist, which the
 *     SandboxManager maps to the NETWORK_FILTERED sentinel — a REQUEST for
 *     per-host filtering. A plain docker/OCI CLI backend cannot install per-host
 *     firewall rules, so it fails closed and refuses EVERY command.
 *
 * So the honest state was: installs impossible, or the sandbox unusable. What was
 * missing is something that can actually enforce "this container may reach the
 * package registry and NOTHING else".
 *
 * THE DESIGN, and why it is enforceable rather than aspirational. Two containers
 * and one network:
 *
 *   1. A docker network created with `--internal`. An internal network has NO
 *      route to the outside world — that is the deny-by-default primitive, applied
 *      by the runtime rather than asserted by us. A container on it cannot reach
 *      any external host, cannot resolve external DNS, and cannot be reached from
 *      outside. It CAN reach other containers on the same network.
 *   2. This proxy, running in a container attached to BOTH that internal network
 *      and a normal egress-capable one. It is therefore the ONLY path out, and it
 *      forwards a request only when the target host is on its allowlist.
 *
 * The sandbox container joins the internal network ONLY, with `HTTP_PROXY` /
 * `HTTPS_PROXY` / `npm_config_registry` pointed at this proxy. Nothing else needs
 * to cooperate: even a package's install script that ignores the proxy variables
 * simply finds no route and no DNS.
 *
 * WHY THIS DOES NOT BREAK PACKAGE INTEGRITY. The proxy does NOT terminate TLS. An
 * `https://` fetch arrives as a `CONNECT host:443` request; we check the HOST from
 * the CONNECT line, and if it is allowed we open a raw TCP tunnel and pipe bytes.
 * We never see or alter the plaintext, so npm's TLS verification and integrity
 * hashes are end-to-end exactly as they would be without a proxy. That also means
 * the filtering unit is a HOSTNAME, which is precisely the granularity the egress
 * allowlist is expressed in.
 *
 * WHY IT IS DEPENDENCY-FREE. It is a Node script that runs in the SAME image the
 * sandbox already uses (`node:22-slim`), using only `node:http`/`node:net`. No new
 * image to pull, no new package, nothing added to package.json — the same
 * reasoning as the static preview server in src/project/container-dev-server.js.
 *
 * FAIL CLOSED, everywhere:
 *   - an empty allowlist refuses everything (an allowlist that failed to arrive
 *     must not mean "allow all");
 *   - a host not on the allowlist gets 403 (or a refused tunnel);
 *   - a CONNECT to a port that is not a normal TLS/HTTP port is refused, so the
 *     tunnel cannot be repurposed into a general-purpose TCP relay;
 *   - every decision is logged, so a denial is diagnosable instead of mysterious.
 *
 * WHAT ONLY A REAL CONTAINER HOST CAN PROVE: that `--internal` truly severs the
 * route (we rely on the runtime for that), and that the runtime's embedded DNS
 * still resolves the proxy's container name on an internal network. The proxy's
 * OWN behavior — every allow/deny decision, the tunnel, the fail-closed cases — is
 * proven here by running it as a real process and driving it with real HTTP.
 *
 * THE PLUMBY BOUNDARY: this module never imports the plumby package.
 */

import crypto from 'node:crypto';

import { requireArray, fail } from '../model/validate.js';
import { normalizeHost, isForbiddenEgressHost } from './egress.js';

/** The port the proxy listens on inside its container. */
export const DEFAULT_PROXY_PORT = 3128;

/**
 * Ports a CONNECT tunnel may target. Restricting these stops the tunnel from
 * becoming a general TCP relay to arbitrary services on an allowlisted host.
 */
export const ALLOWED_CONNECT_PORTS = Object.freeze([443, 80]);

/**
 * Validate + normalize the hosts a sandbox may reach.
 *
 * Reuses the SAME forbidden-host rules as the egress allowlist itself
 * (src/sandbox/egress.js), so a loopback / RFC1918 / link-local / metadata target
 * can never be smuggled in through the proxy's configuration — the proxy sits on
 * an egress-capable network, so an allowlisted `169.254.169.254` would be a
 * cloud-credential exfiltration path, not merely a wrong answer.
 *
 * @param {string[]} hosts
 * @returns {string[]} normalized, de-duplicated, sorted
 */
export function sanitizeProxyAllowlist(hosts) {
  requireArray('EgressProxy', 'allowedHosts', hosts);
  const out = new Set();
  for (const raw of hosts) {
    const host = normalizeHost(raw);
    if (host === null) continue;
    // normalizeHost passes through anything it cannot parse as a URL, so validate
    // the SHAPE too: a garbage entry must not silently become an allowlist entry
    // (it would never match a real request, but it would hide a config error).
    if (!isPlausibleHost(host)) continue;
    // The proxy has real egress, so a host-local / metadata target must never be
    // reachable through it, however it got into the configuration.
    if (isForbiddenEgressHost(host)) continue;
    out.add(host);
  }
  return [...out].sort();
}

/**
 * Is this a syntactically plausible hostname or IP literal? A DNS label is
 * alphanumeric with internal hyphens; an IPv4 literal is four dotted octets. This
 * is a shape check, not a resolution check.
 */
function isPlausibleHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  }
  // REJECT ALTERNATE IP ENCODINGS. `2130706433` and `0177.0.0.1` are both
  // 127.0.0.1 to getaddrinfo, and both satisfy the DNS-label grammar below — so
  // without this they survived the forbidden-host filter and could be allowlisted.
  // Any label that is entirely digits (or octal/hex-looking) is not a real DNS name.
  if (/^[0-9]+$/.test(host.replace(/\./g, ''))) return false;
  if (/^0[xX][0-9a-fA-F]+$/.test(host)) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host);
}

/**
 * The proxy environment a sandbox container needs so its toolchain routes through
 * the proxy.
 *
 * Both upper- and lower-case forms are set because the ecosystem is inconsistent
 * about which it reads (curl prefers lower-case, Node and npm accept both).
 * `NO_PROXY` deliberately covers only loopback, so nothing else can bypass it.
 *
 * @param {object} args
 * @param {string} args.proxyHost  the proxy container's name on the internal network
 * @param {number} [args.proxyPort]
 * @returns {Object<string,string>} env map (name -> value)
 */
export function proxyEnvFor({ proxyHost, proxyPort = DEFAULT_PROXY_PORT } = {}) {
  if (typeof proxyHost !== 'string' || proxyHost.trim() === '') {
    fail('EgressProxy', 'proxyHost must be a non-empty string');
  }
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) {
    fail('EgressProxy', `proxyPort must be an integer in 1..65535, got ${proxyPort}`);
  }
  const url = `http://${proxyHost}:${proxyPort}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    // npm reads its own config names in preference to the generic ones.
    npm_config_proxy: url,
    npm_config_https_proxy: url,
  };
}

/**
 * The proxy program, run as `node -e <this>` inside the proxy container.
 *
 * Configuration arrives through the environment: `AAB_EGRESS_ALLOWLIST` is a
 * comma-separated host list and `AAB_EGRESS_PORT` the listen port. An absent or
 * empty allowlist denies everything — a configuration that failed to arrive must
 * never mean "allow all".
 */
export const EGRESS_PROXY_SRC = `
const http = require('node:http'), net = require('node:net'), url = require('node:url'), dns = require('node:dns');
const allowed = String(process.env.AAB_EGRESS_ALLOWLIST || '')
  .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
const port = Number(process.env.AAB_EGRESS_PORT) || ${DEFAULT_PROXY_PORT};
// Tunnellable ports. Defaults to ordinary web ports; overridable so a deploy with
// a registry on a non-standard port can work, and so the tests can drive the
// tunnel without binding a privileged port. An unparseable value falls back to the
// restrictive default rather than opening everything.
const connectPorts = (function () {
  var raw = String(process.env.AAB_EGRESS_CONNECT_PORTS || '').trim();
  if (raw === '') return ${JSON.stringify([...ALLOWED_CONNECT_PORTS])};
  var parsed = raw.split(',').map(function (s) { return Number(s.trim()); })
    .filter(function (n) { return Number.isInteger(n) && n > 0 && n <= 65535; });
  return parsed.length > 0 ? parsed : ${JSON.stringify([...ALLOWED_CONNECT_PORTS])};
})();

function log(decision, target, why) {
  console.log('aab-egress ' + decision + ' ' + target + (why ? ' (' + why + ')' : ''));
}
// DENY BY DEFAULT: an exact hostname match against a non-empty allowlist. No
// wildcards and no suffix matching — a suffix rule like '.npmjs.org' would also
// admit 'evil-npmjs.org' to a careless reader, so the operator lists real hosts.
function isAllowed(host) {
  if (allowed.length === 0) return false;
  if (!host) return false;
  // A trailing dot is the same DNS name; normalize so it cannot slip past.
  var h = String(host).toLowerCase().replace(/\\.$/, '');
  return allowed.indexOf(h) !== -1;
}

// A HOSTNAME ALLOWLIST IS NOT ENOUGH ON ITS OWN. This proxy is the one component
// with real egress, so if an allowlisted name resolves into the host, a private
// range, or the cloud metadata address, the allowlist would have handed out
// exactly the SSRF path it exists to prevent (split-horizon DNS, a hijacked
// record, or simply a mirror that points inward). So every connection resolves
// through this lookup and REFUSES a non-public answer, whatever the name was.
function isPublicAddress(ip, family) {
  if (family === 6) {
    var v6 = String(ip).toLowerCase();
    if (v6 === '::1' || v6 === '::') return false;
    if (v6.indexOf('fe80') === 0) return false;          // link-local
    if (/^f[cd]/.test(v6)) return false;                 // unique-local
    if (v6.indexOf('::ffff:') === 0) {                    // IPv4-mapped
      return isPublicAddress(v6.slice(7), 4);
    }
    return true;
  }
  var p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some(function (n) { return !Number.isInteger(n) || n < 0 || n > 255; })) return false;
  if (p[0] === 0 || p[0] === 127) return false;                       // this-host / loopback
  if (p[0] === 10) return false;                                      // RFC1918
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;         // RFC1918
  if (p[0] === 192 && p[1] === 168) return false;                     // RFC1918
  if (p[0] === 169 && p[1] === 254) return false;                     // link-local + metadata
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;        // CGNAT
  if (p[0] >= 224) return false;                                      // multicast / reserved
  return true;
}
// An on-prem registry mirror on a private address is a legitimate deployment, so
// the address check is overridable. It defaults to OFF: enabling it gives up the
// SSRF protection above, which is why it has to be an explicit decision.
var allowPrivate = /^(1|true|yes|on)$/i.test(String(process.env.AAB_EGRESS_ALLOW_PRIVATE_ADDRESSES || '').trim());
function safeLookup(hostname, options, callback) {
  var cb = typeof options === 'function' ? options : callback;
  var opts = typeof options === 'function' ? {} : (options || {});
  dns.lookup(hostname, { all: true, verbatim: true }, function (err, addresses) {
    if (err) return cb(err);
    var ok = (addresses || []).filter(function (a) { return allowPrivate || isPublicAddress(a.address, a.family); });
    if (ok.length === 0) {
      log('DENY', hostname, 'resolves only to non-public addresses');
      return cb(new Error('egress denied: ' + hostname + ' resolves to a non-public address'));
    }
    if (opts.all === true) return cb(null, ok);
    return cb(null, ok[0].address, ok[0].family);
  });
}

// Hop-by-hop headers must not be forwarded to the origin.
var HOP_BY_HOP = ['proxy-authorization', 'proxy-connection', 'proxy-authenticate',
  'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function forwardableHeaders(headers, authority) {
  var out = {};
  Object.keys(headers || {}).forEach(function (k) {
    if (HOP_BY_HOP.indexOf(k.toLowerCase()) === -1) out[k] = headers[k];
  });
  // The Host header must agree with the origin we actually connected to, so a
  // disagreeing Host cannot be used to address a different vhost than the one
  // the allowlist decision was made about.
  out.host = authority;
  return out;
}

// Plain HTTP: the request line carries an absolute URI when a client is talking to
// a proxy. We forward it verbatim to the allowed origin.
const server = http.createServer(function (req, res) {
  var target;
  try { target = new url.URL(req.url); } catch (e) { target = null; }
  if (!target || target.protocol !== 'http:') {
    // Only absolute-form http:// is forwarded. An absolute-form https:// request is
    // REFUSED rather than serviced: forwarding it would mean issuing a cleartext
    // request on the sandbox's behalf, silently downgrading a URL that asked for
    // TLS. CONNECT is the only correct path for https, and it keeps TLS end-to-end.
    var why = target && target.protocol === 'https:'
      ? 'absolute-form https:// must use CONNECT; refusing to downgrade to cleartext'
      : 'not an absolute http:// proxy request';
    log('DENY', String(req.url), why);
    res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad proxy request: ' + why); return;
  }
  if (!isAllowed(target.hostname)) {
    log('DENY', target.hostname, 'not on the egress allowlist');
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('egress denied: ' + target.hostname + ' is not on the sandbox egress allowlist');
    return;
  }
  var targetPort = Number(target.port || 80);
  // The SAME port bound as CONNECT. Without it an allowlisted host was reachable on
  // ANY port over the forward path, so the tunnel's port restriction was only half
  // the boundary.
  if (connectPorts.indexOf(targetPort) === -1) {
    log('DENY', target.hostname + ':' + targetPort, 'port ' + targetPort + ' is not permitted');
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('egress denied: port ' + targetPort + ' is not permitted'); return;
  }
  log('ALLOW', target.hostname + ':' + targetPort, 'http');
  var authority = target.port ? target.hostname + ':' + target.port : target.hostname;
  var upstream = http.request({
    host: target.hostname,
    port: targetPort,
    method: req.method,
    path: target.pathname + (target.search || ''),
    headers: forwardableHeaders(req.headers, authority),
    lookup: safeLookup
  }, function (up) {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', function (err) {
    try { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('upstream error: ' + err.message); } catch (e) {}
  });
  req.pipe(upstream);
});

// HTTPS: a CONNECT tunnel. We check the HOST and then pipe RAW BYTES — TLS is
// never terminated, so package integrity and certificate validation stay
// end-to-end between the sandbox and the registry.
server.on('connect', function (req, clientSocket, head) {
  // Parse via URL so the target is canonicalized the same way the forward path
  // canonicalizes it — a raw string split let alternate encodings of an address
  // match the allowlist here while being normalized (and rejected) there.
  var authority = String(req.url || '');
  var host = null, targetPort = 443;
  try {
    var parsed = new url.URL('http://' + authority);
    host = parsed.hostname;
    targetPort = Number(parsed.port || 443);
    // A bracketed IPv6 literal comes back bracketed from URL; net.connect wants it bare.
    if (host.charAt(0) === '[') host = host.slice(1, -1);
  } catch (e) { host = null; }
  function refuse(why) {
    log('DENY', req.url || '?', why);
    try {
      clientSocket.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
      clientSocket.end();
    } catch (e) {}
  }
  if (!host) return refuse('unparseable CONNECT target');
  if (!isAllowed(host)) return refuse('not on the egress allowlist');
  // A tunnel to an arbitrary port would turn an allowlisted host into a general
  // TCP relay, so only ordinary web ports are tunnelled.
  if (connectPorts.indexOf(targetPort) === -1) return refuse('port ' + targetPort + ' is not tunnellable');

  log('ALLOW', host + ':' + targetPort, 'connect');
  var upstream = net.connect({ port: targetPort, host: host, lookup: safeLookup }, function () {
    clientSocket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', function () {
    try { clientSocket.write('HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n'); clientSocket.end(); } catch (e) {}
  });
  clientSocket.on('error', function () { try { upstream.destroy(); } catch (e) {} });
});

server.on('clientError', function (err, socket) { try { socket.destroy(); } catch (e) {} });
server.listen(port, '0.0.0.0', function () {
  console.log('aab-egress proxy listening on 0.0.0.0:' + port + ' allowing [' + allowed.join(', ') + ']');
});
`;

/**
 * The argv that runs the proxy inside a container.
 *
 * @returns {string[]}
 */
export function proxyCommand() {
  return ['node', '-e', EGRESS_PROXY_SRC];
}

/**
 * A stable fingerprint of the effective allowlist, carried as a container label.
 *
 * WHY: a running proxy was previously adopted on its NAME alone, so an allowlist
 * change — including a REMOVAL, i.e. a revocation — never took effect, and any
 * container that happened to be called `aab-egress-proxy` became the component
 * every sandbox's traffic was pointed at. Comparing this fingerprint makes
 * adoption safe: a proxy whose policy differs from the current configuration is
 * replaced rather than trusted.
 *
 * @param {string[]} allowedHosts
 * @returns {string} hex digest of the sanitized, ordered allowlist
 */
export function allowlistFingerprint(allowedHosts) {
  const hosts = sanitizeProxyAllowlist(allowedHosts ?? []);
  return crypto.createHash('sha256').update(hosts.join(',')).digest('hex').slice(0, 32);
}

/** The label key carrying the allowlist fingerprint on the proxy container. */
export const ALLOWLIST_LABEL = 'aab.egress.allowlist';

/**
 * The environment the PROXY container itself needs (its allowlist + listen port).
 *
 * @param {object} args
 * @param {string[]} args.allowedHosts
 * @param {number} [args.proxyPort]
 * @returns {Object<string,string>}
 */
export function proxyContainerEnv({ allowedHosts, proxyPort = DEFAULT_PROXY_PORT, connectPorts } = {}) {
  const hosts = sanitizeProxyAllowlist(allowedHosts ?? []);
  const ports = Array.isArray(connectPorts)
    ? connectPorts.filter((n) => Number.isInteger(n) && n > 0 && n <= 65_535)
    : [];
  return {
    AAB_EGRESS_ALLOWLIST: hosts.join(','),
    AAB_EGRESS_PORT: String(proxyPort),
    ...(ports.length > 0 ? { AAB_EGRESS_CONNECT_PORTS: ports.join(',') } : {}),
  };
}
