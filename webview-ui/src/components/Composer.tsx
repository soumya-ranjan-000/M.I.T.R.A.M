import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { HostToWebview } from '../../../src/webview/protocol';
import { SlashCommand, parseSlash, suggestSlash } from '../../../src/webview/slashCommands';
import { onHostMessage, postToHost } from '../vscode';
import { Icon } from './Icon';
import { Usage, UsageBar } from './UsageBar';

/** What the agent is up to: drives the glow around the input box. */
export type AgentState = 'idle' | 'working' | 'waiting';

interface Props {
  busy: boolean;
  agentState: AgentState;
  activeFile: string | null;
  hasSelection: boolean;
  planMode: boolean;
  model: string;
  usage: Usage | null;
  onTogglePlan: () => void;
  onSlash: (command: SlashCommand) => void;
  onSend: (text: string, includeActive: boolean, mentions: string[]) => void;
}

interface MenuItem {
  key: string;
  label: string;
  hint?: string;
}

const MENTION_RE = /(^|\s)@([^\s@]*)$/;
const MAX_HEIGHT = 200;

export function Composer({ busy, agentState, activeFile, hasSelection, planMode, model, usage, onTogglePlan, onSlash, onSend }: Props) {
  const [text, setText] = useState('');
  const [includeActive, setIncludeActive] = useState(true);
  const [mentions, setMentions] = useState<string[]>([]);
  const [results, setResults] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryRef = useRef<string | null>(null);
  const listId = useId();

  useEffect(
    () =>
      onHostMessage((msg: HostToWebview) => {
        if (msg.type === 'fileResults' && msg.query === queryRef.current) {
          setResults(msg.files);
          setIndex(0);
        }
      }),
    [],
  );

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const slash = results.length === 0 && !slashDismissed ? suggestSlash(text) : [];
  const items: MenuItem[] =
    results.length > 0
      ? results.map((f) => ({ key: f, label: f }))
      : slash.map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.description }));
  const menuOpen = items.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  function updateMention(value: string, caret: number) {
    const match = MENTION_RE.exec(value.slice(0, caret));
    if (match) {
      queryRef.current = match[2];
      postToHost({ type: 'searchFiles', query: match[2] });
    } else {
      queryRef.current = null;
      setResults([]);
    }
  }

  function pickFile(file: string) {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(MENTION_RE, (_m, lead: string) => `${lead}@${file} `);
    setText(before + text.slice(caret));
    setMentions((prev) => (prev.includes(file) ? prev : [...prev, file]));
    queryRef.current = null;
    setResults([]);
    el?.focus();
  }

  function runSlash(command: SlashCommand) {
    setText('');
    setResults([]);
    onSlash(command);
  }

  function chooseItem(i: number) {
    if (results.length > 0) pickFile(results[i]);
    else runSlash(slash[i]);
  }

  /** The "@" button: insert an @ so the file picker opens. */
  function startMention() {
    const next = text && !/\s$/.test(text) ? `${text} @` : `${text}@`;
    setText(next);
    queryRef.current = '';
    postToHost({ type: 'searchFiles', query: '' });
    textareaRef.current?.focus();
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const command = parseSlash(trimmed);
    if (command) return runSlash(command);
    onSend(
      trimmed,
      includeActive,
      mentions.filter((m) => trimmed.includes(`@${m}`)),
    );
    setText('');
    setMentions([]);
    setResults([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => (i + step + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        chooseItem(index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); // also tells the app not to treat this Escape as "stop"
        if (results.length > 0) setResults([]);
        else setSlashDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const fileName = activeFile ? activeFile.slice(activeFile.lastIndexOf('/') + 1) : '';

  return (
    <div className="composer">
      <div className="composer-wrap" data-agent-state={agentState}>
        {menuOpen && (
          <ul className="mentions" role="listbox" id={listId} aria-label={results.length > 0 ? 'Files' : 'Commands'}>
            {items.map((item, i) => (
              <li
                key={item.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === index}
                className={i === index ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseItem(i);
                }}
              >
                <span className="menu-label">{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
              </li>
            ))}
          </ul>
        )}

        <div className={`composer-card${planMode ? ' plan' : ''}`}>
          {activeFile && (
            <div className="attachments">
              <button
                className={`pill ${includeActive ? 'on' : 'off'}`}
                aria-pressed={includeActive}
                onClick={() => setIncludeActive((v) => !v)}
                title={
                  includeActive
                    ? `${activeFile}${hasSelection ? ' (selection)' : ''}: attached. Click to leave it out.`
                    : `Click to attach ${activeFile}`
                }
              >
                <Icon name={includeActive ? 'file' : 'plus'} size={12} />
                <span>
                  {fileName}
                  {hasSelection ? ' · selection' : ''}
                </span>
                {includeActive && <Icon name="x" size={11} />}
              </button>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            aria-label="Message M.I.T.R.A.M"
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={menuOpen ? optionId(index) : undefined}
            placeholder={planMode ? 'Describe what to plan. Nothing will be changed.' : 'Ask anything. Use @ to add files and / for commands'}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              setIndex(0);
              setSlashDismissed(false);
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
          />

          <div className="composer-bar">
            <button className="tool-btn icon" onClick={startMention} title="Attach a file (@)" aria-label="Attach a file">
              <Icon name="at" size={14} />
            </button>
            <button
              className={`tool-btn${planMode ? ' on' : ''}`}
              aria-pressed={planMode}
              onClick={onTogglePlan}
              title="Plan mode: investigate and propose a plan before changing anything (/plan)"
            >
              <Icon name="plan" size={14} />
              <span>Plan</span>
            </button>
            <button className="tool-btn model" onClick={() => postToHost({ type: 'pickModel' })} title={`Model: ${model} (click to change, or /model)`}>
              <Icon name="chip" size={14} />
              <span>{model || 'model'}</span>
            </button>
            <span className="spacer" />
            {busy ? (
              <button className="send-btn stop" onClick={() => postToHost({ type: 'stop' })} title="Stop (Esc)" aria-label="Stop">
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button className="send-btn" onClick={send} disabled={!text.trim()} title="Send (Enter)" aria-label="Send">
                <Icon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="composer-foot">
        {usage ? <UsageBar usage={usage} /> : <span className="hint">Enter to send · Shift+Enter for a new line</span>}
      </div>
    </div>
  );
}
