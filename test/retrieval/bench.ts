/**
 * Measures how well code retrieval finds what a request is about, and what it costs. No model is called.
 *
 * Two kinds of retrieval are scored against the labels in requests.ts:
 * - the agent's own tools: each request becomes the searches a model could plausibly make with
 *   search_files and find_files;
 * - the pre-analysis pass (src/agent/retrieve.ts), which attaches code to the message before the model runs.
 *
 *   npm run bench:retrieval [-- --runs N] [--large <dir>] [--save-baseline]
 *
 * --large defaults to this repo's node_modules, as a stand-in for a big workspace.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { CodeIndex, walkWorkspaceFiles } from '../../src/agent/codeIndex';
import { retrieve } from '../../src/agent/retrieve';
import { nodeFilePort } from '../../src/tools/NodeFilePort';
import { findFilesTool, searchFilesTool } from '../../src/tools/searchFiles';
import type { ToolContext } from '../../src/tools/Tool';
import { walkFiles } from '../../src/tools/walk';
import { RetrievalRequest, SNAPSHOT_REF, chatter, heldoutChatter, heldoutChatter2, heldoutChatter3, requests } from './requests';

const exec = promisify(execFile);
const here = path.resolve(process.cwd(), 'test/retrieval');
const CHARS_PER_TOKEN = 3.5; // the estimate contextManager uses

// Words a model would not search for. Everything else that is 3+ characters is a candidate term.
const STOPWORDS = new Set(
  ('the and but for from with without into onto about after before while when where why how what which who ' +
    'are was were been being its this that these those there here our you your they them their does did doesn ' +
    'don not never can could should would will just also even too very all any each every other same only still ' +
    'make add fix change sure please want need get new old one two five first last see look check currently ' +
    'instead next both has have had').split(' '),
);

function terms(text: string): string[] {
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function context(root: string): ToolContext {
  return { root, signal: new AbortController().signal, files: nodeFilePort };
}

// ---------- Ranking ----------

interface Retrieved {
  /** Distinct files, in the order they were returned. */
  files: string[];
  /** The file of each returned match, in order (search_files only). */
  matches: string[];
  /** Size of what the model would read; NaN when nothing is sent as such. */
  chars: number;
  capped: boolean;
}

async function searchFiles(ctx: ToolContext, pattern: string): Promise<Retrieved> {
  const out = await searchFilesTool.run({ pattern, case_insensitive: true }, ctx);
  const matches = out.split('\n').flatMap((line) => /^(.+?):\d+: /.exec(line)?.[1] ?? []);
  return { files: [...new Set(matches)], matches, chars: out.length, capped: out.includes('[stopped at') };
}

async function findFiles(ctx: ToolContext, glob: string): Promise<Retrieved> {
  const out = await findFilesTool.run({ glob }, ctx);
  const files = out.startsWith('No files') ? [] : out.split('\n').filter((l) => !l.startsWith('['));
  return { files, matches: [], chars: out.length, capped: out.includes('[stopped at') };
}

interface Score {
  /** Reciprocal rank of the first labelled file. */
  rr: number;
  recall5: number;
  recall10: number;
  /** 1 if any labelled file was returned at all. */
  found: number;
  tokens: number;
  capped: number;
}

function score(r: Retrieved, gold: string[]): Score {
  const ranks = gold.map((g) => r.files.indexOf(g));
  const hit = ranks.filter((i) => i >= 0);
  const within = (k: number) => ranks.filter((i) => i >= 0 && i < k).length / gold.length;
  return {
    rr: hit.length ? 1 / (Math.min(...hit) + 1) : 0,
    recall5: within(5),
    recall10: within(10),
    found: hit.length ? 1 : 0,
    tokens: r.chars / CHARS_PER_TOKEN,
    capped: r.capped ? 1 : 0,
  };
}

function mean(scores: Score[]): Score {
  const avg = (f: (s: Score) => number) => (scores.length ? scores.reduce((n, s) => n + f(s), 0) / scores.length : 0);
  return {
    rr: avg((s) => s.rr),
    recall5: avg((s) => s.recall5),
    recall10: avg((s) => s.recall10),
    found: avg((s) => s.found),
    tokens: avg((s) => s.tokens),
    capped: avg((s) => s.capped),
  };
}

