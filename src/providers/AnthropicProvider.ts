import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
import type {
  ChatMessage,
  ModelProvider,
  ProviderEvent,
  StopReason,
  StreamRequest,
} from './ModelProvider';

export interface AnthropicProviderOptions {
  /** Foundry endpoint, e.g. https://<resource>.services.ai.azure.com/anthropic/ */
  baseURL: string;
  apiKey: string;
  /** Model name or deployment name on the Foundry resource. */
  model: string;
  maxTokens?: number;
  /** Mark the tools, system prompt and latest message as cacheable. Default true. */
  promptCaching?: boolean;
  /** Ask for streamed reasoning summaries. Falls back automatically if the deployment rejects it. */
  reasoning?: boolean;
}

export class AnthropicProvider implements ModelProvider {
  private readonly client: AnthropicFoundry;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.client = new AnthropicFoundry({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
    });
  }

  async *stream(request: StreamRequest): AsyncIterable<ProviderEvent> {
    const withThinking = (request.reasoning ?? this.options.reasoning ?? false) && !thinkingRejected.has(this.options.model);
    let started = false;
    try {
      for await (const event of this.streamOnce(request, withThinking)) {
        started = true;
        yield event;
      }
    } catch (error) {
      // Some deployments don't accept the thinking parameter: remember that and retry once without it.
      if (!withThinking || started || !isThinkingRejection(error)) throw error;
      thinkingRejected.add(this.options.model);
      yield* this.streamOnce(request, false);
    }
  }

  private async *streamOnce(request: StreamRequest, withThinking: boolean): AsyncIterable<ProviderEvent> {
    const cache = this.options.promptCaching ?? true;
    const stream = this.client.messages.stream(
      {
        model: this.options.model,
        max_tokens: request.maxTokens ?? this.options.maxTokens ?? 16000,
        system: request.system && cache ? [{ type: 'text', text: request.system, cache_control: EPHEMERAL }] : request.system,
        messages: buildMessages(request.messages, cache, request.volatileContext),
        tools: cache ? withToolCacheBreakpoint(request.tools) : request.tools,
        ...(withThinking ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
      },
      { signal: request.signal },
    );

    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') yield { type: 'text_delta', text: event.delta.text };
      else if (event.delta.type === 'thinking_delta') yield { type: 'thinking_delta', text: event.delta.thinking };
    }

    const final = await stream.finalMessage();
    for (const block of final.content) {
      if (block.type === 'tool_use') {
        yield { type: 'tool_use', toolUse: { id: block.id, name: block.name, input: block.input } };
      }
    }
    yield {
      type: 'usage',
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
    yield { type: 'stop', reason: mapStopReason(final.stop_reason) };
  }
}

/** Models whose deployment rejected the thinking parameter, so we stop sending it. */
const thinkingRejected = new Set<string>();

function isThinkingRejection(error: unknown): boolean {
  const e = error as { status?: number; message?: string } | null;
  return e?.status === 400 && /thinking|adaptive|display/i.test(e.message ?? '');
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
      return reason;
    default:
      return 'other';
  }
}

const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * Caching is a prefix match over tools, then system, then messages. One breakpoint on
 * the last tool, one on the system prompt and one on the newest message let each
 * request reuse everything before it (3 of the 4 allowed breakpoints).
 */
function withToolCacheBreakpoint(tools: StreamRequest['tools']): StreamRequest['tools'] {
  if (!tools?.length) return tools;
  return [...tools.slice(0, -1), { ...tools[tools.length - 1], cache_control: EPHEMERAL }];
}

/**
 * Messages for one request. The cache breakpoint goes on the last real block, and the volatile
 * text (the agent's board, say) is added after it, so only that small tail is re-sent uncached
 * and the cached history in front of it keeps matching from one request to the next.
 */
function buildMessages(messages: ChatMessage[], cache: boolean, volatile?: string): ChatMessage[] {
  const marked = cache ? withCacheBreakpoint(messages) : messages;
  const last = marked[marked.length - 1];
  if (!volatile || !last || last.role !== 'user') return marked;
  const blocks = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : [...last.content];
  blocks.push({ type: 'text' as const, text: volatile });
  return [...marked.slice(0, -1), { ...last, content: blocks }];
}

/** Returns a copy of the messages with a breakpoint on the last block; history is not modified. */
function withCacheBreakpoint(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const blocks =
    typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : [...last.content];
  if (blocks.length === 0) return messages;
  const lastBlock = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = { ...lastBlock, cache_control: EPHEMERAL } as typeof lastBlock;
  return [...messages.slice(0, -1), { ...last, content: blocks } as ChatMessage];
}
