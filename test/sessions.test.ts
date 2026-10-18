import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_NOT_KEPT } from '../src/agent/attachments';
import { SessionStore, forStorage, newSession, titleFrom } from '../src/storage/sessions';
import type { ImageAttachment } from '../src/webview/protocol';

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

describe('saving images', () => {
  const image = (id: string): ImageAttachment => ({
    id, mediaType: 'image/png', data: 'iVBORw0KGgo=', name: `${id}.png`, width: 10, height: 10, bytes: 8,
  });
  const imageBlock = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgo=' } };

  /** A chat with `turns` messages that each attach one image. */
  function chatWithImages(turns: number) {
    const session = newSession();
    for (let i = 0; i < turns; i++) {
      session.display.push({ role: 'user', text: `q${i}`, images: [image(`i${i}`)] }, { role: 'assistant', text: `a${i}` });
      session.history.push(
        { role: 'user', content: [imageBlock, { type: 'text', text: `q${i}` }] },
        { role: 'assistant', content: `a${i}` },
      );
    }
    return session;
  }

  it('keeps image data only for the latest messages with images', () => {
    const session = chatWithImages(4);
    const saved = forStorage(session, 2);
    const kept = saved.display.flatMap((m) => (m.role === 'user' ? (m.images ?? []).map((i) => i.data !== '') : []));
    expect(kept).toEqual([false, false, true, true]);
    expect(saved.history[0].content).toEqual([
      { type: 'text', text: IMAGE_NOT_KEPT },
      { type: 'text', text: 'q0' },
    ]);
    expect(saved.history[6].content).toEqual([imageBlock, { type: 'text', text: 'q3' }]);
  });

  it('treats PDFs like images', () => {
    const session = newSession();
    const pdf = { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'JVBERi0x' }, title: 'old.pdf' };
    for (let i = 0; i < 3; i++) session.history.push({ role: 'user', content: [pdf, { type: 'text', text: `q${i}` }] }, { role: 'assistant', content: 'a' });
    const saved = forStorage(session, 2);
    expect((saved.history[0].content as { text?: string }[])[0].text).toMatch(/PDF "old.pdf" was attached here, but it was not kept/);
    expect((saved.history[2].content as { type: string }[])[0].type).toBe('document');
  });

  it('leaves the chat in memory untouched, so the model still sees every image this session', () => {
    const session = chatWithImages(4);
    forStorage(session, 0);
    expect(session.history[0].content).toEqual([imageBlock, { type: 'text', text: 'q0' }]);
    expect(session.display[0]).toMatchObject({ images: [{ data: 'iVBORw0KGgo=' }] });
  });

  it('keeps images on disk only in the most recent chats', async () => {
    const store = new SessionStore(dir);
    const chats = Array.from({ length: 4 }, () => chatWithImages(1));
    for (const chat of chats) {
      await store.save(chat);
      await new Promise((r) => setTimeout(r, 2)); // distinct updatedAt
    }
    const reloaded = new SessionStore(dir);
    await reloaded.load();
    const hasData = (id: string) => {
      const m = reloaded.get(id)!.display[0];
      return m.role === 'user' && m.images?.[0]?.data !== '';
    };
    expect(chats.map((c) => hasData(c.id))).toEqual([false, true, true, true]);
  });
});
