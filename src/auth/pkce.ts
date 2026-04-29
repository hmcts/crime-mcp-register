/**
 * PKCE (Proof Key for Code Exchange) -- RFC 7636.
 *
 * Claude Code always uses PKCE with method S256. Our job on the server:
 *   1. /authorize: receive a code_challenge (derived from a verifier we
 *      never see), stash it alongside the auth flow state.
 *   2. /token: receive a code_verifier from the client, hash it using
 *      SHA-256 + base64url, compare against the stored challenge.
 *      Reject on mismatch.
 *
 * We do NOT generate verifiers ourselves -- that's the client's job
 * (Claude Code). We only validate.
 *
 * Spec reference: RFC 7636 section 4.6 -- challenge = BASE64URL(SHA256(verifier))
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Verify a PKCE code_verifier matches a stored code_challenge.
 * Uses timing-safe comparison to avoid leaking info about partial matches.
 *
 * Only method "S256" is supported -- the only method Claude Code sends,
 * and the only method OAuth 2.1 permits for public clients.
 *
 * Returns true on match, false on mismatch or malformed input.
 */
export function verifyPkce(verifier: string, storedChallenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  if (!verifier || !storedChallenge) return false;

  // Verifier spec: 43-128 chars, [A-Z a-z 0-9 - . _ ~]
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;

  const computed = createHash('sha256').update(verifier).digest('base64url');

  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(computed);
  const b = Buffer.from(storedChallenge);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
