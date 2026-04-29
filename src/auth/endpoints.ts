/**
 * HTTP endpoint handlers for the MCP OAuth proxy.
 *
 * Six endpoints cover the full OAuth 2.1 + RFC 7591 + RFC 8414 flow:
 *
 *   GET  /.well-known/oauth-authorization-server
 *        RFC 8414 metadata. Claude Code hits this first to discover our
 *        auth + token + register endpoints.
 *
 *   POST /register
 *        RFC 7591 Dynamic Client Registration. Claude Code auto-registers
 *        itself without pre-shared credentials. We issue a client_id per
 *        registration; since we're a proxy and the real client_id is our
 *        own GitHub OAuth App's (kept server-side), the client_id we hand
 *        out here is effectively opaque to Claude Code -- it echoes it back
 *        on every subsequent auth request but we don't check it against
 *        secrets. This is the standard pattern for public clients + PKCE.
 *
 *   GET  /authorize
 *        Entry point for the browser flow. Claude Code redirects the user's
 *        browser here with state + PKCE challenge. We stash the state,
 *        then redirect the browser on to github.com/login/oauth/authorize
 *        with our GitHub App's client_id and our /callback URL.
 *
 *   GET  /callback
 *        GitHub redirects here after the user authorises. We exchange the
 *        GitHub code for a GitHub token, fetch the user's login, generate
 *        our own single-use auth code, and redirect back to Claude Code's
 *        redirect_uri with it. Our auth code is short-lived (60s) -- it
 *        exists only to bridge this redirect -> Claude Code's immediate
 *        /token POST.
 *
 *   POST /token
 *        Two grant types:
 *          authorization_code -- exchange our single-use auth code + PKCE
 *                               verifier for our own access + refresh tokens
 *          refresh_token      -- exchange our refresh token for a new access
 *                               token (and, if near-expiry, new refresh)
 *
 *   (No /revoke endpoint in v1 -- sessions expire via TTL. See OAUTH_HANDOVER.)
 *
 * Design note: all handlers are pure functions of (req, res, deps). The
 * deps struct carries the store + config + github client. This keeps the
 * handlers easy to test without standing up an HTTP server.
 *
 * Spec refs:
 *   MCP authorization: https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization
 *   OAuth 2.1 draft:   https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/
 *   RFC 7591:          https://datatracker.ietf.org/doc/html/rfc7591
 *   RFC 8414:          https://datatracker.ietf.org/doc/html/rfc8414
 *   RFC 7636 (PKCE):   https://datatracker.ietf.org/doc/html/rfc7636
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { OAuthConfig } from './config.js';
import type { AuthStore, Session } from './store.js';
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  generateAccessToken,
  generateRefreshToken,
  generateAuthCode,
} from './tokens.js';
import { verifyPkce } from './pkce.js';
import { exchangeCodeForToken, refreshGitHubToken, getGitHubUser } from './github.js';

export interface AuthDeps {
  store: AuthStore;
  config: OAuthConfig;
  /** GitHub scopes we request. Default fine for public-repo read. */
  scopes?: string;
}

const DEFAULT_SCOPES = 'read:user';

// --- /.well-known/oauth-authorization-server --------------------------------

export function handleMetadata(res: ServerResponse, deps: AuthDeps): void {
  const base = deps.config.baseUrl;
  const body = {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],   // public clients, PKCE-only
  };
  respondJson(res, 200, body);
}

// --- POST /register (RFC 7591) ----------------------------------------------

export async function handleRegister(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): Promise<void> {
  const body = await readJsonBody(req).catch(() => null);
  if (!body) return respondError(res, 400, 'invalid_client_metadata', 'body must be JSON');

  // We honour client-provided redirect_uris; Claude Code sends e.g.
  // http://127.0.0.1:<port>/callback. We don't pre-validate them beyond
  // "looks like a URL" -- the real trust anchor is PKCE.
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return respondError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array');
  }

  const clientId = 'mcp-' + randomUUID();
  respondJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Echo back anything else the client declared -- standard practice
    ...(body.client_name ? { client_name: body.client_name } : {}),
  });

  // Note: we do not persist the client registration. Validation happens per-request
  // via PKCE + the pending-auth state + the one-time auth code. This keeps the
  // store simpler and is acceptable for public clients.
  void deps;
}

// --- GET /authorize ---------------------------------------------------------

