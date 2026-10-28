import { useEffect, useRef, useState } from 'react';
import type { SessionSummary, TaskView } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { Icon } from './Icon';

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  /** Other chats working, or finished, out of sight. */
  tasks: TaskView[];
  /** Opens the MCP servers panel. */
  onOpenMcp: () => void;
  /** How many MCP servers are connected, shown as a badge on the button. */
  mcpConnected?: number;
}

const ACTIVE = new Set<TaskView['status']>(['working', 'waiting', 'queued']);

export function Header({ sessions, activeId, tasks, onOpenMcp, mcpConnected = 0 }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const historyBtn = useRef<HTMLButtonElement>(null);
  const title = sessions.find((s) => s.id === activeId)?.title ?? 'New chat';
  const taskOf = new Map(tasks.map((t) => [t.id, t]));
  const working = tasks.filter((t) => ACTIVE.has(t.status)).length;
  const waiting = tasks.some((t) => t.status === 'waiting');
  // Chats at work come first in the history menu.
  const ordered = [...sessions].sort((a, b) => Number(taskOf.has(b.id) && ACTIVE.has(taskOf.get(b.id)!.status)) - Number(taskOf.has(a.id) && ACTIVE.has(taskOf.get(a.id)!.status)));

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
        className={`icon-btn ${working > 0 ? 'has-badge' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={working > 0 ? `Chat history (${working} other chat${working === 1 ? '' : 's'} working${waiting ? ', one needs your approval' : ''})` : 'Chat history'}
        aria-label={working > 0 ? `Chat history, ${working} other chat${working === 1 ? '' : 's'} working` : 'Chat history'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="history" size={16} />
        {working > 0 && <span className={`icon-badge${waiting ? ' warn' : ''}`}>{working}</span>}
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
      <button
        className={`icon-btn ${mcpConnected > 0 ? 'has-badge' : ''}`}
        onClick={onOpenMcp}
        title={mcpConnected > 0 ? `MCP servers (${mcpConnected} connected)` : 'MCP servers (/mcp)'}
        aria-label="MCP servers"
      >
        <Icon name="plug" size={16} />
        {mcpConnected > 0 && <span className="icon-badge">{mcpConnected}</span>}
      </button>
      <button className="icon-btn" onClick={() => postToHost({ type: 'openSettings' })} title="Settings" aria-label="Settings">
        <Icon name="settings" size={16} />
      </button>

      {open && (
        <ul className="history-menu" role="menu" aria-label="Saved chats" onKeyDown={moveFocus}>
          {sessions.length === 0 && <li className="history-empty">No saved chats yet</li>}
          {ordered.map((s) => (
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
                {taskOf.has(s.id) && <TaskStatus status={taskOf.get(s.id)!.status} />}
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

/** A small sign of what another chat is doing: working, waiting for you, or how it ended. */
export function TaskStatus({ status }: { status: TaskView['status'] }) {
  const label = STATUS_LABEL[status];
  if (status === 'working') return <span className="spinner" role="img" aria-label={label} title={label} />;
  const icon = status === 'done' ? 'check' : status === 'error' || status === 'waiting' ? 'alert' : 'history';
  return (
    <span className={`bg-task-status ${status}`} role="img" aria-label={label} title={label}>
      <Icon name={icon} size={13} />
    </span>
  );
}

const STATUS_LABEL: Record<TaskView['status'], string> = {
  working: 'Working',
  waiting: 'Needs your approval',
  queued: 'Waiting for another chat to finish',
  done: 'Finished',
  paused: 'Paused',
  error: 'Failed',
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
