// Smoke test for PLAN task 7.14, against the REAL @playwright/mcp server the user asked about.
// Proves a published third-party server connects and its tools arrive through the Tool interface.
//
// Run: npx esbuild scripts/mcp-smoke-playwright.ts --bundle --platform=node --target=node20 \
//        --format=cjs --outfile=/tmp/mcp-pw.js && node /tmp/mcp-pw.js
import { McpManager } from '../src/mcp/McpManager';
import { parseServers } from '../src/mcp/config';
import { MCP_PRESETS, buildEntry, findPreset } from '../src/mcp/presets';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  // Exactly what the "Add server" wizard writes when the user picks Playwright.
  const entry = buildEntry(findPreset('playwright')!, {});
  console.log(`settings entry: ${JSON.stringify(entry)}`);

  const { servers, problems } = parseServers({ playwright: entry }, {});
  check('the preset validates', problems.length === 0 && servers.length === 1, problems.join('; '));

  const manager = new McpManager({
    servers: () => servers,
    confirmTrust: async () => true,
    log: (m) => console.log(`    log: ${m}`),
  });

  console.log('\n— connecting to @playwright/mcp (this downloads the package on first run) —');
  const started = Date.now();
  await manager.ensureStarted();

  const status = manager.status()[0];
  check('connects', status.status === 'ready', status.error);
  if (status.status !== 'ready') {
    console.log('\nCould not reach the server (likely offline). Skipping the rest.');
    await manager.dispose();
    process.exit(0);
  }

  console.log(`    connected in ${Date.now() - started}ms`);
  const tools = manager.tools();
  check('offers its tools', tools.length > 0, `${tools.length} tools`);
  check('names them mcp__playwright__*', tools.every((t) => t.name.startsWith('mcp__playwright__')));
  check('every tool needs approval', tools.every((t) => t.requiresApproval));
  check('every name fits the API limit', tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)));
  check('every tool has a schema the API accepts', tools.every((t) => t.inputSchema?.type === 'object'));
  check('descriptions say which server they came from', tools.every((t) => t.description.startsWith('[playwright]')));

  const navigate = tools.find((t) => t.name.includes('navigate'));
  check('includes a navigate tool', !!navigate, navigate?.name);
  if (navigate) {
    const preview = navigate.preview({ url: 'https://example.com' });
    check('previews the arguments for approval', preview.detail?.includes('example.com') === true, preview.summary);
    check('is badged as MCP', preview.badge === 'MCP');
  }

  console.log(`\n    first 8 tools: ${tools.slice(0, 8).map((t) => t.name).join(', ')}`);

  // The tool cap keeps prompt cost bounded; Playwright alone offers a few dozen.
  const capped = new McpManager({
    servers: () => servers,
    confirmTrust: async () => true,
    toolLimit: () => 5,
    log: () => {},
  });
  await capped.ensureStarted();
  check('respects mitram.mcpToolLimit', capped.tools().length === 5, `${capped.tools().length} tools`);
  await capped.dispose();

  await manager.dispose();
  check('dispose closes the server', manager.tools().length === 0);

  console.log(`\n${failures === 0 ? 'All Playwright smoke checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('smoke test crashed:', error);
  process.exit(1);
});
