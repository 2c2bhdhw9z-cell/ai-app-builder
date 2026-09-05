/**
 * Session management — short-lived SIGNED session tokens (design.md §0).
 *
 * After a successful OIDC exchange the platform issues a short-lived signed
 * session token bound to EXACTLY ONE User_Account. Tokens are signed with
 * node:crypto (HMAC-SHA256) — no JWT library, no external dependency. The token
 * is a compact `<payloadB64url>.<sigB64url>` string (JWT-style but hand-rolled
 * on stdlib): the payload carries the bound accountId, a session id, issued-at,
 * and expiry.
 *
 * Documented lifetime: ~24h (DEFAULT_SESSION_TTL_MS). Refresh/rotation renews
 * before expiry and ROTATES the token — the prior token is invalidated so a
 * leaked token has a bounded blast radius. Invalidation is tracked server-side
 * by session id + a monotonically increasing rotation counter: verifying a
 * token whose (sessionId, rotation) is not the current one is rejected.
 *
 * Session issuance/rotation/expiry are emitted to the injectable audit sink
 * (Req 25.1). The signing key never leaves this module and is never audited.
 */

import crypto from 'node:crypto';

import { AUDIT_EVENTS, toAuditSink } from './audit.js';

/** Documented session lifetime — ~24 hours. */
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Base64url encode a Buffer/string with no padding. */
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** HMAC-SHA256 signature (base64url) over `data` with `key`. */
function sign(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}

/** Constant-time signature comparison (avoids timing oracles). */
function signatureMatches(expected, actual) {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Create a SessionManager. `signingKey` (string/Buffer) signs tokens; generate
 * one with crypto.randomBytes in production. `now` is injectable for tests
 * (defaults to Date.now). `ttlMs` is the token lifetime (~24h by default).
 *
 * @param {object} opts
 * @param {string|Buffer} opts.signingKey  HMAC key (kept in-memory only)
 * @param {number} [opts.ttlMs]            token lifetime in ms
 * @param {() => number} [opts.now]        clock, for tests
 * @param {Function|{record:Function}} [opts.auditSink]  security-event sink
 */
export function createSessionManager(opts = {}) {
  const { signingKey } = opts;
  if (!signingKey || (typeof signingKey !== 'string' && !Buffer.isBuffer(signingKey))) {
    throw new TypeError('createSessionManager: signingKey must be a non-empty string or Buffer');
  }
  const ttlMs = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const audit = toAuditSink(opts.auditSink);

  // Server-side session table: sessionId -> { accountId, rotation }. Only the
  // CURRENT rotation for a session is valid; any prior token is invalidated.
  const sessions = new Map();

  /** Build + sign a token for (sessionId, accountId, rotation) at time `iat`. */
  function mint(sessionId, accountId, rotation, iat) {
    const payload = {
      sid: sessionId,
      accountId,
      rot: rotation,
      iat,
      exp: iat + ttlMs,
    };
    const payloadB64 = b64url(JSON.stringify(payload));
    const sig = sign(signingKey, payloadB64);
    return { token: `${payloadB64}.${sig}`, payload };
  }

  return {
    ttlMs,

    /**
     * Issue a brand-new session bound to exactly one User_Account. Returns a
     * Session: { token, sessionId, accountId, issuedAt, expiresAt }.
     */
    issue(userAccount) {
      const accountId = requireAccountId(userAccount);
      const iat = now();
      const sessionId = crypto.randomUUID();
      const rotation = 0;
      sessions.set(sessionId, { accountId, rotation });
      const { token, payload } = mint(sessionId, accountId, rotation, iat);
      audit({ type: AUDIT_EVENTS.SESSION_ISSUED, at: iat, accountId, sessionId });
      return {
        token,
        sessionId,
        accountId,
        issuedAt: iat,
        expiresAt: payload.exp,
      };
    },

    /**
     * Verify a token: checks signature, expiry, and that its (sessionId,
     * rotation) is the current one. Returns the decoded claims on success or
     * throws a generic Error on any failure (no detail is leaked to callers).
     * A rejection is audited.
     */
    verify(token) {
      const claims = this.decode(token);
      return claims;
    },

    /** Like verify but returns null instead of throwing (for soft checks). */
    tryVerify(token) {
      try {
        return this.decode(token);
      } catch {
        return null;
      }
    },

    /**
     * Decode + fully validate a token. Throws Error('invalid session') on any
     * failure — the same message for every cause, so verification never
     * discloses whether a token was expired vs. tampered vs. rotated out.
     */
    decode(token) {
      const fail = (reason, fields = {}) => {
        audit({ type: AUDIT_EVENTS.SESSION_REJECTED, at: now(), reason, ...fields });
        throw new Error('invalid session');
      };
      if (typeof token !== 'string' || !token.includes('.')) {
        fail('malformed');
      }
      const dot = token.indexOf('.');
      const payloadB64 = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      const expectedSig = sign(signingKey, payloadB64);
      if (!signatureMatches(expectedSig, sig)) {
        fail('bad-signature');
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      } catch {
        fail('bad-payload');
      }
      const current = sessions.get(payload.sid);
      if (!current || current.rotation !== payload.rot || current.accountId !== payload.accountId) {
        // Rotated-out (stale) token, unknown session, or account mismatch.
        fail('rotated-or-unknown', { sessionId: payload.sid });
      }
      if (now() >= payload.exp) {
        audit({
          type: AUDIT_EVENTS.SESSION_EXPIRED,
          at: now(),
          accountId: payload.accountId,
          sessionId: payload.sid,
        });
        throw new Error('invalid session');
      }
      return {
        sessionId: payload.sid,
        accountId: payload.accountId,
        rotation: payload.rot,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      };
    },

    /**
     * Refresh/rotate a session. Validates the presented token, increments the
     * rotation counter (invalidating the prior token), and returns a fresh
     * Session. The old token will no longer verify.
     */
    rotate(token) {
      const claims = this.decode(token);
      const entry = sessions.get(claims.sessionId);
      const rotation = entry.rotation + 1;
      const iat = now();
      sessions.set(claims.sessionId, { accountId: claims.accountId, rotation });
      const { token: newToken, payload } = mint(claims.sessionId, claims.accountId, rotation, iat);
      audit({
        type: AUDIT_EVENTS.SESSION_ROTATED,
        at: iat,
        accountId: claims.accountId,
        sessionId: claims.sessionId,
        rotation,
      });
      return {
        token: newToken,
        sessionId: claims.sessionId,
        accountId: claims.accountId,
        issuedAt: iat,
        expiresAt: payload.exp,
      };
    },

    /** Explicitly revoke a session (e.g. logout). Idempotent. */
    revoke(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

function requireAccountId(userAccount) {
  const id = userAccount && userAccount.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError('session must be bound to a User_Account with a non-empty id');
  }
  return id;
}
