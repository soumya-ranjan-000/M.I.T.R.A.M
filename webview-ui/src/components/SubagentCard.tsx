import { memo, useState } from 'react';
import type { DisplayMessage } from '../../../src/webview/protocol';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { StatusIndicator, ToolCard } from './ToolCard';

type ToolMessage = Extract<DisplayMessage, { role: 'tool' }>;

/**
 * A sub-agent at work: what it is doing now and any approval it is waiting for. Opened, it shows
 * the brief it was given, every call it made and its report.
 */
export const SubagentCard = memo(function SubagentCard({ tool }: { tool: ToolMessage }) {
  const [open, setOpen] = useState(false);
  const steps = tool.steps ?? [];
  const running = tool.status === 'running';
  const pending = steps.filter((s) => s.status === 'pending');
  const current = steps.filter((s) => s.status === 'running').pop();
  const activity = running ? tool.note || (current ? `${current.summary}…` : steps.length ? 'Thinking…' : 'Starting…') : '';

  return (
    <div
      className={`toolcard subagent ${tool.status}${pending.length ? ' waiting' : ''}`}
      role="group"
      aria-label={`Sub-agent: ${tool.summary}`}
    >
      <button className="toolcard-head clickable" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="agent" size={14} />
        <span className="toolcard-summary" title={tool.summary}>
          {tool.summary}
        </span>
        {tool.badge && <span className="toolcard-badge">{tool.badge}</span>}
        {steps.length > 0 && (
          <span className="subagent-count">
            {steps.length} step{steps.length === 1 ? '' : 's'}
          </span>
        )}
        <StatusIndicator status={tool.status} />
        <span className={`chevron${open ? ' open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
      </button>

      {!open && activity && (
        <div className="subagent-activity" title={activity}>
          {activity}
        </div>
      )}
      {/* Approval requests must stay reachable while the card is closed. */}
      {!open && pending.length > 0 && (
        <div className="subagent-steps">
          {pending.map((s) => (
            <ToolCard key={s.id} tool={s} />
          ))}
        </div>
      )}

      {open && (
        <div className="subagent-body">
          {tool.detail && (
            <>
              <div className="subagent-label">Brief</div>
              <pre className="toolcard-body">{tool.detail}</pre>
            </>
          )}
          {steps.length > 0 && (
            <>
              <div className="subagent-label">Steps</div>
              <div className="subagent-steps">
                {steps.map((s) => (
                  <ToolCard key={s.id} tool={s} />
                ))}
              </div>
            </>
          )}
          {activity && <div className="subagent-activity">{activity}</div>}
          {tool.output && (
            <>
              <div className="subagent-label">{tool.status === 'ok' ? 'Report' : 'Error'}</div>
              <div className="subagent-report">
                <Markdown text={tool.output} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});
