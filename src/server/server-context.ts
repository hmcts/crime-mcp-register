/**
 * Server context -- lets tool handlers reach the current MCP Server instance
 * for capabilities like elicitation that require sending a request back to
 * the client.
 *
 * Why AsyncLocalStorage:
 *   The MCP SDK's tool dispatch model gives the handler the parsed args and
 *   nothing else. Operations like server.elicitInput() require the Server
 *   instance, but threading it through every defineTool() handler signature
 *   would be a breaking change for every existing consumer.
 *
 *   Instead, we set the Server in async context at the request boundary
 *   (registerTools in create-server.ts wraps each handler invocation in
 *   runWithServer), and tools that need it call getCurrentServer() at
 *   any depth. Same pattern used for per-developer sessions.
 *
 * Out-of-scope reads:
 *   getCurrentServer() returns undefined outside a runWithServer scope --
 *   for example if a tool is invoked through a non-MCP path, or during
 *   unit tests. Helpers built on top (like elicitInput) handle the
 *   undefined case explicitly.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

interface ServerContext {
  server: Server;
}

const storage = new AsyncLocalStorage<ServerContext>();

/**
 * Run `fn` with the given Server attached to the async context. Tool
 * handlers run inside this scope; anything they call (sync or async)
 * can recover the Server via getCurrentServer().
 */
export function runWithServer<T>(server: Server, fn: () => T): T {
  return storage.run({ server }, fn);
}

/**
 * Read the current Server if set via runWithServer, else undefined.
 * Tool handlers running inside the MCP request lifecycle always see
 * a defined Server. Code paths outside the request lifecycle (tests,
 * direct programmatic invocation) see undefined.
 */
export function getCurrentServer(): Server | undefined {
  return storage.getStore()?.server;
}