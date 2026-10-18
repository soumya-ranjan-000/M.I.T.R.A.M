import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeText, readAttachment } from '../src/agent/fileReaders';
import { MAX_FILE_TEXT_CHARS } from '../src/webview/protocol';
import { pngHeader } from './imageFixtures';

/** A ZIP archive, as Office and LibreOffice files are. `stored` names entries saved without compression. */
function zip(entries: Record<string, string>, stored: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const store = stored.includes(name);
    const data = store ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(store ? 0 : 8, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBytes, end]);
}

function read(name: string, bytes: Buffer) {
  const result = readAttachment(name, bytes);
  if (result.kind !== 'file') throw new Error(`expected a file, got ${JSON.stringify(result).slice(0, 200)}`);
  return result.file;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe('Word documents', () => {
  const docx = (body: string) => zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `<w:document ${W}><w:body>${body}</w:body></w:document>` });

  it('reads paragraphs, tabs, breaks and entities, and leaves out deleted text', () => {
    const file = read(
      'report.docx',
      docx(
        '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Q3 report</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t xml:space="preserve">Revenue </w:t></w:r><w:proofErr/><w:r><w:t>grew &amp; costs fell</w:t></w:r>' +
          '<w:del><w:r><w:delText>DRAFT</w:delText></w:r></w:del><w:r><w:tab/><w:t>12%</w:t><w:br/><w:t>next line</w:t></w:r></w:p>' +
          '<w:p/>',
      ),
    );
    expect(file.kind).toBe('text');
    expect(file.data).toBe('Q3 report\nRevenue grew & costs fell\t12%\nnext line');
    expect(file.detail).toBe('10 words');
  });

  it('reads tables as rows of cells', () => {
    const cell = (t: string) => `<w:tc><w:tcPr/><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const file = read('t.docx', docx(`<w:tbl><w:tr>${cell('Name')}${cell('Score')}</w:tr><w:tr>${cell('Ana')}${cell('9')}</w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p>`));
    expect(file.data).toBe('Name | Score\nAna | 9\nAfter');
  });
});

describe('Excel workbooks', () => {
  const rels = (items: [string, string][]) =>
    `<Relationships>${items.map(([id, target]) => `<Relationship Id="${id}" Type="x" Target="${target}"/>`).join('')}</Relationships>`;
  const xlsx = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; misc" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': rels([
      ['rId1', 'worksheets/sheet1.xml'],
      ['rId2', '/xl/worksheets/sheet2.xml'],
      ['rId3', 'sharedStrings.xml'],
      ['rId4', 'styles.xml'],
    ]),
    'xl/sharedStrings.xml': '<sst><si><t>Region</t></si><si><r><t>Total</t></r><r><t xml:space="preserve"> (USD)</t></r><rPh><t>X</t></rPh></si><si><t>North, East</t></si></sst>',
    'xl/styles.xml':
      '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
      '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164"/><xf numFmtId="20"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Day</t></is></c><c r="D1" t="inlineStr"><is><t>Time</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>SUM(X1:X9)</f><v>1234.5</v></c><c r="C2" s="1"><v>45292</v></c><c r="D2" s="3"><v>0.5</v></c></row>' +
      '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="C3" s="2"><v>45292.75</v></c><c r="E3" s="0"/></row>' +
      '<row r="4"/>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="str"><v>a &lt; b</v></c><c r="B1" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>',
  });

  it('turns each sheet into CSV, with shared strings, formulas’ values, booleans, gaps, dates and times', () => {
    const file = read('sales.xlsx', xlsx);
    expect(file.data).toBe(
      [
        '## Sheet: Sales',
        'Region,Total (USD),Day,Time',
        '"North, East",1234.5,2024-01-01,12:00:00',
        'TRUE,,2024-01-01 18:00',
        '',
        '## Sheet: Notes & misc',
        'a < b,#DIV/0!',
      ].join('\n'),
    );
    expect(file.detail).toBe('2 sheets · 4 rows');
  });
});

describe('PowerPoint presentations', () => {
  it('reads slides in presentation order, not file order', () => {
    const slide = (texts: string[]) => `<p:sld><p:cSld><p:spTree>${texts.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`;
    const pptx = zip({
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slide(['Thanks', 'Questions?']),
      'ppt/slides/slide2.xml': slide(['Roadmap 2025']),
    });
    const file = read('deck.pptx', pptx);
    expect(file.data).toBe('## Slide 1\nRoadmap 2025\n\n## Slide 2\nThanks\nQuestions?');
    expect(file.detail).toBe('2 slides');
  });
});

describe('OpenDocument (LibreOffice)', () => {
  const odf = (type: string, body: string) =>
    zip(
      {
        mimetype: `application/vnd.oasis.opendocument.${type}`,
        'content.xml': `<office:document-content><office:automatic-styles/><office:body>${body}</office:body></office:document-content>`,
      },
      ['mimetype'],
    );

  it('reads a text document', () => {
    const file = read(
      'notes.odt',
      odf(
        'text',
        '<office:text><text:sequence-decls><text:sequence-decl text:name="X"/></text:sequence-decls>' +
          '<text:h text:outline-level="1">Minutes</text:h><text:p>Ana<text:s text:c="3"/>said <text:span text:style-name="T1">yes</text:span>.<text:tab/>Done<text:line-break/>Next</text:p><text:p/></office:text>',
      ),
    );
    expect(file.data).toBe('Minutes\nAna   said yes.\tDone\nNext');
    expect(file.detail).toBe('6 words');
  });

  it('reads a spreadsheet, without expanding the huge repeats LibreOffice writes for empty rows', () => {
    const cell = (t: string, extra = '') => `<table:table-cell${extra} office:value-type="string"><text:p>${t}</text:p></table:table-cell>`;
    const file = read(
      'budget.ods',
      odf(
        'spreadsheet',
        '<office:spreadsheet><table:table table:name="Budget"><table:table-column table:number-columns-repeated="3"/>' +
          `<table:table-row>${cell('Item')}${cell('Cost')}</table:table-row>` +
          `<table:table-row>${cell('Rent, office')}<table:table-cell table:number-columns-repeated="2"/>${cell('1 200,00')}</table:table-row>` +
          '<table:table-row table:number-rows-repeated="1048574"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>' +
          '</table:table></office:spreadsheet>',
      ),
    );
    expect(file.data).toBe('## Sheet: Budget\nItem,Cost\n"Rent, office",,,"1 200,00"');
    expect(file.detail).toBe('1 sheet');
  });
});

describe('readAttachment', () => {
  it('sends a PDF as it is, with its page count', () => {
    const file = read('a.pdf', Buffer.from('%PDF-1.4\n<< /Type /Page >> << /Type /Page >>\n%%EOF', 'latin1'));
    expect(file.kind).toBe('pdf');
    expect(Buffer.from(file.data, 'base64').toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    expect(file.detail).toBe('2 pages');
  });

  it('hands images back to be resized, whatever their extension', () => {
    const result = readAttachment('screenshot.dat', pngHeader(10, 10));
    expect(result).toMatchObject({ kind: 'image', image: { name: 'screenshot.dat', mediaType: 'image/png' } });
  });

  it('reads text files in UTF-8, UTF-16 and Windows-1252', () => {
    expect(read('a.csv', Buffer.from('id,name\n1,Zoë\n')).data).toBe('id,name\n1,Zoë\n');
    expect(read('a.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé', 'utf16le')])).data).toBe('hé');
    expect(read('old.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9])).data).toBe('café');
    expect(read('a.md', Buffer.from('# T\n\nx')).detail).toBe('3 lines');
    expect(read('one', Buffer.from('A')).data).toBe('A');
  });

  it('shortens very long text and says so', () => {
    const file = read('big.log', Buffer.from('x'.repeat(MAX_FILE_TEXT_CHARS + 10)));
    expect(file.data.length).toBe(MAX_FILE_TEXT_CHARS);
    expect(file.truncated).toBe(true);
    expect(file.detail).toBe('1 line · shortened');
  });

  it('explains what it cannot read', () => {
    const reason = (name: string, bytes: Buffer) => {
      const r = readAttachment(name, bytes);
      return r.kind === 'error' ? r.reason : `not an error: ${r.kind}`;
    };
    expect(reason('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toMatch(/old Office format.*\.docx/);
    expect(reason('photos.zip', zip({ 'a.txt': 'x' }))).toMatch(/ZIP archive/);
    expect(reason('broken.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toMatch(/could not be read/);
    expect(reason('app.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1]))).toMatch(/not a file type/);
    expect(reason('empty.txt', Buffer.alloc(0))).toMatch(/no text/);
  });
});

describe('decodeText', () => {
  it('treats data with NUL bytes or many control characters as binary', () => {
    expect(decodeText(Buffer.from([0x41, 0x00, 0x42]))).toBeNull();
    expect(decodeText(Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 0x01 : 0x41))))).toBeNull();
    expect(decodeText(Buffer.from('plain\ttext\r\n'))).toBe('plain\ttext\r\n');
  });
});
