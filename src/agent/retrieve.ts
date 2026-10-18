import * as fs from 'node:fs/promises';
import { resolveInWorkspace } from '../safety/workspaceGuard';
import { CodeIndex, QueryTerm, RefreshStats, SearchHit, forEachTerm, hashTerm } from './codeIndex';

const MAX_FILES = 6;
const SNIPPET_FILES = 2;
const SNIPPET_LINES = 20;
/** Lines of context kept above the first match in a snippet. */
const LEAD_LINES = 3;
const MAX_LINE_CHARS = 200;
/** About 1,400 tokens. */
const BUDGET_CHARS = 5_000;
/** Files scoring below this share of the best one are left out. */
const RELATIVE_CUTOFF = 0.35;
/**
 * The best file must score at least this much, or nothing is attached. In a workspace of a handful of
 * files every term is common and scores stay below it, which is fine: one list_dir shows such a project.
 */
const MIN_SCORE = 4;

export interface RetrievedFile {
  path: string;
  startLine: number;
  endLine: number;
  matched: string[];
  snippet?: string;
}

export interface Retrieval {
  files: RetrievedFile[];
  /** The `<retrieved>` block for the user message, or '' when nothing was confident enough. */
  block: string;
}

export interface RetrieveOptions {
  /** Paths already attached to the message. */
  exclude?: Iterable<string>;
  /** Paths to favour a little, such as open editor tabs. */
  boost?: Iterable<string>;
}

/**
 * Whether the hits are worth the tokens, so chatter like "looks good" attaches nothing. Scores alone
 * can't tell: "what do you think?" matches ThinkingBlock.tsx strongly. So the message must also name an
 * identifier, or one of the top three files must match at least two of its words.
 */
export function isConfident(message: string, terms: QueryTerm[], hits: SearchHit[]): boolean {
  if (!hits[0] || hits[0].score < MIN_SCORE) return false;
  const namesIdentifier = /[a-z][A-Z]|[A-Za-z]_[A-Za-z]/.test(message);
  return namesIdentifier || (new Set(terms.map((t) => t.word)).size >= 2 && hits.slice(0, 3).some((h) => h.matched.length >= 2));
}

/** The window of SNIPPET_LINES lines that covers the most (IDF-weighted, distinct) query terms. */
export function bestWindow(lines: string[], terms: QueryTerm[]): { start: number; end: number } {
  const weights = new Map(terms.map((t) => [t.hash, t.idf]));
  const lineTerms = lines.map((line) => {
    const found = new Set<number>();
    forEachTerm(line.slice(0, 1000), (term) => {
      const h = hashTerm(term);
      if (weights.has(h)) found.add(h);
    });
    return found;
  });
  let best = { start: 0, score: 0 };
  lineTerms.forEach((found, i) => {
    if (found.size === 0) return;
    const start = Math.max(0, i - LEAD_LINES);
    const covered = new Set<number>();
    let repeats = 0;
    for (let j = start; j < Math.min(lines.length, start + SNIPPET_LINES); j++) {
      for (const h of lineTerms[j]) {
        if (covered.has(h)) repeats += weights.get(h)!;
        else covered.add(h);
      }
    }
    const score = [...covered].reduce((n, h) => n + weights.get(h)!, 0) + 0.1 * repeats;
    if (score > best.score) best = { start, score };
  });
  let end = Math.min(lines.length, best.start + SNIPPET_LINES);
  while (end > best.start + 1 && !lines[end - 1].trim()) end--;
  return { start: best.start, end };
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function formatRetrieved(files: RetrievedFile[], budgetChars = BUDGET_CHARS): string {
  if (files.length === 0) return '';
  const list = files.map((f) => `${f.path}:${f.startLine}-${f.endLine} (${f.matched.join(', ')})`).join('\n');
  let body = list;
  for (const f of files) {
    if (!f.snippet) continue;
    const block = `\n<snippet path="${escapeAttr(f.path)}" lines="${f.startLine}-${f.endLine}">\n${f.snippet}\n</snippet>`;
    if (body.length + block.length <= budgetChars) body += block;
  }
  return `<retrieved>\n${body}\n</retrieved>`;
}

/** Finds code related to `message` and formats it for the user turn. */
export async function retrieve(index: CodeIndex, message: string, options: RetrieveOptions = {}): Promise<Retrieval> {
  const exclude = new Set(options.exclude);
  const { terms, hits } = index.search(message, { limit: MAX_FILES * 3, boost: new Set(options.boost) });
  const candidates = hits.filter((h) => !exclude.has(h.path));
  if (!isConfident(message, terms, candidates)) return { files: [], block: '' };

  const cutoff = candidates[0].score * RELATIVE_CUTOFF;
  const files: RetrievedFile[] = [];
  for (const hit of candidates) {
    if (files.length >= MAX_FILES || hit.score < cutoff) break;
    const abs = await resolveInWorkspace(index.root, hit.path);
    const text = abs ? await fs.readFile(abs, 'utf8').catch(() => null) : null;
    if (text === null) continue; // deleted or moved since it was indexed
    const lines = text.split('\n');
    const { start, end } = bestWindow(lines, terms);
    const snippet =
      files.length < SNIPPET_FILES
        ? lines
            .slice(start, end)
            .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l))
            .join('\n')
        : undefined;
    files.push({ path: hit.path, startLine: start + 1, endLine: end, matched: hit.matched, snippet });
  }
  return { files, block: formatRetrieved(files) };
}

