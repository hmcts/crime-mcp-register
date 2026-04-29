/**
 * Request context -- lets deeply-nested code (e.g. the GitHub client inside
 * a tool handler) read the current request's session without needing the
 * session threaded through every function signature.
 *
 * Why AsyncLocalStorage:
 *   The MCP SDK's tool dispatch model gives us a callback per tool invocation
 *   but no hook into the request/response boundary we need. Rather than
 *   rewrite every tool signature to accept a `session` argument (brittle,
 *   invasive), we set a context at the request boundary in sse-server.ts
 *   and read it wherever we need the GitHub token.
 *
 *   AsyncLocalStorage correctly propagates context across await points, so
 *   `await fetchFile(...)` inside a tool handler sees the same context as
 *   the incoming HTTP request that triggered it. This is Node's standard
 *   solution for this pattern (Express, Fastify, NestJS all use it).
 *
 * The context is optional: stdio mode has no sessions, so reads return
 * undefined and the GitHub client falls back to its legacy gh CLI path.
 * This keeps stdio / local dev workflows unaffected.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Session } from './store.js';

export interface RequestContext {
  session: Session;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with the given session attached to the async context. Any code
 * executed inside `fn` (synchronously or async) can recover the context
 * via getCurrentSession().
 */
export function runWithSession<T>(session: Session, fn: () => T): T {
  return storage.run({ session }, fn);
}

/**
 * Read the current session if one was set via runWithSession, else undefined.
 * Safe to call anywhere; returns undefined outside a runWithSession scope.
 */
export function getCurrentSession(): Session | undefined {
  return storage.getStore()?.session;
}
