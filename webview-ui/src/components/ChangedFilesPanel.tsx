import { useState } from 'react';
import type { ChangedFileView } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { Icon } from './Icon';

const KIND: Record<ChangedFileView['kind'], { letter: string; label: string }> = {
  created: { letter: 'A', label: 'Created' },
  modified: { letter: 'M', label: 'Modified' },
  deleted: { letter: 'D', label: 'Deleted' },
};

function Counts({ added, removed }: { added?: number; removed?: number }) {
  if (added === undefined && removed === undefined) return null;
  return (
    <span className="changes-counts">
      {!!added && <span className="added">+{added}</span>}
      {!!removed && <span className="removed">−{removed}</span>}
    </span>
  );
}

/** Holds a missing button's place, so the line counts stay in one column. */
const Spacer = () => (
  <span className="icon-btn small changes-spacer" aria-hidden="true">
    <Icon name="file" size={13} />
  </span>
);

interface Props {
  files: ChangedFileView[];
  /** Files the last turn changed, which "Undo last turn" restores. */
  turnFiles: string[];
  busy: boolean;
}

/** Every file this chat changed, compared with before the chat, each one a diff away. */
export function ChangedFilesPanel({ files, turnFiles, busy }: Props) {
  const [open, setOpen] = useState(true);
  if (files.length === 0) return null;

  const total = (key: 'added' | 'removed') => files.reduce((n, f) => n + (f[key] ?? 0), 0);
  const title = `${files.length} file${files.length === 1 ? '' : 's'} changed`;

  return (
    <section className="changes" aria-label="Files changed in this chat">
      <div className="changes-head">
        <button className="changes-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`chevron${open ? ' open' : ''}`}>
            <Icon name="chevron" size={12} />
          </span>
          <span className="changes-title">{title}</span>
          <Counts added={total('added')} removed={total('removed')} />
        </button>
        {!busy && (
          <span className="changes-actions">
            {turnFiles.length > 0 && (
              <button onClick={() => postToHost({ type: 'revert' })} title={`Restore the files the last turn changed:\n${turnFiles.join('\n')}`}>
                <Icon name="undo" size={13} /> Undo last turn
              </button>
            )}
            <button onClick={() => postToHost({ type: 'keepChatChanges' })} title="Keep these changes and clear the list">
              <Icon name="check" size={13} /> Keep
            </button>
            <button onClick={() => postToHost({ type: 'revertChat' })} title="Put every file back as it was before this chat">
              <Icon name="retry" size={13} /> Revert all
            </button>
          </span>
        )}
      </div>
      {open && (
        <ul className="changes-list">
          {files.map((f) => {
            const slash = Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\'));
            const name = f.path.slice(slash + 1);
            const dir = slash >= 0 ? f.path.slice(0, slash) : '';
            return (
              <li key={f.path} className={f.kind}>
                <button
                  className="changes-file"
                  onClick={() => postToHost({ type: 'viewChatChange', path: f.path })}
                  title={`${f.path}: show what this chat changed`}
                >
                  <span className="changes-kind" title={KIND[f.kind].label} aria-label={KIND[f.kind].label}>
                    {KIND[f.kind].letter}
                  </span>
                  <span className="changes-name">{name}</span>
                  {dir && <span className="changes-dir">{dir}</span>}
                  <Counts added={f.added} removed={f.removed} />
                </button>
                {f.kind === 'deleted' ? (
                  <Spacer />
                ) : (
                  <button
                    className="icon-btn small"
                    onClick={() => postToHost({ type: 'openFile', path: f.path, line: 1 })}
                    title={`Open ${f.path}`}
                    aria-label={`Open ${f.path}`}
                  >
                    <Icon name="file" size={13} />
                  </button>
                )}
                {!f.revertible && !busy && <Spacer />}
                {f.revertible && !busy && (
                  <button
                    className="icon-btn small"
                    onClick={() => postToHost({ type: 'revertChatFile', path: f.path })}
                    title={f.kind === 'created' ? `Delete ${f.path} (moves it to the trash)` : `Put ${f.path} back as it was before this chat`}
                    aria-label={`Revert ${f.path}`}
                  >
                    <Icon name="undo" size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && <p className="changes-note">Files changed by commands the agent ran are not listed.</p>}
    </section>
  );
}
