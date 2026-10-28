import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentEvent, ApprovalRequest, FileChange, runAgent } from '../agent/AgentLoop';
import { emptyBoard } from '../agent/board';
import { formatEnvironment } from '../agent/environment';
import { gatherEnvironment } from '../agent/gatherEnvironment';
import { loadProjectInstructions } from '../agent/projectInstructions';
import { buildUserContent } from '../agent/ContextBuilder';
import { gatherContext } from '../agent/gatherContext';
import { Retrieval, Retriever } from '../agent/retrieve';
import { resolveInWorkspace } from '../safety/workspaceGuard';
import { pruneAttachments } from '../agent/attachments';
import { repairToolPairs } from '../agent/contextManager';
import { ReadResult, readAttachment } from '../agent/fileReaders';
import { buildSubagentPrompt, buildSystemPrompt } from '../agent/SystemPrompt';
import { Slots, createSubagentRunner } from '../agent/subagents';
import { AnthropicProvider } from '../providers/AnthropicProvider';
import { OpenAIProvider, openAIEndpointProblem, usesOpenAI } from '../providers/OpenAIProvider';
import { ChatMessage, ModelProvider, describeError } from '../providers/ModelProvider';
import { CommandRuleStore } from '../storage/commandRules';
import { SecretStore } from '../storage/secrets';
import { Session, SessionStore, newSession, titleFrom } from '../storage/sessions';
import { readSettings } from '../storage/settings';
import { Checkpoint, withCheckpoint } from '../safety/checkpoints';
import { ChatChangeStore } from '../safety/chatChanges';
import { isAutoApproved } from '../safety/approvalPolicy';
import {
  CommandRule,
  compileAnchoredPatterns,
  compilePatterns,
  describeRule,
  hasShellSyntax,
  suggestCommandRule,
} from '../safety/commandPolicy';
import { Logger } from '../logging';
import { Notifier } from '../notifications/Notifier';
import { VoiceSession, startVoiceSession } from '../voice/voiceServer';
import { endpointProblem, transcribe } from '../voice/transcribe';
import { appWindowArgs, findAppBrowser } from '../voice/appWindow';
import { McpConfigStore, McpServerEntry } from '../mcp/McpConfigStore';
import { McpManager } from '../mcp/McpManager';
import { normalizeDirectory } from '../mcp/paths';
import { MCP_PRESETS, McpPreset, buildEntry } from '../mcp/presets';
import { McpTrustStore } from '../storage/mcpTrust';
import { createRegistry } from '../tools';
import { createDelegateTaskTool } from '../tools/delegateTask';
import { Tool, ToolRegistry } from '../tools/Tool';
import { createDiagnosticsReader, createVscodeFilePort } from '../tools/vscodeHost';
import { ProcessManager } from '../tools/processes';
import { describeActivity } from './activity';
import { MAX_LIVE_OUTPUT_CHARS, applyHostEvent } from './displayReducer';
import { ChangeLog } from './changeLog';
import { ProposalContentProvider } from './ProposalContentProvider';
import {
  ApprovalDecision,
  FileAttachment,
  HostToWebview,
  ImageAttachment,
  MAX_FILES,
  MAX_IMAGES,
  MAX_UPLOAD_BYTES,
  ProcessAction,
  ProcessView,
  TaskView,
  WebviewToHost,
  isWebviewToHost,
} from './protocol';

interface Run {
  text: string;
  includeActive: boolean;
  mentions: string[];
  plan: boolean;
  images: ImageAttachment[];
  files: FileAttachment[];
  /** A resumed run: keep the earlier revert point so the whole task can be undone together. */
  continueTask?: boolean;
  /** Already in the transcript: sent while an earlier run worked, which did not get to read it. */
  shown?: boolean;
}

/** One run that answers several messages, as if they had been sent together. */
function mergeRuns(runs: Run[]): Run {
  return {
    text: runs.map((r) => r.text).filter(Boolean).join('\n\n'),
    includeActive: runs.some((r) => r.includeActive),
    mentions: [...new Set(runs.flatMap((r) => r.mentions))],
    plan: runs[0].plan,
    images: runs.flatMap((r) => r.images),
    files: runs.flatMap((r) => r.files),
    continueTask: runs[0].continueTask,
    shown: true,
  };
}

/**
 * One chat's runs: everything that has to outlive switching to another chat, so the agent keeps
 * working there. Each chat's runs go one at a time; different chats run side by side.
 */
interface ChatRun {
  session: Session;
  /** The run in progress, if any. */
  abort?: AbortController;
  /** Settles when the chat's latest run has finished. Runs share the history, so they go one at a time. */
  running: Promise<void>;
  /** Runs waiting for the one before them to stop. */
  queuedRuns: number;
  /** Messages sent while a run was working, for it to read before its next step. */
  steering: { run: Run; content: ChatMessage['content'] }[];
  lastRun?: Run;
  pendingApprovals: Map<string, (d: ApprovalDecision) => void>;
  pendingTools: Map<string, ApprovalRequest>;
  /** Tools the user allowed for the rest of this chat. */
  alwaysAllowed: Set<string>;
  startedAt: number;
  plan: boolean;
  /** Waiting for another chat's run to finish (`mitram.maxConcurrentRuns`). */
  queuedForSlot: boolean;
  /** Files the run in progress wrote, so another chat's edit to one of them comes with a warning. */
  touched: Set<string>;
  usage?: Extract<HostToWebview, { type: 'usage' }>;
  /** How the last run ended, shown again when the chat is opened. Cleared when the next run starts. */
  ended?: { kind: 'done' } | { kind: 'paused'; reason: 'steps' | 'time' | 'stuck'; steps: number } | { kind: 'error'; message: string; needsSetup: boolean };
  /** It ended while another chat was on screen and has not been opened since. */
  unread: boolean;
  /** The chat was deleted: its run must not save it back. */
  deleted: boolean;
}

function newChatRun(session: Session): ChatRun {
  return {
    session,
    running: Promise.resolve(),
    queuedRuns: 0,
    steering: [],
    pendingApprovals: new Map(),
    pendingTools: new Map(),
    alwaysAllowed: new Set(),
    startedAt: 0,
    plan: false,
    queuedForSlot: false,
    touched: new Set(),
    unread: false,
    deleted: false,
  };
}

const SLOT_NOTE = 'Waiting for another chat to finish…';
/** How often the list of chats working out of sight is refreshed while they work. */
const TASKS_THROTTLE_MS = 500;

const MODEL_KEY = 'mitram.model';
/** Steps one sub-agent may take: enough for a focused task, short of the main agent's budget. */
const SUBAGENT_MAX_STEPS = 40;
/** Marks a diff URI whose text comes from the change log rather than from a stored proposal. */
const CHANGE_QUERY = 'change:';
/** How long streamed text is gathered before it is sent to the webview. Short enough to read as live. */
const DELTA_FLUSH_MS = 40;
/** How often the terminals panel gets a watched process's new output. */
const PROCESS_FLUSH_MS = 200;
/** How long the changed-files panel waits after an edit before reading the files again. */
const CHANGES_DEBOUNCE_MS = 300;
/** How long the small voice window gets to load its page before the default browser is used. */
const PAGE_LOAD_MS = 6000;
/** How long a new message waits for the run it interrupts to stop. A command can hold its run open. */
const STOP_WAIT_MS = 5000;
const OTHER_MODEL = 'Enter another model or deployment name…';

