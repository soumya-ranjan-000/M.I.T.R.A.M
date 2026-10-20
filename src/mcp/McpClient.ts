import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as os from 'node:os';
import { McpServerConfig, describeServer, formatAuthValue } from './config';
import { OAuthHost, McpOAuthProvider, SignInRequired, startOAuthCallback } from './oauth';
import { normalizeServerArgs } from './paths';

/**
 * What we call ourselves in the MCP handshake. This is the client protocol identity, not the
 * extension's version, so it deliberately does not track package.json: servers may branch on it,
 * and it should only change when our client behaviour does.
 */
const CLIENT_VERSION = '1.0.0';

/** How long to wait for a remote server to answer `initialize`. */
export const CONNECT_TIMEOUT_MS = 15_000;
/**
 * A local server started with `npx` downloads its package on the first run, which on Windows (where
 * `npx.cmd` goes through cmd.exe and antivirus scans each file) routinely takes over a minute.
 */
export const STDIO_CONNECT_TIMEOUT_MS = 90_000;
/** How long one tool call may take. */
export const CALL_TIMEOUT_MS = 60_000;

/** `needs-auth`: the server wants the user to sign in, which only happens when they ask. */
export type McpStatus = 'idle' | 'connecting' | 'ready' | 'failed' | 'disabled' | 'needs-auth';

/** How long the user has to finish signing in in the browser. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

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
  /** Where OAuth credentials live and how to reach the user's browser. Needed for `auth.kind: "oauth"`. */
  oauth?: OAuthHost;
  /** Replaces the sign-in timeout, for tests. */
  signInTimeoutMs?: number;
}

/** The message shown when a server needs a key that has not been set. */
export const MISSING_KEY = 'no API key set';

/** The server answered 401 or would need the user: a sign-in is needed, which is not a failure. */
function needsSignIn(error: unknown): boolean {
  return error instanceof SignInRequired || error instanceof UnauthorizedError || (error as { name?: string } | null)?.name === 'SignInRequired';
}

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
      const oauth = this.config.auth?.kind === 'oauth';
      const key = this.config.auth && !oauth ? await this.deps.getApiKey?.(this.config.id) : undefined;
      if (this.config.auth && !oauth && !key) throw new Error(MISSING_KEY);
      if (oauth && !this.deps.oauth) throw new Error('OAuth sign-in is not available here');

      // Without `interactive` the provider only reuses saved credentials, so this never opens a browser.
      const provider = oauth ? new McpOAuthProvider({ store: this.deps.oauth!.store(this.id) }) : undefined;
      this.transport = this.deps.createTransport?.(this.config, key) ?? this.buildTransport(key, provider);
      this.client = new Client({ name: 'mitram', version: CLIENT_VERSION }, { capabilities: {} });

      const connectMs = this.config.transport === 'stdio' ? STDIO_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
      await withTimeout(this.client.connect(this.transport), connectMs, 'connection');
      const listed = await withTimeout(this.client.listTools(), CONNECT_TIMEOUT_MS, 'listing tools');
      this.definitions = (listed.tools ?? []) as McpToolDefinition[];
      this.state = 'ready';
      this.deps.log?.(`mcp ${this.id}: ready, ${this.definitions.length} tools in ${Date.now() - started}ms`);
    } catch (error) {
      if (this.config.auth?.kind === 'oauth' && needsSignIn(error)) {
        this.state = 'needs-auth';
        this.lastError = undefined;
        this.deps.log?.(`mcp ${this.id}: needs sign-in`);
      } else {
        this.state = 'failed';
        this.lastError = this.explain(errorText(error));
        this.deps.log?.(`mcp ${this.id}: failed (${this.lastError})`);
      }
      await this.shutdown();
    }
  }

  /**
   * Signs the user in through their browser, then connects. If saved credentials still work this
   * just connects. Otherwise it listens on loopback for the redirect, opens the sign-in page and
   * waits for the user, who can take as long as the timeout allows. Never throws: the outcome is
   * the status, with the reason in `error` if it failed.
   */
  async signIn(): Promise<void> {
    const host = this.deps.oauth;
    if (this.config.auth?.kind !== 'oauth' || !host || this.state === 'disabled') return;
    await this.close();

    // Saved credentials first: a signed-in server must not be sent through the browser again.
    await this.start();
    if (this.state !== 'needs-auth') return;

    this.state = 'connecting';
    this.lastError = undefined;
    let provider: McpOAuthProvider | undefined;
    const callback = await startOAuthCallback({ expectedState: () => provider?.currentState, timeoutMs: this.deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS });
    try {
      const redirectUrl = (await host.externalRedirect?.(callback.redirectUrl)) ?? callback.redirectUrl;
      provider = new McpOAuthProvider({
        store: host.store(this.id),
        interactive: { redirectUrl, open: (url) => host.openBrowser(url) },
      });
      await provider.prepareForSignIn();

      const transport = this.buildTransport(undefined, provider) as Transport & { finishAuth?: (code: string) => Promise<void> };
      const client = new Client({ name: 'mitram', version: CLIENT_VERSION }, { capabilities: {} });
      try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS * 2, 'sign-in');
      } catch (error) {
        if (!needsSignIn(error)) throw error;
        this.deps.log?.(`mcp ${this.id}: waiting for sign-in in the browser`);
        const code = await callback.code;
        await transport.finishAuth!(code);
      }
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    } catch (error) {
      this.state = 'failed';
      this.lastError = `sign-in failed: ${errorText(error)}`;
      this.deps.log?.(`mcp ${this.id}: ${this.lastError}`);
      return;
    } finally {
      callback.close();
    }
    // Credentials are saved: connect the ordinary way.
    this.state = 'idle';
    await this.start();
  }

  /** Forgets the saved sign-in. The next connection needs the user to sign in again. */
  async signOut(): Promise<void> {
    await this.close();
    await this.deps.oauth?.store(this.id).clear();
    if (this.config.auth?.kind === 'oauth' && this.state === 'idle') this.state = 'needs-auth';
  }

  /** Adds the server's own stderr to a bare failure, which is usually where the real reason is. */
  private explain(message: string): string {
    const tail = this.stderr.trim().split('\n').filter(Boolean).pop();
    return tail && !message.includes(tail) ? `${message} — ${tail.slice(0, 200)}` : message;
  }

  private buildTransport(key: string | undefined, authProvider?: OAuthClientProvider): Transport {
    const { config } = this;
    const authHeader = config.auth?.kind === 'header' && key ? { [config.auth.name]: formatAuthValue(config.auth, key) } : {};

    if (config.transport === 'stdio') {
      const authEnv = config.auth?.kind === 'env' && key ? { [config.auth.name]: formatAuthValue(config.auth, key) } : {};
      const transport = new StdioClientTransport({
        command: config.command!,
        // Paths pasted on Windows (quotes, a trailing backslash, a lower-case drive) or written with
        // `~` are put in the form the server expects, since no shell is involved to do it.
        args: normalizeServerArgs(config.args, { platform: process.platform, home: os.homedir(), env: process.env }),
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
        authProvider,
        requestInit: { headers },
        // The stream is opened with fetch, which ignores requestInit, so add them here too.
        eventSourceInit: {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers } }),
        },
      } as ConstructorParameters<typeof SSEClientTransport>[1]);
    }
    return new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers } });
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
