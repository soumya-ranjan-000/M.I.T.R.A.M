import { useEffect, useState } from 'react';
import { formatElapsed } from '../../../src/webview/activity';
import type { TaskView } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { TaskStatus } from './Header';

const RUNNING = new Set<TaskView['status']>(['working', 'waiting', 'queued']);

/** Other chats the agent is working on, or finished while you were away: click one to open it. */
export function TaskList({ tasks }: { tasks: TaskView[] }) {
  const [now, setNow] = useState(() => Date.now());
  const running = tasks.some((t) => RUNNING.has(t.status));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (tasks.length === 0) return null;
  return (
    <section className="bg-tasks" aria-label="Other chats">
      <div className="bg-tasks-title">Other chats</div>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <button className={`bg-task ${t.status}`} onClick={() => postToHost({ type: 'switchSession', id: t.id })} title={`Open "${t.title}"`}>
              <TaskStatus status={t.status} />
              <span className="bg-task-text">
                <span className="bg-task-title">{t.title}</span>
                <span className="bg-task-label">{t.label}</span>
              </span>
              {RUNNING.has(t.status) && t.since > 0 && <span className="bg-task-time">{formatElapsed(now - t.since)}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
