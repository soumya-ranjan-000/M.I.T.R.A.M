import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentEvent, ApprovalRequest, runAgent } from '../agent/AgentLoop';
import { emptyBoard } from '../agent/board';
import { formatEnvironment } from '../agent/environment';
import { gatherEnvironment } from '../agent/gatherEnvironment';
import { loadProjectInstructions } from '../agent/projectInstructions';
import { formatUserMessage } from '../agent/ContextBuilder';
import { gatherContext } from '../agent/gatherContext';
import { buildSystemPrompt } from '../agent/SystemPrompt';
import { AnthropicProvider } from '../providers/AnthropicProvider';
import { describeError } from '../providers/ModelProvider';
import { SecretStore } from '../storage/secrets';
import { Session, SessionStore, newSession, titleFrom } from '../storage/sessions';
import { readSettings } from '../storage/settings';
import { Checkpoint, withCheckpoint } from '../safety/checkpoints';
import { isAutoApproved } from '../safety/approvalPolicy';
import { compileAnchoredPatterns, compilePatterns } from '../safety/commandPolicy';
import { Logger } from '../logging';
import { createDefaultRegistry } from '../tools';
import { ToolRegistry } from '../tools/Tool';
import { createDiagnosticsReader, createVscodeFilePort } from '../tools/vscodeHost';
import { applyHostEvent } from './displayReducer';
import { ProposalContentProvider } from './ProposalContentProvider';
import { ApprovalDecision, HostToWebview, WebviewToHost, isWebviewToHost } from './protocol';

interface Run {
  text: string;
  includeActive: boolean;
  mentions: string[];
  plan: boolean;
  /** A resumed run: keep the earlier revert point so the whole task can be undone together. */
  continueTask?: boolean;
}

const MODEL_KEY = 'mitram.model';
const OTHER_MODEL = 'Enter another model or deployment name…';

