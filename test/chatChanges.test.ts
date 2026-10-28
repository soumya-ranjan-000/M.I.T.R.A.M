import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatChangeStore, diffCounts, type ChangeOwner } from '../src/safety/chatChanges';
import { nodeFilePort } from '../src/tools/NodeFilePort';

let root: string;
let store: ChatChangeStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-cc-'));
  store = new ChatChangeStore(path.join(root, '.store'));
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const abs = (f: string) => path.join(root, f);
const read = (f: string) => fs.readFile(abs(f), 'utf8');
const exists = (f: string) => fs.access(abs(f)).then(() => true, () => false);

/** Writes a file as the agent would: the store hears what it replaced. */
async function agentWrite(session: ChangeOwner, f: string, content: string) {
  const before = (await exists(f)) ? await read(f) : null;
  await nodeFilePort.writeText(abs(f), content);
  await store.record(session, abs(f), before);
}

describe('diffCounts', () => {
  it('counts added and removed lines', () => {
    expect(diffCounts('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(diffCounts('', 'x\ny')).toEqual({ added: 2, removed: 0 });
    expect(diffCounts('x\ny\n', '')).toEqual({ added: 0, removed: 2 });
    expect(diffCounts('same\n', 'same\n')).toEqual({ added: 0, removed: 0 });
  });

  it('finds lines kept in the middle of a changed block', () => {
    expect(diffCounts('1\nkeep\n2\n', '3\nkeep\n4\n5\n')).toEqual({ added: 3, removed: 2 });
  });

  it('treats a missing final newline and Windows line endings as the same lines', () => {
    expect(diffCounts('a\r\nb\r\n', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });
});

describe('ChatChangeStore', () => {
  it('keeps what a file held before the chat first changed it, across turns', async () => {
    await fs.writeFile(abs('a.txt'), 'one\n');
    const session: ChangeOwner = { id: 's1' };
    await agentWrite(session, 'a.txt', 'two\n');
    await agentWrite(session, 'a.txt', 'three\n');
    await agentWrite(session, 'new.txt', 'x\ny\n');

    expect(await store.original(session, abs('a.txt'))).toBe('one\n');
    expect(await store.summarize(session, nodeFilePort)).toEqual([
      { abs: abs('a.txt'), kind: 'modified', added: 1, removed: 1, revertible: true },
      { abs: abs('new.txt'), kind: 'created', added: 2, removed: 0, revertible: true },
    ]);
  });

  it('leaves out files that are back as they were, and reports deleted ones', async () => {
    await fs.writeFile(abs('a.txt'), 'one\n');
    await fs.writeFile(abs('b.txt'), 'b1\nb2\n');
    const session: ChangeOwner = { id: 's1' };
    await agentWrite(session, 'a.txt', 'two\n');
    await agentWrite(session, 'b.txt', 'changed\n');
    await agentWrite(session, 'tmp.txt', 'temp');
    await fs.writeFile(abs('a.txt'), 'one\n');
    await fs.rm(abs('b.txt'));
    await fs.rm(abs('tmp.txt'));

    expect(await store.summarize(session, nodeFilePort)).toEqual([
      { abs: abs('b.txt'), kind: 'deleted', added: 0, removed: 2, revertible: true },
    ]);
  });

  it('reverts one file, removing a file the chat created', async () => {
    await fs.writeFile(abs('a.txt'), 'one\n');
    const session: ChangeOwner = { id: 's1' };
    await agentWrite(session, 'a.txt', 'two\n');
    await agentWrite(session, 'new.txt', 'x');

    expect(await store.revert(session, abs('a.txt'), nodeFilePort)).toBe(true);
    expect(await store.revert(session, abs('new.txt'), nodeFilePort)).toBe(true);
    expect(await read('a.txt')).toBe('one\n');
    expect(await exists('new.txt')).toBe(false);
    expect(session.changes).toEqual([]);
    expect(await store.summarize(session, nodeFilePort)).toEqual([]);
  });

  it('records a file again after it was reverted', async () => {
    await fs.writeFile(abs('a.txt'), 'one\n');
    const session: ChangeOwner = { id: 's1' };
    await agentWrite(session, 'a.txt', 'two\n');
    await store.revert(session, abs('a.txt'), nodeFilePort);
    await agentWrite(session, 'a.txt', 'three\n');
    expect(await store.original(session, abs('a.txt'))).toBe('one\n');
  });

  it('lists a file too large to keep without counts, and cannot revert it', async () => {
    const big = 'x'.repeat(2_000_001);
    await fs.writeFile(abs('big.txt'), big);
    const session: ChangeOwner = { id: 's1' };
    await agentWrite(session, 'big.txt', 'small');
    expect(await store.summarize(session, nodeFilePort)).toEqual([{ abs: abs('big.txt'), kind: 'modified', revertible: false }]);
    expect(await store.revert(session, abs('big.txt'), nodeFilePort)).toBe(false);
    expect(await read('big.txt')).toBe('small');
  });

  it('keeps chats apart, and forgets or prunes what was kept', async () => {
    await fs.writeFile(abs('a.txt'), 'one\n');
    const first: ChangeOwner = { id: 's1' };
    const second: ChangeOwner = { id: 's2' };
    await agentWrite(first, 'a.txt', 'two\n');
    await agentWrite(second, 'a.txt', 'three\n');
    expect(await store.original(first, abs('a.txt'))).toBe('one\n');
    expect(await store.original(second, abs('a.txt'))).toBe('two\n');

    await store.forget(first);
    expect(first.changes).toEqual([]);
    expect(await fs.readdir(path.join(root, '.store'))).toEqual(['s2']);
    await store.prune([]);
    expect(await fs.readdir(path.join(root, '.store'))).toEqual([]);
  });
});
