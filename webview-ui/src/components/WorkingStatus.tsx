import { useEffect, useState } from 'react';
import { describeActivity, formatElapsed } from '../../../src/webview/activity';
import type { DisplayMessage } from '../../../src/webview/protocol';
import { Icon } from './Icon';

/** One line that always says what the agent is doing, with how long it has been going. */
export function WorkingStatus({ messages, since, note }: { messages: DisplayMessage[]; since: number; note?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const activity = describeActivity(messages);
  const { waitingForUser } = activity;
  const label = note && !waitingForUser ? note : activity.label;
  return (
    <div className={`working${waitingForUser ? ' waiting' : ''}`} role="status">
      {waitingForUser ? (
        <Icon name="alert" size={13} />
      ) : (
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span className="working-label" title={label}>
        {label}
      </span>
      {!waitingForUser && <span className="working-time">{formatElapsed(now - since)}</span>}
    </div>
  );
}