export function handleAuthorize(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): void {
  const url = new URL(req.url!, deps.config.baseUrl);
  const p = url.searchParams;

  const clientId       = p.get('client_id');
  const redirectUri    = p.get('redirect_uri');
  const responseType   = p.get('response_type');
  const codeChallenge  = p.get('code_challenge');
  const challengeMethod= p.get('code_challenge_method');
  const state          = p.get('state');
  const scope          = p.get('scope') ?? undefined;

  if (!clientId || !redirectUri || !codeChallenge || !state) {
    return respondError(res, 400, 'invalid_request', 'missing required parameter');
  }
  if (responseType !== 'code') {
    return respondError(res, 400, 'unsupported_response_type', 'only code is supported');
  }
  if (challengeMethod !== 'S256') {
    return respondError(res, 400, 'invalid_request', 'code_challenge_method must be S256');
  }

  // Stash the pending auth state, keyed by a value we pass to GitHub as ITS
  // state parameter -- that's what comes back on /callback. We could reuse
  // the client's state, but decoupling them (ours <-> theirs) keeps the
  // logic clearer and avoids the temptation to trust client-supplied keys.
  const ourState = randomUUID();
  const now = Date.now();
  deps.store.putPending(ourState, {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: challengeMethod,
    state,
    scope,
    createdAt: now,
    expiresAt: now + AUTH_CODE_TTL_MS * 10,   // 10 minutes to complete the redirect dance
  });

  // Build the GitHub authorize URL with our own OAuth App's client_id + callback
  const ghUrl = new URL('https://github.com/login/oauth/authorize');
  ghUrl.searchParams.set('client_id', deps.config.githubClientId);
  ghUrl.searchParams.set('redirect_uri', `${deps.config.baseUrl}/callback`);
  ghUrl.searchParams.set('scope', deps.scopes ?? DEFAULT_SCOPES);
  ghUrl.searchParams.set('state', ourState);

  res.writeHead(302, { 'Location': ghUrl.toString() });
  res.end();
}

// --- GET /callback ----------------------------------------------------------

export async function handleCallback(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): Promise<void> {
  const url = new URL(req.url!, deps.config.baseUrl);
  const p = url.searchParams;

  const code   = p.get('code');
  const state  = p.get('state');
  const ghErr  = p.get('error');

  if (ghErr) {
    return respondErrorHtml(res, 400,
      `GitHub authorisation failed: ${ghErr}. You can close this tab.`);
  }
  if (!code || !state) {
    return respondErrorHtml(res, 400,
      'Invalid callback -- missing code or state. You can close this tab.');
  }

  // Retrieve our pending-auth entry; takePendingByState is single-use
  const pending = deps.store.takePendingByState(state);
  if (!pending) {
    return respondErrorHtml(res, 400,
      'Authorisation state expired or unknown. Please restart the sign-in. You can close this tab.');
  }

  // Exchange GitHub's code for a GitHub token
  let ghToken;
  try {
    ghToken = await exchangeCodeForToken(deps.config, code);
  } catch (err: any) {
    console.error('[oauth] github exchange failed:', err.message);
    return respondErrorHtml(res, 502,
      'GitHub token exchange failed. You can close this tab and try again.');
  }

  // Capture the user's login so we can log/audit later
  let githubUserLogin: string;
  try {
    githubUserLogin = await getGitHubUser(ghToken.accessToken);
  } catch (err: any) {
    console.error('[oauth] github getUser failed:', err.message);
    return respondErrorHtml(res, 502,
      'Could not verify GitHub user. You can close this tab and try again.');
  }

  // Generate our own single-use auth code. The client will exchange it at
  // /token within 60 seconds.
  const ourAuthCode = generateAuthCode();
  const now = Date.now();
  deps.store.putPendingWithCode({
    ...pending,
    ourAuthCode,
    githubAccessToken: ghToken.accessToken,
    githubRefreshToken: ghToken.refreshToken,
    githubUserLogin,
    expiresAt: now + AUTH_CODE_TTL_MS,
  });

  // Redirect back to the client's redirect_uri with our code + their state
  const back = new URL(pending.redirectUri);
  back.searchParams.set('code', ourAuthCode);
  back.searchParams.set('state', pending.state);

  res.writeHead(302, { 'Location': back.toString() });
  res.end();

  console.error(`[oauth] authorised github user: ${githubUserLogin}`);
}

// --- POST /token ------------------------------------------------------------

export async function handleToken(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): Promise<void> {
  const body = await readFormBody(req).catch(() => null);
  if (!body) return respondError(res, 400, 'invalid_request', 'body must be form-encoded');

  const grantType = body.get('grant_type');

  if (grantType === 'authorization_code') {
    return handleCodeGrant(body, res, deps);
  }
  if (grantType === 'refresh_token') {
    return handleRefreshGrant(body, res, deps);
  }
  return respondError(res, 400, 'unsupported_grant_type', `grant_type must be authorization_code or refresh_token`);
}

