/**
 * Thin OAuth client for talking to GitHub as our upstream identity provider.
 *
 * Three calls, all against github.com (not api.github.com for auth):
 *
 *   exchangeCodeForToken -- POST /login/oauth/access_token
 *     Called inside /callback. Swaps the code GitHub sent us for an access
 *     token (and refresh token, if the OAuth app has refresh enabled).
 *
 *   refreshGitHubToken -- POST /login/oauth/access_token
 *     Called inside /token when we're refreshing a session and the upstream
 *     GitHub access token has also aged out. Same endpoint, different grant.
 *
 *   getGitHubUser -- GET api.github.com/user
 *     Called right after exchangeCodeForToken to capture the authenticated
 *     user's login name for our session record (used for logs + future
 *     auditing). Not authentication itself -- just "who are you."
 *
 * Note on GitHub refresh tokens:
 *   GitHub only issues refresh tokens if the OAuth App has "Expire user
 *   authorization tokens" enabled in its settings. Default is off -- tokens
 *   live forever. If that setting is off, githubRefreshToken will be
 *   undefined and we never need to refresh upstream. Our own refresh flow
 *   (issuing new *our* tokens backed by the same stored GitHub token) is
 *   independent.
 */

import { OAuthConfig } from './config.js';

export interface GithubTokenResponse {
  accessToken: string;
  refreshToken?: string;
  scope: string;
  tokenType: string;            // always "bearer" from GitHub
  expiresIn?: number;           // seconds; only present if App has expiry on
  refreshTokenExpiresIn?: number;
}

/**
 * Exchange a GitHub authorisation code for a GitHub access token.
 * This is the server-to-GitHub leg after GitHub redirects the user back.
 *
 * Throws on network failure, non-2xx response, or GitHub error payload.
 */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
): Promise<GithubTokenResponse> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: `${config.baseUrl}/callback`,
    }).toString(),
  });

  return parseTokenResponse(res);
}

/**
 * Refresh a GitHub access token using the stored refresh token.
 * Only called when the GitHub OAuth App has expiring tokens enabled.
 */
export async function refreshGitHubToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<GithubTokenResponse> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  return parseTokenResponse(res);
}

/**
 * Fetch the authenticated user's GitHub login.
 * We store this on the session so logs / audits can identify which dev
 * made which call, even after their access token has rotated.
 */
export async function getGitHubUser(accessToken: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'crime-mcp-register',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub /user returned ${res.status}`);
  }
  const body = await res.json() as { login?: string };
  if (!body.login) throw new Error('GitHub /user returned no login');
  return body.login;
}

// --- internals ---------------------------------------------------------------

async function parseTokenResponse(res: Response): Promise<GithubTokenResponse> {
  if (!res.ok) {
    throw new Error(`GitHub token endpoint returned ${res.status}`);
  }

  const body = await res.json() as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (body.error) {
    throw new Error(`GitHub OAuth error: ${body.error} -- ${body.error_description ?? ''}`.trim());
  }
  if (!body.access_token) {
    throw new Error('GitHub OAuth response missing access_token');
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope ?? '',
    tokenType: body.token_type ?? 'bearer',
    expiresIn: body.expires_in,
    refreshTokenExpiresIn: body.refresh_token_expires_in,
  };
}
