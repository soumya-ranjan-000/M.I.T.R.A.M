import { useEffect, useState, type ReactNode } from 'react';
import { describeSteps, isWaiting, liveSteps, stepsStatus, type Indexed, type StepMessage } from '../../../src/webview/steps';
import { Icon } from './Icon';

interface Props {
  steps: Indexed<StepMessage>[];
  /** The agent is still working on this group: it is the end of the transcript. */
  active: boolean;
  renderStep: (step: Indexed<StepMessage>) => ReactNode;
}

/**
 * The tool calls and reasoning between two replies, as one line. While the agent works it shows
 * what is running; when it is done it folds away. Approval prompts are always shown.
 */
export function StepGroup({ steps, active, renderStep }: Props) {
  const [open, setOpen] = useState(false);
  // Fold when the work is done, even if it was opened to watch.
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  const messages = steps.map((s) => s.message);
  const status = stepsStatus(messages);
  const label = describeSteps(messages);
  const shown = open ? steps : active ? liveSteps(steps) : steps.filter((s) => isWaiting(s.message));

  return (
    <div className={`step-group ${status}${active ? ' active' : ''}`} role="group" aria-label={label}>
      <button className="step-group-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`chevron${open ? ' open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
        <span className="step-group-label" title={label}>
          {label}
        </span>
        <span className="step-group-count">
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>
        {status === 'running' && active && <span className="spinner" aria-hidden="true" />}
        {status === 'error' && (
          <span className="status error" role="img" aria-label="Some steps failed" title="Some steps failed">
            <Icon name="alert" size={13} />
          </span>
        )}
      </button>
      {shown.length > 0 && <div className="step-list">{shown.map(renderStep)}</div>}
    </div>
  );
}
