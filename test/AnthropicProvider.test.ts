import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/providers/AnthropicProvider';
import type { ProviderEvent } from '../src/providers/ModelProvider';

let server: http.Server;
let baseURL = '';
let mode: 'text' | 'tool' | 'thinking' | 'reject-thinking' = 'text';
const requests: any[] = [];
let lastRequest: { url?: string; headers: http.IncomingHttpHeaders; body: any } | undefined;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
      requests.push(lastRequest.body);
      if (mode === 'reject-thinking' && lastRequest.body.thinking) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking: adaptive is not supported for this model' } }));
        return;
      }
      if (mode === 'thinking') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse('message_start', { type: 'message_start', message: { id: 'm3', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }));
        res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
        for (const t of ['Checking ', 'the file.']) res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } }));
        res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }));
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        res.write(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
        res.write(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } }));
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: 1 }));
        res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }));
        res.write(sse('message_stop', { type: 'message_stop' }));
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (mode === 'tool') {
        res.write(sse('message_start', {
          type: 'message_start',
          message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } },
        }));
        res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }));
        for (const part of ['{"path":', ' "src/a.ts"}']) {
          res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: part } }));
        }
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }));
        res.write(sse('message_stop', { type: 'message_stop' }));
        res.end();
        return;
      }
      res.write(sse('message_start', {
        type: 'message_start',
        message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      }));
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      for (const t of ['Hello', ' world']) {
        res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }));
      }
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }));
      res.write(sse('message_stop', { type: 'message_stop' }));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic/`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('AnthropicProvider', () => {
  it('streams text deltas, usage and a stop reason', async () => {
    const provider = new AnthropicProvider({ baseURL, apiKey: 'test-key', model: 'my-deployment' });
    const events: ProviderEvent[] = [];
    for await (const e of provider.stream({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(e);
    }

    expect(events.filter((e) => e.type === 'text_delta').map((e: any) => e.text).join('')).toBe('Hello world');
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });

    expect(lastRequest?.url).toContain('/anthropic/v1/messages');
    expect(lastRequest?.body.model).toBe('my-deployment');
    expect(lastRequest?.body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(JSON.stringify(lastRequest?.headers)).toContain('test-key');
  });

  it('assembles streamed tool calls and sends tool definitions', async () => {
    mode = 'tool';
    const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'm' });
    const events: ProviderEvent[] = [];
    const tools = [{ name: 'read_file', description: 'd', input_schema: { type: 'object' as const, properties: {} } }];
    for await (const e of provider.stream({ messages: [{ role: 'user', content: 'x' }], tools })) events.push(e);
    mode = 'text';

    expect(events.find((e) => e.type === 'tool_use')).toEqual({
      type: 'tool_use',
      toolUse: { id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts' } },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
    expect(lastRequest?.body.tools[0].name).toBe('read_file');
  });

  it('puts cache breakpoints on the last tool, the system prompt and the newest message', async () => {
    const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'm' });
    const tools = [
      { name: 'a', description: 'd', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'b', description: 'd', input_schema: { type: 'object' as const, properties: {} } },
    ];
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'latest' },
    ];
    for await (const _ of provider.stream({ system: 'sys', messages, tools })) void _;

    const body = lastRequest!.body;
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content).toBe('first');
    expect(body.messages[2].content).toEqual([{ type: 'text', text: 'latest', cache_control: { type: 'ephemeral' } }]);
    // The caller's history must not be modified.
    expect(messages[2].content).toBe('latest');
    expect(tools[1]).not.toHaveProperty('cache_control');
  });

  it('puts the breakpoint on the last block of a tool-result message', async () => {
    const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'm' });
    const messages = [
      { role: 'user' as const, content: 'go' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't', name: 'a', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't', content: 'ok' }] },
    ];
    for await (const _ of provider.stream({ messages })) void _;
    expect(lastRequest!.body.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sends no cache_control when prompt caching is turned off', async () => {
    const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'm', promptCaching: false });
    const tools = [{ name: 'a', description: 'd', input_schema: { type: 'object' as const, properties: {} } }];
    for await (const _ of provider.stream({ system: 'sys', messages: [{ role: 'user', content: 'x' }], tools })) void _;
    expect(JSON.stringify(lastRequest!.body)).not.toContain('cache_control');
    expect(lastRequest!.body.system).toBe('sys');
  });

  it('streams reasoning summaries when asked, and asks for them in summarized form', async () => {
    mode = 'thinking';
    requests.length = 0;
    const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'reasoner', reasoning: true });
    const events: ProviderEvent[] = [];
    for await (const e of provider.stream({ messages: [{ role: 'user', content: 'x' }] })) events.push(e);
    mode = 'text';

    expect(events.filter((e) => e.type === 'thinking_delta').map((e: any) => e.text).join('')).toBe('Checking the file.');
    expect(events.filter((e) => e.type === 'text_delta').map((e: any) => e.text).join('')).toBe('Done.');
    expect(requests[0].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('does not send a thinking parameter unless reasoning is enabled', async () => {
    requests.length = 0;
    const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'plain' });
    for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'x' }] })) void _;
    expect(requests[0].thinking).toBeUndefined();
  });

  it('retries once without thinking if the deployment rejects it, then stops asking', async () => {
    mode = 'reject-thinking';
    requests.length = 0;
    const text = async (model: string) => {
      const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model, reasoning: true });
      let out = '';
      for await (const e of provider.stream({ messages: [{ role: 'user', content: 'x' }] })) {
        if (e.type === 'text_delta') out += e.text;
      }
      return out;
    };

    expect(await text('old-model')).toBe('Hello world'); // succeeded via the fallback
    expect(requests).toHaveLength(2);
    expect(requests[0].thinking).toBeDefined();
    expect(requests[1].thinking).toBeUndefined();

    requests.length = 0;
    expect(await text('old-model')).toBe('Hello world'); // remembered: no failed attempt this time
    expect(requests).toHaveLength(1);
    expect(requests[0].thinking).toBeUndefined();
    mode = 'text';
  });

  it('does not hide unrelated 400 errors behind the fallback', async () => {
    const bad = http.createServer((_q, r) => {
      r.writeHead(400, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } }));
    });
    await new Promise<void>((r) => bad.listen(0, '127.0.0.1', r));
    try {
      const provider = new AnthropicProvider({
        baseURL: `http://127.0.0.1:${(bad.address() as AddressInfo).port}/`,
        apiKey: 'k',
        model: 'strict-model',
        reasoning: true,
      });
      const drain = async () => {
        for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'x' }] })) void _;
      };
      await expect(drain()).rejects.toThrow(/max_tokens/);
    } finally {
      await new Promise<void>((r) => bad.close(() => r()));
    }
  });

  it('adds volatile context after the cache breakpoint, so the cached prefix stays stable', async () => {
    const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'v1' });
    const messages = [
      { role: 'user' as const, content: 'go' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't', name: 'a', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't', content: 'ok' }] },
    ];
    for await (const _ of provider.stream({ messages, volatileContext: '<board>plan</board>' })) void _;

    const last = lastRequest!.body.messages[2].content;
    expect(last).toHaveLength(2);
    expect(last[0]).toMatchObject({ type: 'tool_result', cache_control: { type: 'ephemeral' } });
    expect(last[1]).toEqual({ type: 'text', text: '<board>plan</board>' }); // after the breakpoint, no cache_control
    expect(messages[2].content).toHaveLength(1); // history untouched
  });

  it('adds volatile context to a plain-text last message, with caching on or off', async () => {
    for (const promptCaching of [true, false]) {
      const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'v2', promptCaching });
      for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'hello' }], volatileContext: 'TAIL' })) void _;
      const content = lastRequest!.body.messages[0].content;
      expect(content.map((b: any) => b.text)).toEqual(['hello', 'TAIL']);
      expect(content[1].cache_control).toBeUndefined();
    }
  });

  it('lets a request turn reasoning off and cap its own output (used for summaries)', async () => {
    requests.length = 0;
    const provider = new AnthropicProvider({ baseURL, apiKey: 'k', model: 'v3', reasoning: true, maxTokens: 9000 });
    for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'x' }], reasoning: false, maxTokens: 1500 })) void _;
    expect(requests[0].thinking).toBeUndefined();
    expect(requests[0].max_tokens).toBe(1500);
  });
});
