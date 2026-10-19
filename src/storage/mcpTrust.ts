import type * as vscode from 'vscode';

const KEY = 'mitram.mcpTrusted';

/**
 * Whether the user has agreed to run MCP servers in this workspace.
 *
 * An MCP server is an arbitrary program, so the answer is kept per project in extension state —
 * never in .vscode/settings.json, which a cloned repository could ship pre-approved.
 */
export class McpTrustStore {
  constructor(private readonly state: Pick<vscode.Memento, 'get' | 'update'>) {}

  /** undefined means the user has not been asked yet. */
  get(): boolean | undefined {
    const saved = this.state.get<unknown>(KEY);
    return typeof saved === 'boolean' ? saved : undefined;
  }

  async set(trusted: boolean): Promise<void> {
    await this.state.update(KEY, trusted);
  }

  /** Forgets the answer, so the next run asks again. */
  async clear(): Promise<void> {
    await this.state.update(KEY, undefined);
  }
}
