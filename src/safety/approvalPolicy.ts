import { hasShellSyntax, isSafeReadOnlyCommand } from './commandPolicy';

export interface ApprovalSettings {
  autoApproveEdits: boolean;
  autoApproveSafeCommands: boolean;
  /** Commands matching one of these (as a whole) run without asking. */
  autoApproveCommands: RegExp[];
}

/**
 * Decides whether a tool call that normally needs approval may run without asking.
 * Dangerous commands never get here: the command policy blocks them first.
 */
export function isAutoApproved(
  toolName: string,
  input: unknown,
  settings: ApprovalSettings,
  alwaysAllowed: ReadonlySet<string>,
): boolean {
  if (alwaysAllowed.has(toolName)) return true;

  if (toolName === 'edit_file' || toolName === 'create_file') return settings.autoApproveEdits;

  if (toolName === 'run_command') {
    const command = String((input as { command?: unknown } | null)?.command ?? '').trim();
    // Anything with shell syntax (chaining, pipes, redirects, substitution) is always reviewed.
    if (!command || hasShellSyntax(command)) return false;
    if (settings.autoApproveSafeCommands && isSafeReadOnlyCommand(command)) return true;
    return settings.autoApproveCommands.some((pattern) => pattern.test(command));
  }
  return false;
}
