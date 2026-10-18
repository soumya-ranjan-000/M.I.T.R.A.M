import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentEvent, ApprovalRequest, runAgent } from '../agent/AgentLoop';
import { emptyBoard } from '../agent/board';
import { formatEnvironment } from '../agent/environment';
import { gatherEnvironment } from '../agent/gatherEnvironment';
import { loadProjectInstructions } from '../agent/projectInstructions';
import { buildUserContent } from '../agent/ContextBuilder';
import { gatherContext } from '../agent/gatherContext';
import { pruneAttachments } from '../agent/attachments';
import { ReadResult, readAttachment } from '../agent/fileReaders';
import { buildSystemPrompt } from '../agent/SystemPrompt';
import { AnthropicProvider } from '../providers/AnthropicProvider';
import { describeError } from '../providers/ModelProvider';
import { CommandRuleStore } from '../storage/commandRules';
import { SecretStore } from '../storage/secrets';
import { Session, SessionStore, newSession, titleFrom } from '../storage/sessions';
import { readSettings } from '../storage/settings';
import { Checkpoint, withCheckpoint } from '../safety/checkpoints';
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
import { createDefaultRegistry } from '../tools';
import { ToolRegistry } from '../tools/Tool';
import { createDiagnosticsReader, createVscodeFilePort } from '../tools/vscodeHost';
import { applyHostEvent } from './displayReducer';
import { ProposalContentProvider } from './ProposalContentProvider';
import {
  ApprovalDecision,
  FileAttachment,
  HostToWebview,
  ImageAttachment,
  MAX_FILES,
  MAX_IMAGES,
  MAX_UPLOAD_BYTES,
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
  // Kept for a view that is opened again mid-run: VS Code rebuilds a hidden view from scratch.
  private runStartedAt = 0;
  private runPlan = false;
  private lastUsage?: { sessionId: string; message: Extract<HostToWebview, { type: 'usage' }> };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: SecretStore,
    private readonly store: SessionStore,
    private readonly proposals: ProposalContentProvider,
    private readonly state: vscode.Memento,
    private readonly commandRules: CommandRuleStore,
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
          {
            text: message.text,
            includeActive: message.includeActive,
            mentions: message.mentions,
            plan: message.plan,
            images: message.images,
            files: message.files,
          },
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
      case 'revert':
        await this.revert();
        break;
      case 'clearBoard':
        await this.clearBoard();
        break;
      case 'continueRun':
        await this.run(
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
    // The view is rebuilt each time it is shown again, so restore what loadMessages resets.
    if (this.abort) this.post({ type: 'runInProgress', since: this.runStartedAt, plan: this.runPlan });
    if (this.lastUsage?.sessionId === this.session.id) this.post(this.lastUsage.message);
    this.postCheckpoint();
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
          ? 'No endpoint configured. Set "mitram.endpoint" in your user settings to your Azure Foundry URL.'
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
    this.runStartedAt = Date.now();
    this.runPlan = run.plan;
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
    session.history.push({ role: 'user', content: buildUserContent(run.text, parts, environment, run.images, run.files) });
    const pruned = pruneAttachments(session.history);
    if (!isRetry) {
      session.display.push({
        role: 'user',
        text: run.text,
        ...(run.images.length ? { images: run.images } : {}),
        // The transcript only shows what was attached; the content is in the history.
        ...(run.files.length ? { files: run.files.map((f) => ({ ...f, data: '' })) } : {}),
      });
      if (session.display.length === 1) session.title = titleFrom(run.text || run.files[0]?.name || 'Image');
    }
    if (pruned > 0) {
      this.emit(session, {
        type: 'notice',
        text: `Removed ${pruned} older image${pruned === 1 ? '' : 's'} or PDF${pruned === 1 ? '' : 's'} from the conversation to stay within the request size limit.`,
      });
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
              // Read the saved rules on every call, so "Always allow" applies within this run too.
              allowedCommands: this.commandRules.list(),
            },
            this.alwaysAllowed,
          ),
        requestApproval: (request) => this.askApproval(session, request, abort.signal),
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
        this.lastUsage = { sessionId: session.id, message };
        if (session === this.session) this.post(message);
        break;
      }
    }
  }

  private askApproval(session: Session, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const name = request.tool.name;
    const { id } = request;
    // The host works out the rule and keeps it here, so the webview can only accept or decline it.
    const rule =
      name === 'run_command' ? suggestCommandRule(String((request.input as { command?: unknown } | null)?.command ?? '')) : null;
    if (rule) {
      this.emit(session, { type: 'toolAllowRule', id, label: describeRule(rule), usesShell: hasShellSyntax(rule.command) });
    }
    this.pendingTools.set(id, request);
    const settle = () => {
      this.pendingTools.delete(id);
      this.proposals.clear(id);
    };
    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(id, (decision) => {
        if (decision === 'always') {
          // A command is remembered as a rule for this workspace, never as "every command".
          if (rule) void this.allowCommandRule(rule);
          else if (name !== 'run_command') this.alwaysAllowed.add(name);
        }
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
