/**
 * Token primitives for the MCP OAuth server.
 *
 * Two token types:
 *   - Access tokens -- short-lived (1h), used as Bearer on every MCP request
 *   - Refresh tokens -- longer-lived (2d), exchanged at /token for a new access
 *
 * Both are crypto-random, URL-safe, opaque strings. They are NOT JWTs -- we
 * look them up in the in-memory session store rather than verify a signature.
 * This means revocation is trivial (delete from store) and there is no key
 * management. The tradeoff is that stateless verification is not possible --
 * but we already have state (the session store) for the GitHub tokens, so
 * the additional lookup cost is free.
 *
 * Auth-code (intermediate, single-use) is generated the same way but expires
 * within seconds -- it's only held long enough to bridge the /callback ->
 * /token exchange. See store.ts for its lifetime rules.
 *
 * Design choice: fixed-length 48-byte (64-char base64url) tokens. Plenty of
 * entropy for opaque bearer tokens; shorter than JWTs; fast to generate.
 */

import { randomBytes } from 'node:crypto';

export const ACCESS_TOKEN_TTL_MS  = 60 * 60 * 1000;            // 1 hour
export const REFRESH_TOKEN_TTL_MS = 2 * 24 * 60 * 60 * 1000;   // 2 days
export const AUTH_CODE_TTL_MS     = 60 * 1000;                 // 60 seconds

/** Token byte length. 48 bytes = 384 bits of entropy, rendered as 64 base64url chars. */
const TOKEN_BYTES = 48;

export function generateAccessToken(): string {
  return randomToken();
}

export function generateRefreshToken(): string {
  return randomToken();
}

export function generateAuthCode(): string {
  return randomToken();
}

/** Base64url-encoded random bytes -- URL-safe, no padding. */
function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}
