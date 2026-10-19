import { describe, expect, it, vi } from 'vitest';
import type { McpCallResult, McpToolCaller, McpToolDefinition } from '../../src/mcp/McpClient';
import { flattenResult, isReadOnlyHinted, mcpTool } from '../../src/mcp/mcpTool';
import type { ToolContext } from '../../src/tools/Tool';

const ctx = (signal: AbortSignal = new AbortController().signal): ToolContext => ({
  root: '/repo',
  signal,
  files: {
    readText: async () => '',
    writeText: async () => {},
    exists: async () => false,
    remove: async () => {},
  },
});

/** A server stand-in: records the call and returns whatever the test wants. */
function caller(result: McpCallResult | (() => Promise<McpCallResult>), id = 'github'): McpToolCaller & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    id,
    calls,
    async callTool(name, args, signal) {
      calls.push([name, args, signal]);
      return typeof result === 'function' ? result() : result;
    },
  };
}

const def = (over: Partial<McpToolDefinition> = {}): McpToolDefinition => ({
  name: 'create_issue',
  description: 'Creates an issue.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  ...over,
});

const text = (t: string): McpCallResult => ({ content: [{ type: 'text', text: t }] });

describe('mcpTool: definition', () => {
  it('takes the encoded name', () => {
    expect(mcpTool(caller(text('ok')), def()).name).toBe('mcp__github__create_issue');
  });

  it('marks the description with the server it came from', () => {
    expect(mcpTool(caller(text('ok')), def()).description).toBe('[github] Creates an issue.');
  });

  it('keeps a chatty server from flooding the prompt', () => {
    const tool = mcpTool(caller(text('ok')), def({ description: 'x'.repeat(5000) }));
    expect(tool.description.length).toBeLessThanOrEqual(1100);
  });

  it('falls back to a description when the server gives none', () => {
    expect(mcpTool(caller(text('ok')), def({ description: undefined })).description).toMatch(/"create_issue" tool from the "github"/);
  });

  it('passes a usable schema through', () => {
    expect(mcpTool(caller(text('ok')), def()).inputSchema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
  });

  it.each([[undefined], [null], ['a string'], [[1, 2]], [{ type: 'array' }]])('falls back to a permissive schema for %s', (schema) => {
    expect(mcpTool(caller(text('ok')), def({ inputSchema: schema })).inputSchema).toEqual({ type: 'object' });
  });

  // readOnly() keeps only !requiresApproval tools, so this is what keeps MCP out of plan mode.
  it('always needs approval, even when the server calls it read-only', () => {
    expect(mcpTool(caller(text('ok')), def()).requiresApproval).toBe(true);
    expect(mcpTool(caller(text('ok')), def({ annotations: { readOnlyHint: true } })).requiresApproval).toBe(true);
  });

  it('reports the server read-only hint separately, for the approval policy', () => {
    expect(isReadOnlyHinted(def({ annotations: { readOnlyHint: true } }))).toBe(true);
    expect(isReadOnlyHinted(def({ annotations: { readOnlyHint: false } }))).toBe(false);
    expect(isReadOnlyHinted(def())).toBe(false);
  });
});

describe('mcpTool: preview', () => {
  it('shows the server, the tool and the exact arguments', () => {
    const preview = mcpTool(caller(text('ok')), def()).preview({ title: 'Bug' });
    expect(preview.summary).toBe('github: create_issue');
    expect(preview.detail).toBe('{\n  "title": "Bug"\n}');
    expect(preview.badge).toBe('MCP');
  });

  it('shows no detail when there are no arguments', () => {
    expect(mcpTool(caller(text('ok')), def()).preview({}).detail).toBeUndefined();
    expect(mcpTool(caller(text('ok')), def()).preview(undefined).detail).toBeUndefined();
  });

  it('caps very long arguments', () => {
    const preview = mcpTool(caller(text('ok')), def()).preview({ body: 'y'.repeat(10_000) });
    expect(preview.detail!.length).toBeLessThan(2_200);
    expect(preview.detail).toContain('truncated');
  });

  it('never throws on odd input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => mcpTool(caller(text('ok')), def()).preview(cyclic)).not.toThrow();
  });
});

