import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ChatMessage } from '../providers/ModelProvider';

import type { Board, DisplayMessage } from '../webview/protocol';
import { emptyBoard } from '../agent/board';
import { dropAttachments, hasAttachments } from '../agent/attachments';
import type { ChatChangeEntry } from '../safety/chatChanges';

export interface Session {
  id: string;
  title: string;
  updatedAt: number;
  /** Messages as sent to the model (includes attached context). */
  history: ChatMessage[];
  /** Messages as shown in the UI. */
  display: DisplayMessage[];
  /** The agent's plan for this chat. Older saved chats don't have one. */
  board?: Board;
  /** Files the agent changed in this chat. Their earlier content is kept by ChatChangeStore. */
  changes?: ChatChangeEntry[];
}

interface Persisted {
  activeId: string | null;
  sessions: Session[];
}

const MAX_SESSIONS = 50;
// Images and PDFs are large, so on disk only the latest few messages with them keep them, in the
// most recent chats. The chat in memory is untouched, so the model still sees them this session.
const KEEP_IMAGE_MESSAGES = 2;
const KEEP_IMAGE_SESSIONS = 3;

export function newSession(): Session {
  return {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    title: 'New chat',
    updatedAt: Date.now(),
    history: [],
    display: [],
    board: emptyBoard(),
  };
}

export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 50 ? oneLine.slice(0, 49) + '…' : oneLine || 'New chat';
}

/** A copy of the session to write to disk, with image and PDF data kept only for its latest `keep` messages that have them. */
export function forStorage(session: Session, keep: number): Session {
  let keptShown = 0;
  const display = session.display
    .slice()
    .reverse()
    .map((m) => {
      if (m.role !== 'user' || !m.images?.length || keptShown++ < keep) return m;
      return { ...m, images: m.images.map((image) => ({ ...image, data: '' })) };
    })
    .reverse();
  let keptSent = 0;
  const history = session.history
    .slice()
    .reverse()
    .map((m) => {
      if (!hasAttachments(m) || keptSent++ < keep) return m;
      const copy = { ...m };
      dropAttachments(copy, 'not kept');
      return copy;
    })
    .reverse();
  return { ...session, display, history };
}

export class SessionStore {
  private data: Persisted = { activeId: null, sessions: [] };
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'sessions.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Persisted;
      if (Array.isArray(parsed.sessions)) this.data = parsed;
    } catch {
      // First run or unreadable file: start empty.
    }
  }

  get activeId(): string | null {
    return this.data.activeId;
  }

  list(): Session[] {
    return [...this.data.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.data.sessions.find((s) => s.id === id);
  }

  /** `activate` makes it the chat that opens next time: false for a chat working in the background. */
  async save(session: Session, activate = true): Promise<void> {
    session.updatedAt = Date.now();
    const i = this.data.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) this.data.sessions[i] = session;
    else this.data.sessions.push(session);
    this.data.sessions = this.list().slice(0, MAX_SESSIONS);
    if (activate) this.data.activeId = session.id;
    await this.flush();
  }

  async setActive(id: string | null): Promise<void> {
    this.data.activeId = id;
    await this.flush();
  }

  async delete(id: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    if (this.data.activeId === id) this.data.activeId = null;
    await this.flush();
  }

  /**
   * Serialised sessions by id. Only the chat that was just saved changes between writes, but turning
   * all fifty into JSON each time blocks the extension host (shared with every other extension) for
   * long enough to be felt on big chats, so unchanged ones reuse their text.
   */
  private readonly serialized = new Map<string, { updatedAt: number; keep: number; json: string }>();
  private writing: Promise<void> = Promise.resolve();

  private async flush(): Promise<void> {
    const recent = new Set(this.list().slice(0, KEEP_IMAGE_SESSIONS).map((s) => s.id));
    const live = new Set<string>();
    const sessions = this.data.sessions.map((s) => {
      live.add(s.id);
      const keep = recent.has(s.id) ? KEEP_IMAGE_MESSAGES : 0;
      const cached = this.serialized.get(s.id);
      if (cached && cached.updatedAt === s.updatedAt && cached.keep === keep) return cached.json;
      const json = JSON.stringify(forStorage(s, keep));
      this.serialized.set(s.id, { updatedAt: s.updatedAt, keep, json });
      return json;
    });
    for (const id of this.serialized.keys()) if (!live.has(id)) this.serialized.delete(id);

    const text = `{"activeId":${JSON.stringify(this.data.activeId)},"sessions":[${sessions.join(',')}]}`;
    // One write at a time, so two saves close together cannot interleave and corrupt the file.
    const write = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, text);
    });
    this.writing = write.catch(() => undefined);
    await write;
  }
}
