// Long-running commands (dev servers, watchers) that outlive the tool call that started them.
// No vscode import, so tests can use it.
import { spawn, type ChildProcess } from 'node:child_process';

export type ProcessStatus = 'running' | 'exited' | 'stopped';

export interface ProcessInfo {
  /** Short and stable, e.g. "p3": the agent and the UI refer to it by this. */
  id: string;
  command: string;
  cwd: string;
  /** The chat that started it. */
  owner: string;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
}

export interface ProcessOutput {
  info: ProcessInfo;
  /** Output from `since` onwards (or from the oldest kept, if that has been dropped). */
  text: string;
  /** Pass as `since` next time to get only what is new. */
  next: number;
  /** Older output was dropped before `since`, so some is missing. */
  dropped: boolean;
}

export type ProcessEvent =
  | { type: 'start'; info: ProcessInfo }
  | { type: 'output'; id: string; text: string }
  | { type: 'exit'; info: ProcessInfo };

interface Entry {
  info: ProcessInfo;
  child?: ChildProcess;
  /** The newest output, at most `maxOutput` characters. */
  buffer: string;
  /** Characters written since the start, so offsets survive dropping old output. */
  total: number;
}

const DEFAULT_MAX_OUTPUT = 1_000_000;
const DEFAULT_MAX_RUNNING = 8;
/** How long a process gets to exit after SIGTERM before it is killed. */
const STOP_GRACE_MS = 3000;

export class ProcessManager {
  private readonly entries = new Map<string, Entry>();
  private nextId = 1;
  private readonly listeners = new Set<(event: ProcessEvent) => void>();
  /** Processes being stopped on purpose, so their exit reads "stopped" rather than "exited". */
  private readonly stopping = new Set<string>();

  constructor(private readonly options: { maxOutput?: number; maxRunning?: number } = {}) {}

  /** Subscribes to starts, output and exits. Returns the unsubscribe function. */
  onEvent(listener: (event: ProcessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ProcessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Starts a shell command in the background. Throws when too many are already running. */
  start(command: string, cwd: string, owner: string): ProcessInfo {
    const running = [...this.entries.values()].filter((e) => e.info.status === 'running').length;
    const max = this.options.maxRunning ?? DEFAULT_MAX_RUNNING;
    if (running >= max) throw new Error(`${running} background processes are already running (the limit is ${max}). Stop one first.`);
    const info: ProcessInfo = { id: `p${this.nextId++}`, command, cwd, owner, status: 'running', exitCode: null, startedAt: Date.now() };
    const entry: Entry = { info, buffer: '', total: 0 };
    this.entries.set(info.id, entry);
    this.spawn(entry);
    this.emit({ type: 'start', info: { ...info } });
    return { ...info };
  }

  private spawn(entry: Entry): void {
    const { info } = entry;
    const child = spawn(info.command, {
      shell: true,
      cwd: info.cwd,
      // Own process group, so stopping it also stops what it started (npm → node → esbuild…).
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
    });
    entry.child = child;
    const append = (chunk: Buffer) => this.append(entry, chunk.toString('utf8'));
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    // Input to a process that has exited is not an error worth reporting.
    child.stdin?.on('error', () => undefined);
    child.on('error', (err) => {
      this.append(entry, `Failed to start: ${err.message}\n`);
      this.finish(entry, child, null);
    });
    child.on('close', (code) => this.finish(entry, child, code));
  }

  private append(entry: Entry, text: string): void {
    const max = this.options.maxOutput ?? DEFAULT_MAX_OUTPUT;
    entry.buffer += text;
    entry.total += text.length;
    if (entry.buffer.length > max) entry.buffer = entry.buffer.slice(-max);
    this.emit({ type: 'output', id: entry.info.id, text });
  }

  private finish(entry: Entry, child: ChildProcess, code: number | null): void {
    // A restart replaced this child: its exit is not the process's.
    if (entry.child !== child || entry.info.status !== 'running') return;
    entry.child = undefined;
    entry.info.status = this.stopping.delete(entry.info.id) ? 'stopped' : 'exited';
    entry.info.exitCode = code;
    entry.info.endedAt = Date.now();
    this.emit({ type: 'exit', info: { ...entry.info } });
  }

  get(id: string): ProcessInfo | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry.info } : undefined;
  }

  list(): ProcessInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  /** Output since an offset from an earlier read, or all that is kept. */
  read(id: string, since = 0): ProcessOutput | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const oldest = entry.total - entry.buffer.length;
    const from = Math.max(since, oldest);
    return { info: { ...entry.info }, text: entry.buffer.slice(from - oldest), next: entry.total, dropped: since < oldest };
  }

  /** Sends text to the process's input, e.g. a key a dev server listens for. */
  write(id: string, text: string): boolean {
    const child = this.entries.get(id)?.child;
    if (!child?.stdin?.writable) return false;
    child.stdin.write(text);
    return true;
  }

  /** Stops a process and everything it started: SIGTERM, then SIGKILL if it does not exit. */
  async stop(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    const child = entry?.child;
    if (!entry || !child || entry.info.status !== 'running') return false;
    this.stopping.add(id);
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    signal(child, 'SIGTERM');
    const timer = setTimeout(() => signal(child, 'SIGKILL'), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
    return true;
  }

  /** Runs the same command again under the same id, with fresh output. */
  async restart(id: string): Promise<ProcessInfo | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    await this.stop(id);
    entry.buffer = '';
    entry.total = 0;
    Object.assign(entry.info, { status: 'running', exitCode: null, startedAt: Date.now(), endedAt: undefined });
    this.spawn(entry);
    this.emit({ type: 'start', info: { ...entry.info } });
    return { ...entry.info };
  }

  /** Forgets a process that has finished. */
  remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.info.status === 'running') return false;
    this.entries.delete(id);
    return true;
  }

  /** Stops every process a chat started, e.g. when the chat is deleted. */
  async stopOwner(owner: string): Promise<void> {
    await Promise.all(this.list().filter((p) => p.owner === owner).map((p) => this.stop(p.id)));
  }

  /** Kills everything at once, when the extension shuts down. */
  dispose(): void {
    for (const entry of this.entries.values()) if (entry.child) signal(entry.child, 'SIGKILL');
    this.listeners.clear();
  }
}

function signal(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // Already gone.
  }
}
