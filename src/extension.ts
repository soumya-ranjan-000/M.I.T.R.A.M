import * as path from 'node:path';
import * as vscode from 'vscode';
import { INSTRUCTIONS_FILE, INSTRUCTIONS_TEMPLATE } from './agent/projectInstructions';
import { Logger, buildDiagnostics } from './logging';
import { CommandRuleStore } from './storage/commandRules';
import { SecretStore } from './storage/secrets';
import { readSettings } from './storage/settings';
import { SessionStore } from './storage/sessions';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { ProposalContentProvider } from './webview/ProposalContentProvider';

export function activate(context: vscode.ExtensionContext): void {
  const secrets = new SecretStore(context.secrets);
  // Chats belong to a project: storageUri is unique per workspace, so two windows never share history.
  // With no folder open there is no storageUri, so those chats get their own bucket.
  const sessions = new SessionStore(context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, 'no-workspace'));
  const output = vscode.window.createOutputChannel('M.I.T.R.A.M', { log: true });
  const logger = new Logger(output);
  const proposals = new ProposalContentProvider();
  // "Always allow" command rules are per project, like chats.
  const commandRules = new CommandRuleStore(context.workspaceState);
  const chat = new ChatViewProvider(
    context.extensionUri,
    secrets,
    sessions,
    proposals,
    context.globalState,
    commandRules,
    logger,
    context.subscriptions,
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
    vscode.commands.registerCommand('mitram.clearApiKey', async () => {
      await secrets.clearApiKey();
      void vscode.window.showInformationMessage('M.I.T.R.A.M: API key removed.');
    }),
  );
}

export function deactivate(): void {}
