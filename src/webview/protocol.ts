// Typed messages exchanged between the extension host and the webview.
// This file is imported by both sides, so keep it free of vscode/node imports.

export type BoardStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface BoardTask {
  title: string;
  status: BoardStatus;
  note?: string;
}

/** The agent's working plan for a chat: a task list plus free-form notes. */
export interface Board {
  tasks: BoardTask[];
  notes: string;
}

export type ToolStatus = 'pending' | 'running' | 'ok' | 'error' | 'rejected';
export type ApprovalDecision = 'approve' | 'reject' | 'always';

export type DisplayMessage =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'thinking'; text: string }
  | {
      role: 'tool';
      id: string;
      name: string;
      summary: string;
      detail?: string;
      status: ToolStatus;
      output?: string;
    };

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'sendMessage'; text: string; includeActive: boolean; mentions: string[]; plan: boolean }
  | { type: 'retry' }
  | { type: 'stop' }
  | { type: 'openSettings' }
  | { type: 'setApiKey' }
  | { type: 'newChat' }
  | { type: 'switchSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'insertCode'; code: string }
  | { type: 'copyCode'; code: string }
  | { type: 'searchFiles'; query: string }
  | { type: 'approval'; id: string; decision: ApprovalDecision }
  | { type: 'viewDiff'; id: string }
  | { type: 'revert' }
  | { type: 'pickModel' }
  | { type: 'clearBoard' }
  | { type: 'continueRun' };

export type HostToWebview =
  | { type: 'streamDelta'; text: string }
  | { type: 'thinkingDelta'; text: string }
  | { type: 'streamEnd' }
  | { type: 'toolStart'; id: string; name: string; summary: string; detail?: string; status: ToolStatus }
  | { type: 'toolUpdate'; id: string; status: ToolStatus; output?: string }
  | { type: 'notice'; text: string }
  | { type: 'checkpoint'; files: string[] }
  | { type: 'modelInfo'; model: string }
  | { type: 'board'; board: Board }
  | { type: 'budgetReached'; reason: 'steps' | 'time' | 'stuck'; steps: number }
  | {
      type: 'usage';
      /** Tokens in the prompt of the latest request (uncached + cache reads + cache writes). */
      contextTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      contextWindow: number;
    }
  | { type: 'error'; message: string; needsSetup?: boolean }
  | { type: 'contextInfo'; file: string | null; hasSelection: boolean; hasWorkspace: boolean }
  | { type: 'fileResults'; query: string; files: string[] }
  | { type: 'sessions'; list: SessionSummary[]; activeId: string | null }
  | { type: 'loadMessages'; messages: DisplayMessage[] };

const NO_PAYLOAD = new Set(['ready', 'retry', 'stop', 'openSettings', 'setApiKey', 'newChat', 'revert', 'pickModel', 'clearBoard', 'continueRun']);
const STRING_FIELD: Record<string, string> = {
  switchSession: 'id',
  deleteSession: 'id',
  insertCode: 'code',
  copyCode: 'code',
  searchFiles: 'query',
  viewDiff: 'id',
};

export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') return false;
  if (NO_PAYLOAD.has(v.type)) return true;
  if (v.type === 'sendMessage') {
    return (
      typeof v.text === 'string' &&
      typeof v.includeActive === 'boolean' &&
      typeof v.plan === 'boolean' &&
      Array.isArray(v.mentions) &&
      v.mentions.every((m) => typeof m === 'string')
    );
  }
  if (v.type === 'approval') {
    return typeof v.id === 'string' && (v.decision === 'approve' || v.decision === 'reject' || v.decision === 'always');
  }
  const field = STRING_FIELD[v.type];
  return field !== undefined && typeof v[field] === 'string';
}
