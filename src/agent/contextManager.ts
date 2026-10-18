import type { ChatMessage } from '../providers/ModelProvider';
import { dropAttachments, estimateAttachmentTokens } from './attachments';

/** Conservative for source code, so we trim slightly early rather than overflow. */
const CHARS_PER_TOKEN = 3.5;

export const CLEARED_TOOL_OUTPUT = '[older tool output cleared to save context]';
export const REMOVED_CONTEXT = '[attached context removed to save context]';
export const REMOVED_TURNS = '[Earlier conversation was removed to save context.]';
export const SUMMARY_PREFIX = '[Summary of the earlier conversation, written to save context]';

/** What we assume a summary costs when deciding how much to replace. */
const SUMMARY_TOKENS = 800;
const MIN_CLEARABLE_CHARS = 400;
const CONTEXT_BLOCK_RE = /<(context|environment)>[\s\S]*?<\/\1>\s*/g;

type Block = { type: string; [key: string]: unknown };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function blocksOf(message: ChatMessage): Block[] {
  return typeof message.content === 'string' ? [] : (message.content as unknown as Block[]);
}

function blockChars(block: Block): number {
  switch (block.type) {
    case 'text':
      return String(block.text ?? '').length;
    case 'tool_use':
      return String(block.name ?? '').length + JSON.stringify(block.input ?? {}).length;
    case 'tool_result': {
      const c = block.content;
      if (typeof c === 'string') return c.length;
      return Array.isArray(c) ? c.reduce((n: number, b: Block) => n + blockChars(b), 0) : 0;
    }
    case 'image':
    case 'document':
      // Not the base64 length: an image costs about w*h/750 tokens and a PDF a few thousand per page.
      return estimateAttachmentTokens(block) * CHARS_PER_TOKEN;
    default:
      return JSON.stringify(block).length;
  }
}

