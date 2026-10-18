import { heldout3, heldoutChatter3 } from './heldout3';

/**
 * Representative chat requests about this repository, each labelled with the files a developer
 * would open first to act on it (most important first). Labels were made by reading the code at
 * SNAPSHOT_REF, and the benchmark searches a snapshot of that commit, so they stay valid while the
 * working tree changes. Move the ref only together with a re-check of every label.
 */
export const SNAPSHOT_REF = '0d3ab3ba994ded0615f806d9f1af453c51512591';

export interface RetrievalRequest {
  id: string;
  /** What the user typed. */
  text: string;
  /** 'identifier': names a symbol, tool, setting or file. 'natural': only describes behaviour. */
  kind: 'identifier' | 'natural';
  /** Workspace-relative paths at SNAPSHOT_REF, most important first. */
  gold: string[];
  /**
   * Never used to tune the pass. 1: written before step 2's pass first ran on it (its results were then
   * reported). 2: written before the ranking fixes that followed, and checked only once they were done.
   * 3: written by a separate agent that never saw the retrieval code, read only after the fixes were final.
   */
  heldout?: 1 | 2 | 3;
}

export const requests: RetrievalRequest[] = [
  {
    id: 'stop-running-command',
    text: "Pressing stop doesn't cancel the command that's currently running",
    kind: 'natural',
    gold: ['src/webview/ChatViewProvider.ts', 'src/tools/runCommand.ts', 'src/agent/AgentLoop.ts'],
  },
  {
    id: 'search-results-setting',
    text: 'Add a setting for the maximum number of matches search_files returns',
    kind: 'identifier',
    gold: ['src/tools/searchFiles.ts', 'src/storage/settings.ts', 'package.json'],
  },
  {
    id: 'diff-preview-content',
    text: 'The diff shown before I approve an edit has the old text on both sides',
    kind: 'natural',
    gold: ['src/webview/ProposalContentProvider.ts', 'src/tools/editFile.ts'],
  },
  {
    id: 'block-force-push',
    text: 'Block git push --force even when safe commands are auto-approved',
    kind: 'identifier',
    gold: ['src/safety/commandPolicy.ts', 'src/safety/approvalPolicy.ts'],
  },
  {
    id: 'revert-created-files',
    text: 'Revert this turn leaves behind files the agent created',
    kind: 'natural',
    gold: ['src/safety/checkpoints.ts'],
  },
  {
    id: 'summarise-not-drop',
    text: 'When the context fills up, old turns are dropped instead of summarised',
    kind: 'natural',
    gold: ['src/agent/contextManager.ts', 'src/agent/summarize.ts'],
  },
  {
    id: 'environment-commit',
    text: 'Include the latest commit message next to the git branch in the environment block',
    kind: 'natural',
    gold: ['src/agent/gatherEnvironment.ts', 'src/agent/environment.ts'],
  },
  {
    id: 'symlink-escape',
    text: 'Can read_file follow a symlink to a file outside the workspace?',
    kind: 'identifier',
    gold: ['src/safety/workspaceGuard.ts', 'src/tools/readFile.ts'],
  },
  {
    id: 'help-slash-command',
    text: 'Add a /help slash command that lists the other commands',
    kind: 'identifier',
    gold: ['src/webview/slashCommands.ts', 'webview-ui/src/components/Composer.tsx'],
  },
  {
    id: 'cache-control-miss',
    text: 'Prompt caching never hits after the first message; check where cache_control is set',
    kind: 'identifier',
    gold: ['src/providers/AnthropicProvider.ts'],
  },
  {
    id: 'board-panel-refresh',
    text: "The plan board panel doesn't refresh while the agent is working",
    kind: 'natural',
    gold: ['webview-ui/src/components/BoardPanel.tsx', 'src/tools/updateBoard.ts', 'webview-ui/src/App.tsx'],
  },
  {
    id: 'stuck-sooner',
    text: 'The agent repeated the same failing tool call five times before stopping; make it stop sooner',
    kind: 'natural',
    gold: ['src/agent/runTracker.ts', 'src/agent/AgentLoop.ts'],
  },
  {
    id: 'api-key-in-logs',
    text: 'Make sure the API key can never appear in the logs',
    kind: 'natural',
    gold: ['src/logging.ts', 'src/storage/secrets.ts'],
  },
  {
    id: 'instructions-github-folder',
    text: 'Also load MITRAM.md from the .github folder',
    kind: 'identifier',
    gold: ['src/agent/projectInstructions.ts'],
  },
  {
    id: 'tool-card-output',
    text: 'Tool cards cut off command output too early',
    kind: 'natural',
    gold: ['webview-ui/src/components/ToolCard.tsx', 'src/agent/AgentLoop.ts'],
  },
  {
    id: 'diagnostics-node-modules',
    text: 'get_diagnostics reports problems from files in node_modules',
    kind: 'identifier',
    gold: ['src/tools/vscodeHost.ts', 'src/tools/getDiagnostics.ts'],
  },
  {
    id: 'tool-result-limit',
    text: 'Large tool results are cut to 30k characters; make the limit depend on the context window',
    kind: 'natural',
    gold: ['src/agent/AgentLoop.ts', 'src/tools/Tool.ts'],
  },
  {
    id: 'verify-reminder',
    text: "The 'verify before done' reminder fires even though I ran the tests",
    kind: 'natural',
    gold: ['src/agent/runTracker.ts'],
  },
  {
    id: 'model-picker-memory',
    text: 'The model picker forgets my choice after reloading the window',
    kind: 'natural',
    gold: ['src/webview/ChatViewProvider.ts', 'src/storage/settings.ts'],
  },
  {
    id: 'mention-picker-dist',
    text: "@ file mentions don't find files inside a nested dist folder",
    kind: 'natural',
    gold: ['src/webview/ChatViewProvider.ts', 'webview-ui/src/components/Composer.tsx'],
  },
  {
    id: 'python-highlighting',
    text: "Code blocks in replies aren't syntax highlighted for Python",
    kind: 'natural',
    gold: ['webview-ui/src/highlight.ts', 'webview-ui/src/components/Markdown.tsx'],
  },
  {
    id: 'usage-bar-cached',
    text: 'The token usage bar counts cached tokens as new input',
    kind: 'natural',
    gold: ['webview-ui/src/components/UsageBar.tsx', 'src/providers/AnthropicProvider.ts'],
  },
  {
    id: 'sessions-per-workspace',
    text: 'Store chat sessions per workspace instead of globally',
    kind: 'natural',
    gold: ['src/extension.ts', 'src/storage/sessions.ts'],
  },
  {
    id: 'auto-approve-edits',
    text: 'autoApproveEdits should not apply to files outside src',
    kind: 'identifier',
    gold: ['src/safety/approvalPolicy.ts', 'src/storage/settings.ts'],
  },

  // Held out, round 1.
  {
    id: 'reasoning-stays-open',
    text: 'Keep the reasoning section expanded after the model finishes thinking',
    kind: 'natural',
    gold: ['webview-ui/src/components/ThinkingBlock.tsx'],
    heldout: 1,
  },
  {
    id: 'crlf-edits',
    text: "edit_file can't find the text in files with Windows line endings",
    kind: 'identifier',
    gold: ['src/tools/editFile.ts'],
    heldout: 1,
  },
  {
    id: 'rate-limit-backoff',
    text: 'Retry automatically with backoff when the API says we are rate limited',
    kind: 'natural',
    gold: ['src/providers/AnthropicProvider.ts', 'src/providers/ModelProvider.ts'],
    heldout: 1,
  },
  {
    id: 'delete-chat-disk',
    text: 'Deleting a chat from the history list leaves it on disk',
    kind: 'natural',
    gold: ['src/storage/sessions.ts', 'src/webview/ChatViewProvider.ts'],
    heldout: 1,
  },
  {
    id: 'diagnostics-report',
    text: "Add the context window size to the Copy Diagnostics bug report",
    kind: 'natural',
    gold: ['src/logging.ts', 'src/extension.ts'],
    heldout: 1,
  },
  {
    id: 'working-timer-approval',
    text: "The elapsed time next to 'Working' keeps counting while it waits for my approval",
    kind: 'natural',
    gold: ['webview-ui/src/components/WorkingStatus.tsx', 'src/webview/activity.ts'],
    heldout: 1,
  },
  {
    id: 'markdown-table-borders',
    text: 'Markdown tables in replies have no borders',
    kind: 'natural',
    gold: ['webview-ui/src/styles.css', 'webview-ui/src/components/Markdown.tsx'],
    heldout: 1,
  },
  {
    id: 'max-iterations-zero',
    text: 'Setting maxIterations to 0 should mean there is no step limit',
    kind: 'identifier',
    gold: ['src/storage/settings.ts', 'src/agent/AgentLoop.ts'],
    heldout: 1,
  },

  // Held out, round 2.
  {
    id: 'list-dir-limit',
    text: 'list_dir cuts big folders off at 300 entries; raise the limit',
    kind: 'identifier',
    gold: ['src/tools/listDir.ts'],
    heldout: 2,
  },
  {
    id: 'command-timeout',
    text: 'Long-running commands time out after two minutes; let the agent ask for more time',
    kind: 'natural',
    gold: ['src/tools/runCommand.ts'],
    heldout: 2,
  },
  {
    id: 'malformed-webview-message',
    text: 'Ignore malformed messages from the webview instead of throwing',
    kind: 'natural',
    gold: ['src/webview/protocol.ts', 'src/webview/ChatViewProvider.ts'],
    heldout: 2,
  },
  {
    id: 'thinking-unsupported',
    text: 'Deployments without extended thinking support fail the first request',
    kind: 'natural',
    gold: ['src/providers/AnthropicProvider.ts'],
    heldout: 2,
  },
  {
    id: 'board-task-limit',
    text: 'Allow more than 30 tasks on the plan board',
    kind: 'natural',
    gold: ['src/agent/board.ts', 'src/tools/updateBoard.ts'],
    heldout: 2,
  },
  {
    id: 'read-file-binary',
    text: 'read_file should refuse binary files with a clearer message',
    kind: 'identifier',
    gold: ['src/tools/readFile.ts'],
    heldout: 2,
  },
  {
    id: 'environment-git-hang',
    text: 'The git calls for the environment summary hang on huge repositories',
    kind: 'natural',
    gold: ['src/agent/gatherEnvironment.ts'],
    heldout: 2,
  },
  {
    id: 'session-title-length',
    text: 'Chat titles are cut at 50 characters in the history list',
    kind: 'natural',
    gold: ['src/storage/sessions.ts'],
    heldout: 2,
  },

  ...heldout3,
];

/** Follow-up messages that name no code. The pass should attach nothing for these. */
export const chatter: string[] = [
  'thanks, that works',
  'yes, go ahead',
  'can you explain that more simply?',
  'what do you think?',
  'ok, now do the same for the other one',
  'looks good to me, ship it',
  'undo that last change please',
  "hmm, that didn't work. try again",
];

/** More chatter, never used for tuning: round 1, written before the gate was tuned. */
export const heldoutChatter: string[] = [
  'perfect, thank you!',
  'can you do that again but shorter?',
  "that's not what I meant",
  'go on',
  'nice work',
  'why did you do that?',
  'sounds good, please continue',
  'stop, wait',
];

/** Held-out chatter, round 2: written before the ranking fixes. */
export const heldoutChatter2: string[] = [
  'are you sure?',
  'sorry, I meant the other file',
  'can you summarise what you changed?',
  'no, keep the old behaviour',
  'fine, leave it as it is',
  'one more thing',
  'run it again',
  'show me the diff',
];

export { heldoutChatter3 };
