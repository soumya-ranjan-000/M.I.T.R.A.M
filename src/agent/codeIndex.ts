import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { IGNORED_DIRS, toPosix, walkFiles } from '../tools/walk';

/**
 * A small in-memory keyword index of the workspace, used to find code related to a message before
 * the model starts exploring. Ranking is BM25 over file contents plus a bonus for terms in the file's
 * name and directories. Terms are stored as 32-bit hashes, so memory grows with the number of
 * (file, distinct term) pairs and there is no dictionary.
 */

const exec = promisify(execFile);

const MAX_FILE_BYTES = 512_000;
const MAX_FILES = 20_000;
const READ_CONCURRENCY = 32;
const K1 = 1.2;
const B = 0.75;
/** Weight of a query term found in the file name, relative to its path IDF. */
const NAME_WEIGHT = 2;
/** Weight of a query term found in a directory name. */
const DIR_WEIGHT = 0.5;
/** Tests and docs repeat the words of the code they describe; prefer the code unless the message asks for them. */
const TEST_FACTOR = 0.75;
const DOC_FACTOR = 0.6;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|(?:^|\/)test_[^/]+$/i;
const DOC_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
/**
 * The message is about test code ("add a test", "the tests for X fail"), not just mentioning a test run
 * ("even though I ran the tests").
 */
const TEST_INTENT =
  /\b(?:add|write|create|update|fix|extend|improve|cover|missing|failing|flaky|broken|new)\b[\w\s-]{0,24}?\b(?:tests?|specs?)\b|\b(?:tests?|specs?)\b[\w\s]{0,12}?\b(?:for|fail\w*|broke\w*|flak\w*|coverage)\b|\b(?:unit|integration|e2e|regression|snapshot)\s+tests?\b|\btest (?:file|suite|case)s?\b/i;
const DOC_TERMS = new Set(['readme', 'doc', 'documentation', 'changelog', 'markdown', 'guide'].map((w) => hashTerm(stem(w))));

/** Text that matches everything and helps with nothing (lockfiles, maps, minified code), plus common binary types. */
const SKIP_FILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(?:map|min\.js|min\.css|svg|png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|vsix|woff2?|ttf|otf|eot|exe|dll|so|dylib|class|jar|pyc|wasm|mp3|mp4|mov|lockb)$/i;

/** English function words, request verbs and pleasantries: they say nothing about where the code is. */
const STOPWORDS = new Set(
  ('the and but for from with without into onto about after before while when where why how what which who whom ' +
    'are was were been being its this that these those there here our you your they them their his her him she ' +
    'does did doesn don didn isn aren wasn won can could should would will shall may might must just also even too ' +
    'very all any each every other some same such only still than then thus not now yes please thanks thank okay ' +
    'make add fix change want need get sure see look try use using way thing things like one two again more ' +
    'most less much many lot really able let good great nice cool awesome perfect looks lgtm ship hmm simply ' +
    'simpler explain describe tell').split(' '),
);

/** Light suffix stripping, so "summarised" meets "summarize", "dropped" meets "drop" and "logs" meets "logging". */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  const suffix = /(?:ing|ed)$/.exec(w);
  if (suffix && w.length - suffix[0].length >= 3) {
    w = w.slice(0, -suffix[0].length);
    if (/([^lsz])\1$/.test(w)) w = w.slice(0, -1);
    else if (suffix[0] === 'ed' && w.endsWith('i')) w = `${w.slice(0, -1)}y`; // verified -> verify
  }
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith('is') && w.length > 4) w = `${w.slice(0, -2)}iz`;
  return w;
}

function normalise(word: string): string | null {
  const lower = word.toLowerCase();
  if (lower.length < 3 || STOPWORDS.has(lower) || /^\d/.test(lower)) return null;
  return stem(lower);
}

const IDENT = /[A-Za-z][A-Za-z0-9_]*/g;
const PART = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g;

/**
 * Calls `emit` for each search term in `text`: every word, and for identifiers such as `autoApproveEdits`
 * or `cache_control` both the whole identifier and its parts. `word` is the word or identifier it came from.
 */
