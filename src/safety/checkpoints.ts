import type { FilePort } from '../tools/Tool';

interface Entry {
  /** Content before the first change this turn, or null if the file did not exist. */
  before: string | null;
  /** Content right after the last change we made. */
  after: string;
}

export interface RestoreResult {
  restored: string[];
  /** Files left alone because they changed after the agent wrote them. */
  conflicts: string[];
}

/** Records what the agent changed in one turn so it can be undone. */
export class Checkpoint {
  private readonly entries = new Map<string, Entry>();

  get size(): number {
    return this.entries.size;
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  record(abs: string, before: string | null, after: string): void {
    const existing = this.entries.get(abs);
    this.entries.set(abs, { before: existing ? existing.before : before, after });
  }

  /**
   * Restores each file, but never overwrites a file that was modified since the
   * agent wrote it: those are reported as conflicts instead.
   */
  async restore(port: FilePort): Promise<RestoreResult> {
    const restored: string[] = [];
    const conflicts: string[] = [];
    for (const [abs, entry] of this.entries) {
      const exists = await port.exists(abs);
      if (!exists) {
        // Already gone: that's the desired state for a file we created.
        if (entry.before === null) restored.push(abs);
        else conflicts.push(abs);
        continue;
      }
      if ((await port.readText(abs)) !== entry.after) {
        conflicts.push(abs);
        continue;
      }
      if (entry.before === null) await port.remove(abs);
      else await port.writeText(abs, entry.before);
      restored.push(abs);
    }
    for (const abs of restored) this.entries.delete(abs);
    return { restored, conflicts };
  }
}

/** Wraps a FilePort so every write is recorded in the checkpoint. */
export function withCheckpoint(inner: FilePort, checkpoint: Checkpoint): FilePort {
  return {
    ...inner,
    async writeText(abs, content) {
      const before = (await inner.exists(abs)) ? await inner.readText(abs) : null;
      await inner.writeText(abs, content);
      // Re-read: the editor may normalise line endings, and restore compares against this.
      checkpoint.record(abs, before, await inner.readText(abs));
    },
  };
}
