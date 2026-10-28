import { useLayoutEffect, useRef } from 'react';

// Colour and cursor codes: a log shown as text has no use for them.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** The last `count` lines as they look on a terminal: a carriage return redraws its line in place. */
export function lastLines(text: string, count: number): string {
  const lines = text
    .replace(ANSI, '')
    .trimEnd()
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r', line.length - 2) + 1).replace(/\r$/, ''));
  return lines.slice(-count).join('\n');
}

/** Lines drawn in a live log. Older ones scroll out. */
const LIVE_LINES = 2000;

/** Output that is still coming, following the newest line unless the user has scrolled up to read. */
export function LiveLog({ text, className = '', label = 'Command output' }: { text: string; className?: string; label?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={ref}
      className={`toolcard-body live ${className}`}
      tabIndex={0}
      aria-label={label}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lastLines(text, LIVE_LINES)}
    </pre>
  );
}