const better = (a: Score, b: Score) => a.rr - b.rr || a.recall10 - b.recall10 || b.tokens - a.tokens;

const STRATEGIES = [
  'search_files, all terms',
  'search_files, avg single term',
  'search_files, best single term',
  'find_files, all terms',
  'find_files, avg single term',
  'find_files, best single term',
  'pre-pass, attached block',
  'pre-pass, ranking only (no gate)',
] as const;
type Strategy = (typeof STRATEGIES)[number];

interface RequestResult {
  id: string;
  kind: RetrievalRequest['kind'];
  set: 'tuning' | `held out ${1 | 2 | 3}`;
  terms: string[];
  scores: Record<Strategy, Score>;
  /** Rank (1-based) of the first labelled file in the all-terms search, or null. */
  allTermsRank: number | null;
  bestSearchTerm: string | null;
  bestFindTerm: string | null;
  /** Ranks of the labelled files in the attached block, or null when the gate attached nothing. */
  attachedRanks: (number | null)[] | null;
  attachedChars: number;
  /** Where the all-terms search's matches landed: top-level directory (or "(root files)") -> count. */
  allTermsMatchesByDir: Record<string, number>;
  /** How many of the all-terms search's matches are in labelled files. */
  allTermsMatchesInGold: number;
}

async function rankRequest(ctx: ToolContext, index: CodeIndex, req: RetrievalRequest): Promise<RequestResult> {
  const ts = terms(req.text);
  const all = await searchFiles(ctx, `(${ts.join('|')})`);
  const perSearch = await Promise.all(ts.map(async (t) => ({ t, s: score(await searchFiles(ctx, t), req.gold) })));
  const perFind = await Promise.all(ts.map(async (t) => ({ t, s: score(await findFiles(ctx, `*${t}*`), req.gold) })));
  const best = (list: { t: string; s: Score }[]) => list.reduce((a, b) => (better(b.s, a.s) > 0 ? b : a));
  const bestSearch = best(perSearch);
  const bestFind = best(perFind);
  const byDir: Record<string, number> = {};
  for (const file of all.matches) {
    const dir = file.includes('/') ? `${file.slice(0, file.indexOf('/'))}/` : '(root files)';
    byDir[dir] = (byDir[dir] ?? 0) + 1;
  }
  const firstRank = Math.min(...req.gold.map((g) => all.files.indexOf(g)).filter((i) => i >= 0));

  const attached = await retrieve(index, req.text);
  const attachedFiles = attached.files.map((f) => f.path);
  const ranked = index.search(req.text, { limit: 10 }).hits.map((h) => h.path);
  return {
    id: req.id,
    kind: req.kind,
    set: req.heldout ? `held out ${req.heldout}` : 'tuning',
    terms: ts,
    scores: {
      'search_files, all terms': score(all, req.gold),
      'search_files, avg single term': mean(perSearch.map((x) => x.s)),
      'search_files, best single term': bestSearch.s,
      'find_files, all terms': score(await findFiles(ctx, `*{${ts.join(',')}}*`), req.gold),
      'find_files, avg single term': mean(perFind.map((x) => x.s)),
      'find_files, best single term': bestFind.s,
      'pre-pass, attached block': score({ files: attachedFiles, matches: [], chars: attached.block.length, capped: false }, req.gold),
      'pre-pass, ranking only (no gate)': score({ files: ranked, matches: [], chars: NaN, capped: false }, req.gold),
    },
    allTermsRank: Number.isFinite(firstRank) ? firstRank + 1 : null,
    bestSearchTerm: bestSearch.s.rr > 0 ? `${bestSearch.t}@${Math.round(1 / bestSearch.s.rr)}` : null,
    bestFindTerm: bestFind.s.rr > 0 ? `${bestFind.t}@${Math.round(1 / bestFind.s.rr)}` : null,
    attachedRanks: attached.block ? req.gold.map((g) => (attachedFiles.includes(g) ? attachedFiles.indexOf(g) + 1 : null)) : null,
    attachedChars: attached.block.length,
    allTermsMatchesByDir: byDir,
    allTermsMatchesInGold: all.matches.filter((f) => req.gold.includes(f)).length,
  };
}

