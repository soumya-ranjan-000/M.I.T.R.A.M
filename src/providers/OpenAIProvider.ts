// Chat Completions, as served by Azure OpenAI, OpenAI and compatible servers (vLLM, LM Studio, Ollama…).
// The history stays in the Anthropic shape the rest of the extension uses; it is translated here, per
// request, so a chat can move between a Claude model and an OpenAI one.
import type { ChatMessage, ModelProvider, ProviderEvent, StopReason, StreamRequest, ToolDefinition } from './ModelProvider';

export const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview';

export interface OpenAIProviderOptions {
  /**
   * An Azure OpenAI resource (https://<resource>.openai.azure.com/), a base URL such as
   * https://api.openai.com/v1, or a full …/chat/completions URL.
   */
  endpoint: string;
  apiKey: string;
  /** The model, or on Azure the deployment name. */
  model: string;
  /** For Azure deployment URLs. */
  apiVersion?: string;
  maxTokens?: number;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

type Block = { type: string; [key: string]: unknown };

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      /** Not part of OpenAI's API, but sent by some compatible servers. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
}

const PDF_NOTE = '[A PDF was attached here, but PDFs cannot be sent to this model. Ask the user to paste the parts that matter.]';

function isLocal(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Whether `model` goes to the OpenAI endpoint: it is listed with it, or that is the only endpoint set.
 */
export function usesOpenAI(settings: { endpoint: string; openai: { endpoint: string; models: string[] } }, model: string): boolean {
  if (!settings.openai.endpoint) return false;
  return settings.openai.models.includes(model) || !settings.endpoint;
}

/** Azure resources take the key in `api-key` and name the deployment in the path. */
export function isAzureHost(hostname: string): boolean {
  return /\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(hostname);
}

/** Why the endpoint cannot be used, or null. A key is never sent over plain http except to this machine. */
export function openAIEndpointProblem(endpoint: string): string | null {
  if (!endpoint.trim()) return 'No OpenAI endpoint is set. Set "mitram.openai.endpoint" in your user settings.';
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return '"mitram.openai.endpoint" is not a valid URL.';
  }
  return url.protocol === 'https:' || isLocal(url.hostname) ? null : '"mitram.openai.endpoint" must use https, unless it points at this machine.';
}

/**
 * The URL to post to. An Azure resource URL becomes its deployment's chat completions URL; Azure's
 * newer `/openai/v1` base and every other base URL just get `/chat/completions`.
 */
