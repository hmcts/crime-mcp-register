# Project Overview -- `@hmcts/crime-mcp-register`

This document is the *why*. What problem this package solves, what it
deliberately does and does not do, and how it fits into the broader
HMCTS Crime MCP ecosystem. For the *how* (every type and method
documented), read [ARCHITECTURE.md](./ARCHITECTURE.md). For a quick
start, read [README.md](./README.md).

## What this is, in one paragraph

`@hmcts/crime-mcp-register` is a small TypeScript library that
provides the runtime plumbing every HMCTS Crime MCP server needs:
SSE transport, an OAuth 2.1 proxy in front of GitHub, a cached GitHub
client, a per-developer request context, and a server factory that
wires it all together. A consuming plugin imports `createServer` from
this package, declares its tools and an `instructions` field for the
model, and gets a production-ready MCP server with one function call.

## What problem this solves

Every MCP server we build for HMCTS Crime fronts the same
infrastructure:

- **Knowledge that lives in GitHub repositories.** The `cpp-ui-pdk2`
  repo, the various plugin repos, future framework repos -- all are
  read-mostly sources for tools that surface them to Claude Code.
- **Per-developer GitHub authentication in production.** The hosted
  service must not run with a shared service-account token; per-developer
  identity is required for audit and revocation. Every developer
  authenticates with their own GitHub account, and the server holds
  their token only for the lifetime of their session.
- **A version-check loop from local Claude Code installs back to the
  remote knowledge.** Each plugin needs a way to tell Claude Code that
  rule files or agent definitions have been updated upstream so the
  developer can refresh.
- **A cache that respects "the source moved" without thrashing GitHub.**
  Knowledge changes weekly at most; reads can be many per second during
  active development.

Without a shared library, every plugin would reimplement all of this.
Worse, every plugin would reimplement it slightly differently -- the
OAuth proxy especially has enough subtle state machinery
(PKCE verification, session GC, refresh-token rotation) that
copy-paste would produce drift, and drift would produce security bugs.

`@hmcts/crime-mcp-register` exists so that none of this gets reimplemented
per plugin. The plumbing is in one place, reviewed in one place, tested
and patched in one place. A plugin is then *only* its tools, its
`instructions` field, and the GitHub repo it fetches from.

## Who this is for

Engineers building MCP servers that connect Claude Code to HMCTS Crime
GitHub repositories. Today that means:

- `crime-frontend-developer-mcp` -- the Crime Procedure cp-angular
  developer's plugin
- Any future Crime framework MCP plugins (cp-react, cp-be, cp-data, etc.)

If you're building an MCP server *outside* HMCTS Crime infrastructure --
fetching from a different code host, using a different identity provider,
needing different transport semantics -- this package is probably not
for you. It is opinionated about its environment.

## What you provide vs what you get

When you build a plugin on top of `@hmcts/crime-mcp-register`, your code
focuses on:

- **Tool definitions.** Each is a `defineTool({...})` call: name,
  description, JSON schema, async handler. The handler does the actual
  work (fetch a file, search a directory, build a payload, etc.). Your
  consumer-facing surface is a list of these.
- **An `instructions` field.** Plain text that becomes part of the
  model's system prompt every turn for as long as the plugin is
  connected. This is where you tell Claude how to use your tools, what
  to do at session start, when to ask the developer before doing
  anything destructive. It is the single most leveraged part of a
  consumer plugin.
- **Optional prompts.** If your plugin wants slash commands
  (`/mcp__<plugin>__<command>`), define them with `definePrompt`.

The library provides everything else:

- **Transport selection.** `local-stdio` for legacy or subprocess use,
  `local-sse` for local development with the production wire format,
  `remote-sse` for hosted deployments. Selected by `CRIME_MCP_MODE` env
  var or explicit config.
- **The HTTP server when SSE.** Healthcheck, version endpoint, cache
  invalidation, and the MCP transport endpoints, all routed.
- **OAuth 2.1 with PKCE.** Six endpoints, full RFC 7591 dynamic
  registration, RFC 8414 metadata, refresh-token rotation, in-memory
  session store with periodic GC. Per-developer GitHub identity
  threaded through to the GitHub client via async-context.