const FILE_EXCLUDE = '**/{node_modules,.git,dist,out,build,.vscode-test}/**';
const FILE_CACHE_MS = 10_000;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'mitram.chatView';

  private view?: vscode.WebviewView;
  private session: Session = newSession();
  private abort?: AbortController;
  private lastRun?: Run;
  private contextWindow = 200_000;
  private readonly toolNames = new Map<string, string>();
  private lastEditor?: vscode.TextEditor;
  private fileCache?: { at: number; files: string[] };
  private loaded?: Promise<void>;
  private readonly pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private readonly alwaysAllowed = new Set<string>();
  private readonly pendingTools = new Map<string, ApprovalRequest>();
  private readonly checkpoints = new Map<string, Checkpoint>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: SecretStore,
    private readonly store: SessionStore,
    private readonly proposals: ProposalContentProvider,
    private readonly state: vscode.Memento,
    private readonly logger: Logger,
    subscriptions: vscode.Disposable[],
  ) {
    this.lastEditor = pickEditor(vscode.window.activeTextEditor);
    subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        this.lastEditor = pickEditor(e) ?? this.lastEditor;
        this.postContextInfo();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === this.lastEditor) this.postContextInfo();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mitram.model')) this.postModel();
      }),
    );
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

  async newChat(): Promise<void> {
    this.abort?.abort();
    this.resolvePending('reject');
    this.alwaysAllowed.clear();
    this.session = newSession();
    this.lastRun = undefined;
    await this.store.setActive(null);
    this.postSessions();
    this.post({ type: 'loadMessages', messages: [] });
    this.postBoard();
    this.postCheckpoint();
  }

  post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  /** Sends a transcript event to the webview and records it in the saved session. */
  private emit(session: Session, event: HostToWebview): void {
    session.display = applyHostEvent(session.display, event);
    if (session === this.session) this.post(event);
  }

  private resolvePending(decision: ApprovalDecision): void {
    for (const resolve of this.pendingApprovals.values()) resolve(decision);
    this.pendingApprovals.clear();
  }

  private async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.init();
        break;
      case 'sendMessage':
        await this.run(
          { text: message.text, includeActive: message.includeActive, mentions: message.mentions, plan: message.plan },
          false,
        );
        break;
      case 'retry':
        if (this.lastRun) await this.run(this.lastRun, true);
        break;
      case 'stop':
        this.abort?.abort();
        this.resolvePending('reject');
        break;
      case 'approval':
        this.pendingApprovals.get(message.id)?.(message.decision);
        this.pendingApprovals.delete(message.id);
        break;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'mitram');
        break;
      case 'setApiKey':
        void vscode.commands.executeCommand('mitram.setApiKey');
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
      case 'viewDiff':
        await this.viewDiff(message.id);
        break;
      case 'revert':
        await this.revert();
        break;
      case 'clearBoard':
        await this.clearBoard();
        break;
      case 'continueRun':
        await this.run(
          { text: 'Continue where you left off.', includeActive: false, mentions: [], plan: false, continueTask: true },
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
    }
  }

  private async init(): Promise<void> {
    this.loaded ??= this.store.load().then(() => {
      const active = this.store.activeId ? this.store.get(this.store.activeId) : undefined;
      if (active) this.session = active;
    });
    await this.loaded;
    this.postSessions();
    this.post({ type: 'loadMessages', messages: this.session.display });
    this.postBoard();
    this.postContextInfo();
    this.postModel();
  }

  private async switchSession(id: string): Promise<void> {
    const target = this.store.get(id);
    if (!target) return;
    this.abort?.abort();
    this.resolvePending('reject');
    this.session = target;
    this.lastRun = undefined;
    await this.store.setActive(id);
    this.postSessions();
    this.post({ type: 'loadMessages', messages: target.display });
    this.postBoard();
    this.postCheckpoint();
  }

  private async deleteSession(id: string): Promise<void> {
    await this.store.delete(id);
    if (this.session.id === id) {
      await this.newChat();
    } else {
      this.postSessions();
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
    const names = [...new Set([current, settings.model, ...settings.models].filter(Boolean))];
    const items: vscode.QuickPickItem[] = [
      ...names.map((label) => ({
        label,
        description: label === current ? 'current' : label === settings.model ? 'from settings' : undefined,
      })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: OTHER_MODEL },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'M.I.T.R.A.M: Choose a model',
      placeHolder: 'Model or deployment name on your Foundry resource',
    });
    if (!picked) return;

    let model = picked.label;
    if (model === OTHER_MODEL) {
      const typed = await vscode.window.showInputBox({
        title: 'Model or deployment name',
        prompt: 'Add it to "mitram.models" to keep it in this list.',
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

  private async run(run: Run, isRetry: boolean): Promise<void> {
    const settings = readSettings();
    const apiKey = await this.secrets.getApiKey();
    if (!settings.endpoint || !apiKey) {
      this.post({
        type: 'error',
        message: !settings.endpoint
          ? 'No endpoint configured. Set "mitram.endpoint" to your Azure Foundry URL.'
          : 'No API key set. Run "M.I.T.R.A.M: Set API Key".',
        needsSetup: true,
      });
      return;
    }

    const provider = new AnthropicProvider({
      baseURL: settings.endpoint,
      apiKey,
      model: this.activeModel(),
      maxTokens: settings.maxTokens,
      promptCaching: settings.promptCaching,
      reasoning: settings.showReasoning,
    });

    this.logger.addSecret(apiKey);
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.lastRun = run;

    this.contextWindow = settings.contextWindow;
    const session = this.session;
    const parts = await gatherContext({
      includeActive: run.includeActive,
      editor: this.lastEditor,
      mentions: run.mentions,
    });

    const turnStart = session.history.length;
    const rootForEnv = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const environment =
      settings.includeEnvironment && rootForEnv ? formatEnvironment(await gatherEnvironment(rootForEnv)) : '';
    session.history.push({ role: 'user', content: formatUserMessage(run.text, parts, environment) });
    if (!isRetry) {
      session.display.push({ role: 'user', text: run.text });
      if (session.display.length === 1) session.title = titleFrom(run.text);
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const fullRegistry = root ? createDefaultRegistry() : new ToolRegistry();
    // Plan mode: read-only tools, so nothing can change until the user approves the plan.
    const registry = run.plan ? fullRegistry.readOnly() : fullRegistry;
    session.board ??= emptyBoard();
    // A resumed run keeps the earlier revert point, so one long task can be undone as a whole.
    const existing = this.checkpoints.get(session.id);
    const checkpoint = run.continueTask && existing ? existing : new Checkpoint();
    this.checkpoints.set(session.id, checkpoint);

    this.logger.info(`run start: model=${this.activeModel()} plan=${run.plan} tools=${registry.size} retry=${isRetry}`);
    try {
      await runAgent({
        provider,
        system: buildSystemPrompt({
          root,
          platform: process.platform,
          date: new Date().toISOString().slice(0, 10),
          projectInstructions: root ? await loadProjectInstructions(root) : null,
          planMode: run.plan,
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
        },
        maxIterations: settings.maxIterations,
        maxRunMs: settings.maxRunMinutes * 60_000,
        verifyBeforeDone: settings.verifyBeforeDone,
        summarizeContext: settings.summarizeContext,
        getBoard: () => session.board ?? emptyBoard(),
        contextWindow: settings.contextWindow,
        onEvent: (event) => this.onAgentEvent(session, event),
        isAutoApproved: (tool, input) =>
          isAutoApproved(
            tool.name,
            input,
            {
              autoApproveEdits: settings.autoApproveEdits,
              autoApproveSafeCommands: settings.autoApproveSafeCommands,
              autoApproveCommands: compileAnchoredPatterns(settings.autoApproveCommands),
            },
            this.alwaysAllowed,
          ),
        requestApproval: (request) => this.askApproval(request, abort.signal),
      });
      this.lastRun = undefined;
      this.post({ type: 'streamEnd' });
    } catch (error) {
      if (abort.signal.aborted) {
        // History is kept consistent by the agent loop, so a cancelled turn is not retried.
        this.lastRun = undefined;
        this.post({ type: 'streamEnd' });
      } else {
        // Drop the failed turn from the model's history so Retry starts clean.
        session.history.length = turnStart;
        const status = (error as { status?: number } | null)?.status;
        this.logger.error(`run failed: status=${status ?? 'n/a'} ${describeError(error)}`);
        this.post({
          type: 'error',
          message: describeError(error),
          needsSetup: status === 401 || status === 403 || status === 404,
        });
      }
    } finally {
      if (this.abort === abort) this.abort = undefined;
      this.pendingApprovals.clear();
      this.pendingTools.clear();
      await this.store.save(session);
      this.postSessions();
      this.postCheckpoint();
    }
  }

  private onAgentEvent(session: Session, event: AgentEvent): void {
    switch (event.type) {
      case 'text':
        this.emit(session, { type: 'streamDelta', text: event.text });
        break;
      case 'thinking':
        this.emit(session, { type: 'thinkingDelta', text: event.text });
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
      case 'notice':
        this.logger.info(`notice: ${event.text}`);
        this.emit(session, { type: 'notice', text: event.text });
        break;
      case 'budget':
        this.logger.info(`run paused: ${event.reason} after ${event.steps} steps`);
        if (session === this.session) this.post({ type: 'budgetReached', reason: event.reason, steps: event.steps });
        break;
      case 'usage':
        if (session === this.session) {
          const u = event.usage;
          this.post({
            type: 'usage',
            contextTokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
            contextWindow: this.contextWindow,
          });
        }
        break;
    }
  }

  private askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const name = request.tool.name;
    const { id } = request;
    this.pendingTools.set(id, request);
    const settle = () => {
      this.pendingTools.delete(id);
      this.proposals.clear(id);
    };
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(id, (decision) => {
        // Commands are never auto-approved: each one is reviewed.
        if (decision === 'always' && name !== 'run_command') this.alwaysAllowed.add(name);
        settle();
        resolve(decision);
      });
      signal.addEventListener(
        'abort',
        () => {
          if (this.pendingApprovals.delete(id)) {
            settle();
            resolve('reject');
          }
        },
        { once: true },
      );
    });
  }

  private async viewDiff(id: string): Promise<void> {
    const request = this.pendingTools.get(id);
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

function pickEditor(editor: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
  return editor && editor.document.uri.scheme === 'file' ? editor : undefined;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
