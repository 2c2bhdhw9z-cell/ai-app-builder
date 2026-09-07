/**
 * THE CONNECTOR CATALOG (spec Task 21.1, Req 10.1).
 *
 * A frozen, offline table of the concrete external-service Connectors the
 * platform offers, covering EVERY Connector_Category from src/model/enums.js:
 *
 *   database        e.g. Supabase, Neon
 *   auth            e.g. Clerk, Auth0
 *   payments        e.g. Stripe
 *   hosting-deploy  e.g. Vercel, Netlify, Expo EAS (deploy destinations)
 *   storage         e.g. Cloudflare R2
 *   ai-model        e.g. an LLM/vision API the GENERATED app calls
 *
 * Each entry declares, purely as static metadata (no I/O here):
 *   - service     the human/lookup name (unique within the catalog)
 *   - category    a Connector_Category, validated via isValidConnectorCategory
 *   - captureKind 'oauth' | 'api-key' (CONNECTOR_CAPTURE_KINDS) — how this
 *                 Connector's credential capture flow runs (Req 10.2)
 *   - envNames    the env-var NAME(s) the captured credential(s) map to. These
 *                 are the ONLY thing that surfaces into generated code / the
 *                 steering manifest (reference-by-NAME, never a literal — Req
 *                 10.4/10.5/11.4). Each must be a valid SecretStore name (see
 *                 ENV_NAME_RE) and must NOT collide with RESERVED_ENV_NAMES.
 *   - hosts       the connector's egress endpoint host(s), so egress.js can add
 *                 them to the deny-by-default allowlist for an ACTIVE binding
 *                 (Req 10, and revoke them when the binding is removed).
 *
 * ═══ THE ai-model DISTINCTION (Req 10.1, kept explicit on purpose) ═══
 * An `ai-model` Connector is a service the GENERATED APP calls at its own
 * runtime (e.g. the app makes an LLM/vision API request using the injected
 * Secret). It is DELIBERATELY DISTINCT from the builder's OWN model provider —
 * createAnthropicProvider / createGeminiProvider / createOpenRouterProvider,
 * which are re-exported through the plumby boundary (src/engine/plumby.js) and
 * drive the Builder_Agent itself. NOTHING in this catalog wires an ai-model
 * entry to the builder's provider: the catalog only names the app-facing
 * service's env-var + endpoint host. The two never share a credential or a code
 * path.
 */

import { Connector_Category, isValidConnectorCategory } from '../model/enums.js';
import { CONNECTOR_CAPTURE_KINDS } from '../model/connector.js';
import { RESERVED_ENV_NAMES } from '../secrets/secret-store.js';
import { fail } from '../model/validate.js';

/** A catalog entry's env NAME must be a valid, non-reserved SecretStore name. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The raw catalog entries. At least one concrete Connector per category (Req
 * 10.1). Endpoint hosts are the operator-supplied hosts egress.js allowlists
 * for an ACTIVE binding — bare hostnames (no scheme), matching egress
 * normalizeHost's expectations.
 */
const RAW_ENTRIES = [
  // ── database ──────────────────────────────────────────────────────────
  {
    service: 'supabase',
    category: 'database',
    captureKind: 'oauth',
    envNames: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    hosts: ['api.supabase.com'],
  },
  {
    service: 'neon',
    category: 'database',
    captureKind: 'api-key',
    envNames: ['NEON_DATABASE_URL'],
    hosts: ['console.neon.tech'],
  },
  // ── auth ──────────────────────────────────────────────────────────────
  {
    service: 'clerk',
    category: 'auth',
    captureKind: 'api-key',
    envNames: ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'],
    hosts: ['api.clerk.com'],
  },
  {
    service: 'auth0',
    category: 'auth',
    captureKind: 'oauth',
    envNames: ['AUTH0_DOMAIN', 'AUTH0_CLIENT_SECRET'],
    hosts: ['auth0.com'],
  },
  // ── payments ──────────────────────────────────────────────────────────
  {
    service: 'stripe',
    category: 'payments',
    captureKind: 'api-key',
    envNames: ['STRIPE_SECRET_KEY'],
    hosts: ['api.stripe.com'],
  },
  // ── hosting-deploy (deploy destinations — Req 10.8) ─────────────────────
  {
    service: 'vercel',
    category: 'hosting-deploy',
    captureKind: 'oauth',
    envNames: ['VERCEL_TOKEN'],
    hosts: ['api.vercel.com'],
  },
  {
    service: 'netlify',
    category: 'hosting-deploy',
    captureKind: 'oauth',
    envNames: ['NETLIFY_AUTH_TOKEN'],
    hosts: ['api.netlify.com'],
  },
  {
    service: 'expo-eas',
    category: 'hosting-deploy',
    captureKind: 'api-key',
    envNames: ['EXPO_TOKEN'],
    hosts: ['api.expo.dev'],
  },
  // ── storage ───────────────────────────────────────────────────────────
  {
    service: 'cloudflare-r2',
    category: 'storage',
    captureKind: 'api-key',
    envNames: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
    hosts: ['cloudflarestorage.com'],
  },
  // ── ai-model (a service the GENERATED APP calls — DISTINCT from the ─────
  //    builder's own provider; see the module header) ─────────────────────
  {
    service: 'openai-api',
    category: 'ai-model',
    captureKind: 'api-key',
    envNames: ['OPENAI_API_KEY'],
    hosts: ['api.openai.com'],
  },
];

