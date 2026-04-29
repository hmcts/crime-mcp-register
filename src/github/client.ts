import { Octokit } from '@octokit/rest';
import { Agent as HttpsAgent } from 'https';
import { getGitHubToken } from './auth.js';
import { getCurrentSession } from '../auth/context.js';

export interface RepoConfig {
  owner: string;
  repo: string;
  branch: string;
}

export interface FileResult {
  path: string;
  content: string;
}

export interface SearchMatch {
  path: string;
  matches: string[];
}

// --- HTTP AGENT (B1) --------------------------------------------------------
//
// Without keep-alive, every request performs a fresh TCP + TLS handshake --
// ~150-250ms of latency per request, multiplied by every component in a
// feature-context call. A single reused agent amortises that cost across
// the whole request burst.
//
// `maxSockets: 20` caps concurrency so we don't thrash GitHub's rate limiter
// during the cold path (large parallel `fetchFile` bursts on PDK index build).
// `maxFreeSockets: 10` holds idle connections briefly so the *next* user's
// cold path gets warm sockets.
const sharedKeepAliveAgent = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 20,
  maxFreeSockets: 10,
});

function createClient(): Octokit {
  // If we're inside an authenticated request (SSE + OAuth), use the dev's own
  // GitHub token from the session. This gives per-dev auditability, scope
  // boundaries, and eliminates the shared service-account pattern.
  //
  // If there is no session (stdio mode, or SSE in dev without enforceAuth),
  // fall back to gh CLI. That preserves existing local-dev workflows.
  const session = getCurrentSession();
  const auth = session ? session.githubAccessToken : getGitHubToken();
  return new Octokit({
    auth,
    request: { agent: sharedKeepAliveAgent },
  });
}

// --- CACHES -------------------------------------------------------------------
// Two caches:
//   treeCache -- path -> SHA map, one git/trees call per repo+branch
//   fileCache -- decoded file contents keyed by repo+branch+path
//
// 24-hour TTL.
//
// PDK source changes once every 1-2 weeks in practice, so the previous 30-min
// TTL produced cache misses every half hour during active development without
// any real likelihood of fresher data. A day-scale TTL means at most one
// cache-miss per file per day per developer, while still bounding staleness
// in the rare case the developer leaves the same MCP process running for
// multiple days without restart.
//
// Mid-day invalidation paths remain:
//   - `update_knowledge` and `setup_workspace` tools in crime-frontend-developer-mcp
//     call invalidateCache() before fetching, so explicit refreshes always hit
//     remote
//   - The SessionStart hook on each developer machine re-checks the remote
//     version hash at the start of every Claude Code session and sets the
//     ~/.claude/pdk-update-available flag for Claude to act on per the
//     consumer plugin's instructions field
//
// Together these cover the "PDK changed mid-session" case without forcing
// every cache lookup to hit GitHub.

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * treeCache stores a Map<path, sha>. The SHA is retained from the git/trees
 * response so `fetchFile` can fetch blobs directly by SHA (B2 path), avoiding
 * an additional directory-resolution round-trip inside GitHub for every file.
 */
const treeCache = new Map<string, CacheEntry<Map<string, string>>>();
const fileCache = new Map<string, CacheEntry<string>>();

function cacheKey(config: RepoConfig): string {
  return `${config.owner}/${config.repo}@${config.branch}`;
}

function fileCacheKey(config: RepoConfig, path: string): string {
  return `${cacheKey(config)}::${path}`;
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return entry.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, fetchedAt: Date.now() });
}

/**
 * Clear all cached data. Call after a known PDK release to ensure fresh fetches.
 *
 * Optional `config` argument scopes the invalidation to a specific repo --
 * useful when `crime-pdk-mcp`'s `update_knowledge` tool invalidates the PDK
 * source cache without disturbing the self-repo knowledge cache (or vice versa).
 */
export function invalidateCache(config?: RepoConfig): void {
  if (!config) { treeCache.clear(); fileCache.clear(); return; }
  const prefix = cacheKey(config);
  treeCache.delete(prefix);
  for (const key of Array.from(fileCache.keys())) {
    if (key.startsWith(prefix + '::')) fileCache.delete(key);
  }
}

/**
 * Fetch the full file tree for a repo+branch and return `path -> sha` map.
 *
 * One `repos.getBranch` call to resolve the branch head's tree SHA, then one
 * `git.getTree` call with `recursive: '1'` to walk the whole tree. Cached for
 * 30 minutes or until explicit invalidation.
 */
async function getRepoTree(config: RepoConfig): Promise<Map<string, string>> {
  const key = cacheKey(config);
  const cached = readCache(treeCache, key);
  if (cached) return cached;

  const octokit = createClient();

  const branchRes = await octokit.repos.getBranch({
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
  });
  const treeSha = branchRes.data.commit.commit.tree.sha;

  const treeRes = await octokit.git.getTree({
    owner: config.owner,
    repo: config.repo,
    tree_sha: treeSha,
    recursive: '1',
  });

  const pathToSha = new Map<string, string>();
  for (const item of treeRes.data.tree) {
    if (item.type === 'blob' && item.path && item.sha) {
      pathToSha.set(item.path, item.sha);
    }
  }

  writeCache(treeCache, key, pathToSha);
  return pathToSha;
}

