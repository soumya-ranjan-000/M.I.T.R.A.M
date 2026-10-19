import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { McpClient, MISSING_KEY } from '../../src/mcp/McpClient';
import { parseServers, type McpServerConfig } from '../../src/mcp/config';

const config = (raw: Record<string, unknown>, id = 'test'): McpServerConfig => {
  const { servers, problems } = parseServers({ [id]: raw }, {});
  if (!servers[0]) throw new Error(`bad config: ${problems.join('; ')}`);
  return servers[0];
};

/** A real MCP server in this process, reachable through a linked transport pair. */
function fakeServer(build: (server: McpServer) => void): () => Transport {
  return () => {
    const server = new McpServer({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
    build(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return clientSide;
  };
}

const greeter = fakeServer((server) => {
  server.registerTool(
    'greet',
    { description: 'Says hello.', inputSchema: { name: z.string() } },
    async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }),
  );
  server.registerTool(
    'peek',
    { description: 'Reads something.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: 'text', text: 'peeked' }] }),
  );
});

describe('McpClient lifecycle', () => {
  it('starts idle and connects on start()', async () => {
    const client = new McpClient(config({ command: 'unused' }), { createTransport: greeter });
    expect(client.status).toBe('idle');

    await client.start();

    expect(client.status).toBe('ready');
    expect(client.error).toBeUndefined();
    expect(client.tools.map((t) => t.name).sort()).toEqual(['greet', 'peek']);
    await client.close();
  });

  it('keeps the server annotations, so read-only hints survive', async () => {
    const client = new McpClient(config({ command: 'unused' }), { createTransport: greeter });
    await client.start();
    expect(client.tools.find((t) => t.name === 'peek')?.annotations?.readOnlyHint).toBe(true);
    expect(client.tools.find((t) => t.name === 'greet')?.annotations?.readOnlyHint).toBeFalsy();
    await client.close();
  });

  it('is disabled when the config says so, and start() does nothing', async () => {
    const client = new McpClient(config({ command: 'unused', enabled: false }), { createTransport: greeter });
    expect(client.status).toBe('disabled');
    await client.start();
    expect(client.status).toBe('disabled');
    expect(client.tools).toEqual([]);
  });

  it('connects only once when start() is called repeatedly', async () => {
    let built = 0;
    const client = new McpClient(config({ command: 'unused' }), {
      createTransport: () => {
        built++;
        return greeter();
      },
    });
    await Promise.all([client.start(), client.start(), client.start()]);
    await client.start();
    expect(built).toBe(1);
    await client.close();
  });

  it('calls a tool and returns its content', async () => {
    const client = new McpClient(config({ command: 'unused' }), { createTransport: greeter });
    await client.start();

    const result = await client.callTool('greet', { name: 'Ada' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, Ada!' }]);
    await client.close();
  });

  it('reports a tool error as isError rather than throwing', async () => {
    const client = new McpClient(config({ command: 'unused' }), { createTransport: greeter });
    await client.start();
    // "greet" requires a string name, so this fails inside the server.
    const result = await client.callTool('greet', {});
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('refuses a call before it is connected', async () => {
    const client = new McpClient(config({ command: 'unused' }), { createTransport: greeter });
    await expect(client.callTool('greet', { name: 'Ada' })).rejects.toThrow(/not connected/);
  });

  it('closes cleanly and can be started again', async () => {
    const client = new McpClient(config({ command: 'unused' }), { createTransport: greeter });
    await client.start();
    await client.close();

    expect(client.status).toBe('idle');
    expect(client.tools).toEqual([]);

    await client.start();
    expect(client.status).toBe('ready');
    await client.close();
  });

  it('survives close() being called twice', async () => {
    const client = new McpClient(config({ command: 'unused' }), { createTransport: greeter });
    await client.start();
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe('McpClient failures', () => {
  // A broken server must cost the user its tools and nothing else.
  it('records a connection failure instead of throwing', async () => {
    const client = new McpClient(config({ command: 'unused' }), {
      createTransport: () => {
        throw new Error('spawn ENOENT');
      },
    });

    await expect(client.start()).resolves.toBeUndefined();

    expect(client.status).toBe('failed');
    expect(client.error).toMatch(/spawn ENOENT/);
    expect(client.tools).toEqual([]);
  });

  it('fails with a clear reason when a server needs a key that is not set', async () => {
    const client = new McpClient(config({ url: 'https://x.example/mcp', auth: { name: 'Authorization' } }), {
      createTransport: greeter,
      getApiKey: async () => undefined,
    });

    await client.start();

    expect(client.status).toBe('failed');
    expect(client.error).toBe(MISSING_KEY);
  });

  it('uses the stored key when the server declares auth', async () => {
    let asked = '';
    const client = new McpClient(config({ url: 'https://x.example/mcp', auth: { name: 'Authorization', format: 'Bearer {key}' } }), {
      createTransport: greeter,
      getApiKey: async (id) => {
        asked = id;
        return 'secret-token';
      },
    });

    await client.start();

    expect(client.status).toBe('ready');
    expect(asked).toBe('test');
    await client.close();
  });

  it('can be retried after a failure', async () => {
    let attempt = 0;
    const client = new McpClient(config({ command: 'unused' }), {
      createTransport: () => {
        if (attempt++ === 0) throw new Error('first attempt fails');
        return greeter();
      },
    });

    await client.start();
    expect(client.status).toBe('failed');

    await client.start();
    expect(client.status).toBe('ready');
    await client.close();
  });
});

describe('McpClient logging', () => {
  // Logs are shared in bug reports, and arguments routinely hold credentials.
  it('never logs arguments, results or the API key', async () => {
    const lines: string[] = [];
    const client = new McpClient(config({ url: 'https://x.example/mcp', auth: { name: 'Authorization' } }), {
      createTransport: greeter,
      getApiKey: async () => 'super-secret-key',
      log: (m) => lines.push(m),
    });

    await client.start();
    await client.callTool('greet', { name: 'Top-Secret-Person' });
    await client.close();

    const text = lines.join('\n');
    expect(text).not.toContain('super-secret-key');
    expect(text).not.toContain('Top-Secret-Person');
    expect(text).not.toContain('Hello,');
    // It should still say something useful.
    expect(text).toMatch(/mcp test: ready, 2 tools/);
    expect(text).toMatch(/mcp test: greet ok/);
  });

  it('describes a server without revealing secrets', () => {
    const client = new McpClient(config({ command: 'npx', args: ['-y', 'pkg'] }), {});
    expect(client.describe()).toBe('test (stdio) npx -y pkg');
  });
});
