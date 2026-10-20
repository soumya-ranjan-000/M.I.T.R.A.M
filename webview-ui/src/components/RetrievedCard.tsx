import { memo, useState } from 'react';
import type { RetrievedRef } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { Icon } from './Icon';

/** The files a local search attached to the user's message before the agent started, each one a link. */
export const RetrievedCard = memo(function RetrievedCard({ files }: { files: RetrievedRef[] }) {
  const [open, setOpen] = useState(false);
  const label = `Attached ${files.length} related file${files.length === 1 ? '' : 's'}`;

  return (
    <div className="toolcard retrieved" role="group" aria-label={label}>
      <button
        className="toolcard-head clickable"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Found by a keyword search of your workspace and sent with your message, so the agent can start from them"
      >
        <Icon name="search" size={14} />
        <span className="toolcard-summary">{label}</span>
        <span className={`chevron${open ? ' open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
      </button>
      {open && (
        <ul className="retrieved-list">
          {files.map((f) => (
            <li key={f.path}>
              <button
                onClick={() => postToHost({ type: 'openFile', path: f.path, line: f.startLine })}
                title={`Open ${f.path} at line ${f.startLine}`}
              >
                <span className="retrieved-path">{f.path}</span>
                <span className="retrieved-lines">
                  {f.startLine}–{f.endLine}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