- **A cached GitHub client.** Two-tier cache (tree + file), 24-hour
  TTL, batched concurrency for multi-file reads, keep-alive HTTPS agent
  shared across all Octokit instances. Per-session token resolution: in
  authenticated SSE sessions, the developer's token is used; in stdio
  or unauthenticated SSE, falls back to `gh auth token`.
- **Session lifecycle management.** `runWithSession` /
  `getCurrentSession` for moving the session through async code without
  threading it through every call.
- **Bundle delivery primitives.** A consumer-agnostic mechanism for
  shipping files to a developer's machine without putting them through
  the MCP tool-result channel: `buildTarGz` produces a UTF-8 no-BOM
  tarball, `storePayload` stashes it in a single-use TTL-bounded store,
  and the SSE server's `GET /payload/:id` route serves it once before
  deleting the entry. Consumer plugins that need to seed developer
  workspaces (PDK rules, agent files, hook scripts) get correct
  byte-perfect installation via `tar -xf` on the developer's side, with
  zero file content travelling through Claude's response tokens. Same
  primitive available to any future plugin without changes.

## What this deliberately does NOT do

- **It does not define your tools.** A plugin that imports this package
  and registers zero tools is technically valid; it just doesn't expose
  anything. Tool surface is the consumer's responsibility.
- **It does not fetch from anywhere except where you tell it.** There
  are no hard-coded repository names, no opinionated paths, no
  "framework knowledge" baked in. You pass a `RepoConfig` to every
  GitHub call.
- **It does not write files to a developer's machine.** That belongs in
  the consumer plugin. `crime-frontend-developer-mcp`'s `setup_workspace`
  tool, for example, writes 27 files to `~/.claude/...` and
  `~/crime-frontend-claude/...` -- but the writing logic is in *that*
  plugin, not in the register. The register provides a server; what the
  tool handlers do with the inputs is entirely the consumer's problem.
- **It does not own the developer-machine SessionStart hook.** That is
  also a consumer-plugin concern. The register provides a `/version`
  endpoint that *can* be polled by such a hook, but defining and
  installing the hook is up to the consumer.
- **It does not provide its own authorisation logic.** OAuth verifies
  *who* the developer is. Whether *that* developer is allowed to call
  *that* tool with *those* arguments is a question the consumer plugin
  must answer if it cares.
- **It does not support transports other than stdio and SSE.** No HTTP
  long-poll, no WebSocket, no IPC pipes. The MCP SDK supports more, but
  this register binds two.
- **It does not support identity providers other than GitHub.** A
  future minor version could parameterise the upstream OAuth client,
  but as of 0.1.0 the OAuth proxy is GitHub-specific.

## Operational requirements per mode

The library supports three transport modes and two GitHub-auth paths
(OAuth session or `gh` CLI fallback). Different combinations have
different operational prerequisites. Use this table to figure out what
you need installed and configured for your scenario.

| Scenario | Transport mode | OAuth required | `gh` CLI required | Use case |
|---|---|---|---|---|
| Subprocess MCP server | `local-stdio` | No | Yes (on developer machine) | Legacy or scripted use |
| Local development | `local-sse` | No | Yes (on developer machine) | Mirroring production wire format locally |
| Hosted, trust-LAN | `remote-sse` (no `auth`) | No | Yes (on the server) | Internal-only deployments |
| Hosted, production | `remote-sse` (with `auth` + `enforceAuth: true`) | Yes | No | Per-developer identity, audit, revocation |
| Build-time scripts | (no server) | No | Yes (wherever the script runs) | `generate:pdk` and similar |

### `gh` CLI as the fallback path

When no OAuth session is present in the current async context, the
GitHub client falls back to running `gh auth token` via `execSync`. This
applies in two situations:

- **Runtime, no OAuth.** Local-stdio mode and local-sse without `enforceAuth`.
  Every request runs without a session, so every GitHub call uses `gh`.
- **Build-time scripts.** The `generate:pdk` script in
  `crime-frontend-developer-mcp` (and any similar consumer scripts) call
  `fetchFile` directly outside an HTTP request lifecycle. There is no
  session to find, so the fallback path is taken.

