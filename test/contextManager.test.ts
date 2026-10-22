import { describe, expect, it } from 'vitest';
import {
  CLEARED_TOOL_OUTPUT, INTERRUPTED_TOOL_RESULT, REMOVED_CONTEXT, REMOVED_TURNS, SUMMARY_PREFIX, estimateMessageTokens, manageContext,
  manageContextAsync, repairToolPairs,
} from '../src/agent/contextManager';
import { REMOVED_IMAGE } from '../src/agent/attachments';
import type { ChatMessage } from '../src/providers/ModelProvider';
import { fakeImage } from './imageFixtures';

const big = (n: number) => 'x'.repeat(n);

/** One agent turn: user text, assistant tool call, tool result, assistant answer. */
function turn(i: number, resultChars = 20_000, ctx = ''): ChatMessage[] {
  return [
    { role: 'user', content: `${ctx}question ${i}` },
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `f${i}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(resultChars) }] },
    { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
  ];
}

/** Every tool_use is immediately followed by a user message with its tool_result. */
function assertValid(history: ChatMessage[]) {
  expect(history[0].role).toBe('user');
  history.forEach((m, i) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return;
    const ids = (m.content as any[]).filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (ids.length === 0) return;
    const next = history[i + 1];
    expect(next?.role).toBe('user');
    const got = (next.content as any[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    expect(got.sort()).toEqual(ids.sort());
  });
  for (let i = 1; i < history.length; i++) {
    // Roles alternate except where a real user message follows a tool result.
    if (history[i].role === 'assistant') expect(history[i - 1].role).toBe('user');
  }
}

const opts = { windowTokens: 100_000, fixedTokens: 2_000 };

describe('manageContext', () => {
  it('does nothing below the trigger', () => {
    const h = [...turn(1, 1000), ...turn(2, 1000)];
    const snapshot = JSON.stringify(h);
    const r = manageContext(h, opts);
    expect(r.changed).toBe(false);
    expect(JSON.stringify(h)).toBe(snapshot);
  });

  it('clears old tool output first and keeps the newest results', () => {
    const h = Array.from({ length: 12 }, (_, i) => turn(i, 20_000)).flat();
    const r = manageContext(h, opts);
    expect(r.changed).toBe(true);
    expect(r.after).toBeLessThanOrEqual(opts.windowTokens * 0.5);
    expect(r.droppedMessages).toBe(0);

    const results = h.flatMap((m) => (m.role === 'user' && typeof m.content !== 'string' ? (m.content as any[]) : []))
      .filter((b) => b.type === 'tool_result');
    expect(results[0].content).toBe(CLEARED_TOOL_OUTPUT);
    expect(results.at(-1).content).toHaveLength(20_000); // newest kept
    assertValid(h);
  });

  it('keeps is_error flags and ids when clearing', () => {
    const h = Array.from({ length: 12 }, (_, i) => turn(i)).flat();
    (h[2].content as any[])[0].is_error = true;
    manageContext(h, opts);
    expect((h[2].content as any[])[0]).toMatchObject({ is_error: true, tool_use_id: 't0', content: CLEARED_TOOL_OUTPUT });
  });

  it('removes attached context from old messages but not the current one', () => {
    const ctx = `<context>\n<file path="a.ts">\n${big(80_000)}\n</file>\n</context>\n\n`;
    const h = [...turn(1, 100, ctx), ...turn(2, 100, ctx), ...turn(3, 100, ctx), ...turn(4, 100, ctx)];
    const r = manageContext(h, opts);
    expect(r.removedContexts).toBeGreaterThan(0);
    expect(String(h[0].content)).toContain(REMOVED_CONTEXT);
    expect(String(h[0].content)).toContain('question 1');
    expect(String(h.at(-4)!.content)).toContain('<context>'); // current turn untouched
    assertValid(h);
  });

  it('removes retrieved code from old messages like attached context', () => {
    const ctx = `<retrieved>\nsrc/a.ts:1-20 (a)\n<snippet path="src/a.ts" lines="1-20">\n${big(80_000)}\n</snippet>\n</retrieved>\n`;
    const h = [...turn(1, 100, ctx), ...turn(2, 100, ctx), ...turn(3, 100, ctx), ...turn(4, 100, ctx)];
    manageContext(h, opts);
    expect(String(h[0].content)).toBe(`${REMOVED_CONTEXT}\nquestion 1`);
    expect(String(h.at(-4)!.content)).toContain('<retrieved>');
    assertValid(h);
  });

  it('drops the oldest whole turns when clearing is not enough, never the current turn', () => {
    // Plain text conversation: nothing clearable, so whole turns must go.
    const h: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      h.push({ role: 'user', content: `q${i} ${big(10_000)}` }, { role: 'assistant', content: `a${i}` });
    }
    const r = manageContext(h, opts);
    expect(r.droppedMessages).toBeGreaterThan(0);
    expect(r.after).toBeLessThanOrEqual(opts.windowTokens * 0.5);
    expect(String(h[0].content).startsWith(REMOVED_TURNS)).toBe(true);
    expect(String(h.at(-2)!.content)).toContain('q29'); // the latest turn survived
    assertValid(h);
  });

  it('keeps tool_use/tool_result pairs intact when dropping turns', () => {
    const h = Array.from({ length: 40 }, (_, i) => turn(i, 600)).flat().map((m) => m);
    // Inflate user text so clearing tool results cannot help.
    h.forEach((m) => { if (m.role === 'user' && typeof m.content === 'string') m.content += big(9_000); });
    manageContext(h, opts);
    assertValid(h);
  });

  it('is stable: a second run right after changes nothing', () => {
    const h = Array.from({ length: 12 }, (_, i) => turn(i)).flat();
    manageContext(h, opts);
    const snapshot = JSON.stringify(h);
    expect(manageContext(h, opts).changed).toBe(false);
    expect(JSON.stringify(h)).toBe(snapshot);
  });

  it('adds the removed-turns marker only once', () => {
    const h: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) h.push({ role: 'user', content: big(10_000) }, { role: 'assistant', content: 'a' });
    manageContext(h, opts);
    for (let i = 0; i < 30; i++) h.push({ role: 'user', content: big(10_000) }, { role: 'assistant', content: 'a' });
    manageContext(h, opts);
    expect(String(h[0].content).split(REMOVED_TURNS).length - 1).toBe(1);
  });

  it('estimates string and block messages', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'x'.repeat(350) })).toBe(100);
    expect(estimateMessageTokens(turn(1, 3500)[2])).toBe(1000);
  });
});

describe('manageContextAsync (summaries)', () => {
  const plain = (n: number): ChatMessage[] => {
    const h: ChatMessage[] = [];
    for (let i = 0; i < n; i++) h.push({ role: 'user', content: `q${i} ${big(10_000)}` }, { role: 'assistant', content: `a${i}` });
    return h;
  };

  it('replaces the dropped turns with one summary and keeps the current turn', async () => {
    const h = plain(30);
    let seen: ChatMessage[] = [];
    let announced = 0;
    const r = await manageContextAsync(h, {
      ...opts,
      summarize: async (turns) => ((seen = turns), 'We built X and fixed Y.'),
      onSummarizing: () => announced++,
    });
    expect(r.summarized).toBe(true);
    expect(announced).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(String(h[0].content)).toBe(`${SUMMARY_PREFIX}\nWe built X and fixed Y.`);
    expect(String(h.at(-2)!.content)).toContain('q29');
    expect(r.after).toBeLessThanOrEqual(opts.windowTokens * 0.5);
    expect(h.length).toBe(30 * 2 - seen.length + 1); // dropped turns become a single message
    assertValid(h);
  });

  it('does a rolling summary: the old summary is part of what gets summarised next time', async () => {
    const h = plain(30);
    await manageContextAsync(h, { ...opts, summarize: async () => 'first summary' });
    for (let i = 30; i < 60; i++) h.push({ role: 'user', content: `q${i} ${big(10_000)}` }, { role: 'assistant', content: `a${i}` });
    let seen: ChatMessage[] = [];
    await manageContextAsync(h, { ...opts, summarize: async (turns) => ((seen = turns), 'second summary') });
    expect(String(seen[0].content)).toContain('first summary');
    expect(String(h[0].content)).toContain('second summary');
    expect(JSON.stringify(h)).not.toContain('first summary');
  });

  it('only summarises as much as needed, not the whole history', async () => {
    const h = plain(30);
    let count = 0;
    await manageContextAsync(h, { ...opts, summarize: async (turns) => ((count = turns.length), 's') });
    expect(count).toBeLessThan(h.length + count - 1);
    expect(h.length).toBeGreaterThan(5);
  });

  it('falls back to dropping turns if the summary fails or is empty', async () => {
    for (const summarize of [async () => { throw new Error('boom'); }, async () => '   ']) {
      const h = plain(30);
      const r = await manageContextAsync(h, { ...opts, summarize });
      expect(r.summarized).toBe(false);
      expect(r.droppedMessages).toBeGreaterThan(0);
      expect(String(h[0].content).startsWith(REMOVED_TURNS)).toBe(true);
      assertValid(h);
    }
  });

  it('leaves the history untouched when the summary request is cancelled', async () => {
    const h = plain(30);
    const before = JSON.stringify(h);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(manageContextAsync(h, { ...opts, summarize: async () => { throw abort; } })).rejects.toThrow('aborted');
    // Level 1 may already have run, but no turn was removed.
    expect(h).toHaveLength(60);
    expect(JSON.stringify(h)).toBe(before);
  });

  it('does not summarise when clearing old output is enough, or below the trigger', async () => {
    let called = 0;
    const small = [...turn(1, 1000), ...turn(2, 1000)];
    await manageContextAsync(small, { ...opts, summarize: async () => (called++, 's') });
    const clearable = Array.from({ length: 12 }, (_, i) => turn(i, 20_000)).flat();
    const r = await manageContextAsync(clearable, { ...opts, summarize: async () => (called++, 's') });
    expect(called).toBe(0);
    expect(r.clearedToolResults).toBeGreaterThan(0);
    expect(r.summarized).toBe(false);
  });

  it('works without a summariser, like the sync version', async () => {
    const h = plain(30);
    const r = await manageContextAsync(h, opts);
    expect(r.droppedMessages).toBeGreaterThan(0);
    expect(r.summarized).toBe(false);
  });
});

describe('images in the context', () => {
  // A 1000×750 screenshot padded to about 1.3 MB of base64.
  const withImage = (text: string): ChatMessage => ({
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fakeImage(1000, 750, 1_000_000) } },
      { type: 'text', text },
    ],
  });
  const types = (m: ChatMessage) => (m.content as { type: string }[]).map((b) => b.type);

  it('counts an image by its pixels, not by the size of its base64', () => {
    const tokens = estimateMessageTokens(withImage('hi'));
    expect(tokens).toBeGreaterThanOrEqual(1000);
    expect(tokens).toBeLessThan(1100);
  });

  it('does not trim a short chat just because it has a screenshot', () => {
    const history = [withImage('what is this?')];
    expect(manageContext(history, opts).changed).toBe(false);
    expect(types(history[0])).toEqual(['image', 'text']);
  });

  it('removes images from older turns when trimming, but keeps the current turn’s', () => {
    const history: ChatMessage[] = [withImage('old question'), { role: 'assistant', content: 'old answer' }];
    for (let i = 0; i < 14; i++) history.push(...turn(i));
    history.push(withImage('current question'));
    const result = manageContext(history, opts);
    expect(result.removedAttachments).toBe(1);
    expect(result.changed).toBe(true);
    expect(history[0].content).toEqual([
      { type: 'text', text: REMOVED_IMAGE },
      { type: 'text', text: 'old question' },
    ]);
    expect(types(history[history.length - 1])).toEqual(['image', 'text']);
    assertValid(history);
  });
});

describe('repairToolPairs', () => {
  const call = (...ids: string[]): ChatMessage => ({
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool_use' as const, id, name: 'run_command', input: { command: 'npm test' } })),
  });
  const results = (...ids: string[]): ChatMessage => ({
    role: 'user',
    content: ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'ok' })),
  });
  const interrupted = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: INTERRUPTED_TOOL_RESULT, is_error: true });

  it('leaves a valid history alone', () => {
    const history = [...turn(1, 10), ...turn(2, 10)];
    const before = structuredClone(history);
    expect(repairToolPairs(history)).toBe(0);
    expect(history).toEqual(before);
  });

  it('answers calls cut off by a message sent while they ran', () => {
    // The 400 seen in practice: two calls, then the next message with no results between.
    const history: ChatMessage[] = [{ role: 'user', content: 'run the tests' }, call('a', 'b'), { role: 'user', content: 'continue' }];
    expect(repairToolPairs(history)).toBe(2);
    expect(history[2]).toEqual({ role: 'user', content: [interrupted('a'), interrupted('b')] });
    // Kept apart from the user's message, which still starts its own turn.
    expect(history[3]).toEqual({ role: 'user', content: 'continue' });
    assertValid(history);
  });

  it('answers calls at the end of a chat saved mid-run', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }, call('a')];
    expect(repairToolPairs(history)).toBe(1);
    assertValid(history);
  });

  it('adds only the missing results to a partial set', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }, call('a', 'b'), results('b')];
    expect(repairToolPairs(history)).toBe(1);
    expect((history[2].content as any[]).map((b) => b.tool_use_id)).toEqual(['a', 'b']);
    assertValid(history);
  });

  it('drops results that landed after the conversation moved on', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      call('a'),
      { role: 'user', content: 'continue' },
      results('a'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    expect(repairToolPairs(history)).toBe(2);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
    expect(history[2].content).toEqual([interrupted('a')]);
    assertValid(history);
  });

  it('drops a duplicate result but keeps the rest of its message', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }, call('a'), results('a', 'a')];
    expect(repairToolPairs(history)).toBe(1);
    expect(history[2]).toEqual(results('a'));
  });

  it('keeps calls and their repaired results together when old turns are trimmed', () => {
    const history: ChatMessage[] = [...turn(0), { role: 'user', content: 'go' }, call('a'), ...turn(1), ...turn(2), ...turn(3)];
    repairToolPairs(history);
    manageContext(history, { windowTokens: 20_000, fixedTokens: 0 });
    assertValid(history);
  });
});