const FILE_EXCLUDE = '**/{node_modules,.git,dist,out,build,.vscode-test}/**';
const FILE_CACHE_MS = 10_000;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'mitram.chatView';

  private view?: vscode.WebviewView;
  private session: Session = newSession();
  /** Run state of each chat that has run in this window, by session id. */
  private readonly runs = new Map<string, ChatRun>();
  /** Runs working at once across chats; more wait their turn. */
  private readonly runSlots = new Slots(() => readSettings().maxConcurrentRuns);
  private tasksTimer?: NodeJS.Timeout;
  /** Commands the agent left running: dev servers, watchers. Killed when the extension stops. */
  private readonly processes = new ProcessManager();
  /** The process whose output the terminals panel shows, and output not yet sent to it. */
  private watchedProcess?: string;
  private processText = '';
  private processTimer?: NodeJS.Timeout;
  /** Terminals mirroring a process, so asking again shows the same one. */
  private readonly processTerminals = new Map<string, vscode.Terminal>();
  private contextWindow = 200_000;
  private readonly toolNames = new Map<string, string>();
  private lastEditor?: vscode.TextEditor;
  private fileCache?: { at: number; files: string[] };
  private readonly retriever = new Retriever((message) => this.logger.info(message));
  private loaded?: Promise<void>;
  private readonly checkpoints = new Map<string, Checkpoint>();
  /** What each finished edit changed, for the diff a card opens. Lost when the window reloads. */
  private readonly changes = new ChangeLog();
  private voice?: VoiceSession;
  private pendingDelta?: { session: Session; type: 'streamDelta' | 'thinkingDelta'; text: string; at?: number };
  private deltaTimer?: NodeJS.Timeout;
  private readonly notifier = new Notifier({
    mode: () => readSettings().notifications,
    viewVisible: () => !!this.view?.visible,
    openChat: () => this.focus(),
    log: (message) => this.logger.info(message),
  });

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: SecretStore,
    private readonly store: SessionStore,
    private readonly chatChanges: ChatChangeStore,
    private readonly proposals: ProposalContentProvider,
    private readonly state: vscode.Memento,
    private readonly commandRules: CommandRuleStore,
    private readonly logger: Logger,
    subscriptions: vscode.Disposable[],
    private readonly mcp?: McpManager,
    private readonly mcpConfig?: McpConfigStore,
    private readonly trust?: McpTrustStore,
  ) {
    this.lastEditor = pickEditor(vscode.window.activeTextEditor);
    this.processes.onEvent((event) => {
      if (event.type === 'output') {
        if (event.id === this.watchedProcess) this.queueProcessOutput(event.text);
      } else {
        this.postProcesses();
        // A restart starts the output afresh.
        if (event.type === 'start' && event.info.id === this.watchedProcess) this.watchProcess(event.info.id);
      }
    });
    this.proposals.setResolver((uri) => {
      const m = new RegExp(`^${CHANGE_QUERY}(before|after):(.+)$`).exec(uri.query);
      const change = m ? this.changes.get(m[2]).find((c) => `/${c.path}` === uri.path) : undefined;
      return change ? (m![1] === 'before' ? (change.before ?? '') : change.after) : undefined;
    });
    subscriptions.push(
      { dispose: () => this.retriever.dispose() },
      { dispose: () => this.voice?.cancel() },
      vscode.window.onDidChangeActiveTextEditor((e) => {
        this.lastEditor = pickEditor(e) ?? this.lastEditor;
        this.postContextInfo();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === this.lastEditor) this.postContextInfo();
      }),
      // A file the chat changed was edited by hand: its line counts in the panel move too.
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.session.changes?.some((c) => c.abs === doc.uri.fsPath)) this.postChatChanges();
      }),
      { dispose: () => clearTimeout(this.changesTimer) },
      { dispose: () => clearTimeout(this.tasksTimer) },
      { dispose: () => clearTimeout(this.processTimer) },
      { dispose: () => this.processes.dispose() },
      vscode.window.onDidCloseTerminal((t) => {
        for (const [id, terminal] of this.processTerminals) if (terminal === t) this.processTerminals.delete(id);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mitram.model')) this.postModel();
        if (e.affectsConfiguration('mitram.collapseToolCalls')) this.postDisplaySettings();
        // Reconnect when the servers change, so edits to settings.json take effect without a reload.
        if (e.affectsConfiguration('mitram.mcpServers')) void this.refreshMcp();
      }),
    );
  }

  /** Reconnects MCP servers after a settings change and tells the webview. */
  private async refreshMcp(): Promise<void> {
    await this.mcp?.refresh();
    this.postMcpStatus();
  }

  /** Sends the MCP panel fresh data. Called by the manager whenever a server's state changes. */
  refreshMcpPanel(): void {
    this.postMcpStatus();
  }

  /**
   * The "Add MCP server" wizard: pick a preset (or describe a custom server), answer what it
   * needs, then store its API key.
   *
   * It runs entirely in the host, through VS Code's own prompts. That is deliberate: the key is
   * typed into a native password box and goes straight to secret storage, so it never passes
   * through the webview or into settings.json.
   */
  private async addMcpServer(): Promise<void> {
    if (!this.mcpConfig) return;

    const items: (vscode.QuickPickItem & { preset?: McpPreset })[] = [
      ...MCP_PRESETS.map((preset) => ({
        label: preset.label,
        detail: preset.description,
        description: preset.secret ? 'needs an API key' : undefined,
        preset,
      })),
      { label: 'Custom…', detail: 'Enter a command or URL yourself.' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Add MCP server',
      placeHolder: 'Choose a server to add',
      matchOnDetail: true,
    });
    if (!picked) return;

    const added = picked.preset ? await this.addFromPreset(picked.preset) : await this.addCustomMcpServer();
    if (!added) return;

    // A server the user just added is one they mean to run.
    this.mcp?.resetTrust();
    await this.mcpTrustSet(true);
    await this.mcp?.refresh();
    this.postMcpStatus();
    void vscode.window.showInformationMessage(`M.I.T.R.A.M: added the MCP server "${added}".`);
    // Adding a server that signs in through the browser means signing in now, not on the first message.
    if (this.mcpConfig?.list().servers.find((s) => s.id === added)?.auth?.kind === 'oauth') {
      await this.mcp?.signIn(added);
      this.postMcpStatus();
    }
  }

  /** Asks for a preset's fields and key, then writes it to settings. Returns the new server id. */
  private async addFromPreset(preset: McpPreset): Promise<string | undefined> {
    const answers: Record<string, string> = {};
    for (const field of preset.fields ?? []) {
      const folder = field.kind === 'directory';
      const pathEnv = { platform: process.platform, home: os.homedir(), env: process.env, base: workspaceRoot() };
      const value = await vscode.window.showInputBox({
        title: `Add ${preset.label}`,
        prompt: field.label,
        placeHolder: folder ? examplePath() : field.placeholder,
        // `hint` explains where to find the value, so keep it visible while typing.
        ignoreFocusOut: true,
        // A folder defaults to the open project, which is what people almost always mean.
        value: folder ? workspaceRoot() : field.id === 'url' ? field.placeholder : undefined,
        validateInput: (text) => {
          if (!text.trim()) return `${field.label} is required.`;
          if (!folder) return null;
          const dir = normalizeDirectory(text, pathEnv);
          if (!dir) return 'Enter the full path of a folder, e.g. ' + examplePath();
          return isDirectory(dir) ? null : `"${dir}" is not a folder that exists on this machine.`;
        },
      });
      if (value === undefined) return undefined;
      // Written the way this platform's programs expect: no quotes, one kind of slash, no trailing one.
      answers[field.id] = folder ? (normalizeDirectory(value, pathEnv) ?? value.trim()) : value.trim();
    }

    const id = this.mcpConfig!.freeId(preset.id);
    if (preset.secret && !(await this.promptMcpKey(id, preset.secret.label, preset.secret.hint))) return undefined;

    await this.mcpConfig!.add(id, buildEntry(preset, answers));
    return id;
  }

  /** The "Custom…" path: a command line or a URL, typed by the user. */
  private async addCustomMcpServer(): Promise<string | undefined> {
    const kind = await vscode.window.showQuickPick(
      [
        { label: 'Local command', detail: 'Run a server on this machine, e.g. npx -y @playwright/mcp@latest', local: true },
        { label: 'Remote URL', detail: 'Connect to a server over https', local: false },
      ],
      { title: 'Add MCP server', placeHolder: 'How should M.I.T.R.A.M reach this server?' },
    );
    if (!kind) return undefined;

    const name = await vscode.window.showInputBox({
      title: 'Add MCP server',
      prompt: 'A short name for this server',
      placeHolder: 'my-server',
      ignoreFocusOut: true,
      validateInput: (text) => (text.trim() ? null : 'A name is required.'),
    });
    if (name === undefined) return undefined;

    const entry: McpServerEntry = {};
    if (kind.local) {
      const command = await vscode.window.showInputBox({
        title: 'Add MCP server',
        prompt: 'The command that starts the server',
        placeHolder: 'npx -y @playwright/mcp@latest',
        ignoreFocusOut: true,
        validateInput: (text) => (text.trim() ? null : 'A command is required.'),
      });
      if (command === undefined) return undefined;
      // Split on whitespace: good enough for the "program arg arg" form these commands take.
      const parts = command.trim().split(/\s+/);
      entry.command = parts[0];
      if (parts.length > 1) entry.args = parts.slice(1);
    } else {
      const url = await vscode.window.showInputBox({
        title: 'Add MCP server',
        prompt: 'The server URL',
        placeHolder: 'https://mcp.example.com/mcp',
        ignoreFocusOut: true,
        validateInput: (text) => {
          const value = text.trim();
          if (!value) return 'A URL is required.';
          try {
            const parsed = new URL(value);
            const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
            return parsed.protocol === 'https:' || local ? null : 'The URL must use https, unless it points at localhost.';
          } catch {
            return 'That is not a valid URL.';
          }
        },
      });
      if (url === undefined) return undefined;
      entry.url = url.trim();
    }

    const id = this.mcpConfig!.freeId(name);
    const wantsKey = await vscode.window.showQuickPick(
      [
        { label: 'No authentication', needsKey: false, oauth: false },
        { label: 'API key', detail: 'Stored in VS Code secret storage, never in settings.json', needsKey: true, oauth: false },
        ...(kind.local
          ? []
          : [{ label: 'Sign in with your browser (OAuth)', detail: 'For servers such as Atlassian and Sentry that offer it. No key to paste', needsKey: false, oauth: true }]),
      ],
      { title: `Add ${id}`, placeHolder: 'Does this server need an API key?' },
    );
    if (!wantsKey) return undefined;

    if (wantsKey.oauth) entry.auth = { kind: 'oauth' };

    if (wantsKey.needsKey) {
      const header = kind.local
        ? await vscode.window.showInputBox({
            title: `Add ${id}`,
            prompt: 'Name of the environment variable that holds the key',
            placeHolder: 'API_TOKEN',
            ignoreFocusOut: true,
            validateInput: (text) => (text.trim() ? null : 'A name is required.'),
          })
        : 'Authorization';
      if (header === undefined) return undefined;
      entry.auth = kind.local
        ? { kind: 'env', name: header.trim() }
        : { kind: 'header', name: 'Authorization', format: 'Bearer {key}' };
      if (!(await this.promptMcpKey(id, `API key for ${id}`, 'Stored in VS Code secret storage, never in settings.json.'))) {
        return undefined;
      }
    }

    await this.mcpConfig!.add(id, entry);
    return id;
  }

  /** Prompts for a server's API key and stores it. The key never leaves the host. */
  private async promptMcpKey(id: string, label: string, hint: string): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: label,
      prompt: hint,
      password: true,
      ignoreFocusOut: true,
      validateInput: (text) => (text.trim() ? null : 'A key is required.'),
    });
    if (key === undefined) return false;
    await this.secrets.setMcpKey(id, key.trim());
    return true;
  }

  /** Sets or replaces one server's API key, then reconnects it. */
  private async setMcpKey(id: string): Promise<void> {
    const server = this.mcp?.status().find((s) => s.id === id);
    if (!server) return;
    const stored = await this.promptMcpKey(id, `API key for ${id}`, 'Stored in VS Code secret storage, never in settings.json.');
    if (!stored) return;
    await this.mcp?.restart(id);
    this.postMcpStatus();
  }

  /** Removes a server after confirming, and forgets its API key. */
  private async removeMcpServer(id: string): Promise<void> {
    if (!this.mcpConfig?.has(id)) return;
    const choice = await vscode.window.showWarningMessage(
      `Remove the MCP server "${id}"?`,
      { modal: true, detail: 'Its settings entry and any stored API key are deleted. You can add it again later.' },
      'Remove',
    );
    if (choice !== 'Remove') return;

    await this.mcpConfig.remove(id);
    // Leaving a key behind would quietly reauthenticate a server added again under the same name.
    await this.secrets.clearMcpKey(id);
    await this.secrets.clearMcpOAuth(id);
    await this.refreshMcp();
  }

  /** Records that this workspace may run MCP servers, after the user added one deliberately. */
  private async mcpTrustSet(trusted: boolean): Promise<void> {
    await this.trust?.set(trusted);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.html = this.getHtml(view.webview, distUri);

    view.webview.onDidReceiveMessage((message: unknown) => {
      if (isWebviewToHost(message)) void this.handle(message);
    });
  }

  focus(): void {
    void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  /** Opens an empty chat. A run in the chat being left keeps going. */
  async newChat(): Promise<void> {
    this.session = newSession();
    await this.store.setActive(null);
    this.showSession();
  }

  /** The run state of a chat, created the first time it is needed. */
  private chatRun(session: Session): ChatRun {
    let chat = this.runs.get(session.id);
    if (!chat) {
      chat = newChatRun(session);
      this.runs.set(session.id, chat);
    }
    return chat;
  }

  /** Posts to the webview only while this chat is the one on screen. */
  private postFor(session: Session, message: HostToWebview): void {
    if (session === this.session) this.post(message);
  }

  post(message: HostToWebview): void {
    // Keep the order the events happened in: any text still waiting goes out first.
    this.flushDeltas();
    this.send(message);
  }

  private send(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  /** Sends a transcript event to the webview and records it in the saved session. */
  private emit(session: Session, event: HostToWebview): void {
    if (event.type === 'streamDelta' || event.type === 'thinkingDelta') {
      this.queueDelta(session, event);
      return;
    }
    this.flushDeltas();
    session.display = applyHostEvent(session.display, event);
    if (session === this.session) this.send(event);
    // What a chat out of sight is doing shows in the task list.
    else this.postTasks();
  }

  /**
   * Streamed text arrives a few words at a time, often dozens of times a second. Each piece used
   * to cost a message to the webview, a re-render and a copy of the transcript, so pieces of the
   * same kind are joined and sent every {@link DELTA_FLUSH_MS} instead.
   */
  private queueDelta(session: Session, event: Extract<HostToWebview, { type: 'streamDelta' | 'thinkingDelta' }>): void {
    const pending = this.pendingDelta;
    if (pending && (pending.session !== session || pending.type !== event.type)) this.flushDeltas();
    const at = event.type === 'thinkingDelta' ? event.at : undefined;
    if (this.pendingDelta) {
      this.pendingDelta.text += event.text;
      this.pendingDelta.at = at ?? this.pendingDelta.at;
    } else {
      this.pendingDelta = { session, type: event.type, text: event.text, at };
    }
    this.deltaTimer ??= setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS);
  }

  private flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    const pending = this.pendingDelta;
    if (!pending) return;
    this.pendingDelta = undefined;
    const event: HostToWebview =
      pending.type === 'thinkingDelta' ? { type: 'thinkingDelta', text: pending.text, at: pending.at } : { type: 'streamDelta', text: pending.text };
    pending.session.display = applyHostEvent(pending.session.display, event);
    if (pending.session === this.session) this.send(event);
  }

  private resolvePending(chat: ChatRun, decision: ApprovalDecision): void {
    for (const resolve of chat.pendingApprovals.values()) resolve(decision);
    chat.pendingApprovals.clear();
  }

  private async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.init();
        break;
      case 'sendMessage': {
        const run: Run = {
          text: message.text,
          includeActive: message.includeActive,
          mentions: message.mentions,
          plan: message.plan,
          images: message.images,
          files: message.files,
        };
        const chat = this.chatRun(this.session);
        if (this.canSteer(chat, run)) await this.steer(chat, run);
        else await this.startRun(this.session, run, false);
        break;
      }
      case 'retry': {
        const last = this.runs.get(this.session.id)?.lastRun;
        if (last) await this.startRun(this.session, last, true);
        break;
      }
      case 'stop': {
        // Only the chat on screen: others keep working.
        const chat = this.runs.get(this.session.id);
        if (chat) {
          chat.abort?.abort();
          this.resolvePending(chat, 'reject');
        }
        break;
      }
      case 'approval': {
        const pending = this.runs.get(this.session.id)?.pendingApprovals;
        pending?.get(message.id)?.(message.decision);
        pending?.delete(message.id);
        break;
      }
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'mitram');
        break;
      case 'setApiKey':
        void vscode.commands.executeCommand(usesOpenAI(readSettings(), this.activeModel()) ? 'mitram.setOpenAIApiKey' : 'mitram.setApiKey');
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'switchSession':
        await this.switchSession(message.id);
        break;
      case 'deleteSession':
        await this.deleteSession(message.id);
        break;
      case 'pickModel':
        await this.pickModel();
        break;
      case 'managePermissions':
        await this.manageAllowedCommands();
        break;
      case 'pickFiles':
        await this.pickFiles();
        break;
      case 'readFiles':
        await this.readFiles(message.uris);
        break;
      case 'attachFileData':
        this.deliverAttachments([readAttachment(message.name, Buffer.from(message.data, 'base64'))]);
        break;
      case 'viewDiff':
        await this.viewDiff(message.id);
        break;
      case 'voiceStart':
        await this.startVoice();
        break;
      case 'voiceCancel':
        this.voice?.cancel();
        break;
      case 'viewChange':
        await this.viewChange(message.id);
        break;
      case 'openFile':
        await this.openFile(message.path, message.line);
        break;
      case 'revert':
        await this.revert();
        break;
      case 'viewChatChange':
        await this.viewChatChange(message.path);
        break;
      case 'revertChatFile':
        await this.revertChat(message.path);
        break;
      case 'revertChat':
        await this.revertChat();
        break;
      case 'keepChatChanges':
        await this.keepChatChanges();
        break;
      case 'watchProcess':
        this.watchProcess(message.id);
        break;
      case 'processAction':
        await this.processAction(message.id, message.action);
        break;
      case 'clearBoard':
        await this.clearBoard();
        break;
      case 'continueRun':
        await this.startRun(
          this.session,
          { text: 'Continue where you left off.', includeActive: false, mentions: [], plan: false, images: [], files: [], continueTask: true },
          false,
        );
        break;
      case 'insertCode':
        await this.insertCode(message.code);
        break;
      case 'copyCode':
        await vscode.env.clipboard.writeText(message.code);
        break;
      case 'searchFiles':
        this.post({
          type: 'fileResults',
          query: message.query,
          files: await this.searchFiles(message.query),
        });
        break;
      case 'mcpRefresh':
        this.postMcpStatus();
        break;
      case 'mcpAdd':
        await this.addMcpServer();
        break;
      case 'mcpRemove':
        await this.removeMcpServer(message.id);
        break;
      case 'mcpEnable':
        await this.mcpConfig?.setEnabled(message.id, message.enabled);
        await this.refreshMcp();
        break;
      case 'mcpSetKey':
        await this.setMcpKey(message.id);
        break;
      case 'mcpSignIn':
        await this.mcp?.signIn(message.id);
        this.postMcpStatus();
        break;
      case 'mcpSignOut':
        await this.mcp?.signOut(message.id);
        this.postMcpStatus();
        break;
      case 'mcpRestart':
        await this.mcp?.restart(message.id);
        this.postMcpStatus();
        break;
    }
  }

  private async init(): Promise<void> {
    this.loaded ??= this.store.load().then(() => {
      const active = this.store.activeId ? this.store.get(this.store.activeId) : undefined;
      if (active) this.session = active;
      // Earlier content kept for chats that have since been deleted or dropped from the list.
      void this.chatChanges.prune(this.store.list().map((s) => s.id));
    });
    await this.loaded;
    // Build the code index while the user types, so the first message doesn't wait for it.
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root && readSettings().retrieveContext) void this.retriever.warm(root);
    // The view is rebuilt each time it is shown again, so everything is sent afresh.
    this.showSession();
    this.postContextInfo();
    this.postModel();
    this.postDisplaySettings();
  }

  private postDisplaySettings(): void {
    this.post({ type: 'displaySettings', collapseToolCalls: readSettings().collapseToolCalls });
  }

  /** Shows another chat. A run in the chat being left keeps going. */
  private async switchSession(id: string): Promise<void> {
    const target = this.store.get(id);
    if (!target) return;
    this.session = target;
    await this.store.setActive(id);
    this.showSession();
  }

  /** Sends everything the webview shows for the chat on screen, after a switch or when the view is rebuilt. */
  private showSession(): void {
    this.postSessions();
    this.post({ type: 'loadMessages', messages: this.session.display });
    this.postRunState();
    this.postBoard();
    this.postCheckpoint();
    this.postChatChanges();
    this.postTasks();
    // Whether a process is "this chat's" depends on the chat on screen.
    this.postProcesses();
  }

  /** Restores what loadMessages resets: a run still going, how the last one ended, and usage. */
  private postRunState(): void {
    const chat = this.runs.get(this.session.id);
    if (!chat) return;
    chat.unread = false;
    if (chat.usage) this.post(chat.usage);
    if (chat.abort) {
      this.post({ type: 'runInProgress', since: chat.startedAt, plan: chat.plan });
      if (chat.queuedForSlot) this.post({ type: 'statusNote', text: SLOT_NOTE });
      this.postSteering(chat);
      return;
    }
    const ended = chat.ended;
    if (ended?.kind === 'error') this.post({ type: 'error', message: ended.message, needsSetup: ended.needsSetup });
    else if (ended?.kind === 'paused') this.post({ type: 'budgetReached', reason: ended.reason, steps: ended.steps });
    else if (ended?.kind === 'done' && chat.plan) this.post({ type: 'planReady' });
  }

  /** Sends the chats working, or finished, out of sight. Called often while they work, so throttled. */
  private postTasks(): void {
    this.tasksTimer ??= setTimeout(() => {
      this.tasksTimer = undefined;
      this.sendTasks();
    }, TASKS_THROTTLE_MS);
  }

  private sendTasks(): void {
    const tasks: TaskView[] = [];
    for (const chat of this.runs.values()) {
      if (chat.session === this.session || chat.deleted) continue;
      const { session, ended } = chat;
      const base = { id: session.id, title: session.title, since: chat.startedAt };
      if (chat.abort) {
        const activity = describeActivity(session.display);
        if (chat.queuedForSlot) tasks.push({ ...base, status: 'queued', label: SLOT_NOTE });
        else tasks.push({ ...base, status: activity.waitingForUser ? 'waiting' : 'working', label: activity.label });
      } else if (chat.unread && ended) {
        if (ended.kind === 'error') tasks.push({ ...base, status: 'error', label: ended.message });
        else if (ended.kind === 'paused') tasks.push({ ...base, status: 'paused', label: 'Paused: open the chat to continue' });
        else tasks.push({ ...base, status: 'done', label: chat.plan ? 'Plan ready' : 'Finished' });
      }
    }
    this.post({ type: 'tasks', tasks });
  }

  private async deleteSession(id: string): Promise<void> {
    const chat = this.runs.get(id);
    if (chat) {
      chat.deleted = true;
      chat.abort?.abort();
      this.resolvePending(chat, 'reject');
      this.runs.delete(id);
    }
    // Its dev servers and watchers go with it.
    void this.processes.stopOwner(id);
    await this.store.delete(id);
    void this.chatChanges.remove(id);
    if (this.session.id === id) {
      await this.newChat();
    } else {
      this.postSessions();
      this.postTasks();
    }
  }

  private postSessions(): void {
    this.post({
      type: 'sessions',
      list: this.store.list().map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
      activeId: this.store.get(this.session.id) ? this.session.id : null,
    });
  }

  private postBoard(): void {
    this.post({ type: 'board', board: this.session.board ?? emptyBoard() });
  }

  /**
   * Sends the MCP panel its data. `hasKey` only says whether a key is stored; the key itself
   * never leaves the host.
   */
  private postMcpStatus(): void {
    if (!this.mcp) return;
    void (async () => {
      const servers = this.mcp!.status();
      const ids = servers.map((s) => s.id);
      const [stored, signedIn] = await Promise.all([this.secrets.mcpKeysPresent(ids), this.secrets.mcpOAuthPresent(ids)]);
      this.post({
        type: 'mcpStatus',
        servers: servers.map((s) => ({ ...s, hasKey: stored.has(s.id), signedIn: signedIn.has(s.id) })),
        presets: MCP_PRESETS.map(({ id, label, description, secret }) => ({ id, label, description, needsKey: !!secret })),
        problems: this.mcpConfig?.list().problems ?? [],
      });
    })();
  }

  private async clearBoard(): Promise<void> {
    this.session.board = emptyBoard();
    await this.store.save(this.session);
    this.postBoard();
  }

  /** The model in use: the one picked in the UI, else the `mitram.model` setting. */
  private activeModel(): string {
    return this.state.get<string>(MODEL_KEY) || readSettings().model;
  }

  private postModel(): void {
    this.post({ type: 'modelInfo', model: this.activeModel() });
  }

  private async pickModel(): Promise<void> {
    const settings = readSettings();
    const current = this.activeModel();
    const names = [...new Set([current, settings.model, ...settings.models, ...settings.openai.models].filter(Boolean))];
    const items: vscode.QuickPickItem[] = [
      ...names.map((label) => ({
        label,
        description: [label === current ? 'current' : label === settings.model ? 'from settings' : '', usesOpenAI(settings, label) ? 'OpenAI endpoint' : '']
          .filter(Boolean)
          .join(' · ') || undefined,
      })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: OTHER_MODEL },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'M.I.T.R.A.M: Choose a model',
      placeHolder: 'Model or deployment name on your Foundry or OpenAI resource',
    });
    if (!picked) return;

    let model = picked.label;
    if (model === OTHER_MODEL) {
      const typed = await vscode.window.showInputBox({
        title: 'Model or deployment name',
        prompt: 'Add it to "mitram.models" (or "mitram.openai.models" for the OpenAI endpoint) to keep it in this list.',
        value: current,
        ignoreFocusOut: true,
      });
      if (!typed?.trim()) return;
      model = typed.trim();
    }
    await this.state.update(MODEL_KEY, model === settings.model ? undefined : model);
    this.postModel();
  }

  private postContextInfo(): void {
    const editor = this.lastEditor;
    this.post({
      type: 'contextInfo',
      file: editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : null,
      hasSelection: !!editor && !editor.selection.isEmpty,
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
    });
  }

  /**
   * Starts a run once the one before it has stopped. A message sent mid-run interrupts it, and the
   * interrupted run must record its tool results before the new message is added after them.
   */
  private async startRun(session: Session, run: Run, isRetry: boolean): Promise<void> {
    const chat = this.chatRun(session);
    chat.abort?.abort();
    this.resolvePending(chat, 'reject');
    const previous = chat.running;
    chat.queuedRuns++;
    const current = (async () => {
      try {
        await Promise.race([previous, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
      } finally {
        chat.queuedRuns--;
      }
      // Messages sent too late for a run to read them start the one after it.
      for (let next: Run | undefined = run, retry = isRetry; next; next = this.takeLeftover(chat), retry = false) {
        await this.run(session, next, retry);
      }
    })();
    chat.running = current.catch(() => undefined);
    await current;
  }

  /** True once a newer run of the same chat has taken over, or is waiting to: this one must leave the UI to it. */
  private handedOver(chat: ChatRun, abort: AbortController): boolean {
    return chat.abort !== abort || chat.queuedRuns > 0;
  }

  /** A message sent while a run works on this chat goes to that run, unless it switches plan mode. */
  private canSteer(chat: ChatRun, run: Run): boolean {
    return !!chat.abort && !chat.abort.signal.aborted && chat.queuedRuns === 0 && run.plan === chat.plan;
  }

  /** Hands a message to the run in progress, which reads it before its next step. */
  private async steer(chat: ChatRun, run: Run): Promise<void> {
    const { session } = chat;
    const active = chat.abort;
    // Typed instead of answering a prompt: the waiting call is declined, and the message says what to do.
    this.resolvePending(chat, 'reject');
    this.recordUserMessage(session, run);
    const parts = await gatherContext({ includeActive: run.includeActive, editor: this.lastEditor, mentions: run.mentions });
    const shown: Run = { ...run, shown: true };
    const content = buildUserContent(run.text, parts, '', run.images, run.files);
    if (chat.abort === active && !active?.signal.aborted) {
      chat.steering.push({ run: shown, content });
      this.postSteering(chat);
    } else {
      // The run ended while the message was being prepared: it starts the next one.
      await this.startRun(session, shown, false);
    }
  }

  /** Removes and returns the messages waiting for the chat's run. */
  private takeSteering(chat: ChatRun): { run: Run; content: ChatMessage['content'] }[] {
    const taken = chat.steering;
    if (taken.length === 0) return [];
    chat.steering = [];
    this.postSteering(chat);
    return taken;
  }

  /** The run for messages a finished run did not read, if they should get one of their own. */
  private takeLeftover(chat: ChatRun): Run | undefined {
    const left = this.takeSteering(chat);
    if (left.length === 0) return undefined;
    if (chat.queuedRuns > 0) {
      // A newer message is about to run: these go in first, so it reads everything in order.
      for (const s of left) chat.session.history.push({ role: 'user', content: s.content });
      return undefined;
    }
    return mergeRuns(left.map((s) => s.run));
  }

  private postSteering(chat: ChatRun): void {
    this.postFor(chat.session, { type: 'steering', count: chat.steering.length });
  }

  private recordUserMessage(session: Session, run: Run): void {
    session.display.push({
      role: 'user',
      text: run.text,
      ...(run.images.length ? { images: run.images } : {}),
      // The transcript only shows what was attached; the content is in the history.
      ...(run.files.length ? { files: run.files.map((f) => ({ ...f, data: '' })) } : {}),
    });
    if (session.display.length === 1) session.title = titleFrom(run.text || run.files[0]?.name || 'Image');
  }

  private async run(session: Session, run: Run, isRetry: boolean): Promise<void> {
    const chat = this.chatRun(session);
    const settings = readSettings();
    const model = this.activeModel();
    const openai = usesOpenAI(settings, model);
    const apiKey = openai ? await this.secrets.getOpenAIKey() : await this.secrets.getApiKey();
    const problem = openai
      ? openAIEndpointProblem(settings.openai.endpoint)
      : !settings.endpoint
        ? 'No endpoint configured. Set "mitram.endpoint" in your user settings to your Azure Foundry URL, or "mitram.openai.endpoint" for an OpenAI model.'
        : null;
    if (problem || !apiKey) {
      this.failRun(chat, problem ?? `No API key set. Run "M.I.T.R.A.M: Set ${openai ? 'OpenAI ' : ''}API Key".`, true);
      return;
    }

    const provider: ModelProvider = openai
      ? new OpenAIProvider({
          endpoint: settings.openai.endpoint,
          apiKey,
          model,
          apiVersion: settings.openai.apiVersion,
          maxTokens: settings.maxTokens,
        })
      : new AnthropicProvider({
          baseURL: settings.endpoint,
          apiKey,
          model,
          maxTokens: settings.maxTokens,
          promptCaching: settings.promptCaching,
          reasoning: settings.showReasoning,
        });

    this.logger.addSecret(apiKey);
    chat.abort?.abort();
    const abort = new AbortController();
    chat.abort = abort;
    // Another message is already waiting behind this one: keep this message, then hand over at once.
    if (chat.queuedRuns > 0) abort.abort();
    chat.startedAt = Date.now();
    chat.plan = run.plan;
    chat.lastRun = run;
    chat.ended = undefined;
    chat.touched.clear();
    this.postTasks();

    this.contextWindow = settings.contextWindow;
    const rootForEnv = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // Everything below is independent of the rest, and any of it can be slow (starting an MCP
    // server can take many seconds), so it all starts now and is awaited where it is needed.
    const registryPromise = rootForEnv ? createRegistry(this.mcp) : undefined;
    const instructionsPromise = rootForEnv ? loadProjectInstructions(rootForEnv) : undefined;
    const [parts, envInfo] = await Promise.all([
      gatherContext({ includeActive: run.includeActive, editor: this.lastEditor, mentions: run.mentions }),
      settings.includeEnvironment && rootForEnv ? gatherEnvironment(rootForEnv) : undefined,
    ]);

    // A run cut off mid-call (by a reload, or a command that would not stop) leaves calls unanswered,
    // and the API rejects every later request in the chat until they are.
    const repaired = repairToolPairs(session.history);
    if (repaired > 0) this.logger.info(`repaired ${repaired} unanswered tool call(s) or stray result(s) in the history`);
    const turnStart = session.history.length;
    // Code a keyword search matched to the message, so the model can start there instead of searching.
    const retrieved: Retrieval =
      settings.retrieveContext && rootForEnv && !run.continueTask && run.text.trim()
        ? await this.retriever.retrieve(rootForEnv, run.text, {
            exclude: parts.flatMap((p) => (p.kind === 'attachment' ? [] : [p.path])),
            boost: envInfo?.openTabs,
          })
        : { files: [], block: '' };
    const environment = [envInfo ? formatEnvironment(envInfo) : '', retrieved.block].filter(Boolean).join('\n');
    session.history.push({ role: 'user', content: buildUserContent(run.text, parts, environment, run.images, run.files) });
    const pruned = pruneAttachments(session.history);
    if (!isRetry && !run.shown) this.recordUserMessage(session, run);
    // Saved now, not when the run ends, so the chat is in the history list while it works and can be
    // opened again after switching away.
    if (!this.store.get(session.id)) void this.store.save(session, session === this.session).then(() => this.postSessions());
    if (!isRetry && retrieved.files.length) {
      // Show what was attached, so the user can see what the agent started from.
      const files = retrieved.files.map(({ path, startLine, endLine }) => ({ path, startLine, endLine }));
      this.emit(session, { type: 'retrieved', files });
    }
    if (pruned > 0) {
      this.emit(session, {
        type: 'notice',
        text: `Removed ${pruned} older image${pruned === 1 ? '' : 's'} or PDF${pruned === 1 ? '' : 's'} from the conversation to stay within the request size limit.`,
      });
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    // Connects MCP servers on the first run that needs them; a failed server costs only its tools.
    // Shown on the working line only while it lasts: it is not part of the conversation.
    if (root && this.mcp?.configured) this.postFor(session, { type: 'statusNote', text: 'Connecting to MCP servers…' });
    const fullRegistry = registryPromise ? await registryPromise : new ToolRegistry();
    if (root && this.mcp?.configured) this.postFor(session, { type: 'statusNote', text: '' });
    this.offerSignIn();
    if (root && this.mcp?.configured) this.postMcpStatus();
    // Plan mode: read-only tools, so nothing can change until the user approves the plan.
    // MCP tools all require approval, so readOnly() leaves them out automatically.
    const registry = run.plan ? fullRegistry.readOnly() : fullRegistry;
    // Sub-agents inherit these tools, so in plan mode they can only read as well.
    const useSubagents = !!root && settings.subagents;
    if (useSubagents) registry.register(createDelegateTaskTool({ canImplement: !run.plan }));
    session.board ??= emptyBoard();
    // A resumed run keeps the earlier revert point, so one long task can be undone as a whole.
    const existing = this.checkpoints.get(session.id);
    const checkpoint = run.continueTask && existing ? existing : new Checkpoint();
    this.checkpoints.set(session.id, checkpoint);

    const date = new Date().toISOString().slice(0, 10);
    const projectInstructions = instructionsPromise ? await instructionsPromise : null;
    const autoApprove = (tool: Tool, input: unknown) =>
      isAutoApproved(
        tool.name,
        input,
        {
          skipApprovalPrompts: settings.skipApprovalPrompts,
          autoApproveEdits: settings.autoApproveEdits,
          autoApproveSafeCommands: settings.autoApproveSafeCommands,
          autoApproveCommands: compileAnchoredPatterns(settings.autoApproveCommands),
          // Read the saved rules on every call, so "Always allow" applies within this run too.
          allowedCommands: this.commandRules.list(),
          autoApproveMcpReads: settings.autoApproveMcpReads,
          mcpReadOnlyTools: this.mcp?.readOnlyToolNames(),
        },
        chat.alwaysAllowed,
      );
    const subagents =
      useSubagents && root
        ? createSubagentRunner({
            provider,
            registry,
            system: (readOnly) => buildSubagentPrompt({ root, platform: process.platform, date, projectInstructions, readOnly }),
            maxSteps: Math.min(settings.maxIterations, SUBAGENT_MAX_STEPS),
            maxConcurrent: settings.maxParallelSubagents,
            contextWindow: settings.contextWindow,
            summarizeContext: settings.summarizeContext,
            onEvent: (parentId, event) => this.onSubagentEvent(session, parentId, event),
            onNote: (id, note) => this.emit(session, { type: 'toolNote', id, note }),
            onFileChange: (change) => this.logChange(session, change),
            isAutoApproved: autoApprove,
            requestApproval: (request, parentId) => this.askApproval(chat, request, abort.signal, parentId),
            log: (message) => this.logger.info(message),
          })
        : undefined;

    // Messages sent while this run worked that it has read, so Retry can repeat them too.
    const steered: Run[] = [];
    let pausedFor: 'steps' | 'time' | 'stuck' | undefined;
    let pausedSteps = 0;
    const pausedText = { steps: 'It used all of its steps. Open the chat to continue.', time: 'It reached the time limit. Open the chat to continue.', stuck: 'It kept repeating one action. Open the chat to guide it.' };
    this.logger.info(`run start: model=${model} api=${openai ? 'openai' : 'anthropic'} plan=${run.plan} tools=${registry.size} retry=${isRetry}`);
    try {
      if (!this.runSlots.free) {
        chat.queuedForSlot = true;
        this.postFor(session, { type: 'statusNote', text: SLOT_NOTE });
        this.postTasks();
      }
      // Past mitram.maxConcurrentRuns, the run waits here for another chat's to finish.
      await this.runSlots.use(abort.signal, async () => {
        if (chat.queuedForSlot) {
          chat.queuedForSlot = false;
          this.postFor(session, { type: 'statusNote', text: '' });
          this.postTasks();
        }
        await runAgent({
          provider,
          system: buildSystemPrompt({
            root,
            platform: process.platform,
            date,
            projectInstructions,
            planMode: run.plan,
            subagents: useSubagents,
            // Only servers that actually connected: naming one with no tools would mislead the model.
            mcpServers: this.mcp?.status().filter((s) => s.status === 'ready' && s.toolCount > 0).map((s) => s.id),
          }),
          history: session.history,
          registry,
          ctx: {
            root: root ?? '',
            signal: abort.signal,
            files: withCheckpoint(createVscodeFilePort(), checkpoint),
            diagnostics: root ? createDiagnosticsReader(root) : undefined,
            blockedCommandPatterns: compilePatterns(settings.blockedCommandPatterns),
            board: {
              get: () => session.board ?? emptyBoard(),
              set: (board) => {
                session.board = board;
                if (session === this.session) this.post({ type: 'board', board });
              },
            },
            subagents,
            processes: root
              ? {
                  owner: session.id,
                  start: (command) => this.processes.start(command, root, session.id),
                  read: (id, since) => this.processes.read(id, since),
                  stop: (id) => this.processes.stop(id),
                  list: () => this.processes.list(),
                }
              : undefined,
          },
          maxIterations: settings.maxIterations,
          maxRunMs: settings.maxRunMinutes * 60_000,
          verifyBeforeDone: settings.verifyBeforeDone,
          summarizeContext: settings.summarizeContext,
          getBoard: () => session.board ?? emptyBoard(),
          contextWindow: settings.contextWindow,
          onEvent: (event) => {
            if (event.type === 'budget') {
              pausedFor = event.reason;
              pausedSteps = event.steps;
            }
            this.onAgentEvent(session, event);
          },
          onFileChange: (change) => this.logChange(session, change),
          isAutoApproved: autoApprove,
          requestApproval: (request) => this.askApproval(chat, request, abort.signal),
          takeMessages: () =>
            this.takeSteering(chat).map(({ run, content }) => {
              steered.push(run);
              return { role: 'user', content };
            }),
        });
      });
      chat.lastRun = undefined;
      // A message it did not get to read starts the next run, which keeps the working indicator.
      const unread = chat.steering.length > 0;
      if (!this.handedOver(chat, abort) && !unread) this.postFor(session, { type: 'streamEnd' });
      const ran = Date.now() - chat.startedAt;
      chat.ended = pausedFor ? { kind: 'paused', reason: pausedFor, steps: pausedSteps } : { kind: 'done' };
      if (pausedFor) void this.notifier.notify('paused', 'M.I.T.R.A.M paused', `${session.title}: ${pausedText[pausedFor]}`, 0, this.notifyChat(session));
      else void this.notifier.notify('done', 'M.I.T.R.A.M finished', session.title, ran, this.notifyChat(session));
    } catch (error) {
      if (abort.signal.aborted) {
        // History is kept consistent by the agent loop, so a cancelled turn is not retried.
        // A newer run keeps the working indicator going, so only a plain stop ends it.
        if (!this.handedOver(chat, abort)) {
          chat.lastRun = undefined;
          this.postFor(session, { type: 'streamEnd' });
        }
      } else {
        // Drop the failed turn from the model's history so Retry starts clean.
        session.history.length = turnStart;
        // Retry asks again everything this turn was asked, including messages sent while it ran.
        const unread = this.takeSteering(chat).map((s) => s.run);
        if (steered.length || unread.length) chat.lastRun = mergeRuns([run, ...steered, ...unread]);
        const status = (error as { status?: number } | null)?.status;
        this.logger.error(`run failed: status=${status ?? 'n/a'} ${describeError(error)}`);
        this.failRun(chat, describeError(error), status === 401 || status === 403 || status === 404);
        void this.notifier.notify('error', 'M.I.T.R.A.M hit an error', `${session.title}: ${describeError(error)}`, 0, this.notifyChat(session));
      }
    } finally {
      this.flushDeltas();
      // Pick up the files this run changed, so the next message's search sees them.
      if (root && settings.retrieveContext) void this.retriever.warm(root);
      if (chat.abort === abort) {
        // Stopped before reading them: they stay in the history, so the next request still sees them.
        // (A newer run that has started reads them itself.)
        if (abort.signal.aborted) for (const s of this.takeSteering(chat)) session.history.push({ role: 'user', content: s.content });
        chat.abort = undefined;
        chat.queuedForSlot = false;
        chat.touched.clear();
        // Only this run's prompts: a newer run that already started may be waiting on its own.
        chat.pendingApprovals.clear();
        chat.pendingTools.clear();
        if (chat.ended && session !== this.session) chat.unread = true;
      }
      // A deleted chat must not come back because its run saved it.
      if (!chat.deleted) await this.store.save(session, session === this.session);
      this.postSessions();
      this.postCheckpoint();
      this.postChatChanges();
      this.postTasks();
    }
  }

  /** Records a failed run, so the error shows again when the chat is opened, and shows it if it is open now. */
  private failRun(chat: ChatRun, message: string, needsSetup: boolean): void {
    chat.ended = { kind: 'error', message, needsSetup };
    if (chat.session === this.session) this.post({ type: 'error', message, needsSetup });
    else chat.unread = true;
    this.postTasks();
  }

  /** For a notification about a chat: whether it is on screen, and how to open it. */
  private notifyChat(session: Session): { onScreen: boolean; open: () => void } {
    return {
      onScreen: session === this.session,
      open: () => {
        this.focus();
        if (session !== this.session && !this.runs.get(session.id)?.deleted) void this.switchSession(session.id);
      },
    };
  }

  private onAgentEvent(session: Session, event: AgentEvent): void {
    switch (event.type) {
      case 'text':
        this.emit(session, { type: 'streamDelta', text: event.text });
        break;
      case 'thinking':
        this.emit(session, { type: 'thinkingDelta', text: event.text, at: Date.now() });
        break;
      case 'tool_start':
        this.toolNames.set(event.id, event.name);
        this.emit(session, { ...event, type: 'toolStart' });
        break;
      case 'tool_update':
        if (event.status !== 'running' && event.status !== 'pending') {
          this.logger.info(`tool ${this.toolNames.get(event.id) ?? '?'}: ${event.status}`);
        }
        this.emit(session, { ...event, type: 'toolUpdate' });
        break;
      case 'tool_output':
        this.emit(session, { ...event, type: 'toolOutput' });
        break;
      case 'notice':
        this.logger.info(`notice: ${event.text}`);
        this.emit(session, { type: 'notice', text: event.text });
        break;
      case 'budget':
        this.logger.info(`run paused: ${event.reason} after ${event.steps} steps`);
        if (session === this.session) this.post({ type: 'budgetReached', reason: event.reason, steps: event.steps });
        break;
      case 'usage': {
        const u = event.usage;
        const message = {
          type: 'usage' as const,
          contextTokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
          contextWindow: this.contextWindow,
        };
        this.chatRun(session).usage = message;
        this.postFor(session, message);
        break;
      }
    }
  }

  /** A sub-agent's event: its tool calls go on its card, and its text and reasoning stay out of the chat. */
  private onSubagentEvent(session: Session, parentId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'tool_start':
        this.toolNames.set(event.id, event.name);
        this.emit(session, { ...event, type: 'toolStart', parentId });
        break;
      case 'tool_update':
        if (event.status !== 'running' && event.status !== 'pending') {
          this.logger.info(`subagent tool ${this.toolNames.get(event.id) ?? '?'}: ${event.status}`);
        }
        this.emit(session, { ...event, type: 'toolUpdate', parentId });
        break;
      case 'tool_output':
        this.emit(session, { ...event, type: 'toolOutput', parentId });
        break;
      case 'notice':
        this.logger.info(`subagent notice: ${event.text}`);
        break;
    }
  }

  /** `parentId` is set when a sub-agent asks: the id of its card, which shows the request. */
  private askApproval(chat: ChatRun, request: ApprovalRequest, signal: AbortSignal, parentId?: string): Promise<ApprovalDecision> {
    const { session } = chat;
    const name = request.tool.name;
    const { id } = request;
    // The host works out the rule and keeps it here, so the webview can only accept or decline it.
    const rule =
      name === 'run_command' ? suggestCommandRule(String((request.input as { command?: unknown } | null)?.command ?? '')) : null;
    if (rule) {
      this.emit(session, { type: 'toolAllowRule', id, label: describeRule(rule), usesShell: hasShellSyntax(rule.command), parentId });
    }
    const clash = this.otherChatEditing(chat, request);
    if (clash) {
      this.emit(session, {
        type: 'toolWarning',
        id,
        text: `The chat "${clash}" is also working and has changed this file. Allowing this may overwrite its edits, or the other way round.`,
        parentId,
      });
    }
    chat.pendingTools.set(id, request);
    // The agent is blocked until the user answers, so tell them even if they are in another window or chat.
    const body = session === this.session ? request.summary : `${session.title}: ${request.summary}`;
    void this.notifier.notify('approval', 'M.I.T.R.A.M needs your approval', body, 0, this.notifyChat(session));
    this.postTasks();
    const settle = () => {
      chat.pendingTools.delete(id);
      this.proposals.clear(id);
      this.postTasks();
    };
    return new Promise<ApprovalDecision>((resolve) => {
      chat.pendingApprovals.set(id, (decision) => {
        if (decision === 'always') {
          // A command is remembered as a rule for this workspace, never as "every command".
          if (rule) void this.allowCommandRule(rule);
          else if (name !== 'run_command') chat.alwaysAllowed.add(name);
        }
        settle();
        resolve(decision);
      });
      signal.addEventListener(
        'abort',
        () => {
          if (chat.pendingApprovals.delete(id)) {
            settle();
            resolve('reject');
          }
        },
        { once: true },
      );
    });
  }

  /** The title of another chat whose run in progress has written the file this edit would change. */
  private otherChatEditing(chat: ChatRun, request: ApprovalRequest): string | undefined {
    if (request.tool.name !== 'edit_file' && request.tool.name !== 'create_file') return undefined;
    const rel = (request.input as { path?: unknown } | null)?.path;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (typeof rel !== 'string' || !root) return undefined;
    const abs = path.resolve(root, rel);
    for (const other of this.runs.values()) {
      if (other !== chat && other.abort && other.touched.has(abs)) return other.session.title;
    }
    return undefined;
  }


  private async pickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      title: 'M.I.T.R.A.M: Attach files',
      openLabel: 'Attach',
      canSelectMany: true,
    });
    if (uris?.length) await this.attachFiles(uris);
  }

  /** Files copied or dragged from a file manager. Only local files are read. */
  private async readFiles(uris: string[]): Promise<void> {
    const files: vscode.Uri[] = [];
    for (const text of uris) {
      try {
        const uri = vscode.Uri.parse(text, true);
        if (uri.scheme === 'file') files.push(uri);
      } catch {
        // Not a URI: ignore it.
      }
    }
    if (files.length) await this.attachFiles(files);
  }

  /** Reads files and hands them to the webview: images to resize like a paste, other files ready to attach. */
  private async attachFiles(uris: vscode.Uri[]): Promise<void> {
    const results: ReadResult[] = [];
    const limit = MAX_IMAGES + MAX_FILES;
    if (uris.length > limit) results.push({ kind: 'error', reason: `all but the first ${limit} files` });
    for (const uri of uris.slice(0, limit)) {
      const name = path.basename(uri.fsPath);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) results.push({ kind: 'error', reason: `${name} is a folder` });
        else if (stat.size > MAX_UPLOAD_BYTES) results.push({ kind: 'error', reason: `${name} is larger than ${MAX_UPLOAD_BYTES / 1_000_000} MB` });
        else results.push(readAttachment(name, Buffer.from(await vscode.workspace.fs.readFile(uri))));
      } catch {
        results.push({ kind: 'error', reason: `${name} could not be read` });
      }
    }
    this.deliverAttachments(results);
  }

  private deliverAttachments(results: ReadResult[]): void {
    const images = results.flatMap((r) => (r.kind === 'image' ? [r.image] : []));
    const files = results.flatMap((r) => (r.kind === 'file' ? [r.file] : []));
    const skipped = results.flatMap((r) => (r.kind === 'error' ? [r.reason] : []));
    if (skipped.length) void vscode.window.showWarningMessage(`M.I.T.R.A.M: Skipped ${skipped.join('; ')}.`);
    if (images.length || files.length) this.post({ type: 'attachmentsPicked', images, files });
  }

  private async allowCommandRule(rule: CommandRule): Promise<void> {
    await this.commandRules.add(rule);
    this.logger.info('command rule added for this workspace');
    const choice = await vscode.window.showInformationMessage(
      `M.I.T.R.A.M: "${ruleLabel(rule)}" will run without asking in this workspace.`,
      'Undo',
      'Manage',
    );
    if (choice === 'Undo') await this.commandRules.remove(rule);
    else if (choice === 'Manage') await this.manageAllowedCommands();
  }

  /** Lists this workspace's "Always allow" command rules so the user can remove some. */
  async manageAllowedCommands(): Promise<void> {
    const rules = this.commandRules.list();
    if (!rules.length) {
      const open = await vscode.window.showInformationMessage(
        'M.I.T.R.A.M: No commands are always allowed in this workspace yet. Choose "Always allow" when a command asks for approval.',
        'Open Settings',
      );
      if (open) void vscode.commands.executeCommand('workbench.action.openSettings', 'mitram.autoApproveCommands');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      rules.map((rule) => ({
        label: ruleLabel(rule),
        description: rule.anyArgs ? 'with any arguments' : 'exactly as written',
        rule,
      })),
      {
        title: 'M.I.T.R.A.M: Commands that run without asking in this workspace',
        placeHolder: 'Select the rules to remove, then press Enter',
        canPickMany: true,
      },
    );
    if (!picked?.length) return;
    for (const { rule } of picked) await this.commandRules.remove(rule);
    void vscode.window.showInformationMessage(
      `M.I.T.R.A.M: Removed ${picked.length} rule${picked.length === 1 ? '' : 's'}. Those commands will ask again.`,
    );
  }

  private async viewDiff(id: string): Promise<void> {
    const request = this.runs.get(this.session.id)?.pendingTools.get(id);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!request?.tool.propose || !root) return;
    try {
      const change = await request.tool.propose(request.input, {
        root,
        signal: new AbortController().signal,
        files: createVscodeFilePort(),
      });
      const left =
        change.before === null
          ? this.proposals.set(id, change.path, 'empty', '')
          : vscode.Uri.file(change.abs);
      const right = this.proposals.set(id, change.path, 'proposed', change.after);
      await vscode.commands.executeCommand('vscode.diff', left, right, `${change.path} (proposed change)`);
    } catch (error) {
      void vscode.window.showWarningMessage(`M.I.T.R.A.M: Can't preview this change: ${(error as Error).message}`);
    }
  }

  /**
   * Voice prompt. A VS Code webview cannot use the microphone, so a page on localhost opens in the
   * user's browser, listens, and sends the text back here (see src/voice).
   */
  private async startVoice(): Promise<void> {
    this.voice?.cancel();
    const { voice } = readSettings();
    const language = voice.language;
    const configured = voice.endpoint ? endpointProblem(voice.endpoint) === null : false;

    if (voice.provider === 'endpoint' && !configured) {
      this.post({ type: 'voiceError', message: endpointProblem(voice.endpoint) ?? 'No transcription endpoint is set.' });
      const open = await vscode.window.showWarningMessage(
        'M.I.T.R.A.M: Voice input is set to use a transcription endpoint, but none is configured.',
        'Open Settings',
      );
      if (open) void vscode.commands.executeCommand('workbench.action.openSettings', 'mitram.voice');
      return;
    }

    const apiKey = configured ? await this.secrets.getVoiceKey() : undefined;
    if (apiKey) this.logger.addSecret(apiKey);
    let session: VoiceSession;
    try {
      session = await startVoiceSession({
        mode: voice.provider === 'endpoint' ? 'record' : 'browser',
        language,
        // The endpoint is also the fallback for a browser with no speech recognition.
        transcribe: configured
          ? (wav, signal) => transcribe(wav, { endpoint: voice.endpoint, apiKey, model: voice.model, language: language.split('-')[0] }, signal)
          : undefined,
      });
    } catch (error) {
      this.logger.error(`voice: could not start (${(error as Error).message})`);
      this.post({ type: 'voiceError', message: 'Could not start voice input on this machine.' });
      return;
    }
    this.voice = session;

    // Remote windows (SSH, WSL, containers) forward the port, so the local browser can reach it.
    // The small window is only trusted once its page has actually loaded: a browser can start and
    // still fail to show anything (a crash on startup, a profile that is locked), and then the
    // default browser is the way through.
    let shown = false;
    if (!vscode.env.remoteName && voice.compactWindow && (await openAppWindow(session.url))) {
      shown = await session.waitForPage(PAGE_LOAD_MS);
      if (!shown) this.logger.info('voice: the small window did not open; using the default browser');
    }
    if (!shown && !(await vscode.env.openExternal(await vscode.env.asExternalUri(vscode.Uri.parse(session.url))))) {
      session.cancel();
      this.post({ type: 'voiceError', message: 'Could not open your browser.' });
      return;
    }
    this.logger.info(`voice: listening (${voice.provider})`);
    this.post({ type: 'voiceState', state: 'listening' });

    session.result.then(
      (text) => {
        if (this.voice === session) this.post({ type: 'voiceResult', text });
      },
      (error: Error) => {
        // A cancel is the user's own choice, not a failure.
        if (this.voice === session && error.message !== 'Cancelled') this.post({ type: 'voiceError', message: error.message });
      },
    ).finally(() => {
      if (this.voice !== session) return;
      this.voice = undefined;
      this.post({ type: 'voiceState', state: 'idle' });
    });
  }

  /** Servers that asked the user to sign in, offered once each so a run is never held up by a browser. */
  private readonly signInOffered = new Set<string>();

  private offerSignIn(): void {
    for (const server of this.mcp?.status() ?? []) {
      if (server.status !== 'needs-auth' || this.signInOffered.has(server.id)) continue;
      this.signInOffered.add(server.id);
      void Promise.resolve(
        vscode.window.showInformationMessage(`M.I.T.R.A.M: the MCP server "${server.id}" needs you to sign in. Its tools are off until you do.`, 'Sign in'),
      ).then((choice) => {
        if (choice === 'Sign in') void this.mcp?.signIn(server.id).then(() => this.postMcpStatus());
      });
    }
  }

  private logChange(session: Session, { callId, abs, before, after }: FileChange): void {
    this.chatRun(session).touched.add(abs);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.changes.record(callId, { path: root ? path.relative(root, abs) : abs, abs, before, after });
    void this.chatChanges.record(session, abs, before).then(() => {
      if (session === this.session) this.postChatChanges();
    });
  }

  private changesTimer?: NodeJS.Timeout;

  /**
   * Sends the chat's changed files to the panel. Working them out reads every file, so a burst of
   * edits is answered once, a moment after the last one.
   */
  private postChatChanges(): void {
    clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => void this.sendChatChanges(), CHANGES_DEBOUNCE_MS);
  }

  private async sendChatChanges(): Promise<void> {
    const session = this.session;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const files = await this.chatChanges.summarize(session, createVscodeFilePort());
    // The user may have switched chats while the files were read.
    if (session !== this.session) return;
    this.post({
      type: 'chatChanges',
      files: files.map(({ abs, ...rest }) => ({ path: root ? path.relative(root, abs) : abs, ...rest })),
    });
  }

  /** The chat's entry for a path the webview sent back. Only files the chat recorded can be named. */
  private chatEntry(rel: string): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return this.session.changes?.find((c) => (root ? path.relative(root, c.abs) : c.abs) === rel)?.abs;
  }

  /** Opens one file's diff from before the chat to now. The right side is the live file, so it can be edited there. */
  private async viewChatChange(rel: string): Promise<void> {
    const abs = this.chatEntry(rel);
    if (!abs) return;
    const original = await this.chatChanges.original(this.session, abs);
    if (original === undefined) {
      void vscode.window.showInformationMessage(`M.I.T.R.A.M: ${rel} was too large to keep its earlier version, so there is no diff.`);
      return;
    }
    const key = `chat-${this.session.id}`;
    const left = this.proposals.set(key, rel, 'original', original ?? '');
    const exists = fs.existsSync(abs);
    const right = exists ? vscode.Uri.file(abs) : this.proposals.set(key, rel, 'deleted', '');
    const what = original === null ? 'created in this chat' : exists ? 'changes in this chat' : 'deleted in this chat';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${rel} (${what})`);
  }

  /**
   * Puts one file, or every file, back as it was before the chat. Files the chat created go to the
   * trash; other files are rewritten through the editor, so Undo there brings the change back.
   */
  private async revertChat(rel?: string): Promise<void> {
    const session = this.session;
    if (this.runs.get(session.id)?.abort) {
      void vscode.window.showInformationMessage('M.I.T.R.A.M: Stop the agent or wait for it to finish before reverting.');
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const targets = rel === undefined ? (session.changes ?? []).map((c) => c.abs) : [this.chatEntry(rel)].filter((a): a is string => !!a);
    if (targets.length === 0) return;
    if (rel === undefined) {
      const answer = await vscode.window.showWarningMessage(
        `Revert ${targets.length} file${targets.length === 1 ? '' : 's'} to how ${targets.length === 1 ? 'it was' : 'they were'} before this chat?`,
        { modal: true, detail: 'Edits you made to these files since are reverted too. Files this chat created are moved to the trash.' },
        'Revert',
      );
      if (answer !== 'Revert') return;
    }

    const port = {
      ...createVscodeFilePort(),
      remove: async (abs: string) => {
        await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: true });
      },
    };
    const relOf = (abs: string) => (root ? path.relative(root, abs) : abs);
    const reverted: string[] = [];
    const skipped: string[] = [];
    for (const abs of targets) {
      try {
        if (await this.chatChanges.revert(session, abs, port)) reverted.push(relOf(abs));
        else skipped.push(relOf(abs));
      } catch (error) {
        this.logger.error(`revert ${relOf(abs)} failed: ${describeError(error)}`);
        skipped.push(relOf(abs));
      }
    }

    const parts: string[] = [];
    if (reverted.length) parts.push(`Reverted ${reverted.length} file${reverted.length === 1 ? '' : 's'} to before this chat: ${reverted.join(', ')}.`);
    if (skipped.length) parts.push(`Could not revert ${skipped.join(', ')}.`);
    this.emit(session, { type: 'notice', text: parts.join(' ') });
    if (reverted.length) {
      // Tell the model, so it doesn't build on edits that are gone.
      session.history.push({
        role: 'user',
        content: `[The user reverted these files to how they were before this conversation: ${reverted.join(', ')}. Your earlier changes to them are gone.]`,
      });
    }
    // The last turn's revert point would now try to undo changes that are no longer there.
    if (rel === undefined) this.checkpoints.delete(session.id);
    await this.store.save(session);
    this.postCheckpoint();
    this.postChatChanges();
  }

  private postProcesses(): void {
    const title = (owner: string) => this.store.get(owner)?.title ?? (owner === this.session.id ? this.session.title : 'a deleted chat');
    const list: ProcessView[] = this.processes.list().map((p) => ({
      id: p.id,
      command: p.command,
      status: p.status,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      chat: title(p.owner),
      mine: p.owner === this.session.id,
    }));
    this.post({ type: 'processes', list });
  }

  /** Streams one process's output to the panel: what is kept so far, then what arrives. */
  private watchProcess(id?: string): void {
    clearTimeout(this.processTimer);
    this.processTimer = undefined;
    this.processText = '';
    this.watchedProcess = id;
    const out = id ? this.processes.read(id) : undefined;
    if (id && out) this.post({ type: 'processOutput', id, text: out.text.slice(-MAX_LIVE_OUTPUT_CHARS), reset: true });
  }

  /** Output arrives in many small pieces; the panel gets it a few times a second. */
  private queueProcessOutput(text: string): void {
    this.processText += text;
    this.processTimer ??= setTimeout(() => {
      this.processTimer = undefined;
      const id = this.watchedProcess;
      if (id && this.processText) this.post({ type: 'processOutput', id, text: this.processText });
      this.processText = '';
    }, PROCESS_FLUSH_MS);
  }

  private async processAction(id: string, action: ProcessAction): Promise<void> {
    switch (action) {
      case 'stop':
        await this.processes.stop(id);
        break;
      case 'restart':
        await this.processes.restart(id);
        break;
      case 'remove':
        if (this.processes.remove(id)) this.postProcesses();
        break;
      case 'terminal':
        this.openProcessTerminal(id);
        break;
    }
  }

  /**
   * Shows a process in a VS Code terminal: its output so far, then live. What is typed there goes to
   * the process (a dev server's "r to restart", say); Ctrl+C stops it. Closing the terminal leaves it running.
   */
  private openProcessTerminal(id: string): void {
    const existing = this.processTerminals.get(id);
    if (existing) {
      existing.show();
      return;
    }
    const info = this.processes.get(id);
    if (!info) return;
    const write = new vscode.EventEmitter<string>();
    const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');
    let off: (() => void) | undefined;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      open: () => {
        write.fire(`\x1b[2m$ ${info.command}\x1b[0m\r\n`);
        write.fire(crlf(this.processes.read(id)?.text ?? ''));
        off = this.processes.onEvent((event) => {
          if (event.type === 'output' && event.id === id) write.fire(crlf(event.text));
          else if (event.type === 'exit' && event.info.id === id) {
            const how = event.info.status === 'stopped' ? 'stopped' : `exited with code ${event.info.exitCode ?? 'unknown'}`;
            write.fire(`\r\n\x1b[2m[${how}]\x1b[0m\r\n`);
          } else if (event.type === 'start' && event.info.id === id) write.fire(`\r\n\x1b[2m[restarted]\x1b[0m\r\n`);
        });
      },
      close: () => {
        off?.();
        write.dispose();
        this.processTerminals.delete(id);
      },
      handleInput: (data) => {
        if (data === '\x03') {
          void this.processes.stop(id);
          return;
        }
        // The process reads a pipe, not a terminal, so typed text is echoed here and sent a line at a time.
        write.fire(data === '\r' ? '\r\n' : data);
        this.processes.write(id, data === '\r' ? '\n' : data);
      },
    };
    const terminal = vscode.window.createTerminal({ name: `${id}: ${info.command}`, pty });
    this.processTerminals.set(id, terminal);
    terminal.show();
  }

  /** Accepts the chat's changes as they are: the list and the last turn's revert point are cleared. */
  private async keepChatChanges(): Promise<void> {
    const session = this.session;
    await this.chatChanges.forget(session);
    this.checkpoints.delete(session.id);
    await this.store.save(session);
    this.postCheckpoint();
    this.postChatChanges();
  }

  /**
   * Opens what a finished edit changed: the file as it was before the call against the file as the
   * call left it. Both sides are snapshots, so the diff stays right if the file is edited later.
   */
  private async viewChange(id: string): Promise<void> {
    const [change] = this.changes.get(id);
    if (!change) {
      void vscode.window.showInformationMessage(
        'M.I.T.R.A.M: This change is no longer available. Diffs are kept until the window reloads, and are skipped for very large files.',
      );
      return;
    }
    const side = (which: 'before' | 'after') =>
      vscode.Uri.from({ scheme: ProposalContentProvider.scheme, path: `/${change.path}`, query: `${CHANGE_QUERY}${which}:${id}` });
    const left = side('before');
    const right = side('after');
    const title = `${change.path} (${change.before === null ? 'new file' : 'changed by M.I.T.R.A.M'})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  }

  private postCheckpoint(): void {
    const checkpoint = this.checkpoints.get(this.session.id);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.post({
      type: 'checkpoint',
      files: checkpoint && root ? checkpoint.paths().map((p) => path.relative(root, p)) : [],
    });
  }

  private async revert(): Promise<void> {
    const session = this.session;
    const checkpoint = this.checkpoints.get(session.id);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!checkpoint || !root || checkpoint.size === 0) return;

    const rel = (paths: string[]) => paths.map((p) => path.relative(root, p));
    const { restored, conflicts } = await checkpoint.restore(createVscodeFilePort());

    const parts: string[] = [];
    if (restored.length) parts.push(`Reverted ${restored.length} file${restored.length === 1 ? '' : 's'}: ${rel(restored).join(', ')}.`);
    if (conflicts.length) {
      parts.push(`Left ${rel(conflicts).join(', ')} alone because ${conflicts.length === 1 ? 'it was' : 'they were'} changed after the agent edited ${conflicts.length === 1 ? 'it' : 'them'}.`);
    }
    this.emit(session, { type: 'notice', text: parts.join(' ') });

    if (restored.length) {
      // Tell the model, so it doesn't assume its earlier edits are still in place.
      session.history.push({
        role: 'user',
        content: `[The user reverted your file changes from the previous turn: ${rel(restored).join(', ')}. Those files are back to their earlier content.]`,
      });
    }
    if (checkpoint.size === 0) this.checkpoints.delete(session.id);
    await this.store.save(session);
    this.postCheckpoint();
    this.postChatChanges();
  }

  /** Opens a workspace file at a line, for the links in the "related files" card. */
  private async openFile(rel: string, line: number): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const abs = root ? await resolveInWorkspace(root, rel) : null;
    if (!abs) return;
    try {
      const at = new vscode.Position(line - 1, 0);
      await vscode.window.showTextDocument(vscode.Uri.file(abs), { selection: new vscode.Range(at, at), preview: true });
    } catch {
      void vscode.window.showWarningMessage(`M.I.T.R.A.M: Could not open ${rel}.`);
    }
  }

  private async insertCode(code: string): Promise<void> {
    const editor = this.lastEditor ?? vscode.window.visibleTextEditors[0];
    if (!editor) {
      void vscode.window.showWarningMessage('M.I.T.R.A.M: No editor open to insert into.');
      return;
    }
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    await editor.edit((builder) => builder.replace(editor.selection, code));
  }

  private async searchFiles(query: string): Promise<string[]> {
    if (!this.fileCache || Date.now() - this.fileCache.at > FILE_CACHE_MS) {
      const uris = await vscode.workspace.findFiles('**/*', FILE_EXCLUDE, 5000);
      this.fileCache = {
        at: Date.now(),
        files: uris.map((u) => vscode.workspace.asRelativePath(u, false)),
      };
    }
    const q = query.toLowerCase();
    const base = (p: string) => p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    return this.fileCache.files
      .filter((p) => p.toLowerCase().includes(q))
      .sort((a, b) => {
        const rank = (p: string) => (base(p).startsWith(q) ? 0 : base(p).includes(q) ? 1 : 2);
        return rank(a) - rank(b) || a.length - b.length;
      })
      .slice(0, 8);
  }

  private getHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'assets', 'index.css'));
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${style}" />
  <title>M.I.T.R.A.M</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

/**
 * Opens `url` as a small app-style window in an installed Chromium-based browser. False if there is
 * none or it would not start, so the caller can fall back to the default browser.
 */
function openAppWindow(url: string): Promise<boolean> {
  const exists = (target: string) => {
    if (path.isAbsolute(target)) return fs.existsSync(target);
    const dirs = (process.env.PATH ?? '').split(path.delimiter);
    return dirs.some((dir) => dir && fs.existsSync(path.join(dir, target)));
  };
  const browser = findAppBrowser({ platform: process.platform, env: process.env, exists });
  if (!browser) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(browser.command, appWindowArgs(url, { platform: process.platform, env: process.env }), { detached: true, stdio: 'ignore' });
      // A launcher that hands the page to a browser that is already running exits with 0 at once;
      // one that crashes exits with a signal or an error code. Staying alive means it is showing.
      const alive = setTimeout(() => {
        child.unref();
        resolve(true);
      }, 1500);
      child.once('error', () => {
        clearTimeout(alive);
        resolve(false);
      });
      child.once('exit', (code) => {
        clearTimeout(alive);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** A sample folder in this platform's own style, for prompts and error messages. */
function examplePath(): string {
  return process.platform === 'win32' ? 'C:\\Users\\you\\projects' : '/home/you/projects';
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function pickEditor(editor: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
  return editor && editor.document.uri.scheme === 'file' ? editor : undefined;
}

/** A saved rule on one line, short enough for a notification or a list. */
function ruleLabel(rule: CommandRule, max = 80): string {
  const text = describeRule(rule).replace(/\s*\r?\n\s*/g, ' ⏎ ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
