import type { Board } from '../webview/protocol';
import { boardProgress } from './board';

export type ToolOutcome = 'ok' | 'error' | 'rejected';

/** What the loop should do after a tool call. */
export type RepeatVerdict = 'ok' | 'warn' | 'stop';

/** Commands that read state rather than check the work, so they do not count as verification. */
const NOT_A_CHECK = /^\s*(ls|pwd|echo|cat|head|tail|wc|which|type|file|stat|git\s+(status|diff|log|show|branch|rev-parse))\b/;

export function isVerificationCommand(command: string): boolean {
  return !NOT_A_CHECK.test(command);
}

const WARN_AT = 3;
const STOP_AT = 5;
const WINDOW = 10;
const MAX_NUDGES = 2;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export type FinishCheck =
  | { action: 'finish' }
  /** Send the model back to work with this message. */
  | { action: 'nudge'; message: string; reason: string }
  /** Out of nudges: let it finish, but tell the user what is left. */
  | { action: 'finish-with-warning'; warning: string };

/**
 * Tracks one run of the agent: which edited files have not been checked yet, whether the
 * agent keeps repeating the same action, and whether it may finish yet.
 */
export class RunTracker {
  private readonly unverified = new Set<string>();
  private lastCheckFailed = false;
  /** The user refused to let a check run, so we must not keep insisting on one. */
  private verificationDeclined = false;
  private readonly recent: { signature: string; outcome: string }[] = [];
  private nudges = 0;

  /** Edited files that no passing check has covered since. */
  unverifiedFiles(): string[] {
    return [...this.unverified];
  }

  /** Call after every tool call. The verdict says whether the loop should warn or stop. */
  record(name: string, input: unknown, outcome: ToolOutcome, output: string): RepeatVerdict {
    this.trackVerification(name, input, outcome, output);
    if (name === 'update_board') return 'ok';

    const signature = `${name}:${stable(input)}`;
    this.recent.push({ signature, outcome: `${outcome}:${output.slice(0, 500)}` });
    if (this.recent.length > WINDOW) this.recent.shift();

    // Repeating a call is only a problem if it keeps giving the same result.
    const last = this.recent[this.recent.length - 1];
    const same = this.recent.filter((r) => r.signature === last.signature && r.outcome === last.outcome).length;
    if (same >= STOP_AT) return 'stop';
    if (same >= WARN_AT) return 'warn';
    return 'ok';
  }

  private trackVerification(name: string, input: unknown, outcome: ToolOutcome, output: string): void {
    if (outcome === 'rejected' && name === 'run_command') this.verificationDeclined = true;
    if (outcome !== 'ok') return;
    const path = (input as { path?: unknown } | null)?.path;

    if ((name === 'edit_file' || name === 'create_file') && typeof path === 'string') {
      this.unverified.add(path);
    } else if (name === 'run_command') {
      const command = String((input as { command?: unknown } | null)?.command ?? '');
      if (!isVerificationCommand(command)) return;
      if (output.startsWith('exit code 0')) this.pass();
      else this.fail();
    } else if (name === 'get_diagnostics') {
      if (output === 'No errors or warnings.') this.pass();
      else if (!output.includes('not available')) this.fail();
    }
  }

  private pass(): void {
    this.unverified.clear();
    this.lastCheckFailed = false;
  }

  private fail(): void {
    if (this.unverified.size > 0) this.lastCheckFailed = true;
  }

  /** A short note for the model, added at the end of each request. */
  noteForModel(): string {
    if (this.unverified.size === 0) return '';
    const files = [...this.unverified].slice(0, 8).join(', ');
    return `<status>Files changed and not yet checked: ${files}${this.lastCheckFailed ? '. Your last check failed.' : '.'}</status>`;
  }

  /** Called when the model tries to end its turn. */
  checkFinish(board: Board | undefined, options: { verify: boolean }): FinishCheck {
    const problems: string[] = [];
    if (options.verify && !this.verificationDeclined && this.unverified.size > 0) {
      const files = [...this.unverified].slice(0, 8).join(', ');
      problems.push(
        this.lastCheckFailed
          ? `Your last check failed and ${files} ${this.unverified.size === 1 ? 'is' : 'are'} still not verified. Fix the failure, then run the check again.`
          : `You changed ${files} but have not verified the change. Run the project's tests, build or linter (or use get_diagnostics), and fix any failures before you finish. If nothing can be checked automatically, say so and explain why.`,
      );
    }
    const unfinished = board ? boardProgress(board).unfinished : [];
    if (unfinished.length > 0) {
      const list = unfinished.slice(0, 6).map((t) => `"${t.title}"`).join(', ');
      problems.push(
        `Your board still has unfinished tasks: ${list}. Carry on with them. If a task is no longer needed, remove it; if you cannot continue without the user, mark it blocked with a note and ask.`,
      );
    }
    if (problems.length === 0) return { action: 'finish' };

    if (this.nudges >= MAX_NUDGES) {
      return { action: 'finish-with-warning', warning: problems.join(' ') };
    }
    this.nudges++;
    return {
      action: 'nudge',
      message: `[Automatic check, not from the user] ${problems.join(' ')}`,
      reason: unfinished.length > 0 && this.unverified.size === 0 ? 'unfinished tasks' : 'unverified changes',
    };
  }
}
