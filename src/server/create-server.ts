/**
 * Server factory -- constructs MCP Server instances with tools and optional prompts,
 * connects via transport chosen by environment or explicit config.
 *
 * Why a factory, not a singleton:
 *   MCP's Server.connect() binds a single transport per instance. For stdio
 *   that's fine (one process, one transport). For SSE a new transport is
 *   created per client connection, so each connection needs its own Server
 *   instance -- otherwise the second connection throws "Already connected
 *   to a transport".
 *
 * Design:
 *   - buildServer(config) -- pure factory. Creates a Server, registers tools
 *     and prompts, returns it. Called once for stdio, once-per-connection
 *     for SSE.
 *   - createServer(config) -- public entry point. Connects via the transport
 *     resolver and starts accepting traffic.
 *
 * SOLID:
 *   - Single responsibility per function. Factory builds; entry point wires.
 *   - Tool and prompt registration is symmetric (same pattern, different schema).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { runWithServer } from './server-context.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig, ToolResult } from '../types/tool.js';
import type { McpPrompt } from '../types/prompt.js';
import { connectTransport, type TransportConfig } from './transport.js';

export interface CreateServerConfig extends ServerConfig {
  prompts?: McpPrompt[];
  transport?: TransportConfig;
}

export type ServerFactory = () => Server;

// --- response helpers --------------------------------------------------------

function toMcpResponse(result: ToolResult) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

function toMcpError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// --- registration ------------------------------------------------------------

function registerTools(server: Server, config: CreateServerConfig): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: config.tools.map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = config.tools.find(t => t.name === name);
    if (!tool) return toMcpError(`Unknown tool: ${name}`);
    try {
      const parsed = tool.zodSchema.parse(args ?? {});
      // Wrap in runWithServer so the handler (and anything it awaits) can
      // reach this Server instance via getCurrentServer() -- needed for
      // elicitation and any other client-bound request types.
      const result = await runWithServer(server, () => tool.handler(parsed));
      return toMcpResponse(result);
    } catch (err: any) {
      return toMcpError(`Error in tool "${name}": ${err.message}`);
    }
  });
}

function registerPrompts(server: Server, prompts: McpPrompt[]): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map(({ name, description, arguments: args }) => ({
      name, description, arguments: args,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request): Promise<any> => {
    const prompt = prompts.find(p => p.name === request.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);
    return await prompt.handler(request.params.arguments ?? {});
  });
}

// --- factory -----------------------------------------------------------------

/**
 * Build a fresh MCP Server instance with all tools and prompts registered.
 * Safe to call multiple times -- each returned instance is independent.
 *
 * The `instructions` field is part of the MCP initialize-response. Claude Code
 * injects it into the model's system prompt every turn (NOT the terminal UI).
 * Use it for guidance the model needs whenever this server is involved --
 * e.g. installation checks, tool-usage rules.
 */
export function buildServer(config: CreateServerConfig): Server {
  const capabilities: Record<string, unknown> = { tools: {} };
  if (config.prompts?.length) capabilities.prompts = {};

  // Note on second arg shape: the MCP SDK accepts `instructions` at the top
  // level of ServerOptions (alongside `capabilities`), not inside the
  // implementation info. Older SDK versions ignore unknown fields silently;
  // current versions render it into the initialize response.
  const server = new Server(
    {
      name: config.name,
      version: config.version,
      ...(config.description ? { description: config.description } : {}),
    },
    {
      capabilities,
      ...(config.instructions ? { instructions: config.instructions } : {}),
    },
  );

  registerTools(server, config);
  if (config.prompts?.length) registerPrompts(server, config.prompts);

  return server;
}

// --- entry point -------------------------------------------------------------

export async function createServer(config: CreateServerConfig): Promise<void> {
  const factory: ServerFactory = () => buildServer(config);
  await connectTransport(factory, config.transport);
  console.error(`[${config.name}] v${config.version} running`);
}