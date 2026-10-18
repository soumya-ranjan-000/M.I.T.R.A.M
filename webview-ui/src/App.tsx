import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { describeActivity } from '../../src/webview/activity';
import { applyHostEvent } from '../../src/webview/displayReducer';
import type { Board, DisplayMessage, FileAttachment, ImageAttachment, SessionSummary } from '../../src/webview/protocol';
import { emptyBoard } from '../../src/agent/board';
import type { SlashCommand } from '../../src/webview/slashCommands';
import { Avatar, MessageHeader } from './components/Avatar';
import { BoardPanel } from './components/BoardPanel';
import { FileStrip, ImageStrip } from './components/Attachments';
import { AgentState, Composer } from './components/Composer';
import { Header } from './components/Header';
import { Icon } from './components/Icon';
import { Markdown } from './components/Markdown';
import { PinnedRequest } from './components/PinnedRequest';
import { RetrievedCard } from './components/RetrievedCard';
import { ThinkingBlock } from './components/ThinkingBlock';
import { ToolCard } from './components/ToolCard';
import { Usage } from './components/UsageBar';
import { WorkingStatus } from './components/WorkingStatus';
import { onHostMessage, postToHost } from './vscode';

interface ErrorState {
  message: string;
  needsSetup: boolean;
}

const CONTINUE_TEXT = 'Continue where you left off.'; // same text the extension host uses
const EXECUTE_PLAN_TEXT = 'The plan is approved. Please carry it out now, following the tasks on your board.';
// Sent by the app on the user's behalf: they carry on a request rather than make one, so they are never pinned.
const FOLLOW_UPS = new Set([CONTINUE_TEXT, EXECUTE_PLAN_TEXT]);

interface Budget {
  reason: 'steps' | 'time' | 'stuck';
  steps: number;
}

const speaker = (m: DisplayMessage): 'user' | 'assistant' => (m.role === 'user' ? 'user' : 'assistant');

