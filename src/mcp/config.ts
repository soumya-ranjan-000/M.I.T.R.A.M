// Parsing and validation of the `mitram.mcpServers` setting.
// Imported by the extension host and by tests, so keep it free of vscode/node imports.

/**
 * How a server's API key is passed to it. The key itself is never stored here: it lives in
 * VS Code's SecretStorage under `mitram.mcpSecret.<id>` and is injected at connect time.
 */
export interface McpAuth {
  /** `header` for remote servers (HTTP header), `env` for local ones (child process variable). */
  kind: 'header' | 'env';
  /** Header name (`Authorization`) or environment variable name (`GITHUB_TOKEN`). */
  name: string;
  /** Template for the value, with `{key}` replaced by the secret. Defaults to `{key}`. */
  format: string;
}

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  /** Key in the settings object, e.g. `playwright`. Used in tool names as `mcp__<id>__<tool>`. */
  id: string;
  transport: McpTransport;
  /** stdio only: the executable to spawn. */
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** http/sse only: the server endpoint. */
  url?: string;
  headers: Record<string, string>;
  /** Set when the server needs an API key. */
  auth?: McpAuth;
  enabled: boolean;
}

export interface ParsedServers {
  servers: McpServerConfig[];
  /** Human-readable reasons entries were rejected or adjusted, for the log and the UI. */
  problems: string[];
}

/** Server ids become part of a tool name, so keep them short and plain. */
const ID = /^[a-zA-Z0-9_-]{1,40}$/;
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Replaces `${env:NAME}` with the value from `env`. Unresolved names become an empty string. */
export function expandEnvRefs(value: string, env: Record<string, string | undefined>, missing?: Set<string>): string {
  return value.replace(ENV_REF, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      missing?.add(name);
      return '';
    }
    return resolved;
  });
}

/** Reads a `Record<string, string>` field, expanding `${env:…}`. Non-string values are rejected. */
function readStringMap(
  raw: unknown,
  field: string,
  id: string,
  env: Record<string, string | undefined>,
  problems: string[],
  missing: Set<string>,
): Record<string, string> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    problems.push(`"${id}": "${field}" must be an object; ignored.`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      problems.push(`"${id}": "${field}.${key}" must be a string; ignored.`);
      continue;
    }
    out[key] = expandEnvRefs(value, env, missing);
  }
  return out;
}

function readAuth(raw: unknown, id: string, transport: McpTransport, problems: string[]): McpAuth | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    problems.push(`"${id}": "auth" must be an object; ignored.`);
    return undefined;
  }
  const kind = raw.kind ?? (transport === 'stdio' ? 'env' : 'header');
  if (kind !== 'header' && kind !== 'env') {
    problems.push(`"${id}": "auth.kind" must be "header" or "env"; ignored.`);
    return undefined;
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    problems.push(`"${id}": "auth.name" is required (the header or variable name); ignored.`);
    return undefined;
  }
  let format = '{key}';
  if (raw.format !== undefined) {
    if (typeof raw.format !== 'string' || !raw.format.includes('{key}')) {
      problems.push(`"${id}": "auth.format" must be a string containing "{key}"; using "{key}".`);
    } else {
      format = raw.format;
    }
  }
  return { kind, name: raw.name.trim(), format };
}

function readTransport(raw: unknown, id: string, url: string | undefined, problems: string[]): McpTransport {
  if (raw !== undefined) {
    if (raw === 'stdio' || raw === 'http' || raw === 'sse') return raw;
    problems.push(`"${id}": "transport" must be "stdio", "http" or "sse"; inferred instead.`);
  }
  if (!url) return 'stdio';
  // Legacy SSE endpoints conventionally end in /sse; everything else is streamable HTTP.
  return /\/sse\/?$/.test(new URL(url).pathname) ? 'sse' : 'http';
}

function parseOne(id: string, raw: unknown, env: Record<string, string | undefined>, problems: string[]): McpServerConfig | null {
  if (!ID.test(id)) {
    problems.push(`"${id}": server names may only use letters, digits, "_" and "-" (max 40 characters); skipped.`);
    return null;
  }
  if (!isRecord(raw)) {
    problems.push(`"${id}": each server must be an object; skipped.`);
    return null;
  }

  const missing = new Set<string>();
  const hasCommand = typeof raw.command === 'string' && raw.command.trim() !== '';
  const hasUrl = typeof raw.url === 'string' && raw.url.trim() !== '';
  if (hasCommand === hasUrl) {
    problems.push(`"${id}": set exactly one of "command" (a local server) or "url" (a remote one); skipped.`);
    return null;
  }

  let url: string | undefined;
  if (hasUrl) {
    url = expandEnvRefs((raw.url as string).trim(), env, missing);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      problems.push(`"${id}": "url" is not a valid URL; skipped.`);
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      problems.push(`"${id}": "url" must use https (or point at localhost); skipped.`);
      return null;
    }
  }

  let args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
      problems.push(`"${id}": "args" must be an array of strings; ignored.`);
    } else {
      args = (raw.args as string[]).map((a) => expandEnvRefs(a, env, missing));
    }
  }

  const transport = readTransport(raw.transport, id, url, problems);
  if (transport === 'stdio' && !hasCommand) {
    problems.push(`"${id}": transport "stdio" needs a "command"; skipped.`);
    return null;
  }
  if (transport !== 'stdio' && !hasUrl) {
    problems.push(`"${id}": transport "${transport}" needs a "url"; skipped.`);
    return null;
  }

  const config: McpServerConfig = {
    id,
    transport,
    ...(hasCommand ? { command: expandEnvRefs((raw.command as string).trim(), env, missing) } : {}),
    args,
    env: readStringMap(raw.env, 'env', id, env, problems, missing),
    ...(url ? { url } : {}),
    headers: readStringMap(raw.headers, 'headers', id, env, problems, missing),
    enabled: raw.enabled === undefined ? true : raw.enabled !== false,
  };

  const auth = readAuth(raw.auth, id, transport, problems);
  if (auth) config.auth = auth;

  if (missing.size) {
    problems.push(`"${id}": no value for ${[...missing].map((n) => `\${env:${n}}`).join(', ')} in this environment.`);
  }
  return config;
}

/**
 * Validates the raw `mitram.mcpServers` setting. Invalid entries are dropped with a reason
 * rather than throwing, so one bad server never stops the others from loading.
 */
export function parseServers(raw: unknown, env: Record<string, string | undefined> = {}): ParsedServers {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { servers: [], problems };
  if (!isRecord(raw)) return { servers: [], problems: ['"mitram.mcpServers" must be an object of server names to settings.'] };

  const servers: McpServerConfig[] = [];
  for (const [id, entry] of Object.entries(raw)) {
    const parsed = parseOne(id, entry, env, problems);
    if (parsed) servers.push(parsed);
  }
  return { servers, problems };
}

/** The value to send for a server's API key, e.g. `Bearer abc123`. */
export function formatAuthValue(auth: McpAuth, key: string): string {
  return auth.format.replace('{key}', key);
}

/** A short description of a server for the UI and logs. Never includes secrets. */
export function describeServer(config: McpServerConfig): string {
  return config.transport === 'stdio' ? [config.command, ...config.args].join(' ') : (config.url ?? '');
}
