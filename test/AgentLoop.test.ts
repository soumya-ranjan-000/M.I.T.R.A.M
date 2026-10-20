import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentEvent, AgentOptions, runAgent } from '../src/agent/AgentLoop';
import { SUMMARY_PREFIX } from '../src/agent/contextManager';
import { SUMMARY_SYSTEM } from '../src/agent/summarize';
import { emptyBoard } from '../src/agent/board';
import type { Board } from '../src/webview/protocol';
import type { ChatMessage, ModelProvider, ProviderEvent, StreamRequest } from '../src/providers/ModelProvider';
import { createDefaultRegistry } from '../src/tools';
import { nodeFilePort } from '../src/tools/NodeFilePort';

type Turn = ProviderEvent[];

/** A provider that replays scripted turns and records the requests it received. */
function scripted(turns: Turn[], summaryText: string | Error = 'SUMMARY TEXT') {
  const requests: ChatMessage[][] = [];
  const volatiles: (string | undefined)[] = [];
  const counts = { summaries: 0 };
  let i = 0;
  const provider: ModelProvider & { requests: ChatMessage[][]; volatiles: (string | undefined)[]; counts: { summaries: number } } = {
    requests,
    volatiles,
    counts,
    async *stream(req: StreamRequest) {
      if (req.system === SUMMARY_SYSTEM) {
        counts.summaries++;
        if (summaryText instanceof Error) throw summaryText;
        yield { type: 'text_delta', text: summaryText };
        yield { type: 'stop', reason: 'end_turn' };
        return;
      }
      volatiles.push(req.volatileContext);
      requests.push(structuredClone(req.messages));
      for (const e of turns[i++] ?? [{ type: 'stop', reason: 'end_turn' }]) yield e;
    },
  };
  return provider;
}

