import { useEffect, useState } from 'react';
import { boardProgress } from '../../../src/agent/board';
import type { Board, BoardStatus } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { Icon } from './Icon';

const STATUS_LABEL: Record<BoardStatus, string> = {
  pending: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
};

function TaskIcon({ status, busy }: { status: BoardStatus; busy: boolean }) {
  const label = STATUS_LABEL[status];
  if (status === 'done') {
    return (
      <span className="task-icon done" role="img" aria-label={label}>
        <Icon name="check" size={10} />
      </span>
    );
  }
  if (status === 'blocked') {
    return (
      <span className="task-icon blocked" role="img" aria-label={label}>
        <Icon name="alert" size={11} />
      </span>
    );
  }
  if (status === 'in_progress') {
    return busy ? <span className="spinner small" role="img" aria-label={label} /> : <span className="task-icon progress" role="img" aria-label={label} />;
  }
  return <span className="task-icon pending" role="img" aria-label={label} />;
}

/** The agent's plan: what is done, what is under way, and what is left. */
export function BoardPanel({ board, busy }: { board: Board; busy: boolean }) {
  const { total, done, unfinished } = boardProgress(board);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  // A fresh plan starts open again.
  useEffect(() => {
    if (total === 0) setUserOpen(null);
  }, [total]);

  if (total === 0 && !board.notes) return null;

  // Open while there is work left; folds away when everything is finished.
  const open = userOpen ?? unfinished.length > 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <section className="board" aria-label="Plan">
      <div className="board-head">
        <button className="board-toggle" onClick={() => setUserOpen(!open)} aria-expanded={open}>
          <span className={`chevron${open ? ' open' : ''}`}>
            <Icon name="chevron" size={12} />
          </span>
          <Icon name="plan" size={14} />
          <span className="board-title">Plan</span>
          {total > 0 && (
            <>
              <span className="board-count">
                {done}/{total}
              </span>
              <span className="board-track" aria-hidden="true">
                <span className="board-fill" style={{ width: `${pct}%` }} />
              </span>
            </>
          )}
        </button>
        <button className="icon-btn small" onClick={() => postToHost({ type: 'clearBoard' })} title="Clear the plan" aria-label="Clear the plan">
          <Icon name="x" size={12} />
        </button>
      </div>

      {open && total > 0 && (
        <ul className="board-list">
          {board.tasks.map((t, i) => (
            <li key={i} className={t.status}>
              <TaskIcon status={t.status} busy={busy} />
              <span className="task-text">
                <span className="task-title">{t.title}</span>
                {t.note && <span className="task-note">{t.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && board.notes && (
        <details className="board-notes">
          <summary>Notes</summary>
          <pre>{board.notes}</pre>
        </details>
      )}
    </section>
  );
}