export function estimateMessageTokens(message: ChatMessage): number {
  const chars =
    typeof message.content === 'string'
      ? message.content.length
      : blocksOf(message).reduce((n, b) => n + blockChars(b), 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** A user message the person typed (as opposed to one that only carries tool results). */
function isRealUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false;
  return typeof message.content === 'string' || blocksOf(message).some((b) => b.type === 'text');
}

export interface ManageOptions {
  /** The model's context window, in tokens. */
  windowTokens: number;
  /** Tokens used by the system prompt and tool definitions, which are not in `history`. */
  fixedTokens: number;
  /** Start trimming above this fraction of the window. */
  triggerRatio?: number;
  /** Trim down to this fraction of the window. */
  targetRatio?: number;
  /** The newest tool results are never cleared. */
  keepRecentToolResults?: number;
}

export interface ManageResult {
  changed: boolean;
  before: number;
  after: number;
  clearedToolResults: number;
  removedContexts: number;
  /** Images and PDFs taken out of older turns. */
  removedAttachments: number;
  droppedMessages: number;
  /** True if the dropped turns were replaced by a model-written summary. */
  summarized: boolean;
}

function totalTokens(history: ChatMessage[], fixedTokens: number): number {
  return fixedTokens + history.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

function turnStarts(history: ChatMessage[]): number[] {
  return history.flatMap((m, i) => (isRealUserMessage(m) ? [i] : []));
}

function thresholds(options: ManageOptions) {
  return {
    trigger: options.windowTokens * (options.triggerRatio ?? 0.7),
    target: options.windowTokens * (options.targetRatio ?? 0.5),
  };
}

/** Level 1: clear bulky old tool output, old attached context, images and PDFs, oldest first. Edits `history` in place. */
function clearBulky(history: ChatMessage[], options: ManageOptions, before: number, result: ManageResult): number {
  const { target } = thresholds(options);
  const keepRecent = options.keepRecentToolResults ?? 4;

  let lastUserIdx = -1;
  history.forEach((m, i) => {
    if (isRealUserMessage(m)) lastUserIdx = i;
  });

  const toolResults: Block[] = [];
  for (const m of history) {
    if (m.role === 'user') for (const b of blocksOf(m)) if (b.type === 'tool_result') toolResults.push(b);
  }
  const protectedResults = new Set(toolResults.slice(-keepRecent));

  const stripContext = (text: string): string | null => {
    CONTEXT_BLOCK_RE.lastIndex = 0;
    const has = CONTEXT_BLOCK_RE.test(text);
    CONTEXT_BLOCK_RE.lastIndex = 0;
    return has ? `${REMOVED_CONTEXT}\n${text.replace(CONTEXT_BLOCK_RE, '')}` : null;
  };

  let current = before;
  for (let i = 0; i < history.length && current > target; i++) {
    const message = history[i];
    if (message.role !== 'user') continue;
    const sizeBefore = estimateMessageTokens(message);

    for (const block of blocksOf(message)) {
      if (block.type === 'tool_result' && !protectedResults.has(block) && blockChars(block) > MIN_CLEARABLE_CHARS) {
        block.content = CLEARED_TOOL_OUTPUT;
        result.clearedToolResults++;
      }
    }
    if (i < lastUserIdx) {
      if (typeof message.content === 'string') {
        const stripped = stripContext(message.content);
        if (stripped !== null) {
          message.content = stripped;
          result.removedContexts++;
        }
      } else {
        for (const block of blocksOf(message)) {
          if (block.type !== 'text' || typeof block.text !== 'string') continue;
          const stripped = stripContext(block.text);
          if (stripped !== null) {
            block.text = stripped;
            result.removedContexts++;
          }
        }
        result.removedAttachments += dropAttachments(message, 'trimmed');
      }
    }
    current += estimateMessageTokens(message) - sizeBefore;
  }
  return current;
}

/** Level 2 without a summary: drop the oldest whole turns, never the current one. */
function dropOldestTurns(history: ChatMessage[], options: ManageOptions, result: ManageResult): void {
  const { target } = thresholds(options);
  for (;;) {
    const starts = turnStarts(history);
    if (starts.length < 2) break; // only the current turn is left
    result.droppedMessages += history.splice(0, starts[1]).length;
    if (totalTokens(history, options.fixedTokens) <= target) break;
  }
  if (result.droppedMessages > 0) prependMarker(history[0]);
}

function newResult(before: number): ManageResult {
  return {
    changed: false,
    before,
    after: before,
    clearedToolResults: 0,
    removedContexts: 0,
    removedAttachments: 0,
    droppedMessages: 0,
    summarized: false,
  };
}

function finish(history: ChatMessage[], options: ManageOptions, result: ManageResult): ManageResult {
  result.after = totalTokens(history, options.fixedTokens);
  result.changed = result.clearedToolResults + result.removedContexts + result.removedAttachments + result.droppedMessages > 0;
  return result;
}

/**
 * Keeps the conversation inside the context window by editing `history` in place.
 *
 * 1. Clears bulky old tool output, old attached file context, images and PDFs, oldest first.
 * 2. If that is not enough, drops the oldest whole turns (never the current one).
 *
 * Trimming happens in bursts (trigger 70%, target 50%) and is written back to the
 * history, so the next requests share a stable prefix and prompt caching still works.
 * Turns are removed whole, so every tool_use keeps its tool_result.
 */
export function manageContext(history: ChatMessage[], options: ManageOptions): ManageResult {
  const { trigger } = thresholds(options);
  const before = totalTokens(history, options.fixedTokens);
  const result = newResult(before);
  if (before <= trigger) return result;

  const current = clearBulky(history, options, before, result);
  if (current > trigger) dropOldestTurns(history, options, result);
  return finish(history, options, result);
}

export interface AsyncManageOptions extends ManageOptions {
  /** Writes a summary of the turns about to be removed. If absent or it fails, they are dropped. */
  summarize?: (turns: ChatMessage[]) => Promise<string>;
  /** Called just before a summary is requested, so the UI can say what is happening. */
  onSummarizing?: () => void;
}

const isAbort = (e: unknown) => ['AbortError', 'APIUserAbortError'].includes((e as { name?: string } | null)?.name ?? '');

/**
 * Like manageContext, but when whole turns have to go it first asks for a summary and keeps
 * that in their place, so decisions and findings survive. A later trim summarises the earlier
 * summary together with newer turns, so it works as a rolling summary.
 */
export async function manageContextAsync(history: ChatMessage[], options: AsyncManageOptions): Promise<ManageResult> {
  const { trigger, target } = thresholds(options);
  const before = totalTokens(history, options.fixedTokens);
  const result = newResult(before);
  if (before <= trigger) return result;

  const current = clearBulky(history, options, before, result);
  if (current <= trigger) return finish(history, options, result);

  const starts = turnStarts(history);
  if (starts.length >= 2 && options.summarize) {
    // Replace the fewest old turns that bring us under the target, counting the summary's own size.
    let cut = starts[starts.length - 1];
    for (let j = 1; j < starts.length; j++) {
      const removed = history.slice(0, starts[j]).reduce((n, m) => n + estimateMessageTokens(m), 0);
      if (current - removed + SUMMARY_TOKENS <= target) {
        cut = starts[j];
        break;
      }
    }
    options.onSummarizing?.();
    try {
      const summary = (await options.summarize(history.slice(0, cut))).trim();
      if (summary) {
        const count = history.splice(0, cut, { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` }).length;
        result.droppedMessages += count;
        result.summarized = true;
        return finish(history, options, result);
      }
    } catch (error) {
      if (isAbort(error)) throw error; // cancelled: leave the history untouched
    }
  }

  // No summary available: fall back to dropping.
  dropOldestTurns(history, options, result);
  return finish(history, options, result);
}

function prependMarker(first: ChatMessage): void {
  if (typeof first.content === 'string') {
    if (!first.content.startsWith(REMOVED_TURNS)) first.content = `${REMOVED_TURNS}\n\n${first.content}`;
    return;
  }
  const blocks = first.content as unknown as Block[];
  if (blocks[0]?.type === 'text' && String(blocks[0].text).startsWith(REMOVED_TURNS)) return;
  blocks.unshift({ type: 'text', text: REMOVED_TURNS });
}
