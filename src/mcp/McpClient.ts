import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpServerConfig, describeServer, formatAuthValue } from './config';

/**
 * What we call ourselves in the MCP handshake. This is the client protocol identity, not the
 * extension's version, so it deliberately does not track package.json: servers may branch on it,
 * and it should only change when our client behaviour does.
 */
const CLIENT_VERSION = '1.0.0';

/** How long to wait for a server to start and answer `initialize`. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** How long one tool call may take. */
export const CALL_TIMEOUT_MS = 60_000;

export type McpStatus = 'idle' | 'connecting' | 'ready' | 'failed' | 'disabled';

/** A tool as the server describes it. Only the parts we use. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    /** The server's claim that the tool changes nothing. A hint, never a guarantee. */
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

/** The result of a tool call, before it is flattened to text. */
export interface McpCallResult {
  content: unknown[];
  isError?: boolean;
}

/** What `mcpTool` needs from a server, so tests can supply a fake. */
export interface McpToolCaller {
  readonly id: string;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
}

export interface McpClientDeps {
  /** The server's API key, read from secret storage when the server declares `auth`. */
  getApiKey?: (serverId: string) => Promise<string | undefined>;
  /** Log sink. Never receives arguments, results or secrets. */
  log?: (message: string) => void;
  /** Replaces the transport, for tests. */
  createTransport?: (config: McpServerConfig, key: string | undefined) => Transport;
}

/** The message shown when a server needs a key that has not been set. */
export const MISSING_KEY = 'no API key set';

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim() || 'unknown error';
}

/** Runs `work`, rejecting if it takes longer than `ms`. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One MCP server: connect, list its tools, call them, shut it down.
 *
 * A failure here never throws outward on connect; it is recorded as `failed` with a reason, so a
 * broken server costs the user its tools and nothing else. Arguments, results, environment values
 * and headers are never logged: they routinely hold credentials.
 */
export class McpClient implements McpToolCaller {
  private client?: Client;
  private transport?: Transport;
  private connecting?: Promise<void>;
  private state: McpStatus;
  private lastError?: string;
  private definitions: McpToolDefinition[] = [];
  /** The tail of the server's stderr, to explain a failure to start. */
  private stderr = '';

  constructor(
    readonly config: McpServerConfig,
    private readonly deps: McpClientDeps = {},
  ) {
    this.state = config.enabled ? 'idle' : 'disabled';
  }

  get id(): string {
    return this.config.id;
  }

  get status(): McpStatus {
    return this.state;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  get tools(): McpToolDefinition[] {
    return this.definitions;
  }

  /** Connects and lists tools, at most once at a time. Never throws; check `status` after. */
  async start(): Promise<void> {
    if (this.state === 'disabled' || this.state === 'ready') return;
    this.connecting ??= this.run().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async run(): Promise<void> {
    this.state = 'connecting';
    this.lastError = undefined;
    const started = Date.now();
    try {
      const key = this.config.auth ? await this.deps.getApiKey?.(this.config.id) : undefined;
      if (this.config.auth && !key) throw new Error(MISSING_KEY);

      this.transport = this.deps.createTransport?.(this.config, key) ?? this.buildTransport(key);
      this.client = new Client({ name: 'mitram', version: CLIENT_VERSION }, { capabilities: {} });

      await withTimeout(this.client.connect(this.transport), CONNECT_TIMEOUT_MS, 'connection');
      const listed = await withTimeout(this.client.listTools(), CONNECT_TIMEOUT_MS, 'listing tools');
      this.definitions = (listed.tools ?? []) as McpToolDefinition[];
      this.state = 'ready';
      this.deps.log?.(`mcp ${this.id}: ready, ${this.definitions.length} tools in ${Date.now() - started}ms`);
    } catch (error) {
      this.state = 'failed';
      this.lastError = this.explain(errorText(error));
      this.deps.log?.(`mcp ${this.id}: failed (${this.lastError})`);
      await this.shutdown();
    }
  }

  /** Adds the server's own stderr to a bare failure, which is usually where the real reason is. */
  private explain(message: string): string {
    const tail = this.stderr.trim().split('\n').filter(Boolean).pop();
    return tail && !message.includes(tail) ? `${message} — ${tail.slice(0, 200)}` : message;
  }

  private buildTransport(key: string | undefined): Transport {
    const { config } = this;
    const authHeader = config.auth?.kind === 'header' && key ? { [config.auth.name]: formatAuthValue(config.auth, key) } : {};

    if (config.transport === 'stdio') {
      const authEnv = config.auth?.kind === 'env' && key ? { [config.auth.name]: formatAuthValue(config.auth, key) } : {};
      const transport = new StdioClientTransport({
        command: config.command!,
        args: config.args,
        // Only the variables the server needs, plus the safe defaults: the agent's own
        // environment may hold credentials for unrelated services.
        env: { ...getDefaultEnvironment(), ...config.env, ...authEnv },
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString()).slice(-2000);
      });
      return transport;
    }

    const url = new URL(config.url!);
    const headers = { ...config.headers, ...authHeader };
    if (config.transport === 'sse') {
      return new SSEClientTransport(url, {
        requestInit: { headers },
        // The stream is opened with fetch, which ignores requestInit, so add them here too.
        eventSourceInit: {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers } }),
        },
      } as ConstructorParameters<typeof SSEClientTransport>[1]);
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    if (this.state !== 'ready' || !this.client) {
      throw new Error(`The MCP server "${this.id}" is not connected${this.lastError ? ` (${this.lastError})` : ''}.`);
    }
    const started = Date.now();
    const result = (await this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: CALL_TIMEOUT_MS,
    })) as McpCallResult;
    this.deps.log?.(`mcp ${this.id}: ${name} ${result.isError ? 'error' : 'ok'} in ${Date.now() - started}ms`);
    return result;
  }

  /** Closes the connection and kills the child process. Safe to call more than once. */
  async close(): Promise<void> {
    await this.shutdown();
    if (this.state !== 'disabled') this.state = 'idle';
    this.definitions = [];
  }

  private async shutdown(): Promise<void> {
    const { client, transport } = this;
    this.client = undefined;
    this.transport = undefined;
    try {
      await client?.close();
    } catch {
      // Already gone; the transport is closed below regardless.
    }
    try {
      await transport?.close();
    } catch {
      // Nothing more we can do.
    }
  }

  /** A line for the log or the MCP panel. Contains no secrets. */
  describe(): string {
    return `${this.id} (${this.config.transport}) ${describeServer(this.config)}`;
  }
}
