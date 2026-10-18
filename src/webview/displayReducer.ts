import type { DisplayMessage, HostToWebview } from './protocol';

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
        return [...messages.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...messages, { role: 'thinking', text: event.text }];
    }
    case 'toolStart':
      return [
        ...messages,
        {
          role: 'tool',
          id: event.id,
          name: event.name,
          summary: event.summary,
          detail: event.detail,
          status: event.status,
        },
      ];
    case 'toolUpdate':
      return messages.map((m) =>
        m.role === 'tool' && m.id === event.id
          ? { ...m, status: event.status, output: event.output ?? m.output }
          : m,
      );
    case 'notice':
      return [...messages, { role: 'assistant', text: `_${event.text}_` }];
    default:
      return messages;
  }
}
