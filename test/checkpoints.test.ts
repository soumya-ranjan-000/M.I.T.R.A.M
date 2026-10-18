import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Checkpoint, withCheckpoint } from '../src/safety/checkpoints';
import { createDefaultRegistry } from '../src/tools';
import { nodeFilePort } from '../src/tools/NodeFilePort';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-cp-'));
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const read = (f: string) => fs.readFile(path.join(root, f), 'utf8');
const exists = (f: string) => fs.access(path.join(root, f)).then(() => true, () => false);

function setup() {
  const cp = new Checkpoint();
  const files = withCheckpoint(nodeFilePort, cp);
  const registry = createDefaultRegistry();
  const run = (name: string, input: unknown) =>
    registry.get(name)!.run(input, { root, signal: new AbortController().signal, files });
  return { cp, run };
}

describe('Checkpoint', () => {
  it('restores edited files and removes created ones', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one');
    const { cp, run } = setup();
    await run('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' });
    await run('create_file', { path: 'new/b.txt', content: 'hi' });
    expect(cp.size).toBe(2);

    const result = await cp.restore(nodeFilePort);
    expect(result.conflicts).toEqual([]);
    expect(result.restored).toHaveLength(2);
    expect(await read('a.txt')).toBe('one');
    expect(await exists('new/b.txt')).toBe(false);
  });

  it('keeps the original content across several edits to the same file', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'v0');
    const { cp, run } = setup();
    await run('edit_file', { path: 'a.txt', old_string: 'v0', new_string: 'v1' });
    await run('edit_file', { path: 'a.txt', old_string: 'v1', new_string: 'v2' });
    await cp.restore(nodeFilePort);
    expect(await read('a.txt')).toBe('v0');
  });

  it('never overwrites a file the user changed afterwards', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one');
    const { cp, run } = setup();
    await run('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' });
    await fs.writeFile(path.join(root, 'a.txt'), 'user edit');

    const result = await cp.restore(nodeFilePort);
    expect(result.restored).toEqual([]);
    expect(result.conflicts).toEqual([path.join(root, 'a.txt')]);
    expect(await read('a.txt')).toBe('user edit');
    expect(cp.size).toBe(1); // still tracked, so it can be retried
  });

  it('does not delete a created file the user has since changed', async () => {
    const { cp, run } = setup();
    await run('create_file', { path: 'n.txt', content: 'agent' });
    await fs.writeFile(path.join(root, 'n.txt'), 'mine now');
    const result = await cp.restore(nodeFilePort);
    expect(result.conflicts).toHaveLength(1);
    expect(await read('n.txt')).toBe('mine now');
  });
});

describe('propose', () => {
  it('computes the change without writing, for edits and creates', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'hello world');
    const registry = createDefaultRegistry();
    const ctx = { root, signal: new AbortController().signal, files: nodeFilePort };

    const edit = await registry.get('edit_file')!.propose!({ path: 'a.txt', old_string: 'world', new_string: 'there' }, ctx);
    expect(edit).toMatchObject({ path: 'a.txt', before: 'hello world', after: 'hello there' });
    expect(await read('a.txt')).toBe('hello world');

    const create = await registry.get('create_file')!.propose!({ path: 'z.txt', content: 'zz' }, ctx);
    expect(create).toMatchObject({ before: null, after: 'zz' });
    expect(await exists('z.txt')).toBe(false);
  });
});

describe('Checkpoint when the user deleted files afterwards', () => {
  it('treats a created file the user already removed as restored', async () => {
    const { cp, run } = setup();
    await run('create_file', { path: 'gone.txt', content: 'x' });
    await fs.rm(path.join(root, 'gone.txt'));
    const result = await cp.restore(nodeFilePort);
    expect(result.restored).toHaveLength(1);
    expect(cp.size).toBe(0);
  });

  it('reports an edited file the user deleted as a conflict, and does not recreate it', async () => {
    await fs.writeFile(path.join(root, 'e.txt'), 'one');
    const { cp, run } = setup();
    await run('edit_file', { path: 'e.txt', old_string: 'one', new_string: 'two' });
    await fs.rm(path.join(root, 'e.txt'));
    const result = await cp.restore(nodeFilePort);
    expect(result.conflicts).toHaveLength(1);
    expect(await exists('e.txt')).toBe(false);
  });
});