export function forEachTerm(text: string, emit: (term: string, word: string) => void): void {
  for (const [ident] of text.matchAll(IDENT)) {
    const parts = ident.match(PART) ?? [];
    if (parts.length > 1) {
      const whole = normalise(ident);
      if (whole) emit(whole, ident);
    }
    for (const part of parts) {
      const term = normalise(part);
      if (term) emit(term, ident);
    }
  }
}

export function terms(text: string): string[] {
  const out: string[] = [];
  forEachTerm(text, (t) => out.push(t));
  return out;
}

/** FNV-1a: a term's id. Collisions between two rare terms are possible and harmless. */
export function hashTerm(term: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function sortedHashes(list: string[]): Uint32Array {
  return Uint32Array.from(new Set(list.map(hashTerm))).sort();
}

function has(sorted: Uint32Array, value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] === value) return mid;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
  /** Number of terms in the file. */
  length: number;
  /** Sorted term hashes, with their counts at the same index. */
  terms: Uint32Array;
  counts: Uint16Array;
  name: Uint32Array;
  dirs: Uint32Array;
}

function indexText(rel: string, text: string, mtimeMs = 0, size = text.length): FileEntry {
  const counts = new Map<number, number>();
  let length = 0;
  forEachTerm(text, (term) => {
    const h = hashTerm(term);
    counts.set(h, (counts.get(h) ?? 0) + 1);
    length++;
  });
  const sorted = Uint32Array.from(counts.keys()).sort();
  const segments = rel.split('/');
  const file = segments.pop() ?? '';
  const base = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file;
  return {
    path: rel,
    mtimeMs,
    size,
    length,
    terms: sorted,
    counts: Uint16Array.from(sorted, (h) => Math.min(counts.get(h)!, 0xffff)),
    name: sortedHashes(terms(base)),
    dirs: sortedHashes(segments.flatMap(terms)),
  };
}

export type FileLister = (root: string, signal?: AbortSignal) => Promise<string[]>;

/** Every file under `root` that the search tools would visit, as workspace-relative paths. */
export const walkWorkspaceFiles: FileLister = async (root, signal) => {
  const paths: string[] = [];
  for await (const abs of walkFiles(root, signal)) paths.push(toPosix(path.relative(root, abs)));
  return paths;
};

/**
 * In a git repository: what git tracks plus untracked files that are not ignored, so .gitignore is
 * respected. Elsewhere: the plain walk.
 */
export const listWorkspaceFiles: FileLister = async (root, signal) => {
  try {
    const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
      signal,
    });
    return stdout.split('\0').filter(Boolean);
  } catch {
    return signal?.aborted ? [] : walkWorkspaceFiles(root, signal);
  }
};

function indexable(paths: string[]): string[] {
  return paths
    .filter((p) => !SKIP_FILE.test(p) && !p.split('/').slice(0, -1).some((d) => IGNORED_DIRS.has(d)))
    .slice(0, MAX_FILES);
}

export interface QueryTerm {
  term: string;
  /** The word in the message it came from. */
  word: string;
  hash: number;
  /** Content IDF in this index, filled in by search. */
  idf: number;
}

/** A term looked up for one query word: the word's own term, a shorter form of it, or a synonym. */
interface Probe extends QueryTerm {
  /** Index of the query word it stands for. */
  group: number;
  kind: 'word' | 'form' | 'synonym';
}

const WEIGHT: Record<Probe['kind'], number> = { word: 1, form: 0.6, synonym: 0.5 };

/** Words that developers and code use for the same thing, so "revert" finds code that says "restore". */
const SYNONYM_GROUPS = [
  'revert restore undo rollback rewind',
  'stop cancel abort interrupt halt kill',
  'delete remove erase discard',
  'error fail failure exception crash throw',
  'setting config configuration option preference',
  'start launch begin spawn',
  'show display reveal',
  'hide collapse fold',
  'expand unfold',
  'limit cap max maximum',
  'folder directory dir',
  'key secret credential',
  'chat session conversation',
  'approve allow permit accept confirm',
  'reject deny refuse block decline',
  'done finish complete',
  'remember persist save store',
  'reload restart refresh',
  'find search lookup',
  'log logger logging',
  'timer elapsed duration',
];
const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  const stems = [...new Set(group.split(' ').map(stem))];
  for (const s of stems) SYNONYMS.set(s, [...(SYNONYMS.get(s) ?? []), ...stems.filter((o) => o !== s)]);
}

