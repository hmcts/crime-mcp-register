/**
 * SSE HTTP server for MCP -- accepts SSE connections, wires each to its own
 * fresh MCP Server instance (required: one transport per Server in the SDK).
 *
 * Endpoints:
 *   GET  /sse                    -- SSE connection entry (MCP transport)
 *   POST /messages?sessionId=... -- MCP message ingress
 *   GET  /health                 -- liveness, counts active sessions
 *   GET  /version                -- serves the bundled knowledge version.json
 *                                  (for the SessionStart hook on dev machines)
 *   POST /invalidate-cache       -- clears github client caches (post-deploy hook)
 *
 * Why per-connection Server instances:
 *   The MCP SDK's Server.connect() binds a transport exclusively. A second
 *   connect() call throws "Already connected to a transport". We therefore
 *   create a new Server per /sse request, using the factory passed in by
 *   the transport resolver. All Servers share the same tool/prompt registry
 *   because the factory closes over it.
 *
 * SOLID:
 *   - Each handler has one responsibility
 *   - The http server is a pure router; endpoint logic lives in handlers
 *   - Connection state (transport -> server) tracked in a single map, keyed by sessionId
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { invalidateCache } from '../github/client.js';
import type { ServerFactory } from './create-server.js';
import type { AuthDeps } from '../auth/endpoints.js';
import {
  handleMetadata,
  handleRegister,
  handleAuthorize,
  handleCallback,
  handleToken,
  authenticateRequest,
} from '../auth/endpoints.js';
import { runWithSession } from '../auth/context.js';
import { takePayload } from './payload-store.js';

export interface SseServerConfig {
  port: number;
  host: string;
  versionLoader?: () => Promise<string>;
  /**
   * Optional auth dependencies. When provided, OAuth endpoints are exposed.
   * Middleware enforcement on /sse + /messages is NOT enabled by this alone --
   * see `enforceAuth` below. This lets us roll the endpoints out first,
   * then flip enforcement on in a later change.
   */
  auth?: AuthDeps;
  /**
   * When true, /sse and /messages require a valid Bearer token.
   * When false (default), endpoints exist but are not gated.
   */
  enforceAuth?: boolean;
}

const SSE_PATH = '/sse';
const MESSAGES_PATH = '/messages';
const HEALTH_PATH = '/health';
const VERSION_PATH = '/version';
const INVALIDATE_PATH = '/invalidate-cache';
const PAYLOAD_PREFIX = '/payload/';

const METADATA_PATH  = '/.well-known/oauth-authorization-server';
const REGISTER_PATH  = '/register';
const AUTHORIZE_PATH = '/authorize';
const CALLBACK_PATH  = '/callback';
const TOKEN_PATH     = '/token';

interface HttpSession {
  server: Server;
  transport: SSEServerTransport;
  /**
   * The OAuth session associated with this connection, if auth is enforced.
   * Captured at /sse connect time from the Bearer token and re-applied on
   * every subsequent /messages request for this sessionId.
   */
  authSession?: import('../auth/store.js').Session;
}

type SessionMap = Map<string, HttpSession>;

// --- handlers ----------------------------------------------------------------

function handleSseConnection(
  res: ServerResponse,
  factory: ServerFactory,
  sessions: SessionMap,
  authSession?: import('../auth/store.js').Session,
): void {
  const server = factory();
  const transport = new SSEServerTransport(MESSAGES_PATH, res);
  sessions.set(transport.sessionId, { server, transport, authSession });

  res.on('close', () => {
    sessions.delete(transport.sessionId);
    server.close().catch(() => { /* best-effort cleanup */ });
  });

  server.connect(transport).catch(err => {
    console.error('[sse-server] connect failed:', err);
    sessions.delete(transport.sessionId);
  });
}

function handleMessage(req: IncomingMessage, res: ServerResponse, sessions: SessionMap): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('unknown sessionId');
    return;
  }

  // Run the message handler inside the auth session's async context so tool
  // handlers (and anything they await) can read the current session via
  // getCurrentSession(). Without auth enforcement this is a no-op pass-through.
  const runInContext = session.authSession
    ? (fn: () => void) => runWithSession(session.authSession!, fn)
    : (fn: () => void) => fn();

  runInContext(() => {
    session.transport.handlePostMessage(req, res).catch(err => {
      console.error('[sse-server] message handler failed:', err);
    });
  });
}