export function App() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(0);
  const [error, setError] = useState<ErrorState | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [hasWorkspace, setHasWorkspace] = useState(true);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [planReady, setPlanReady] = useState(false);
  const [model, setModel] = useState('');
  const [board, setBoard] = useState<Board>(emptyBoard());
  const [budget, setBudget] = useState<Budget | null>(null);
  const planTurn = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // The user's requests on screen, by their index in `visible`, for the pinned request bar.
  const requests = useRef(new Map<number, HTMLDivElement>());
  const pinFrame = useRef(0);
  // How far down the pinned bar reaches: a request starting above that line is on screen, so the
  // bar never covers it with an older one. Measured whenever the bar is shown.
  const pinZone = useRef(84);
  const [pinned, setPinned] = useState<number | null>(null);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      switch (msg.type) {
        case 'streamDelta':
        case 'thinkingDelta':
        case 'toolStart':
        case 'toolUpdate':
        case 'toolAllowRule':
        case 'notice':
          setMessages((prev) => applyHostEvent(prev, msg));
          break;
        case 'streamEnd':
          setBusy(false);
          if (planTurn.current) setPlanReady(true);
          break;
        case 'board':
          setBoard(msg.board);
          break;
        case 'runInProgress':
          // The view was reopened while the agent kept working: pick the run back up.
          planTurn.current = msg.plan;
          setBusySince(msg.since);
          setBusy(true);
          break;
        case 'budgetReached':
          setBudget({ reason: msg.reason, steps: msg.steps });
          break;
        case 'modelInfo':
          setModel(msg.model);
          break;
        case 'error':
          setError({ message: msg.message, needsSetup: !!msg.needsSetup });
          setBusy(false);
          setPlanReady(false);
          break;
        case 'loadMessages':
          setMessages(msg.messages);
          setUsage(null);
          setPlanReady(false);
          setBudget(null);
          setBusy(false);
          setError(null);
          stickToBottom.current = true;
          break;
        case 'usage':
          setUsage(msg);
          break;
        case 'checkpoint':
          setChangedFiles(msg.files);
          break;
        case 'sessions':
          setSessions(msg.list);
          setActiveId(msg.activeId);
          break;
        case 'contextInfo':
          setActiveFile(msg.file);
          setHasSelection(msg.hasSelection);
          setHasWorkspace(msg.hasWorkspace);
          break;
      }
    });
    postToHost({ type: 'ready' });
    return off;
  }, []);

  // Escape stops a running turn (unless a menu in the composer already used it).
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) postToHost({ type: 'stop' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  // Follow new content, but not if the person has scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, error, busy]);

  // The visible area also changes when bars appear above the composer or the composer grows;
  // keep the end of the conversation in view in those cases too.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
      updatePinned();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Pins the request that what is at the top of the view belongs to, once that request has scrolled
   * fully out of sight, so a long run of tool calls never hides what was asked. Once per frame.
   */
  const updatePinned = useCallback(() => {
    cancelAnimationFrame(pinFrame.current);
    pinFrame.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      let current = -1;
      for (const [i, node] of requests.current) {
        if (i > current && node.getBoundingClientRect().top < top + pinZone.current) current = i;
      }
      const node = requests.current.get(current);
      setPinned(node && node.getBoundingClientRect().bottom <= top ? current : null);
    });
  }, []);

  useEffect(updatePinned, [messages, updatePinned]);

  function onScroll() {
    const el = scroller.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    updatePinned();
  }

  function jumpToRequest(index: number) {
    const node = requests.current.get(index);
    if (!node) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    node.classList.remove('flash');
    void node.offsetWidth; // restart the animation
    node.classList.add('flash');
    node.addEventListener('animationend', () => node.classList.remove('flash'), { once: true });
  }

  const startWorking = useCallback(() => {
    stickToBottom.current = true;
    setBudget(null);
    setBusySince(Date.now());
    setBusy(true);
  }, []);

  const send = useCallback(
    (text: string, includeActive: boolean, mentions: string[], plan: boolean, images: ImageAttachment[] = [], files: FileAttachment[] = []) => {
      planTurn.current = plan;
      setPlanReady(false);
      setMessages((prev) => [
        ...prev,
        {
          role: 'user',
          text,
          ...(images.length ? { images } : {}),
          // The transcript only shows what was attached, as the host saves it.
          ...(files.length ? { files: files.map((f) => ({ ...f, data: '' })) } : {}),
        },
      ]);
      setError(null);
      startWorking();
      postToHost({ type: 'sendMessage', text, includeActive, mentions, plan, images, files });
    },
    [startWorking],
  );

  function executePlan() {
    setPlanMode(false);
    send(EXECUTE_PLAN_TEXT, false, [], false);
  }

  function runSlash(command: SlashCommand) {
    switch (command.name) {
      case 'new':
        postToHost({ type: 'newChat' });
        break;
      case 'undo':
        postToHost({ type: 'revert' });
        break;
      case 'plan':
        setPlanMode((v) => !v);
        break;
      case 'model':
        postToHost({ type: 'pickModel' });
        break;
      case 'permissions':
        postToHost({ type: 'managePermissions' });
        break;
    }
  }

  function continueRun() {
    setMessages((prev) => [...prev, { role: 'user', text: CONTINUE_TEXT }]);
    setError(null);
    startWorking();
    postToHost({ type: 'continueRun' });
  }

  function retry() {
    setError(null);
    startWorking();
    postToHost({ type: 'retry' });
  }

  // The plan panel shows the board, so its tool calls are not shown as cards.
  const agentState: AgentState = !busy ? 'idle' : describeActivity(messages).waitingForUser ? 'waiting' : 'working';
  const visible = messages.filter((m) => !(m.role === 'tool' && m.name === 'update_board'));
  const pinnedMessage = pinned === null ? undefined : visible[pinned];

  return (
    <div className="app">
      <Header sessions={sessions} activeId={activeId} />
      {!hasWorkspace && (
        <div className="banner">
          No folder is open, so file and command tools are off. Open a folder (File → Open Folder) to let M.I.T.R.A.M edit
          files and run commands.
        </div>
      )}

      <div className="messages-wrap">
        {pinnedMessage?.role === 'user' && (
          <PinnedRequest
            text={pinnedMessage.text}
            images={pinnedMessage.images?.length ?? 0}
            files={pinnedMessage.files?.length ?? 0}
            onJump={() => jumpToRequest(pinned!)}
            barRef={(node) => {
              if (node) pinZone.current = node.offsetTop + node.offsetHeight;
            }}
          />
        )}
        <div className="messages" ref={scroller} onScroll={onScroll} role="log" aria-label="Conversation" aria-live="polite" aria-busy={busy}>
          {messages.length === 0 && !error && (
            <div className="welcome">
              <Avatar role="assistant" size={40} />
              <h2>How can I help?</h2>
              <p>Ask about your code, or have me make changes. I ask before I edit files or run commands.</p>
              <ul>
                <li>
                  <kbd>@</kbd> attach a file
                </li>
                <li>
                  <kbd>+</kbd> attach images, PDFs and documents, or paste a screenshot
                </li>
                <li>
                  <kbd>/</kbd> commands: new, undo, plan, model
                </li>
                <li>
                  <kbd>Plan</kbd> investigate first, change nothing
                </li>
              </ul>
            </div>
          )}

          {visible.map((m, i) => {
            const header = i === 0 || speaker(visible[i - 1]) !== speaker(m);
            return (
              <Fragment key={m.role === 'tool' ? m.id : i}>
                {header && <MessageHeader role={speaker(m)} />}
                {m.role === 'user' && (
                  <div
                    className="bubble"
                    ref={(node) => {
                      if (node && !FOLLOW_UPS.has(m.text)) requests.current.set(i, node);
                      else requests.current.delete(i);
                    }}
                  >
                    {m.images?.length ? <ImageStrip images={m.images} /> : null}
                  {m.files?.length ? <FileStrip files={m.files} /> : null}
                    {m.text}
                  </div>
                )}
                {m.role === 'assistant' && (
                  <div className="reply">
                    <Markdown text={m.text} />
                  </div>
                )}
                {m.role === 'thinking' && <ThinkingBlock text={m.text} live={busy && m === messages[messages.length - 1]} />}
                {m.role === 'tool' && <ToolCard tool={m} />}
                {m.role === 'retrieved' && <RetrievedCard files={m.files} />}
              </Fragment>
            );
          })}

          {busy && (
            <>
              {messages.length > 0 && speaker(messages[messages.length - 1]) === 'user' && <MessageHeader role="assistant" />}
              <WorkingStatus messages={messages} since={busySince} />
            </>
          )}

          {error && (
            <div className="error-box" role="alert">
              <div>{error.message}</div>
              <div className="actions">
                {error.needsSetup ? (
                  <>
                    <button onClick={() => postToHost({ type: 'setApiKey' })}>
                      <Icon name="key" /> Set API key
                    </button>
                    <button onClick={() => postToHost({ type: 'openSettings' })}>
                      <Icon name="settings" /> Settings
                    </button>
                  </>
                ) : null}
                <button onClick={retry}>
                  <Icon name="retry" /> Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {budget && !busy && (
        <div className="notice-bar paused" role="status">
          <span>
            {budget.reason === 'steps' && `Paused after ${budget.steps} steps.`}
            {budget.reason === 'time' && 'Paused: the time limit for one run was reached.'}
            {budget.reason === 'stuck' && 'Stopped: it kept repeating the same action.'}
          </span>
          <button className="primary" onClick={continueRun}>
            <Icon name="send" size={13} /> Continue
          </button>
        </div>
      )}
      <BoardPanel board={board} busy={busy} />
      {changedFiles.length > 0 && !busy && (
        <div className="notice-bar">
          <span title={changedFiles.join('\n')}>
            {changedFiles.length} file{changedFiles.length === 1 ? '' : 's'} changed in the last turn
          </span>
          <button onClick={() => postToHost({ type: 'revert' })} title="Restore the files the agent changed">
            <Icon name="undo" /> Revert changes
          </button>
        </div>
      )}
      {planReady && !busy && (
        <div className="notice-bar plan" role="region" aria-label="Plan ready">
          <span>Plan ready. Review it above, then run it or keep refining.</span>
          <span className="bar-actions">
            <button className="primary" onClick={executePlan}>
              <Icon name="check" /> Execute plan
            </button>
            <button onClick={() => setPlanReady(false)}>Keep planning</button>
          </span>
        </div>
      )}

      <Composer
        busy={busy}
        agentState={agentState}
        activeFile={activeFile}
        hasSelection={hasSelection}
        planMode={planMode}
        model={model}
        usage={usage}
        onTogglePlan={() => setPlanMode((v) => !v)}
        onSlash={runSlash}
        onSend={(text, includeActive, mentions, images, files) => send(text, includeActive, mentions, planMode, images, files)}
      />
    </div>
  );
}
