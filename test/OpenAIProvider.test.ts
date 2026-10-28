import { describe, expect, it } from 'vitest';
import type { ChatMessage, ProviderEvent } from '../src/providers/ModelProvider';
import { OpenAIProvider, chatCompletionsUrl, openAIEndpointProblem, toOpenAIMessages, usesOpenAI } from '../src/providers/OpenAIProvider';

/** A fetch that answers with the given server-sent events and records what it was sent. */
function sse(events: unknown[], { status = 200, splitAt = 7 } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'Bad deployment' } }), { status });
    // Arrives in small pieces, so events and lines are split across chunks as on a real network.
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += splitAt) controller.enqueue(bytes.slice(i, i + splitAt));
        controller.close();
      },
    });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

async function collect(provider: OpenAIProvider, messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]) {
  const events: ProviderEvent[] = [];
  for await (const e of provider.stream({ system: 'sys', messages, tools: [{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: {} } }] })) {
    events.push(e);
  }
  return events;
}

const azure = 'https://agenticaiqa.openai.azure.com/';

describe('chatCompletionsUrl', () => {
  it('builds the deployment URL for an Azure OpenAI resource', () => {
    expect(chatCompletionsUrl(azure, 'gpt-5.6-sol')).toBe(
      'https://agenticaiqa.openai.azure.com/openai/deployments/gpt-5.6-sol/chat/completions?api-version=2024-12-01-preview',
    );
    expect(chatCompletionsUrl('https://x.cognitiveservices.azure.com/openai', 'd', '2025-01-01')).toBe(
      'https://x.cognitiveservices.azure.com/openai/deployments/d/chat/completions?api-version=2025-01-01',
    );
  });

  it('adds /chat/completions to a v1 or non-Azure base URL, and keeps a full URL', () => {
    expect(chatCompletionsUrl('https://x.openai.azure.com/openai/v1/', 'd')).toBe('https://x.openai.azure.com/openai/v1/chat/completions');
    expect(chatCompletionsUrl('https://api.openai.com/v1', 'gpt-5')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatCompletionsUrl('http://localhost:11434/v1/chat/completions', 'llama')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('refuses plain http except on this machine', () => {
    expect(openAIEndpointProblem('http://example.com/v1')).toMatch(/https/);
    expect(openAIEndpointProblem('http://localhost:1234/v1')).toBeNull();
    expect(openAIEndpointProblem(azure)).toBeNull();
    expect(openAIEndpointProblem('')).toMatch(/mitram.openai.endpoint/);
  });
});

describe('usesOpenAI', () => {
  const both = { endpoint: 'https://r.services.ai.azure.com/anthropic/', openai: { endpoint: azure, models: ['gpt-5.6-sol'] } };

  it('sends only the listed models to the OpenAI endpoint when both are set', () => {
    expect(usesOpenAI(both, 'gpt-5.6-sol')).toBe(true);
    expect(usesOpenAI(both, 'claude-opus-5-5')).toBe(false);
  });

  it('sends every model there when it is the only endpoint, and none when it is not set', () => {
    expect(usesOpenAI({ ...both, endpoint: '' }, 'anything')).toBe(true);
    expect(usesOpenAI({ endpoint: both.endpoint, openai: { endpoint: '', models: ['gpt-5.6-sol'] } }, 'gpt-5.6-sol')).toBe(false);
  });
});

describe('toOpenAIMessages', () => {
  it('turns tool calls and results into assistant tool_calls and tool messages', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'read a' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
          { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'A' },
          { type: 'tool_result', tool_use_id: 't2', content: 'no such file', is_error: true },
        ],
      },
      { role: 'user', content: 'also check c' },
    ];
    expect(toOpenAIMessages('sys', history, 'BOARD')).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read a' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 't2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'A' },
      { role: 'tool', tool_call_id: 't2', content: 'Error: no such file' },
      { role: 'user', content: 'also check c\n\nBOARD' },
    ]);
  });

  it('sends the board after tool results as its own user message', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'list_dir', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] },
    ];
    const out = toOpenAIMessages(undefined, history, 'BOARD');
    expect(out.slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 't1', content: 'a.txt' },
      { role: 'user', content: 'BOARD' },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] });
  });

  it('sends images as data URLs, moves tool images after the tool messages, and notes PDFs', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const history = [
      { role: 'user', content: [image, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' } }, { type: 'text', text: 'what is this?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 's', name: 'mcp__playwright__screenshot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's', content: [{ type: 'text', text: 'shot' }, image] }] },
    ] as unknown as ChatMessage[];
    const out = toOpenAIMessages(undefined, history) as any[];
    expect(out[0].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(out[0].content[1].text).toMatch(/PDF/);
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 's', content: 'shot\n[The images this returned follow in the next message.]' });
    expect(out[3]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] });
  });
});

describe('OpenAIProvider.stream', () => {
  it('posts to the Azure deployment with an api-key header and streams the text and usage', async () => {
    const { doFetch, calls } = sse([
      { choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } } },
      '[DONE]',
    ]);
    const provider = new OpenAIProvider({ endpoint: azure, apiKey: 'k', model: 'gpt-5.6-sol', maxTokens: 16384, fetch: doFetch });
    const events = await collect(provider);

    expect(calls[0].url).toBe('https://agenticaiqa.openai.azure.com/openai/deployments/gpt-5.6-sol/chat/completions?api-version=2024-12-01-preview');
    expect(calls[0].init.headers).toMatchObject({ 'api-key': 'k' });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ model: 'gpt-5.6-sol', max_completion_tokens: 16384, stream: true, stream_options: { include_usage: true } });
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } });

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 } },
      { type: 'stop', reason: 'end_turn' },
    ]);
  });

  it('puts tool calls back together from their pieces', async () => {
    const { doFetch, calls } = sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'list_dir', arguments: '{}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]);
    const events = await collect(new OpenAIProvider({ endpoint: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5', fetch: doFetch }));
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer k' });
    expect(events).toEqual([
      { type: 'tool_use', toolUse: { id: 'call_a', name: 'read_file', input: { path: 'a.txt' } } },
      { type: 'tool_use', toolUse: { id: 'call_b', name: 'list_dir', input: {} } },
      { type: 'stop', reason: 'tool_use' },
    ]);
  });

  it('maps a cut-off reply and a content filter stop', async () => {
    const cut = sse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }, '[DONE]']);
    expect((await collect(new OpenAIProvider({ endpoint: azure, apiKey: 'k', model: 'd', fetch: cut.doFetch }))).at(-1)).toEqual({ type: 'stop', reason: 'max_tokens' });
    const filtered = sse([{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }, '[DONE]']);
    expect((await collect(new OpenAIProvider({ endpoint: azure, apiKey: 'k', model: 'd', fetch: filtered.doFetch }))).at(-1)).toEqual({ type: 'stop', reason: 'refusal' });
  });

  it('throws an error with the status, so the chat can describe it', async () => {
    const { doFetch } = sse([], { status: 404 });
    await expect(collect(new OpenAIProvider({ endpoint: azure, apiKey: 'k', model: 'missing', fetch: doFetch }))).rejects.toMatchObject({
      status: 404,
      message: '404 Bad deployment',
    });
  });
});
