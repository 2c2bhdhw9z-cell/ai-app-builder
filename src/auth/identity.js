/**
 * IdentityManager — OAuth 2.0 / OIDC delegated authentication (design.md §0).
 *
 * The platform stores NO passwords or credentials of its own. Sign-in is
 * delegated to a third-party identity provider (GitHub, Google); the platform
 * receives only the IdP-issued subject/identity and records it as
 * `User_Account.authIdentity`. There is no in-house password database.
 *
 * The IdP is modeled as an INJECTABLE verifier interface so there are no real
 * network calls (tests supply a fake). A verifier is any object exposing:
 *   - verifyIdToken(idToken) -> { provider, subject, ... }   (OIDC id_token), or
 *   - exchangeCode(code)     -> { provider, subject, ... }    (auth-code grant)
 * Either shape is accepted. The returned claims MUST carry a stable `subject`
 * and a `provider`; the platform derives `authIdentity = "<provider>:<subject>"`.
 *
 * Accounts are looked up/created by authIdentity via an injectable account
 * store (default: in-memory). No password field is ever set on the account.
 */

import crypto from 'node:crypto';

import { createUserAccount } from '../model/account.js';

/** Providers the platform delegates to (design.md §0). */
export const SUPPORTED_IDP_PROVIDERS = Object.freeze(['github', 'google']);

/** Compose the stable platform identity string from IdP claims. */
export function toAuthIdentity(claims) {
  if (!claims || typeof claims !== 'object') {
    throw new TypeError('IdP claims must be an object');
  }
  const { provider, subject } = claims;
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw new TypeError('IdP claims must include a non-empty provider');
  }
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new TypeError('IdP claims must include a non-empty subject');
  }
  return `${provider}:${subject}`;
}

/**
 * Minimal in-memory account store keyed by authIdentity. Real persistence is a
 * later task; the interface (find/create) is what matters here.
 */
export function createInMemoryAccountStore() {
  const byIdentity = new Map();
  return {
    findByAuthIdentity(authIdentity) {
      return byIdentity.get(authIdentity) ?? null;
    },
    save(account) {
      byIdentity.set(account.authIdentity, account);
      return account;
    },
    all() {
      return [...byIdentity.values()];
    },
  };
}

/**
 * Create an IdentityManager.
 *
 * @param {object} opts
 * @param {{verifyIdToken?:Function, exchangeCode?:Function}} opts.idpVerifier
 *        injectable IdP; must expose verifyIdToken and/or exchangeCode
 * @param {object} [opts.accountStore]  find/create accounts (default in-memory)
 * @param {() => number} [opts.now]     clock, for tests
 */
export function createIdentityManager(opts = {}) {
  const { idpVerifier } = opts;
  if (!idpVerifier || (typeof idpVerifier.verifyIdToken !== 'function' && typeof idpVerifier.exchangeCode !== 'function')) {
    throw new TypeError(
      'createIdentityManager: idpVerifier must expose verifyIdToken(idToken) and/or exchangeCode(code)',
    );
  }
  const accountStore = opts.accountStore ?? createInMemoryAccountStore();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /**
   * Verify a delegated identity from the request and return a User_Account.
   * Accepts a request carrying either an OIDC `idToken` or an auth-code `code`.
   * Returns { account } on success or { denied: true, reason } on failure.
   * On denial no Project contents are disclosed — this only reports authn state.
   */
  async function authenticate(request = {}) {
    let claims;
    try {
      if (request.idToken !== undefined && typeof idpVerifier.verifyIdToken === 'function') {
        claims = await idpVerifier.verifyIdToken(request.idToken);
      } else if (request.code !== undefined && typeof idpVerifier.exchangeCode === 'function') {
        claims = await idpVerifier.exchangeCode(request.code);
      } else {
        return { denied: true, reason: 'no-credential' };
      }
    } catch {
      // The IdP rejected the token/code. Do not leak the underlying cause.
      return { denied: true, reason: 'idp-rejected' };
    }

    if (!claims) {
      return { denied: true, reason: 'idp-rejected' };
    }

    let authIdentity;
    try {
      authIdentity = toAuthIdentity(claims);
    } catch {
      return { denied: true, reason: 'invalid-claims' };
    }

    // Look up an existing account for this delegated identity, or create one.
    // NOTE: only authIdentity is recorded; there is NO password field, ever.
    let account = accountStore.findByAuthIdentity(authIdentity);
    if (!account) {
      account = createUserAccount({
        id: crypto.randomUUID(),
        authIdentity,
        createdAt: new Date(now()).toISOString(),
      });
      accountStore.save(account);
    }
    return { account };
  }

  return { authenticate, accountStore };
}
