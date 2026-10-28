import type Anthropic from '@anthropic-ai/sdk';
import type { Board } from '../webview/protocol';
import type { ProcessInfo, ProcessOutput } from './processes';

export interface FilePort {
  readText(absPath: string): Promise<string>;
  writeText(absPath: string, content: string): Promise<void>;
  exists(absPath: string): Promise<boolean>;
  remove(absPath: string): Promise<void>;
}

/** Background processes, as seen from one chat. Every chat sees every process; `owner` says which are its own. */
export interface ProcessPort {
  /** The chat this port belongs to, to tell its processes from others'. */
  owner: string;
  /** Starts a command in the workspace root and leaves it running. */
  start(command: string): ProcessInfo;
  read(id: string, since?: number): ProcessOutput | undefined;
  stop(id: string): Promise<boolean>;
  list(): ProcessInfo[];
}

/** Read and write access to the agent's board for the current chat. */
export interface BoardAccess {
  get(): Board;
  set(board: Board): void;
}

export interface ToolContext {
  /** Absolute path of the workspace root. */
  root: string;
  signal: AbortSignal;
  files: FilePort;
  /** Formats current editor diagnostics, optionally for one workspace-relative path. */
  diagnostics?: (relPath?: string) => Promise<string>;
  /** Extra user-configured patterns that block a command outright. */
  blockedCommandPatterns?: RegExp[];
  /** The agent's plan board for this chat. */
  board?: BoardAccess;
  /** The id of the tool call being run. Set by the agent loop for each call. */
  callId?: string;
  /** Shows the output so far on the call's card while it runs. Set by the agent loop for each call. */
  progress?: (output: string) => void;
  /** Starts sub-agents for delegate_task. Not set where delegation is off, or inside a sub-agent. */
  subagents?: SubagentRunner;
  /** Background processes. Not set where they are not available, e.g. in tests and evals. */
  processes?: ProcessPort;
}

/** read-only: explore and report. implement: may also edit files and run commands. */
export type SubagentMode = 'explore' | 'implement';

export interface Delegation {
  /** The delegate_task call this sub-agent belongs to; its card shows the sub-agent's calls. */
  callId: string;
  description: string;
  prompt: string;
  mode: SubagentMode;
}

export interface SubagentRunner {
  /** Runs a sub-agent on the task and resolves with its final report. */
  run(task: Delegation, ctx: ToolContext): Promise<string>;
}

export interface ToolPreview {
  summary: string;
  detail?: string;
  /** A short label shown next to the summary on the card. */
  badge?: string;
}

/** The result an edit would produce, computed without writing anything. */
export interface ProposedChange {
  /** Workspace-relative path. */
  path: string;
  abs: string;
  /** Current content, or null if the file does not exist yet. */
  before: string | null;
  after: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool['input_schema'];
  /** Edits and commands need the user's approval before they run. */
  requiresApproval: boolean;
  preview(input: unknown): ToolPreview;
  /** Returns a reason if the call must be blocked outright (no approval prompt), else null. */
  policy?(input: unknown, ctx: ToolContext): string | null;
  /** For file-changing tools: what the file would look like after the call. */
  propose?(input: unknown, ctx: ToolContext): Promise<ProposedChange>;
  /** Returns the text sent back to the model. Throw to report an error to it. */
  run(input: unknown, ctx: ToolContext): Promise<string>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  definitions(): Anthropic.Tool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /** A registry with only the tools that never change anything (used by plan mode). */
  readOnly(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const tool of this.tools.values()) if (!tool.requiresApproval) copy.register(tool);
    return copy;
  }

  /** A registry without the named tools. */
  without(...names: string[]): ToolRegistry {
    const copy = new ToolRegistry();
    for (const tool of this.tools.values()) if (!names.includes(tool.name)) copy.register(tool);
    return copy;
  }

  get size(): number {
    return this.tools.size;
  }
}

/** Thrown for bad tool input; the message goes straight back to the model. */
export class ToolInputError extends Error {}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ToolInputError('Tool input must be a JSON object.');
  }
  return input as Record<string, unknown>;
}

export function reqString(input: unknown, key: string): string {
  const v = asRecord(input)[key];
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" is required and must be a string.`);
  return v;
}

export function optString(input: unknown, key: string): string | undefined {
  const v = asRecord(input)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string.`);
  return v;
}

export function optInt(input: unknown, key: string): number | undefined {
  const v = asRecord(input)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolInputError(`"${key}" must be an integer.`);
  return v;
}

export function optBool(input: unknown, key: string): boolean | undefined {
  const v = asRecord(input)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolInputError(`"${key}" must be a boolean.`);
  return v;
}

/** Keeps the start and end of long text, dropping the middle. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n… [${dropped} characters truncated] …\n${text.slice(text.length - half)}`;
}
