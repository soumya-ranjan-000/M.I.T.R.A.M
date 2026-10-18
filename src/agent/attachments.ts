import type { ChatMessage } from '../providers/ModelProvider';
import type { ImageMediaType } from '../webview/protocol';

/** Shown to the model where an old image was taken out of the conversation. */
export const REMOVED_IMAGE = '[image removed to save context]';
/** Shown to the model where an image was not kept when the chat was saved. */
export const IMAGE_NOT_KEPT = '[an image was attached here, but it was not kept when the chat was saved]';

// Current models read images up to 2576 px on the long edge and 3.75 MP, at about w*h/750 tokens,
// so one image costs at most about this much.
const MAX_IMAGE_TOKENS = 4784;
// A PDF page costs its text plus an image of the page: typically 1,500-3,000 tokens and more.
const PDF_PAGE_TOKENS = 3000;
/** With more than 20 images in one request the API accepts smaller images only, so keep at most 20. */
export const MAX_HISTORY_IMAGES = 20;
/** Base64 characters of images and PDFs per request, well inside the API's 32 MB request limit. */
export const MAX_HISTORY_ATTACHMENT_CHARS = 24_000_000;

// About 64 KB once decoded, which reaches a JPEG frame header after any metadata.
const HEADER_CHARS = 87_384;

type Block = { type: string; [key: string]: unknown };

const isAttachment = (block: Block) => block.type === 'image' || block.type === 'document';
const base64Of = (block: object) => {
  const data = (block as { source?: { data?: unknown } }).source?.data;
  return typeof data === 'string' ? data : '';
};

/** The image type from its first bytes, so a file's extension is never trusted. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Width and height from a PNG or JPEG header, or null if they can't be found. */
export function imageDimensions(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64.slice(0, HEADER_CHARS), 'base64');
  const type = sniffImageType(bytes);
  if (type === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (type !== 'image/jpeg') return null;
  // Walk the segments to the frame header: SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
  let i = 2;
  while (i + 9 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Pages in a PDF, counted from its page objects, or from the page tree when those are compressed.
 * Null if neither can be found.
 */
export function pdfPageCount(pdf: Buffer): number | null {
  const text = pdf.toString('latin1');
  const pages = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  if (pages > 0) return pages;
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1] ?? m[2]));
  return counts.length ? Math.max(...counts) : null;
}

const tokenCache = new WeakMap<object, number>();

/** Rough tokens for an image (w*h/750, capped) or a document block (by its pages or its text). */
export function estimateAttachmentTokens(block: Block): number {
  const cached = tokenCache.get(block);
  if (cached !== undefined) return cached;
  const data = base64Of(block);
  let tokens: number;
  if (block.type === 'image') {
    const size = data ? imageDimensions(data) : null;
    tokens = size ? Math.min(MAX_IMAGE_TOKENS, Math.ceil((size.width * size.height) / 750)) : MAX_IMAGE_TOKENS;
  } else if ((block as { source?: { type?: unknown } }).source?.type === 'base64') {
    const bytes = Buffer.from(data, 'base64');
    tokens = (pdfPageCount(bytes) ?? Math.max(1, Math.round(bytes.length / 60_000))) * PDF_PAGE_TOKENS;
  } else {
    tokens = Math.ceil(data.length / 3.5);
  }
  tokenCache.set(block, tokens);
  return tokens;
}

/** What the model sees in place of an image or PDF that was taken out. */
function note(block: Block, why: 'trimmed' | 'not kept'): string {
  if (block.type === 'image') return why === 'trimmed' ? REMOVED_IMAGE : IMAGE_NOT_KEPT;
  const name = typeof block.title === 'string' ? ` "${block.title}"` : '';
  return why === 'trimmed'
    ? `[PDF${name} removed to save context]`
    : `[a PDF${name} was attached here, but it was not kept when the chat was saved]`;
}

/** Replaces the images and PDFs in a message with a short note, in place. Returns how many it replaced. */
export function dropAttachments(message: ChatMessage, why: 'trimmed' | 'not kept'): number {
  if (typeof message.content === 'string') return 0;
  let count = 0;
  message.content = (message.content as unknown as Block[]).map((block) => {
    if (!isAttachment(block)) return block;
    count++;
    return { type: 'text', text: note(block, why) };
  }) as unknown as typeof message.content;
  return count;
}

/** True if a message carries an image or a PDF. */
export function hasAttachments(message: ChatMessage): boolean {
  return typeof message.content !== 'string' && (message.content as unknown as Block[]).some(isAttachment);
}

/**
 * Keeps a request inside the API's limits on images and PDFs, in count and in size, by replacing
 * the oldest ones with a note. The newest message keeps its own. Edits `history` in place and
 * returns how many it removed.
 */
export function pruneAttachments(
  history: ChatMessage[],
  maxImages = MAX_HISTORY_IMAGES,
  maxChars = MAX_HISTORY_ATTACHMENT_CHARS,
): number {
  const found: { message: number; block: number; image: boolean; chars: number }[] = [];
  history.forEach((m, message) => {
    if (typeof m.content === 'string') return;
    (m.content as unknown as Block[]).forEach((b, block) => {
      if (isAttachment(b)) found.push({ message, block, image: b.type === 'image', chars: base64Of(b).length });
    });
  });
  let images = found.filter((f) => f.image).length;
  let chars = found.reduce((n, f) => n + f.chars, 0);
  let removed = 0;
  for (const f of found) {
    const tooManyImages = images > maxImages;
    const tooLarge = chars > maxChars;
    if ((!tooManyImages && !tooLarge) || f.message === history.length - 1) break;
    if (!tooLarge && !f.image) continue; // only the image count is over: a PDF can stay
    const blocks = history[f.message].content as unknown as Block[];
    blocks[f.block] = { type: 'text', text: note(blocks[f.block], 'trimmed') };
    if (f.image) images--;
    chars -= f.chars;
    removed++;
  }
  return removed;
}
