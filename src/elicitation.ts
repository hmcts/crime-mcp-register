/**
 * Elicitation helper -- typed wrapper around the MCP elicitation/create
 * primitive.
 *
 * Elicitation lets a tool handler pause and ask the user for structured
 * input (rendered as a form by the client, when the client supports it --
 * Claude Code 2.1.76+). Unlike a plain tool argument, the schema is
 * presented to the user with default values pre-populated and field-level
 * descriptions; the user submits via the client's UI; the handler resumes
 * with the validated content.
 *
 * Schema constraints (per MCP spec):
 *   The requestedSchema MUST be a flat object with primitive properties
 *   (string, number, boolean, integer, array of enum strings). No nested
 *   objects, no oneOf/anyOf, no recursion. Use `enum` for dropdowns/radio,
 *   `default` for pre-filling, `description` for field labels and hints.
 *
 * Response:
 *   { action: 'accept', content }   -- user submitted the form
 *   { action: 'decline' }            -- user explicitly declined this prompt
 *   { action: 'cancel' }             -- user cancelled / closed
 *
 *   Tool handlers should treat decline and cancel as "user opted out" and
 *   either fall back to a non-interactive flow or return early with an
 *   informative message. Don't error -- the user said no, gracefully.
 *
 * Client capability:
 *   If the client doesn't advertise elicitation support, the SDK will
 *   throw. Callers can catch this and fall back. Use `clientSupportsElicitation()`
 *   to check before calling, when a fallback path matters.
 */

import { getCurrentServer } from './server/server-context.js';

export interface ElicitResult<T = Record<string, unknown>> {
  action: 'accept' | 'decline' | 'cancel';
  content?: T;
}

export interface ElicitProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly (string | number)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  // For array of enum (multi-select), the items property carries the enum:
  items?: { type: 'string'; enum: readonly string[] };
}

export interface ElicitSchema {
  type: 'object';
  properties: Record<string, ElicitProperty>;
  required?: readonly string[];
}

/**
 * Options passed through to the underlying SDK request. Only `timeout` is
 * documented as widely supported; other fields exist on the SDK's RequestOptions
 * but their support varies by version. Extra options are forwarded as-is and
 * silently ignored by older SDKs.
 */
export interface ElicitOptions {
  /**
   * Time in milliseconds to wait for the client's response before the SDK
   * throws. Default behaviour (when omitted) is the SDK's own default --
   * historically 60_000 ms, which is too short for forms with several free-text
   * fields. Callers should set this explicitly.
   */
  timeout?: number;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Send an elicitation request to the client. Returns the user's response.
 *
 * Throws if no Server is in async context (the helper must be called from
 * inside a tool handler running through registerTools), or if the client
 * doesn't support elicitation, or if the request times out. Tool handlers
 * should consider catching to provide a non-interactive fallback --
 * elicitOrFallback() does this for you.
 */
export async function elicitInput<T = Record<string, unknown>>(
  message: string,
  requestedSchema: ElicitSchema,
  options?: ElicitOptions,
): Promise<ElicitResult<T>> {
  const server = getCurrentServer();
  if (!server) {
    throw new Error(
      'elicitInput called outside a tool handler scope. The MCP Server is ' +
      'only available via getCurrentServer() during request handling.',
    );
  }
  // The SDK's Server class exposes elicitInput (added in MCP spec 2025-06-18).
  // It returns { action, content? } per the spec. The second argument is the
  // SDK's RequestOptions -- forwarded as-is. Older SDKs that didn't accept
  // a second argument will ignore it (extra positional args are not an error
  // in JS), so passing this is always safe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any).elicitInput(
    { message, requestedSchema },
    options,
  ) as Promise<ElicitResult<T>>;
}

/**
 * Whether the connected client advertised elicitation support during the
 * initialise handshake. False if running on stdio, false if the client is
 * older than Claude Code 2.1.76, true otherwise.
 *
 * Tool handlers wanting a graceful fallback should check this BEFORE the
 * elicitation call, then either elicit or fall back to non-interactive
 * behaviour as appropriate.
 */
export function clientSupportsElicitation(): boolean {
  const server = getCurrentServer();
  if (!server) return false;
  // The SDK exposes the negotiated client capabilities after initialise.
  // Look for elicitation in the capabilities object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const caps = (server as any).getClientCapabilities?.();
  return Boolean(caps?.elicitation);
}

