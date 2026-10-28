import * as os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessManager, type ProcessEvent } from '../src/tools/processes';
import { createDefaultRegistry } from '../src/tools';
import type { ProcessPort, ToolContext } from '../src/tools/Tool';
import { nodeFilePort } from '../src/tools/NodeFilePort';
import { isAutoApproved } from '../src/safety/approvalPolicy';
import { RunTracker } from '../src/agent/runTracker';

const cwd = os.tmpdir();
let manager: ProcessManager;
afterEach(() => manager?.dispose());

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const portFor = (m: ProcessManager, owner: string): ProcessPort => ({
  owner,
  start: (command) => m.start(command, cwd, owner),
  read: (id, since) => m.read(id, since),
  stop: (id) => m.stop(id),
  list: () => m.list(),
});

describe('ProcessManager', () => {
  it('keeps a process running, collects its output and reports its exit', async () => {
    manager = new ProcessManager();
    const events: ProcessEvent['type'][] = [];
    manager.onEvent((e) => events.push(e.type));
    const p = manager.start('echo one; sleep 0.3; echo two', cwd, 'chat1');
    expect(p).toMatchObject({ id: 'p1', status: 'running', owner: 'chat1' });
    await until(() => manager.get('p1')!.status !== 'running');
    expect(manager.get('p1')).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(manager.read('p1')!.text).toBe('one\ntwo\n');
    expect(events[0]).toBe('start');
    expect(events.at(-1)).toBe('exit');
  });

  it('reads only what is new since an offset, and says when older output was dropped', async () => {
    manager = new ProcessManager({ maxOutput: 10 });
    manager.start('printf abcdefghij; sleep 0.2; printf KLMNO', cwd, 'c');
    await until(() => manager.read('p1')!.next === 10);
    const first = manager.read('p1')!;
    expect(first).toMatchObject({ text: 'abcdefghij', next: 10, dropped: false });
    await until(() => manager.read('p1')!.next === 15);
    expect(manager.read('p1', first.next)).toMatchObject({ text: 'KLMNO', next: 15, dropped: false });
    // Only the last 10 characters are kept: asking from the start says some are missing.
    expect(manager.read('p1', 0)).toMatchObject({ text: 'fghijKLMNO', dropped: true });
  });

  it('stops a process and what it started, and restarts it under the same id', async () => {
    manager = new ProcessManager();
    manager.start('sleep 30', cwd, 'c');
    expect(await manager.stop('p1')).toBe(true);
    expect(manager.get('p1')).toMatchObject({ status: 'stopped' });
    expect(await manager.stop('p1')).toBe(false);

    const again = await manager.restart('p1');
    expect(again).toMatchObject({ id: 'p1', status: 'running' });
    await manager.stop('p1');
    expect(manager.remove('p1')).toBe(true);
    expect(manager.list()).toEqual([]);
  });

  it('passes input to the process', async () => {
    manager = new ProcessManager();
    manager.start('read line; echo "got $line"', cwd, 'c');
    expect(manager.write('p1', 'hello\n')).toBe(true);
    await until(() => manager.get('p1')!.status !== 'running');
    expect(manager.read('p1')!.text).toBe('got hello\n');
  });

  it('refuses to start more than its limit, and stops a chat\'s processes together', async () => {
    manager = new ProcessManager({ maxRunning: 2 });
    manager.start('sleep 30', cwd, 'a');
    manager.start('sleep 30', cwd, 'b');
    expect(() => manager.start('sleep 30', cwd, 'a')).toThrow(/limit is 2/);
    await manager.stopOwner('a');
    expect(manager.list().map((p) => p.status)).toEqual(['stopped', 'running']);
  });
});

describe('background process tools', () => {
  const registry = createDefaultRegistry();
  const ctx = (processes?: ProcessPort): ToolContext => ({ root: cwd, signal: new AbortController().signal, files: nodeFilePort, processes });
  const run = (name: string, input: unknown, c: ToolContext) => registry.get(name)!.run(input, c);

  it('starts a background command, returns its first output, and leaves it running', async () => {
    manager = new ProcessManager();
    const out = await run('run_command', { command: 'echo ready; sleep 30', background: true }, ctx(portFor(manager, 'me')));
    expect(out).toMatch(/^Started background process p1; it is still running\.\nOutput so far:\nready\n/);
    expect(manager.get('p1')?.status).toBe('running');
  }, 10_000);

  it('reports a background command that ends at once like any command', async () => {
    manager = new ProcessManager();
    const out = await run('run_command', { command: 'echo boom; exit 3', background: true }, ctx(portFor(manager, 'me')));
    expect(out).toMatch(/^exit code 3\nThe background process p1 has already ended\.\nboom/);
  });

  it('reads, lists and stops processes, telling the agent which chat started each', async () => {
    manager = new ProcessManager();
    manager.start('echo hi; sleep 30', cwd, 'me');
    manager.start('sleep 30', cwd, 'someone-else');
    await until(() => manager.read('p1')!.next > 0);
    const c = ctx(portFor(manager, 'me'));

    const read = await run('read_process_output', { id: 'p1' }, c);
    expect(read).toMatch(/^p1 \(running, started \d+s ago\): echo hi; sleep 30\nhi\nnext: 3$/);
    expect(await run('read_process_output', { id: 'p1', since: 3 }, c)).toContain('(no new output)');

    const list = await run('list_processes', {}, c);
    expect(list).toContain('p2 (running, started 0s ago, started from another chat): sleep 30');

    expect(await run('stop_process', { id: 'p1' }, c)).toBe('Stopped p1: echo hi; sleep 30');
    expect(await run('stop_process', { id: 'p1' }, c)).toMatch(/^p1 is not running/);
    await expect(run('read_process_output', { id: 'p9' }, c)).rejects.toThrow(/No background process "p9"/);
  });

  it('explains when background processes are not available', async () => {
    await expect(run('run_command', { command: 'sleep 1', background: true }, ctx())).rejects.toThrow(/not available/);
    await expect(run('list_processes', {}, ctx())).rejects.toThrow(/not available/);
  });

  it('shows a background start on its card, needs approval to stop a process, and does not count a start as a check', () => {
    expect(registry.get('run_command')!.preview({ command: 'npm run dev', background: true }).summary).toBe('Run in background: npm run dev');
    const settings = { skipApprovalPrompts: false, autoApproveEdits: false, autoApproveSafeCommands: false, autoApproveCommands: [], allowedCommands: [] };
    expect(isAutoApproved('stop_process', { id: 'p1' }, settings, new Set())).toBe(false);
    expect(isAutoApproved('stop_process', { id: 'p1' }, { ...settings, skipApprovalPrompts: true }, new Set())).toBe(true);

    const tracker = new RunTracker();
    tracker.record('edit_file', { path: 'a.ts' }, 'ok', 'ok');
    tracker.record('run_command', { command: 'npm run dev', background: true }, 'ok', 'Started background process p1');
    expect(tracker.noteForModel()).not.toContain('last check failed');
    expect(tracker.unverifiedFiles()).toEqual(['a.ts']);
  });
});
