import { spawn } from 'node:child_process';
import { checkCommand } from '../safety/commandPolicy';
import { Tool, ToolContext, ToolInputError, optInt, reqString, truncateMiddle } from './Tool';

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_CAPTURE_CHARS = 1_000_000;
const PROGRESS_INTERVAL_MS = 500;
// Roughly what fits on a tool card's header line in a narrow side bar.
const SUMMARY_MAX_CHARS = 40;
/** How long a background command is watched before the call returns, to catch an immediate failure. */
const BACKGROUND_SETTLE_MS = 5000;
const BACKGROUND_POLL_MS = 250;

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace root and return its exit code and combined output (stdout and stderr). ' +
    'Use it to run tests, builds, linters and git. Commands must not be interactive. ' +
    `Times out after ${DEFAULT_TIMEOUT_S} seconds by default. ` +
    'For a dev server, watcher or anything else that does not finish on its own, set background: true: the command keeps running, ' +
    'the call returns its first few seconds of output and a process id, and you check on it with read_process_output and stop it with stop_process.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      timeout_seconds: { type: 'integer', description: `Timeout in seconds (max ${MAX_TIMEOUT_S}). Ignored with background.` },
      background: { type: 'boolean', description: 'Leave the command running and return at once with a process id.' },
    },
    required: ['command'],
  },
  requiresApproval: true,
  preview: (input) => {
    const command = String((input as { command?: unknown } | null)?.command ?? '').trim();
    const lines = command.split(/\r?\n/);
    const background = (input as { background?: unknown } | null)?.background === true;
    return {
      summary: `${background ? 'Run in background' : 'Run'}: ${lines.length > 1 ? `${lines[0]} …` : command}`,
      // The one-line summary gets cut off, so show the whole command before it is approved.
      detail: lines.length > 1 || command.length > SUMMARY_MAX_CHARS ? command : undefined,
    };
  },
  policy: (input, ctx) => checkCommand(reqString(input, 'command'), ctx.blockedCommandPatterns),
  async run(input, ctx) {
    const command = reqString(input, 'command');
    if (!command.trim()) throw new ToolInputError('command must not be empty.');
    if ((input as { background?: unknown }).background === true) return runInBackground(command, ctx);
    const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, optInt(input, 'timeout_seconds') ?? DEFAULT_TIMEOUT_S));

    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        cwd: ctx.root,
        // Own process group so the whole tree can be killed on timeout or cancel.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
      });

      let output = '';
      let timedOut = false;
      // Output arrives in many small pieces; the card is refreshed with what has come at most this often.
      let progressTimer: NodeJS.Timeout | undefined;
      const append = (chunk: Buffer) => {
        if (output.length < MAX_CAPTURE_CHARS) output += chunk.toString('utf8');
        if (ctx.progress && !progressTimer) {
          progressTimer = setTimeout(() => {
            progressTimer = undefined;
            ctx.progress?.(output);
          }, PROGRESS_INTERVAL_MS);
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);

      const kill = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // Already exited.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutS * 1000);
      const onAbort = () => kill();
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(progressTimer);
        ctx.signal.removeEventListener('abort', onAbort);
      };

      child.on('error', (err) => {
        cleanup();
        reject(new Error(`Failed to start command: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        cleanup();
        if (ctx.signal.aborted) return reject(new Error('Cancelled by user.'));
        const body = truncateMiddle(output.trimEnd(), MAX_OUTPUT_CHARS) || '(no output)';
        if (timedOut) return resolve(`Timed out after ${timeoutS}s and was killed.\n${body}`);
        resolve(`exit code ${code ?? `signal ${signal}`}\n${body}`);
      });
    });
  },
};

/** Starts the command, watches it for a few seconds, and leaves it running. */
async function runInBackground(command: string, ctx: ToolContext): Promise<string> {
  if (!ctx.processes) throw new ToolInputError('Background commands are not available here. Run it without background.');
  const { id } = ctx.processes.start(command);
  const until = Date.now() + BACKGROUND_SETTLE_MS;
  let seen = 0;
  while (Date.now() < until && !ctx.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, BACKGROUND_POLL_MS));
    const out = ctx.processes.read(id);
    if (!out) break;
    if (out.next !== seen) {
      seen = out.next;
      ctx.progress?.(out.text);
    }
    if (out.info.status !== 'running') break;
  }
  const out = ctx.processes.read(id);
  const body = truncateMiddle((out?.text ?? '').trimEnd(), MAX_OUTPUT_CHARS) || '(no output yet)';
  if (out && out.info.status !== 'running') {
    // It finished (or failed) at once: report it like any other command.
    return `exit code ${out.info.exitCode ?? 'unknown'}\nThe background process ${id} has already ended.\n${body}`;
  }
  return (
    `Started background process ${id}; it is still running.\nOutput so far:\n${body}\n\n` +
    `Use read_process_output with id "${id}" to check on it, and stop_process when it is no longer needed.`
  );
}
