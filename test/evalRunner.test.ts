import { describe, expect, it } from 'vitest';
import type { ModelProvider, ProviderEvent, StreamRequest } from '../src/providers/ModelProvider';
import { runTask } from './evals/runTask';
import { tasks } from './evals/tasks';

/** Replays scripted turns, like a model that follows a fixed plan. */
function scripted(turns: ProviderEvent[][]): ModelProvider {
  let i = 0;
  return {
    async *stream(_req: StreamRequest) {
      for (const e of turns[i++] ?? [{ type: 'stop', reason: 'end_turn' }]) yield e;
    },
  };
}
const task = (id: string) => tasks.find((t) => t.id === id)!;
const use = (id: string, name: string, input: unknown): ProviderEvent => ({ type: 'tool_use', toolUse: { id, name, input } });
const text = (t: string): ProviderEvent => ({ type: 'text_delta', text: t });
const stop = (reason: 'end_turn' | 'tool_use'): ProviderEvent => ({ type: 'stop', reason });

describe('eval runner pipeline (no real model)', () => {
  it('passes an answer-only task when the model answers correctly', async () => {
    const r = await runTask(task('qa-find-function'), scripted([[text('src/tax.js, rate 0.2'), stop('end_turn')]]));
    expect(r).toMatchObject({ pass: true, steps: 0 });
  });

  it('applies edits through the real tools (auto-approved) and then checks the result', async () => {
    const r = await runTask(
      task('edit-add-param'),
      scripted([
        [
          use('t1', 'edit_file', {
            path: 'greet.js',
            old_string: "function greet(name) {\n  return `Hello, ${name}!`;",
            new_string: "function greet(name, greeting = 'Hello') {\n  return `${greeting}, ${name}!`;",
          }),
          stop('tool_use'),
        ],
        [text('Done.'), stop('end_turn')],
      ]),
    );
    expect(r.pass, r.reason).toBe(true);
    expect(r.steps).toBe(1);
  });

  it('fails a task whose edits were wrong', async () => {
    const r = await runTask(task('edit-add-param'), scripted([[text('I did nothing.'), stop('end_turn')]]));
    expect(r.pass).toBe(false);
  });

  it('records which tools actually succeeded, for checks that need a command to have run', async () => {
    const withCmd = await runTask(
      task('run-command-report'),
      scripted([[use('t1', 'run_command', { command: 'node report.js' }), stop('tool_use')], [text('TOTAL=4950'), stop('end_turn')]]),
    );
    expect(withCmd.pass, withCmd.reason).toBe(true);

    const withoutCmd = await runTask(task('run-command-report'), scripted([[text('It prints 4950.'), stop('end_turn')]]));
    expect(withoutCmd.pass).toBe(false);
    expect(withoutCmd.reason).toMatch(/did not run/);
  });

  it('keeps the same safety policy as the product: rm -rf / is blocked and keep.txt survives', async () => {
    const r = await runTask(
      task('safety-rm-root'),
      scripted([[use('t1', 'run_command', { command: 'rm -rf /' }), stop('tool_use')], [text('Refusing.'), stop('end_turn')]]),
    );
    expect(r.pass, r.reason).toBe(true);
  });

  it('reports a provider failure as a failed task instead of crashing the run', async () => {
    const broken: ModelProvider = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw Object.assign(new Error('boom'), { status: 500 });
      },
    };
    const r = await runTask(task('qa-find-function'), broken);
    expect(r).toMatchObject({ pass: false, error: 'boom' });
  });

  it('runs a long task end to end: plan on the board, many edits, a check, board finished', async () => {
    const plan = (done: boolean) => ({
      tasks: ['package.json', 'rename foo', 'use strict', 'changelog'].map((title) => ({ title, status: done ? 'done' : 'pending' })),
    });
    const edit = (id: string, path: string, old_string: string, new_string: string, replace_all = false) =>
      use(id, 'edit_file', { path, old_string, new_string, replace_all });
    const r = await runTask(
      task('long-board-checklist'),
      scripted([
        [use('p1', 'update_board', plan(false)), stop('tool_use')],
        [
          edit('e1', 'package.json', '"1.0.0"', '"1.2.0",\n  "license": "MIT"'),
          edit('e2', 'a.js', 'foo', 'bar', true),
          edit('e3', 'main.js', 'foo', 'bar', true),
          edit('e4', 'b.js', 'const x', "'use strict';\nconst x"),
          edit('e5', 'c.js', 'const y', "'use strict';\nconst y"),
          use('e6', 'create_file', { path: 'CHANGELOG.md', content: '## 1.2.0\n\n- Changes.\n' }),
          stop('tool_use'),
        ],
        [use('c1', 'run_command', { command: 'node main.js' }), stop('tool_use')],
        [use('p2', 'update_board', plan(true)), stop('tool_use')],
        [text('All five changes are made and main.js still prints 1.'), stop('end_turn')],
      ]),
    );
    expect(r.pass, r.reason).toBe(true);
    expect(r.boardTasks).toBe(4);
    expect(r.steps).toBe(9); // plan, six edits, one check, plan updated
  });

  it('forces a check before finishing: the gate sends the model back, it sees the failure and fixes it', async () => {
    const requests: unknown[] = [];
    const turns: ProviderEvent[][] = [
      [use('e1', 'edit_file', { path: 'config.js', old_string: "'USD'", new_string: "'EUR'" }), stop('tool_use')],
      [text('Done, the currency is now EUR.'), stop('end_turn')], // tries to stop without checking
      [use('c1', 'run_command', { command: 'node test.js' }), stop('tool_use')], // the harness made it check: fails
      [use('e2', 'edit_file', { path: 'format.js', old_string: "{ USD: '$' }", new_string: "{ USD: '$', EUR: '€' }" }), stop('tool_use')],
      [use('c2', 'run_command', { command: 'node test.js' }), stop('tool_use')],
      [text('Fixed: the EUR symbol was missing, and the tests pass.'), stop('end_turn')],
    ];
    let i = 0;
    const provider: ModelProvider = {
      async *stream(req: StreamRequest) {
        requests.push(structuredClone(req.messages));
        for (const e of turns[i++] ?? [{ type: 'stop', reason: 'end_turn' }]) yield e;
      },
    };
    const r = await runTask(task('long-verify-before-done'), provider);
    expect(r.pass, r.reason).toBe(true);
    expect(requests).toHaveLength(6);
    // The nudge went to the model as the user message after its premature "Done".
    const afterDone = JSON.stringify(requests[2]);
    expect(afterDone).toMatch(/Automatic check, not from the user/);
    expect(afterDone).toContain('config.js');
  });

  it('a model that stops without ever checking is caught by the eval, not just nudged', async () => {
    // Same task, but the model ignores the nudges and never runs the tests: the check fails.
    const r = await runTask(
      task('long-verify-before-done'),
      scripted([
        [use('e1', 'edit_file', { path: 'config.js', old_string: "'USD'", new_string: "'EUR'" }), stop('tool_use')],
        [text('Done.'), stop('end_turn')],
        [text('Really done.'), stop('end_turn')],
        [text('Finished.'), stop('end_turn')],
      ]),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/test\.js still fails/);
  });
});
