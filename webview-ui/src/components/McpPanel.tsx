import { useEffect, useRef } from 'react';
import type { McpPresetView, McpServerView, McpStatusKind } from '../../../src/webview/protocol';
import { postToHost } from '../vscode';
import { Icon } from './Icon';

interface Props {
  servers: McpServerView[];
  presets: McpPresetView[];
  /** Reasons entries in the settings were rejected, so a typo is visible rather than silent. */
  problems: string[];
  onClose: () => void;
}

/** What the dot next to a server means. */
const STATUS_LABEL: Record<McpStatusKind, string> = {
  idle: 'not connected yet',
  connecting: 'connecting…',
  ready: 'connected',
  failed: 'failed',
  disabled: 'turned off',
  'needs-auth': 'sign-in needed',
};

function summary(server: McpServerView): string {
  if (server.status === 'ready') return `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
  if (server.status === 'failed') return server.error ?? 'failed';
  if (server.status === 'needs-auth') return 'sign-in needed';
  if (server.oauth && server.status === 'connecting') return 'waiting for you to sign in, in your browser…';
  if (server.needsKey && !server.hasKey) return 'no API key set';
  return STATUS_LABEL[server.status];
}

/**
 * The MCP servers panel: what is configured, whether it connected, and the actions for each one.
 *
 * Adding a server and setting its key happen in the extension host, through VS Code's own
 * prompts, so an API key is never typed into this webview.
 */
export function McpPanel({ servers, presets, problems, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const anyConnected = servers.some((s) => s.status === 'ready');

  return (
    <div className="mcp-backdrop">
      <div className="mcp-panel" ref={rootRef} role="dialog" aria-modal="true" aria-label="MCP servers">
        <div className="mcp-head">
          <Icon name="plug" size={15} />
          <span className="mcp-title">MCP servers</span>
          <button className="icon-btn" onClick={() => postToHost({ type: 'mcpAdd' })} title="Add a server" aria-label="Add a server">
            <Icon name="plus" size={15} />
          </button>
          <button
            className="icon-btn"
            disabled={!anyConnected && !servers.length}
            onClick={() => postToHost({ type: 'mcpRestart' })}
            title="Reconnect every server"
            aria-label="Reconnect every server"
          >
            <Icon name="retry" size={15} />
          </button>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>

        {problems.length > 0 && (
          <ul className="mcp-problems" aria-label="Problems in your settings">
            {problems.map((p) => (
              <li key={p}>
                <Icon name="alert" size={12} /> {p}
              </li>
            ))}
          </ul>
        )}

        {servers.length === 0 ? (
          <div className="mcp-empty">
            <p>No MCP servers yet. They give the agent extra tools, such as a browser or your issue tracker.</p>
            <div className="mcp-suggestions">
              {presets.slice(0, 4).map((preset) => (
                <button key={preset.id} className="mcp-suggestion" onClick={() => postToHost({ type: 'mcpAdd' })} title={preset.description}>
                  {preset.label}
                  {preset.needsKey && <span className="mcp-chip">key</span>}
                </button>
              ))}
            </div>
            <button className="mcp-add-btn" onClick={() => postToHost({ type: 'mcpAdd' })}>
              Add a server…
            </button>
          </div>
        ) : (
          <ul className="mcp-list">
            {servers.map((server) => (
              <li key={server.id} className={`mcp-item ${server.status}`}>
                <div className="mcp-item-head">
                  <span className={`mcp-dot ${server.status}`} title={STATUS_LABEL[server.status]} />
                  <span className="mcp-name" title={server.description}>
                    {server.id}
                  </span>
                  <span className="mcp-summary">{summary(server)}</span>
                </div>
                <div className="mcp-item-desc" title={server.description}>
                  {server.description}
                </div>
                <div className="mcp-actions">
                  {server.oauth && (server.status === 'needs-auth' || server.status === 'failed') && server.enabled && (
                    <button className="primary" onClick={() => postToHost({ type: 'mcpSignIn', id: server.id })}>
                      Sign in
                    </button>
                  )}
                  {server.oauth && server.signedIn && (
                    <button onClick={() => postToHost({ type: 'mcpSignOut', id: server.id })} title="Forget the saved sign-in">
                      Sign out
                    </button>
                  )}
                  {server.needsKey && (
                    <button onClick={() => postToHost({ type: 'mcpSetKey', id: server.id })}>
                      {server.hasKey ? 'Replace API key' : 'Set API key'}
                    </button>
                  )}
                  <button onClick={() => postToHost({ type: 'mcpEnable', id: server.id, enabled: !server.enabled })}>
                    {server.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button disabled={!server.enabled} onClick={() => postToHost({ type: 'mcpRestart', id: server.id })}>
                    Reconnect
                  </button>
                  <button className="mcp-remove" onClick={() => postToHost({ type: 'mcpRemove', id: server.id })}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mcp-foot">
          Tools from a server need your approval before they run, and their results are treated as untrusted data. API keys and sign-ins are kept
          in VS Code's secret storage.
        </div>
      </div>
    </div>
  );
}
