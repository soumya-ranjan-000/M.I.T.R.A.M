import * as vscode from 'vscode';
import { McpServerConfig, parseServers } from './config';

const SECTION = 'mitram';
const KEY = 'mcpServers';

/** What a server looks like in settings.json, before validation. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transport?: 'stdio' | 'http' | 'sse';
  auth?: { kind?: 'header' | 'env'; name: string; format?: string };
  enabled?: boolean;
}

/**
 * Reads and writes `mitram.mcpServers`.
 *
 * Always the user-level (Global) value: a workspace must not be able to make M.I.T.R.A.M start a
 * process. The MCP panel edits through here, so hand-editing settings.json stays equivalent.
 * API keys never pass through this store; they live in `SecretStore`.
 */
export class McpConfigStore {
  /** The raw map as the user wrote it, straight from user settings. */
  private raw(): Record<string, McpServerEntry> {
    const inspected = vscode.workspace.getConfiguration(SECTION).inspect<Record<string, McpServerEntry>>(KEY);
    return { ...(inspected?.globalValue ?? {}) };
  }

  /** The validated servers, plus the reasons any entry was rejected. */
  list(): { servers: McpServerConfig[]; problems: string[] } {
    return parseServers(this.raw(), process.env);
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.raw(), id);
  }

  /** A server id based on `name` that is not taken yet, e.g. `github-2`. */
  freeId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
    if (!this.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base.slice(0, 37)}-${n}`;
      if (!this.has(candidate)) return candidate;
    }
  }

  private async write(servers: Record<string, McpServerEntry>): Promise<void> {
    await vscode.workspace.getConfiguration(SECTION).update(KEY, servers, vscode.ConfigurationTarget.Global);
  }

  async add(id: string, entry: McpServerEntry): Promise<void> {
    await this.write({ ...this.raw(), [id]: entry });
  }

  async remove(id: string): Promise<void> {
    const servers = this.raw();
    if (!Object.prototype.hasOwnProperty.call(servers, id)) return;
    delete servers[id];
    await this.write(servers);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const servers = this.raw();
    const entry = servers[id];
    if (!entry) return;
    await this.write({ ...servers, [id]: { ...entry, enabled } });
  }
}