// ---------- Latency ----------

interface Timing {
  corpus: string;
  op: string;
  firstMs: number;
  medianMs: number;
  maxMs: number;
}

async function time(corpus: string, op: string, runs: number, fn: () => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i <= runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const [firstMs, ...warm] = samples;
  warm.sort((a, b) => a - b);
  return { corpus, op, firstMs, medianMs: warm[Math.floor(warm.length / 2)], maxMs: warm[warm.length - 1] };
}

async function corpusStats(root: string): Promise<{ files: number; mb: number; searchedMb: number }> {
  let files = 0;
  let bytes = 0;
  let searched = 0;
  for await (const file of walkFiles(root)) {
    const size = (await fs.stat(file)).size;
    files++;
    bytes += size;
    if (size <= 1_000_000) searched += size; // search_files skips larger files
  }
  return { files, mb: bytes / 1e6, searchedMb: searched / 1e6 };
}

/** Heap plus typed-array memory, after a full GC when node runs with --expose-gc. */
function memoryBytes(): number {
  (globalThis as { gc?: () => void }).gc?.();
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

// ---------- Output ----------

const pct = (n: number) => `${Math.round(n * 100)}%`;
const ms = (n: number) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());
const num = (n: number, f: (n: number) => string) => (Number.isNaN(n) ? '—' : f(n));

function table(head: string[], rows: (string | number)[][]): string {
  const lines = [head, head.map(() => '---'), ...rows.map((r) => r.map(String))];
  return lines.map((l) => `| ${l.join(' | ')} |`).join('\n');
}

function summary(subset: RequestResult[]): Record<Strategy, Score> {
  return Object.fromEntries(STRATEGIES.map((s) => [s, mean(subset.map((r) => r.scores[s]))])) as Record<Strategy, Score>;
}

function rankingTable(scores: Record<Strategy, Score>): string {
  return table(
    ['strategy', 'MRR', 'recall@5', 'recall@10', 'found', 'tokens to the model', 'hit cap'],
    STRATEGIES.map((s) => {
      const x = scores[s];
      return [s, x.rr.toFixed(2), pct(x.recall5), pct(x.recall10), pct(x.found), num(x.tokens, (n) => String(Math.round(n))), pct(x.capped)];
    }),
  );
}

