import * as vscode from 'vscode';

const API_KEY = 'mitram.apiKey';
const VOICE_KEY = 'mitram.voiceApiKey';
const OPENAI_KEY = 'mitram.openaiApiKey';
const MCP_PREFIX = 'mitram.mcpSecret.';
const OAUTH_PREFIX = 'mitram.mcpOAuth.';

/** Where an MCP server's API key is kept. Never settings.json, which may be synced or shared. */
const mcpKey = (serverId: string) => `${MCP_PREFIX}${serverId}`;

export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getApiKey(): Thenable<string | undefined> {
    return this.secrets.get(API_KEY);
  }

  setApiKey(key: string): Thenable<void> {
    return this.secrets.store(API_KEY, key);
  }

  clearApiKey(): Thenable<void> {
    return this.secrets.delete(API_KEY);
  }

  /** The key for `mitram.openai.endpoint`. */
  getOpenAIKey(): Thenable<string | undefined> {
    return this.secrets.get(OPENAI_KEY);
  }

  setOpenAIKey(key: string): Thenable<void> {
    return this.secrets.store(OPENAI_KEY, key);
  }

  clearOpenAIKey(): Thenable<void> {
    return this.secrets.delete(OPENAI_KEY);
  }

  /** The key for the speech-to-text endpoint, when it needs one. */
  getVoiceKey(): Thenable<string | undefined> {
    return this.secrets.get(VOICE_KEY);
  }

  setVoiceKey(key: string): Thenable<void> {
    return this.secrets.store(VOICE_KEY, key);
  }

  clearVoiceKey(): Thenable<void> {
    return this.secrets.delete(VOICE_KEY);
  }

  /** The API key for one MCP server, or undefined if none has been set. */
  getMcpKey(serverId: string): Thenable<string | undefined> {
    return this.secrets.get(mcpKey(serverId));
  }

  setMcpKey(serverId: string, key: string): Thenable<void> {
    return this.secrets.store(mcpKey(serverId), key);
  }

  clearMcpKey(serverId: string): Thenable<void> {
    return this.secrets.delete(mcpKey(serverId));
  }

  /** An MCP server's OAuth credentials (client registration and tokens), as one JSON string. */
  getMcpOAuth(serverId: string): Thenable<string | undefined> {
    return this.secrets.get(`${OAUTH_PREFIX}${serverId}`);
  }

  setMcpOAuth(serverId: string, json: string): Thenable<void> {
    return this.secrets.store(`${OAUTH_PREFIX}${serverId}`, json);
  }

  clearMcpOAuth(serverId: string): Thenable<void> {
    return this.secrets.delete(`${OAUTH_PREFIX}${serverId}`);
  }

  /** Which of these servers are signed in. */
  async mcpOAuthPresent(serverIds: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    await Promise.all(
      serverIds.map(async (id) => {
        const text = await this.secrets.get(`${OAUTH_PREFIX}${id}`);
        if (text && text.includes('"tokens"')) found.add(id);
      }),
    );
    return found;
  }

  /** Which of these servers have a key stored. Used to show "no API key set" in the UI. */
  async mcpKeysPresent(serverIds: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    await Promise.all(
      serverIds.map(async (id) => {
        if (await this.secrets.get(mcpKey(id))) found.add(id);
      }),
    );
    return found;
  }
}
