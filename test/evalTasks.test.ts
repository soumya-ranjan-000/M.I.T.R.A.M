import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tasks } from './evals/tasks';
import { makeContext, writeFixture } from './evals/types';

// These tests never call a model. They prove the eval checks are sound:
// each check must FAIL on the untouched fixture and PASS once a reference solution is applied.

let base: string;
beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-evals-'));
});
afterAll(() => fs.rm(base, { recursive: true, force: true }));

describe('eval task set', () => {
  it('has 20-30 tasks with unique ids and a prompt each', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    expect(tasks.length).toBeLessThanOrEqual(30);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    for (const t of tasks) expect(t.prompt.length).toBeGreaterThan(10);
  });
});

describe.each(tasks)('eval task $id', (task) => {
  it('is not already solved before the agent acts (unless it is a "must not happen" test)', async () => {
    const dir = await fs.mkdtemp(path.join(base, `${task.id}-before-`));
    await writeFixture(dir, task.files);
    const result = await task.check(makeContext(dir));
    expect(result.pass, `check passed on the untouched fixture: ${result.reason}`).toBe(!!task.expectInitialPass);
  });

  it('passes with the reference solution', async () => {
    const dir = await fs.mkdtemp(path.join(base, `${task.id}-after-`));
    await writeFixture(dir, task.files);
    await writeFixture(dir, task.solution.writeFiles ?? {});
    const toolCalls = (task.solution.toolCalls ?? []).map((name) => ({ name, ok: true }));
    const result = await task.check(makeContext(dir, task.solution.answer ?? '', toolCalls, task.solution.board));
    expect(result.pass, result.reason).toBe(true);
  });
});
