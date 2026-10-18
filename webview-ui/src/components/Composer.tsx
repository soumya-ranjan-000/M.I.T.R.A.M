import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  FileAttachment,
  HostToWebview,
  ImageAttachment,
  MAX_FILES,
  MAX_IMAGES,
  MAX_MESSAGE_ATTACHMENT_CHARS,
  MAX_UPLOAD_BYTES,
  attachmentChars,
} from '../../../src/webview/protocol';
import { SlashCommand, parseSlash, suggestSlash } from '../../../src/webview/slashCommands';
import { ImageSource, fileUris, rawToSource, toAttachment, toBase64, transferFiles } from '../images';
import { onHostMessage, postToHost } from '../vscode';
import { FileChip, ImageChip } from './Attachments';
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
  onSend: (text: string, includeActive: boolean, mentions: string[], images: ImageAttachment[], files: FileAttachment[]) => void;
}

interface MenuItem {
  key: string;
  label: string;
  hint?: string;
}

const MENTION_RE = /(^|\s)@([^\s@]*)$/;
const MAX_HEIGHT = 200;
const HINT_MS = 6000;

const ATTACH_ITEMS: MenuItem[] = [
  { key: 'files', label: 'Attach files…', hint: 'images, PDF, Word, Excel, text…' },
  { key: 'mention', label: 'Add a workspace file', hint: '@' },
];
const TOO_LARGE = 'Images and PDFs are limited to about 18 MB per message.';
const fits = (images: ImageAttachment[], files: FileAttachment[]) => attachmentChars(images, files) <= MAX_MESSAGE_ATTACHMENT_CHARS;