export function chatCompletionsUrl(endpoint: string, deployment: string, apiVersion = DEFAULT_AZURE_API_VERSION): string {
  const url = new URL(endpoint.trim());
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(path)) return url.toString();
  if (isAzureHost(url.hostname) && !/\/v1$/.test(path)) {
    url.pathname = `${path.replace(/\/openai$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
    if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', apiVersion);
  } else {
    url.pathname = `${path}/chat/completions`;
  }
  return url.toString();
}

function authHeaders(endpoint: string, apiKey: string): Record<string, string> {
  return isAzureHost(new URL(endpoint.trim()).hostname) ? { 'api-key': apiKey } : { authorization: `Bearer ${apiKey}` };
}

function blocksOf(message: ChatMessage): Block[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content as unknown as Block[]);
}

/** An image or PDF block as a content part, or as text saying it could not be sent. */
function mediaPart(block: Block): ContentPart {
  const source = block.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
  if (block.type === 'image' && source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  if (block.type === 'image' && source?.type === 'url' && source.url) return { type: 'image_url', image_url: { url: source.url } };
  return { type: 'text', text: block.type === 'document' ? PDF_NOTE : '[An attachment here could not be sent to this model.]' };
}

/** A tool result's text. Images in it cannot go in a tool message, so they are returned to send after it. */
function toolResultText(block: Block): { text: string; media: ContentPart[] } {
  const content = block.content;
  const parts = typeof content === 'string' ? [{ type: 'text', text: content } as Block] : Array.isArray(content) ? (content as Block[]) : [];
  const media = parts.filter((p) => p.type !== 'text').map(mediaPart);
  const text = parts.flatMap((p) => (p.type === 'text' ? [String(p.text ?? '')] : [])).join('\n');
  const shown = media.length ? `${text}${text ? '\n' : ''}[The images this returned follow in the next message.]` : text;
  return { text: block.is_error ? `Error: ${shown}` : shown || '(empty result)', media };
}

function userContent(parts: ContentPart[]): string | ContentPart[] {
  return parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n\n') : parts;
}

/**
 * The conversation as Chat Completions messages. Tool results become `tool` messages straight after
 * the call that asked for them; whatever else the user message held follows as a user message.
 */
export function toOpenAIMessages(system: string | undefined, messages: ChatMessage[], volatile?: string): OpenAIMessage[] {
  const out: OpenAIMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    const blocks = blocksOf(message);
    if (message.role === 'assistant') {
      const text = blocks.flatMap((b) => (b.type === 'text' ? [String(b.text ?? '')] : [])).join('');
      const calls: OpenAIToolCall[] = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: String(b.id), type: 'function', function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      // Reasoning blocks are the model's own and are not sent back.
      if (!text && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const parts: ContentPart[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const { text, media } = toolResultText(block);
        out.push({ role: 'tool', tool_call_id: String(block.tool_use_id), content: text });
        parts.push(...media);
      } else if (block.type === 'text') {
        parts.push({ type: 'text', text: String(block.text ?? '') });
      } else {
        parts.push(mediaPart(block));
      }
    }
    if (parts.length) out.push({ role: 'user', content: userContent(parts) });
  }
  if (volatile) {
    const last = out[out.length - 1];
    if (last?.role === 'user') {
      const parts: ContentPart[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
      last.content = userContent([...parts, { type: 'text', text: volatile }]);
    } else {
      out.push({ role: 'user', content: volatile });
    }
  }
  return out;
}

function toOpenAITools(tools: ToolDefinition[] | undefined) {
  return tools?.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/** The JSON payload of each server-sent event, until `[DONE]`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield JSON.parse(data);
    }
  }
}

/** An error the chat can describe: `status` is what describeError keys on. */
async function httpError(response: Response): Promise<Error> {
  let detail = '';
  try {
    const parsed = JSON.parse(await response.text()) as { error?: { message?: string } | string };
    detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '');
  } catch {
    // Not JSON: the status says enough.
  }
  return Object.assign(new Error(`${response.status} ${detail || response.statusText}`.trim()), { status: response.status });
}

export class OpenAIProvider implements ModelProvider {
  constructor(private readonly options: OpenAIProviderOptions) {}

  async *stream(request: StreamRequest): AsyncIterable<ProviderEvent> {
    const { endpoint, apiKey, model } = this.options;
    const tools = toOpenAITools(request.tools);
    const doFetch = this.options.fetch ?? fetch;
    const response = await doFetch(chatCompletionsUrl(endpoint, model, this.options.apiVersion), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(endpoint, apiKey) },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(request.system, request.messages, request.volatileContext),
        ...(tools?.length ? { tools } : {}),
        max_completion_tokens: request.maxTokens ?? this.options.maxTokens ?? 16000,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    });
    if (!response.ok) throw await httpError(response);
    if (!response.body) throw new Error('The endpoint returned no response body.');

    // Calls arrive in pieces, keyed by index: the id and name first, the arguments a few characters at a time.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null | undefined;
    for await (const data of sseData(response.body)) {
      const chunk = data as StreamChunk;
      if (chunk.usage) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        yield {
          type: 'usage',
          usage: { inputTokens: (chunk.usage.prompt_tokens ?? 0) - cached, outputTokens: chunk.usage.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 },
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) yield { type: 'thinking_delta', text: reasoning };
      if (delta?.content) yield { type: 'text_delta', text: delta.content };
      for (const piece of delta?.tool_calls ?? []) {
        const call = calls.get(piece.index) ?? { id: '', name: '', args: '' };
        if (piece.id) call.id = piece.id;
        if (piece.function?.name) call.name += piece.function.name;
        if (piece.function?.arguments) call.args += piece.function.arguments;
        calls.set(piece.index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      let input: unknown = {};
      try {
        input = call.args.trim() ? JSON.parse(call.args) : {};
      } catch {
        // Cut off or malformed: the tool reports the missing arguments and the model tries again.
      }
      yield { type: 'tool_use', toolUse: { id: call.id || `call_${index}`, name: call.name, input } };
    }
    // Some servers end a turn with calls as "stop".
    yield { type: 'stop', reason: calls.size > 0 && finish !== 'length' ? 'tool_use' : mapFinishReason(finish) };
  }
}