const use = (id: string, name: string, input: unknown): ProviderEvent => ({
  type: 'tool_use',
  toolUse: { id, name, input },
});
const text = (t: string): ProviderEvent => ({ type: 'text_delta', text: t });
const stop = (reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'): ProviderEvent => ({ type: 'stop', reason });

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-loop-'));
  await fs.writeFile(path.join(tmp, 'a.txt'), 'hello world');
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

function setup(turns: Turn[], over: Partial<AgentOptions> = {}, summaryText?: string | Error) {
  const provider = scripted(turns, summaryText);
  const events: AgentEvent[] = [];
  const history: ChatMessage[] = [{ role: 'user', content: 'go' }];
  const ac = new AbortController();
  const options: AgentOptions = {
    provider,
    system: 'sys',
    history,
    registry: createDefaultRegistry(),
    ctx: { root: tmp, signal: ac.signal, files: nodeFilePort },
    maxIterations: 10,
    onEvent: (e) => events.push(e),
    requestApproval: async () => 'approve',
    ...over,
  };
  return { provider, events, history, options, ac };
}

describe('runAgent file changes', () => {
  it('reports what each edit and creation changed, keyed by the tool call', async () => {
    await fs.writeFile(path.join(tmp, 'diffme.txt'), 'one two');
    const changes: { callId: string; abs: string; before: string | null; after: string }[] = [];
    const { options } = setup(
      [
        [
          use('e1', 'edit_file', { path: 'diffme.txt', old_string: 'two', new_string: '2' }),
          use('c1', 'create_file', { path: 'made/new.txt', content: 'fresh' }),
          stop('tool_use'),
        ],
        [stop('end_turn')],
      ],
      { onFileChange: (c) => changes.push(c) },
    );
    await runAgent(options);

    const edit = changes.find((c) => c.callId === 'e1');
    const create = changes.find((c) => c.callId === 'c1');
    expect(edit).toMatchObject({ abs: path.join(tmp, 'diffme.txt'), before: 'one two', after: 'one 2' });
    expect(create).toMatchObject({ abs: path.join(tmp, 'made', 'new.txt'), before: null, after: 'fresh' });
  });

  it('reports nothing for a rejected edit', async () => {
    const changes: unknown[] = [];
    const { options } = setup(
      [[use('e2', 'edit_file', { path: 'a.txt', old_string: 'hello', new_string: 'bye' }), stop('tool_use')], [stop('end_turn')]],
      { onFileChange: (c) => changes.push(c), requestApproval: async () => 'reject' },
    );
    await runAgent(options);
    expect(changes).toEqual([]);
  });
});

describe('runAgent', () => {
  it('runs a tool and feeds the result back to the model', async () => {
    const { options, history, events, provider } = setup([
      [text('Let me look. '), use('t1', 'read_file', { path: 'a.txt' }), stop('tool_use')],
      [text('It says hello.'), stop('end_turn')],
    ]);
    await runAgent(options);

    expect(provider.requests).toHaveLength(2);
    const second = provider.requests[1];
    const toolResultMsg = second[second.length - 1];
    expect(toolResultMsg.role).toBe('user');
    expect(JSON.stringify(toolResultMsg.content)).toContain('1\\thello world');

    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(events.filter((e) => e.type === 'tool_update').map((e: any) => e.status)).toEqual(['ok']);
  });

  it('turns tool errors into is_error results instead of crashing', async () => {
    const { options, history } = setup([
      [use('t1', 'read_file', { path: 'missing.txt' }), stop('tool_use')],
      [text('ok'), stop('end_turn')],
    ]);
    await runAgent(options);
    const result = (history[2].content as any[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/not found/);
  });

  it('answers unknown tools with an error result', async () => {
    const { options, history } = setup([
      [use('t1', 'format_disk', {}), stop('tool_use')],
      [stop('end_turn')],
    ]);
    await runAgent(options);
    expect((history[2].content as any[])[0].is_error).toBe(true);
  });

  it('asks for approval before mutating tools and honours rejection', async () => {
    const asked: string[] = [];
    const { options, history } = setup(
      [
        [use('t1', 'create_file', { path: 'new.txt', content: 'x' }), stop('tool_use')],
        [stop('end_turn')],
      ],
      {
        requestApproval: async (r) => {
          asked.push(r.tool.name);
          return 'reject';
        },
      },
    );
    await runAgent(options);
    expect(asked).toEqual(['create_file']);
    await expect(fs.access(path.join(tmp, 'new.txt'))).rejects.toThrow();
    expect((history[2].content as any[])[0].content).toMatch(/rejected/);
  });

  it('runs mutating tools once approved, and never asks for read-only tools', async () => {
    const asked: string[] = [];
    const { options } = setup(
      [
        [use('t1', 'read_file', { path: 'a.txt' }), use('t2', 'create_file', { path: 'ok.txt', content: 'yes' }), stop('tool_use')],
        [stop('end_turn')],
      ],
      { requestApproval: async (r) => (asked.push(r.tool.name), 'approve') },
    );
    await runAgent(options);
    expect(asked).toEqual(['create_file']);
    expect(await fs.readFile(path.join(tmp, 'ok.txt'), 'utf8')).toBe('yes');
  });

  it('never executes calls from a response cut off by max_tokens', async () => {
    const { options, history } = setup([
      [use('t1', 'create_file', { path: 'cut.txt', content: 'partial' }), stop('max_tokens')],
      [stop('end_turn')],
    ]);
    await runAgent(options);
    await expect(fs.access(path.join(tmp, 'cut.txt'))).rejects.toThrow();
    expect((history[2].content as any[])[0].is_error).toBe(true);
  });

  it('stops at the iteration limit with a notice', async () => {
    const looping: Turn = [use('t', 'list_dir', {}), stop('tool_use')];
    const { options, events } = setup([looping, looping, looping], { maxIterations: 2 });
    await runAgent(options);
    const notice = events.filter((e) => e.type === 'notice').at(-1) as any;
    expect(notice.text).toMatch(/Paused after 2 steps/);
    expect(events.at(-1)).toEqual({ type: 'budget', reason: 'steps', steps: 2 });
  });

  it('keeps history valid when cancelled mid-turn', async () => {
    const { options, history, ac } = setup(
      [[use('t1', 'create_file', { path: 'c.txt', content: 'x' }), stop('tool_use')]],
      {
        requestApproval: async () => {
          ac.abort();
          return 'reject';
        },
      },
    );
    await expect(runAgent(options)).rejects.toMatchObject({ name: 'AbortError' });
    // assistant tool_use is always followed by its tool_result
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((history[2].content as any[])[0].type).toBe('tool_result');
  });

  it('reports refusals', async () => {
    const { options, events } = setup([[stop('refusal')]]);
    await runAgent(options);
    expect(events.some((e) => e.type === 'notice')).toBe(true);
  });

  it('blocks dangerous commands without ever asking for approval', async () => {
    const asked: string[] = [];
    const { options, history, events } = setup(
      [
        [use('t1', 'run_command', { command: 'rm -rf /' }), stop('tool_use')],
        [stop('end_turn')],
      ],
      { requestApproval: async (r) => (asked.push(r.tool.name), 'approve') },
    );
    await runAgent(options);
    expect(asked).toEqual([]);
    const result = (history[2].content as any[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/Blocked by safety policy/);
    expect(events.filter((e) => e.type === 'tool_update').map((e: any) => e.status)).toEqual(['error']);
  });

  it('passes the tool input to the approval request', async () => {
    let seen: unknown;
    const { options } = setup(
      [[use('t1', 'create_file', { path: 'in.txt', content: 'x' }), stop('tool_use')], [stop('end_turn')]],
      { requestApproval: async (r) => ((seen = r.input), 'reject') },
    );
    await runAgent(options);
    expect(seen).toEqual({ path: 'in.txt', content: 'x' });
  });

  it('does not prompt, or show a pending card, for auto-approved actions', async () => {
    const asked: string[] = [];
    const { options, events } = setup(
      [[use('t1', 'create_file', { path: 'auto.txt', content: 'yes' }), stop('tool_use')], [stop('end_turn')]],
      {
        isAutoApproved: () => true,
        requestApproval: async (r) => (asked.push(r.tool.name), 'reject'),
      },
    );
    await runAgent(options);
    expect(asked).toEqual([]);
    expect(await fs.readFile(path.join(tmp, 'auto.txt'), 'utf8')).toBe('yes');
    const statuses = events
      .filter((e) => e.type === 'tool_start' || e.type === 'tool_update')
      .map((e: any) => e.status);
    expect(statuses).toEqual(['running', 'ok']); // never 'pending'
  });

  it('still blocks dangerous commands even when everything is auto-approved', async () => {
    const { options, history } = setup(
      [[use('t1', 'run_command', { command: 'sudo rm -rf /' }), stop('tool_use')], [stop('end_turn')]],
      { isAutoApproved: () => true },
    );
    await runAgent(options);
    expect((history[2].content as any[])[0].content).toMatch(/Blocked by safety policy/);
  });

  it('passes reasoning through as events without putting it in the model history', async () => {
    const { options, history, events } = setup([
      [{ type: 'thinking_delta', text: 'hmm ' }, { type: 'thinking_delta', text: 'ok' }, text('Answer'), stop('end_turn')],
    ]);
    await runAgent(options);
    expect(events.filter((e) => e.type === 'thinking').map((e: any) => e.text).join('')).toBe('hmm ok');
    expect(JSON.stringify(history)).not.toContain('hmm');
  });

  // ---------- board ----------
  describe('the board', () => {
    const boardOf = (...tasks: [string, Board['tasks'][number]['status']][]): Board => ({
      tasks: tasks.map(([title, status]) => ({ title, status })),
      notes: '',
    });

    it('is shown to the model at the end of every request, always as the latest version', async () => {
      let board: Board = emptyBoard();
      const access = { get: () => board, set: (b: Board) => (board = b) };
      const { options, provider } = setup(
        [
          [use('b1', 'update_board', { tasks: [{ title: 'a', status: 'pending' }, { title: 'b', status: 'pending' }] }), stop('tool_use')],
          [use('b2', 'update_board', { tasks: [{ title: 'a', status: 'done' }, { title: 'b', status: 'done' }] }), stop('tool_use')],
          [text('All done.'), stop('end_turn')],
        ],
        { getBoard: () => board },
      );
      options.ctx.board = access;
      await runAgent(options);

      expect(provider.volatiles[0]).toBeUndefined(); // nothing on the board yet
      expect(provider.volatiles[1]).toContain('Progress: 0 of 2 done');
      expect(provider.volatiles[2]).toContain('Progress: 2 of 2 done');
      // It is never written into the history, so trimming can't remove it and caching isn't disturbed.
      expect(JSON.stringify(options.history)).not.toContain('<board>');
    });

    it('stops the model finishing while tasks are pending, then lets it finish once they are done', async () => {
      let board = boardOf(['write code', 'done'], ['write tests', 'pending']);
      const { options, history, events, provider } = setup(
        [
          [text('I think we are done.'), stop('end_turn')],
          [use('b', 'update_board', { tasks: [{ title: 'write code', status: 'done' }, { title: 'write tests', status: 'done' }] }), stop('tool_use')],
          [text('Finished the tests too.'), stop('end_turn')],
        ],
        { getBoard: () => board },
      );
      options.ctx.board = { get: () => board, set: (b) => (board = b) };
      await runAgent(options);

      expect(provider.requests).toHaveLength(3);
      const nudge = history.find((m) => typeof m.content === 'string' && m.content.startsWith('[Automatic check'));
      expect(String(nudge!.content)).toContain('"write tests"');
      expect(events.some((e) => e.type === 'notice' && /unfinished tasks/.test((e as any).text))).toBe(true);
    });

    it('does not insist on blocked tasks, which are waiting for the user', async () => {
      const { options, provider } = setup([[text('I need your decision on the database.'), stop('end_turn')]], {
        getBoard: () => boardOf(['pick database', 'blocked'], ['build', 'done']),
      });
      await runAgent(options);
      expect(provider.requests).toHaveLength(1);
    });

    it('gives up after two reminders and tells the user what is still open', async () => {
      const { options, events, provider } = setup(
        [[text('done'), stop('end_turn')], [text('done'), stop('end_turn')], [text('done'), stop('end_turn')]],
        { getBoard: () => boardOf(['never finished', 'pending']) },
      );
      await runAgent(options);
      expect(provider.requests).toHaveLength(3);
      const last = events.filter((e) => e.type === 'notice').at(-1) as any;
      expect(last.text).toMatch(/Finished with open items.*never finished/);
    });
  });

  // ---------- verify before done ----------
  describe('verify before done', () => {
    const editA = async () => {
      await fs.writeFile(path.join(tmp, 'v.txt'), 'hello world');
      return use('e1', 'edit_file', { path: 'v.txt', old_string: 'hello', new_string: 'howdy' });
    };
    const auto = { isAutoApproved: (tool: { name: string }) => tool.name === 'edit_file' || tool.name === 'run_command' };

    it('sends the model back to check its changes, then lets it finish once a check passes', async () => {
      const { options, history, events, provider } = setup(
        [
          [await editA(), stop('tool_use')],
          [text('Done!'), stop('end_turn')],
          [use('c1', 'run_command', { command: 'node -e "process.exit(0)"' }), stop('tool_use')],
          [text('Verified.'), stop('end_turn')],
        ],
        { ...auto, verifyBeforeDone: true },
      );
      await runAgent(options);

      expect(provider.requests).toHaveLength(4);
      expect(await fs.readFile(path.join(tmp, 'v.txt'), 'utf8')).toBe('howdy world');
      const nudge = history.find((m) => typeof m.content === 'string' && m.content.startsWith('[Automatic check'));
      expect(String(nudge!.content)).toMatch(/v\.txt/);
      expect(events.some((e) => e.type === 'notice' && /unverified changes/.test((e as any).text))).toBe(true);
      // While unverified, the model is also told so at the end of each request.
      expect(provider.volatiles[1]).toContain('v.txt');
      expect(provider.volatiles[3]).toBeUndefined();
    });

    it('does not interfere when nothing was changed', async () => {
      const { options, provider } = setup([[text('Just an answer.'), stop('end_turn')]], { ...auto, verifyBeforeDone: true });
      await runAgent(options);
      expect(provider.requests).toHaveLength(1);
    });

    it('is off unless asked for', async () => {
      const { options, provider } = setup([[await editA(), stop('tool_use')], [text('Done!'), stop('end_turn')]], auto);
      await runAgent(options);
      expect(provider.requests).toHaveLength(2);
    });

    it('gives up after two reminders if no check ever passes, and says so', async () => {
      const { options, events, provider } = setup(
        [[await editA(), stop('tool_use')], [text('Done'), stop('end_turn')], [text('Done'), stop('end_turn')], [text('Done'), stop('end_turn')]],
        { ...auto, verifyBeforeDone: true },
      );
      await runAgent(options);
      expect(provider.requests).toHaveLength(4);
      expect((events.filter((e) => e.type === 'notice').at(-1) as any).text).toMatch(/Finished with open items.*v\.txt/);
    });

    it('stops insisting once the user has refused to let a check run', async () => {
      const { options, provider } = setup(
        [
          [await editA(), stop('tool_use')],
          [text('Done'), stop('end_turn')],
          [use('c1', 'run_command', { command: 'npm test' }), stop('tool_use')],
          [text('Understood, I did not run it.'), stop('end_turn')],
        ],
        { isAutoApproved: (tool) => tool.name === 'edit_file', requestApproval: async () => 'reject', verifyBeforeDone: true },
      );
      await runAgent(options);
      expect(provider.requests).toHaveLength(4); // no third nudge
    });

    it('treats a failing check as not verified', async () => {
      const { options, history, provider } = setup(
        [
          [await editA(), stop('tool_use')],
          [use('c1', 'run_command', { command: 'node -e "process.exit(1)"' }), stop('tool_use')],
          [text('Done'), stop('end_turn')],
          [stop('end_turn')],
        ],
        { ...auto, verifyBeforeDone: true },
      );
      await runAgent(options);
      const nudge = history.find((m) => typeof m.content === 'string' && m.content.startsWith('[Automatic check'));
      expect(String(nudge!.content)).toMatch(/last check failed/);
      expect(provider.requests.length).toBeGreaterThanOrEqual(4);
    });
  });

  // ---------- budgets ----------
  describe('budgets and getting stuck', () => {
    it('pauses with a resumable event when the time budget runs out', async () => {
      let t = 0;
      const looping: ProviderEvent[] = [use('t', 'list_dir', {}), stop('tool_use')];
      const { options, events, provider } = setup([looping, looping, looping], { maxRunMs: 60_000, now: () => t });
      const record = options.onEvent;
      options.onEvent = (e) => {
        record(e);
        if (e.type === 'tool_update') t += 40_000; // each tool call "takes" 40 seconds
      };
      await runAgent(options);
      expect(provider.requests.length).toBe(2); // the third request never started
      expect(events.filter((e) => e.type === 'notice').at(-1)).toMatchObject({ text: expect.stringMatching(/Paused after 1 minute/) });
      expect(events.at(-1)).toEqual({ type: 'budget', reason: 'time', steps: 2 });
    });

    it('warns after the third identical result and stops after the fifth', async () => {
      const failing = (n: number): ProviderEvent[] => [
        use(`e${n}`, 'edit_file', { path: 'missing.txt', old_string: 'a', new_string: 'b' }),
        stop('tool_use'),
      ];
      const { options, history, events, provider } = setup([failing(1), failing(2), failing(3), failing(4), failing(5), [text('never reached'), stop('end_turn')]], {
        isAutoApproved: () => true,
      });
      await runAgent(options);

      expect(provider.requests).toHaveLength(5);
      const resultOf = (i: number) => String(((history[2 + i * 2].content as any[])[0]).content);
      expect(resultOf(1)).not.toContain('[Note:');
      expect(resultOf(2)).toContain('[Note: this exact call');
      expect(events.at(-1)).toEqual({ type: 'budget', reason: 'stuck', steps: 5 });
      // Still a valid history: the last tool call has its result.
      expect(history.at(-1)!.role).toBe('user');
      expect(((history.at(-1)!.content as any[])[0]).type).toBe('tool_result');
    });

    it('does not call a repeated command stuck while its output keeps changing', async () => {
      let n = 0;
      const registry = createDefaultRegistry();
      const real = registry.get('run_command')!;
      registry.register({ ...real, run: async () => `exit code 1\n${5 - n++} failing` });
      const turns = [1, 2, 3, 4, 5, 6].map((i): ProviderEvent[] => [use(`c${i}`, 'run_command', { command: 'npm test' }), stop('tool_use')]);
      const { options, events } = setup([...turns, [text('ok'), stop('end_turn')]], { registry, isAutoApproved: () => true, maxIterations: 20 });
      await runAgent(options);
      expect(events.some((e) => e.type === 'budget')).toBe(false);
    });
  });

  // ---------- summaries ----------
  describe('summarising old context', () => {
    const bigHistory = (): ChatMessage[] => {
      const h: ChatMessage[] = [];
      for (let i = 0; i < 30; i++) h.push({ role: 'user', content: `q${i} ${'x'.repeat(10_000)}` }, { role: 'assistant', content: `a${i}` });
      h.push({ role: 'user', content: 'the current question' });
      return h;
    };

    it('replaces old turns with a model-written summary and tells the user', async () => {
      const { options, history, events, provider } = setup([[text('ok'), stop('end_turn')]], { contextWindow: 20_000, summarizeContext: true });
      options.history.splice(0, options.history.length, ...bigHistory());
      await runAgent(options);

      expect(provider.counts.summaries).toBe(1);
      expect(String(history[0].content)).toBe(`${SUMMARY_PREFIX}\nSUMMARY TEXT`);
      expect(history.some((m) => m.role === 'user' && m.content === 'the current question')).toBe(true);
      const texts = events.filter((e) => e.type === 'notice').map((e: any) => e.text);
      expect(texts.some((t) => /Summarising the earlier conversation/.test(t))).toBe(true);
      expect(texts.some((t) => /^Summarised older context/.test(t))).toBe(true);
    });

    it('drops old turns instead when summaries are off, or when the summary fails', async () => {
      const off = setup([[text('ok'), stop('end_turn')]], { contextWindow: 20_000, summarizeContext: false });
      off.options.history.splice(0, off.options.history.length, ...bigHistory());
      await runAgent(off.options);
      expect(off.provider.counts.summaries).toBe(0);
      expect(String(off.history[0].content)).toMatch(/removed to save context/);

      const failing = setup([[text('ok'), stop('end_turn')]], { contextWindow: 20_000, summarizeContext: true }, new Error('model unavailable'));
      failing.options.history.splice(0, failing.options.history.length, ...bigHistory());
      await runAgent(failing.options);
      expect(failing.provider.counts.summaries).toBe(1);
      expect(String(failing.history[0].content)).toMatch(/removed to save context/);
      expect(failing.events.some((e) => e.type === 'notice' && /^Trimmed older context/.test((e as any).text))).toBe(true);
    });
  });
});
