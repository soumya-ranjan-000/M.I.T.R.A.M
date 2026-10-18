import { useEffect, useState } from 'react';
import { Icon } from './Icon';

/** The model's reasoning summary. Open while it is streaming, then folds itself away. */
export function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  return (
    <div className={`thinking${live ? ' live' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`chevron${open ? ' open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
        <Icon name="sparkle" size={13} />
        <span>{live ? 'Thinking…' : 'Reasoning'}</span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}
