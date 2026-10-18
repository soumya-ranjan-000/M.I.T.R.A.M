import type { FileAttachment, ImageAttachment } from '../../../src/webview/protocol';
import { Icon } from './Icon';

const src = (image: ImageAttachment) => `data:${image.mediaType};base64,${image.data}`;
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const describe = (image: ImageAttachment) => `${image.name} · ${image.width}×${image.height} · ${size(image.bytes)}`;

/** An image waiting to be sent, in the composer. */
export function ImageChip({ image, onRemove }: { image: ImageAttachment; onRemove: () => void }) {
  return (
    <span className="image-chip" title={describe(image)}>
      <img className="attachment-thumb" src={src(image)} alt="" />
      <span className="image-chip-text">
        <span className="image-chip-name">{image.name}</span>
        <span className="image-chip-meta">
          {image.width}×{image.height} · {size(image.bytes)}
        </span>
      </span>
      <button className="icon-btn small" onClick={onRemove} title={`Remove ${image.name}`} aria-label={`Remove ${image.name}`}>
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

const extension = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? 'file').toUpperCase();

/** A PDF, document, spreadsheet or text file: waiting to be sent (with a remove button) or sent. */
export function FileChip({ file, onRemove }: { file: FileAttachment; onRemove?: () => void }) {
  const how = file.kind === 'pdf' ? 'sent as a PDF' : 'sent as the text read from it';
  return (
    <span className="file-chip" title={`${file.name} · ${file.detail} · ${size(file.bytes)} · ${how}`}>
      <span className="file-badge">{extension(file.name)}</span>
      <span className="image-chip-text">
        <span className="image-chip-name">{file.name}</span>
        <span className="image-chip-meta">
          {file.detail} · {size(file.bytes)}
        </span>
      </span>
      {onRemove && (
        <button className="icon-btn small" onClick={onRemove} title={`Remove ${file.name}`} aria-label={`Remove ${file.name}`}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

/** The files of a sent message, in the transcript. */
export function FileStrip({ files }: { files: FileAttachment[] }) {
  return (
    <span className="bubble-files">
      {files.map((file) => (
        <FileChip key={file.id} file={file} />
      ))}
    </span>
  );
}

/** The images of a sent message, in the transcript. */
export function ImageStrip({ images }: { images: ImageAttachment[] }) {
  return (
    <span className="bubble-images">
      {images.map((image) =>
        image.data ? (
          <img key={image.id} className="bubble-thumb" src={src(image)} alt={image.name} title={describe(image)} />
        ) : (
          <span key={image.id} className="image-gone" title={`${image.name} was not kept when the chat was saved.`}>
            <Icon name="image" size={12} /> image (not kept)
          </span>
        ),
      )}
    </span>
  );
}
