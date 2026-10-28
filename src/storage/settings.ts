import * as vscode from 'vscode';
import { McpServerConfig, parseServers } from '../mcp/config';
import { NotifyMode, parseMode } from '../notifications/policy';
import { DEFAULT_AZURE_API_VERSION } from '../providers/OpenAIProvider';

export interface MitramSettings {
  endpoint: string;
  model: string;
  /** A second, OpenAI-compatible endpoint (Azure OpenAI, OpenAI…), used for the models listed with it. */
  openai: { endpoint: string; models: string[]; apiVersion: string };
  models: string[];
  maxTokens: number;
  maxIterations: number;
  skipApprovalPrompts: boolean;
  autoApproveEdits: boolean;
  autoApproveSafeCommands: boolean;
  blockedCommandPatterns: string[];
  autoApproveCommands: string[];
  contextWindow: number;
  promptCaching: boolean;
  includeEnvironment: boolean;
  retrieveContext: boolean;
  showReasoning: boolean;
  maxRunMinutes: number;
  verifyBeforeDone: boolean;
  summarizeContext: boolean;
  subagents: boolean;
  maxParallelSubagents: number;
  notifications: NotifyMode;
  voice: { provider: 'browser' | 'endpoint'; endpoint: string; model: string; language: string; compactWindow: boolean };
  /** MCP servers whose tools the agent may use, after validation. */
  mcpServers: McpServerConfig[];
  /** Reasons entries in `mitram.mcpServers` were rejected or adjusted. */
  mcpProblems: string[];
  blockedMcpTools: string[];
  autoApproveMcpReads: boolean;
  mcpToolLimit: number;
}

export function readSettings(): MitramSettings {
  const cfg = vscode.workspace.getConfiguration('mitram');
  return {
    endpoint: cfg.get<string>('endpoint', '').trim(),
    model: cfg.get<string>('model', 'claude-opus-5-5').trim(),
    models: cfg.get<string[]>('models', []),
    openai: {
      endpoint: cfg.get<string>('openai.endpoint', '').trim(),
      models: cfg.get<string[]>('openai.models', []).map((m) => m.trim()).filter(Boolean),
      apiVersion: cfg.get<string>('openai.apiVersion', DEFAULT_AZURE_API_VERSION).trim() || DEFAULT_AZURE_API_VERSION,
    },
    maxTokens: cfg.get<number>('maxTokens', 16000),
    maxIterations: Math.max(1, cfg.get<number>('maxIterations', 60)),
    skipApprovalPrompts: cfg.get<boolean>('skipApprovalPrompts', false),
    autoApproveEdits: cfg.get<boolean>('autoApproveEdits', false),
    autoApproveSafeCommands: cfg.get<boolean>('autoApproveSafeCommands', false),
    blockedCommandPatterns: cfg.get<string[]>('blockedCommandPatterns', []),
    autoApproveCommands: cfg.get<string[]>('autoApproveCommands', []),
    contextWindow: Math.max(8000, cfg.get<number>('contextWindow', 200000)),
    promptCaching: cfg.get<boolean>('promptCaching', true),
    includeEnvironment: cfg.get<boolean>('includeEnvironment', true),
    retrieveContext: cfg.get<boolean>('retrieveContext', true),
    showReasoning: cfg.get<boolean>('showReasoning', true),
    maxRunMinutes: Math.max(0, cfg.get<number>('maxRunMinutes', 20)),
    verifyBeforeDone: cfg.get<boolean>('verifyBeforeDone', true),
    summarizeContext: cfg.get<boolean>('summarizeContext', true),
    subagents: cfg.get<boolean>('subagents', true),
    maxParallelSubagents: Math.min(8, Math.max(1, Math.floor(cfg.get<number>('maxParallelSubagents', 3)))),
    voice: {
      provider: cfg.get<string>('voice.provider', 'browser') === 'endpoint' ? 'endpoint' : 'browser',
      endpoint: cfg.get<string>('voice.endpoint', '').trim(),
      model: cfg.get<string>('voice.model', 'whisper-1').trim() || 'whisper-1',
      language: cfg.get<string>('voice.language', '').trim(),
      compactWindow: cfg.get<boolean>('voice.compactWindow', true),
    },
    notifications: parseMode(cfg.get<string>('notifications', 'whenAway')),
    ...readMcp(cfg),
  };
}

/** The MCP part of the settings: validated servers plus the reasons any entry was rejected. */
function readMcp(cfg: vscode.WorkspaceConfiguration) {
  // Only the user-level value counts: a repository must never be able to start a process.
  const raw = cfg.inspect<unknown>('mcpServers');
  const { servers, problems } = parseServers(raw?.globalValue ?? raw?.defaultValue, process.env);
  return {
    mcpServers: servers,
    mcpProblems: problems,
    blockedMcpTools: cfg.get<string[]>('blockedMcpTools', []),
    autoApproveMcpReads: cfg.get<boolean>('autoApproveMcpReads', false),
    mcpToolLimit: Math.min(200, Math.max(1, Math.floor(cfg.get<number>('mcpToolLimit', 60)))),
  };
}
