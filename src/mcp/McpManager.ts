import type { Tool } from '../tools/Tool';
import { McpClient, McpClientDeps, McpStatus } from './McpClient';
import { McpServerConfig, describeServer } from './config';
import { isReadOnlyHinted, mcpTool } from './mcpTool';
import { encodeToolName } from './naming';

/** What the MCP panel and `/mcp` show for one server. */
export interface McpServerStatus {
  id: string;
  status: McpStatus;
  /** Why it failed, when it did. Never contains a secret. */
  error?: string;
  toolCount: number;
  /** The command or URL, for the panel's second line. */
  description: string;
  /** The server declares an API key but none is stored yet. */
  needsKey: boolean;
  enabled: boolean;
}

export interface McpManagerDeps {
  /** The validated servers, read fresh so settings changes are picked up. */
  servers: () => McpServerConfig[];
  getApiKey?: (serverId: string) => Promise<string | undefined>;
  /** Patterns from `mitram.blockedMcpTools`. */
  blocked?: () => RegExp[];
  /** Largest number of MCP tools offered to the model at once. */
  toolLimit?: () => number;
  /**
   * Asked once, before any server is started, because a server is an arbitrary program.
   * Returning false leaves every server untouched.
   */
  confirmTrust?: (servers: McpServerConfig[]) => Promise<boolean>;
  log?: (message: string) => void;
  /** Called when a server's status changes, so the UI can refresh. */
  onChange?: () => void;
  /** Replaces client construction, for tests. */
  createClient?: (config: McpServerConfig, deps: McpClientDeps) => McpClient;
}

/** Whether two configs differ in a way that needs a reconnect. */
function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Owns every MCP connection for the window.
 *
 * Servers are started lazily — the first run that needs tools pays for it — and in parallel, so
 * one slow server does not hold up the others. Clients are cached across runs. A server that
 * fails keeps its error and simply contributes no tools.
 */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private starting?: Promise<void>;
  private trusted?: boolean;
  private disposed = false;

  constructor(private readonly deps: McpManagerDeps) {}

  /** True when the user has configured at least one enabled server. */
  get configured(): boolean {
    return this.deps.servers().some((s) => s.enabled);
  }

  private build(config: McpServerConfig): McpClient {
    const clientDeps: McpClientDeps = { getApiKey: this.deps.getApiKey, log: this.deps.log };
    return this.deps.createClient?.(config, clientDeps) ?? new McpClient(config, clientDeps);
  }

  /** Drops clients whose configuration changed or which are no longer configured. */
  private async reconcile(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Map(configs.map((c) => [c.id, c]));
    const stale: McpClient[] = [];

    for (const [id, client] of this.clients) {
      const config = wanted.get(id);
      if (!config || !sameConfig(config, client.config)) {
        stale.push(client);
        this.clients.delete(id);
      }
    }
    for (const config of configs) {
      if (!this.clients.has(config.id)) this.clients.set(config.id, this.build(config));
    }
    await Promise.all(stale.map((c) => c.close()));
  }

  /**
   * Connects every enabled server that is not connected yet. Never throws: a server that fails
   * is recorded and skipped. Safe to call before every run.
   */
  async ensureStarted(): Promise<void> {
    if (this.disposed) return;
    this.starting ??= this.startAll().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startAll(): Promise<void> {
    const configs = this.deps.servers();
    await this.reconcile(configs);

    const pending = configs.filter((c) => c.enabled && this.clients.get(c.id)?.status === 'idle');
    if (!pending.length) return;

    // A server is a program the user is about to run, so ask once per workspace.
    if (this.trusted === undefined && this.deps.confirmTrust) {
      this.trusted = await this.deps.confirmTrust(pending);
      if (!this.trusted) {
        this.deps.log?.(`mcp: not starting ${pending.length} server(s); the folder is not trusted for MCP`);
        return;
      }
    }
    if (this.trusted === false) return;

    this.deps.log?.(`mcp: connecting to ${pending.length} server(s)`);
    await Promise.all(pending.map((config) => this.clients.get(config.id)?.start()));
    this.deps.onChange?.();
  }

  /**
   * The tools of every connected server, as `Tool` objects.
   * Capped: definitions cost prompt tokens on every request.
   */
  tools(): Tool[] {
    const blocked = this.deps.blocked?.() ?? [];
    const limit = this.deps.toolLimit?.() ?? 60;
    const all: Tool[] = [];

    for (const client of this.clients.values()) {
      if (client.status !== 'ready') continue;
      for (const def of client.tools) all.push(mcpTool(client, def, { blocked }));
    }
    if (all.length <= limit) return all;

    const dropped = all.slice(limit);
    this.deps.log?.(`mcp: offering ${limit} of ${all.length} tools; dropped ${dropped.map((t) => t.name).join(', ')}`);
    return all.slice(0, limit);
  }

  /** One line per configured server, for the panel and `/mcp`. */
  status(): McpServerStatus[] {
    return this.deps.servers().map((config) => {
      const client = this.clients.get(config.id);
      return {
        id: config.id,
        status: client?.status ?? (config.enabled ? 'idle' : 'disabled'),
        error: client?.error,
        toolCount: client?.tools.length ?? 0,
        description: describeServer(config),
        needsKey: !!config.auth,
        enabled: config.enabled,
      };
    });
  }

  /** The configured server ids, for decoding tool names. */
  serverIds(): string[] {
    return this.deps.servers().map((s) => s.id);
  }

  /**
   * Full names of connected tools whose server claims they change nothing.
   *
   * This is the server's own `readOnlyHint`, which is a claim by software we cannot inspect. The
   * approval policy only acts on it when the user has explicitly opted in.
   */
  readOnlyToolNames(): Set<string> {
    const names = new Set<string>();
    for (const client of this.clients.values()) {
      if (client.status !== 'ready') continue;
      for (const def of client.tools) {
        if (isReadOnlyHinted(def)) names.add(encodeToolName(client.id, def.name));
      }
    }
    return names;
  }

  /**
   * Reconnects one server, or all of them. Used by the panel's Reconnect button and after a key
   * is set or settings change.
   */
  async restart(id?: string): Promise<void> {
    const targets = id ? [this.clients.get(id)].filter((c): c is McpClient => !!c) : [...this.clients.values()];
    await Promise.all(targets.map((c) => c.close()));
    if (id) {
      // A server the user explicitly restarted is one they intend to run.
      this.trusted ??= true;
      const config = this.deps.servers().find((s) => s.id === id);
      if (config && !sameConfig(config, this.clients.get(id)!.config)) this.clients.set(id, this.build(config));
    }
    await this.ensureStarted();
    this.deps.onChange?.();
  }

  /** Called when `mitram.mcpServers` changes: drop stale clients and reconnect. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    await this.reconcile(this.deps.servers());
    await this.ensureStarted();
    this.deps.onChange?.();
  }

  /** Forgets the trust answer, so the next start asks again. */
  resetTrust(): void {
    this.trusted = undefined;
  }

  /** Closes every connection and kills every child process. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.close()));
  }
}
