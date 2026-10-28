import { describe, expect, it, vi } from 'vitest';
import { Slots, createSubagentRunner, subagentTools } from '../src/agent/subagents';
import type { ModelProvider, ProviderEvent, StreamRequest } from '../src/providers/ModelProvider';
import { createDelegateTaskTool } from '../src/tools/delegateTask';
import { Delegation, Tool, ToolContext, ToolRegistry } from '../src/tools/Tool';
import { SUBAGENT_TOOL } from '../src/webview/protocol';

/** Resolves on the next turn of the event loop, so queued work can run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const tool = (name: string, requiresApproval = false): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  requiresApproval,
  preview: () => ({ summary: name }),
  run: async () => 'ok',
});

const ctx = (signal: AbortSignal = new AbortController().signal): ToolContext => ({
  root: '/repo',
  signal,
  files: {
    readText: async () => '',
    writeText: async () => {},
    exists: async () => false,
    remove: async () => {},
  },
});

describe('Slots', () => {
  it('reports whether a slot is free', async () => {
    const slots = new Slots(1);
    expect(slots.free).toBe(true);

    let release = () => {};
    const held = slots.use(ctx().signal, () => new Promise<string>((r) => (release = () => r('done'))));
    await tick();

    expect(slots.free).toBe(false);
    release();
    await held;
    expect(slots.free).toBe(true);
  });

  it('reads a size given as a function on every check, so a new setting applies to the next waiter', async () => {
    let size = 1;
    const slots = new Slots(() => size);
    let release = () => {};
    const held = slots.use(ctx().signal, () => new Promise<void>((r) => (release = r)));
    await tick();
    expect(slots.free).toBe(false);
    size = 2;
    expect(slots.free).toBe(true);
    release();
    await held;
  });

  it('runs work and returns its value', async () => {
    expect(await new Slots(2).use(ctx().signal, async () => 42)).toBe(42);
  });

  // The point of the semaphore: more than `size` must never run at once.
  it('never runs more than its size at a time', async () => {
    const slots = new Slots(2);
    const signal = ctx().signal;
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        slots.use(signal, async () => {
          running++;
          peak = Math.max(peak, running);
          await tick();
          running--;
        }),
      ),
    );

    expect(peak).toBe(2);
  });

  it('lets a queued waiter through in turn', async () => {
    const slots = new Slots(1);
    const signal = ctx().signal;
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        slots.use(signal, async () => {
          order.push(n);
          await tick();
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3]);
  });

  // A slot leaked on failure would deadlock every later sub-agent.
  it('frees its slot when the work throws', async () => {
    const slots = new Slots(1);
    const signal = ctx().signal;

    await expect(slots.use(signal, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(slots.free).toBe(true);
    expect(await slots.use(signal, async () => 'after')).toBe('after');
  });

  it('refuses to start once the run is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new Slots(1).use(controller.signal, async () => 'never')).rejects.toThrow(/Abort/i);
  });

  it('gives up waiting when the run is aborted', async () => {
    const slots = new Slots(1);
    const controller = new AbortController();
    let release = () => {};
    const held = slots.use(ctx().signal, () => new Promise<void>((r) => (release = r)));
    await tick();

    const queued = slots.use(controller.signal, async () => 'never');
    await tick();
    controller.abort();

    await expect(queued).rejects.toThrow(/Abort/i);
    release();
    await held;
  });

  it('does not start work that was queued behind an aborted waiter', async () => {
    const slots = new Slots(1);
    const controller = new AbortController();
    const work = vi.fn(async () => 'ran');
    let release = () => {};
    const held = slots.use(ctx().signal, () => new Promise<void>((r) => (release = r)));
    await tick();

    const queued = slots.use(controller.signal, work);
    await tick();
    controller.abort();
    release();
    await held;
    await expect(queued).rejects.toThrow(/Abort/i);

    expect(work).not.toHaveBeenCalled();
  });
});

describe('subagentTools', () => {
  const registry = () =>
    new ToolRegistry()
      .register(tool('read_file'))
      .register(tool('search_files'))
      .register(tool('edit_file', true))
      .register(tool('run_command', true))
      .register(tool('update_board'))
      .register(tool(SUBAGENT_TOOL));

  // A sub-agent that could delegate would recurse without limit.
  it('never lets a sub-agent delegate again', () => {
    for (const mode of ['explore', 'implement'] as const) {
      expect(subagentTools(registry(), mode).get(SUBAGENT_TOOL)).toBeUndefined();
    }
  });

  // The board is the main agent's plan; a sub-agent must not rewrite it.
  it('never gives a sub-agent the board', () => {
    for (const mode of ['explore', 'implement'] as const) {
      expect(subagentTools(registry(), mode).get('update_board')).toBeUndefined();
    }
  });

  it('gives an explore sub-agent only tools that change nothing', () => {
    const tools = subagentTools(registry(), 'explore');
    expect(tools.get('read_file')).toBeDefined();
    expect(tools.get('search_files')).toBeDefined();
    expect(tools.get('edit_file')).toBeUndefined();
    expect(tools.get('run_command')).toBeUndefined();
  });

  it('gives an implement sub-agent the tools that change things', () => {
    const tools = subagentTools(registry(), 'implement');
    expect(tools.get('edit_file')).toBeDefined();
    expect(tools.get('run_command')).toBeDefined();
    expect(tools.get('read_file')).toBeDefined();
  });

  it('leaves the registry of the main agent untouched', () => {
    const main = registry();
    subagentTools(main, 'explore');
    expect(main.get(SUBAGENT_TOOL)).toBeDefined();
    expect(main.get('update_board')).toBeDefined();
    expect(main.size).toBe(6);
  });
});

describe('delegate_task: the tool definition', () => {
  it('offers both modes when editing is allowed', () => {
    const schema = createDelegateTaskTool({ canImplement: true }).inputSchema as {
      properties: { mode: { enum: string[] } };
    };
    expect(schema.properties.mode.enum).toEqual(['explore', 'implement']);
  });

  // In plan mode nothing may change, so the model must not be offered a mode it cannot use.
  it('offers only explore in plan mode', () => {
    const schema = createDelegateTaskTool({ canImplement: false }).inputSchema as {
      properties: { mode: { enum: string[] } };
    };
    expect(schema.properties.mode.enum).toEqual(['explore']);
  });

  // It only starts another agent, so it is not itself an action needing approval.
  it('does not ask for approval itself', () => {
    expect(createDelegateTaskTool({ canImplement: true }).requiresApproval).toBe(false);
  });
});

describe('delegate_task: preview', () => {
  const tool = createDelegateTaskTool({ canImplement: true });

  it('shows the description and the brief', () => {
    const preview = tool.preview({ description: 'Map the auth flow', prompt: 'Find where login happens.' });
    expect(preview.summary).toBe('Map the auth flow');
    expect(preview.detail).toBe('Find where login happens.');
  });

  it('says whether the sub-agent can change anything', () => {
    expect(tool.preview({ description: 'x', prompt: 'y' }).badge).toBe('read-only');
    expect(tool.preview({ description: 'x', prompt: 'y', mode: 'explore' }).badge).toBe('read-only');
    expect(tool.preview({ description: 'x', prompt: 'y', mode: 'implement' }).badge).toBe('can edit');
  });

  it('never promises editing in plan mode', () => {
    const planTool = createDelegateTaskTool({ canImplement: false });
    expect(planTool.preview({ description: 'x', prompt: 'y', mode: 'implement' }).badge).toBe('read-only');
  });

  it('falls back to a label when the description is missing or odd', () => {
    expect(tool.preview({ prompt: 'y' }).summary).toBe('Sub-agent');
    expect(tool.preview({ description: '   ', prompt: 'y' }).summary).toBe('Sub-agent');
    expect(tool.preview({ description: 42, prompt: 'y' }).summary).toBe('Sub-agent');
  });

  // The agent loop wraps preview() in try/catch (AgentLoop.ts) because the model can send
  // anything, so preview is only required to cope with an object that has odd fields; run()
  // reports the precise error. This pins the part callers rely on.
  it('copes with an object whose fields are missing or the wrong type', () => {
    expect(() => tool.preview({})).not.toThrow();
    expect(tool.preview({}).summary).toBe('Sub-agent');
    expect(tool.preview({ description: 'x', prompt: 42 }).detail).toBeUndefined();
    expect(tool.preview({ description: 'x', prompt: 'y', mode: 99 }).badge).toBe('read-only');
  });
});

describe('delegate_task: input validation', () => {
  const runner = { run: vi.fn(async (_task: Delegation, _ctx: ToolContext) => 'the report') };
  const withRunner = (signal?: AbortSignal): ToolContext => ({
    ...ctx(signal),
    subagents: runner,
    callId: 'call-1',
  });

  it('passes a valid task to the runner and returns its report', async () => {
    runner.run.mockClear();
    const out = await createDelegateTaskTool({ canImplement: true }).run(
      { description: 'Map the auth flow', prompt: 'Find where login happens.', mode: 'implement' },
      withRunner(),
    );

    expect(out).toBe('the report');
    expect(runner.run.mock.calls[0][0]).toEqual({
      callId: 'call-1',
      description: 'Map the auth flow',
      prompt: 'Find where login happens.',
      mode: 'implement',
    });
  });

  it('defaults to the read-only mode', async () => {
    runner.run.mockClear();
    await createDelegateTaskTool({ canImplement: true }).run({ description: 'x', prompt: 'y' }, withRunner());
    expect(runner.run.mock.calls[0][0].mode).toBe('explore');
  });

  it('requires a description and a brief', async () => {
    const tool = createDelegateTaskTool({ canImplement: true });
    await expect(tool.run({ prompt: 'y' }, withRunner())).rejects.toThrow(/"description" is required/);
    await expect(tool.run({ description: 'x' }, withRunner())).rejects.toThrow(/"prompt" is required/);
    await expect(tool.run({ description: 'x', prompt: '   ' }, withRunner())).rejects.toThrow(/must not be empty/);
  });

  it('rejects a mode it does not know', async () => {
    await expect(
      createDelegateTaskTool({ canImplement: true }).run({ description: 'x', prompt: 'y', mode: 'rewrite' }, withRunner()),
    ).rejects.toThrow(/"mode" must be/);
  });

  // Plan mode promises nothing changes, so this must be refused at run time, not just in the schema.
  it('refuses to implement in plan mode', async () => {
    await expect(
      createDelegateTaskTool({ canImplement: false }).run({ description: 'x', prompt: 'y', mode: 'implement' }, withRunner()),
    ).rejects.toThrow(/Plan mode is on/);
  });

  it('explains itself when sub-agents are unavailable', async () => {
    const tool = createDelegateTaskTool({ canImplement: true });
    await expect(tool.run({ description: 'x', prompt: 'y' }, ctx())).rejects.toThrow(/not available here/);
  });
});

/**
 * A provider that says `text` and stops, without calling any tool.
 *
 * The request's `messages` is the live history array, which the loop appends to after this
 * returns, so it is copied here to record what the sub-agent was actually sent.
 */
