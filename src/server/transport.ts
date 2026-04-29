/**
 * Transport factory -- chooses stdio or SSE based on runtime mode.
 *
 * Takes a ServerFactory (not a Server instance) because SSE needs a fresh
 * Server per client connection. Stdio calls the factory once; SSE calls it
 * per incoming /sse request.
 *
 * Modes:
 *   local-stdio  -- subprocess mode (legacy, for local dev without HTTP)
 *   local-sse    -- HTTP SSE on localhost (dev mode -- mirrors production wire-format)
 *   remote-sse   -- HTTP SSE on configured port (production hosted)
 *
 * Selection precedence:
 *   1. config.mode (explicit)
 *   2. env CRIME_MCP_MODE ('stdio' | 'dev' | 'prod')
 *   3. default: 'local-stdio'
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ServerFactory } from './create-server.js';
import type { AuthDeps } from '../auth/endpoints.js';

export type TransportMode = 'local-stdio' | 'local-sse' | 'remote-sse';

export interface TransportConfig {
  mode?: TransportMode;
  port?: number;
  host?: string;
  /** Optional: exposes GET /version on SSE servers. Ignored for stdio. */
  versionLoader?: () => Promise<string>;
  /**
   * Optional: enables OAuth endpoints on SSE servers.
   * Ignored for stdio (no HTTP surface).
   */
  auth?: AuthDeps;
  /** When true, /sse + /messages require Bearer auth. Slice C will enable this. */
  enforceAuth?: boolean;
}

const DEFAULT_DEV_PORT = 3000;
const DEFAULT_PROD_PORT = 8080;

export function resolveMode(explicit?: TransportMode): TransportMode {
  if (explicit) return explicit;
  const env = process.env.CRIME_MCP_MODE?.toLowerCase();
  if (env === 'stdio') return 'local-stdio';
  if (env === 'dev')   return 'local-sse';
  if (env === 'prod')  return 'remote-sse';
  return 'local-stdio';
}

export function resolvePort(mode: TransportMode, explicit?: number): number {
  if (explicit) return explicit;
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  if (envPort && !isNaN(envPort)) return envPort;
  return mode === 'local-sse' ? DEFAULT_DEV_PORT : DEFAULT_PROD_PORT;
}

export async function connectTransport(factory: ServerFactory, config: TransportConfig = {}): Promise<void> {
  const mode = resolveMode(config.mode);

  if (mode === 'local-stdio') {
    // Single instance for the lifetime of the process
    const server = factory();
    await server.connect(new StdioServerTransport());
    return;
  }

  // SSE modes -- import lazily so stdio-only deployments don't load HTTP deps
  const { startSseServer } = await import('./sse-server.js');
  await startSseServer(factory, {
    port: resolvePort(mode, config.port),
    host: config.host ?? (mode === 'local-sse' ? '127.0.0.1' : '0.0.0.0'),
    versionLoader: config.versionLoader,
    auth: config.auth,
    enforceAuth: config.enforceAuth,
  });
}
