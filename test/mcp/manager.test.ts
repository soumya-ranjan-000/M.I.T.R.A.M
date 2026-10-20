import { describe, expect, it, vi } from 'vitest';
import { McpClient, type McpClientDeps } from '../../src/mcp/McpClient';
import { McpManager } from '../../src/mcp/McpManager';
import { parseServers, type McpServerConfig } from '../../src/mcp/config';

const configs = (raw: Record<string, unknown>): McpServerConfig[] => {
  const { servers, problems } = parseServers(raw, {});
  if (problems.length) throw new Error(`bad config: ${problems.join('; ')}`);
  return servers;
};

/**
 * A stand-in for a connected server. Mirrors the parts of McpClient the manager uses, so the
 * manager can be tested without spawning anything.
 */
class FakeClient {
  status: McpClient['status'] = 'idle';
  error?: string;
  tools: { name: string }[] = [];
  starts = 0;
  closes = 0;

  constructor(
    readonly config: McpServerConfig,
    // Public and mutable so a test can fix a failing server and reconnect it.
    public behaviour: { toolNames?: string[]; fail?: string } = {},
  ) {
    if (!config.enabled) this.status = 'disabled';
  }

  get id() {
    return this.config.id;
  }

  async start(): Promise<void> {
    if (this.status === 'disabled' || this.status === 'ready') return;
    this.starts++;
    if (this.behaviour.fail) {
      this.status = 'failed';
      this.error = this.behaviour.fail;
      return;
    }
    this.status = 'ready';
    this.tools = (this.behaviour.toolNames ?? ['run']).map((name) => ({ name }));
  }

  async close(): Promise<void> {
    this.closes++;
    if (this.status !== 'disabled') this.status = 'idle';
    this.tools = [];
  }

  async callTool() {
    return { content: [{ type: 'text', text: 'ok' }] };
  }

  describe() {
    return this.id;
  }
}

/** Builds a manager whose clients are fakes, and hands back the fakes for inspection. */
function managerWith(
  servers: McpServerConfig[],
  behaviour: Record<string, { toolNames?: string[]; fail?: string }> = {},
  extra: Partial<ConstructorParameters<typeof McpManager>[0]> = {},
) {
  const made = new Map<string, FakeClient>();
  const manager = new McpManager({
    servers: () => servers,
    createClient: (config: McpServerConfig, _deps: McpClientDeps) => {
      const client = new FakeClient(config, behaviour[config.id] ?? {});
      made.set(config.id, client);
      return client as unknown as McpClient;
    },
    ...extra,
  });
  return { manager, made };
}

describe('McpManager: starting', () => {
  it('reports whether anything is configured', () => {
    expect(managerWith([]).manager.configured).toBe(false);
    expect(managerWith(configs({ a: { command: 'x' } })).manager.configured).toBe(true);
    expect(managerWith(configs({ a: { command: 'x', enabled: false } })).manager.configured).toBe(false);
  });

  it('connects enabled servers and collects their tools', async () => {
    const { manager } = managerWith(configs({ a: { command: 'x' }, b: { command: 'y' } }), {
      a: { toolNames: ['one', 'two'] },
      b: { toolNames: ['three'] },
    });

    await manager.ensureStarted();

    expect(manager.tools().map((t) => t.name).sort()).toEqual(['mcp__a__one', 'mcp__a__two', 'mcp__b__three']);
  });

  it('never starts a disabled server', async () => {
    const { manager, made } = managerWith(configs({ a: { command: 'x', enabled: false } }));
    await manager.ensureStarted();
    expect(made.get('a')!.starts).toBe(0);
    expect(manager.tools()).toEqual([]);
  });

  it('caches clients across runs, so a second run reconnects nothing', async () => {
    const { manager, made } = managerWith(configs({ a: { command: 'x' } }));

    await manager.ensureStarted();
    await manager.ensureStarted();
    await manager.ensureStarted();

    expect(made.get('a')!.starts).toBe(1);
  });

  it('starts servers in parallel rather than one after another', async () => {
    const order: string[] = [];
    const servers = configs({ a: { command: 'x' }, b: { command: 'y' } });
    const manager = new McpManager({
      servers: () => servers,
      createClient: (config) =>
        ({
          id: config.id,
          config,
          status: 'idle' as const,
          tools: [],
          async start() {
            order.push(`start:${config.id}`);
            await new Promise((r) => setTimeout(r, 10));
            order.push(`done:${config.id}`);
            (this as { status: string }).status = 'ready';
          },
          async close() {},
        }) as unknown as McpClient,
    });

    await manager.ensureStarted();

    // Both start before either finishes.
    expect(order.slice(0, 2).sort()).toEqual(['start:a', 'start:b']);
  });

  // One broken server must not cost the user the others.
  it('keeps the healthy servers when one fails', async () => {
    const { manager } = managerWith(configs({ good: { command: 'x' }, bad: { command: 'y' } }), {
      good: { toolNames: ['works'] },
      bad: { fail: 'spawn ENOENT' },
    });

    await manager.ensureStarted();

    expect(manager.tools().map((t) => t.name)).toEqual(['mcp__good__works']);
    const bad = manager.status().find((s) => s.id === 'bad')!;
    expect(bad.status).toBe('failed');
    expect(bad.error).toBe('spawn ENOENT');
  });
});

