import type { Ref } from 'react';
import { Icon } from './Icon';

interface Props {
  text: string;
  images: number;
  files: number;
  onJump: () => void;
  barRef?: Ref<HTMLButtonElement>;
}

/** The user's request for what is on screen, pinned over the top of the conversation. */
export function PinnedRequest({ text, images, files, onJump, barRef }: Props) {
  const oneLine = text.replace(/\s+/g, ' ').trim() || (files ? 'Attached files' : images === 1 ? 'Image' : 'Images');
  return (
    <button
      ref={barRef}
      className="pinned-request"
      onClick={onJump}
      title="Show your whole message"
      aria-label={`Your request: ${oneLine}. Show the whole message.`}
    >
      <span className="pinned-head">
        <Icon name="user" size={12} />
        <span className="pinned-label">Your request</span>
        {images > 0 && (
          <span className="pinned-badge" title={`${images} image${images === 1 ? '' : 's'}`}>
            <Icon name="image" size={12} />
            {images}
          </span>
        )}
        {files > 0 && (
          <span className="pinned-badge" title={`${files} file${files === 1 ? '' : 's'}`}>
            <Icon name="file" size={12} />
            {files}
          </span>
        )}
        <span className="pinned-jump">
          <Icon name="send" size={12} />
        </span>
      </span>
      <span className="pinned-text">{oneLine}</span>
    </button>
  );
}