export function Composer({ busy, agentState, activeFile, hasSelection, planMode, model, usage, onTogglePlan, onSlash, onSend }: Props) {
  const [text, setText] = useState('');
  const [includeActive, setIncludeActive] = useState(true);
  const [mentions, setMentions] = useState<string[]>([]);
  const [results, setResults] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [images, setImagesState] = useState<ImageAttachment[]>([]);
  const [files, setFilesState] = useState<FileAttachment[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  // Kept in refs too, so attachments added by overlapping pastes or host replies count each other.
  const imagesRef = useRef<ImageAttachment[]>([]);
  const filesRef = useRef<FileAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryRef = useRef<string | null>(null);
  const listId = useId();

  useEffect(
    () =>
      onHostMessage((msg: HostToWebview) => {
        if (msg.type === 'fileResults' && msg.query === queryRef.current) {
          setResults(msg.files);
          setIndex(0);
        } else if (msg.type === 'attachmentsPicked') {
          addFiles(msg.files);
          void addImages(msg.images.map(rawToSource));
        }
      }),
    [],
  );

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

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
      : slash.length > 0
        ? slash.map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.description }))
        : attachOpen
          ? ATTACH_ITEMS
          : [];
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
    else if (slash.length > 0) runSlash(slash[i]);
    else chooseAttach(ATTACH_ITEMS[i].key);
  }

  function setImages(next: ImageAttachment[]) {
    imagesRef.current = next;
    setImagesState(next);
  }

  function setFiles(next: FileAttachment[]) {
    filesRef.current = next;
    setFilesState(next);
  }

  /** Adds files the host has read, up to the limits, and says why any were left out. */
  function addFiles(incoming: FileAttachment[]) {
    const next = [...filesRef.current];
    let problem: string | null = null;
    for (const file of incoming) {
      if (next.length >= MAX_FILES) {
        problem = `Up to ${MAX_FILES} files per message.`;
        break;
      }
      if (fits(imagesRef.current, [...next, file])) next.push(file);
      else problem = TOO_LARGE;
    }
    if (next.length !== filesRef.current.length) setFiles(next);
    if (problem) setHint(problem);
  }

  function removeFile(id: string) {
    setFiles(filesRef.current.filter((file) => file.id !== id));
    setHint(null);
    textareaRef.current?.focus();
  }

  /** Resizes and adds images, up to the limit, and says why any were left out. */
  async function addImages(sources: ImageSource[]) {
    if (sources.length === 0) return;
    const room = Math.max(0, MAX_IMAGES - imagesRef.current.length);
    const problems: string[] = [];
    if (sources.length > room) problems.push(`Up to ${MAX_IMAGES} images per message.`);
    const added: ImageAttachment[] = [];
    for (const source of sources.slice(0, room)) {
      try {
        const image = await toAttachment(source);
        if (fits([...imagesRef.current, ...added, image], filesRef.current)) added.push(image);
        else problems.push(TOO_LARGE);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    if (added.length) setImages([...imagesRef.current, ...added].slice(0, MAX_IMAGES));
    if (problems.length) setHint(problems[0]);
  }

  function removeImage(id: string) {
    setImages(imagesRef.current.filter((image) => image.id !== id));
    setHint(null);
    textareaRef.current?.focus();
  }

  /**
   * Attaches the files in a paste or drop: images are resized here, other files go to the host to
   * read, and file paths from a file manager are read by the host. Returns false if there were none.
   * Runs synchronously up to that answer: the data is gone once the event returns.
   */
  function attachTransfer(data: DataTransfer, preferText: boolean): boolean {
    const { images: pictures, others } = transferFiles(data, preferText);
    const uris = pictures.length || others.length ? [] : fileUris(data);
    if (!pictures.length && !others.length && !uris.length) return false;
    void addImages(pictures);
    for (const file of others) void sendFileData(file);
    if (uris.length) postToHost({ type: 'readFiles', uris });
    return true;
  }

  async function sendFileData(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) return setHint(`${file.name} is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB.`);
    postToHost({ type: 'attachFileData', name: file.name || 'pasted file', data: await toBase64(file) });
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // A plain text paste is untouched.
    if (attachTransfer(e.clipboardData, true)) e.preventDefault();
  }

  function onDragOver(e: React.DragEvent) {
    const types = Array.from(e.dataTransfer.types);
    if (types.includes('Files') || types.includes('text/uri-list')) e.preventDefault();
  }

  function onDrop(e: React.DragEvent) {
    if (attachTransfer(e.dataTransfer, false)) e.preventDefault();
  }

  function chooseAttach(key: string) {
    setAttachOpen(false);
    if (key === 'files') postToHost({ type: 'pickFiles' });
    else startMention();
  }

  function onAttachKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!attachOpen) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + ATTACH_ITEMS.length) % ATTACH_ITEMS.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      chooseAttach(ATTACH_ITEMS[index].key);
    } else if (e.key === 'Escape') {
      e.preventDefault(); // not "stop the agent"
      setAttachOpen(false);
    }
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
    const attached = images.length + files.length;
    if ((!trimmed && attached === 0) || busy) return;
    const command = attached === 0 ? parseSlash(trimmed) : null;
    if (command) return runSlash(command);
    onSend(
      trimmed,
      includeActive,
      mentions.filter((m) => trimmed.includes(`@${m}`)),
      images,
      files,
    );
    setText('');
    setMentions([]);
    setResults([]);
    setImages([]);
    setFiles([]);
    setHint(null);
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
          <ul
            className="mentions"
            role="listbox"
            id={listId}
            aria-label={results.length > 0 ? 'Files' : slash.length > 0 ? 'Commands' : 'Attach'}
          >
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

        <div className={`composer-card${planMode ? ' plan' : ''}`} onDragOver={onDragOver} onDrop={onDrop}>
          {(activeFile || images.length > 0 || files.length > 0 || hint) && (
            <div className="attachments">
              {activeFile && (
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
              )}
              {images.map((image) => (
                <ImageChip key={image.id} image={image} onRemove={() => removeImage(image.id)} />
              ))}
              {files.map((file) => (
                <FileChip key={file.id} file={file} onRemove={() => removeFile(file.id)} />
              ))}
              {hint && (
                <span className="attach-hint" role="status">
                  {hint}
                </span>
              )}
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
            onPaste={onPaste}
          />

          <div className="composer-bar">
            <button
              className={`tool-btn icon${attachOpen ? ' on' : ''}`}
              onClick={() => {
                setAttachOpen((v) => !v);
                setIndex(0);
              }}
              onKeyDown={onAttachKeyDown}
              onBlur={() => setAttachOpen(false)}
              title="Attach images, PDFs, documents, spreadsheets or text files"
              aria-label="Attach"
              aria-haspopup="listbox"
              aria-expanded={attachOpen}
              aria-controls={attachOpen ? listId : undefined}
              aria-activedescendant={attachOpen ? optionId(index) : undefined}
            >
              <Icon name="plus" size={14} />
            </button>
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
              <button className="send-btn" onClick={send} disabled={!text.trim() && images.length === 0 && files.length === 0} title="Send (Enter)" aria-label="Send">
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
