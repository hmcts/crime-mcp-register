# `@hmcts/crime-mcp-register`

> Runtime plumbing for HMCTS Crime MCP servers -- SSE transport, OAuth
> proxy, cached GitHub client, server factory. Bring your tools and
> your `instructions` field; this package handles everything else.

[![@hmcts/crime-mcp-register in hmcts-lib](https://img.shields.io/badge/npm-0.1.0-blue.svg)](https://dev.azure.com/hmcts/Artifacts/_artifacts/feed/hmcts-lib/Npm/@hmcts%2Fcrime-mcp-register)
[![Status: beta](https://img.shields.io/badge/status-beta-yellow.svg)](#status)

## Install

```bash
npm install @hmcts/crime-mcp-register
```

## What this is

`@hmcts/crime-mcp-register` is the foundation every HMCTS Crime MCP server
sits on. A consumer plugin (e.g. `crime-frontend-developer-mcp`) imports
`createServer`, declares its tools and an `instructions` field for the
model, and gets:

- SSE transport with per-connection MCP Server instances
- A complete OAuth 2.1 + PKCE flow proxying GitHub for per-developer
  identity in production
- A cached GitHub client that respects per-session tokens
- A `/version` endpoint plugins can wire to a hash-of-knowledge loader
- A `/health` endpoint reporting active session count
- An async-context primitive for threading session identity through
  deeply-nested tool handlers without changing every signature
- Bundle delivery primitives: `buildTarGz` + `storePayload` + a
  single-use `GET /payload/:id` download route, for shipping files to a
  developer's machine without inflating MCP tool results

All transport modes (`local-stdio`, `local-sse`, `remote-sse`) share the
same factory and tool registration code. A plugin author writes one set
of tools and runs them locally over stdio or remotely over SSE without
changing tool code.

## Minimal example

```ts
import { createServer, defineTool } from '@hmcts/crime-mcp-register';

const greet = defineTool({
  name: 'greet',
  description: 'Greet a person by name.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Who to greet.' },
    },
    required: ['name'],
  },
  handler: async ({ name }) => ({ greeting: `Hello, ${name}!` }),
});

await createServer({
  name: 'hello-mcp',
  version: '0.1.0',
  instructions: 'When asked to greet someone, use the greet tool.',
  tools: [greet],
});
```

By default this runs over stdio. Set `CRIME_MCP_MODE=dev` to run over
SSE on `http://127.0.0.1:3000/sse`. Set `CRIME_MCP_MODE=prod` to run
over SSE on `0.0.0.0:8080`.

## Real-world example: enabling OAuth

For a hosted deployment with per-developer GitHub auth:

```ts
import {
  createServer,
  loadOAuthConfigFromEnv,
  AuthStore,
} from '@hmcts/crime-mcp-register';
import { allTools } from './tools';
import { instructionsField } from './instructions';

const oauthConfig = loadOAuthConfigFromEnv();
const store = oauthConfig ? new AuthStore() : undefined;
store?.start();

await createServer({
  name: 'my-mcp',
  version: '0.1.0',
  instructions: instructionsField,
  tools: allTools,
  transport: {
    versionLoader: async () => JSON.stringify({
      hash: await computeKnowledgeHash(),
      generated: new Date().toISOString(),
    }),
    auth: oauthConfig && store ? { store, config: oauthConfig } : undefined,
    enforceAuth: !!oauthConfig,
  },
});
```

Required environment variables when `enforceAuth` is on:
- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `OAUTH_BASE_URL` -- full URL of this server, no trailing slash, must
  match the GitHub OAuth App's callback URL

## Where to read next

- **[PROJECT-OVERVIEW.md](./PROJECT-OVERVIEW.md)** -- what problem this
  solves, what it deliberately doesn't do, the mental model, and how
  to decide whether this is the right tool. Aimed at anyone evaluating
  the package or about to write a plugin against it.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** -- every public symbol
  documented, transport modes, OAuth flow, error model, extension
  points. Aimed at anyone maintaining the package or wiring it into a
  plugin in detail.

## Common tasks

### Define a tool

```ts
import { defineTool } from '@hmcts/crime-mcp-register';

const myTool = defineTool({
  name: 'my_tool',
  description: 'What it does, in detail. Used by the model verbatim.',
  inputSchema: { /* JSON schema (object only) */ },
  handler: async (args) => ({ /* ToolResult */ }),
});
```

The JSON schema is automatically converted to a Zod schema for runtime
validation. Invalid arguments produce a tool error before your handler
runs.

### Define a prompt (slash command)

```ts
import { definePrompt } from '@hmcts/crime-mcp-register';

const myPrompt = definePrompt({
  name: 'my_prompt',
  description: 'What this prompt does.',
  arguments: [{ name: 'topic', required: true }],
  handler: async ({ topic }) => ({
    description: 'Generated for ' + topic,
    messages: [{ role: 'user', content: { type: 'text', text: '...' } }],
  }),
});
```

Pass it via `prompts: [myPrompt]` to `createServer`. Surfaces in Claude
Code as `/mcp__<server-name>__my_prompt`.

### Fetch a file from GitHub

```ts
import { fetchFile } from '@hmcts/crime-mcp-register';

const content = await fetchFile(
  { owner: 'hmcts', repo: 'cpp-ui-pdk2', branch: 'main' },
  'projects/pdk/src/button/button.ts',
);
```

Cached for 24 hours. Call `invalidateCache({ owner, repo, branch })` to
clear when you know the source has changed.

### Read the current developer's session

```ts
import { getCurrentSession } from '@hmcts/crime-mcp-register';

async function myHandler(args) {
  const session = getCurrentSession();
  if (session) {
    console.log('Acting as', session.githubUserLogin);
  }
}
```

Returns `undefined` outside an authenticated SSE request (stdio mode,
or SSE without `enforceAuth`). The GitHub client uses this internally
already; you only need to call it directly if you have logic that depends
on per-developer identity.

## Configuration reference

Most setups need only `name`, `version`, `tools`, and `instructions` on
the `createServer` call. Everything else has reasonable defaults.

For the full reference of every config field and what it does, see
[ARCHITECTURE.md section 3 -- `ServerConfig`](./ARCHITECTURE.md#3-the-serverconfig-contract)
and [section 4 -- Transport modes](./ARCHITECTURE.md#4-transport-modes-and-lifecycle).

## Status

`v0.1.0-beta.0`. Pre-1.0 -- minor versions may introduce breaking changes
until the API stabilises around at least one external consumer.

Today's surface is stable enough for `crime-frontend-developer-mcp`,
which has driven its design. We will commit to semver discipline once
the package has been used in at least one plugin outside the in-tree one.

## Repository

[`hmcts/crime-mcp-register`](https://github.com/hmcts/crime-mcp-register).
Issues and contributions welcome.

### Contribute to This Repository

Contributions are welcome! Please see the [CONTRIBUTING.md](.github/CONTRIBUTING.md) file for guidelines.

## License

This project is licensed under the [MIT License](LICENSE).