describe('McpManager: the trust gate', () => {
  it('asks once before starting anything, and starts when allowed', async () => {
    const confirmTrust = vi.fn(async (_servers: McpServerConfig[]) => true);
    const { manager, made } = managerWith(configs({ a: { command: 'x' }, b: { command: 'y' } }), {}, { confirmTrust });

    await manager.ensureStarted();
    await manager.ensureStarted();

    expect(confirmTrust).toHaveBeenCalledOnce();
    expect(confirmTrust.mock.calls[0][0].map((c) => c.id)).toEqual(['a', 'b']);
    expect(made.get('a')!.starts).toBe(1);
  });

  // The whole point of the gate: refusing must leave every process unstarted.
  it('starts nothing when the user refuses', async () => {
    const { manager, made } = managerWith(configs({ a: { command: 'x' } }), {}, { confirmTrust: async () => false });

    await manager.ensureStarted();

    expect(made.get('a')!.starts).toBe(0);
    expect(manager.tools()).toEqual([]);
  });

  it('does not ask again after a refusal', async () => {
    const confirmTrust = vi.fn(async () => false);
    const { manager } = managerWith(configs({ a: { command: 'x' } }), {}, { confirmTrust });

    await manager.ensureStarted();
    await manager.ensureStarted();

    expect(confirmTrust).toHaveBeenCalledOnce();
  });

  it('asks again after resetTrust()', async () => {
    const confirmTrust = vi.fn(async () => false);
    const { manager } = managerWith(configs({ a: { command: 'x' } }), {}, { confirmTrust });

    await manager.ensureStarted();
    manager.resetTrust();
    await manager.ensureStarted();

    expect(confirmTrust).toHaveBeenCalledTimes(2);
  });

  it('does not ask when nothing is configured', async () => {
    const confirmTrust = vi.fn(async () => true);
    const { manager } = managerWith([], {}, { confirmTrust });

    await manager.ensureStarted();

    expect(confirmTrust).not.toHaveBeenCalled();
  });
});

describe('McpManager: tools', () => {
  it('offers nothing before the servers are started', () => {
    const { manager } = managerWith(configs({ a: { command: 'x' } }));
    expect(manager.tools()).toEqual([]);
  });

  it('caps the number of tools and says which were dropped', async () => {
    const lines: string[] = [];
    const names = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const { manager } = managerWith(configs({ a: { command: 'x' } }), { a: { toolNames: names } }, {
      toolLimit: () => 4,
      log: (m) => lines.push(m),
    });

    await manager.ensureStarted();

    expect(manager.tools()).toHaveLength(4);
    expect(lines.join('\n')).toMatch(/offering 4 of 10 tools/);
  });

  it('passes the blocklist to each tool', async () => {
    const { manager } = managerWith(configs({ a: { command: 'x' } }), { a: { toolNames: ['delete_all'] } }, {
      blocked: () => [/delete_/],
    });

    await manager.ensureStarted();

    const tool = manager.tools()[0];
    expect(tool.policy?.({}, {} as never)).toMatch(/blocked by mitram.blockedMcpTools/);
  });

  it('lists the configured server ids', () => {
    const { manager } = managerWith(configs({ a: { command: 'x' }, b: { url: 'https://x.example/mcp' } }));
    expect(manager.serverIds()).toEqual(['a', 'b']);
  });
});

describe('McpManager: status', () => {
  it('describes every configured server, started or not', () => {
    const { manager } = managerWith(configs({ a: { command: 'npx', args: ['-y', 'pkg'] }, b: { command: 'y', enabled: false } }));

    expect(manager.status()).toEqual([
      { id: 'a', status: 'idle', error: undefined, toolCount: 0, description: 'npx -y pkg', needsKey: false, oauth: false, enabled: true },
      { id: 'b', status: 'disabled', error: undefined, toolCount: 0, description: 'y', needsKey: false, oauth: false, enabled: false },
    ]);
  });

  it('counts tools once connected', async () => {
    const { manager } = managerWith(configs({ a: { command: 'x' } }), { a: { toolNames: ['one', 'two'] } });
    await manager.ensureStarted();
    expect(manager.status()[0]).toMatchObject({ status: 'ready', toolCount: 2 });
  });

  it('flags a server that needs an API key', () => {
    const { manager } = managerWith(configs({ a: { url: 'https://x.example/mcp', auth: { name: 'Authorization' } } }));
    expect(manager.status()[0].needsKey).toBe(true);
  });
});

