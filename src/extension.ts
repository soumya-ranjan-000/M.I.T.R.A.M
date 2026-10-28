import * as path from 'node:path';
import * as vscode from 'vscode';
import { INSTRUCTIONS_FILE, INSTRUCTIONS_TEMPLATE } from './agent/projectInstructions';
import { Logger, buildDiagnostics } from './logging';
import { McpConfigStore } from './mcp/McpConfigStore';
import { McpManager } from './mcp/McpManager';
import { McpServerConfig, describeServer } from './mcp/config';
import { compileAnchoredPatterns } from './safety/commandPolicy';
import { CommandRuleStore } from './storage/commandRules';
import { McpTrustStore } from './storage/mcpTrust';
import { SecretStore } from './storage/secrets';
import { readSettings } from './storage/settings';
import { SessionStore } from './storage/sessions';
import { ChatChangeStore } from './safety/chatChanges';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { ProposalContentProvider } from './webview/ProposalContentProvider';

export function activate(context: vscode.ExtensionContext): void {
  const secrets = new SecretStore(context.secrets);
  // Chats belong to a project: storageUri is unique per workspace, so two windows never share history.
  // With no folder open there is no storageUri, so those chats get their own bucket.
  const storageDir = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, 'no-workspace');
  const sessions = new SessionStore(storageDir);
  // What files held before a chat changed them, next to the chats themselves.
  const chatChanges = new ChatChangeStore(path.join(storageDir, 'changes'));
  const output = vscode.window.createOutputChannel('M.I.T.R.A.M', { log: true });
  const logger = new Logger(output);
  const proposals = new ProposalContentProvider();
  // "Always allow" command rules are per project, like chats.
  const commandRules = new CommandRuleStore(context.workspaceState);
  // Running an MCP server means running a program, so trust is per project too.
  const mcpTrust = new McpTrustStore(context.workspaceState);
  const mcpConfig = new McpConfigStore();
  // Declared before the manager because its onChange closes over it, and assigned just below.
  // The optional call matters: a status change during construction would otherwise be a
  // temporal dead zone error, which activation reports as the whole extension failing to load.
  let chat: ChatViewProvider | undefined;
  const mcp = new McpManager({
    servers: () => readSettings().mcpServers,
    getApiKey: (id) => Promise.resolve(secrets.getMcpKey(id)),
    blocked: () => compileAnchoredPatterns(readSettings().blockedMcpTools),
    toolLimit: () => readSettings().mcpToolLimit,
    oauth: {
      store: (id) => ({
        load: () => Promise.resolve(secrets.getMcpOAuth(id)),
        save: (json) => Promise.resolve(secrets.setMcpOAuth(id, json)),
        clear: () => Promise.resolve(secrets.clearMcpOAuth(id)),
      }),
      openBrowser: async (url) => {
        await vscode.env.openExternal(vscode.Uri.parse(url, true));
      },
      // A remote window forwards the port, so the browser on this machine can reach the redirect.
      externalRedirect: vscode.env.remoteName
        ? async (url) => (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true)
        : undefined,
    },
    confirmTrust: (servers) => confirmMcpTrust(servers, mcpTrust, logger),
    log: (message) => logger.info(message),
    onChange: () => chat?.refreshMcpPanel(),
  });
  chat = new ChatViewProvider(
    context.extensionUri,
    secrets,
    sessions,
    chatChanges,
    proposals,
    context.globalState,
    commandRules,
    logger,
    context.subscriptions,
    mcp,
    mcpConfig,
    mcpTrust,
  );

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('mitram.showLogs', () => output.show()),
    vscode.commands.registerCommand('mitram.copyDiagnostics', async () => {
      const s = readSettings();
      const text = buildDiagnostics({
        extensionVersion: String(context.extension.packageJSON.version),
        vscodeVersion: vscode.version,
        platform: process.platform,
        model: s.model,
        endpoint: s.endpoint,
        workspaceOpen: !!vscode.workspace.workspaceFolders?.length,
        settings: {
          maxTokens: s.maxTokens,
          maxIterations: s.maxIterations,
          contextWindow: s.contextWindow,
          promptCaching: s.promptCaching,
          includeEnvironment: s.includeEnvironment,
          retrieveContext: s.retrieveContext,
          skipApprovalPrompts: s.skipApprovalPrompts,
          autoApproveEdits: s.autoApproveEdits,
          autoApproveSafeCommands: s.autoApproveSafeCommands,
          autoApproveCommands: s.autoApproveCommands.length,
          blockedCommandPatterns: s.blockedCommandPatterns.length,
          subagents: s.subagents,
          maxParallelSubagents: s.maxParallelSubagents,
          // Counts only: a server's command or URL can name an internal host.
          mcpServers: s.mcpServers.length,
          mcpServersEnabled: s.mcpServers.filter((server) => server.enabled).length,
          mcpServersConnected: mcp.status().filter((server) => server.status === 'ready').length,
          mcpToolsOffered: mcp.tools().length,
          mcpProblems: s.mcpProblems.length,
          blockedMcpTools: s.blockedMcpTools.length,
          autoApproveMcpReads: s.autoApproveMcpReads,
        },
      });
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('M.I.T.R.A.M: Diagnostics copied. It contains no API key or prompts.');
    }),
    vscode.workspace.registerTextDocumentContentProvider(ProposalContentProvider.scheme, proposals),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat),
    vscode.commands.registerCommand('mitram.focusChat', () => chat.focus()),
    vscode.commands.registerCommand('mitram.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('mitram.manageAllowedCommands', () => chat.manageAllowedCommands()),
    vscode.commands.registerCommand('mitram.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'M.I.T.R.A.M: Azure Foundry API Key',
        prompt: 'Stored securely in VS Code SecretStorage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (key?.trim()) {
        await secrets.setApiKey(key.trim());
        void vscode.window.showInformationMessage('M.I.T.R.A.M: API key saved.');
      }
    }),
    vscode.commands.registerCommand('mitram.initProjectInstructions', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        void vscode.window.showWarningMessage('M.I.T.R.A.M: Open a folder first.');
        return;
      }
      const file = vscode.Uri.joinPath(root, INSTRUCTIONS_FILE);
      try {
        await vscode.workspace.fs.stat(file);
      } catch {
        await vscode.workspace.fs.writeFile(file, Buffer.from(INSTRUCTIONS_TEMPLATE, 'utf8'));
      }
      await vscode.window.showTextDocument(file);
    }),
    vscode.commands.registerCommand('mitram.setVoiceApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'M.I.T.R.A.M: Voice Transcription API Key',
        prompt: 'For the endpoint in mitram.voice.endpoint. Stored securely in VS Code SecretStorage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (key?.trim()) {
        await secrets.setVoiceKey(key.trim());
        void vscode.window.showInformationMessage('M.I.T.R.A.M: Voice API key saved.');
      }
    }),
    vscode.commands.registerCommand('mitram.clearVoiceApiKey', async () => {
      await secrets.clearVoiceKey();
      void vscode.window.showInformationMessage('M.I.T.R.A.M: Voice API key removed.');
    }),
    vscode.commands.registerCommand('mitram.setOpenAIApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'M.I.T.R.A.M: OpenAI API Key',
        prompt: 'For the endpoint in mitram.openai.endpoint (Azure OpenAI or OpenAI). Stored securely in VS Code SecretStorage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (key?.trim()) {
        await secrets.setOpenAIKey(key.trim());
        void vscode.window.showInformationMessage('M.I.T.R.A.M: OpenAI API key saved.');
      }
    }),
    vscode.commands.registerCommand('mitram.clearOpenAIApiKey', async () => {
      await secrets.clearOpenAIKey();
      void vscode.window.showInformationMessage('M.I.T.R.A.M: OpenAI API key removed.');
    }),
    vscode.commands.registerCommand('mitram.clearApiKey', async () => {
      await secrets.clearApiKey();
      void vscode.window.showInformationMessage('M.I.T.R.A.M: API key removed.');
    }),
    // Kills every MCP child process when the window closes or the extension is disabled.
    { dispose: () => void mcp.dispose() },
  );
}

