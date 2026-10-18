import { posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { FileAttachment, MAX_FILE_TEXT_CHARS, MAX_PDF_BYTES, RawImage } from '../webview/protocol';
import { pdfPageCount, sniffImageType } from './attachments';

/** What an attached file becomes: an image to resize, a file for the model, or a reason it can't be used. */
export type ReadResult = { kind: 'image'; image: RawImage } | { kind: 'file'; file: FileAttachment } | { kind: 'error'; reason: string };

// A ZIP entry may not inflate to more than this, so a crafted "zip bomb" can't exhaust memory.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
// Rows and slides past these are left out (the text is also capped at MAX_FILE_TEXT_CHARS).
const MAX_REPEAT = 1000;

const newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** Decides what an attached file is from its contents (never its extension) and reads it. */
export function readAttachment(name: string, bytes: Buffer): ReadResult {
  const image = sniffImageType(bytes);
  if (image) return { kind: 'image', image: { name, mediaType: image, data: bytes.toString('base64') } };

  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    if (bytes.length > MAX_PDF_BYTES) return { kind: 'error', reason: `${name} is larger than ${MAX_PDF_BYTES / 1_000_000} MB` };
    const pages = pdfPageCount(bytes);
    return file(name, 'pdf', bytes.toString('base64'), bytes.length, pages ? plural(pages, 'page') : 'PDF', false);
  }

  const magic = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
  if (magic === 0xd0cf11e0) {
    return { kind: 'error', reason: `${name} is an old Office format: save it as .docx, .xlsx or .pptx (or PDF) and attach that` };
  }

  if (magic === 0x504b0304) {
    try {
      const doc = readOfficeDocument(openZip(bytes));
      if (!doc) return { kind: 'error', reason: `${name} is a ZIP archive: attach the files inside it instead` };
      return textFile(name, doc.text, bytes.length, doc.detail);
    } catch {
      return { kind: 'error', reason: `${name} could not be read (damaged or unsupported)` };
    }
  }

  const text = decodeText(bytes);
  if (text === null) return { kind: 'error', reason: `${name} is not a file type M.I.T.R.A.M can read` };
  return textFile(name, text, bytes.length, plural(text.split('\n').length, 'line'));
}

function file(name: string, kind: FileAttachment['kind'], data: string, bytes: number, detail: string, truncated: boolean): ReadResult {
  return { kind: 'file', file: { id: newId(), name, kind, data, bytes, detail, truncated } };
}

function textFile(name: string, text: string, bytes: number, detail: string): ReadResult {
  if (!text.trim()) return { kind: 'error', reason: `${name} has no text in it` };
  const truncated = text.length > MAX_FILE_TEXT_CHARS;
  return file(name, 'text', truncated ? text.slice(0, MAX_FILE_TEXT_CHARS) : text, bytes, truncated ? `${detail} · shortened` : detail, truncated);
}

/** Text from bytes: UTF-8 or UTF-16 with a byte order mark, else Windows-1252; null if it looks binary. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const head = bytes.subarray(0, 8192);
  let control = 0;
  for (const b of head) {
    if (b === 0) return null;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control++;
  }
  if (control > head.length / 100) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ---------- ZIP ----------

type Zip = Map<string, () => Buffer>;

/** The entries of a ZIP archive (the container of .docx, .xlsx, .odt and friends), read on demand. */
export function openZip(buf: Buffer): Zip {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive');
  const entries: Zip = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged ZIP archive');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new Error(`unsupported compression in ${name}`);
    });
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

const entryText = (zip: Zip, name: string) => zip.get(name)?.().toString('utf8') ?? '';

// ---------- XML ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] !== '#') return ENTITIES[ref] ?? match;
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : undefined;
}

