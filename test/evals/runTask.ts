import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgent } from '../../src/agent/AgentLoop';
import { emptyBoard } from '../../src/agent/board';
import type { Board } from '../../src/webview/protocol';
import { formatUserMessage } from '../../src/agent/ContextBuilder';
import { buildSystemPrompt } from '../../src/agent/SystemPrompt';
import type { ChatMessage, ModelProvider } from '../../src/providers/ModelProvider';
import { createDefaultRegistry } from '../../src/tools';
import { nodeFilePort } from '../../src/tools/NodeFilePort';
import { EvalTask, ToolCallRecord, makeContext, writeFixture } from './types';

export interface TaskResult {
  id: string;
  pass: boolean;
  reason: string;
  steps: number;
  /** Tasks on the agent's board at the end. */
  boardTasks: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  error?: string;
}

export interface RunOptions {
  maxIterations?: number;
  timeoutMs?: number;
  /** Keep the temp workspace for inspection. */
  keep?: boolean;
}

/**
 * Runs one task the way the extension would: same system prompt, same tools, same
 * safety policy. Every approval is granted, since there is no human in the loop.
 */
export async function runTask(task: EvalTask, provider: ModelProvider, options: RunOptions = {}): Promise<TaskResult> {
  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `mitram-eval-${task.id}-`));
  await writeFixture(dir, task.files);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 240_000);
  const history: ChatMessage[] = [{ role: 'user', content: formatUserMessage(task.prompt, []) }];

  let answer = '';
  let steps = 0;
  let error: string | undefined;
  const toolCalls: ToolCallRecord[] = [];
  const names = new Map<string, string>();
  let board: Board = emptyBoard();
  const totals = { input: 0, output: 0, cacheRead: 0 };

  try {
    await runAgent({
      provider,
      system: buildSystemPrompt({ root: dir, platform: process.platform, date: new Date().toISOString().slice(0, 10) }),
      history,
      registry: createDefaultRegistry(),
      ctx: { root: dir, signal: abort.signal, files: nodeFilePort, board: { get: () => board, set: (b) => (board = b) } },
      maxIterations: options.maxIterations ?? 60,
      contextWindow: 200_000,
      summarizeContext: true,
      verifyBeforeDone: true,
      getBoard: () => board,
      requestApproval: async () => 'approve',
      onEvent: (event) => {
        if (event.type === 'text') answer += event.text;
        else if (event.type === 'tool_start') {
          steps++;
          names.set(event.id, event.name);
        } else if (event.type === 'tool_update' && event.status !== 'running' && event.status !== 'pending') {
          toolCalls.push({ name: names.get(event.id) ?? '?', ok: event.status === 'ok' });
        } else if (event.type === 'usage') {
          totals.input += event.usage.inputTokens;
          totals.output += event.usage.outputTokens;
          totals.cacheRead += event.usage.cacheReadTokens;
        }
      },
    });
  } catch (e) {
    error = abort.signal.aborted ? 'timed out' : (e as Error).message;
  } finally {
    clearTimeout(timer);
  }

  const check = error ? { pass: false, reason: `run failed: ${error}` } : await task.check(makeContext(dir, answer, toolCalls, board));
  if (!options.keep) await fs.rm(dir, { recursive: true, force: true });

  return {
    id: task.id,
    pass: check.pass,
    reason: check.reason,
    steps,
    boardTasks: board.tasks.length,
    ms: Date.now() - started,
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    ...(error ? { error } : {}),
  };
}
