/**
 * THE DENY-BY-DEFAULT EGRESS ALLOWLIST (spec subtask 5.1, Req 8.1, Req 10).
 *
 * A per-project Isolation_Boundary contains outbound network access to a small,
 * explicitly-configured set of hosts. This module is the PURE derivation of
 * that set from a Project's ConnectorBindings plus the Package_Manager registry
 * host(s). It performs NO container calls and touches no I/O, so it is fully
 * unit-testable and the same function that drives the real network namespace
 * can be exercised deterministically in the test suite.
 *
 * THE INVARIANT this module enforces:
 *   - DENY BY DEFAULT: nothing is reachable unless it is explicitly allowed.
 *   - No inbound, no lateral (peer container / host) access is EVER produced by
 *     this function — it only ever yields a flat set of allowed OUTBOUND hosts.
 *     Loopback / private / link-local / metadata targets are stripped so a
 *     misconfigured connector can never open a hole to the host or a neighbour.
 *   - Only ACTIVE ConnectorBinding endpoints contribute hosts. A binding whose
 *     status is 'removed' contributes NOTHING (adding a binding adds its
 *     host(s); removing it revokes them — this is a pure function of the
 *     current bindings, so recomputing after a change is the revocation).
 *   - The Package_Manager registry host(s) are always added (a project must be
 *     able to install its declared dependencies), and are subject to the same
 *     host-safety normalization.
 *
 * A Connector's reachable host is taken from an explicit `host`/`endpoint`/`url`
 * field on the binding (or its connector). We deliberately do NOT invent hosts
 * from a connector's category — an allowlist entry must trace to a concrete,
 * operator-supplied endpoint.
 */

import { requireArray, requireString, fail } from '../model/validate.js';

/**
 * Hostnames / IP forms that must NEVER appear in an egress allowlist because
 * they would let a sandboxed project reach the host, a neighbouring container,
 * or a cloud metadata endpoint (lateral / host access — forbidden by Req 8.1).
 */
const FORBIDDEN_HOST_EXACT = Object.freeze([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '::',
  '169.254.169.254', // cloud instance metadata
  'metadata.google.internal',
  'host.docker.internal',
  'host.containers.internal',
]);

/**
 * True when `host` denotes a loopback, unspecified, link-local, or RFC1918
 * private target — i.e. a lateral/host address we must never allow outbound to.
 * Conservative and string-based (this is an allowlist gate, not a resolver).
 */
export function isForbiddenEgressHost(host) {
  if (typeof host !== 'string') return true;
  const h = host.trim().toLowerCase();
  if (h === '') return true;
  if (FORBIDDEN_HOST_EXACT.includes(h)) return true;
  // Loopback range 127.0.0.0/8.
  if (/^127\./.test(h)) return true;
  // Link-local 169.254.0.0/16 (covers the metadata range).
  if (/^169\.254\./.test(h)) return true;
  // RFC1918 private ranges — lateral targets, never routable egress.
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  // IPv6 loopback/link-local/unique-local prefixes.
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

/**
 * Normalize a caller-supplied endpoint into a bare, lowercase hostname. Accepts
 * either a hostname ('api.stripe.com') or a URL ('https://api.stripe.com/v1');
 * strips scheme, path, port, and credentials. Returns null for empty input.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value === '') return null;
  // If it looks like a URL, let the URL parser extract the hostname; otherwise
  // treat the whole string as a host[:port] and drop the port.
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  } else {
    // host[:port][/path] — keep only the host portion.
    value = value.split('/')[0];
    if (value.startsWith('[')) {
      // Bracketed IPv6, optionally with a port: [::1]:443 -> ::1
      const close = value.indexOf(']');
      if (close !== -1) value = value.slice(1, close);
    } else {
      // Strip a trailing :port ONLY when there is exactly ONE colon and digits
      // follow it — otherwise it is a bare IPv6 literal (e.g. '::1') we must
      // leave intact.
      const colonCount = (value.match(/:/g) || []).length;
      if (colonCount === 1) {
        const [hostPart, portPart] = value.split(':');
        if (/^\d+$/.test(portPart)) value = hostPart;
      }
    }
  }
  value = value.trim().toLowerCase();
  return value === '' ? null : value;
}

/**
 * Extract the operator-supplied endpoint host(s) from a single ConnectorBinding.
 * Looks for an explicit `host`, `endpoint`, `url`, or `hosts` field on the
 * binding (preferred) or its connector. Returns an array of normalized hosts
 * (possibly empty). Does NOT apply the forbidden-host filter — that happens once
 * centrally in computeEgressAllowlist so the rule is enforced uniformly.
 *
 * @param {object} binding a ConnectorBinding-shaped object
 * @returns {string[]}
 */
export function endpointHostsForBinding(binding) {
  if (!binding || typeof binding !== 'object') return [];
  const sources = [];
  const collect = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.host !== undefined) sources.push(obj.host);
    if (obj.endpoint !== undefined) sources.push(obj.endpoint);
    if (obj.url !== undefined) sources.push(obj.url);
    if (Array.isArray(obj.hosts)) sources.push(...obj.hosts);
  };
  collect(binding);
  collect(binding.connector);
  const out = [];
  for (const s of sources) {
    const host = normalizeHost(s);
    if (host) out.push(host);
  }
  return out;
}

/**
 * Compute a project's deny-by-default egress allowlist.
 *
 * @param {object} args
 * @param {Array<object>} args.bindings              the project's ConnectorBindings
 * @param {string[]} [args.packageRegistryHosts]     Package_Manager registry host(s)
 * @returns {{ allowedHosts: string[], denyByDefault: true }} frozen result
 */
export function computeEgressAllowlist({ bindings, packageRegistryHosts = [] } = {}) {
  const model = 'EgressAllowlist';
  const list = requireArray(model, 'bindings', bindings ?? []);
  const registry = requireArray(model, 'packageRegistryHosts', packageRegistryHosts);

  // A set preserves the deny-by-default meaning (membership is the only signal)
  // and dedupes hosts contributed by multiple bindings.
  const allowed = new Set();

  // Package registry host(s): always required so a project can install its
  // declared dependencies. Subject to the same safety filter as everything else.
  for (const raw of registry) {
    const host = normalizeHost(raw);
    if (host && !isForbiddenEgressHost(host)) allowed.add(host);
  }

  // Connector-derived hosts: ONLY from ACTIVE bindings.
  for (const [i, binding] of list.entries()) {
    if (!binding || typeof binding !== 'object') {
      fail(model, `bindings[${i}] must be a ConnectorBinding object`);
    }
    // A 'removed' (or otherwise non-active) binding contributes nothing — this
    // is how removing a connector revokes its egress.
    if (binding.status !== 'active') continue;
    for (const host of endpointHostsForBinding(binding)) {
      if (!isForbiddenEgressHost(host)) allowed.add(host);
    }
  }

  return Object.freeze({
    denyByDefault: true,
    allowedHosts: Object.freeze([...allowed].sort()),
  });
}

/**
 * Reusable default: npm's public registry host. Callers pass their own
 * Package_Manager host(s); this is a convenience for the common Node case.
 */
export const DEFAULT_PACKAGE_REGISTRY_HOSTS = Object.freeze(['registry.npmjs.org']);
