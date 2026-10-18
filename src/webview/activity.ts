import type { DisplayMessage } from './protocol';

export interface Activity {
  /** Short text for the status line, e.g. "Reading src/a.ts…". */
  label: string;
  /** True when the agent is blocked on the user, so no "working" animation should show. */
  waitingForUser: boolean;
}

/** What the agent is doing right now, derived from the end of the transcript. */
export function describeActivity(messages: DisplayMessage[]): Activity {
  const last = messages[messages.length - 1];
  if (!last) return { label: 'Thinking…', waitingForUser: false };

  if (last.role !== 'tool') {
    // Nothing has come back yet, or reasoning is streaming: thinking. Answer text: writing.
    return { label: last.role === 'assistant' ? 'Writing…' : 'Thinking…', waitingForUser: false };
  }

  switch (last.status) {
    case 'pending':
      return { label: 'Waiting for your approval', waitingForUser: true };
    case 'running':
      return { label: `${last.summary}…`, waitingForUser: false };
    default:
      return { label: 'Reviewing the result…', waitingForUser: false };
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}m ${seconds}s`;
}