async function handleCodeGrant(body: URLSearchParams, res: ServerResponse, deps: AuthDeps): Promise<void> {
  const code         = body.get('code');
  const clientId     = body.get('client_id');
  const codeVerifier = body.get('code_verifier');
  const redirectUri  = body.get('redirect_uri');

  if (!code || !clientId || !codeVerifier || !redirectUri) {
    return respondError(res, 400, 'invalid_request', 'missing required parameter');
  }

  const pending = deps.store.takePendingByAuthCode(code);
  if (!pending) {
    return respondError(res, 400, 'invalid_grant', 'unknown or expired authorization code');
  }

  // Validate the client / redirect match what we saw on /authorize
  if (pending.clientId !== clientId) {
    return respondError(res, 400, 'invalid_grant', 'client_id mismatch');
  }
  if (pending.redirectUri !== redirectUri) {
    return respondError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
  }
  if (!verifyPkce(codeVerifier, pending.codeChallenge, pending.codeChallengeMethod)) {
    return respondError(res, 400, 'invalid_grant', 'pkce verification failed');
  }

  // Mint our own tokens
  const now = Date.now();
  const session: Session = {
    ourAccessToken: generateAccessToken(),
    ourRefreshToken: generateRefreshToken(),
    ourAccessExpiresAt: now + ACCESS_TOKEN_TTL_MS,
    ourRefreshExpiresAt: now + REFRESH_TOKEN_TTL_MS,
    githubAccessToken: pending.githubAccessToken,
    githubRefreshToken: pending.githubRefreshToken,
    githubUserLogin: pending.githubUserLogin,
    clientId: pending.clientId,
  };
  deps.store.putSession(session);

  respondJson(res, 200, {
    access_token: session.ourAccessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: session.ourRefreshToken,
    scope: pending.scope ?? deps.scopes ?? DEFAULT_SCOPES,
  });
}

async function handleRefreshGrant(body: URLSearchParams, res: ServerResponse, deps: AuthDeps): Promise<void> {
  const refreshToken = body.get('refresh_token');
  if (!refreshToken) {
    return respondError(res, 400, 'invalid_request', 'refresh_token required');
  }

  const session = deps.store.getSessionByRefreshToken(refreshToken);
  if (!session) {
    return respondError(res, 400, 'invalid_grant', 'unknown or expired refresh_token');
  }

  // Refresh upstream GitHub token if we have a refresh token for it AND it's
  // time to rotate. For the v1 path this is only when the GitHub OAuth App
  // has "expiring tokens" turned on.
  let newGhAccess: string | undefined;
  let newGhRefresh: string | undefined;
  if (session.githubRefreshToken) {
    try {
      const refreshed = await refreshGitHubToken(deps.config, session.githubRefreshToken);
      newGhAccess = refreshed.accessToken;
      newGhRefresh = refreshed.refreshToken;
    } catch (err: any) {
      // If upstream refresh fails, we still issue a new access token backed
      // by the existing (possibly soon-expiring) GitHub token. Next tool
      // call may fail against GitHub and then Claude Code re-auths.
      console.error('[oauth] upstream github refresh failed:', err.message);
    }
  }

  // Rotate our own access + refresh tokens. Refresh rotation is
  // defence-in-depth -- reuse detection is easier when tokens are one-use.
  const now = Date.now();
  const newAccess = generateAccessToken();
  const newRefresh = generateRefreshToken();
  deps.store.rotateSession(
    session.ourAccessToken,
    newAccess,
    now + ACCESS_TOKEN_TTL_MS,
    newRefresh,
    now + REFRESH_TOKEN_TTL_MS,
    newGhAccess,
    newGhRefresh,
  );

  respondJson(res, 200, {
    access_token: newAccess,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: newRefresh,
  });
}

// --- response helpers -------------------------------------------------------

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
  });
  res.end(JSON.stringify(body));
}

function respondError(res: ServerResponse, status: number, error: string, description?: string): void {
  respondJson(res, status, {
    error,
    ...(description ? { error_description: description } : {}),
  });
}

function respondErrorHtml(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Sign-in error</title><body style="font-family: sans-serif; padding: 2em; max-width: 40em"><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p></body>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  return JSON.parse(raw);
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(req);
  return new URLSearchParams(raw);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// --- middleware -------------------------------------------------------------

/**
 * Extract + validate a Bearer token from an incoming request.
 *
 * Returns the matched session on success. Returns undefined AND writes a
 * 401 response on failure, so callers can just check for undefined and
 * return early without writing to res themselves.
 *
 * Per RFC 6750, 401 responses carry a WWW-Authenticate header so the client
 * can trigger its re-auth flow. Claude Code uses this header to know it
 * should prompt the user to sign in again.
 */
export function authenticateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AuthDeps,
): import('./store.js').Session | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    writeUnauthorized(res, deps, 'missing or malformed Authorization header');
    return undefined;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    writeUnauthorized(res, deps, 'empty Bearer token');
    return undefined;
  }

  const session = deps.store.getSessionByAccessToken(token);
  if (!session) {
    writeUnauthorized(res, deps, 'invalid or expired access token');
    return undefined;
  }

  return session;
}

function writeUnauthorized(res: ServerResponse, deps: AuthDeps, description: string): void {
  // Conform to RFC 6750 section 3 -- WWW-Authenticate with Bearer scheme, realm, and error details.
  // The `resource_metadata` hint is an MCP-spec extension pointing the client at our
  // authorization metadata URL so it can kick off re-auth without further discovery.
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate':
      `Bearer realm="${deps.config.baseUrl}", ` +
      `error="invalid_token", ` +
      `error_description="${description.replace(/"/g, '\\"')}", ` +
      `resource_metadata="${deps.config.baseUrl}/.well-known/oauth-authorization-server"`,
  });
  res.end(JSON.stringify({ error: 'invalid_token', error_description: description }));
}