/** Relationship id to the full path of its target, from a part's .rels file. */
function relationships(zip: Zip, part: string): Map<string, string> {
  const relsPath = posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`);
  const map = new Map<string, string>();
  for (const [tag] of entryText(zip, relsPath).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    if (id && target) map.set(id, target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target)));
  }
  return map;
}

/** Tidies extracted text: no trailing spaces, at most one blank line in a row. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- Office documents ----------

function readOfficeDocument(zip: Zip): { text: string; detail: string } | null {
  if (zip.has('word/document.xml')) {
    const text = docxText(entryText(zip, 'word/document.xml'));
    return { text, detail: plural(text.split(/\s+/).filter(Boolean).length, 'word') };
  }
  if (zip.has('xl/workbook.xml')) return xlsxText(zip);
  if (zip.has('ppt/presentation.xml')) return pptxText(zip);
  const mimetype = entryText(zip, 'mimetype').trim();
  if (mimetype.startsWith('application/vnd.oasis.opendocument.') && zip.has('content.xml')) {
    return odfText(entryText(zip, 'content.xml'), mimetype.split('.').pop() ?? '');
  }
  return null;
}

/** Word: paragraphs as lines, table rows as "cell | cell". Deleted text and field codes are left out. */
export function docxText(xml: string): string {
  let out = '';
  let cellDepth = 0;
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<(\/?)w:(p|tc|tr)\b[^>]*?(\/?)>/g;
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (m[2]) out += m[2] === 'tab' ? '\t' : '\n';
    else {
      const [closing, tag, selfClosing] = [m[3] === '/', m[4], m[5] === '/'];
      if (tag === 'tc') {
        if (closing) {
          cellDepth--;
          out = `${out.trimEnd()} | `;
        } else if (!selfClosing) cellDepth++;
      } else if (tag === 'tr') {
        if (closing) out = `${out.replace(/ \| $/, '')}\n`;
      } else if (closing || selfClosing) out += cellDepth > 0 ? ' ' : '\n';
    }
  }
  return tidy(out);
}

/** Excel: each sheet as CSV under its name, with dates shown as dates. */
function xlsxText(zip: Zip): { text: string; detail: string } {
  const workbook = entryText(zip, 'xl/workbook.xml');
  const targets = relationships(zip, 'xl/workbook.xml');
  const sharedPath = [...targets.values()].find((t) => t.endsWith('sharedStrings.xml')) ?? 'xl/sharedStrings.xml';
  const stylesPath = [...targets.values()].find((t) => t.endsWith('styles.xml')) ?? 'xl/styles.xml';
  const shared = [...entryText(zip, sharedPath).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
  const dates = dateStyles(entryText(zip, stylesPath));
  const base = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook) ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);

  const sheets: string[] = [];
  let rows = 0;
  let chars = 0;
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const path = targets.get(attr(tag, 'r:id') ?? '');
    if (!path || !zip.has(path) || chars > MAX_FILE_TEXT_CHARS) continue;
    const lines: string[] = [];
    for (const row of entryText(zip, path).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      let next = 0;
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cell[1], 'r');
        const column = ref ? columnIndex(ref) : next;
        next = column + 1;
        cells[column] = csvField(cellValue(cell[1], cell[2] ?? '', shared, dates, base));
      }
      const line = Array.from(cells, (c) => c ?? '').join(',').replace(/,+$/, '');
      if (!line) continue;
      lines.push(line);
      chars += line.length + 1;
      if (chars > MAX_FILE_TEXT_CHARS) break;
    }
    rows += lines.length;
    sheets.push(`## Sheet: ${attr(tag, 'name') ?? path}\n${lines.join('\n')}`);
  }
  return { text: sheets.join('\n\n'), detail: `${plural(sheets.length, 'sheet')} · ${plural(rows, 'row')}` };
}