function handleHealth(res: ServerResponse, sessions: SessionMap): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
     .end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
}

async function handleVersion(
  res: ServerResponse,
  loader: (() => Promise<string>) | undefined,
): Promise<void> {
  if (!loader) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ error: 'version endpoint not configured' }));
    return;
  }
  try {
    const json = await loader();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(json);
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ error: err.message }));
  }
}

function handleInvalidateCache(res: ServerResponse): void {
  invalidateCache();
  res.writeHead(200, { 'Content-Type': 'application/json' })
     .end(JSON.stringify({ status: 'ok', invalidated: true }));
}

/**
 * GET /payload/:id -- single-use download of a generated bundle.
 *
 * The id was returned by setup_workspace or update_knowledge in the tool
 * result. takePayload() removes the entry on read -- the bundle cannot be
 * fetched a second time. If the id is unknown or expired, returns 404
 * (no body details to avoid information leakage).
 *
 * Auth: NOT gated by the OAuth Bearer because the id itself is the
 * capability -- 192 bits of entropy in a random base64url token is the
 * sole authorisation for this download. The id is delivered to Claude
 * over the (already authenticated) MCP session, then used once.
 *
 * The Content-Disposition header gives the developer's local fetch tool
 * a sensible default filename for `curl -O` style usage, though the apply
 * script doesn't depend on it.
 */
function handlePayload(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const id = url.pathname.slice(PAYLOAD_PREFIX.length);
  if (!id) {
    res.writeHead(404).end();
    return;
  }

  const entry = takePayload(id);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': entry.contentType,
    'Content-Length': entry.bundle.length.toString(),
    'Content-Disposition': `attachment; filename="${entry.filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(entry.bundle);
}

// --- entry point -------------------------------------------------------------

export async function startSseServer(factory: ServerFactory, config: SseServerConfig): Promise<void> {
  const sessions: SessionMap = new Map();

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === SSE_PATH) {
      // When auth enforcement is on, validate Bearer before opening the SSE stream
      // and bind the auth session to this connection so /messages inherits it.
      let authSession;
      if (config.enforceAuth && config.auth) {
        authSession = authenticateRequest(req, res, config.auth);
        if (!authSession) return;  // 401 already written
      }
      return handleSseConnection(res, factory, sessions, authSession);
    }
    if (method === 'POST' && url.pathname === MESSAGES_PATH) {
      // Messages inherit the authSession captured at /sse connect time.
      // We do NOT re-validate the Bearer on each POST -- Claude Code does
      // not resend it on /messages (token is on the SSE GET). If the
      // access token expires mid-session, the upstream GitHub call will
      // fail, Claude Code will reconnect, and /sse will re-validate.
      return handleMessage(req, res, sessions);
    }
    if (method === 'GET'  && url.pathname === HEALTH_PATH)     return handleHealth(res, sessions);
    if (method === 'GET'  && url.pathname === VERSION_PATH)    return handleVersion(res, config.versionLoader);
    if (method === 'POST' && url.pathname === INVALIDATE_PATH) return handleInvalidateCache(res);
    if (method === 'GET'  && url.pathname.startsWith(PAYLOAD_PREFIX)) return handlePayload(req, res);

    // OAuth endpoints -- only routed when auth is configured, so stdio / unauth
    // dev setups don't accidentally surface partial auth surface.
    if (config.auth) {
      if (method === 'GET'  && url.pathname === METADATA_PATH)  return handleMetadata(res, config.auth);
      if (method === 'POST' && url.pathname === REGISTER_PATH)  return handleRegister(req, res, config.auth);
      if (method === 'GET'  && url.pathname === AUTHORIZE_PATH) return handleAuthorize(req, res, config.auth);
      if (method === 'GET'  && url.pathname === CALLBACK_PATH)  return handleCallback(req, res, config.auth);
      if (method === 'POST' && url.pathname === TOKEN_PATH)     return handleToken(req, res, config.auth);
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => {
    http.listen(config.port, config.host, () => {
      console.error(`[sse-server] listening on http://${config.host}:${config.port}${SSE_PATH}`);
      resolve();
    });
  });
}
