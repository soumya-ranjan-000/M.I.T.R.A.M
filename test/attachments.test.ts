import { describe, expect, it } from 'vitest';
import {
  IMAGE_NOT_KEPT,
  MAX_HISTORY_IMAGES,
  REMOVED_IMAGE,
  dropAttachments,
  estimateAttachmentTokens,
  imageDimensions,
  pdfPageCount,
  pruneAttachments,
  sniffImageType,
} from '../src/agent/attachments';
import type { ChatMessage } from '../src/providers/ModelProvider';
import { fakeImage, pngHeader } from './imageFixtures';

/** The start of a JPEG file: SOI, an APP0 segment, a DHT segment, then the SOF0 frame header. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(9)]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sof]);
}

const imageBlock = (data: string) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data } });
const userWith = (images: number, text = 'look', padBytes = 0): ChatMessage => ({
  role: 'user',
  content: [...Array.from({ length: images }, () => imageBlock(fakeImage(800, 600, padBytes))), { type: 'text', text }],
});
const imageCount = (history: ChatMessage[]) =>
  history.reduce((n, m) => n + (typeof m.content === 'string' ? 0 : (m.content as { type: string }[]).filter((b) => b.type === 'image').length), 0);

describe('sniffImageType', () => {
  it('recognises the four image types from their first bytes', () => {
    expect(sniffImageType(pngHeader(1, 1))).toBe('image/png');
    expect(sniffImageType(jpegHeader(1, 1))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('rejects anything else, whatever the file is called', () => {
    expect(sniffImageType(Buffer.from('#!/bin/sh\nrm -rf x'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('imageDimensions', () => {
  it('reads PNG and JPEG headers', () => {
    expect(imageDimensions(pngHeader(1824, 968).toString('base64'))).toEqual({ width: 1824, height: 968 });
    expect(imageDimensions(jpegHeader(640, 480).toString('base64'))).toEqual({ width: 640, height: 480 });
  });

  it('returns null for data it cannot read', () => {
    expect(imageDimensions(Buffer.from('not an image').toString('base64'))).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]).toString('base64'))).toBeNull();
  });
});

describe('estimateAttachmentTokens', () => {
  it('uses w*h/750, not the size of the data', () => {
    expect(estimateAttachmentTokens(imageBlock(fakeImage(1000, 750, 2_000_000)))).toBe(1000);
  });

  it('caps at the largest image a model reads, and assumes that size when it cannot tell', () => {
    expect(estimateAttachmentTokens(imageBlock(fakeImage(10_000, 10_000)))).toBe(4784);
    expect(estimateAttachmentTokens(imageBlock('AAAA'))).toBe(4784);
    expect(estimateAttachmentTokens({ type: 'image', source: { type: 'url', url: 'https://x/y.png' } })).toBe(4784);
  });
});

describe('dropAttachments', () => {
  it('replaces each image with a note and keeps the text', () => {
    const message = userWith(2, 'what is this?');
    expect(dropAttachments(message, 'trimmed')).toBe(2);
    expect(message.content).toEqual([
      { type: 'text', text: REMOVED_IMAGE },
      { type: 'text', text: REMOVED_IMAGE },
      { type: 'text', text: 'what is this?' },
    ]);
    expect(dropAttachments({ role: 'user', content: 'plain' }, 'trimmed')).toBe(0);
  });
});

describe('pruneAttachments', () => {
  it('does nothing within the limits', () => {
    const history = [userWith(5), { role: 'assistant' as const, content: 'ok' }, userWith(5)];
    expect(pruneAttachments(history)).toBe(0);
    expect(imageCount(history)).toBe(10);
  });

  it('removes the oldest images past the count limit', () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) history.push(userWith(5, `turn ${i}`), { role: 'assistant', content: 'ok' });
    history.push(userWith(5, 'now'));
    expect(pruneAttachments(history)).toBe(30 - MAX_HISTORY_IMAGES);
    expect(imageCount(history)).toBe(MAX_HISTORY_IMAGES);
    expect((history[0].content as { type: string; text?: string }[])[0]).toEqual({ type: 'text', text: REMOVED_IMAGE });
    expect(imageCount([history[history.length - 1]])).toBe(5);
  });

  it('removes the oldest images past the size limit', () => {
    const history: ChatMessage[] = [userWith(1, 'a', 3000), { role: 'assistant', content: 'ok' }, userWith(1, 'b', 3000)];
    expect(pruneAttachments(history, 20, 5000)).toBe(1);
    expect(imageCount(history)).toBe(1);
  });

  it('never removes the newest message’s images, even if they alone are over the limit', () => {
    const history: ChatMessage[] = [userWith(5, 'now', 3000)];
    expect(pruneAttachments(history, 2, 10)).toBe(0);
    expect(imageCount(history)).toBe(5);
  });
});

describe('PDFs', () => {
  const pdf = (body: string) => Buffer.from(`%PDF-1.7\n${body}\n%%EOF`, 'latin1');
  const pdfBlock = (data: string, title = 'report.pdf') => ({
    type: 'document' as const,
    source: { type: 'base64' as const, media_type: 'application/pdf' as const, data },
    title,
  });

  it('counts pages from page objects, or from the page tree when those are compressed', () => {
    expect(pdfPageCount(pdf('1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >> 2 0 obj << /Type /Page >> 3 0 obj <</Type/Page/Parent 1 0 R>>'))).toBe(2);
    expect(pdfPageCount(pdf('5 0 obj << /Type /ObjStm /N 40 >> 1 0 obj << /Count 7 /Kids [4 0 R] /Type /Pages >>'))).toBe(7);
    expect(pdfPageCount(pdf('nothing to see'))).toBeNull();
  });

  it('estimates a PDF by its pages, not by the size of its base64', () => {
    const data = pdf(`<< /Type /Page >> << /Type /Page >> << /Type /Page >>${' '.repeat(3_000_000)}`).toString('base64');
    expect(estimateAttachmentTokens(pdfBlock(data))).toBe(9000);
  });

  it('replaces a PDF with a note that names it', () => {
    const message: ChatMessage = { role: 'user', content: [pdfBlock('JVBERi0x'), { type: 'text', text: 'summarise' }] };
    dropAttachments(message, 'not kept');
    expect(message.content).toEqual([
      { type: 'text', text: '[a PDF "report.pdf" was attached here, but it was not kept when the chat was saved]' },
      { type: 'text', text: 'summarise' },
    ]);
    const image = userWith(1);
    dropAttachments(image, 'not kept');
    expect((image.content as { text?: string }[])[0].text).toBe(IMAGE_NOT_KEPT);
  });

  it('counts PDFs toward the size limit, but not toward the image limit', () => {
    const big = 'A'.repeat(4000);
    const history: ChatMessage[] = [
      { role: 'user', content: [pdfBlock(big, 'old.pdf'), { type: 'text', text: 'a' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [pdfBlock(big, 'new.pdf'), { type: 'text', text: 'b' }] },
    ];
    expect(pruneAttachments(history, 20, 5000)).toBe(1);
    expect((history[0].content as { text?: string }[])[0].text).toBe('[PDF "old.pdf" removed to save context]');

    // Over the image count only: the old PDF stays, the old images go.
    const mixed: ChatMessage[] = [
      { role: 'user', content: [pdfBlock('JVBERi0x', 'keep.pdf'), ...(userWith(3).content as never[])] },
      { role: 'assistant', content: 'ok' },
      userWith(2),
    ];
    expect(pruneAttachments(mixed, 4)).toBe(1);
    expect((mixed[0].content as { type: string }[]).map((b) => b.type)).toEqual(['document', 'text', 'image', 'image', 'text']);
  });
});
