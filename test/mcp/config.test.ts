import { describe, expect, it } from 'vitest';
import { describeServer, expandEnvRefs, formatAuthValue, parseServers } from '../../src/mcp/config';

const one = (raw: unknown, env: Record<string, string | undefined> = {}) => parseServers(raw, env);

describe('parseServers: shape', () => {
  it('accepts nothing configured', () => {
    expect(parseServers(undefined)).toEqual({ servers: [], problems: [] });
    expect(parseServers(null)).toEqual({ servers: [], problems: [] });
    expect(parseServers({})).toEqual({ servers: [], problems: [] });
  });

  it('rejects a non-object setting', () => {
    const { servers, problems } = one([{ command: 'npx' }]);
    expect(servers).toEqual([]);
    expect(problems[0]).toMatch(/must be an object/);
  });

  it('skips an entry that is not an object', () => {
    const { servers, problems } = one({ bad: 'npx playwright' });
    expect(servers).toEqual([]);
    expect(problems[0]).toMatch(/each server must be an object/);
  });

  it('keeps the good servers when one entry is bad', () => {
    const { servers, problems } = one({
      bad: {},
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    expect(servers.map((s) => s.id)).toEqual(['playwright']);
    expect(problems).toHaveLength(1);
  });

  it('rejects a server name that cannot appear in a tool name', () => {
    const { servers, problems } = one({ 'my server!': { command: 'npx' } });
    expect(servers).toEqual([]);
    expect(problems[0]).toMatch(/letters, digits/);
  });
});

describe('parseServers: transport', () => {
  it('reads a local stdio server', () => {
    const { servers } = one({ playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } });
    expect(servers[0]).toMatchObject({
      id: 'playwright',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      enabled: true,
    });
  });

  it('infers streamable http from a plain url', () => {
    const { servers } = one({ docs: { url: 'https://mcp.example.com/mcp' } });
    expect(servers[0].transport).toBe('http');
  });

  it('infers legacy sse from a /sse url, as Atlassian uses', () => {
    const { servers } = one({ atlassian: { url: 'https://mcp.atlassian.com/v1/sse' } });
    expect(servers[0].transport).toBe('sse');
  });

  it('honours an explicit transport', () => {
    const { servers } = one({ docs: { url: 'https://mcp.example.com/sse', transport: 'http' } });
    expect(servers[0].transport).toBe('http');
  });

  it('falls back to inference for an unknown transport', () => {
    const { servers, problems } = one({ docs: { url: 'https://mcp.example.com/mcp', transport: 'carrier-pigeon' } });
    expect(servers[0].transport).toBe('http');
    expect(problems[0]).toMatch(/"transport" must be/);
  });

  it('requires exactly one of command and url', () => {
    expect(one({ a: { command: 'npx', url: 'https://x.example/mcp' } }).problems[0]).toMatch(/exactly one/);
    expect(one({ a: { args: ['x'] } }).problems[0]).toMatch(/exactly one/);
  });

  it('rejects a url transport without a url', () => {
    const { servers, problems } = one({ a: { command: 'npx', transport: 'http' } });
    expect(servers).toEqual([]);
    expect(problems.some((p) => /needs a "url"/.test(p))).toBe(true);
  });
});

describe('parseServers: url safety', () => {
  it('rejects a malformed url', () => {
    const { servers, problems } = one({ a: { url: 'not a url' } });
    expect(servers).toEqual([]);
    expect(problems[0]).toMatch(/not a valid URL/);
  });

  // A token in a header would otherwise travel in clear text.
  it('rejects plain http for a remote host', () => {
    const { servers, problems } = one({ a: { url: 'http://mcp.example.com/mcp' } });
    expect(servers).toEqual([]);
    expect(problems[0]).toMatch(/must use https/);
  });

  it('allows http on localhost, for a server you run yourself', () => {
    expect(one({ a: { url: 'http://localhost:3000/mcp' } }).servers).toHaveLength(1);
    expect(one({ b: { url: 'http://127.0.0.1:3000/mcp' } }).servers).toHaveLength(1);
  });
});

describe('parseServers: fields', () => {
  it('ignores args that are not an array of strings', () => {
    const { servers, problems } = one({ a: { command: 'npx', args: ['ok', 7] } });
    expect(servers[0].args).toEqual([]);
    expect(problems[0]).toMatch(/"args" must be an array of strings/);
  });

  it('ignores non-string values in env and headers', () => {
    const { servers, problems } = one({ a: { command: 'npx', env: { GOOD: 'x', BAD: 3 } } });
    expect(servers[0].env).toEqual({ GOOD: 'x' });
    expect(problems[0]).toMatch(/"env.BAD" must be a string/);
  });

  it('defaults enabled to true and respects false', () => {
    expect(one({ a: { command: 'npx' } }).servers[0].enabled).toBe(true);
    expect(one({ a: { command: 'npx', enabled: false } }).servers[0].enabled).toBe(false);
  });
});

describe('parseServers: ${env:NAME} expansion', () => {
  it('expands in url, args, env and headers', () => {
    const { servers } = one(
      {
        a: {
          url: 'https://${env:HOST}/mcp',
          headers: { 'X-Tenant': '${env:TENANT}' },
        },
      },
      { HOST: 'mcp.example.com', TENANT: 'acme' },
    );
    expect(servers[0].url).toBe('https://mcp.example.com/mcp');
    expect(servers[0].headers).toEqual({ 'X-Tenant': 'acme' });
  });

  it('reports a variable that is not set, without failing the server', () => {
    const { servers, problems } = one({ a: { command: 'npx', env: { TOKEN: '${env:NOPE}' } } }, {});
    expect(servers[0].env).toEqual({ TOKEN: '' });
    expect(problems[0]).toMatch(/\$\{env:NOPE\}/);
  });

  it('leaves text without a reference alone', () => {
    expect(expandEnvRefs('plain', {})).toBe('plain');
    expect(expandEnvRefs('${notenv:X}', {})).toBe('${notenv:X}');
  });
});

describe('parseServers: auth', () => {
  it('defaults a remote server to a header and a local one to an env var', () => {
    expect(one({ a: { url: 'https://x.example/mcp', auth: { name: 'Authorization' } } }).servers[0].auth).toEqual({
      kind: 'header',
      name: 'Authorization',
      format: '{key}',
    });
    expect(one({ b: { command: 'npx', auth: { name: 'GITHUB_TOKEN' } } }).servers[0].auth).toEqual({
      kind: 'env',
      name: 'GITHUB_TOKEN',
      format: '{key}',
    });
  });

  it('keeps a format that contains {key}', () => {
    const { servers } = one({ a: { url: 'https://x.example/mcp', auth: { name: 'Authorization', format: 'Bearer {key}' } } });
    expect(servers[0].auth?.format).toBe('Bearer {key}');
  });

  it('falls back when the format would drop the key', () => {
    const { servers, problems } = one({ a: { url: 'https://x.example/mcp', auth: { name: 'Authorization', format: 'Bearer' } } });
    expect(servers[0].auth?.format).toBe('{key}');
    expect(problems[0]).toMatch(/must be a string containing/);
  });

  it('drops auth without a name', () => {
    const { servers, problems } = one({ a: { url: 'https://x.example/mcp', auth: {} } });
    expect(servers[0].auth).toBeUndefined();
    expect(problems[0]).toMatch(/"auth.name" is required/);
  });

  it('drops auth with an unknown kind', () => {
    const { servers, problems } = one({ a: { url: 'https://x.example/mcp', auth: { kind: 'basic', name: 'x' } } });
    expect(servers[0].auth).toBeUndefined();
    expect(problems[0]).toMatch(/"auth.kind" must be/);
  });

  it('accepts oauth for a remote server, with no name needed', () => {
    const { servers, problems } = one({ a: { url: 'https://x.example/mcp', auth: { kind: 'oauth' } } });
    expect(problems).toEqual([]);
    expect(servers[0].auth).toEqual({ kind: 'oauth', name: '', format: '{key}' });
  });

  it('refuses oauth for a local command, which has no sign-in page', () => {
    const { servers, problems } = one({ a: { command: 'npx', auth: { kind: 'oauth' } } });
    expect(servers[0].auth).toBeUndefined();
    expect(problems[0]).toMatch(/oauth.*remote/);
  });

  // The secret itself must never be readable from settings.
  it('never carries a key on the parsed config', () => {
    const { servers } = one({ a: { url: 'https://x.example/mcp', auth: { name: 'Authorization' }, key: 'sk-secret' } });
    expect(JSON.stringify(servers[0])).not.toContain('sk-secret');
  });
});

describe('helpers', () => {
  it('formats an auth value from the template', () => {
    expect(formatAuthValue({ kind: 'header', name: 'Authorization', format: 'Bearer {key}' }, 'abc')).toBe('Bearer abc');
    expect(formatAuthValue({ kind: 'env', name: 'TOKEN', format: '{key}' }, 'abc')).toBe('abc');
  });

  it('describes a server without revealing secrets', () => {
    const { servers } = one({ a: { command: 'npx', args: ['-y', 'pkg'] }, b: { url: 'https://x.example/mcp' } });
    expect(describeServer(servers[0])).toBe('npx -y pkg');
    expect(describeServer(servers[1])).toBe('https://x.example/mcp');
  });
});