/**
 * Outcome of an elicitOrFallback call.
 *
 * `source` tells the consumer what path produced the result:
 *   - 'elicitation' -- user filled the form, answers came from the client
 *   - 'fallback'    -- user did not fill the form (declined, cancelled, the
 *                      client doesn't render elicitation, or the SDK threw),
 *                      answers came from the fallback callback
 *
 * `action` is the user-response action when the elicitation path was taken
 * AND a response actually came back. Absent on capability skip / SDK throw.
 *
 * `error` is set when the fallback was taken specifically because the SDK
 * threw or the response shape was unexpected. Production callers can ignore
 * it; diagnostics surface it. Absent on a clean accept or a clean decline.
 *
 * `rawResult` is the unprocessed return value from the underlying
 * elicitInput call, when one came back. Production callers can ignore it;
 * diagnostics use it to inspect what the SDK actually produced. Absent
 * when elicitInput threw or wasn't called at all.
 */
export interface ElicitOrFallbackResult<T> {
  source: 'elicitation' | 'fallback';
  /** The user response action when the elicitation path was taken. */
  action?: 'accept' | 'decline' | 'cancel';
  /** The resolved values -- either from the user or from the fallback. */
  values: T;
  /** Error message if the fallback was taken because of an exception. */
  error?: string;
  /** Raw underlying elicitInput result, for diagnostics only. */
  rawResult?: unknown;
}

/**
 * Options for elicitOrFallback. Currently just timeout, but designed so we
 * can extend later (per-task customisation, retry policy, etc.) without
 * breaking callers.
 */
export interface ElicitOrFallbackOptions {
  /**
   * Maximum time to wait for the user's elicitation response, in milliseconds.
   * Defaults to 300_000 (5 minutes) -- long enough for thoughtful form-filling
   * with several free-text fields, short enough that a genuinely abandoned
   * session frees the server's pending request. Callers with shorter forms
   * (e.g. yes/no confirmations) can pass a smaller value; callers with very
   * long forms can pass a larger one.
   */
  timeout?: number;
}

/**
 * Try elicitation; if anything other than accept comes back, use the
 * provided fallback to produce values.
 *
 * Always returns successfully -- never throws. The fallback path is taken
 * for ALL non-accept outcomes (decline, cancel, client doesn't support
 * elicitation, SDK error, request timeout). The caller doesn't need to
 * know which because the right behaviour is the same: use the fallback
 * values.
 *
 * On SDK error or timeout, `error` is populated so callers (especially
 * diagnostics) can surface what went wrong. On clean decline/cancel,
 * `error` is absent -- the user opted out, no error happened.
 *
 * Why no client detection: VS Code's MCP extension currently auto-declines
 * elicitation requests without rendering the form. CLI Claude Code renders
 * properly. Rather than maintain a list of "broken" clients (which would
 * go stale when VS Code fixes the bug, or miss new clients), we treat any
 * non-accept outcome identically. The user gets the fallback values; if
 * they want to override, the tool's downstream logic should let them
 * (e.g. by also surfacing a Markdown intake form in the response).
 *
 * Usage:
 *
 * ```ts
 * const result = await elicitOrFallback(
 *   'Configure form options',
 *   schema,
 *   () => ({ format: 'json', pageSize: 10 }),  // sensible defaults
 *   { timeout: 600_000 }                        // 10 min for a long form
 * );
 * if (result.source === 'fallback') {
 *   // optionally surface a Markdown intake to the developer
 * }
 * useThe(result.values);
 * ```
 */
export async function elicitOrFallback<T extends Record<string, unknown>>(
  message: string,
  requestedSchema: ElicitSchema,
  fallback: () => T,
  options?: ElicitOrFallbackOptions,
): Promise<ElicitOrFallbackResult<T>> {
  // Quick out: if the client didn't advertise elicitation in the handshake,
  // skip the round-trip entirely.
  if (!clientSupportsElicitation()) {
    return { source: 'fallback', values: fallback() };
  }

  const timeout = options?.timeout ?? 300_000;

  let rawResult: unknown;
  try {
    const result = await elicitInput<T>(message, requestedSchema, { timeout });
    rawResult = result;
    if (result.action === 'accept' && result.content) {
      return {
        source: 'elicitation',
        action: 'accept',
        values: result.content as T,
        rawResult,
      };
    }
    if (result.action === 'accept') {
      // Accept with no/empty content -- treat as a malformed response.
      // Surface the error so callers can see something unexpected happened
      // rather than silently using defaults the user didn't choose.
      return {
        source: 'fallback',
        action: 'accept',
        values: fallback(),
        error: 'elicitInput returned action=accept but content was empty or missing',
        rawResult,
      };
    }
    // Decline or cancel -- fall back. Preserve the action so the caller
    // can tell whether the user actively opted out vs the surface
    // auto-declined. No error -- this is a legitimate outcome.
    return {
      source: 'fallback',
      action: result.action,
      values: fallback(),
      rawResult,
    };
  } catch (err: unknown) {
    // SDK error, timeout, or any unexpected throw. Capture the message so
    // callers can surface it for diagnosis, then fall back to defaults.
    const message = err instanceof Error ? err.message : String(err);
    return {
      source: 'fallback',
      values: fallback(),
      error: message,
      rawResult,
    };
  }
}