const runText = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function cellValue(attrs: string, inner: string, shared: string[], dates: Map<number, 'date' | 'time'>, base: number): string {
  const type = attr(attrs, 't');
  const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
  if (type === 'inlineStr') return runText(inner);
  if (v === undefined) return '';
  if (type === 's') return shared[Number(v)] ?? '';
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str' || type === 'e') return unescapeXml(v);
  const style = dates.get(Number(attr(attrs, 's') ?? -1));
  const serial = Number(v);
  if (!style || !Number.isFinite(serial)) return v;
  const iso = new Date(base + Math.round(serial * 86_400_000)).toISOString();
  if (style === 'time') return iso.slice(11, 19);
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Which cell styles format numbers as dates or times. */
function dateStyles(styles: string): Map<number, 'date' | 'time'> {
  const formats = new Map<number, string>();
  for (const [tag] of styles.matchAll(/<numFmt\b[^>]*>/g)) formats.set(Number(attr(tag, 'numFmtId')), attr(tag, 'formatCode') ?? '');
  const kind = (id: number): 'date' | 'time' | null => {
    if ((id >= 14 && id <= 17) || id === 22) return 'date';
    if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return 'time';
    const code = (formats.get(id) ?? '').replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
    if (/[dy]/i.test(code)) return 'date';
    return /[hs]/i.test(code) ? 'time' : null;
  };
  const result = new Map<number, 'date' | 'time'>();
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach(([tag], i) => {
    const k = kind(Number(attr(tag, 'numFmtId') ?? 0));
    if (k) result.set(i, k);
  });
  return result;
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** PowerPoint: the text of each slide, in presentation order. */
function pptxText(zip: Zip): { text: string; detail: string } {
  const targets = relationships(zip, 'ppt/presentation.xml');
  const order = [...entryText(zip, 'ppt/presentation.xml').matchAll(/<p:sldId\b[^>]*>/g)].map(([tag]) => targets.get(attr(tag, 'r:id') ?? ''));
  const slides = order.filter((p): p is string => !!p && zip.has(p)).slice(0, MAX_REPEAT);
  const text = slides
    .map((path, i) => {
      let out = '';
      for (const m of entryText(zip, path).matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>/g)) {
        out += m[1] !== undefined ? unescapeXml(m[1]) : '\n';
      }
      return `## Slide ${i + 1}\n${tidy(out)}`;
    })
    .join('\n\n');
  return { text, detail: plural(slides.length, 'slide') };
}

/** OpenDocument (LibreOffice): text and presentations as paragraphs, spreadsheets as CSV. */
export function odfText(xml: string, type: string): { text: string; detail: string } {
  const body = /<office:body>([\s\S]*)<\/office:body>/.exec(xml)?.[1] ?? xml;
  const re = /<(\/?)([\w.-]+:[\w.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let out = '';
  let paragraph = 0;
  let pages = 0;
  const sheets: string[] = [];
  let rows: string[] = [];
  let cells: string[] = [];
  let cell: string | null = null;
  let rowRepeat = 1;
  let cellRepeat = 1;
  let inSheet = false;
  let rowChars = 0;
  for (const m of body.matchAll(re)) {
    const [, closing, tag, attrs, selfClosing, text] = m;
    if (text !== undefined) {
      if (paragraph > 0) {
        if (cell !== null) cell += unescapeXml(text);
        else out += unescapeXml(text);
      }
      continue;
    }
    const add = (s: string) => (cell !== null ? (cell += s) : (out += s));
    switch (tag) {
      case 'text:p':
      case 'text:h':
        if (selfClosing) add(cell !== null ? '' : '\n');
        else if (closing) {
          paragraph--;
          add(cell !== null ? ' ' : '\n');
        } else paragraph++;
        break;
      case 'text:s':
        add(' '.repeat(Math.min(Number(attr(attrs, 'text:c') ?? 1), 100)));
        break;
      case 'text:tab':
        add('\t');
        break;
      case 'text:line-break':
        add('\n');
        break;
      case 'draw:page':
        if (!closing) out += `\n## Slide ${++pages}\n`;
        break;
      case 'table:table':
        if (type !== 'spreadsheet') break;
        if (!closing) {
          rows = [`## Sheet: ${attr(attrs, 'table:name') ?? sheets.length + 1}`];
          inSheet = true;
        } else {
          sheets.push(rows.join('\n'));
          inSheet = false;
        }
        break;
      case 'table:table-row':
        if (type !== 'spreadsheet') break;
        if (!closing) {
          cells = [];
          rowRepeat = Math.min(Number(attr(attrs, 'table:number-rows-repeated') ?? 1), MAX_REPEAT);
        }
        if (closing || selfClosing) {
          const line = cells.join(',').replace(/,+$/, '');
          if (line) {
            for (let i = 0; i < rowRepeat; i++) rows.push(line);
            rowChars += (line.length + 1) * rowRepeat;
          }
        }
        break;
      case 'table:table-cell':
      case 'table:covered-table-cell':
        if (type !== 'spreadsheet') break;
        if (!closing) {
          cell = '';
          cellRepeat = Math.min(Number(attr(attrs, 'table:number-columns-repeated') ?? 1), MAX_REPEAT);
        }
        if (closing || selfClosing) {
          const value = csvField((cell ?? '').trim());
          for (let i = 0; i < cellRepeat; i++) cells.push(value);
          cell = null;
        }
        break;
    }
    if (out.length > MAX_FILE_TEXT_CHARS || rowChars > MAX_FILE_TEXT_CHARS) break;
  }
  if (inSheet) sheets.push(rows.join('\n'));
  if (type === 'spreadsheet') {
    return { text: sheets.join('\n\n'), detail: plural(sheets.length, 'sheet') };
  }
  const text = tidy(out);
  return { text, detail: pages ? plural(pages, 'slide') : plural(text.split(/\s+/).filter(Boolean).length, 'word') };
}
