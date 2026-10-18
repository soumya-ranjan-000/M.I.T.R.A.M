import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { emptyBoard } from '../../src/agent/board';
import type { Board } from '../../src/webview/protocol';

export interface ToolCallRecord {
  name: string;
  ok: boolean;
}

export interface EvalContext {
  dir: string;
  /** Everything the assistant said, concatenated. */
  answer: string;
  toolCalls: ToolCallRecord[];
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
  /** The agent's plan board as it stood when the run ended. */
  board: Board;
  /** Runs `node <args>` in the task directory, optionally with extra environment variables. */
  node(args: string[], env?: Record<string, string>): Promise<{ code: number; out: string }>;
}

export interface CheckResult {
  pass: boolean;
  reason: string;
}

export interface EvalTask {
  id: string;
  title: string;
  /** Files created in a fresh temp directory before the agent runs. */
  files: Record<string, string>;
  prompt: string;
  check(ctx: EvalContext): Promise<CheckResult>;
  /** A known-good outcome, used to prove the check can pass. Applied without any model. */
  solution: {
    writeFiles?: Record<string, string>;
    answer?: string;
    toolCalls?: string[];
    board?: Board;
  };
  /** Negative tests ("must not happen") already pass before the agent acts. */
  expectInitialPass?: boolean;
}

export const ok = (reason = 'ok'): CheckResult => ({ pass: true, reason });
export const fail = (reason: string): CheckResult => ({ pass: false, reason });

export async function writeFixture(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
}

export function makeContext(dir: string, answer = '', toolCalls: ToolCallRecord[] = [], board: Board = emptyBoard()): EvalContext {
  return {
    dir,
    answer,
    toolCalls,
    board,
    read: (rel) => fs.readFile(path.join(dir, rel), 'utf8'),
    exists: (rel) => fs.access(path.join(dir, rel)).then(() => true, () => false),
    node: (args, env) =>
      new Promise((resolve) => {
        execFile('node', args, { cwd: dir, timeout: 15_000, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({ code, out: `${stdout}${stderr}`.trim() });
        });
      }),
  };
}
