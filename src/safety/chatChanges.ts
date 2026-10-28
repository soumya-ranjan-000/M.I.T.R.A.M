// Remembers every file the agent changed in a chat, and what it held before the agent first touched
// it, so the whole chat's changes can be listed, diffed and reverted. No vscode import, so tests can use it.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FilePort } from '../tools/Tool';

/** One file a chat changed, as saved with the session. Its earlier content lives in the store's folder. */
export interface ChatChangeEntry {
  abs: string;
  /** The file did not exist before the agent wrote it. */
  created: boolean;
  /** The earlier content was saved. False when the file was too large to keep. */
  kept: boolean;
}

export type ChangeKind = 'created' | 'modified' | 'deleted';

/** A file as it stands now compared with before the chat. Counts are missing when the earlier content was not kept. */
export interface ChangedFile {
  abs: string;
  kind: ChangeKind;
  added?: number;
  removed?: number;
  revertible: boolean;
}

/** The part of a session this store reads and updates. */
export interface ChangeOwner {
  id: string;
  changes?: ChatChangeEntry[];
}

/** Largest earlier content kept for one file, like the per-call diffs. */
const MAX_CHARS = 2_000_000;
/** Above this many line pairs the exact count is not worth the time; the changed block is counted whole. */
const MAX_DIFF_CELLS = 4_000_000;

const splitLines = (text: string): string[] => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/));

/** Lines added and removed between two versions of a file. */
export function diffCounts(before: string, after: string): { added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS) return { added: m, removed: n };
  // Longest common subsequence of the changed block, one row at a time.
  let prev = new Int32Array(m + 1);
  let row = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const line = a[start + i - 1];
    for (let j = 1; j <= m; j++) {
      row[j] = line === b[start + j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    [prev, row] = [row, prev];
  }
  const common = prev[m];
  return { added: m - common, removed: n - common };
}

export class ChatChangeStore {
  constructor(private readonly dir: string) {}

  private folder(sessionId: string): string {
    return path.join(this.dir, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  private file(sessionId: string, abs: string): string {
    return path.join(this.folder(sessionId), createHash('sha1').update(abs).digest('hex'));
  }

  /**
   * Called on every write the agent makes. Only the first write to a file in a chat counts: what it
   * replaced is "before the chat". The entry is added before the disk write, so two writes close
   * together cannot both claim to be first.
   */
  async record(session: ChangeOwner, abs: string, before: string | null): Promise<void> {
    const changes = (session.changes ??= []);
    if (changes.some((c) => c.abs === abs)) return;
    const entry: ChatChangeEntry = { abs, created: before === null, kept: before === null || before.length <= MAX_CHARS };
    changes.push(entry);
    if (before === null || !entry.kept) return;
    try {
      await fs.mkdir(this.folder(session.id), { recursive: true });
      await fs.writeFile(this.file(session.id, abs), before, 'utf8');
    } catch {
      entry.kept = false;
    }
  }

  /** What the file held before the chat: null if it did not exist, undefined if that was not kept. */
  async original(session: ChangeOwner, abs: string): Promise<string | null | undefined> {
    const entry = session.changes?.find((c) => c.abs === abs);
    if (!entry) return undefined;
    if (entry.created) return null;
    if (!entry.kept) return undefined;
    try {
      return await fs.readFile(this.file(session.id, abs), 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Every file that differs from before the chat, in the order the agent first changed them. */
  async summarize(session: ChangeOwner, port: Pick<FilePort, 'exists' | 'readText'>): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    for (const entry of session.changes ?? []) {
      const exists = await port.exists(entry.abs);
      const current = exists ? await port.readText(entry.abs).catch(() => undefined) : undefined;
      const original = await this.original(session, entry.abs);
      if (entry.created) {
        // Created and then removed again: nothing left to show.
        if (!exists) continue;
        files.push({ abs: entry.abs, kind: 'created', added: current === undefined ? undefined : splitLines(current).length, removed: 0, revertible: true });
      } else if (!exists) {
        files.push({ abs: entry.abs, kind: 'deleted', added: 0, removed: original == null ? undefined : splitLines(original).length, revertible: original != null });
      } else if (original == null || current === undefined) {
        files.push({ abs: entry.abs, kind: 'modified', revertible: original != null });
      } else if (current !== original) {
        files.push({ abs: entry.abs, kind: 'modified', ...diffCounts(original, current), revertible: true });
      }
    }
    return files;
  }

  /**
   * Puts a file back as it was before the chat: a file the chat created is removed. Returns false when
   * the earlier content was not kept. The entry is dropped, so a later write records afresh.
   */
  async revert(session: ChangeOwner, abs: string, port: Pick<FilePort, 'exists' | 'writeText' | 'remove'>): Promise<boolean> {
    const original = await this.original(session, abs);
    if (original === undefined) return false;
    if (original === null) {
      if (await port.exists(abs)) await port.remove(abs);
    } else {
      await port.writeText(abs, original);
    }
    session.changes = session.changes?.filter((c) => c.abs !== abs);
    await fs.rm(this.file(session.id, abs), { force: true });
    return true;
  }

  /** Forgets a chat's changes, keeping the files as they are. */
  async forget(session: ChangeOwner): Promise<void> {
    session.changes = [];
    await this.remove(session.id);
  }

  /** Deletes what was kept for a chat, e.g. when the chat itself is deleted. */
  async remove(sessionId: string): Promise<void> {
    await fs.rm(this.folder(sessionId), { recursive: true, force: true });
  }

  /** Deletes what was kept for chats that no longer exist. */
  async prune(liveIds: string[]): Promise<void> {
    const live = new Set(liveIds.map((id) => path.basename(this.folder(id))));
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => !live.has(n)).map((n) => fs.rm(path.join(this.dir, n), { recursive: true, force: true })));
  }
}
