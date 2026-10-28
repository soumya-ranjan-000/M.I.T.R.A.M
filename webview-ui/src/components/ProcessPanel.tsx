import { useEffect, useState } from 'react';
import { formatElapsed } from '../../../src/webview/activity';
import type { ProcessAction, ProcessView } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { Icon } from './Icon';
import { LiveLog, lastLines } from './LiveLog';

interface Props {
  processes: ProcessView[];
  /** The process shown, or null while the panel is closed. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Output of the selected process, as streamed by the host. */
  log: string;
  /** Sends a message to the agent asking about a process. */
  onAsk: (process: ProcessView) => void;
}

function statusText(p: ProcessView, now: number): string {
  if (p.status === 'running') return `running · ${formatElapsed(now - p.startedAt)}`;
  if (p.status === 'stopped') return 'stopped';
  return `exited ${p.exitCode ?? '?'}`;
}

const act = (id: string, action: ProcessAction) => postToHost({ type: 'processAction', id, action });

/**
 * Commands the agent left running (dev servers, watchers): a chip above the composer that opens a
 * panel with each one's live output and buttons to stop, restart or open it in a terminal.
 */
export function ProcessPanel({ processes, selected, onSelect, log, onAsk }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const running = processes.filter((p) => p.status === 'running');
  useEffect(() => {
    if (!running.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running.length]);

  // Stream the shown process's output, and stop when the panel closes.
  useEffect(() => {
    postToHost({ type: 'watchProcess', id: selected ?? undefined });
  }, [selected]);
  // The shown process was removed: close.
  useEffect(() => {
    if (selected && !processes.some((p) => p.id === selected)) onSelect(null);
  }, [processes, selected, onSelect]);

  if (processes.length === 0) return null;
  const ended = processes.length - running.length;
  const current = processes.find((p) => p.id === selected);
  const label = [running.length ? `${running.length} running` : '', ended ? `${ended} ended` : ''].filter(Boolean).join(' · ');

  return (
    <section className="procs" aria-label="Background processes">
      <button
        className={`procs-chip${running.length ? ' live' : ''}`}
        onClick={() => onSelect(current ? null : (running[running.length - 1] ?? processes[processes.length - 1]).id)}
        aria-expanded={!!current}
        title={current ? 'Hide background processes' : 'Show background processes'}
      >
        <Icon name="terminal" size={13} />
        <span>{label}</span>
        <span className={`chevron${current ? ' open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
      </button>

      {current && (
        <div className="procs-panel">
          <ul className="procs-list" role="listbox" aria-label="Processes">
            {processes.map((p) => (
              <li key={p.id} role="option" aria-selected={p.id === current.id}>
                <button className={`procs-item ${p.status}${p.id === current.id ? ' selected' : ''}`} onClick={() => onSelect(p.id)} title={p.command}>
                  {p.status === 'running' ? <span className="spinner" aria-hidden="true" /> : <span className={`procs-dot ${p.status}${p.status === 'exited' && p.exitCode !== 0 ? ' failed' : ''}`} aria-hidden="true" />}
                  <span className="procs-item-text">
                    <span className="procs-command">{p.command}</span>
                    <span className="procs-meta">
                      {p.id} · {statusText(p, now)}
                      {!p.mine && ` · ${p.chat}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="procs-actions">
            {current.status === 'running' ? (
              <button onClick={() => act(current.id, 'stop')} title="Stop it and everything it started">
                <Icon name="stop" size={12} /> Stop
              </button>
            ) : (
              <button onClick={() => act(current.id, 'remove')} title="Remove it from this list">
                <Icon name="x" size={12} /> Remove
              </button>
            )}
            <button onClick={() => act(current.id, 'restart')} title="Run the same command again">
              <Icon name="retry" size={12} /> Restart
            </button>
            <button onClick={() => act(current.id, 'terminal')} title="Show it in a VS Code terminal, where you can also type to it">
              <Icon name="terminal" size={12} /> Open in terminal
            </button>
            <button onClick={() => postToHost({ type: 'copyCode', code: lastLines(log, Infinity) })} title="Copy its output">
              <Icon name="copy" size={12} /> Copy
            </button>
            <button onClick={() => onAsk(current)} title="Ask the agent to read its output and tell you what is wrong">
              <Icon name="sparkle" size={12} /> Ask the agent
            </button>
          </div>
          {log ? <LiveLog text={log} className="procs-log" label={`Output of ${current.command}`} /> : <p className="procs-empty">No output yet.</p>}
        </div>
      )}
    </section>
  );
}
