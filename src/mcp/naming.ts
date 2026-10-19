// Encoding of MCP tool names into the single flat namespace the model API allows.
// Pure: no vscode/node imports, so tests can use it directly.

/** The API accepts `^[a-zA-Z0-9_-]{1,64}$` for a tool name. */
export const MAX_TOOL_NAME = 64;

const PREFIX = 'mcp__';
const SEP = '__';
/** Characters of the tool name always kept, so the server part can never crowd it out. */
const MIN_TOOL_CHARS = 12;

/** Replaces anything the API would reject with `_`. */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  // A name must not be empty, and a leading "-" reads like a flag in logs.
  return cleaned === '' ? '_' : cleaned;
}

/** FNV-1a, as 4 hex characters. Keeps two truncated names from colliding. */
function hash4(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 16).toString(16).padStart(4, '0');
}

/** Cuts `tool` to `budget` characters, ending with a hash so distinct tools stay distinct. */
function shorten(tool: string, budget: number): string {
  if (budget <= 5) return hash4(tool).slice(0, Math.max(1, budget));
  return `${tool.slice(0, budget - 5)}_${hash4(tool)}`;
}

/**
 * The name one of `server`'s tools is offered to the model under: `mcp__<server>__<tool>`.
 *
 * The `mcp__` prefix keeps these out of the built-in tools' namespace, and the server id keeps
 * two servers' identically named tools apart. Over-long names are truncated with a hash rather
 * than cut, so they cannot collide.
 */
export function encodeToolName(server: string, tool: string): string {
  let id = sanitize(server);
  const name = sanitize(tool);
  const maxServer = MAX_TOOL_NAME - PREFIX.length - SEP.length - MIN_TOOL_CHARS;
  if (id.length > maxServer) id = shorten(id, maxServer);
  const budget = MAX_TOOL_NAME - PREFIX.length - id.length - SEP.length;
  return `${PREFIX}${id}${SEP}${name.length <= budget ? name : shorten(name, budget)}`;
}

/** Whether this is one of our MCP tool names. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(PREFIX) && name.includes(SEP, PREFIX.length);
}

/**
 * Splits an encoded name back into server and tool.
 *
 * A server id may itself contain `__`, so pass the configured ids whenever you have them: the
 * longest matching id wins. Without them this splits at the first `__`, which is right for
 * ordinary ids and only used for display.
 */
export function decodeToolName(name: string, serverIds: readonly string[] = []): { server: string; tool: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);

  let best: string | undefined;
  for (const id of serverIds) {
    const sanitized = sanitize(id);
    if (rest.startsWith(sanitized + SEP) && (best === undefined || sanitized.length > best.length)) best = sanitized;
  }
  if (best !== undefined) {
    const match = serverIds.find((id) => sanitize(id) === best);
    return { server: match ?? best, tool: rest.slice(best.length + SEP.length) };
  }

  const at = rest.indexOf(SEP);
  if (at <= 0) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + SEP.length) };
}

/** "server: tool", for a card summary or a log line. */
export function describeToolName(name: string, serverIds: readonly string[] = []): string {
  const parts = decodeToolName(name, serverIds);
  return parts ? `${parts.server}: ${parts.tool}` : name;
}
