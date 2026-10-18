import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveInWorkspace } from '../src/safety/workspaceGuard';

let tmp: string;
let root: string;
let outside: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-guard-'));
  root = path.join(tmp, 'ws');
  outside = path.join(tmp, 'outside');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x');
  await fs.writeFile(path.join(outside, 'secret.txt'), 's');
  await fs.symlink(outside, path.join(root, 'link'));
});

afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

describe('resolveInWorkspace', () => {
  it('allows files inside the workspace, including not-yet-existing ones', async () => {
    expect(await resolveInWorkspace(root, 'src/a.ts')).toBe(path.join(await fs.realpath(root), 'src/a.ts'));
    expect(await resolveInWorkspace(root, 'src/new/file.ts')).not.toBeNull();
  });

  it('rejects .. escapes and absolute paths outside the root', async () => {
    expect(await resolveInWorkspace(root, '../outside/secret.txt')).toBeNull();
    expect(await resolveInWorkspace(root, path.join(outside, 'secret.txt'))).toBeNull();
    expect(await resolveInWorkspace(root, 'src/../../outside')).toBeNull();
  });

  it('rejects symlinks that point outside the root', async () => {
    expect(await resolveInWorkspace(root, 'link/secret.txt')).toBeNull();
    expect(await resolveInWorkspace(root, 'link/new.txt')).toBeNull();
  });
});