In both situations the operator running the process is responsible for
having `gh` installed and authenticated. The library does not run
`gh auth login` for you -- it only reads the token via `gh auth token`.
If `gh` is not authenticated, `getGitHubToken()` throws a banner pointing
the operator at `gh auth login`.

### `gh` CLI vs personal access tokens

`gh auth login` and a manually-generated personal access token (PAT) are
different mechanisms:

- A **PAT** is generated by hand in the GitHub web UI under
  *Settings -> Developer settings -> Personal access tokens*. The user picks
  scopes, copies the token, and pastes it into config files or
  environment variables. The token is long-lived (often 90 days, sometimes
  no expiry) and tied to the user's identity directly.
- `gh auth login` runs an OAuth Device Authorization Grant against the
  **GitHub CLI OAuth App** -- GitHub's own first-party application. The
  token issued is an OAuth access token, scoped by the OAuth App's
  registration, stored in the OS keychain, refreshed silently as needed.
  The user does not see or copy it.

Some organisations forbid manually-generated PATs but permit
OAuth-issued tokens via `gh auth login`. Some forbid both. **Verify with
your security team which applies to your environment** before relying on
either as the runtime auth path. The library is agnostic -- it shells out
to `gh auth token` and trusts whatever token comes back.

### CI environments

`gh` honours the `GH_TOKEN` environment variable. If `GH_TOKEN` is set,
`gh auth token` returns its value without any interactive flow. Two
common CI patterns:

```bash
# Pattern 1: pre-authenticate gh with a token from your secret store
echo "$GITHUB_PAT" | gh auth login --with-token

# Pattern 2: just set the env var, no gh auth login needed
export GH_TOKEN="$GITHUB_PAT"
```

In either case, the source of `GITHUB_PAT` (or whatever your secret is
called) is the operational decision: a service account's PAT, a GitHub
App's installation token, an OIDC-exchanged short-lived token, etc.
Choose what your environment requires.

### When `gh` should NOT be used

The intended architecture: `gh` is for personal-machine use (developers
working locally) and operator-machine use (build scripts, CI). It is
**not** the auth mechanism for a hosted runtime serving real users.

A hosted production deployment should configure OAuth and run with
`enforceAuth: true`. Every developer connecting to the server gets their
own session, with their own GitHub identity, audited as them. There is
no shared service-account token in the request path; nothing falls back
to `gh`.

If you find yourself wanting a service-account token in a runtime path
("just give the server a PAT and let it act as 'the system'"), pause --
that is a sign the deployment isn't using OAuth as intended. The whole
point of the OAuth proxy is to avoid that pattern.

## The mental model

Think of `crime-mcp-register` as the runtime; think of a consumer plugin
as the content. The runtime is generic; the content is specific. The
runtime knows nothing about cp-angular or the PDK; the content has no
opinions about how SSE sessions are bound or how OAuth state is stashed.

That separation is what makes it safe to evolve them independently: a
plugin can ship every week with new rules, agents, and tool descriptions
without touching anything in the register. The register can ship a
quarterly update with a transport bug fix or a cache-tier optimisation
without any plugin needing to change.

## Concrete example: how `crime-frontend-developer-mcp` uses this

The consumer plugin's full integration boils down to:

```ts
import { createServer, loadOAuthConfigFromEnv, AuthStore } from '@hmcts/crime-mcp-register';
import { allTools } from './tools';
import { instructionsField } from './instructions';

const oauthConfig = loadOAuthConfigFromEnv();
const store = oauthConfig ? new AuthStore() : undefined;
store?.start();

await createServer({
  name: 'crime-frontend-developer-mcp',
  version: '1.0.0',
  description: 'HMCTS Crime cp-angular developer plugin',
  instructions: instructionsField,
  tools: allTools,
  transport: {
    versionLoader: async () => JSON.stringify(await getKnowledgeVersion()),
    auth: oauthConfig && store ? { store, config: oauthConfig } : undefined,
    enforceAuth: !!oauthConfig,
  },
});
```

Everything else -- SSE on port 3000 (dev) or 8080 (prod), OAuth flow,
session store, cache invalidation hook, GitHub client with the developer's
token -- comes from the register. The plugin is just the tools and the
text the model reads at every turn.

## What you get for free

- Idiomatic mode resolution from `CRIME_MCP_MODE` (`stdio` | `dev` | `prod`)
  with explicit-config override.
