import type Anthropic from '@anthropic-ai/sdk';

export type ChatMessage = Anthropic.MessageParam;
export type ToolDefinition = Anthropic.Tool;

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; toolUse: ToolUse }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: StopReason };

export interface StreamRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /**
   * Text added to the end of the last message for this request only. Not part of the history,
   * and placed after the cache breakpoint, so changing it does not invalidate the cached prefix.
   */
  volatileContext?: string;
  /** Overrides the provider's setting for streamed reasoning, e.g. off for a summary. */
  reasoning?: boolean;
  /** Overrides the provider's default maximum output tokens. */
  maxTokens?: number;
}

export interface ModelProvider {
  stream(request: StreamRequest): AsyncIterable<ProviderEvent>;
}

/** Turns an SDK/network error into a short message suitable for the chat UI. */
export function describeError(error: unknown): string {
  const e = error as { status?: number; message?: string; name?: string } | null;
  if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') return 'Stopped.';
  switch (e?.status) {
    case 401:
    case 403:
      return 'Authentication failed. Check your API key with "M.I.T.R.A.M: Set API Key".';
    case 404:
      return 'Not found. Check the endpoint URL and model/deployment name in settings.';
    case 429:
      return 'Rate limited. Wait a moment and retry.';
  }
  if (typeof e?.status === 'number' && e.status >= 500) {
    return `The service returned an error (${e.status}). Try again shortly.`;
  }
  return e?.message ?? 'Unknown error.';
}