// --- PUBLIC API ---------------------------------------------------------------

/**
 * Fetch file content by path.
 *
 * Fast path (B2): if we have a cached tree for this repo+branch, look up the
 * file's SHA from that tree and call `git.getBlob(file_sha)`. The blob endpoint
 * skips GitHub's internal path-to-blob directory walk and returns a tighter
 * response envelope than `repos.getContent`.
 *
 * Fallback: if the tree isn't cached (first call for a repo we haven't listed
 * yet -- e.g. SELF_REPO during a `fetchFile(SELF_REPO, 'knowledge/version.json')`
 * before any `listFiles` has fired), use `repos.getContent(path)` directly.
 * That path still works, just incurs the extra directory lookup inside GitHub.
 *
 * Either path's result is cached for 30 minutes. `invalidateCache(config)` or
 * the PDK knowledge-refresh flow clears both file and tree caches consistently.
 */
export async function fetchFile(config: RepoConfig, path: string): Promise<string> {
  const key = fileCacheKey(config, path);
  const cached = readCache(fileCache, key);
  if (cached !== undefined) return cached;

  const tree = readCache(treeCache, cacheKey(config));
  if (tree) {
    const sha = tree.get(path);
    if (sha) {
      try {
        const content = await fetchBlobBySha(config, sha);
        writeCache(fileCache, key, content);
        return content;
      } catch (err: any) {
        // Blob SHAs come from a cached tree snapshot. If the repo has been
        // garbage-collected since our tree fetch (rare -- Git keeps blobs for
        // weeks by default) the blob may be gone. Fall through to getContent,
        // which always serves the live branch head.
        if (err.status !== 404) {
          // eslint-disable-next-line no-console
          console.error(`[crime-mcp-register] blob fetch failed for ${path} (sha=${sha}): ${err.message}`);
        }
      }
    }
    // Tree is cached but the specific path isn't in it -- file was added after
    // our tree snapshot. Fall through to getContent.
  }

  try {
    const res = await createClient().repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path,
      ref: config.branch,
    });
    const data = res.data as { content?: string; encoding?: string };
    if (data.content && data.encoding === 'base64') {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      writeCache(fileCache, key, decoded);
      return decoded;
    }
    throw new Error(`Unexpected response format for: ${path}`);
  } catch (err: any) {
    if (err.status === 404) return `[File not found: ${path}]`;
    throw err;
  }
}

/**
 * Fetch a blob's content by its SHA.
 *
 * `git.getBlob` returns a `{ content, encoding: 'base64' }` envelope -- we
 * decode to UTF-8. Same content format as `getContent`, but one fewer
 * directory-resolution step inside GitHub per call.
 */
async function fetchBlobBySha(config: RepoConfig, sha: string): Promise<string> {
  const res = await createClient().git.getBlob({
    owner: config.owner,
    repo: config.repo,
    file_sha: sha,
  });
  const data = res.data as { content?: string; encoding?: string };
  if (data.content && data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  throw new Error(`Unexpected blob response format for sha: ${sha}`);
}

export async function listFiles(config: RepoConfig, basePath: string, _recursive = true): Promise<string[]> {
  try {
    const tree = await getRepoTree(config);
    const out: string[] = [];
    for (const path of tree.keys()) {
      if (path.startsWith(basePath)) out.push(path);
    }
    return out;
  } catch (err: any) {
    if (err.status === 404) return [];
    throw err;
  }
}

export async function searchInFiles(
  config: RepoConfig,
  keyword: string,
  basePath: string,
  extensions: string[] = ['.ts', '.html', '.scss', '.md'],
  maxMatchesPerFile = 10
): Promise<SearchMatch[]> {
  const allFiles = await listFiles(config, basePath);
  const filtered = allFiles.filter(f => extensions.some(ext => f.endsWith(ext)));
  const results: SearchMatch[] = [];

  // Process in batches of 5 to bound concurrency. The keep-alive agent's
  // socket pool (20) is the hard ceiling, but smaller batches here keep
  // memory usage reasonable when `filtered` is large (hundreds of files).
  for (const batch of chunk(filtered, 5)) {
    await Promise.all(batch.map(async filePath => {
      const content = await fetchFile(config, filePath);
      const matches = content
        .split('\n')
        .filter(line => line.toLowerCase().includes(keyword.toLowerCase()))
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, maxMatchesPerFile);
      if (matches.length > 0) results.push({ path: filePath, matches });
    }));
  }

  return results;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  return Array.from(
    { length: Math.ceil(arr.length / size) },
    (_, i) => arr.slice(i * size, i * size + size)
  );
}
