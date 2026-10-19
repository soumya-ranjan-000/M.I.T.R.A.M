// A minimal real MCP server over stdio, for the smoke test in scripts/mcp-smoke.ts.
// Not shipped: scripts/ is excluded from the extension bundle.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'smoke', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool(
  'echo',
  { description: 'Returns what it is given.', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);

server.registerTool(
  'whoami',
  { description: 'Reports whether the API key reached the server.', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: `token=${process.env.SMOKE_TOKEN ?? '(none)'}` }] }),
);

server.connect(new StdioServerTransport());
