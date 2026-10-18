import { Icon } from './Icon';

/** Small round marker that tells the two speakers apart at a glance. */
export function Avatar({ role, size = 22 }: { role: 'user' | 'assistant'; size?: number }) {
  if (role === 'user') {
    return (
      <span className="avatar user" style={{ width: size, height: size }} aria-hidden="true">
        <Icon name="user" size={Math.round(size * 0.6)} />
      </span>
    );
  }
  return (
    <span className="avatar assistant" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 19V6l7 8 7-8v13" />
      </svg>
    </span>
  );
}

export function MessageHeader({ role }: { role: 'user' | 'assistant' }) {
  return (
    <div className={`msg-header ${role}`}>
      <Avatar role={role} />
      <span>{role === 'user' ? 'You' : 'M.I.T.R.A.M'}</span>
    </div>
  );
}
