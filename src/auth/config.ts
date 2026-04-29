/**
 * OAuth configuration for the MCP auth layer.
 *
 * Configuration precedence:
 *   1. Explicit values passed at construction time (for tests)
 *   2. Environment variables
 *   3. No defaults for secrets -- refuse to start if missing
 *
 * Environment variables:
 *   GITHUB_OAUTH_CLIENT_ID     -- from the GitHub OAuth App
 *   GITHUB_OAUTH_CLIENT_SECRET -- from the GitHub OAuth App (keep secret)
 *   OAUTH_BASE_URL             -- public URL of this server, e.g.
 *                                http://localhost:3000 for dev,
 *                                https://mcp.example.com in prod
 *
 * OAUTH_BASE_URL must match the callback URL configured on the GitHub OAuth
 * App -- if they disagree, GitHub rejects the callback with
 * "redirect_uri_mismatch". For local dev, both should be
 * http://localhost:3000.
 */

export interface OAuthConfig {
  githubClientId: string;
  githubClientSecret: string;
  baseUrl: string;
}

/**
 * Load OAuth config from the environment.
 * Returns undefined if any required value is missing -- signals to the caller
 * that auth should be disabled (stdio mode, or SSE without auth for dev).
 */
export function loadOAuthConfigFromEnv(): OAuthConfig | undefined {
  const id  = process.env.GITHUB_OAUTH_CLIENT_ID;
  const sec = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const url = process.env.OAUTH_BASE_URL;

  if (!id || !sec || !url) return undefined;

  // Sanity: baseUrl must be a full URL with scheme, no trailing slash
  const normalized = url.replace(/\/+$/, '');
  try {
    new URL(normalized);
  } catch {
    throw new Error(`OAUTH_BASE_URL is not a valid URL: ${url}`);
  }

  return {
    githubClientId: id,
    githubClientSecret: sec,
    baseUrl: normalized,
  };
}