/** Validate + freeze a single raw catalog entry into a normalized record. */
function normalizeEntry(raw) {
  const model = 'ConnectorCatalog';
  if (!raw || typeof raw !== 'object') fail(model, 'each catalog entry must be an object');
  const service = raw.service;
  if (typeof service !== 'string' || service.trim() === '') {
    fail(model, 'each catalog entry needs a non-empty service name');
  }
  if (!isValidConnectorCategory(raw.category)) {
    fail(
      model,
      `entry ${JSON.stringify(service)} category must be one of [${Connector_Category.join(', ')}], got ${JSON.stringify(raw.category)}`,
    );
  }
  if (!CONNECTOR_CAPTURE_KINDS.includes(raw.captureKind)) {
    fail(
      model,
      `entry ${JSON.stringify(service)} captureKind must be one of [${CONNECTOR_CAPTURE_KINDS.join(', ')}], got ${JSON.stringify(raw.captureKind)}`,
    );
  }
  if (!Array.isArray(raw.envNames) || raw.envNames.length === 0) {
    fail(model, `entry ${JSON.stringify(service)} must declare at least one env-var NAME`);
  }
  for (const name of raw.envNames) {
    if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) {
      fail(model, `entry ${JSON.stringify(service)} env name ${JSON.stringify(name)} must match ${ENV_NAME_RE}`);
    }
    if (RESERVED_ENV_NAMES.has(name)) {
      fail(model, `entry ${JSON.stringify(service)} env name ${JSON.stringify(name)} is a reserved/dangerous env-var`);
    }
  }
  const hosts = Array.isArray(raw.hosts) ? raw.hosts : [];
  for (const host of hosts) {
    if (typeof host !== 'string' || host.trim() === '') {
      fail(model, `entry ${JSON.stringify(service)} egress host must be a non-empty string`);
    }
  }
  return Object.freeze({
    service,
    category: raw.category,
    captureKind: raw.captureKind,
    envNames: Object.freeze([...raw.envNames]),
    hosts: Object.freeze([...hosts]),
  });
}

/**
 * Build a frozen Connector_Catalog with lookup + list surfaces.
 *
 * @param {object} [args]
 * @param {Array<object>} [args.entries]  override the built-in entries (tests)
 * @returns {object} a frozen catalog
 */
export function createConnectorCatalog({ entries = RAW_ENTRIES } = {}) {
  const model = 'ConnectorCatalog';
  const normalized = entries.map(normalizeEntry);

  const byService = new Map();
  for (const entry of normalized) {
    if (byService.has(entry.service)) {
      fail(model, `duplicate catalog service ${JSON.stringify(entry.service)}`);
    }
    byService.set(entry.service, entry);
  }

  // Every category MUST have at least one concrete Connector (Req 10.1).
  for (const category of Connector_Category) {
    if (!normalized.some((e) => e.category === category)) {
      fail(model, `Connector_Catalog is missing an entry for category ${JSON.stringify(category)}`);
    }
  }

  /** Look up a catalog entry by exact service name, or null. */
  function get(service) {
    return byService.get(service) ?? null;
  }

  /** Whether a service exists in the catalog. */
  function has(service) {
    return byService.has(service);
  }

  /** All catalog entries (frozen array). */
  function list() {
    return normalized;
  }

  /** All entries in a given Connector_Category (frozen array; [] if unknown). */
  function listByCategory(category) {
    return Object.freeze(normalized.filter((e) => e.category === category));
  }

  /** The distinct categories present in the catalog. */
  function categories() {
    return Object.freeze([...new Set(normalized.map((e) => e.category))]);
  }

  return Object.freeze({
    get,
    has,
    list,
    listByCategory,
    categories,
  });
}

/** The default, built-in Connector_Catalog instance. */
export const defaultConnectorCatalog = createConnectorCatalog();