describe('mcpTool: policy', () => {
  it('allows a tool that matches no pattern', () => {
    expect(mcpTool(caller(text('ok')), def(), { blocked: [/^mcp__github__delete_/] }).policy?.({}, ctx())).toBeNull();
  });

  it('blocks a tool matching mitram.blockedMcpTools', () => {
    const tool = mcpTool(caller(text('ok')), def({ name: 'delete_repo' }), { blocked: [/delete_/] });
    expect(tool.policy?.({}, ctx())).toMatch(/blocked by mitram.blockedMcpTools/);
  });

  it('has no opinion when nothing is configured', () => {
    expect(mcpTool(caller(text('ok')), def()).policy?.({}, ctx())).toBeNull();
  });
});

describe('mcpTool: run', () => {
  it('calls the server tool by its real name and passes the signal', async () => {
    const c = caller(text('Created #12'));
    const controller = new AbortController();

    const out = await mcpTool(c, def()).run({ title: 'Bug' }, ctx(controller.signal));

    expect(out).toBe('Created #12');
    expect(c.calls[0][0]).toBe('create_issue');
    expect(c.calls[0][1]).toEqual({ title: 'Bug' });
    expect(c.calls[0][2]).toBe(controller.signal);
  });

  it('treats missing input as no arguments', async () => {
    const c = caller(text('ok'));
    await mcpTool(c, def()).run(undefined, ctx());
    expect(c.calls[0][1]).toEqual({});
  });

  it.each([['a string'], [[1, 2]], [42]])('rejects input that is not an object: %s', async (input) => {
    await expect(mcpTool(caller(text('ok')), def()).run(input, ctx())).rejects.toThrow(/must be a JSON object/);
  });

  // The loop turns a thrown error into is_error, which is how the model learns it failed.
  it('throws when the server reports an error', async () => {
    const c = caller({ content: [{ type: 'text', text: 'Issue title is required' }], isError: true });
    await expect(mcpTool(c, def()).run({}, ctx())).rejects.toThrow('Issue title is required');
  });

  it('throws something useful when the server reports an error with no text', async () => {
    const c = caller({ content: [], isError: true });
    await expect(mcpTool(c, def()).run({}, ctx())).rejects.toThrow(/reported an error running "create_issue"/);
  });

  it('truncates a very long result', async () => {
    const out = await mcpTool(caller(text('z'.repeat(80_000))), def()).run({}, ctx());
    expect(out.length).toBeLessThan(31_000);
    expect(out).toContain('truncated');
  });

  it('says so when the server returns nothing', async () => {
    expect(await mcpTool(caller({ content: [] }), def()).run({}, ctx())).toBe('(the server returned no content)');
  });

  it('passes a cancellation from the server through', async () => {
    const c = caller(async () => {
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    });
    await expect(mcpTool(c, def()).run({}, ctx())).rejects.toThrow('Aborted');
  });
});

describe('flattenResult', () => {
  it('joins text blocks', () => {
    expect(flattenResult({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo');
  });

  it('notes images and audio instead of dropping them silently', () => {
    expect(flattenResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] })).toBe('[image omitted: image/png]');
    expect(flattenResult({ content: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }] })).toBe('[audio omitted: audio/wav]');
  });

  it('reads embedded text resources and links', () => {
    expect(flattenResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } }] })).toBe('hello');
    expect(flattenResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.bin', blob: 'AAAA' } }] })).toBe(
      '[resource omitted: file:///a.bin]',
    );
    expect(flattenResult({ content: [{ type: 'resource_link', uri: 'https://x.example/a' }] })).toBe('[resource: https://x.example/a]');
  });

  it('falls back to structuredContent when there are no blocks', () => {
    expect(flattenResult({ content: [], structuredContent: { count: 2 } } as McpCallResult)).toBe('{\n  "count": 2\n}');
  });

  it('survives malformed content', () => {
    expect(flattenResult({ content: [null, 42, { type: 'unknown' }] as unknown[] })).toBe('');
    expect(flattenResult({ content: 'not an array' as unknown as unknown[] })).toBe('');
  });
});

describe('mcpTool: isolation between servers', () => {
  it('gives two servers distinct names for the same tool', () => {
    const a = mcpTool(caller(text('ok'), 'github'), def());
    const b = mcpTool(caller(text('ok'), 'gitlab'), def());
    expect(a.name).not.toBe(b.name);
  });

  it('routes each call to its own server', async () => {
    const a = caller(text('from a'), 'github');
    const b = caller(text('from b'), 'gitlab');
    const runA = vi.fn(a.callTool.bind(a));

    await mcpTool({ id: 'github', callTool: runA }, def()).run({}, ctx());
    await mcpTool(b, def()).run({}, ctx());

    expect(runA).toHaveBeenCalledOnce();
    expect(b.calls).toHaveLength(1);
  });
});
