/**
 * MCP prompt type -- matches the MCP protocol prompt shape.
 * Prompts surface in Claude Code as slash commands under the server namespace:
 *   /mcp__<server-name>__<prompt-name>
 */

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

export interface McpPrompt {
  name: string;
  description: string;
  arguments?: PromptArgument[];
  handler: (args: Record<string, unknown>) => Promise<PromptResult>;
}

export function definePrompt(prompt: McpPrompt): McpPrompt {
  return prompt;
}