export interface RetrieverTimeouts {
  /** How long a message waits for the first build. Past that it goes out without retrieved code. */
  firstBuildMs: number;
  /** How long a message waits for a refresh before using the index as it stands. */
  refreshMs: number;
}

const DEFAULT_TIMEOUTS: RetrieverTimeouts = { firstBuildMs: 1500, refreshMs: 150 };

/**
 * Keeps an index of the open workspace current and answers within a time budget. Each message waits
 * briefly for a refresh, then uses the index as it stands while the refresh finishes in the background,
 * so on a large workspace the ranking can be one message behind. Excerpts are always read from disk.
 */
export class Retriever {
  private index?: CodeIndex;
  private ready = false;
  private refreshing?: Promise<RefreshStats | undefined>;
  private abort?: AbortController;

  constructor(
    private readonly log: (message: string) => void,
    private readonly timeouts: RetrieverTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  /** Starts building or refreshing the index for `root`, if that isn't already under way. */
  warm(root: string): Promise<RefreshStats | undefined> {
    if (this.index?.root !== root) {
      this.abort?.abort();
      this.abort = new AbortController();
      this.index = new CodeIndex(root);
      this.ready = false;
      this.refreshing = undefined;
    }
    const index = this.index;
    const signal = this.abort!.signal;
    this.refreshing ??= index
      .refresh(signal)
      .then((stats) => {
        if (stats.added || stats.updated || stats.removed) {
          this.log(`code index: ${stats.files} files (+${stats.added} ~${stats.updated} -${stats.removed}) in ${stats.ms} ms`);
        }
        return stats;
      })
      .catch((e: Error) => {
        this.log(`code index refresh failed: ${e.message}`);
        return undefined;
      })
      .finally(() => {
        if (this.index !== index) return;
        this.ready = true; // even after a failure, so later messages don't each wait for a first build
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  async retrieve(root: string, message: string, options: RetrieveOptions = {}): Promise<Retrieval> {
    const started = Date.now();
    const refresh = this.warm(root);
    const index = this.index!;
    const wait = this.ready ? this.timeouts.refreshMs : this.timeouts.firstBuildMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([refresh, new Promise((resolve) => (timer = setTimeout(resolve, wait)))]);
    clearTimeout(timer);
    if (!this.ready) {
      this.log(`retrieval skipped: code index not ready after ${wait} ms`);
      return { files: [], block: '' };
    }
    const result = await retrieve(index, message, options);
    this.log(`retrieval: ${result.files.length} files, ${result.block.length} chars in ${Date.now() - started} ms`);
    return result;
  }

  dispose(): void {
    this.abort?.abort();
  }
}
