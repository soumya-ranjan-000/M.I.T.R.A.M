import type { ProcessInfo } from './processes';
import { Tool, ToolContext, ToolInputError, optInt, reqString } from './Tool';

/** Output returned per read: the newest part, which is what a log is read for. */
const MAX_READ_CHARS = 30_000;

function port(ctx: ToolContext) {
  if (!ctx.processes) throw new ToolInputError('Background processes are not available here.');
  return ctx.processes;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function describe(p: ProcessInfo, owner: string): string {
  const state =
    p.status === 'running'
      ? `running, started ${ago(p.startedAt)}`
      : p.status === 'stopped'
        ? `stopped ${ago(p.endedAt ?? p.startedAt)}`
        : `exited with code ${p.exitCode ?? 'unknown'} ${ago(p.endedAt ?? p.startedAt)}`;
  return `${p.id} (${state}${p.owner === owner ? '' : ', started from another chat'}): ${p.command}`;
}

export const readProcessOutputTool: Tool = {
  name: 'read_process_output',
  description:
    'Read the output of a background process started with run_command (background: true): whether it is still running, its exit code, ' +
    'and its output. Pass the "next" offset from your previous read as since to get only what is new.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The process id, e.g. "p3".' },
      since: { type: 'integer', description: 'Only output after this offset, from a previous read.' },
    },
    required: ['id'],
  },
  requiresApproval: false,
  preview: (input) => ({ summary: `Read output of ${String((input as { id?: unknown } | null)?.id ?? 'process')}` }),
  async run(input, ctx) {
    const processes = port(ctx);
    const id = reqString(input, 'id');
    const out = processes.read(id, optInt(input, 'since') ?? 0);
    if (!out) throw new ToolInputError(`No background process "${id}". Use list_processes to see them.`);
    let text = out.text;
    const cut = text.length > MAX_READ_CHARS;
    if (cut) text = text.slice(-MAX_READ_CHARS);
    const notes = [
      out.dropped ? '[older output was dropped]' : '',
      cut ? `[showing the last ${MAX_READ_CHARS} characters]` : '',
    ].filter(Boolean);
    return [describe(out.info, processes.owner), ...notes, text.trimEnd() || '(no new output)', `next: ${out.next}`].join('\n');
  },
};

export const listProcessesTool: Tool = {
  name: 'list_processes',
  description: 'List the background processes in this window: running ones and ones that have ended, with their ids and commands.',
  inputSchema: { type: 'object', properties: {} },
  requiresApproval: false,
  preview: () => ({ summary: 'List background processes' }),
  async run(_input, ctx) {
    const processes = port(ctx);
    const list = processes.list();
    return list.length ? list.map((p) => describe(p, processes.owner)).join('\n') : 'No background processes.';
  },
};

export const stopProcessTool: Tool = {
  name: 'stop_process',
  description:
    'Stop a background process and everything it started. Stop the ones you started once they are no longer needed, unless the user wants them left running. ' +
    'Do not stop a process another chat started unless the user asks.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The process id, e.g. "p3".' } },
    required: ['id'],
  },
  requiresApproval: true,
  preview: (input) => ({ summary: `Stop process ${String((input as { id?: unknown } | null)?.id ?? '')}` }),
  async run(input, ctx) {
    const processes = port(ctx);
    const id = reqString(input, 'id');
    const before = processes.list().find((p) => p.id === id);
    if (!before) throw new ToolInputError(`No background process "${id}". Use list_processes to see them.`);
    if (before.status !== 'running') return `${id} is not running: ${describe(before, processes.owner)}`;
    await processes.stop(id);
    return `Stopped ${id}: ${before.command}`;
  },
};
