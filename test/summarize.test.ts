import { describe, expect, it } from 'vitest';
import type { ChatMessage, ModelProvider, StreamRequest } from '../src/providers/ModelProvider';
import { SUMMARY_SYSTEM, renderTranscript, summarizeMessages } from '../src/agent/summarize';

const history: ChatMessage[] = [
  { role: 'user', content: '<environment>\nbranch: main\n</environment>\n\nAdd a slugify helper' },
  { role: 'assistant', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't', name: 'read_file', input: { path: 'src/a.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(2000) }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: 'not found', is_error: true }] },
];

describe('renderTranscript', () => {
  it('labels speakers, shows tool calls, clips results, and drops attached context', () => {
    const out = renderTranscript(history);
    expect(out).toContain('User: Add a slugify helper');
    expect(out).not.toContain('branch: main');
    expect(out).toContain('Assistant: On it.');
    expect(out).toContain('Assistant called read_file with {"path":"src/a.ts"}');
    expect(out).toMatch(/Tool result: x{400}…/);
    expect(out).toContain('Tool result (error): not found');
  });

  it('keeps very long transcripts to a bounded size, keeping both ends', () => {
    const long: ChatMessage[] = Array.from({ length: 2000 }, (_, i) => ({ role: 'user' as const, content: `message ${i} ${'y'.repeat(100)}` }));
    const out = renderTranscript(long);
    expect(out.length).toBeLessThan(61_000);
    expect(out).toContain('message 0 ');
    expect(out).toContain('message 1999 ');
    expect(out).toContain('middle of the transcript omitted');
  });
});

describe('summarizeMessages', () => {
  const provider = (text: string, seen: StreamRequest[] = []): ModelProvider => ({
    async *stream(req) {
      seen.push(req);
      yield { type: 'text_delta', text };
      yield { type: 'stop', reason: 'end_turn' };
    },
  });

  it('asks without tools or reasoning, with a small output cap, and returns the trimmed text', async () => {
    const seen: StreamRequest[] = [];
    expect(await summarizeMessages(provider('  The summary.  ', seen), history)).toBe('The summary.');
    expect(seen[0]).toMatchObject({ system: SUMMARY_SYSTEM, reasoning: false, maxTokens: 1500 });
    expect(seen[0].tools).toBeUndefined();
    expect(String(seen[0].messages[0].content)).toContain('Add a slugify helper');
  });

  it('throws on an empty summary so the caller can fall back', async () => {
    await expect(summarizeMessages(provider('   '), history)).rejects.toThrow(/empty/);
  });
});
