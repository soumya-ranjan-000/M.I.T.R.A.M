import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ChatMessage } from '../providers/ModelProvider';

import type { Board, DisplayMessage } from '../webview/protocol';
import { emptyBoard } from '../agent/board';

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
}

interface Persisted {
  activeId: string | null;
  sessions: Session[];
}

const MAX_SESSIONS = 50;

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

  async save(session: Session): Promise<void> {
    session.updatedAt = Date.now();
    const i = this.data.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) this.data.sessions[i] = session;
    else this.data.sessions.push(session);
    this.data.sessions = this.list().slice(0, MAX_SESSIONS);
    this.data.activeId = session.id;
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

  private async flush(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data));
  }
}
