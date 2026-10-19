// Smoke test for PLAN task 7.14: drives McpClient against a REAL MCP server running as a
// separate process over stdio. The unit tests use an in-process transport, so this is what
// proves spawning, env injection and shutdown actually work.
//
// Run: npx esbuild scripts/mcp-smoke.ts --bundle --platform=node --target=node20 \
//        --format=cjs --outfile=/tmp/mcp-smoke.js && node /tmp/mcp-smoke.js
import { join } from 'node:path';
import { McpClient } from '../src/mcp/McpClient';
import { McpManager } from '../src/mcp/McpManager';
import { parseServers } from '../src/mcp/config';

// Resolved from the working directory, not __dirname: this file is bundled to a temporary
// path before it runs, so __dirname would point at the bundle's directory.
const SERVER = join(process.cwd(), 'scripts', 'mcp-smoke-server.js');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const { servers, problems } = parseServers(
    {
      smoke: { command: process.execPath, args: [SERVER], auth: { kind: 'env', name: 'SMOKE_TOKEN' } },
      broken: { command: process.execPath, args: [join(__dirname, 'does-not-exist.js')] },
    },
    {},
  );
  check('config parses with no problems', problems.length === 0, problems.join('; '));

  console.log('\n— a real stdio server —');
  const logs: string[] = [];
  const client = new McpClient(servers[0], {
    getApiKey: async () => 'smoke-secret-token',
    log: (m) => logs.push(m),
  });

  await client.start();
  check('connects to a spawned process', client.status === 'ready', client.error);
  check('lists its tools', client.tools.length === 2, client.tools.map((t) => t.name).join(', '));
  check('keeps the read-only hint', client.tools.find((t) => t.name === 'whoami')?.annotations?.readOnlyHint === true);

  const echoed = await client.callTool('echo', { text: 'hello' });
  const echoText = (echoed.content[0] as { text?: string })?.text;
  check('calls a tool and gets its result', echoText === 'echo: hello', echoText);

  // The key is injected into the child's environment, never logged or written to settings.
  const who = await client.callTool('whoami', {});
  const whoText = (who.content[0] as { text?: string })?.text;
  check('the API key reaches the server', whoText === 'token=smoke-secret-token', whoText);
  check('the key never appears in the log', !logs.join('\n').includes('smoke-secret-token'));
  check('arguments never appear in the log', !logs.join('\n').includes('hello'));

  const failed = await client.callTool('echo', {}).then(
    (r) => r,
    () => ({ isError: true, content: [] }),
  );
  check('a bad call reports an error rather than crashing', failed.isError === true);

  await client.close();
  check('closes cleanly', client.status === 'idle');

  console.log('\n— a server that cannot start —');
  const broken = new McpClient(servers[1], { log: () => {} });
  await broken.start();
  check('records the failure instead of throwing', broken.status === 'failed', broken.error);

  console.log('\n— the manager —');
  const manager = new McpManager({
    servers: () => servers,
    getApiKey: async () => 'smoke-secret-token',
    confirmTrust: async () => true,
    log: () => {},
  });
  await manager.ensureStarted();
  const tools = manager.tools();
  check('offers the healthy server tools', tools.length === 2, tools.map((t) => t.name).join(', '));
  check('names them mcp__smoke__*', tools.every((t) => t.name.startsWith('mcp__smoke__')));
  check('every MCP tool needs approval', tools.every((t) => t.requiresApproval));
  check('reports one failed server', manager.status().filter((s) => s.status === 'failed').length === 1);
  check('knows which tools are read-only', manager.readOnlyToolNames().has('mcp__smoke__whoami'));

  const run = await tools.find((t) => t.name === 'mcp__smoke__echo')!.run({ text: 'via registry' }, {
    root: process.cwd(),
    signal: new AbortController().signal,
    files: { readText: async () => '', writeText: async () => {}, exists: async () => false, remove: async () => {} },
  });
  check('a tool runs through the Tool interface', run === 'echo: via registry', run);

  // A leaked child process would outlive the window.
  await manager.dispose();
  check('dispose leaves nothing connected', manager.tools().length === 0);

  console.log(`\n${failures === 0 ? 'All smoke checks passed.' : `${failures} smoke check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('smoke test crashed:', error);
  process.exit(1);
});
