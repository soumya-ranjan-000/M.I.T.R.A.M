import { SUBAGENT_TOOL, type DisplayMessage } from './protocol';

type ToolMessage = Extract<DisplayMessage, { role: 'tool' }>;

export interface Activity {
  /** Short text for the status line, e.g. "Reading src/a.ts…". */
  label: string;
  /** True when the agent is blocked on the user, so no "working" animation should show. */
  waitingForUser: boolean;
}

/** The tool cards at the end of the transcript: calls from one response run at the same time. */
function trailingTools(messages: DisplayMessage[]): ToolMessage[] {
  const tools: ToolMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool') break;
    tools.unshift(m);
  }
  return tools;
}

/** What the agent is doing right now, derived from the end of the transcript. */
export function describeActivity(messages: DisplayMessage[]): Activity {
  const last = messages[messages.length - 1];
  if (!last) return { label: 'Thinking…', waitingForUser: false };

  if (last.role !== 'tool') {
    // Nothing has come back yet, or reasoning is streaming: thinking. Answer text: writing.
    return { label: last.role === 'assistant' ? 'Writing…' : 'Thinking…', waitingForUser: false };
  }

  const tools = trailingTools(messages);
  if (tools.some((t) => t.status === 'pending' || t.steps?.some((s) => s.status === 'pending'))) {
    return { label: 'Waiting for your approval', waitingForUser: true };
  }

  const running = tools.filter((t) => t.status === 'running');
  const agents = running.filter((t) => t.name === SUBAGENT_TOOL);
  if (agents.length > 1) return { label: `${agents.length} sub-agents working…`, waitingForUser: false };
  if (agents.length === 1) {
    const [agent] = agents;
    const step = agent.steps?.filter((s) => s.status === 'running').pop();
    return { label: step ? `${agent.summary}: ${step.summary}…` : `${agent.summary}…`, waitingForUser: false };
  }
  if (running.length > 0) return { label: `${running[running.length - 1].summary}…`, waitingForUser: false };
  return { label: 'Reviewing the result…', waitingForUser: false };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}m ${seconds}s`;
}
