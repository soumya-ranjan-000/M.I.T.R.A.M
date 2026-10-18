import { useId } from 'react';
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
  return <AssistantMark size={size} />;
}

/** The M.I.T.R.A.M mark: the same glowing M as the extension icon, scaled to the avatar. */
function AssistantMark({ size }: { size: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <span className="avatar assistant" style={{ width: size, height: size, borderRadius: size * 0.26 }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <defs>
          <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="5" y1="0" x2="19" y2="0">
            <stop offset="0" stopColor="#3b82f6" />
            <stop offset="0.4" stopColor="#8b5cf6" />
            <stop offset="0.7" stopColor="#ec4899" />
            <stop offset="1" stopColor="#f59e0b" />
          </linearGradient>
        </defs>
        <path d="M6 18V7.5l6 6.8 6-6.8V18" stroke={`url(#${id})`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        {size >= 32 && (
          <g fill="#fff">
            <circle cx="6" cy="7.5" r="1.7" />
            <circle cx="18" cy="7.5" r="1.7" />
            <circle cx="12" cy="14.3" r="1.7" />
          </g>
        )}
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
