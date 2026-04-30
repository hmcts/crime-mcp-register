# Architecture -- `@hmcts/crime-mcp-register`

This document is the structural reference for `@hmcts/crime-mcp-register`. It
describes how the package is organised, what every public symbol does, the
runtime lifecycle of a server built on top of it, and the constraints a
consumer should know about. For the *why*, read [PROJECT-OVERVIEW.md](./PROJECT-OVERVIEW.md);
for a quick start, read [README.md](./README.md).

## Contents

1. [Module layout](#1-module-layout)
2. [Public API surface](#2-public-api-surface)
3. [The `ServerConfig` contract](#3-the-serverconfig-contract)
4. [Transport modes and lifecycle](#4-transport-modes-and-lifecycle)
5. [The SSE server in detail](#5-the-sse-server-in-detail)
6. [The OAuth proxy](#6-the-oauth-proxy)
7. [The GitHub client](#7-the-github-client)
8. [Request context and per-developer auth](#8-request-context-and-per-developer-auth)
8b. [Bundle delivery](#8b-bundle-delivery)
8c. [Elicitation](#8c-elicitation)
9. [Error model](#9-error-model)
10. [Constraints and version locks](#10-constraints-and-version-locks)
11. [Extension points](#11-extension-points)

---

## 1. Module layout

```
src/
+-- index.ts                  Public re-exports -- the entire surface area
+-- elicitation.ts            elicitInput / clientSupportsElicitation /
|                             elicitOrFallback -- structured user input via MCP
|                             elicitation, with fallback for non-rendering clients
+-- types/
|   +-- tool.ts               CoreTool, ServerConfig, defineTool, JSON schema -> Zod
|   +-- prompt.ts             McpPrompt, definePrompt
+-- server/
|   +-- create-server.ts      buildServer (factory), createServer (entry point)
|   +-- transport.ts          Mode resolution: stdio | local-sse | remote-sse
|   +-- sse-server.ts         HTTP server hosting MCP-over-SSE + auxiliary endpoints
|   +-- server-context.ts     AsyncLocalStorage-backed Server reference -- lets tool
|   |                         handlers reach the MCP Server for client-bound requests
|   |                         like elicitation
|   +-- payload-store.ts      Single-use, TTL-bounded bundle store for /payload/:id
|   +-- tar-gz.ts             Minimal tar.gz writer (ustar + zlib, no new deps)
+-- github/
|   +-- auth.ts               gh-CLI fallback for unauthenticated dev mode
|   +-- client.ts             Octokit wrapper, two-tier cache, public fetch primitives
+-- auth/
    +-- config.ts             OAuth env loading
    +-- tokens.ts             Crypto-random token primitives + TTL constants
    +-- pkce.ts               PKCE S256 verification
    +-- store.ts              In-memory session + pending-auth store with GC
    +-- github.ts              OAuth client for github.com (code exchange, refresh, /user)
    +-- endpoints.ts          Six HTTP handlers for the OAuth flow + Bearer middleware
    +-- context.ts            AsyncLocalStorage-backed request context
```

Total: 18 source files, ~2200 lines. Single-file modules where the unit is
small enough; folder-as-module where the surface needs more than one file
(server, github, auth).

The dependency direction is one-way: `server` depends on `auth` and `github`;
`auth` depends only on `auth/*`; `github` depends on `auth/context` for
session lookup but not on the rest. There are no cyclic imports. The new
`server/payload-store.ts`, `server/tar-gz.ts`, `server/server-context.ts`,
and `elicitation.ts` modules are leaves -- nothing in the codebase depends on
them; they exist purely as primitives for consumer plugins to import. The
elicitation module reads its current Server via `server/server-context`,
which `create-server.ts` populates per tool-handler invocation.

## 2. Public API surface

Every export is re-exported from `src/index.ts`. Nothing else is part of the
public contract; consumer code must not reach into `dist/server/...` or
similar paths.

### Exports

```ts
// GitHub client
export { getGitHubToken, fetchFile, listFiles, searchInFiles, chunk, invalidateCache };
export type { RepoConfig, FileResult, SearchMatch };

// Tool definition
export { defineTool };
export type { CoreTool, JsonSchema, JsonSchemaProperty, ToolResult, ServerConfig };

// Prompt definition
export { definePrompt };
export type { McpPrompt, PromptArgument, PromptMessage, PromptResult };

// Server factory
export { createServer, buildServer };
export type { CreateServerConfig, ServerFactory };
export type { TransportMode, TransportConfig };

// Auth (only relevant if you enable OAuth)
export { AuthStore };
export type { Session, PendingAuth, PendingAuthWithCode };
export { loadOAuthConfigFromEnv };
export type { OAuthConfig };
export type { AuthDeps };
export { runWithSession, getCurrentSession };
export type { RequestContext };

// Bundle delivery (one-time download URLs for seeding developer machines)
export { storePayload, payloadStoreSize };
export { buildTarGz };
export type { TarEntry };

// Elicitation (structured user input via MCP elicitation; Claude Code 2.1.76+)
export { elicitInput, clientSupportsElicitation, elicitOrFallback };
export type { ElicitResult, ElicitSchema, ElicitProperty };
export type { ElicitOrFallbackResult, ElicitOptions, ElicitOrFallbackOptions };
export { runWithServer, getCurrentServer };
```

### What each does, in a sentence

| Export                    | Kind  | Purpose                                                                          |
|---------------------------|-------|----------------------------------------------------------------------------------|
| `defineTool`              | fn    | Declare a tool: name, description, JSON schema, async handler. Returns a `CoreTool`. |
| `CoreTool`                | type  | Internal representation of a tool, including the auto-generated Zod schema.      |
| `JsonSchema` / `Property` | types | The subset of JSON Schema `defineTool` accepts.                                  |
| `ToolResult`              | type  | `Record<string, unknown>` -- anything JSON-serialisable a tool returns.           |
| `ServerConfig`            | type  | Identity (name, version, description), optional `instructions`, the tool list.   |
| `definePrompt`            | fn    | Identity helper for `McpPrompt` declarations (no transformation; symmetry with `defineTool`). |
| `McpPrompt`               | type  | A prompt visible in Claude Code as a slash command under the server's namespace. |
| `PromptArgument`          | type  | Single argument a prompt accepts.                                                |
| `PromptResult`            | type  | What a prompt handler returns -- a list of role/content messages.                 |
| `buildServer`             | fn    | Pure factory: returns a fresh `Server` instance with tools and prompts registered. Called once for stdio, once per connection for SSE. |
| `createServer`            | fn    | Public entry point: builds, picks transport, connects.                           |
| `CreateServerConfig`      | type  | `ServerConfig` plus optional `prompts` and `transport`.                          |
| `ServerFactory`           | type  | `() => Server` -- what `buildServer` produces, what the transport layer expects.  |
| `TransportConfig`         | type  | Mode, port, host, version loader, optional auth deps, enforce flag.              |
| `TransportMode`           | type  | `'local-stdio' \| 'local-sse' \| 'remote-sse'`.                                  |
| `RepoConfig`              | type  | `{ owner, repo, branch }` -- every github-client call takes one.                  |
| `FileResult`              | type  | `{ path, content }` (declared but not currently used by any export in 0.1.0).    |
| `SearchMatch`             | type  | `{ path, matches[] }` returned by `searchInFiles`.                               |
| `getGitHubToken`          | fn    | `gh auth token` execSync wrapper. Throws a banner if gh isn't logged in.         |
| `fetchFile`               | fn    | Fetch a file by path, with two-tier (tree + file) cache.                         |
| `listFiles`               | fn    | List files under a base path. Recursive only -- the boolean is reserved.          |
| `searchInFiles`           | fn    | Substring search across files, batched for concurrency control.                  |
| `chunk`                   | fn    | Generic array chunker, exposed because clients sometimes want the same batching behaviour. |
| `invalidateCache`         | fn    | Clear all caches, or scope to one `RepoConfig`.                                  |
| `AuthStore`               | class | In-memory store for pending-auth and session records. Has a GC timer.            |
| `Session`                 | type  | Long-lived record: our token pair + GitHub token pair + identity.                |
| `PendingAuth`             | type  | Short-lived record between `/authorize` and `/callback`.                         |
| `PendingAuthWithCode`     | type  | Short-lived record between `/callback` and the client's `/token` POST.           |
| `loadOAuthConfigFromEnv`  | fn    | Read OAuth config from env vars; return `undefined` if any required value missing. |
| `OAuthConfig`             | type  | `{ githubClientId, githubClientSecret, baseUrl }`.                               |
| `AuthDeps`                | type  | What the auth handlers need: `{ store, config, scopes? }`.                       |
| `runWithSession`          | fn    | Run a callback within an AsyncLocalStorage scope carrying a session.             |
| `getCurrentSession`       | fn    | Read the session from the current async scope, or `undefined`.                   |
| `RequestContext`          | type  | The structure stored in AsyncLocalStorage: `{ session }`.                        |
| `storePayload`            | fn    | Stash a `Buffer` bundle in the in-memory single-use store; returns a 32-char base64url id. |
| `payloadStoreSize`        | fn    | Number of bundles currently held; used by `/health`-style diagnostics.           |
| `buildTarGz`              | fn    | Pure tar.gz writer. `(entries: TarEntry[]) => Buffer`. UTF-8 no-BOM, ustar format. |
| `TarEntry`                | type  | `{ path: string; content: string }` -- one file in the bundle.                   |
| `elicitInput`             | fn    | Send an `elicitation/create` request to the client. Returns `{ action, content? }`. Throws on timeout, error, or unsupported client. |
| `clientSupportsElicitation` | fn  | Whether the connected client advertised elicitation support during initialise.   |
| `elicitOrFallback`        | fn    | Try `elicitInput`; on any non-accept outcome (decline, cancel, throw, no support), call the fallback supplier and return those values instead. Never throws. |
| `ElicitResult`            | type  | Raw `elicitInput` return: `{ action: 'accept'\|'decline'\|'cancel', content? }`. |
| `ElicitSchema`            | type  | Flat object schema accepted by elicitation. Properties are primitives + `array` of enum strings. |
| `ElicitProperty`          | type  | A single field in an elicitation schema (string/number/integer/boolean/array of enum). |
| `ElicitOrFallbackResult`  | type  | `{ source, action?, values, error?, rawResult? }` -- which path produced the values, plus diagnostics. |
| `ElicitOptions`           | type  | Forwarded to the SDK's `RequestOptions`: `{ timeout?, signal? }`.                |
| `ElicitOrFallbackOptions` | type  | Currently `{ timeout? }`; defaults to 300_000 ms (5 min).                        |
| `runWithServer`           | fn    | Run a callback within an AsyncLocalStorage scope carrying the current MCP `Server`. Used by `create-server` per tool-handler invocation. |
| `getCurrentServer`        | fn    | Read the current MCP `Server` if set via `runWithServer`, else `undefined`.      |

The complete behaviour of each is described later in this document.

## 3. The `ServerConfig` contract

```ts
interface ServerConfig {
  name: string;            // MCP server name; appears in Claude Code as the namespace
  version: string;         // semver string; appears in initialize-response
  description?: string;    // free-text; surfaced in some clients
  instructions?: string;   // model-facing system instructions
  tools: CoreTool[];       // every tool callable on this server
}

interface CreateServerConfig extends ServerConfig {
  prompts?: McpPrompt[];   // optional slash commands under /mcp__<name>__<prompt>
  transport?: TransportConfig;
}
```

### `name` and `version`

Identity, surfaced in MCP's `initialize` response. The name becomes the
namespace prefix Claude Code uses to surface tools (`mcp__<name>__<tool>`)
and prompts (`/mcp__<name>__<prompt>`).

### `description`

Optional. Some MCP clients render it; Claude Code currently does not give
it special treatment. Useful for human-readable identification in logs
and any future tooling.

### `instructions`

The single most important field for plugin behaviour. It is text injected
into the model's system prompt **every turn** for the lifetime of the
connection. Claude Code does not show it in the terminal UI; the developer
never sees it directly. It is for the model.

Practical use: this is where the consuming plugin tells Claude how to use
its tools, what first-action checks to perform, when to ask the developer
before doing something destructive, and so on. The
`crime-frontend-developer-mcp` plugin's `instructions` field is what
implements its three-branch first-action check (read install marker, read
update flag, decide what to do).

The field is plumbed through to the SDK at the `ServerOptions` level,
alongside `capabilities`. Older SDK versions silently ignore unknown fields
at this position; current versions surface them.

### `tools`

An array of `CoreTool` values, each produced by `defineTool`. Order does
not matter. Tool names must be unique within the array; duplicates cause
later definitions to win in the `tools.find` lookup at dispatch time, which
is almost certainly not what the consumer wants.

### `prompts` (optional)

If supplied, the server advertises the `prompts` capability in the
initialize-response, and `ListPromptsRequest` / `GetPromptRequest` handlers
are registered. If empty or omitted, the prompts capability is not
advertised at all.

### `transport` (optional)

If omitted, transport is resolved from the `CRIME_MCP_MODE` environment
variable, defaulting to `local-stdio`. See [section 4](#4-transport-modes-and-lifecycle).

## 4. Transport modes and lifecycle

### Mode selection

```
TransportConfig.mode (explicit)
  v (if absent)
process.env.CRIME_MCP_MODE
  v (if absent)
'local-stdio'
```

`CRIME_MCP_MODE` accepts `'stdio'`, `'dev'`, or `'prod'`, mapped to
`'local-stdio'`, `'local-sse'`, and `'remote-sse'` respectively.

### What each mode is for

**`local-stdio`** -- the original MCP transport. The host process spawns the
MCP server as a child, JSON-RPC over stdio. One Server instance for the
lifetime of the child process. No HTTP surface, no auth, no SSE machinery
loaded. Used for local dev when the consumer is willing to run a subprocess
per Claude Code session.

**`local-sse`** -- HTTP SSE on `127.0.0.1`. Default port `3000`. For local
development when you want the production wire format (so the same server
process can be tested against multiple clients) without OAuth. The
`/version` endpoint, GitHub client (using `gh` CLI fallback), and
`/invalidate-cache` are all live; OAuth endpoints are not registered.

**`remote-sse`** -- HTTP SSE on `0.0.0.0`. Default port `8080`. For hosted
deployments. Typically run with `auth` configured in `TransportConfig` so
OAuth endpoints register and (if `enforceAuth: true`) `/sse` and `/messages`
require Bearer tokens.

### The factory pattern

`buildServer` returns a fresh `Server` instance every time. `createServer`
hands `buildServer` to the transport layer as a `ServerFactory`:

- **stdio** calls the factory once. One Server, one transport, lifetime
  bound to the process.
- **SSE** calls the factory **per `/sse` connection**. The MCP SDK's
  `Server.connect()` binds a single transport exclusively; a second connect
  on the same Server throws *"Already connected to a transport"*. So each
  client connection gets its own Server, all sharing the same tool/prompt
  registry through the closure inside the factory.

### Port resolution

```
TransportConfig.port (explicit)
  v (if absent)
process.env.PORT
  v (if absent)
local-sse  -> 3000
remote-sse -> 8080
```

`local-stdio` ignores port entirely.

### Host resolution

If `TransportConfig.host` is supplied, that wins. Otherwise:

- `local-sse` -> `127.0.0.1` (loopback only -- local dev)
- `remote-sse` -> `0.0.0.0` (listen on all interfaces -- typical container
  deployment)

### Lazy import

The SSE server module is dynamically imported only when SSE mode is
selected. Stdio-only deployments do not load the HTTP-server code at all.
This keeps the cold-start cost low for stdio consumers.

## 5. The SSE server in detail

### Endpoints

| Method | Path                                         | Purpose                                                      | Auth-gated when `enforceAuth: true`? |
|--------|----------------------------------------------|--------------------------------------------------------------|--------------------------------------|
| GET    | `/sse`                                       | MCP transport -- opens an SSE stream                          | Yes                                  |
| POST   | `/messages?sessionId=...`                    | MCP message ingress for a previously-opened SSE session      | Inherits SSE session's auth          |
| GET    | `/health`                                    | Liveness probe; returns active session count                 | No                                   |
| GET    | `/version`                                   | Serves a JSON blob the consumer's `versionLoader` produces   | No                                   |
| POST   | `/invalidate-cache`                          | Clears the GitHub client cache                               | No                                   |
| GET    | `/payload/:id`                               | Single-use download of a bundle stored via `storePayload`. Deletes the entry on first read. The id itself is the capability -- 192 bits of entropy. | No (the random id is the auth) |
| GET    | `/.well-known/oauth-authorization-server`    | RFC 8414 metadata document                                   | Only registered when `auth` provided |
| POST   | `/register`                                  | RFC 7591 dynamic client registration                         | Only registered when `auth` provided |
| GET    | `/authorize`                                 | OAuth flow entry -- redirects to GitHub                       | Only registered when `auth` provided |
| GET    | `/callback`                                  | GitHub redirects here after user consent                     | Only registered when `auth` provided |
| POST   | `/token`                                     | Code-grant and refresh-grant exchanges                       | Only registered when `auth` provided |

### Per-connection state

Each open SSE connection has an entry in an in-memory `Map<sessionId, HttpSession>`
where `HttpSession` is:

```ts
{
  server: Server;                      // dedicated MCP Server for this connection
  transport: SSEServerTransport;       // the SDK transport, owns the response stream
  authSession?: Session;               // captured at /sse open time when auth enforced
}
```

The session is keyed by the SDK-issued `sessionId` (a string). When the SSE
response stream closes, the entry is removed and `Server.close()` is called
(best-effort).

### Why `/messages` doesn't re-validate the Bearer

When auth is enforced, the Bearer is validated **once** at `/sse` open time
and the resulting `Session` is stored on the `HttpSession`. Subsequent
`/messages` POSTs for the same `sessionId` inherit that auth context -- they
do not re-validate.

This is intentional: Claude Code does not resend the Bearer on `/messages`.
The Bearer travels on the SSE GET only. If the access token expires
mid-session, the next upstream GitHub call inside a tool will fail, Claude
Code's transport will reconnect, and `/sse` will re-validate at that point.

### Async context binding

When `authSession` is present, every `/messages` handler runs inside
`runWithSession(authSession, ...)`. This sets the AsyncLocalStorage scope
so that any code inside the tool handler -- including code awaited inside
`fetchFile` or `listFiles` -- can call `getCurrentSession()` and get back
the right session without the session being threaded through every call.

When `authSession` is not present (stdio, or SSE with `enforceAuth: false`),
the wrapping is a no-op.

## 6. The OAuth proxy

The auth layer implements a full OAuth 2.1 + PKCE + RFC 7591 flow in front
of GitHub. The MCP server is a *proxy*: from Claude Code's perspective it
is the OAuth provider; from GitHub's perspective it is a confidential
client running a single registered OAuth App.

This indirection lets us issue our own opaque, short-lived tokens to
Claude Code -- independent of GitHub's own token lifetimes -- while still
having a real GitHub access token in the session for upstream calls.

### Flow

```
Claude Code                     MCP server (us)                    GitHub
     |                                  |                              |
     |  GET /.well-known/oauth-...      |                              |
     | -------------------------------->|                              |
     |           metadata JSON          |                              |
     | <--------------------------------|                              |
     |                                  |                              |
     |  POST /register                  |                              |
     | -------------------------------->|                              |
     |           client_id              |                              |
     | <--------------------------------|                              |
     |                                  |                              |
     |  GET /authorize                  |                              |
     |  ?response_type=code             |                              |
     |  &client_id=...                  |                              |
     |  &code_challenge=...&state=...   |                              |
     | -------------------------------->|                              |
     |                                  |  302 -> github.com/.../authorize
     | <--------------------------------| <----------------------------+
     |                                  |                              |
     |   (user authenticates with GH)                                  |
     |                                                                 |
     |  GET /callback?code=...&state=...                               |
     | -------------------------------->|                              |
     |                                  |  POST /login/oauth/access_token
     |                                  | ---------------------------->|
     |                                  |            token             |
     |                                  | <----------------------------|
     |                                  |  GET /user (with token)      |
     |                                  | ---------------------------->|
     |                                  |            login             |
     |                                  | <----------------------------|
     |     302 -> original redirect_uri                                 |
     |            with our authcode                                    |
     | <--------------------------------|                              |
     |                                                                 |
     |  POST /token                                                    |
     |  grant_type=authorization_code                                  |
     |  code=<our authcode>                                            |
     |  code_verifier=<PKCE>                                           |
     | -------------------------------->|                              |
     |   { access_token, refresh_token } (OURS, not GitHub's)          |
     | <--------------------------------|                              |
     |                                                                 |
     |  GET /sse (Authorization: Bearer <our access_token>)            |
     | -------------------------------->|                              |
     |   ... MCP traffic ...            |                              |
```

### Token lifetimes

| Token       | Issued by | Lifetime  | Verification                     |
|-------------|-----------|-----------|----------------------------------|
| Auth code   | Us        | 60 s      | Single-use, looked up by code    |
| Access      | Us        | 1 h       | Map lookup by token              |
| Refresh     | Us        | 2 d       | Map lookup by token              |
| GitHub access | GitHub  | App-defined (default: never expires) | Used for upstream API calls |
| GitHub refresh | GitHub | App-defined | Only present if expiry enabled  |

Our tokens are 384-bit base64url-encoded random bytes (48 byte buffer ->
64 character string). Not JWTs -- they have no internal structure and are
verified by lookup, not signature. Revocation is trivial (delete from
store); session bookkeeping is unavoidable anyway because we need to keep
the upstream GitHub token paired with each session.

### PKCE

Claude Code always sends PKCE with method `S256`. We never generate
verifiers; we only verify them at `/token` against the challenge stashed
during `/authorize`. The verification uses `timingSafeEqual` to avoid
leaking partial-match information.

Verifier validation enforces the RFC 7636 section 4.1 character set
(`[A-Za-z0-9-._~]`) and length range (43-128 chars). Method other than
`S256` is rejected -- OAuth 2.1 requires it for public clients.

### Session store

In-memory `AuthStore` class with three maps:

- `sessionsByAccess` -- keyed by our access token; for `/sse` Bearer validation
- `sessionsByRefresh` -- keyed by our refresh token; for `/token` refresh grants
- `pendingByState` -- keyed by the PKCE state parameter; for `/callback` lookup
- `pendingByAuthCode` -- keyed by our auth code; for `/token` code grants

A periodic GC (default 60 s interval, started by `start()`, stopped by
`stop()`) sweeps expired pending entries and refresh-expired sessions.
`unref()` is called on the timer so it never blocks process shutdown.

The store is not persistent. A server restart logs every developer out;
they re-auth on next reconnect. This is documented behaviour, accepted
because OAuth flows are cheap and the alternative (file or database
persistence) introduces concerns disproportionate to the value at this
scale.

### Why a proxy at all

The MCP server doesn't get to call `gh auth token` in production -- there
is no `gh` and there is no developer-local credential to inherit. Each
developer's connection needs its own GitHub identity, ideally with
per-developer auditability and the ability to revoke a single developer's
access without touching the whole service.

Without the proxy, every plugin would either share a service-account
GitHub token (bad: no per-developer audit, hard to revoke, broad scope)
or implement its own OAuth flow (bad: every plugin reimplementing the
same machinery). The proxy in `crime-mcp-register` lets the consumer
plugin opt into per-developer GitHub auth by passing `auth` in the
transport config -- and get it for free if they don't need it.

## 7. The GitHub client

A thin Octokit wrapper with caching and per-session token resolution.

### `RepoConfig`

```ts
interface RepoConfig { owner: string; repo: string; branch: string }
```

Every public function takes one. The cache key is
`${owner}/${repo}@${branch}`, plus the file path for file-level entries.

### Public functions

- `fetchFile(config, path)` -- single file content as UTF-8
- `listFiles(config, basePath)` -- paths under `basePath` matching the
  recursive tree
- `searchInFiles(config, keyword, basePath, extensions, max)` -- substring
  search across files, returning matches with line snippets
- `chunk(arr, size)` -- generic array chunker, exposed for symmetry with
  `searchInFiles`'s internal batching
- `invalidateCache(config?)` -- clear all caches, or scope to one repo
- `getGitHubToken()` -- `gh auth token` execSync wrapper; throws a banner
  if `gh` is not authenticated

### Two-tier cache

```
treeCache : Map<repoKey, Map<path, sha>>     // 1 entry per repo+branch
fileCache : Map<repoKey::path, content>      // 1 entry per file
```

Both with a 24-hour TTL, sweep-on-read (a stale entry returns `undefined`
and is deleted).

### Why two tiers

The tree cache holds `path -> sha` from a single recursive `git/getTree`
call. With the tree cached, `fetchFile` can call `git/getBlob(file_sha)`
directly, skipping GitHub's internal directory walk and shaving real
latency off bursty cold paths (PDK index build can request 100+ files in
parallel).

Without the tree, `fetchFile` falls back to `repos/getContent(path)` -- one
extra directory lookup per call, but it works without prior `listFiles`.

### Concurrency control

- A shared `https.Agent` with `keepAlive: true`, `maxSockets: 20`,
  `maxFreeSockets: 10`. Without keep-alive, every Octokit call performs a
  fresh TCP+TLS handshake (150-250 ms each). One agent shared across all
  Octokit instances amortises that cost.
- `searchInFiles` batches in groups of 5 to bound memory when `filtered`
  is large (hundreds of files); the agent's socket pool is the hard
  ceiling.

### Per-session token resolution

```ts
function createClient(): Octokit {
  const session = getCurrentSession();
  const auth = session ? session.githubAccessToken : getGitHubToken();
  return new Octokit({ auth, request: { agent: sharedKeepAliveAgent } });
}
```

The auth source depends on context:

- **Inside a `runWithSession` scope** (an authenticated SSE request -- OAuth
  enabled, valid Bearer presented), use the developer's GitHub access token
  from their session. Each request runs as the developer who initiated it.
- **Outside any session scope** -- which means either:
  - a `local-stdio` server (no HTTP, no OAuth surface)
  - a `local-sse` or `remote-sse` server with `enforceAuth: false` (OAuth
    endpoints exist but `/sse` and `/messages` are not gated)
  - **a build-time script that imports `fetchFile` directly** -- for
    example `crime-frontend-developer-mcp`'s `generate:pdk` script, which
    runs as a Node process with no HTTP server at all and no
    `runWithSession` ever invoked. Every `fetchFile` call from such a
    script falls into this branch.

In all of these the client falls back to `getGitHubToken()`, which calls
`gh auth token` via `execSync`. The operator running the process -- a
developer on their laptop, a CI runner, whoever -- must have `gh`
installed and authenticated.

This split is intentional. `gh` is the auth path for personal-machine and
operator-machine use; OAuth is the auth path for hosted runtime serving
real users. A production deployment should be running with
`enforceAuth: true` so no request ever falls back to `gh`. See
[PROJECT-OVERVIEW.md -- Operational requirements per mode](./PROJECT-OVERVIEW.md#operational-requirements-per-mode)
for the full picture and CI configuration patterns.

### Cache invalidation paths

- `invalidateCache()` -- wipe everything (called by `POST /invalidate-cache`)
- `invalidateCache(config)` -- wipe one repo
- The 24-hour TTL -- automatic for files left undisturbed

A consumer plugin that knows when its source repo changes (e.g. after a
`update_knowledge` tool runs) is expected to call `invalidateCache(config)`
explicitly to guarantee the next read hits remote.

### Error handling

- 404 on `getContent` returns the literal string `"[File not found: <path>]"`.
  This is a deliberate non-throw because consumer code often iterates
  through a list of expected files and treats individual misses as
  best-effort. (Subject to revision in a future major version.)
- 404 on `getBlob` falls through to `getContent` (the blob may have been
  garbage-collected since the tree was cached).
- Any other error propagates to the caller.

## 8. Request context and per-developer auth

```ts
runWithSession(session, () => { /* ... */ });
const s = getCurrentSession();   // returns the session inside that scope, else undefined
```

Backed by `node:async_hooks.AsyncLocalStorage`. Context propagates across
`await` points correctly -- this is what makes `fetchFile`'s
`getCurrentSession()` lookup work even when called several layers deep
inside a tool handler.

The SSE server wraps `transport.handlePostMessage` in `runWithSession`
when an authenticated session exists for the current `sessionId`. Tool
handlers and any code they await all see the right session.

For stdio deployments and unauthenticated SSE, no `runWithSession` call
ever happens; `getCurrentSession()` returns `undefined`, and the GitHub
client falls back to its `gh` CLI path.

## 8b. Bundle delivery

A primitive consumer plugins use to ship files to a developer's machine
without putting them through the MCP tool-result channel.

The problem this solves: an MCP tool result that returns 50 KB of JSON
text gets spilled to a temp file by Claude Code, forcing additional reads
and risking client-side encoding drift if Claude reaches for shell tools
to handle the bulk. Bundle delivery returns a tiny tool result (a URL +
small mutations) and ships the bulk content as a single binary download
that `tar -xf` extracts byte-perfectly on the developer's disk.

### The flow

```
1. Consumer plugin tool generates files to ship; calls buildTarGz(entries) -> Buffer.
2. Consumer calls storePayload(bundle, filename, contentType) -> id (32-char base64url).
3. Consumer returns to Claude:  { downloadUrl: <baseUrl>/payload/<id>, ... }
4. Claude (on the developer's machine) runs:  curl <url> -o /tmp/x.tar.gz && tar -xf /tmp/x.tar.gz -C $HOME
5. The /payload/:id handler reads-and-deletes the bundle from the store on first GET.
```

### Why the delete-on-read

The id is a 24-byte random value (192 bits of entropy) -- non-guessable
in any practical sense. It IS the capability for that bundle. Once
fetched, the entry is removed; a stale URL cannot be replayed even if
leaked. Combined with the 5-minute TTL backstop, no bundle outlives its
intended use.

### Auth on /payload/:id

The endpoint is NOT gated by the OAuth Bearer middleware. Reasoning:
the random id is the sole capability, and the consumer plugin returned
it to Claude over the (already authenticated) MCP session. Adding a
second auth layer on the download path would require Claude to forward
its Bearer to a separate HTTP request -- something Claude Code's tool
runtime does not currently do. The single-use + TTL + 192-bit entropy
combination provides equivalent security for this use case.

A future iteration could parameterise this: an optional Bearer-required
flag on the route, useful if a consumer wants belt-and-braces gating.

### Tar.gz writer

`buildTarGz` produces a standard ustar tar.gz that GNU tar, BSD tar,
Windows 10's built-in tar (since 1803), and 7-zip can all read.

```ts
import { buildTarGz, TarEntry } from '@hmcts/crime-mcp-register';

const entries: TarEntry[] = [
  { path: 'crime-frontend-claude/cp-angular/GATES.md', content: '...' },
  { path: '.crime-frontend-developer-mcp/installed.json', content: '...' },
];

const bundle: Buffer = buildTarGz(entries);  // ready to store + serve
```

Encoding contract: file contents are written as UTF-8 bytes with no BOM,
regardless of the developer's locale. `tar -xf` preserves those bytes
verbatim -- no re-encoding, no character mangling. This is the property
that makes bundle delivery encoding-correct where Claude-driven
PowerShell writes were not.

Constraints:
- Path length capped at 100 bytes (ustar `name` field). For the consumer
  plugins shipping today this is comfortable; for deeper paths, ustar
  has a `prefix` field that's not currently used.
- Entries must be regular files. Directories are implicit (created by
  `tar -xf` when extracting a file with that prefix).
- File mode is fixed at `0644`, owner/group `root` (the values are
  cosmetic; what matters on extraction is the developer's umask).

### Payload store

Single-use, TTL-bounded, in-memory.

```ts
import { storePayload, payloadStoreSize } from '@hmcts/crime-mcp-register';

const id = storePayload(bundle, 'cfd-setup.tar.gz', 'application/gzip');
//   -> '24-byte base64url string'

console.log(payloadStoreSize());  // current count, for diagnostics
```

The store has a 1-minute GC sweep that runs while there are entries,
removing anything past its 5-minute TTL. The interval is `unref`'d so
it doesn't keep the Node process alive on its own.

### Reusability

These primitives are consumer-agnostic. Any future MCP plugin that
needs to seed developer machines (cp-react-developer-mcp, cp-be-developer-mcp,
or unrelated work) can import and use them without modification:

```ts
import { defineTool, buildTarGz, storePayload } from '@hmcts/crime-mcp-register';

export const setupTool = defineTool({
  name: 'setup_my_workspace',
  description: '...',
  handler: async () => {
    const bundle = buildTarGz(myEntries);
    const id = storePayload(bundle, 'myplugin.tar.gz', 'application/gzip');
    return { downloadUrl: `${baseUrl}/payload/${id}`, /* ... */ };
  },
});
```

The `/payload/:id` route is part of the SSE server, so any plugin that
runs on `crime-mcp-register`'s `createServer` gets it for free.

## 8c. Elicitation

A primitive consumer plugins use to ask the user for structured input
mid-tool-call -- a form rendered by the client (Claude Code 2.1.76+),
with answers returned to the handler as a typed object.

### The protocol shape

The MCP elicitation protocol (added 2025-06-18) defines a single client-bound
request: `elicitation/create`. The server sends a `message` and a
`requestedSchema` describing the form's fields; the client renders a UI;
the user submits, declines, or cancels; the response carries one of
`{ action: 'accept', content }`, `{ action: 'decline' }`, or
`{ action: 'cancel' }`.

The schema is restricted by spec to a **flat object with primitive
properties**: strings (with optional `enum` for dropdowns/radio), numbers
and integers (with `minimum`/`maximum`), booleans (rendered as checkboxes),
and arrays of enum strings (rendered as multi-select). No nested objects,
no `oneOf`, no recursion. Each property may declare a `default` (pre-fills
the field) and a `description` (rendered as the field's label or help text).

### `elicitInput`

Direct wrapper around the SDK's `Server.elicitInput`. Reads the current
MCP `Server` via `getCurrentServer()` (which `create-server` populates
per tool-handler invocation), forwards `{ message, requestedSchema }` plus
any `ElicitOptions` (notably `timeout`), and returns the raw `ElicitResult`.

```ts
const result = await elicitInput<{ format: string; pageSize: number }>(
  'Configure output',
  schema,
  { timeout: 300_000 },
);
if (result.action === 'accept' && result.content) {
  // result.content is the validated user input
}
```

The wrapper throws if it's called outside a tool-handler scope (no Server
in async context) or if the SDK rejects (timeout, capability mismatch,
schema validation failure). Tool handlers wanting graceful degradation
should use `elicitOrFallback` instead.

### `elicitOrFallback`

The pattern most consumer tools want. Tries elicitation; on **any**
non-accept outcome, calls the supplied fallback to produce values:

```ts
const result = await elicitOrFallback(
  'Configure output',
  schema,
  () => ({ format: 'json', pageSize: 10 }),  // sensible defaults
);
// result.source === 'elicitation' | 'fallback'
// result.values is always populated
```

The result includes `source` ('elicitation' or 'fallback'), the original
`action` (accept / decline / cancel) when one came back, an `error` field
when the SDK threw, and a `rawResult` field carrying the underlying
elicitInput response when one exists. Production callers can use just
`source` and `values`; diagnostics callers can inspect the rest.

The default timeout is **300_000 ms (5 minutes)** -- long enough for
thoughtful form-filling, short enough that an abandoned session frees
the server's pending request. Consumer tools with shorter or longer
forms can override via `ElicitOrFallbackOptions.timeout`.

### Why fall back unconditionally on non-accept

The protocol distinguishes user-initiated `decline` from
client-initiated auto-decline only by convention -- both come back as
`action: 'decline'` with no payload. At time of writing, the VS Code
MCP extension advertises elicitation support during the initialise
handshake but auto-declines actual requests without rendering the form;
CLI Claude Code renders correctly. Rather than maintain a list of
"broken" clients (which would go stale when VS Code fixes the bug, or
miss new clients), `elicitOrFallback` treats any non-accept outcome
identically. The user gets the fallback values; if the consumer tool
wants to surface a Markdown intake to the user (as `gate_intake` does),
it can do so based on `source === 'fallback'` without caring whether
the user declined intentionally or the surface didn't render.

### Server context plumbing

`server-context.ts` provides an `AsyncLocalStorage<{ server: Server }>`
backing the elicitation lookup. `create-server.ts` wraps every tool
handler invocation in `runWithServer(server, () => handler(args))`,
so the handler (and anything it awaits) can call `getCurrentServer()`
to reach the Server for client-bound requests.

This pattern mirrors `runWithSession` / `getCurrentSession` (used for
per-developer GitHub identity). The AsyncLocalStorage approach was
chosen over threading a `Server` argument through `defineTool`'s handler
signature because the latter would be a breaking change for every
existing consumer.

### Reusability

The elicitation primitives are consumer-agnostic. Any future MCP plugin
that needs structured user input mid-tool-call can import and use them
without modification. The current consumer is
`crime-frontend-developer-mcp`'s `gate_intake` tool, which uses
`elicitOrFallback` to capture Gate 1 specs from the developer in a
single round-trip on supported clients (rendered form) and via Markdown
intake on non-rendering clients (Claude shows the markdown, user replies
in chat, the tool re-validates on the second call).

## 9. Error model

Three layers of error handling:

1. **Tool handler errors.** Caught by the `CallToolRequestSchema` handler
   in `create-server.ts`. The error message is wrapped in a
   `{ isError: true, content: [{ type: 'text', text: '...' }] }` response.
   The MCP SDK propagates this to the client; Claude Code surfaces it as
   a tool error.
2. **OAuth endpoint errors.** Each handler writes an HTTP error response
   directly (`res.writeHead(...).end(...)`). For OAuth-protocol errors,
   the body follows RFC 6749 / RFC 7591 shape (`{ error, error_description }`).
3. **Transport-level errors.** Logged to `console.error` with a
   `[sse-server]` prefix. The connection in question is dropped; other
   connections are unaffected.

There is no central logger. Consumers wanting structured logging are
expected to wrap tool handlers themselves; the register's own log surface
is bounded and prefixed.

## 10. Constraints and version locks

### Octokit `^20.1.2`

Locked to the v20 line by deliberate decision. Octokit v21+ is ESM-only.
Migrating to ESM would mean either:
- Migrating this package and every consumer to ESM, or
- Adopting a CJS/ESM dual-build setup

Either is real work; neither is in scope for the 0.1.0 line. Documented as
a constraint here so a contributor doesn't accidentally bump it.

### `@modelcontextprotocol/sdk` `^1.0.0`

Tracks the SDK's public API. The `instructions` field on `ServerOptions`
is honoured by SDK 1.x; older 0.x versions silently ignore it. We rely on
the 1.x behaviour.

### `zod` `^3.22.0`

Used for the JSON-schema -> Zod conversion in `defineTool`. A future major
of zod (v4) would require revisiting `jsonPropertyToZod` and
`jsonSchemaToZod` shapes. Not blocking for 0.1.0.

### Node version

Tested on Node 20. AsyncLocalStorage is stable since Node 16. `fetch` is
built-in since Node 18. Earlier Node versions are not supported.

### File size ceilings

No hard ceiling, but every source file is currently under 500 lines.
`endpoints.ts` is the largest at 466. This is a soft convention to keep
files reviewable; it is not enforced by anything in the build.

## 11. Extension points

### Adding a tool to a consumer plugin

```ts
import { defineTool, type CoreTool } from '@hmcts/crime-mcp-register';

const myTool: CoreTool = defineTool({
  name: 'my_tool',
  description: 'What it does, in detail. Used by the model verbatim.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The query to run.' },
      limit: { type: 'number', description: 'Max results.', default: 10 },
    },
    required: ['query'],
  },
  handler: async ({ query, limit }) => {
    // ... do work ...
    return { results: [...] };
  },
});
```

`defineTool` runs the JSON schema through `jsonSchemaToZod` and stores the
resulting Zod schema on the returned `CoreTool`. At dispatch time the
incoming arguments are parsed by Zod; failures become tool errors with
the Zod message in the body.

### Adding a prompt

```ts
import { definePrompt } from '@hmcts/crime-mcp-register';

const myPrompt = definePrompt({
  name: 'review_pull_request',
  description: 'Generate a PR review draft.',
  arguments: [
    { name: 'pr_url', description: 'GitHub PR URL', required: true },
  ],
  handler: async ({ pr_url }) => ({
    description: 'Generated PR review',
    messages: [{ role: 'user', content: { type: 'text', text: `Review ${pr_url}...` } }],
  }),
});
```

In Claude Code the prompt becomes available as
`/mcp__<server-name>__review_pull_request`.

### Enabling OAuth

```ts
import {
  createServer,
  loadOAuthConfigFromEnv,
  AuthStore,
} from '@hmcts/crime-mcp-register';

const config = loadOAuthConfigFromEnv();
if (!config) throw new Error('OAuth env vars not set');

const store = new AuthStore();
store.start();

await createServer({
  name: 'my-mcp',
  version: '1.0.0',
  tools: [...],
  transport: {
    mode: 'remote-sse',
    auth: { store, config },
    enforceAuth: true,
  },
});
```

Required environment variables:
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `OAUTH_BASE_URL` (full URL, no trailing slash; must match the GitHub OAuth App's callback URL)

### Adding a `/version` endpoint

```ts
await createServer({
  // ...
  transport: {
    mode: 'remote-sse',
    versionLoader: async () => JSON.stringify({
      hash: 'abc123...',
      generated: new Date().toISOString(),
    }),
  },
});
```

The loader runs on every `GET /version` (no caching layered between it
and the response). If the loader throws, a 500 response is written.

The `crime-frontend-developer-mcp` SessionStart hook polls
`http://localhost:3000/version` on dev to compare against the
locally-cached hash; that's the canonical use of this endpoint.

### Adding a custom HTTP endpoint

Not currently supported through the public API. The HTTP server in
`sse-server.ts` is closed; routing is hard-coded. A consumer needing this
today would have to fork; future work could expose a "user routes" hook.

### Adding a custom auth source

Same answer. The OAuth proxy is hard-wired to GitHub. A future minor
version could parameterise the upstream IdP.

---

## Appendix -- request flow end-to-end

For an authenticated SSE deployment with one tool call:

1. Claude Code GETs `/.well-known/oauth-authorization-server`. Metadata JSON returned.
2. Claude Code POSTs `/register`. Receives `client_id`.
3. Claude Code GETs `/authorize` with `code_challenge` and `state`. Server stashes a
   `PendingAuth` keyed by `state` and 302s to GitHub.
4. User logs in on GitHub. GitHub 302s back to `/callback?code=...&state=...`.
5. Server takes the pending entry by state, exchanges the GitHub code for a
   GitHub access token, fetches the GitHub user login, generates an
   internal auth code, stores a `PendingAuthWithCode`, and 302s to Claude
   Code's original `redirect_uri` with the auth code.
6. Claude Code POSTs `/token` with `grant_type=authorization_code`,
   `code=<our auth code>`, `code_verifier=<PKCE>`. Server verifies the
   PKCE, generates our access + refresh tokens, creates a `Session`,
   stores it indexed by both tokens, and responds with the token pair.
7. Claude Code GETs `/sse` with `Authorization: Bearer <our access token>`.
   The server's middleware looks up the session, captures it on the
   `HttpSession`, opens the SSE stream, calls `factory()` to build a
   fresh Server, connects the SSE transport.
8. Claude Code POSTs `/messages?sessionId=...` with an MCP `tools/call`
   request. The server retrieves the `HttpSession`, runs
   `transport.handlePostMessage` inside `runWithSession(session, ...)`.
9. The SDK dispatches to the tool handler. The handler calls `fetchFile`.
   `fetchFile` calls `createClient()`, which calls `getCurrentSession()`,
   gets back the session, and uses `session.githubAccessToken` for the
   Octokit instance. Octokit reuses the shared keep-alive agent's socket.
10. GitHub responds. The handler returns a result. The SDK serialises it
    over the SSE stream. Claude Code receives the response.

For an unauthenticated stdio deployment, steps 1-7 don't happen; step 8
becomes a stdio JSON-RPC message; step 9 falls through to `getGitHubToken()`
and the `gh` CLI.
