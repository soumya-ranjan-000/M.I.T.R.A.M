import { CommandRule, hasShellSyntax, isSafeReadOnlyCommand, matchesRule } from './commandPolicy';

export interface ApprovalSettings {
  skipApprovalPrompts: boolean;
  autoApproveEdits: boolean;
  autoApproveSafeCommands: boolean;
  /** Commands matching one of these (as a whole) run without asking. */
  autoApproveCommands: RegExp[];
  /** Rules saved with "Always allow" for this workspace. */
  allowedCommands: CommandRule[];
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

  if (settings.skipApprovalPrompts) {
    if (toolName === 'edit_file' || toolName === 'create_file') return true;
    if (toolName === 'run_command') {
      return !!String((input as { command?: unknown } | null)?.command ?? '').trim();
    }
  }

  if (toolName === 'edit_file' || toolName === 'create_file') return settings.autoApproveEdits;

  if (toolName === 'run_command') {
    const command = String((input as { command?: unknown } | null)?.command ?? '').trim();
    if (!command) return false;
    // An exact rule may cover shell syntax: it is the very command the user reviewed.
    if (settings.allowedCommands.some((rule) => matchesRule(rule, command))) return true;
    // Otherwise anything with shell syntax (chaining, pipes, redirects, substitution) is always reviewed.
    if (hasShellSyntax(command)) return false;
    if (settings.autoApproveSafeCommands && isSafeReadOnlyCommand(command)) return true;
    return settings.autoApproveCommands.some((pattern) => pattern.test(command));
  }
  return false;
}
