import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ModelProvider, StopReason, ToolUse, Usage } from '../providers/ModelProvider';
import { Tool, ToolContext, ToolRegistry, truncateMiddle } from '../tools/Tool';
import type { ApprovalDecision, Board, ToolStatus } from '../webview/protocol';
import { renderBoardForModel } from './board';
import { estimateTokens, manageContextAsync } from './contextManager';
import { RunTracker, ToolOutcome } from './runTracker';
import { summarizeMessages } from './summarize';

const MAX_RESULT_CHARS = 30_000;
const MAX_UI_OUTPUT_CHARS = 4_000;

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; name: string; summary: string; detail?: string; status: ToolStatus }
  | { type: 'tool_update'; id: string; status: ToolStatus; output?: string }
  | { type: 'notice'; text: string }
  /** The run stopped early but can be continued: out of steps or time, or going in circles. */
  | { type: 'budget'; reason: 'steps' | 'time' | 'stuck'; steps: number }
  | { type: 'usage'; usage: Usage };

export interface ApprovalRequest {
  id: string;
  tool: Tool;
  input: unknown;
  summary: string;
  detail?: string;
}

export interface AgentOptions {
  provider: ModelProvider;
  system: string;
  /** Mutated in place: assistant and tool-result messages are appended. */
  history: ChatMessage[];
  registry: ToolRegistry;
  ctx: ToolContext;
  maxIterations: number;
  /** The model's context window in tokens. When set, old context is trimmed to fit. */
  contextWindow?: number;
  /** Summarise old turns when context runs out, instead of just dropping them. */
  summarizeContext?: boolean;
  /** The agent's board. Shown to the model at the end of every request, and checked before it may finish. */
  getBoard?: () => Board;
  /** Before finishing, make the agent check files it changed and finish its board tasks. */
  verifyBeforeDone?: boolean;
  /** Stop (resumably) after this long. 0 or unset means no time limit. */
  maxRunMs?: number;
  /** Clock, replaceable in tests. */
  now?: () => number;
  onEvent: (event: AgentEvent) => void;
  /** Return true to run a tool that normally needs approval without asking. */
  isAutoApproved?: (tool: Tool, input: unknown) => boolean;
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

class AbortedError extends Error {
  override name = 'AbortError';
}

/**
 * Runs the model/tool loop until the model stops calling tools, the user cancels,
 * or the iteration limit is reached.
 *
 * Invariant: every tool_use block pushed to `history` is followed by a user message
 * holding a tool_result for each one (even when cancelled), so the history stays valid.
 */
export async function runAgent(options: AgentOptions): Promise<void> {
  const { provider, system, history, registry, ctx, maxIterations, onEvent } = options;
  const tools = registry.size > 0 ? registry.definitions() : undefined;
  const fixedTokens = estimateTokens(system) + estimateTokens(JSON.stringify(tools ?? []));
  const tracker = new RunTracker();
  const now = options.now ?? Date.now;
  const startedAt = now();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let text = '';
    const toolUses: ToolUse[] = [];
    let stop: StopReason = 'other';

    if (options.maxRunMs && now() - startedAt >= options.maxRunMs) {
      const minutes = Math.max(1, Math.round(options.maxRunMs / 60_000));
      onEvent({ type: 'notice', text: `Paused after ${minutes} minute${minutes === 1 ? '' : 's'}. Press Continue to keep going.` });
      onEvent({ type: 'budget', reason: 'time', steps: iteration });
      return;
    }

    if (options.contextWindow) {
      const trimmed = await manageContextAsync(history, {
        windowTokens: options.contextWindow,
        fixedTokens,
        summarize: options.summarizeContext ? (turns) => summarizeMessages(provider, turns, ctx.signal) : undefined,
        onSummarizing: () => onEvent({ type: 'notice', text: 'Summarising the earlier conversation to free up context…' }),
      });
      if (trimmed.changed) {
        const k = (n: number) => `${Math.round(n / 1000)}k`;
        onEvent({
          type: 'notice',
          text: `${trimmed.summarized ? 'Summarised' : 'Trimmed'} older context to stay within the model's limit (about ${k(trimmed.before)} → ${k(trimmed.after)} tokens).`,
        });
      }
    }

    // The board and run status go at the very end, outside the cached history, so they are
    // always current and survive any trimming.
    const volatileContext =
      [options.getBoard ? renderBoardForModel(options.getBoard()) : '', tracker.noteForModel()].filter(Boolean).join('\n') || undefined;

    try {
      for await (const event of provider.stream({ system, messages: history, tools, signal: ctx.signal, volatileContext })) {
        if (event.type === 'text_delta') {
          text += event.text;
          onEvent({ type: 'text', text: event.text });
        } else if (event.type === 'thinking_delta') {
          onEvent({ type: 'thinking', text: event.text });
        } else if (event.type === 'tool_use') {
          toolUses.push(event.toolUse);
        } else if (event.type === 'usage') {
          onEvent({ type: 'usage', usage: event.usage });
        } else if (event.type === 'stop') {
          stop = event.reason;
        }
      }
    } catch (error) {
      if (ctx.signal.aborted && text) history.push({ role: 'assistant', content: text });
      throw error;
    }

    const content: Anthropic.ContentBlockParam[] = [];
    if (text) content.push({ type: 'text', text });
    for (const use of toolUses) {
      content.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input });
    }
    if (content.length > 0) history.push({ role: 'assistant', content });

    if (stop === 'refusal') {
      onEvent({ type: 'notice', text: 'The model declined to continue with this request.' });
      return;
    }
    if (toolUses.length === 0) {
      if (stop === 'max_tokens') {
        onEvent({ type: 'notice', text: 'The response was cut off (max tokens reached).' });
        return;
      }
      // The model wants to stop: make sure it has checked its work and finished its plan.
      const check = tracker.checkFinish(options.getBoard?.(), { verify: options.verifyBeforeDone ?? false });
      if (check.action === 'nudge') {
        history.push({ role: 'user', content: check.message });
        onEvent({ type: 'notice', text: `Not finished yet (${check.reason}). Asking the agent to carry on.` });
        continue;
      }
      if (check.action === 'finish-with-warning') {
        onEvent({ type: 'notice', text: `Finished with open items: ${check.warning}` });
      }
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let stuck = false;
    for (const use of toolUses) {
      if (ctx.signal.aborted) {
        results.push(toolResult(use.id, 'Cancelled by the user.', true));
      } else if (stop === 'max_tokens') {
        // The call may have been cut off mid-input, so never run it.
        results.push(toolResult(use.id, 'The response was cut off before this call completed. Retry with smaller steps.', true));
      } else {
        const done = await executeTool(use, options);
        const verdict = tracker.record(use.name, use.input, done.outcome, done.output);
        if (verdict === 'warn' || verdict === 'stop') {
          done.block.content = `${done.block.content}\n\n[Note: this exact call has now given the same result several times. Do something different: change the approach, or mark the task blocked and ask the user.]`;
        }
        if (verdict === 'stop') stuck = true;
        results.push(done.block);
      }
    }
    history.push({ role: 'user', content: results });

    if (ctx.signal.aborted) throw new AbortedError('Aborted');
    if (stuck) {
      onEvent({
        type: 'notice',
        text: 'Stopped: the same action kept giving the same result. Tell me how to proceed, or press Continue to let me try a different approach.',
      });
      onEvent({ type: 'budget', reason: 'stuck', steps: iteration + 1 });
      return;
    }
  }

  onEvent({ type: 'notice', text: `Paused after ${maxIterations} steps. Press Continue to keep going.` });
  onEvent({ type: 'budget', reason: 'steps', steps: maxIterations });
}

