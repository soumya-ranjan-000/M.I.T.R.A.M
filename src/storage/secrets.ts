import * as vscode from 'vscode';

const API_KEY = 'mitram.apiKey';

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
}
