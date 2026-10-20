// Splits streamed markdown into blocks that stop changing once they are finished, so only the last
// block has to be parsed again as more text arrives. No dependencies, so tests can import it.

/** Below this, parsing the whole text is cheap and splitting would only risk the layout. */
export const CHUNK_MIN_CHARS = 2500;

const FENCE = /^\s{0,3}(```|~~~)/;
// A block that continues the one before it: indented text, or another list item.
const CONTINUES = /^(\s+\S|[-*+]\s|\d+[.)]\s)/;

/**
 * Splits at blank lines that are outside code fences. A piece that continues a list or an indented
 * block is joined to the one before it, so lists and nested content keep their structure. The pieces
 * always join back into the original text.
 */
export function splitMarkdown(text: string): string[] {
  if (text.length < CHUNK_MIN_CHARS) return [text];

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let blank = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join('\n'));
    current = [];
  };

  for (const line of lines) {
    const match = FENCE.exec(line);
    if (match) {
      if (fence === null) fence = match[1];
      else if (match[1] === fence) fence = null;
    }

    const isBlank = line.trim() === '';
    // The first non-blank line after blank ones decides whether a new block starts here.
    if (fence === null && !isBlank && blank > 0 && !CONTINUES.test(line)) {
      flush();
      blank = 0;
    }
    blank = isBlank ? blank + 1 : 0;
    current.push(line);
  }
  flush();

  // Rejoin with the newline that split() removed between pieces, so the text is preserved exactly.
  return chunks.map((chunk, i) => (i < chunks.length - 1 ? `${chunk}\n` : chunk));
}
