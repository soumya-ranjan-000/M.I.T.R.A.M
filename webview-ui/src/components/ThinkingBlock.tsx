import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatElapsed } from '../../../src/webview/activity';
import { Icon } from './Icon';

interface Props {
  text: string;
  live: boolean;
  /** When the reasoning started and last grew, if the host timed it. */
  startedAt?: number;
  endedAt?: number;
}

/** The model's reasoning summary. Open while it is streaming, then folds itself away. */
export const ThinkingBlock = memo(function ThinkingBlock({ text, live, startedAt, endedAt }: Props) {
  const [open, setOpen] = useState(live);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);
  // Keep the newest reasoning in view while it streams.
  useLayoutEffect(() => {
    if (live && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [live, text]);

  const took = startedAt && endedAt ? `Thought for ${formatElapsed(Math.max(1000, endedAt - startedAt))}` : 'Reasoning';
  return (
    <div className={`thinking${live ? ' live' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`chevron${open ? ' open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
        <Icon name="sparkle" size={13} />
        <span>{live ? 'Thinking…' : took}</span>
      </button>
      {open && (
        <div className="thinking-body" ref={body}>
          {text}
        </div>
      )}
    </div>
  );
});
