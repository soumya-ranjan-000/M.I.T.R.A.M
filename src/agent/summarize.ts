import type { ChatMessage, ModelProvider } from '../providers/ModelProvider';

const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_RESULT_CHARS = 400;
const CONTEXT_RE = /<(context|environment)>[\s\S]*?<\/\1>\s*/g;

export const SUMMARY_SYSTEM = [
  'You summarise part of a coding-assistant session so the work can continue after older messages are removed.',
  'Write a compact, factual summary (under 400 words) covering: what the user asked for and any later changes of mind; decisions made and why;',
  'files created or changed and what changed; commands run and their important results; errors hit and how they were fixed;',
  'what is finished, what is still open, and anything the later work depends on (names, paths, commands, constraints).',
  'Be specific: use exact file paths and identifiers. No preamble, no advice, only the summary.',
].join(' ');

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Plain-text rendering of messages, small enough to summarise in one request. */
export function renderTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who = m.role === 'user' ? 'User' : 'Assistant';
    if (typeof m.content === 'string') {
      lines.push(`${who}: ${m.content.replace(CONTEXT_RE, '').trim()}`);
      continue;
    }
    for (const block of m.content as unknown as { type: string; [k: string]: unknown }[]) {
      if (block.type === 'text') {
        lines.push(`${who}: ${String(block.text).replace(CONTEXT_RE, '').trim()}`);
      } else if (block.type === 'image') {
        lines.push(`${who}: [attached an image]`);
      } else if (block.type === 'document') {
        lines.push(`${who}: [attached a PDF${typeof block.title === 'string' ? ` "${block.title}"` : ''}]`);
      } else if (block.type === 'tool_use') {
        lines.push(`Assistant called ${String(block.name)} with ${clip(JSON.stringify(block.input ?? {}), 200)}`);
      } else if (block.type === 'tool_result') {
        const c = block.content;
        const text = typeof c === 'string' ? c : JSON.stringify(c);
        lines.push(`Tool result${block.is_error ? ' (error)' : ''}: ${clip(text, MAX_RESULT_CHARS)}`);
      }
    }
  }
  const text = lines.filter((l) => l.trim()).join('\n');
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  const half = MAX_TRANSCRIPT_CHARS / 2;
  return `${text.slice(0, half)}\n… [middle of the transcript omitted] …\n${text.slice(-half)}`;
}

/** Asks the model for a summary of `messages`. Throws if nothing usable comes back. */
export async function summarizeMessages(provider: ModelProvider, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  let summary = '';
  for await (const event of provider.stream({
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: `Summarise this session so far:\n\n${renderTranscript(messages)}` }],
    signal,
    reasoning: false,
    maxTokens: 1500,
  })) {
    if (event.type === 'text_delta') summary += event.text;
  }
  if (!summary.trim()) throw new Error('The summary was empty.');
  return summary.trim();
}
