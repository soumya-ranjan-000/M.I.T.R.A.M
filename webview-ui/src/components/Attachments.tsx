import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileAttachment, ImageAttachment } from '../../../src/webview/protocol';
import { Icon } from './Icon';

const src = (image: ImageAttachment) => `data:${image.mediaType};base64,${image.data}`;
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const describe = (image: ImageAttachment) => `${image.name} · ${image.width}×${image.height} · ${size(image.bytes)}`;

/** Largest side of the hover preview, in CSS pixels. */
const PREVIEW_MAX = 320;
const GAP = 8;
/** Room for the caption under the image. */
const CAPTION = 22;

interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Fits the image inside the window next to the thumbnail: above it if there is room, otherwise below. */
function place(image: ImageAttachment, anchor: DOMRect): Placement {
  const maxW = Math.min(PREVIEW_MAX, window.innerWidth - 2 * GAP);
  const maxH = Math.min(PREVIEW_MAX, Math.max(anchor.top, window.innerHeight - anchor.bottom) - 2 * GAP - CAPTION);
  const scale = Math.min(1, maxW / Math.max(1, image.width), Math.max(40, maxH) / Math.max(1, image.height));
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const above = anchor.top - GAP - height - CAPTION >= GAP;
  const top = above ? anchor.top - GAP - height - CAPTION : anchor.bottom + GAP;
  const left = Math.min(Math.max(GAP, anchor.left), window.innerWidth - GAP - width);
  return { left, top, width, height };
}

/** An image thumbnail that shows the image larger while it is hovered or focused. */
function PreviewThumb({ image, className }: { image: ImageAttachment; className: string }) {
  const [at, setAt] = useState<Placement | null>(null);
  const show = (e: React.SyntheticEvent<HTMLImageElement>) => setAt(place(image, e.currentTarget.getBoundingClientRect()));
  const hide = () => setAt(null);
  // The preview is pinned to the window, so it would drift away from a thumbnail that scrolls.
  useEffect(() => {
    if (!at) return;
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [at]);
  return (
    <>
      <img
        className={className}
        src={src(image)}
        alt={image.name}
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && at) {
            e.preventDefault();
            hide();
          }
        }}
      />
      {at &&
        createPortal(
          <div className="image-preview" style={{ left: at.left, top: at.top }} role="tooltip">
            <img src={src(image)} alt="" width={at.width} height={at.height} />
            <div className="image-preview-caption" style={{ maxWidth: Math.max(at.width, 120) }}>
              {describe(image)}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** An image waiting to be sent, in the composer. */
export function ImageChip({ image, onRemove }: { image: ImageAttachment; onRemove: () => void }) {
  return (
    <span className="image-chip">
      <PreviewThumb image={image} className="attachment-thumb" />
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
          <PreviewThumb key={image.id} image={image} className="bubble-thumb" />
        ) : (
          <span key={image.id} className="image-gone" title={`${image.name} was not kept when the chat was saved.`}>
            <Icon name="image" size={12} /> image (not kept)
          </span>
        ),
      )}
    </span>
  );
}
