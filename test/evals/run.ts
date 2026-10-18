/**
 * Runs the eval tasks against your real model and records a pass rate.
 *
 *   MITRAM_ENDPOINT=https://<resource>.services.ai.azure.com/anthropic/ \
 *   MITRAM_API_KEY=... [MITRAM_MODEL=<deployment>] npm run eval -- --yes
 *
 * Flags: --yes (required, this spends tokens) --only a,b --concurrency N
 *        --keep (keep temp workspaces) --save-baseline
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AnthropicProvider } from '../../src/providers/AnthropicProvider';
import { TaskResult, runTask } from './runTask';
import { tasks } from './tasks';

const here = path.resolve(process.cwd(), 'test/evals');
const BASELINE = path.join(here, 'baseline.json');

interface Baseline {
  date: string;
  model: string;
  passRate: number;
  results: Record<string, boolean>;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const endpoint = process.env.MITRAM_ENDPOINT;
  const apiKey = process.env.MITRAM_API_KEY;
  const model = process.env.MITRAM_MODEL ?? 'claude-opus-5-5';
  if (!endpoint || !apiKey) {
    console.error('Set MITRAM_ENDPOINT and MITRAM_API_KEY (and optionally MITRAM_MODEL).');
    return 2;
  }

  const only = option('only')?.split(',');
  const selected = only ? tasks.filter((t) => only.includes(t.id)) : tasks;
  if (selected.length === 0) {
    console.error(`No tasks match --only ${only?.join(',')}. Known ids: ${tasks.map((t) => t.id).join(', ')}`);
    return 2;
  }
  if (!flag('yes')) {
    console.error(
      `This will run ${selected.length} task(s) against "${model}" and spend tokens (each task can take several model calls).\n` +
        'Re-run with --yes to proceed.',
    );
    return 2;
  }

  const provider = new AnthropicProvider({ baseURL: endpoint, apiKey, model });
  const concurrency = Math.max(1, Number(option('concurrency') ?? 2));
  const results: TaskResult[] = [];
  const queue = [...selected];

  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      const r = await runTask(task, provider, { keep: flag('keep') });
      results.push(r);
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(26)} ${(r.ms / 1000).toFixed(1)}s  ${r.steps} tool calls${r.pass ? '' : `\n      ${r.reason}`}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const passed = results.filter((r) => r.pass).length;
  const passRate = passed / results.length;
  const sum = (f: (r: TaskResult) => number) => results.reduce((n, r) => n + f(r), 0);
  console.log(
    `\n${passed}/${results.length} passed (${Math.round(passRate * 100)}%)` +
      `\ntokens: ${sum((r) => r.inputTokens).toLocaleString()} in (${sum((r) => r.cacheReadTokens).toLocaleString()} cached), ${sum((r) => r.outputTokens).toLocaleString()} out`,
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(path.join(here, 'results'), { recursive: true });
  await fs.writeFile(path.join(here, 'results', `${stamp}.json`), JSON.stringify({ model, passRate, results }, null, 2));

  const current: Record<string, boolean> = Object.fromEntries(results.map((r) => [r.id, r.pass]));
  let regressions: string[] = [];
  try {
    const base = JSON.parse(await fs.readFile(BASELINE, 'utf8')) as Baseline;
    regressions = Object.entries(base.results).filter(([id, was]) => was && current[id] === false).map(([id]) => id);
    console.log(`baseline: ${Math.round(base.passRate * 100)}% (${base.model}, ${base.date.slice(0, 10)})`);
    if (regressions.length) console.log(`REGRESSIONS vs baseline: ${regressions.join(', ')}`);
  } catch {
    console.log('No baseline yet. Run with --save-baseline to record this result.');
  }

  if (flag('save-baseline')) {
    const baseline: Baseline = { date: new Date().toISOString(), model, passRate, results: current };
    await fs.writeFile(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`Saved baseline to ${path.relative(process.cwd(), BASELINE)}`);
  }
  return regressions.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(2);
});
