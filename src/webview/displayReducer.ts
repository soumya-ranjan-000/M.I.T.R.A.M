import type { DisplayMessage, HostToWebview, ToolCall } from './protocol';

/** Output kept on a running command's card. Older lines are dropped first; the finished card gets the tool's result instead. */
export const MAX_LIVE_OUTPUT_CHARS = 200_000;

/** The end of `text`, cut at a line break so the first line shown is whole. */
function keepTail(text: string): string {
  if (text.length <= MAX_LIVE_OUTPUT_CHARS) return text;
  const tail = text.slice(-MAX_LIVE_OUTPUT_CHARS);
  const nl = tail.indexOf('\n');
  return nl >= 0 ? tail.slice(nl + 1) : tail;
}

type ToolMessage = Extract<DisplayMessage, { role: 'tool' }>;

/** Changes the top-level tool card with this id. */
function updateTool(messages: DisplayMessage[], id: string, change: (m: ToolMessage) => ToolMessage): DisplayMessage[] {
  return messages.map((m) => (m.role === 'tool' && m.id === id ? change(m) : m));
}

/** Changes a tool call made by a sub-agent: its own card or, without a parent, a top-level one. */
function updateCall(
  messages: DisplayMessage[],
  id: string,
  parentId: string | undefined,
  change: <T extends ToolCall>(c: T) => T,
): DisplayMessage[] {
  if (!parentId) return updateTool(messages, id, change);
  return updateTool(messages, parentId, (m) => ({ ...m, steps: m.steps?.map((s) => (s.id === id ? change(s) : s)) }));
}

/**
 * Applies a host event to the visible message list. Shared by the extension host
 * (to persist the transcript) and the webview (to render it) so they never diverge.
 */
export function applyHostEvent(messages: DisplayMessage[], event: HostToWebview): DisplayMessage[] {
  switch (event.type) {
    case 'streamDelta': {
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        return [...messages.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...messages, { role: 'assistant', text: event.text }];
    }
    case 'thinkingDelta': {
      const last = messages[messages.length - 1];
      if (last?.role === 'thinking') {
        return [...messages.slice(0, -1), { ...last, text: last.text + event.text, ...(event.at ? { endedAt: event.at } : {}) }];
      }
      return [...messages, { role: 'thinking', text: event.text, ...(event.at ? { startedAt: event.at, endedAt: event.at } : {}) }];
    }
    case 'toolStart': {
      const call: ToolCall = { id: event.id, name: event.name, summary: event.summary, detail: event.detail, status: event.status };
      if (event.parentId) return updateTool(messages, event.parentId, (m) => ({ ...m, steps: [...(m.steps ?? []), call] }));
      return [...messages, { role: 'tool', ...call, ...(event.badge ? { badge: event.badge } : {}) }];
    }
    case 'toolUpdate':
      return updateCall(messages, event.id, event.parentId, (c) => ({ ...c, status: event.status, output: event.output ?? c.output }));
    case 'toolOutput':
      return updateCall(messages, event.id, event.parentId, (c) => ({ ...c, output: keepTail((c.output ?? '') + event.text) }));
    case 'toolWarning':
      return updateCall(messages, event.id, event.parentId, (c) => ({ ...c, warning: event.text }));
    case 'toolAllowRule':
      return updateCall(messages, event.id, event.parentId, (c) => ({ ...c, allowRule: { label: event.label, usesShell: event.usesShell } }));
    case 'toolNote':
      return updateTool(messages, event.id, (m) => ({ ...m, note: event.note || undefined }));
    case 'notice':
      return [...messages, { role: 'assistant', text: `_${event.text}_` }];
    case 'retrieved':
      return [...messages, { role: 'retrieved', files: event.files }];
    default:
      return messages;
  }
}