function sayProvider(text: string, seen?: StreamRequest[]): ModelProvider {
  return {
    async *stream(request: StreamRequest): AsyncIterable<ProviderEvent> {
      seen?.push({ ...request, messages: structuredClone(request.messages) });
      yield { type: 'text_delta', text };
      yield { type: 'stop', reason: 'end_turn' };
    },
  };
}

function runnerDeps(provider: ModelProvider, over: Partial<Parameters<typeof createSubagentRunner>[0]> = {}) {
  return {
    provider,
    registry: new ToolRegistry().register(tool('read_file')).register(tool('edit_file', true)),
    system: (readOnly: boolean) => (readOnly ? 'read-only system' : 'implement system'),
    maxSteps: 4,
    maxConcurrent: 2,
    onEvent: () => {},
    onNote: () => {},
    requestApproval: async () => 'approve' as const,
    ...over,
  };
}

describe('createSubagentRunner', () => {
  const task = { callId: 'call-1', description: 'Investigate', prompt: 'Find the bug.', mode: 'explore' as const };

  it('returns the sub-agent\'s last words as the report', async () => {
    const runner = createSubagentRunner(runnerDeps(sayProvider('I found the bug in auth.ts.')));
    expect(await runner.run(task, ctx())).toBe('I found the bug in auth.ts.');
  });

  it('says so when the sub-agent reports nothing', async () => {
    const runner = createSubagentRunner(runnerDeps(sayProvider('   ')));
    expect(await runner.run(task, ctx())).toMatch(/finished without writing a report/);
  });

  it('gives an explore sub-agent the read-only prompt and tools', async () => {
    const seen: StreamRequest[] = [];
    const runner = createSubagentRunner(runnerDeps(sayProvider('done', seen)));

    await runner.run(task, ctx());

    expect(seen[0].system).toBe('read-only system');
    expect(seen[0].tools?.map((t) => t.name)).toEqual(['read_file']);
  });

  it('gives an implement sub-agent the editing prompt and tools', async () => {
    const seen: StreamRequest[] = [];
    const runner = createSubagentRunner(runnerDeps(sayProvider('done', seen)));

    await runner.run({ ...task, mode: 'implement' }, ctx());

    expect(seen[0].system).toBe('implement system');
    expect(seen[0].tools?.map((t) => t.name).sort()).toEqual(['edit_file', 'read_file']);
  });

  // The sub-agent knows nothing of the main conversation: its history starts with the brief.
  it('starts the sub-agent with only its brief', async () => {
    const seen: StreamRequest[] = [];
    const runner = createSubagentRunner(runnerDeps(sayProvider('done', seen)));

    await runner.run(task, ctx());

    expect(seen[0].messages).toEqual([{ role: 'user', content: 'Find the bug.' }]);
  });

  it('tells the user when a sub-agent is queued, then clears the note', async () => {
    const notes: string[] = [];
    const deps = runnerDeps(sayProvider('done'), { maxConcurrent: 1, onNote: (_id, note) => notes.push(note) });
    const runner = createSubagentRunner(deps);

    await Promise.all([runner.run(task, ctx()), runner.run({ ...task, callId: 'call-2' }, ctx())]);

    expect(notes.some((n) => /Queued/.test(n))).toBe(true);
    // The note is cleared once it starts, so the card does not keep saying "Queued".
    expect(notes[notes.length - 1]).toBe('');
  });

  it('passes the sub-agent\'s events up under its own call id', async () => {
    const events: string[] = [];
    const runner = createSubagentRunner(
      runnerDeps(sayProvider('done'), { onEvent: (parentId, event) => events.push(`${parentId}:${event.type}`) }),
    );

    await runner.run(task, ctx());

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.startsWith('call-1:'))).toBe(true);
  });
});
