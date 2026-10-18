import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { Icon } from './Icon';

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
}

export function Header({ sessions, activeId }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const historyBtn = useRef<HTMLButtonElement>(null);
  const title = sessions.find((s) => s.id === activeId)?.title ?? 'New chat';

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        historyBtn.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // Move focus into the menu so it can be used from the keyboard.
    rootRef.current?.querySelector<HTMLButtonElement>('.history-menu button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function moveFocus(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return (
    <div className="header" ref={rootRef}>
      <span className="header-title" title={title}>
        {title}
      </span>
      <button
        ref={historyBtn}
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        title="Chat history"
        aria-label="Chat history"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="history" size={16} />
      </button>
      <button className="icon-btn" onClick={() => postToHost({ type: 'newChat' })} title="New chat (/new)" aria-label="New chat">
        <Icon name="plus" size={16} />
      </button>
      <button
        className="icon-btn"
        disabled={activeId === null}
        onClick={() => activeId && postToHost({ type: 'deleteSession', id: activeId })}
        title="Delete this chat"
        aria-label="Delete this chat"
      >
        <Icon name="trash" size={16} />
      </button>
      <button className="icon-btn" onClick={() => postToHost({ type: 'openSettings' })} title="Settings" aria-label="Settings">
        <Icon name="settings" size={16} />
      </button>

      {open && (
        <ul className="history-menu" role="menu" aria-label="Saved chats" onKeyDown={moveFocus}>
          {sessions.length === 0 && <li className="history-empty">No saved chats yet</li>}
          {sessions.map((s) => (
            <li key={s.id} role="none">
              <button
                role="menuitem"
                className={s.id === activeId ? 'active' : ''}
                aria-current={s.id === activeId ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  historyBtn.current?.focus();
                  if (s.id !== activeId) postToHost({ type: 'switchSession', id: s.id });
                }}
              >
                <span className="history-item-title">{s.title}</span>
                <span className="history-item-time">{formatTime(s.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
