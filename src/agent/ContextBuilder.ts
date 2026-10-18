import type Anthropic from '@anthropic-ai/sdk';
import type { FileAttachment, ImageAttachment } from '../webview/protocol';

export type ContextPart =
  | { kind: 'selection'; path: string; startLine: number; endLine: number; text: string }
  | { kind: 'file'; path: string; text: string; truncated: boolean }
  /** A file the user attached from outside the workspace: the text read from it. */
  | { kind: 'attachment'; name: string; text: string; truncated: boolean };

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Wraps the user's text with the environment summary and any attached editor context. */
export function formatUserMessage(text: string, parts: ContextPart[], environment = ''): string {
  const prefix = environment ? `${environment}\n` : '';
  if (parts.length === 0) return prefix ? `${prefix}\n${text}` : text;
  const blocks = parts.map((part) => {
    if (part.kind === 'selection') {
      return `<selection path="${part.path}" lines="${part.startLine}-${part.endLine}">\n${part.text}\n</selection>`;
    }
    if (part.kind === 'attachment') {
      const note = part.truncated ? '\n[attachment shortened]' : '';
      return `<attachment name="${escapeAttr(part.name)}">\n${part.text}${note}\n</attachment>`;
    }
    const note = part.truncated ? '\n[file truncated]' : '';
    return `<file path="${part.path}">\n${part.text}${note}\n</file>`;
  });
  return `${prefix}<context>\n${blocks.join('\n')}\n</context>\n\n${text}`;
}

/**
 * The user's turn as sent to the model. Without images or PDFs it is a plain string, as before, so
 * existing chats and the cached prompt prefix are unchanged; text read from other files joins the
 * attached context. With images or PDFs: those first, then one text block (never empty, which the
 * API rejects, and which marks the turn as typed).
 */
export function buildUserContent(
  text: string,
  parts: ContextPart[],
  environment: string,
  images: ImageAttachment[] = [],
  files: FileAttachment[] = [],
): string | Anthropic.ContentBlockParam[] {
  const sendableImages = images.filter((image) => image.data);
  const pdfs = files.filter((f) => f.kind === 'pdf' && f.data);
  const texts = files.filter((f) => f.kind === 'text' && f.data);
  const attached = sendableImages.length + pdfs.length + texts.length;
  const what = sendableImages.length && !pdfs.length && !texts.length ? 'image' : 'file';
  const words = text || (attached ? `(see the attached ${what}${attached === 1 ? '' : 's'})` : '');
  const allParts: ContextPart[] = [
    ...parts,
    ...texts.map((f) => ({ kind: 'attachment' as const, name: f.name, text: f.data, truncated: f.truncated })),
  ];
  const formatted = formatUserMessage(words, allParts, environment);
  if (sendableImages.length === 0 && pdfs.length === 0) return formatted;
  return [
    ...sendableImages.map((image) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
    })),
    ...pdfs.map((pdf) => ({
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: pdf.data },
      title: pdf.name,
    })),
    { type: 'text' as const, text: formatted },
  ];
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}