/** "picker" -> "pick", "configuration" -> "configur", "handler" -> "handl": for words the code spells differently. */
function shorterForms(term: string): string[] {
  const forms: string[] = [];
  for (const suffix of ['ation', 'ion', 'ment', 'able', 'er', 'or']) {
    if (term.endsWith(suffix) && term.length - suffix.length >= 3) forms.push(stem(term.slice(0, -suffix.length)));
  }
  return forms;
}

export interface SearchHit {
  path: string;
  score: number;
  /** Query words found in the file's contents or path. */
  matched: string[];
}

export interface SearchResult {
  terms: QueryTerm[];
  hits: SearchHit[];
}

export interface RefreshStats {
  files: number;
  added: number;
  updated: number;
  removed: number;
  ms: number;
}

export class CodeIndex {
  private readonly files = new Map<string, FileEntry>();

  constructor(
    readonly root: string,
    private readonly listFiles: FileLister = listWorkspaceFiles,
  ) {}

  get size(): number {
    return this.files.size;
  }

  /** Brings the index up to date: reads new and changed files (by mtime and size) and drops deleted ones. */
  async refresh(signal?: AbortSignal): Promise<RefreshStats> {
    const started = Date.now();
    const listed = indexable(await this.listFiles(this.root, signal));
    const stats = { files: 0, added: 0, updated: 0, removed: 0, ms: 0 };
    const drop = (rel: string) => {
      if (this.files.delete(rel)) stats.removed++;
    };
    const seen = new Set(listed);
    for (const rel of this.files.keys()) if (!seen.has(rel)) drop(rel);

    let next = 0;
    const worker = async () => {
      while (next < listed.length && !signal?.aborted) {
        const rel = listed[next++];
        const abs = path.join(this.root, rel);
        // lstat: symlinks are skipped, as in the search tools, so nothing outside the workspace is read.
        const stat = await fs.lstat(abs).catch(() => null);
        if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
          drop(rel);
          continue;
        }
        const old = this.files.get(rel);
        if (old && old.mtimeMs === stat.mtimeMs && old.size === stat.size) continue;
        const text = await fs.readFile(abs, 'utf8').catch(() => null);
        if (text === null || text.slice(0, 8000).includes('\0')) {
          drop(rel);
          continue;
        }
        this.files.set(rel, indexText(rel, text, stat.mtimeMs, stat.size));
        if (old) stats.updated++;
        else stats.added++;
      }
    };
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
    stats.files = this.files.size;
    stats.ms = Date.now() - started;
    return stats;
  }

  search(query: string, options: { limit?: number; boost?: ReadonlySet<string> } = {}): SearchResult {
    const words: QueryTerm[] = [];
    const seenWords = new Set<number>();
    forEachTerm(query, (term, word) => {
      const hash = hashTerm(term);
      if (seenWords.has(hash)) return;
      seenWords.add(hash);
      words.push({ term, word, hash, idf: 0 });
    });
    if (words.length === 0 || this.files.size === 0) return { terms: words, hits: [] };

    // What to look up for each query word: the word itself, and at lower weights its shorter forms, for
    // code that spells it differently ("picker" -> pickModel), and its synonyms ("revert" -> restore).
    const probes: Probe[] = [];
    const seen = new Set<number>();
    const add = (term: string, group: number, kind: Probe['kind']) => {
      const hash = hashTerm(term);
      if (seen.has(hash)) return;
      seen.add(hash);
      probes.push({ term, word: words[group].word, hash, idf: 0, group, kind });
    };
    words.forEach((w, group) => add(w.term, group, 'word'));
    words.forEach((w, group) => {
      for (const form of shorterForms(w.term)) add(form, group, 'form');
      for (const synonym of SYNONYMS.get(w.term) ?? []) add(synonym, group, 'synonym');
    });

    // One pass to find matches and document frequencies.
    const contentDf = new Array<number>(probes.length).fill(0);
    const pathDf = new Array<number>(probes.length).fill(0);
    const matches: { file: FileEntry; tf: number[]; inName: boolean[]; inDir: boolean[] }[] = [];
    let totalLength = 0;
    for (const file of this.files.values()) {
      totalLength += file.length;
      let any = false;
      const tf = new Array<number>(probes.length).fill(0);
      const inName = new Array<boolean>(probes.length).fill(false);
      const inDir = new Array<boolean>(probes.length).fill(false);
      probes.forEach((p, i) => {
        const at = has(file.terms, p.hash);
        if (at >= 0) {
          tf[i] = file.counts[at];
          contentDf[i]++;
          any = true;
        }
        inName[i] = has(file.name, p.hash) >= 0;
        inDir[i] = has(file.dirs, p.hash) >= 0;
        if (inName[i] || inDir[i]) {
          pathDf[i]++;
          any = true;
        }
      });
      if (any) matches.push({ file, tf, inName, inDir });
    }

    const wantsTests = TEST_INTENT.test(query);
    const wantsDocs = words.some((w) => DOC_TERMS.has(w.hash));
    const n = this.files.size;
    const avgLength = totalLength / n || 1;
    const idf = (df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5));
    probes.forEach((p, i) => (p.idf = idf(contentDf[i]) * WEIGHT[p.kind]));
    const pathIdf = pathDf.map((df, i) => idf(df) * WEIGHT[probes[i].kind]);

    const hits = matches.map(({ file, tf, inName, inDir }) => {
      // Each query word counts once, through whichever of its probes matches best.
      const perWord = new Array<number>(words.length).fill(0);
      const norm = K1 * (1 - B + (B * file.length) / avgLength);
      probes.forEach((p, i) => {
        let s = tf[i] ? (p.idf * tf[i] * (K1 + 1)) / (tf[i] + norm) : 0;
        if (inName[i]) s += NAME_WEIGHT * pathIdf[i];
        else if (inDir[i]) s += DIR_WEIGHT * pathIdf[i];
        perWord[p.group] = Math.max(perWord[p.group], s);
      });
      let score = perWord.reduce((a, b) => a + b, 0);
      const matched = [...new Set(words.filter((_, g) => perWord[g] > 0).map((w) => w.word))];
      if (!wantsTests && TEST_FILE.test(file.path)) score *= TEST_FACTOR;
      else if (!wantsDocs && DOC_FILE.test(file.path)) score *= DOC_FACTOR;
      if (options.boost?.has(file.path)) score *= 1.2;
      return { path: file.path, score, matched };
    });
    if (!wantsTests) keepTestsBelowTheirCode(hits);
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const terms = probes.map(({ term, word, hash, idf }) => ({ term, word, hash, idf }));
    return { terms, hits: hits.slice(0, options.limit ?? 10) };
  }
}

/** The file a test is for, by name: `a/foo.test.ts`, `foo.spec.ts`, `foo_test.go` and `test_foo.py` are all `foo`. */
function testSubject(file: string): string | null {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  const m = /^(?:test_)?(.+?)(?:[._](?:test|spec))?\.[^.]+$/.exec(name);
  return m && m[1] !== name ? m[1] : null;
}

/** A test file never outranks the code it tests, so the code gets the excerpt. */
function keepTestsBelowTheirCode(hits: SearchHit[]): void {
  const codeScore = new Map<string, number>();
  for (const hit of hits) {
    if (TEST_FILE.test(hit.path)) continue;
    const base = hit.path.slice(hit.path.lastIndexOf('/') + 1).toLowerCase().replace(/\.[^.]+$/, '');
    codeScore.set(base, Math.max(codeScore.get(base) ?? 0, hit.score));
  }
  for (const hit of hits) {
    if (!TEST_FILE.test(hit.path)) continue;
    const subject = testSubject(hit.path);
    const code = subject ? codeScore.get(subject) : undefined;
    if (code !== undefined && hit.score >= code) hit.score = code * 0.95;
  }
}
