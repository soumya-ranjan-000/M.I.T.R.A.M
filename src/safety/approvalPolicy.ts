import { isMcpToolName } from '../mcp/naming';
import { CommandRule, hasShellSyntax, isSafeReadOnlyCommand, matchesRule } from './commandPolicy';

export interface ApprovalSettings {
  skipApprovalPrompts: boolean;
  autoApproveEdits: boolean;
  autoApproveSafeCommands: boolean;
  /** Commands matching one of these (as a whole) run without asking. */
  autoApproveCommands: RegExp[];
  /** Rules saved with "Always allow" for this workspace. */
  allowedCommands: CommandRule[];
  /** Run MCP tools the server itself marks read-only without asking. Off by default. */
  autoApproveMcpReads?: boolean;
  /** Full names of MCP tools whose server claims they change nothing. */
  mcpReadOnlyTools?: ReadonlySet<string>;
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

  // An MCP tool runs inside software we cannot inspect, so the blanket "skip prompts" setting
  // (which the user set for edits and commands) does not extend to it. The only automatic
  // approval is the explicit opt-in below, and then only for tools the server calls read-only.
  if (isMcpToolName(toolName)) {
    return !!settings.autoApproveMcpReads && !!settings.mcpReadOnlyTools?.has(toolName);
  }

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
