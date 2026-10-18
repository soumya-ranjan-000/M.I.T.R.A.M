import { useState } from 'react';
import type { DisplayMessage } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { Icon, IconName } from './Icon';

type ToolMessage = Extract<DisplayMessage, { role: 'tool' }>;

const TOOL_ICONS: Record<string, IconName> = {
  read_file: 'file',
  list_dir: 'folder',
  search_files: 'search',
  find_files: 'search',
  get_diagnostics: 'alert',
  edit_file: 'edit',
  create_file: 'filePlus',
  run_command: 'terminal',
};

const STATUS_LABEL: Record<ToolMessage['status'], string> = {
  pending: 'Waiting for your approval',
  running: 'Running',
  ok: 'Done',
  error: 'Failed',
  rejected: 'Rejected',
};

function StatusIndicator({ status }: { status: ToolMessage['status'] }) {
  const label = STATUS_LABEL[status];
  switch (status) {
    case 'running':
      return <span className="spinner" role="img" aria-label={label} title={label} />;
    case 'ok':
      return <span className="status ok" role="img" aria-label={label} title={label}><Icon name="check" size={13} /></span>;
    case 'error':
      return <span className="status error" role="img" aria-label={label} title={label}><Icon name="alert" size={13} /></span>;
    case 'rejected':
      return <span className="status rejected" role="img" aria-label={label} title={label}><Icon name="x" size={13} /></span>;
    default:
      return <span className="status pending" role="img" aria-label={label} title={label}>?</span>;
  }
}

export function ToolCard({ tool }: { tool: ToolMessage }) {
  const decide = (decision: 'approve' | 'reject' | 'always') =>
    postToHost({ type: 'approval', id: tool.id, decision });
  const pending = tool.status === 'pending';
  const hasBody = !!tool.detail || !!tool.output;
  const [open, setOpen] = useState(false);
  const expandable = !pending && hasBody;

  const head = (
    <>
      <Icon name={TOOL_ICONS[tool.name] ?? 'terminal'} size={14} />
      <span className="toolcard-summary" title={tool.summary}>
        {tool.summary}
      </span>
      <StatusIndicator status={tool.status} />
      {expandable && (
        <span className={`chevron${open ? ' open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
      )}
    </>
  );

  return (
    <div className={`toolcard ${tool.status}`} role="group" aria-label={`${tool.summary}: ${STATUS_LABEL[tool.status]}`}>
      {expandable ? (
        <button className="toolcard-head clickable" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {head}
        </button>
      ) : (
        <div className="toolcard-head">{head}</div>
      )}

      {pending && tool.detail && <pre className="toolcard-body">{tool.detail}</pre>}
      {pending && tool.allowRule?.usesShell && (
        <p className="toolcard-warning">
          <Icon name="alert" size={13} />
          <span>
            This command uses pipes, chaining, redirects or wildcards, so it can do several things at once. Always allow
            covers only this exact command, so read all of it first.
          </span>
        </p>
      )}
      {pending && (
        <div className="actions">
          {(tool.name === 'edit_file' || tool.name === 'create_file') && (
            <button onClick={() => postToHost({ type: 'viewDiff', id: tool.id })} title="Open the proposed change in the diff editor">
              <Icon name="diff" /> View diff
            </button>
          )}
          <button className="primary" onClick={() => decide('approve')}>
            <Icon name="check" /> Allow
          </button>
          {tool.name !== 'run_command' && (
            <button onClick={() => decide('always')} title="Allow this kind of action for the rest of this chat">
              Always allow in this chat
            </button>
          )}
          {tool.allowRule &&
            (tool.allowRule.usesShell ? (
              <button
                onClick={() => decide('always')}
                title="Run exactly this command without asking in this workspace. Any change to it, even one character, asks again. Review saved commands with /permissions."
              >
                Always allow this exact command
              </button>
            ) : (
              <button
                className="always-rule"
                onClick={() => decide('always')}
                title={`Run commands matching "${tool.allowRule.label}" without asking in this workspace (* means any further arguments). Review them with /permissions.`}
              >
                Always allow <code>{tool.allowRule.label}</code>
              </button>
            ))}
          <button onClick={() => decide('reject')}>
            <Icon name="x" /> Reject
          </button>
        </div>
      )}

      {expandable && open && (
        <>
          {tool.detail && <pre className="toolcard-body">{tool.detail}</pre>}
          {tool.output && <pre className="toolcard-body">{tool.output}</pre>}
        </>
      )}
    </div>
  );
}