/**
 * Asks once per workspace before any MCP server is started.
 *
 * A server is an arbitrary program launched with the user's own permissions, so this is a real
 * consent step, not a notification. The answer is remembered per project; "Not now" is not
 * remembered, so the next run asks again.
 */
async function confirmMcpTrust(servers: McpServerConfig[], trust: McpTrustStore, logger: Logger): Promise<boolean> {
  const saved = trust.get();
  if (saved !== undefined) return saved;

  const names = servers.map((s) => s.id).join(', ');
  const detail = servers.map((s) => `• ${s.id} — ${describeServer(s)}`).join('\n');
  const choice = await vscode.window.showWarningMessage(
    `Start ${servers.length} MCP server${servers.length === 1 ? '' : 's'} for this project?`,
    {
      modal: true,
      detail: `${detail}\n\nEach runs as a program with your permissions and can use its tools on your behalf. Only continue if you trust them.`,
    },
    'Start servers',
    'Never for this project',
  );

  if (choice === 'Start servers') {
    await trust.set(true);
    logger.info(`mcp: trusted for this workspace (${names})`);
    return true;
  }
  if (choice === 'Never for this project') {
    await trust.set(false);
    logger.info('mcp: refused for this workspace');
    return false;
  }
  // Dismissed: do not start anything, but ask again next time.
  logger.info('mcp: trust prompt dismissed; not starting servers');
  return false;
}

export function deactivate(): void {}