async function main(): Promise<void> {
  const runs = Math.max(1, Number(option('runs') ?? 5));
  const workspace = process.cwd();
  const large = path.resolve(option('large') ?? path.join(workspace, 'node_modules'));

  const snapshot = await fs.mkdtemp(path.join(os.tmpdir(), 'mitram-retrieval-'));
  try {
    await exec('sh', ['-c', 'git archive --format=tar "$1" | tar -x -C "$2"', 'sh', SNAPSHOT_REF, snapshot], { cwd: workspace });
    const missing: string[] = [];
    for (const r of requests) {
      for (const g of r.gold) {
        if (!(await fs.access(path.join(snapshot, g)).then(() => true, () => false))) missing.push(`${r.id}: ${g}`);
      }
    }
    if (missing.length) throw new Error(`Labelled files missing at ${SNAPSHOT_REF.slice(0, 7)}:\n${missing.join('\n')}`);

    // Ranking quality, on the pinned snapshot.
    const ctx = context(snapshot);
    const index = new CodeIndex(snapshot);
    await index.refresh();
    const results: RequestResult[] = [];
    for (const req of requests) results.push(await rankRequest(ctx, index, req));
    const sets = ['tuning', 'held out 1', 'held out 2', 'held out 3'] as const;
    const bySet = Object.fromEntries(sets.map((s) => [s, results.filter((r) => r.set === s)])) as Record<(typeof sets)[number], RequestResult[]>;
    const tuning = bySet.tuning;
    const heldoutAll = results.filter((r) => r.set !== 'tuning');
    const overall: Record<string, Record<Strategy, Score>> = Object.fromEntries(sets.map((s) => [s, summary(bySet[s])]));
    overall['all held out'] = summary(heldoutAll);
    const describe: Record<string, string> = {
      tuning: 'used to design and tune the pre-pass',
      'held out 1': 'written before step 2 first ran on them',
      'held out 2': 'written before the ranking fixes',
      'held out 3': 'written by a separate agent that never saw the retrieval code',
    };
    console.log(`\n## Ranking quality: snapshot ${SNAPSHOT_REF.slice(0, 7)}\n`);
    for (const s of sets) {
      console.log(`${s === 'tuning' ? '' : '\n'}${s[0].toUpperCase()}${s.slice(1)} (${bySet[s].length} requests, ${describe[s]}):\n`);
      console.log(rankingTable(overall[s]));
    }
    console.log(`\nAll held-out requests together (${heldoutAll.length}):\n`);
    console.log(rankingTable(overall['all held out']));

    const byKind = {
      identifier: summary(results.filter((r) => r.kind === 'identifier')),
      natural: summary(results.filter((r) => r.kind === 'natural')),
    };
    const counts = { identifier: 0, natural: 0 };
    for (const r of results) counts[r.kind]++;
    console.log('\nMRR by request kind (both sets):\n');
    console.log(
      table(
        ['strategy', `identifier (${counts.identifier})`, `natural (${counts.natural})`],
        STRATEGIES.map((s) => [s, byKind.identifier[s].rr.toFixed(2), byKind.natural[s].rr.toFixed(2)]),
      ),
    );

    // The gate: how often the pre-pass attaches anything.
    const attachRate = async (messages: string[]) => {
      let n = 0;
      for (const m of messages) if ((await retrieve(index, m)).block) n++;
      return n;
    };
    const gate = [
      ['tuning requests', tuning.length, tuning.filter((r) => r.attachedRanks).length],
      ...([1, 2, 3] as const).map((n) => {
        const set = bySet[`held out ${n}`];
        return [`held-out requests, round ${n}`, set.length, set.filter((r) => r.attachedRanks).length] as const;
      }),
      ['chatter (tuning)', chatter.length, await attachRate(chatter)],
      ['chatter (held out, round 1)', heldoutChatter.length, await attachRate(heldoutChatter)],
      ['chatter (held out, round 2)', heldoutChatter2.length, await attachRate(heldoutChatter2)],
      ['chatter (held out, round 3)', heldoutChatter3.length, await attachRate(heldoutChatter3)],
    ] as const;
    console.log('\nHow often the pre-pass attached something:\n');
    console.log(table(['messages', 'count', 'attached'], gate.map(([name, total, n]) => [name, total, `${n} (${pct(n / total)})`])));

    console.log('\nPer request (rank of the first labelled file; term@rank for the best single term; ranks of labelled files in the attached block):\n');
    console.log(
      table(
        ['request', 'set', 'kind', 'all-terms search', 'best search term', 'best find term', 'pre-pass attached'],
        results.map((r) => [
          r.id,
          r.set,
          r.kind,
          r.allTermsRank ?? '—',
          r.bestSearchTerm ?? '—',
          r.bestFindTerm ?? '—',
          r.attachedRanks ? r.attachedRanks.map((x) => x ?? '—').join(', ') : 'nothing (gate)',
        ]),
      ),
    );

    const dirTotals: Record<string, number> = {};
    for (const r of tuning) for (const [dir, n] of Object.entries(r.allTermsMatchesByDir)) dirTotals[dir] = (dirTotals[dir] ?? 0) + n;
    const totalMatches = Object.values(dirTotals).reduce((a, b) => a + b, 0);
    const inGold = tuning.reduce((n, r) => n + r.allTermsMatchesInGold, 0);
    console.log(`\nWhere the tuning set's all-terms searches' ${totalMatches} matches landed (${pct(inGold / totalMatches)} in labelled files):\n`);
    console.log(
      table(
        ['directory', 'matches', 'share'],
        Object.entries(dirTotals).sort((a, b) => b[1] - a[1]).map(([dir, n]) => [dir, n, pct(n / totalMatches)]),
      ),
    );

    // Latency and memory.
    const corpora: [string, string][] = [
      ['snapshot', snapshot],
      ['workspace', workspace],
      ['large', large],
    ];
    const stats: Record<string, Awaited<ReturnType<typeof corpusStats>>> = {};
    const prepass: Record<string, { files: number; buildMs: number; memoryMb: number }> = {};
    const timings: Timing[] = [];
    const typicalRequest = requests.find((r) => r.id === 'stuck-sooner')!.text;
    const typical = `(${terms(typicalRequest).join('|')})`;
    for (const [name, root] of corpora) {
      stats[name] = await corpusStats(root);
      const c = context(root);
      timings.push(await time(name, 'walk (list every file)', runs, async () => { for await (const _ of walkFiles(root)) { /* count only */ } }));
      timings.push(await time(name, 'find_files *runTracker*', runs, () => findFilesTool.run({ glob: '*runTracker*' }, c)));
      timings.push(await time(name, 'search_files, no match (full scan)', runs, () => searchFilesTool.run({ pattern: 'zq9xj_no_match' }, c)));
      timings.push(await time(name, 'search_files, typical request', runs, () => searchFilesTool.run({ pattern: typical, case_insensitive: true }, c)));

      // The large corpus is gitignored here, so list it with the walk rather than git.
      const before = memoryBytes();
      const started = performance.now();
      const idx = new CodeIndex(root, name === 'large' ? walkWorkspaceFiles : undefined);
      const built = await idx.refresh();
      prepass[name] = { files: built.files, buildMs: performance.now() - started, memoryMb: (memoryBytes() - before) / 1e6 };
      timings.push(await time(name, 'pre-pass: refresh index, no changes', runs, () => idx.refresh()));
      timings.push(await time(name, 'pre-pass: retrieve (search + excerpts)', runs, () => retrieve(idx, typicalRequest)));
    }
    const git = (args: string[]) => () => exec('git', args, { cwd: workspace, timeout: 3000, maxBuffer: 256 * 1024 });
    timings.push(await time('workspace', 'git branch --show-current', runs, git(['branch', '--show-current'])));
    timings.push(await time('workspace', 'git diff --stat', runs, git(['diff', '--stat'])));
    timings.push(await time('workspace', 'read one 30 KB file (attached context)', runs, () => fs.readFile(path.join(workspace, 'src/webview/ChatViewProvider.ts'), 'utf8')));

    const label = (name: string, root: string) =>
      name === 'snapshot' ? `snapshot (git archive ${SNAPSHOT_REF.slice(0, 7)})` : `${name} (${path.relative(workspace, root) || '.'})`;
    console.log(`\n## Latency (ms; first run, then median and max of ${runs} warm runs)\n`);
    console.log(
      table(
        ['corpus', 'files', 'MB (≤1 MB files)', 'indexed by pre-pass', 'index build ms', 'index memory MB'],
        corpora.map(([name, root]) => [
          label(name, root),
          stats[name].files,
          `${stats[name].mb.toFixed(1)} (${stats[name].searchedMb.toFixed(1)})`,
          prepass[name].files,
          Math.round(prepass[name].buildMs),
          prepass[name].memoryMb < 1 ? '<1' : prepass[name].memoryMb.toFixed(1),
        ]),
      ),
    );
    console.log('');
    console.log(table(['corpus', 'operation', 'first', 'median', 'max'], timings.map((t) => [t.corpus, t.op, ms(t.firstMs), ms(t.medianMs), ms(t.maxMs)])));

    const report = {
      date: new Date().toISOString(),
      ref: SNAPSHOT_REF,
      machine: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, cpus: os.cpus().length },
      ranking: { overall, byKind, gate: Object.fromEntries(gate.map(([name, total, n]) => [name, { total, attached: n }])), perRequest: results },
      latency: { corpora: stats, prepass, timings },
    };
    const stamp = report.date.replace(/[:.]/g, '-');
    await fs.mkdir(path.join(here, 'results'), { recursive: true });
    await fs.writeFile(path.join(here, 'results', `${stamp}.json`), JSON.stringify(report, null, 2));
    if (process.argv.includes('--save-baseline')) {
      await fs.writeFile(path.join(here, 'baseline.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(`\nSaved baseline to ${path.relative(workspace, path.join(here, 'baseline.json'))}`);
    }
  } finally {
    await fs.rm(snapshot, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
