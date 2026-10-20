// Remembers what each tool call changed, so a finished edit in the chat can be opened as a diff.
// Pure (no vscode import) so tests can use it.

/** One file a tool call wrote. */
export interface LoggedChange {
  /** Workspace-relative path, for the diff title. */
  path: string;
  abs: string;
  /** Content before the call, or null if the call created the file. */
  before: string | null;
  after: string;
}

/** Calls remembered. Older ones are forgotten first. */
const MAX_CALLS = 200;
/** Characters kept per side of one file. A larger file shows no diff rather than eating memory. */
const MAX_CHARS = 2_000_000;
/** Characters kept across every call, so a long session of big edits stays bounded. */
const MAX_TOTAL_CHARS = 40_000_000;

const size = (c: LoggedChange) => (c.before?.length ?? 0) + c.after.length;

export class ChangeLog {
  private readonly byCall = new Map<string, LoggedChange[]>();
  private total = 0;

  /**
   * Records a write. When one call writes a file twice, the diff runs from the first "before" to the
   * last "after". Returns false when the file was too large to keep.
   */
  record(callId: string, change: LoggedChange): boolean {
    if ((change.before?.length ?? 0) > MAX_CHARS || change.after.length > MAX_CHARS) return false;
    const list = this.byCall.get(callId) ?? [];
    const i = list.findIndex((c) => c.abs === change.abs);
    if (i >= 0) {
      this.total -= size(list[i]);
      list[i] = { ...change, before: list[i].before };
    } else {
      list.push(change);
    }
    this.total += size(i >= 0 ? list[i] : change);
    // Re-insert so the most recently written call counts as newest.
    this.byCall.delete(callId);
    this.byCall.set(callId, list);
    this.trim();
    return true;
  }

  /** The files a call changed, in the order it first wrote them. */
  get(callId: string): LoggedChange[] {
    return this.byCall.get(callId) ?? [];
  }

  /** Call ids with a recorded change. */
  get size(): number {
    return this.byCall.size;
  }

  clear(): void {
    this.byCall.clear();
    this.total = 0;
  }

  private trim(): void {
    while (this.byCall.size > MAX_CALLS || this.total > MAX_TOTAL_CHARS) {
      const oldest = this.byCall.keys().next();
      if (oldest.done) return;
      for (const c of this.byCall.get(oldest.value) ?? []) this.total -= size(c);
      this.byCall.delete(oldest.value);
    }
  }
}
