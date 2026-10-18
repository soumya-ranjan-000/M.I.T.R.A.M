export type ContextPart =
  | { kind: 'selection'; path: string; startLine: number; endLine: number; text: string }
  | { kind: 'file'; path: string; text: string; truncated: boolean };

/** Wraps the user's text with the environment summary and any attached editor context. */
export function formatUserMessage(text: string, parts: ContextPart[], environment = ''): string {
  const prefix = environment ? `${environment}\n` : '';
  if (parts.length === 0) return prefix ? `${prefix}\n${text}` : text;
  const blocks = parts.map((part) => {
    if (part.kind === 'selection') {
      return `<selection path="${part.path}" lines="${part.startLine}-${part.endLine}">\n${part.text}\n</selection>`;
    }
    const note = part.truncated ? '\n[file truncated]' : '';
    return `<file path="${part.path}">\n${part.text}${note}\n</file>`;
  });
  return `${prefix}<context>\n${blocks.join('\n')}\n</context>\n\n${text}`;
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}
