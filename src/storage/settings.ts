import * as vscode from 'vscode';

export interface MitramSettings {
  endpoint: string;
  model: string;
  models: string[];
  maxTokens: number;
  maxIterations: number;
  autoApproveEdits: boolean;
  autoApproveSafeCommands: boolean;
  blockedCommandPatterns: string[];
  autoApproveCommands: string[];
  contextWindow: number;
  promptCaching: boolean;
  includeEnvironment: boolean;
  showReasoning: boolean;
  maxRunMinutes: number;
  verifyBeforeDone: boolean;
  summarizeContext: boolean;
}

export function readSettings(): MitramSettings {
  const cfg = vscode.workspace.getConfiguration('mitram');
  return {
    endpoint: cfg.get<string>('endpoint', '').trim(),
    model: cfg.get<string>('model', 'claude-opus-5-5').trim(),
    models: cfg.get<string[]>('models', []),
    maxTokens: cfg.get<number>('maxTokens', 16000),
    maxIterations: Math.max(1, cfg.get<number>('maxIterations', 60)),
    autoApproveEdits: cfg.get<boolean>('autoApproveEdits', false),
    autoApproveSafeCommands: cfg.get<boolean>('autoApproveSafeCommands', false),
    blockedCommandPatterns: cfg.get<string[]>('blockedCommandPatterns', []),
    autoApproveCommands: cfg.get<string[]>('autoApproveCommands', []),
    contextWindow: Math.max(8000, cfg.get<number>('contextWindow', 200000)),
    promptCaching: cfg.get<boolean>('promptCaching', true),
    includeEnvironment: cfg.get<boolean>('includeEnvironment', true),
    showReasoning: cfg.get<boolean>('showReasoning', true),
    maxRunMinutes: Math.max(0, cfg.get<number>('maxRunMinutes', 20)),
    verifyBeforeDone: cfg.get<boolean>('verifyBeforeDone', true),
    summarizeContext: cfg.get<boolean>('summarizeContext', true),
  };
}
