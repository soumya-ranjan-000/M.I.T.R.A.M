import type Anthropic from '@anthropic-ai/sdk';
import { Tool, ToolInputError, truncateMiddle } from '../tools/Tool';
import type { McpCallResult, McpToolCaller, McpToolDefinition } from './McpClient';
import { encodeToolName } from './naming';

/** Characters of a server's description kept, so a chatty server cannot flood the prompt. */
const MAX_DESCRIPTION = 1024;
/** Characters of a result sent back to the model. */
const MAX_RESULT = 30_000;
/** Characters of the arguments shown on the approval card. */
const MAX_PREVIEW = 2_000;

/** Used when a server offers no usable schema: the model may still pass arguments. */
const PERMISSIVE_SCHEMA: Anthropic.Tool['input_schema'] = { type: 'object' };

export interface McpToolOptions {
  /** Patterns that block a tool outright, from `mitram.blockedMcpTools`. */
  blocked?: RegExp[];
}

/** The server's own claim that a tool changes nothing. A hint from untrusted software. */
export function isReadOnlyHinted(def: McpToolDefinition): boolean {
  return def.annotations?.readOnlyHint === true;
}

/** Keeps only a schema the API will accept: a JSON Schema object. */
function toInputSchema(raw: unknown): Anthropic.Tool['input_schema'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return PERMISSIVE_SCHEMA;
  const schema = raw as Record<string, unknown>;
  if (schema.type !== 'object') return PERMISSIVE_SCHEMA;
  return schema as Anthropic.Tool['input_schema'];
}

function describe(server: string, def: McpToolDefinition): string {
  const own = (def.description ?? def.annotations?.title ?? '').trim();
  const text = own || `The "${def.name}" tool from the "${server}" MCP server.`;
  return truncateMiddle(`[${server}] ${text}`, MAX_DESCRIPTION);
}

/** The arguments as the user should see them before approving. */
function previewArgs(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input as object).length === 0) return undefined;
  try {
    return truncateMiddle(JSON.stringify(input, null, 2), MAX_PREVIEW);
  } catch {
    return undefined;
  }
}

/**
 * Turns one block of a result into text. Images and embedded resources become a short note:
 * the agent loop sends tool results as text, so there is nowhere to put the bytes.
 */
function blockToText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return '';
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' ? b.text : '';
    case 'image':
      return `[image omitted: ${typeof b.mimeType === 'string' ? b.mimeType : 'unknown type'}]`;
    case 'audio':
      return `[audio omitted: ${typeof b.mimeType === 'string' ? b.mimeType : 'unknown type'}]`;
    case 'resource_link':
      return `[resource: ${typeof b.uri === 'string' ? b.uri : 'unknown'}]`;
    case 'resource': {
      const resource = b.resource as Record<string, unknown> | undefined;
      if (resource && typeof resource.text === 'string') return resource.text;
      const uri = resource && typeof resource.uri === 'string' ? resource.uri : 'unknown';
      return `[resource omitted: ${uri}]`;
    }
    default:
      return '';
  }
}

/** The text of a result, for the model. */
export function flattenResult(result: McpCallResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map(blockToText).filter(Boolean).join('\n').trim();
  if (text) return text;
  // structuredContent is the newer shape; fall back to it before giving up.
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) {
    try {
      return JSON.stringify(structured, null, 2);
    } catch {
      // fall through
    }
  }
  return '';
}

function asArguments(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolInputError('Tool input must be a JSON object.');
  }
  return input as Record<string, unknown>;
}

/**
 * Wraps one of a server's tools as a `Tool`.
 *
 * Every MCP tool needs approval: the server is software the user installed but we cannot inspect,
 * and the tool's own `readOnlyHint` is a claim, not a guarantee. The approval policy may still
 * auto-approve read-hinted tools when the user opts in. Because `requiresApproval` is always true,
 * `ToolRegistry.readOnly()` leaves these out of plan mode, which is what we want.
 */
export function mcpTool(client: McpToolCaller, def: McpToolDefinition, options: McpToolOptions = {}): Tool {
  const server = client.id;
  const name = encodeToolName(server, def.name);
  const blocked = options.blocked ?? [];

  return {
    name,
    description: describe(server, def),
    inputSchema: toInputSchema(def.inputSchema),
    requiresApproval: true,
    preview(input) {
      return {
        summary: `${server}: ${def.name}`,
        detail: previewArgs(input),
        badge: 'MCP',
      };
    },
    policy() {
      const rule = blocked.find((pattern) => pattern.test(name));
      return rule ? `"${name}" is blocked by mitram.blockedMcpTools (${rule.source}).` : null;
    },
    async run(input, ctx) {
      const args = asArguments(input);
      const result = await client.callTool(def.name, args, ctx.signal);
      const text = flattenResult(result);
      if (result.isError) {
        // Report it like any other tool failure, so the loop marks it is_error.
        throw new Error(text || `The MCP server "${server}" reported an error running "${def.name}".`);
      }
      return truncateMiddle(text, MAX_RESULT) || '(the server returned no content)';
    },
  };
}
