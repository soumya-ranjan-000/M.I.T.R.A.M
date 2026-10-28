// Folds the agent's working steps (tool calls, reasoning, attached files) into groups, so the
// transcript reads as the conversation with one line of "what it did" between replies.
import { SUBAGENT_TOOL, type DisplayMessage, type ToolCall } from './protocol';

export type StepMessage = Extract<DisplayMessage, { role: 'tool' | 'thinking' | 'retrieved' }>;

/** A message with its position in the list it came from. */
export interface Indexed<T extends DisplayMessage = DisplayMessage> {
  message: T;
  index: number;
}

export type TranscriptItem = ({ kind: 'message' } & Indexed) | { kind: 'steps'; steps: Indexed<StepMessage>[] };

export type StepsStatus = 'pending' | 'running' | 'error' | 'ok';

export function isStep(m: DisplayMessage): m is StepMessage {
  return m.role === 'tool' || m.role === 'thinking' || m.role === 'retrieved';
}

/**
 * Splits a transcript into messages and runs of steps. A run shorter than `minSize` stays as
 * plain messages: a group around a single card hides nothing and adds a click.
 */
export function groupSteps(messages: DisplayMessage[], minSize = 2): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: Indexed<StepMessage>[] = [];
  const close = () => {
    if (run.length >= minSize) items.push({ kind: 'steps', steps: run });
    else for (const s of run) items.push({ kind: 'message', ...s });
    run = [];
  };
  messages.forEach((message, index) => {
    if (isStep(message)) {
      run.push({ message, index });
    } else {
      close();
      items.push({ kind: 'message', message, index });
    }
  });
  close();
  return items;
}

/** The exit code of a finished run_command call, or null if it did not run to an exit. */
export function commandExit(tool: Pick<ToolCall, 'name' | 'status' | 'output'>): number | null {
  if (tool.name !== 'run_command' || tool.status !== 'ok' || !tool.output) return null;
  const m = /^exit code (\d+)/.exec(tool.output);
  return m ? Number(m[1]) : null;
}

/** A step is waiting for the user: its own approval, or one a sub-agent asked for. */
export function isWaiting(m: StepMessage): boolean {
  return m.role === 'tool' && (m.status === 'pending' || !!m.steps?.some((s) => s.status === 'pending'));
}

/** One status for a group: anything waiting wins, then anything running, then any failure. */
export function stepsStatus(steps: StepMessage[]): StepsStatus {
  const tools = steps.filter((s): s is Extract<StepMessage, { role: 'tool' }> => s.role === 'tool');
  if (steps.some(isWaiting)) return 'pending';
  if (tools.some((t) => t.status === 'running')) return 'running';
  if (tools.some((t) => t.status === 'error' || (commandExit(t) ?? 0) !== 0)) return 'error';
  return 'ok';
}

const READS = new Set(['read_file']);
const SEARCHES = new Set(['list_dir', 'search_files', 'find_files']);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a group did, in a few words: "Read 3 files, ran 2 commands". */
export function describeSteps(steps: StepMessage[]): string {
  const count = (test: (name: string) => boolean) =>
    steps.filter((s) => s.role === 'tool' && test(s.name)).length;
  const parts: string[] = [];
  const reads = count((n) => READS.has(n));
  const searches = count((n) => SEARCHES.has(n));
  const edits = count((n) => n === 'edit_file');
  const creates = count((n) => n === 'create_file');
  const commands = count((n) => n === 'run_command');
  const diagnostics = count((n) => n === 'get_diagnostics');
  const agents = count((n) => n === SUBAGENT_TOOL);
  const mcp = count((n) => n.startsWith('mcp__'));
  const known = reads + searches + edits + creates + commands + diagnostics + agents + mcp;
  const other = steps.filter((s) => s.role === 'tool').length - known;

  if (reads) parts.push(`read ${plural(reads, 'file')}`);
  if (searches) parts.push(plural(searches, 'search', 'searches'));
  if (edits) parts.push(`edited ${plural(edits, 'file')}`);
  if (creates) parts.push(`created ${plural(creates, 'file')}`);
  if (commands) parts.push(`ran ${plural(commands, 'command')}`);
  if (diagnostics) parts.push('checked problems');
  if (agents) parts.push(plural(agents, 'sub-agent'));
  if (mcp) parts.push(plural(mcp, 'MCP call'));
  if (other) parts.push(plural(other, 'other step'));
  if (parts.length === 0) {
    if (steps.some((s) => s.role === 'thinking')) parts.push('reasoned');
    if (steps.some((s) => s.role === 'retrieved')) parts.push('attached related files');
  }
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The steps a working group keeps on screen while folded: whatever waits for the user or is
 * running, and reasoning that is still streaming. With none of those, the latest step.
 */
export function liveSteps<T extends Indexed<StepMessage>>(steps: T[]): T[] {
  const live = steps.filter(({ message: m }) => isWaiting(m) || (m.role === 'tool' && m.status === 'running'));
  const last = steps[steps.length - 1];
  if (last?.message.role === 'thinking' && !live.includes(last)) live.push(last);
  return live.length ? live : last ? [last] : [];
}
