/**
 * crime-mcp-register -- generic MCP foundation.
 * Extended by crime-pdk-mcp and any future framework-specific servers.
 */

// GitHub
export { getGitHubToken } from './github/auth.js';
export { fetchFile, listFiles, searchInFiles, chunk, invalidateCache } from './github/client.js';
export type { RepoConfig, FileResult, SearchMatch } from './github/client.js';

// Types
export { defineTool } from './types/tool.js';
export type {
  CoreTool, JsonSchema, JsonSchemaProperty, ToolResult, ServerConfig,
} from './types/tool.js';
export { definePrompt } from './types/prompt.js';
export type {
  McpPrompt, PromptArgument, PromptMessage, PromptResult,
} from './types/prompt.js';

// Server
export { createServer, buildServer } from './server/create-server.js';
export type { CreateServerConfig, ServerFactory } from './server/create-server.js';
export type { TransportMode, TransportConfig } from './server/transport.js';

// Auth (OAuth proxy for remote SSE mode)
export { AuthStore } from './auth/store.js';
export type { Session, PendingAuth, PendingAuthWithCode } from './auth/store.js';
export { loadOAuthConfigFromEnv } from './auth/config.js';
export type { OAuthConfig } from './auth/config.js';
export type { AuthDeps } from './auth/endpoints.js';
export { runWithSession, getCurrentSession } from './auth/context.js';
export type { RequestContext } from './auth/context.js';

// Bundle delivery: one-time-use download URLs for setup/update payloads.
// Used by consumer plugins to ship a tarball of files for Claude to fetch
// and extract on the developer's machine.
export { storePayload, payloadStoreSize } from './server/payload-store.js';
export { buildTarGz } from './server/tar-gz.js';
export type { TarEntry } from './server/tar-gz.js';

// Elicitation: structured form input from the user (Claude Code 2.1.76+).
// Tool handlers can pause and ask the user for boolean / enum / multi-select /
// numeric / string input, rendered as a form by the client. Falls back gracefully
// when the client doesn't support it via clientSupportsElicitation().
export { elicitInput, clientSupportsElicitation, elicitOrFallback } from './elicitation.js';
export type {
  ElicitResult,
  ElicitSchema,
  ElicitProperty,
  ElicitOrFallbackResult,
  ElicitOptions,
  ElicitOrFallbackOptions,
} from './elicitation.js';
export { runWithServer, getCurrentServer } from './server/server-context.js';