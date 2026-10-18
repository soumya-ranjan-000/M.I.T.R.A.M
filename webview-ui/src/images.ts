import { ImageAttachment, MAX_IMAGE_BYTES, RawImage } from '../../src/webview/protocol';

// Current Claude models read images up to 2576 px on the long edge and 3.75 megapixels. The API
// scales larger ones down anyway, so do it here and send less.
const MAX_EDGE = 2576;
const MAX_PIXELS = 3_750_000;

export interface ImageSource {
  blob: Blob;
  name: string;
}

/**
 * The files in a paste or drop: images (resized here) and anything else (read by the host). For a
 * paste that also carries text, such as cells copied from a spreadsheet (which come with a picture
 * of themselves), the text wins and nothing is returned.
 */
export function transferFiles(data: DataTransfer, preferText: boolean): { images: ImageSource[]; others: File[] } {
  if (preferText && data.getData('text/plain').trim()) return { images: [], others: [] };
  const files = Array.from(data.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  // SVG is text the model can read, not a picture the browser can resize.
  const isImage = (f: File) => f.type.startsWith('image/') && f.type !== 'image/svg+xml';
  return {
    images: files.filter(isImage).map((f) => ({ blob: f, name: f.name || 'pasted image' })),
    others: files.filter((f) => !isImage(f)),
  };
}

/** file:// URIs, which is all some file managers put on the clipboard. */
export function fileUris(data: DataTransfer): string[] {
  return data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^file:/i.test(line));
}

export function rawToSource(raw: RawImage): ImageSource {
  const binary = atob(raw.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { blob: new Blob([bytes], { type: raw.mediaType }), name: raw.name };
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), type, quality),
  );
}

export function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Decodes an image, scales it to what the model can use, and re-encodes it as PNG (JPEG if the
 * PNG is still too big). Re-encoding also drops metadata such as a photo's location.
 */
export async function toAttachment({ blob, name }: ImageSource): Promise<ImageAttachment> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error(`Couldn't read ${name} as an image.`);
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`Couldn't process ${name}.`);
    ctx.drawImage(bitmap, 0, 0, width, height);

    let out = await encode(canvas, 'image/png');
    if (out.size > MAX_IMAGE_BYTES) {
      // JPEG has no transparency: put white behind the picture first.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      out = await encode(canvas, 'image/jpeg', 0.85);
    }
    if (out.size > MAX_IMAGE_BYTES) throw new Error(`${name} is too large, even after resizing.`);
    return {
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      mediaType: out.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      data: await toBase64(out),
      name,
      width,
      height,
      bytes: out.size,
    };
  } finally {
    bitmap.close();
  }
}
