import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, newSession, titleFrom } from '../src/storage/sessions';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-sessions-'));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('SessionStore', () => {
  it('persists sessions across instances and tracks the active one', async () => {
    const a = new SessionStore(dir);
    const s = newSession();
    s.display.push({ role: 'user', text: 'hello' });
    await a.save(s);

    const b = new SessionStore(dir);
    await b.load();
    expect(b.activeId).toBe(s.id);
    expect(b.get(s.id)?.display[0]).toEqual({ role: 'user', text: 'hello' });
  });

  it('deletes sessions and clears the active id', async () => {
    const store = new SessionStore(dir);
    const s = newSession();
    await store.save(s);
    await store.delete(s.id);
    expect(store.list()).toHaveLength(0);
    expect(store.activeId).toBeNull();
  });

  it('survives a missing or corrupt file', async () => {
    await fs.writeFile(path.join(dir, 'sessions.json'), '{not json');
    const store = new SessionStore(dir);
    await store.load();
    expect(store.list()).toEqual([]);
  });
});

describe('titleFrom', () => {
  it('collapses whitespace and truncates long text', () => {
    expect(titleFrom('  a \n b ')).toBe('a b');
    expect(titleFrom('x'.repeat(80))).toHaveLength(50);
    expect(titleFrom('   ')).toBe('New chat');
  });
});