- Per-connection MCP `Server` instances on SSE so the SDK's "one
  transport per server" rule isn't violated.
- An auth-aware GitHub client that uses the developer's token in
  production and `gh auth token` in dev -- without the consumer plugin
  threading anything.
- A cache that warms quickly (one tree fetch covers all paths under it),
  bursts efficiently (keep-alive agent), and respects explicit
  invalidation (when the consumer plugin knows the source repo just
  changed).
- A `/version` endpoint the consumer can wire to anything that returns
  a JSON string on demand.
- A `/health` endpoint that reports active session count.
- Session bookkeeping (issue, refresh, expire) without the consumer
  touching it.

## What you should know if you're maintaining this

- **The OAuth proxy is the most subtle part.** The flow has 5
  redirects, 3 token exchanges, and 4 different token kinds. Read
  [ARCHITECTURE.md section 6](./ARCHITECTURE.md#6-the-oauth-proxy) carefully
  before changing anything in `src/auth/`.
- **The factory pattern is load-bearing.** `buildServer` returns a fresh
  `Server` instance every time because the MCP SDK's `Server.connect()`
  is exclusive -- calling it twice on the same Server throws. SSE
  *requires* per-connection Server instances. If you ever refactor
  `create-server.ts`, do not regress this.
- **Octokit is locked at v20.x.** v21+ is ESM-only. Migrating means
  either dual-build or full ESM, both real work, neither in the 0.1.0
  scope.
- **The cache TTL is 24 hours.** That's a deliberate trade-off -- short
  enough that yesterday's content gets refreshed, long enough that
  a busy developer doesn't pay for re-fetches all day. A consumer that
  knows the source has changed (e.g. its own `update_knowledge` tool
  has run) is expected to call `invalidateCache(config)` to force the
  refresh.
- **The session store is in-memory.** Server restart logs everyone
  out. This is documented behaviour, accepted because OAuth flows are
  cheap and persistence introduces concerns out of scope for the
  current architecture.
- **`AsyncLocalStorage` is the load-bearing primitive for per-developer
  identity.** It is what lets a tool handler 5 calls deep in the call
  graph reach `getCurrentSession()` and get the right session without
  it being passed explicitly. If you ever find yourself wanting to
  refactor that out, you will end up threading the session through
  every signature in the codebase. Don't.

## Status

`v0.1.0-beta.0`. Pre-1.0 means the surface may shift in minor
versions. Today's API is stable enough for the in-tree consumer
(`crime-frontend-developer-mcp`); we will commit to semver discipline
once we have at least one external consumer past initial integration.

Known limitations targeted for the v1.0 roadmap:

- Custom HTTP route registration (currently the consumer cannot add
  endpoints alongside the built-ins)
- Pluggable upstream identity provider
- Persisted session store option for production deployments that need
  to survive process restarts without forcing every developer to re-auth
- A way to register middleware in front of tool handlers (logging,
  authorization, rate-limiting)

## Roadmap

The package is consumed by `crime-frontend-developer-mcp` today.
Near-term plans:

1. **0.1.x** -- bug fixes and small refinements driven by real plugin use.
2. **0.2.0** -- custom-route extension point. Consumers can register
   additional HTTP handlers alongside the built-ins.
3. **0.3.0** -- pluggable persistence for `AuthStore`. Default stays
   in-memory; production deployments can opt into a persisted backend.
4. **1.0.0** -- semver lock. After at least one external consumer has
   integrated and the API has been stable for two minor versions.

## When to use a different tool

Use `@hmcts/crime-mcp-register` when you need:

- An MCP server that runs on HMCTS Crime infrastructure
- Per-developer GitHub identity in production
- Knowledge cached from GitHub repositories
- A consistent transport story across local-dev and hosted

Use the bare `@modelcontextprotocol/sdk` directly when you need:

- A non-GitHub identity provider
- A non-SSE transport (e.g. stdio-only with no HTTP at all and no caching)
- An MCP server outside HMCTS Crime infrastructure
- Custom HTTP routes that aren't expressible as tools

There is no shame in choosing the bare SDK; this register is opinionated
on purpose. The opinions are what make it useful for our specific
ecosystem and a poor fit elsewhere.
