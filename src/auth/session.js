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

/**
 * Absolute session lifetime cap (audit H18). A rolling ttl that resets on every
 * rotate() lets a stolen token be renewed forever, so the documented ~24h
 * lifetime was never actually enforced. We carry an immutable session start and
 * refuse to rotate/decode past `sessionStart + MAX_SESSION_LIFETIME`. Default
 * 24h so a session's total life equals the documented lifetime regardless of how
 * often it rotates; overridable for tests.
 */
export const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

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
  const maxLifetimeMs = opts.maxLifetimeMs ?? MAX_SESSION_LIFETIME_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const audit = toAuditSink(opts.auditSink);

  // Server-side session table: sessionId -> { accountId, rotation, sessionStart,
  // absExp }. Only the CURRENT rotation for a session is valid; any prior token
  // is invalidated. sessionStart/absExp are immutable across rotations and cap
  // the session's total lifetime (audit H18).
  const sessions = new Map();

  /**
   * Build + sign a token for (sessionId, accountId, rotation) at time `iat`.
   * `sessionStart`/`absExp` are the session's IMMUTABLE start and absolute
   * expiry, carried in the payload so a decode can enforce the cap even if the
   * server-side entry is gone. The per-token `exp` is min(iat+ttl, absExp) so a
   * rotation near the cap cannot extend life past it.
   */
  function mint(sessionId, accountId, rotation, iat, sessionStart, absExp) {
    const payload = {
      sid: sessionId,
      accountId,
      rot: rotation,
      iat,
      exp: Math.min(iat + ttlMs, absExp),
      sst: sessionStart,
      aexp: absExp,
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
      const sessionStart = iat;
      const absExp = sessionStart + maxLifetimeMs;
      sessions.set(sessionId, { accountId, rotation, sessionStart, absExp });
      const { token, payload } = mint(sessionId, accountId, rotation, iat, sessionStart, absExp);
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
      // REUSE DETECTION (audit H18): a token with a VALID signature but a STALE
      // rotation (rot < current) is the canonical signal that a token was
      // copied — the legitimate client already rotated past it. Do not merely
      // reject the stale token and leave the newest one alive (whoever holds it
      // may be the attacker): kill the WHOLE session family and emit a
      // high-severity event so the theft is actioned, not just observed.
      if (
        current &&
        current.accountId === payload.accountId &&
        typeof payload.rot === 'number' &&
        payload.rot < current.rotation
      ) {
        sessions.delete(payload.sid);
        audit({
          type: AUDIT_EVENTS.SESSION_REUSE_DETECTED,
          at: now(),
          severity: 'high',
          accountId: payload.accountId,
          sessionId: payload.sid,
          presentedRotation: payload.rot,
          currentRotation: current.rotation,
        });
        throw new Error('invalid session');
      }
      if (!current || current.rotation !== payload.rot || current.accountId !== payload.accountId) {
        // Rotated-out (stale) token, unknown session, or account mismatch.
        fail('rotated-or-unknown', { sessionId: payload.sid });
      }
      // ABSOLUTE LIFETIME CAP (audit H18): refuse any token past the session's
      // immutable absolute expiry, regardless of how many times it rotated. Use
      // both the payload's aexp and the server entry's absExp (defense in depth);
      // the more restrictive wins.
      const absExp = Math.min(
        typeof payload.aexp === 'number' ? payload.aexp : Infinity,
        current && typeof current.absExp === 'number' ? current.absExp : Infinity,
      );
      if (now() >= absExp) {
        sessions.delete(payload.sid);
        audit({
          type: AUDIT_EVENTS.SESSION_EXPIRED,
          at: now(),
          accountId: payload.accountId,
          sessionId: payload.sid,
          reason: 'absolute-lifetime',
        });
        throw new Error('invalid session');
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
        sessionStart: payload.sst,
        absoluteExpiresAt: absExp,
      };
    },

    /**
     * Refresh/rotate a session. Validates the presented token, increments the
     * rotation counter (invalidating the prior token), and returns a fresh
     * Session. The old token will no longer verify.
     */
    rotate(token) {
      // decode() enforces the absolute cap and reuse detection, so a session
      // past its lifetime (or a replayed stale token) can never be rotated.
      const claims = this.decode(token);
      const entry = sessions.get(claims.sessionId);
      const rotation = entry.rotation + 1;
      const iat = now();
      // The session start and absolute expiry are IMMUTABLE across rotations —
      // this is what makes the ~24h lifetime actually bounded (audit H18).
      const sessionStart = entry.sessionStart;
      const absExp = entry.absExp;
      sessions.set(claims.sessionId, { accountId: claims.accountId, rotation, sessionStart, absExp });
      const { token: newToken, payload } = mint(claims.sessionId, claims.accountId, rotation, iat, sessionStart, absExp);
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

    /**
     * Explicitly revoke a session (e.g. logout). Idempotent. When `accountId` is
     * supplied it is an OWNERSHIP check: a session is only revoked if it belongs
     * to that account (audit H18), so one account cannot revoke another's
     * session. Emits a SESSION_REVOKED audit event when a session was actually
     * removed. Returns true if a session was revoked, false otherwise.
     */
    revoke(sessionId, accountId) {
      const entry = sessions.get(sessionId);
      if (!entry) return false;
      if (accountId !== undefined && entry.accountId !== accountId) {
        // Ownership mismatch: refuse to revoke another account's session.
        audit({
          type: AUDIT_EVENTS.SESSION_REJECTED,
          at: now(),
          reason: 'revoke-ownership-mismatch',
          sessionId,
        });
        return false;
      }
      sessions.delete(sessionId);
      audit({
        type: AUDIT_EVENTS.SESSION_REVOKED,
        at: now(),
        accountId: entry.accountId,
        sessionId,
      });
      return true;
    },

    /**
     * Reap expired sessions from the server-side table (audit H18: the map was
     * never cleaned, so expired sessions accumulated for the process lifetime).
     * Removes any session past its absolute expiry. Returns the count reaped.
     * Safe to call on a timer or opportunistically.
     */
    reapExpired() {
      const t = now();
      let reaped = 0;
      for (const [sid, entry] of sessions) {
        if (typeof entry.absExp === 'number' && t >= entry.absExp) {
          sessions.delete(sid);
          reaped += 1;
        }
      }
      return reaped;
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
