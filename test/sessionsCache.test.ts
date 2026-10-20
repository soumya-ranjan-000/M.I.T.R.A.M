import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, newSession } from '../src/storage/sessions';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-sessions-'));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const readBack = async () => JSON.parse(await fs.readFile(path.join(dir, 'sessions.json'), 'utf8'));

describe('SessionStore writes', () => {
  it('writes every chat and the active id, and loads them back', async () => {
    const store = new SessionStore(dir);
    const a = newSession();
    const b = newSession();
    b.title = 'second';
    await store.save(a);
    await store.save(b);

    const file = await readBack();
    expect(file.activeId).toBe(b.id);
    expect(file.sessions.map((s: { id: string }) => s.id).sort()).toEqual([a.id, b.id].sort());

    const again = new SessionStore(dir);
    await again.load();
    expect(again.get(b.id)?.title).toBe('second');
  });

  it('picks up a change to a chat that was saved before', async () => {
    const store = new SessionStore(dir);
    const a = newSession();
    const b = newSession();
    await store.save(a);
    await store.save(b);

    a.title = 'renamed';
    await new Promise((r) => setTimeout(r, 2)); // updatedAt is the clock, so make sure it moves
    await store.save(a);

    const file = await readBack();
    expect(file.sessions.find((s: { id: string }) => s.id === a.id).title).toBe('renamed');
    expect(file.sessions.find((s: { id: string }) => s.id === b.id).title).toBe('New chat');
  });

  it('drops a deleted chat from the file', async () => {
    const store = new SessionStore(dir);
    const a = newSession();
    await store.save(a);
    await store.delete(a.id);
    const file = await readBack();
    expect(file.sessions).toEqual([]);
    expect(file.activeId).toBeNull();
  });

  it('keeps the file valid when saves overlap', async () => {
    const store = new SessionStore(dir);
    const chats = Array.from({ length: 8 }, () => newSession());
    await Promise.all(chats.map((c) => store.save(c)));
    const file = await readBack();
    expect(file.sessions).toHaveLength(8);
  });
});