describe('McpManager: settings changes', () => {
  it('picks up a newly added server', async () => {
    let servers = configs({ a: { command: 'x' } });
    const { manager } = managerWith([], {}, { servers: () => servers });

    await manager.ensureStarted();
    expect(manager.tools()).toHaveLength(1);

    servers = configs({ a: { command: 'x' }, b: { command: 'y' } });
    await manager.refresh();

    expect(manager.tools()).toHaveLength(2);
  });

  it('closes a server that was removed from settings', async () => {
    let servers = configs({ a: { command: 'x' }, b: { command: 'y' } });
    const made = new Map<string, FakeClient>();
    const manager = new McpManager({
      servers: () => servers,
      createClient: (config) => {
        const client = new FakeClient(config);
        made.set(config.id, client);
        return client as unknown as McpClient;
      },
    });

    await manager.ensureStarted();
    servers = configs({ a: { command: 'x' } });
    await manager.refresh();

    expect(made.get('b')!.closes).toBe(1);
    expect(manager.tools().map((t) => t.name)).toEqual(['mcp__a__run']);
  });

  it('reconnects a server whose configuration changed', async () => {
    let servers = configs({ a: { command: 'x' } });
    const built: FakeClient[] = [];
    const manager = new McpManager({
      servers: () => servers,
      createClient: (config) => {
        const client = new FakeClient(config);
        built.push(client);
        return client as unknown as McpClient;
      },
    });

    await manager.ensureStarted();
    servers = configs({ a: { command: 'x', args: ['--new-flag'] } });
    await manager.refresh();

    expect(built).toHaveLength(2);
    expect(built[0].closes).toBe(1);
    expect(built[1].config.args).toEqual(['--new-flag']);
  });

  it('leaves an unchanged server connected', async () => {
    const servers = configs({ a: { command: 'x' } });
    const { manager, made } = managerWith(servers, {}, { servers: () => servers });

    await manager.ensureStarted();
    await manager.refresh();

    expect(made.get('a')!.closes).toBe(0);
    expect(made.get('a')!.starts).toBe(1);
  });
});

describe('McpManager: restart', () => {
  it('reconnects one server', async () => {
    const { manager, made } = managerWith(configs({ a: { command: 'x' }, b: { command: 'y' } }));
    await manager.ensureStarted();

    await manager.restart('a');

    expect(made.get('a')!.closes).toBe(1);
    expect(made.get('a')!.starts).toBe(2);
    expect(made.get('b')!.closes).toBe(0);
  });

  it('reconnects everything when given no id', async () => {
    const { manager, made } = managerWith(configs({ a: { command: 'x' }, b: { command: 'y' } }));
    await manager.ensureStarted();

    await manager.restart();

    expect(made.get('a')!.starts).toBe(2);
    expect(made.get('b')!.starts).toBe(2);
  });

  it('recovers a failed server once the problem is fixed', async () => {
    const behaviour: Record<string, { fail?: string }> = { a: { fail: 'no API key set' } };
    const servers = configs({ a: { url: 'https://x.example/mcp', auth: { name: 'Authorization' } } });
    const made = new Map<string, FakeClient>();
    const manager = new McpManager({
      servers: () => servers,
      createClient: (config) => {
        const client = new FakeClient(config, behaviour[config.id] ?? {});
        made.set(config.id, client);
        return client as unknown as McpClient;
      },
    });

    await manager.ensureStarted();
    expect(manager.status()[0].status).toBe('failed');

    behaviour.a = {};
    made.get('a')!.behaviour = {} as never;
    await manager.restart('a');

    expect(manager.status()[0].status).toBe('ready');
  });

  it('notifies the UI when a status changes', async () => {
    const onChange = vi.fn();
    const { manager } = managerWith(configs({ a: { command: 'x' } }), {}, { onChange });

    await manager.ensureStarted();

    expect(onChange).toHaveBeenCalled();
  });
});

describe('McpManager: disposal', () => {
  // A leaked child process outlives the window, so this is the important one.
  it('closes every client', async () => {
    const { manager, made } = managerWith(configs({ a: { command: 'x' }, b: { command: 'y' } }));
    await manager.ensureStarted();

    await manager.dispose();

    expect(made.get('a')!.closes).toBe(1);
    expect(made.get('b')!.closes).toBe(1);
    expect(manager.tools()).toEqual([]);
  });

  it('starts nothing after disposal', async () => {
    const { manager, made } = managerWith(configs({ a: { command: 'x' } }));
    await manager.dispose();

    await manager.ensureStarted();

    expect(made.get('a')).toBeUndefined();
  });

  it('closes servers that never connected', async () => {
    const { manager, made } = managerWith(configs({ a: { command: 'x' } }), {}, { confirmTrust: async () => false });
    await manager.ensureStarted();

    await manager.dispose();

    expect(made.get('a')!.closes).toBe(1);
  });
});
