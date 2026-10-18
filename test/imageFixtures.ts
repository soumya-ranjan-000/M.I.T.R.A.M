// Tiny image headers for tests: enough for type sniffing and dimension parsing.

/** The start of a PNG file: signature and IHDR chunk. */
export function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A base64 image whose header says width×height, padded to look like a big file. */
export function fakeImage(width: number, height: number, padBytes = 0): string {
  return Buffer.concat([pngHeader(width, height), Buffer.alloc(padBytes)]).toString('base64');
}
