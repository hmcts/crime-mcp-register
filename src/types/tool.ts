import { z } from 'zod';

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export type ToolResult = Record<string, unknown>;

type HandlerArgs<T> = T extends (args: infer A) => Promise<ToolResult> ? A : never;

export interface CoreTool<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  zodSchema: z.ZodObject<any>;
  handler: (args: TInput) => Promise<ToolResult>;
}

export interface ServerConfig {
  name: string;
  version: string;
  description?: string;   // <- added
  /**
   * Server `instructions` -- injected into the model's system prompt every
   * turn via the MCP initialize-response. Use for guidance the model needs
   * whenever this server is involved (e.g. installation checks, tool-usage
   * rules). Per Claude Code documentation, this surfaces to the model only,
   * NOT the terminal UI. Optional.
   */
  instructions?: string;
  tools: CoreTool<any>[];
}

function jsonPropertyToZod(prop: JsonSchemaProperty): z.ZodTypeAny {
  if (prop.enum) return z.enum(prop.enum as [string, ...string[]]);
  if (prop.type === 'array') return z.array(z.string());
  if (prop.type === 'number') return z.number();
  return z.string();
}

function jsonSchemaToZod(schema: JsonSchema): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    let field = jsonPropertyToZod(prop);
    const isRequired = schema.required?.includes(key) ?? false;
    if (!isRequired) {
      field = prop.default !== undefined ? field.default(prop.default) : field.optional();
    }
    shape[key] = field;
  }
  return z.object(shape);
}

export function defineTool<THandler extends (args: any) => Promise<ToolResult>>(
  def: { name: string; description: string; inputSchema: JsonSchema; handler: THandler; }
): CoreTool<HandlerArgs<THandler>> {
  return { ...def, zodSchema: jsonSchemaToZod(def.inputSchema) };
}