function toolResult(id: string, content: string, isError: boolean): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) };
}

interface ToolRun {
  block: Anthropic.ToolResultBlockParam & { content: string };
  outcome: ToolOutcome;
  /** The text of the result, for the run tracker. */
  output: string;
}

function finished(id: string, content: string, outcome: ToolOutcome): ToolRun {
  return { block: toolResult(id, content, outcome !== 'ok') as ToolRun['block'], outcome, output: content };
}

async function executeTool(use: ToolUse, options: AgentOptions): Promise<ToolRun> {
  const { registry, ctx, onEvent } = options;
  const tool = registry.get(use.name);
  if (!tool) {
    onEvent({ type: 'tool_start', id: use.id, name: use.name, summary: use.name, status: 'error' });
    onEvent({ type: 'tool_update', id: use.id, status: 'error', output: `Unknown tool: ${use.name}` });
    return finished(use.id, `Unknown tool "${use.name}".`, 'error');
  }

  let preview = { summary: tool.name, detail: undefined as string | undefined };
  try {
    preview = { detail: undefined, ...tool.preview(use.input) };
  } catch {
    // Malformed input: run() will report a precise error to the model.
  }

  let blocked: string | null = null;
  try {
    blocked = tool.policy?.(use.input, ctx) ?? null;
  } catch {
    // Malformed input: run() will report a precise error to the model.
  }
  if (blocked) {
    onEvent({ type: 'tool_start', id: use.id, name: tool.name, summary: preview.summary, status: 'error' });
    onEvent({ type: 'tool_update', id: use.id, status: 'error', output: `Blocked: ${blocked}` });
    return finished(use.id, `Blocked by safety policy: ${blocked} Do not retry this; choose a safer approach or ask the user.`, 'error');
  }

  // Decide before showing the card, so auto-approved actions never flash approval buttons.
  const needsPrompt = tool.requiresApproval && !options.isAutoApproved?.(tool, use.input);

  onEvent({
    type: 'tool_start',
    id: use.id,
    name: tool.name,
    summary: preview.summary,
    detail: preview.detail,
    status: needsPrompt ? 'pending' : 'running',
  });

  if (needsPrompt) {
    const decision = await options.requestApproval({ id: use.id, tool, input: use.input, ...preview });
    if (decision === 'reject') {
      onEvent({ type: 'tool_update', id: use.id, status: 'rejected' });
      return finished(use.id, 'The user rejected this action. Do not retry it; ask what they want instead.', 'rejected');
    }
    onEvent({ type: 'tool_update', id: use.id, status: 'running' });
  }

  try {
    const output = await tool.run(use.input, ctx);
    onEvent({ type: 'tool_update', id: use.id, status: 'ok', output: truncateMiddle(output, MAX_UI_OUTPUT_CHARS) });
    return { ...finished(use.id, truncateMiddle(output, MAX_RESULT_CHARS) || '(empty result)', 'ok'), output };
  } catch (error) {
    const message = (error as Error).message || 'Tool failed.';
    onEvent({ type: 'tool_update', id: use.id, status: 'error', output: message });
    return finished(use.id, message, 'error');
  }
}
