import * as path from 'node:path';
import type { ChatMessage, ModelProvider } from '../providers/ModelProvider';
import { SubagentMode, SubagentRunner, Tool, ToolRegistry } from '../tools/Tool';
import { SUBAGENT_TOOL, type ApprovalDecision } from '../webview/protocol';
import { AgentEvent, ApprovalRequest, FileChange, recordWrites, runAgent } from './AgentLoop';

export interface SubagentDeps {
  provider: ModelProvider;
  /** The main agent's tools. A sub-agent gets them without the board and delegation, and only the read-only ones to explore. */
  registry: ToolRegistry;
  /** The system prompt for a sub-agent. `readOnly` says whether it can change anything. */
  system: (readOnly: boolean) => string;
  /** Model/tool steps one sub-agent may take. */
  maxSteps: number;
  /** Sub-agents that may work at once; the rest wait for a free slot. */
  maxConcurrent: number;
  contextWindow?: number;
  summarizeContext?: boolean;
  /** An event from the sub-agent working for the delegate_task call `parentId`. */
  onEvent: (parentId: string, event: AgentEvent) => void;
  /** Sets the note on that sub-agent's card, or clears it with ''. */
  onNote: (parentId: string, note: string) => void;
  /** A file a sub-agent wrote, so its card in the chat can show the change. */
  onFileChange?: (change: FileChange) => void;
  isAutoApproved?: (tool: Tool, input: unknown) => boolean;
  requestApproval: (request: ApprovalRequest, parentId: string) => Promise<ApprovalDecision>;
  log?: (message: string) => void;
}

function abortError(): Error {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/** A counting semaphore, first come first served. A waiter gives up when its signal aborts. */
export class Slots {
  private active = 0;
  private readonly waiting = new Set<() => void>();

  /** A function is read on every check, so a changed setting applies to the next waiter. */
  constructor(private readonly size: number | (() => number)) {}

  private get limit(): number {
    return typeof this.size === 'function' ? this.size() : this.size;
  }

  get free(): boolean {
    return this.active < this.limit;
  }

  async use<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      if (signal.aborted) throw abortError();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          this.waiting.delete(wake);
          reject(abortError());
        };
        this.waiting.add(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (signal.aborted) throw abortError();
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiting.values().next().value;
      if (next) {
        this.waiting.delete(next);
        next();
      }
    }
  }
}

/** The tools for a sub-agent: no board (that is the main agent's plan) and no sub-agents of its own. */
export function subagentTools(registry: ToolRegistry, mode: SubagentMode): ToolRegistry {
  const tools = registry.without('update_board', SUBAGENT_TOOL);
  return mode === 'explore' ? tools.readOnly() : tools;
}

const STOPPED: Record<'steps' | 'time' | 'stuck', string> = {
  steps: 'it used all of its steps',
  time: 'it ran out of time',
  stuck: 'it kept repeating the same action',
};

function lastText(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (text.trim()) return text.trim();
  }
  return '';
}

/** What the main agent gets back: the sub-agent's last words, plus facts from the harness it cannot misreport. */
function buildReport(history: ChatMessage[], stopped: keyof typeof STOPPED | undefined, changed: string[]): string {
  const parts = [lastText(history) || '(The sub-agent finished without writing a report.)'];
  if (stopped) parts.push(`[The sub-agent stopped before finishing because ${STOPPED[stopped]}. Its report may be incomplete.]`);
  if (changed.length) parts.push(`[Files changed by this sub-agent: ${changed.join(', ')}]`);
  return parts.join('\n\n');
}

/**
 * Runs sub-agents for one run of the main agent. Each works with its own history and returns only
 * its final report. A few run at once; their edits and commands share one lock, so they never write
 * at the same moment and their approval prompts come one at a time.
 */
export function createSubagentRunner(deps: SubagentDeps): SubagentRunner {
  const slots = new Slots(Math.max(1, deps.maxConcurrent));
  const writes = new Slots(1);

  return {
    async run(task, ctx) {
      let shown = '';
      const note = (text: string) => {
        if (text === shown) return;
        shown = text;
        deps.onNote(task.callId, text);
      };
      const tools = subagentTools(deps.registry, task.mode);
      const readOnly = tools.readOnly().size === tools.size;

      if (!slots.free) note(`Queued: ${deps.maxConcurrent} sub-agent${deps.maxConcurrent === 1 ? ' is' : 's are'} already working`);
      return slots.use(ctx.signal, async () => {
        note('');
        deps.log?.(`subagent start: mode=${readOnly ? 'explore' : 'implement'} tools=${tools.size}`);
        const changed = new Set<string>();
        const history: ChatMessage[] = [{ role: 'user', content: task.prompt }];
        let stopped: keyof typeof STOPPED | undefined;
        let calls = 0;

        await runAgent({
          provider: deps.provider,
          system: deps.system(readOnly),
          history,
          registry: tools,
          ctx: { ...ctx, files: recordWrites(ctx.files, changed), board: undefined, subagents: undefined, callId: undefined },
          maxIterations: deps.maxSteps,
          contextWindow: deps.contextWindow,
          summarizeContext: deps.summarizeContext,
          onEvent: (event) => {
            if (event.type === 'budget') stopped = event.reason;
            if (event.type === 'tool_start') calls++;
            deps.onEvent(task.callId, event);
          },
          onFileChange: deps.onFileChange,
          isAutoApproved: deps.isAutoApproved,
          requestApproval: (request) => deps.requestApproval(request, task.callId),
          exclusive: (fn) => {
            if (!writes.free) note('Waiting for another sub-agent to finish a change');
            return writes.use(ctx.signal, () => {
              note('');
              return fn();
            });
          },
        });

        const files = [...changed].map((abs) => path.relative(ctx.root, abs));
        deps.log?.(`subagent done: calls=${calls} changed=${files.length}${stopped ? ` stopped=${stopped}` : ''}`);
        return buildReport(history, stopped, files);
      });
    },
  };
}
