import { describe, expect, it } from 'vitest';
import { CHUNK_MIN_CHARS, splitMarkdown } from '../webview-ui/src/markdownChunks';

const filler = (n: number) => `${'word '.repeat(Math.ceil(n / 5))}`.trim();
const pad = `${filler(CHUNK_MIN_CHARS)}\n\n`;

describe('splitMarkdown', () => {
  it('leaves short text whole', () => {
    expect(splitMarkdown('# Hi\n\nthere')).toEqual(['# Hi\n\nthere']);
  });

  it('joins back into exactly the original text', () => {
    const text = `${pad}Second paragraph.\n\n- a\n- b\n\n\`\`\`ts\nlet x = 1;\n\nlet y = 2;\n\`\`\`\n\nLast.`;
    expect(splitMarkdown(text).join('')).toBe(text);
  });

  it('splits long text at blank lines between paragraphs', () => {
    const chunks = splitMarkdown(`${pad}Second.\n\nThird.`);
    expect(chunks.length).toBe(3);
    expect(chunks[1]).toContain('Second.');
  });

  it('never splits inside a code fence, even at a blank line', () => {
    const chunks = splitMarkdown(`${pad}\`\`\`py\na = 1\n\nb = 2\n\`\`\`\n\nAfter.`);
    const code = chunks.find((c) => c.includes('a = 1'))!;
    expect(code).toContain('b = 2');
    expect(code).toContain('```\n');
  });

  it('keeps an unterminated fence (still streaming) in one block', () => {
    const chunks = splitMarkdown(`${pad}\`\`\`py\na = 1\n\nb = 2`);
    expect(chunks[chunks.length - 1]).toContain('b = 2');
    expect(chunks[chunks.length - 1]).toContain('a = 1');
  });

  it('keeps a list with blank lines between items together', () => {
    const chunks = splitMarkdown(`${pad}1. one\n\n2. two\n\n3. three\n\nAfter.`);
    const list = chunks.find((c) => c.includes('1. one'))!;
    expect(list).toContain('3. three');
  });

  it('keeps indented continuation text with its list item', () => {
    const chunks = splitMarkdown(`${pad}- item\n\n    more about the item\n\nAfter.`);
    expect(chunks.find((c) => c.includes('- item'))).toContain('more about the item');
  });

  it('does not change the earlier blocks when text is appended', () => {
    const base = `${pad}Second.\n\nThird`;
    const before = splitMarkdown(base);
    const after = splitMarkdown(`${base} paragraph keeps growing`);
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
  });
});
