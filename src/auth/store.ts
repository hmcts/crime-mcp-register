/**
 * In-memory session store for the OAuth auth layer.
 *
 * Two kinds of entries:
 *
 *   Pending auth state -- short-lived (60s) record created when Claude Code
 *   hits /authorize, holding the PKCE challenge + redirect_uri until GitHub
 *   redirects back to /callback. Once the user's GitHub code is exchanged
 *   and our own auth-code is issued, the entry is rewritten keyed by our
 *   auth-code and still short-lived (60s).
 *
 *   Session -- long-lived (up to refresh TTL) record created when the client
 *   exchanges our auth-code at /token. Holds both our token pair and the
 *   upstream GitHub token pair. Looked up by access token (every tool call)
 *   or refresh token (on /token refresh grant).
 *
 * Design choices:
 *   - Three Maps for O(1) lookup by three different keys (access, refresh,
 *     auth-code). Each session is stored once; map values hold shared references.
 *   - Periodic GC rather than per-access expiry check. Lazy expiry would
 *     work too, but GC bounds memory growth in the face of many short-lived
 *     sessions with no follow-up traffic.
 *   - No persistence. Server restart = everyone re-auths. Documented decision.
 *
 * Concurrency:
 *   Node single-threaded event loop means Map mutations are atomic from the
 *   caller's perspective. No locks needed.
 */

export interface PendingAuth {
  // Values Claude Code sent on /authorize
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;              // Claude Code's state, echoed back on redirect
  scope?: string;
  // Ours
  createdAt: number;
  expiresAt: number;
}

export interface PendingAuthWithCode extends PendingAuth {
  // Populated after /callback receives the GitHub code
  ourAuthCode: string;
  // GitHub tokens captured at callback time -- held briefly until /token exchange
  githubAccessToken: string;
  githubRefreshToken?: string;
  githubUserLogin: string;
}

export interface Session {
  // Tokens we issued to Claude Code
  ourAccessToken: string;
  ourRefreshToken: string;
  ourAccessExpiresAt: number;
  ourRefreshExpiresAt: number;
  // Upstream GitHub tokens
  githubAccessToken: string;
  githubRefreshToken?: string;
  // Identity (for logs, future auditing)
  githubUserLogin: string;
  // Client that created the session
  clientId: string;
}

export class AuthStore {
  private sessionsByAccess  = new Map<string, Session>();
  private sessionsByRefresh = new Map<string, Session>();
  private pendingByState    = new Map<string, PendingAuth>();         // keyed by PKCE state (random value embedded in GitHub redirect)
  private pendingByAuthCode = new Map<string, PendingAuthWithCode>(); // keyed by our auth code
  private gcTimer: NodeJS.Timeout | null = null;

  /** Start the background GC. Idempotent. */
  start(intervalMs = 60 * 1000): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.gc(), intervalMs);
    // Don't block process shutdown on the GC timer
    this.gcTimer.unref();
  }

  stop(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  // --- pending auth (pre-callback) ------------------------------------------

  putPending(state: string, entry: PendingAuth): void {
    this.pendingByState.set(state, entry);
  }

  takePendingByState(state: string): PendingAuth | undefined {
    const entry = this.pendingByState.get(state);
    if (!entry) return undefined;
    this.pendingByState.delete(state);
    if (Date.now() >= entry.expiresAt) return undefined;
    return entry;
  }

  // --- pending auth (post-callback, awaiting /token exchange) ---------------

  putPendingWithCode(entry: PendingAuthWithCode): void {
    this.pendingByAuthCode.set(entry.ourAuthCode, entry);
  }

  takePendingByAuthCode(authCode: string): PendingAuthWithCode | undefined {
    const entry = this.pendingByAuthCode.get(authCode);
    if (!entry) return undefined;
    this.pendingByAuthCode.delete(authCode);  // single-use
    if (Date.now() >= entry.expiresAt) return undefined;
    return entry;
  }

  // --- sessions -------------------------------------------------------------

  putSession(session: Session): void {
    this.sessionsByAccess.set(session.ourAccessToken, session);
    this.sessionsByRefresh.set(session.ourRefreshToken, session);
  }

  getSessionByAccessToken(token: string): Session | undefined {
    const s = this.sessionsByAccess.get(token);
    if (!s) return undefined;
    if (Date.now() >= s.ourAccessExpiresAt) return undefined;   // caller handles 401
    return s;
  }

  getSessionByRefreshToken(token: string): Session | undefined {
    const s = this.sessionsByRefresh.get(token);
    if (!s) return undefined;
    if (Date.now() >= s.ourRefreshExpiresAt) return undefined;
    return s;
  }

  /**
   * Refresh an existing session -- issue a new access token (and optionally a
   * new refresh token, for rotation). The caller supplies the new values;
   * this method updates the indexes and timestamps atomically.
   */
  rotateSession(
    oldAccessToken: string,
    newAccessToken: string,
    newAccessExpiresAt: number,
    newRefreshToken?: string,
    newRefreshExpiresAt?: number,
    newGithubAccessToken?: string,
    newGithubRefreshToken?: string,
  ): Session | undefined {
    const s = this.sessionsByAccess.get(oldAccessToken);
    if (!s) return undefined;

    this.sessionsByAccess.delete(oldAccessToken);
    s.ourAccessToken = newAccessToken;
    s.ourAccessExpiresAt = newAccessExpiresAt;

    if (newRefreshToken && newRefreshExpiresAt) {
      this.sessionsByRefresh.delete(s.ourRefreshToken);
      s.ourRefreshToken = newRefreshToken;
      s.ourRefreshExpiresAt = newRefreshExpiresAt;
      this.sessionsByRefresh.set(newRefreshToken, s);
    }

    if (newGithubAccessToken) {
      s.githubAccessToken = newGithubAccessToken;
    }
    if (newGithubRefreshToken) {
      s.githubRefreshToken = newGithubRefreshToken;
    }

    this.sessionsByAccess.set(newAccessToken, s);
    return s;
  }

  deleteSession(accessToken: string): void {
    const s = this.sessionsByAccess.get(accessToken);
    if (!s) return;
    this.sessionsByAccess.delete(s.ourAccessToken);
    this.sessionsByRefresh.delete(s.ourRefreshToken);
  }

  // --- garbage collection ---------------------------------------------------

  private gc(): void {
    const now = Date.now();

    for (const [k, v] of this.pendingByState) {
      if (now >= v.expiresAt) this.pendingByState.delete(k);
    }
    for (const [k, v] of this.pendingByAuthCode) {
      if (now >= v.expiresAt) this.pendingByAuthCode.delete(k);
    }
    // Session expiry is governed by refresh-token lifetime (access tokens
    // may expire first, but the session remains alive -- refresh issues new
    // access tokens). Once refresh expires, the whole session is gone.
    for (const [k, v] of this.sessionsByAccess) {
      if (now >= v.ourRefreshExpiresAt) {
        this.sessionsByAccess.delete(k);
        this.sessionsByRefresh.delete(v.ourRefreshToken);
      }
    }
  }

  // --- stats (for /health, tests) -------------------------------------------

  stats(): { sessions: number; pendingState: number; pendingCode: number } {
    return {
      sessions: this.sessionsByAccess.size,
      pendingState: this.pendingByState.size,
      pendingCode: this.pendingByAuthCode.size,
    };
  }
}
