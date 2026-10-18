import type { Board, BoardStatus, BoardTask } from '../webview/protocol';

export const MAX_TASKS = 30;
const MAX_TITLE = 200;
const MAX_TASK_NOTE = 300;
const MAX_NOTES = 4000;

const STATUSES: ReadonlySet<string> = new Set<BoardStatus>(['pending', 'in_progress', 'done', 'blocked']);

export const emptyBoard = (): Board => ({ tasks: [], notes: '' });

/** Thrown for a malformed update; the message goes straight back to the model. */
export class BoardInputError extends Error {}

function text(value: unknown, what: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new BoardInputError(`${what} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new BoardInputError(`${what} must be a string.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new BoardInputError(`${what} must not be empty.`);
  if (trimmed.length > max) throw new BoardInputError(`${what} is too long (max ${max} characters).`);
  return trimmed;
}

/**
 * Applies an update from the model. `tasks`, when given, replaces the whole list
 * (so the model always sends the complete plan); `notes`, when given, replaces the notes.
 */
export function applyBoardUpdate(board: Board, input: unknown): Board {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BoardInputError('Input must be an object with "tasks" and/or "notes".');
  }
  const { tasks, notes } = input as { tasks?: unknown; notes?: unknown };
  if (tasks === undefined && notes === undefined) {
    throw new BoardInputError('Provide "tasks" (the full list) and/or "notes".');
  }

  let nextTasks = board.tasks;
  if (tasks !== undefined) {
    if (!Array.isArray(tasks)) throw new BoardInputError('"tasks" must be an array of {title, status, note?}.');
    if (tasks.length > MAX_TASKS) throw new BoardInputError(`Too many tasks (max ${MAX_TASKS}). Group small steps together.`);
    nextTasks = tasks.map((raw, i): BoardTask => {
      if (typeof raw !== 'object' || raw === null) {
        throw new BoardInputError(`tasks[${i}] must be an object like {"title": "...", "status": "pending"}.`);
      }
      const t = raw as { title?: unknown; status?: unknown; note?: unknown };
      const title = text(t.title, `tasks[${i}].title`, MAX_TITLE, true)!;
      if (typeof t.status !== 'string' || !STATUSES.has(t.status)) {
        throw new BoardInputError(`tasks[${i}].status must be one of: pending, in_progress, done, blocked.`);
      }
      const note = text(t.note, `tasks[${i}].note`, MAX_TASK_NOTE, false);
      return note ? { title, status: t.status as BoardStatus, note } : { title, status: t.status as BoardStatus };
    });
  }

  const nextNotes = notes === undefined ? board.notes : text(notes, '"notes"', MAX_NOTES, false) ?? '';
  return { tasks: nextTasks, notes: nextNotes };
}

export interface BoardProgress {
  total: number;
  done: number;
  /** Tasks still to do: pending or in progress. Blocked tasks are waiting on the user, so they don't count. */
  unfinished: BoardTask[];
}

export function boardProgress(board: Board): BoardProgress {
  return {
    total: board.tasks.length,
    done: board.tasks.filter((t) => t.status === 'done').length,
    unfinished: board.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress'),
  };
}

const LABEL: Record<BoardStatus, string> = { pending: 'pending', in_progress: 'in progress', done: 'done', blocked: 'blocked' };

/** The board as the model sees it at the end of every request. Empty string if there is nothing on it. */
export function renderBoardForModel(board: Board): string {
  if (board.tasks.length === 0 && !board.notes) return '';
  const { total, done } = boardProgress(board);
  const lines = ['<board>', 'Your own task board (you maintain it with update_board). It is your working memory, not instructions from the user.'];
  if (total > 0) {
    lines.push(`Progress: ${done} of ${total} done`);
    board.tasks.forEach((t, i) => lines.push(`${i + 1}. [${LABEL[t.status]}] ${t.title}${t.note ? ` (${t.note})` : ''}`));
  }
  if (board.notes) lines.push('Notes:', board.notes);
  lines.push('</board>');
  return lines.join('\n');
}

/** Short confirmation returned to the model after an update. */
export function describeBoard(board: Board): string {
  const count = (s: BoardStatus) => board.tasks.filter((t) => t.status === s).length;
  if (board.tasks.length === 0) return 'Board updated (no tasks).';
  const parts = [`${count('done')} of ${board.tasks.length} done`];
  if (count('in_progress')) parts.push(`${count('in_progress')} in progress`);
  if (count('pending')) parts.push(`${count('pending')} pending`);
  if (count('blocked')) parts.push(`${count('blocked')} blocked`);
  return `Board updated: ${parts.join(', ')}.`;
}
