export interface Usage {
  contextTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextWindow: number;
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

export function UsageBar({ usage }: { usage: Usage }) {
  const pct = Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
  const cachedPct = usage.contextTokens ? Math.round((usage.cacheReadTokens / usage.contextTokens) * 100) : 0;
  const level = pct >= 70 ? 'high' : pct >= 50 ? 'mid' : 'low';
  const tooltip = [
    `Prompt: ${usage.contextTokens.toLocaleString()} tokens (${pct}% of ${usage.contextWindow.toLocaleString()})`,
    `Read from cache: ${usage.cacheReadTokens.toLocaleString()} (${cachedPct}%)`,
    `Written to cache: ${usage.cacheWriteTokens.toLocaleString()}`,
    `Last reply: ${usage.outputTokens.toLocaleString()} tokens`,
    pct >= 70 ? 'Older context is trimmed automatically when this gets full.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="usagebar" title={tooltip}>
      <div className={`usage-track ${level}`}>
        <div className="usage-fill" style={{ width: `${pct}%` }} />
      </div>
      <span>
        {fmt(usage.contextTokens)} / {fmt(usage.contextWindow)}
        {usage.cacheReadTokens > 0 ? ` · ${cachedPct}% cached` : ''}
      </span>
    </div>
  );
}
