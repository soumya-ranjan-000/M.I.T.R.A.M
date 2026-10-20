import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
// @ts-expect-error express ships no types here and the SDK's own types are not needed for a fake server
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpClient } from '../../src/mcp/McpClient';
import { McpServerConfig } from '../../src/mcp/config';
import { McpOAuthProvider, OAuthHost, OAuthStore, SignInRequired, isSafeAuthorizationUrl, startOAuthCallback } from '../../src/mcp/oauth';

/** A stand-in for a hosted MCP server with OAuth: registration, authorize, token, refresh, and a tool behind a bearer token. */
async function fakeServer() {
  const clients = new Map<string, OAuthClientInformationFull>();
  const codes = new Map<string, { challenge: string; clientId: string }>();
  const access = new Set<string>();
  const refresh = new Map<string, string>();
  const stats = { registrations: 0, authorizations: 0, refreshes: 0, deny: false };

  const issue = (clientId: string) => {
    const accessToken = `at-${randomBytes(6).toString('hex')}`;
    const refreshToken = `rt-${randomBytes(6).toString('hex')}`;
    access.add(accessToken);
    refresh.set(refreshToken, clientId);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer', expires_in: 3600 };
  };

  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: (id) => clients.get(id),
      registerClient: (client) => {
        stats.registrations++;
        const full = { ...client, client_id: `client-${stats.registrations}`, client_id_issued_at: Date.now() } as OAuthClientInformationFull;
        clients.set(full.client_id, full);
        return full;
      },
    },
    async authorize(client, params, res) {
      stats.authorizations++;
      const target = new URL(params.redirectUri);
      if (stats.deny) {
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'The user denied access');
      } else {
        const code = `code-${randomBytes(6).toString('hex')}`;
        codes.set(code, { challenge: params.codeChallenge, clientId: client.client_id });
        target.searchParams.set('code', code);
      }
      if (params.state) target.searchParams.set('state', params.state);
      res.redirect(target.toString());
    },
    async challengeForAuthorizationCode(_client, code) {
      return codes.get(code)!.challenge;
    },
    async exchangeAuthorizationCode(client, code) {
      codes.delete(code);
      return issue(client.client_id);
    },
    async exchangeRefreshToken(client, token) {
      if (refresh.get(token) !== client.client_id) throw new Error('bad refresh token');
      stats.refreshes++;
      refresh.delete(token);
      return issue(client.client_id);
    },
    async verifyAccessToken(token) {
      if (!access.has(token)) throw new InvalidTokenError('expired or unknown token');
      return { token, clientId: 'x', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
  };

  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(base), resourceServerUrl: new URL(`${base}/mcp`) }));
  app.post(
    '/mcp',
    requireBearerAuth({ verifier: provider, resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp` }),
    express.json(),
    async (req: http.IncomingMessage & { body?: unknown }, res: http.ServerResponse) => {
      const mcp = new McpServer({ name: 'fake', version: '1.0.0' });
      mcp.registerTool('ping', { description: 'Answers pong' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close());
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  return {
    url: `${base}/mcp`,
    stats,
    /** Makes every access token the server issued so far stop working, as an expiry would. */
    expireAccessTokens: () => access.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function memoryStore(): OAuthStore & { text?: string } {
  const store: OAuthStore & { text?: string } = {
    load: async () => store.text,
    save: async (json) => void (store.text = json),
    clear: async () => void (store.text = undefined),
  };
  return store;
}

/** The user's browser: follows the authorization page, which redirects straight back to the loopback listener. */
async function browser(url: string): Promise<void> {
  const first = await fetch(url, { redirect: 'manual' });
  const back = first.headers.get('location');
  if (back) await fetch(back);
}

function config(url: string): McpServerConfig {
  return { id: 'atlassian', transport: 'http', url, args: [], env: {}, headers: {}, auth: { kind: 'oauth', name: '', format: '{key}' }, enabled: true };
}

let server: Awaited<ReturnType<typeof fakeServer>>;
beforeEach(async () => {
  server = await fakeServer();
});
afterEach(() => server.close());

function setup(openBrowser: (url: string) => Promise<void> = browser, signInTimeoutMs?: number) {
  const store = memoryStore();
  const opened: string[] = [];
  const host: OAuthHost = {
    store: () => store,
    openBrowser: async (url) => {
      opened.push(url);
      await openBrowser(url);
    },
  };
  const make = () => new McpClient(config(server.url), { oauth: host, signInTimeoutMs });
  return { store, opened, make };
}

describe('OAuth sign-in against a server', () => {
  it('reports "needs sign-in" without opening a browser', async () => {
    const { make, opened, store } = setup();
    const client = make();
    await client.start();
    expect(client.status).toBe('needs-auth');
    expect(client.error).toBeUndefined();
    expect(opened).toEqual([]);
    expect(server.stats.registrations).toBe(0);
    expect(store.text).toBeUndefined();
  });

  it('signs in through the browser, then lists the server tools', async () => {
    const { make, opened, store } = setup();
    const client = make();
    await client.start();
    await client.signIn();

    expect(client.status).toBe('ready');
    expect(client.tools.map((t) => t.name)).toEqual(['ping']);
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]).searchParams.get('code_challenge_method')).toBe('S256');
    expect(server.stats).toMatchObject({ registrations: 1, authorizations: 1 });
    expect(JSON.parse(store.text!)).toMatchObject({ tokens: { token_type: 'bearer' } });
    const result = await client.callTool('ping', {});
    expect(JSON.stringify(result.content)).toContain('pong');
    await client.close();
  });

  it('reconnects later with the saved sign-in and no browser', async () => {
    const { make, opened } = setup();
    const first = make();
    await first.signIn();
    await first.close();

    const second = make();
    await second.start();
    expect(second.status).toBe('ready');
    expect(opened).toHaveLength(1);
    expect(server.stats.authorizations).toBe(1);
    await second.close();
  });

  it('renews an expired access token with the refresh token, silently', async () => {
    const { make, opened } = setup();
    const first = make();
    await first.signIn();
    await first.close();

    server.expireAccessTokens();
    const second = make();
    await second.start();
    expect(second.status).toBe('ready');
    expect(server.stats.refreshes).toBe(1);
    expect(opened).toHaveLength(1);
    await second.close();
  });

  it('signs in again when the refresh token is no longer good', async () => {
    const { make, opened, store } = setup();
    const first = make();
    await first.signIn();
    await first.close();

    server.expireAccessTokens();
    // Break the saved refresh token.
    const saved = JSON.parse(store.text!);
    saved.tokens.refresh_token = 'rt-revoked';
    store.text = JSON.stringify(saved);

    const second = make();
    await second.start();
    expect(second.status).toBe('needs-auth');
    expect(opened).toHaveLength(1);
    await second.signIn();
    expect(second.status).toBe('ready');
    expect(opened).toHaveLength(2);
    await second.close();
  });

  it('does not send a signed-in server through the browser again when asked to sign in', async () => {
    const { make, opened } = setup();
    const client = make();
    await client.signIn();
    await client.signIn();
    expect(client.status).toBe('ready');
    expect(opened).toHaveLength(1);
    await client.close();
  });

  it('forgets the sign-in on sign out', async () => {
    const { make, store } = setup();
    const client = make();
    await client.signIn();
    await client.signOut();
    expect(store.text).toBeUndefined();
    expect(client.status).toBe('needs-auth');
    await client.start();
    expect(client.status).toBe('needs-auth');
  });

  it('fails with the reason when the user denies access', async () => {
    server.stats.deny = true;
    const { make, store } = setup();
    const client = make();
    await client.signIn();
    expect(client.status).toBe('failed');
    expect(client.error).toMatch(/sign-in failed.*The user denied access/);
    expect(store.text && JSON.parse(store.text).tokens).toBeUndefined();
  });

  it('gives up if the user never finishes', async () => {
    const { make } = setup(async () => undefined, 150);
    const client = make();
    await client.signIn();
    expect(client.status).toBe('failed');
    expect(client.error).toMatch(/Timed out/);
  });
});

describe('the loopback callback', () => {
  it('accepts only the state it was waiting for', async () => {
    const callback = await startOAuthCallback({ expectedState: () => 'good' });
    try {
      const wrong = await fetch(`${callback.redirectUrl}?code=stolen&state=bad`);
      expect(wrong.status).toBe(400);
      const none = await fetch(`${callback.redirectUrl}?code=stolen`);
      expect(none.status).toBe(400);
      const right = await fetch(`${callback.redirectUrl}?code=real&state=good`);
      expect(right.status).toBe(200);
      await expect(callback.code).resolves.toBe('real');
    } finally {
      callback.close();
    }
  });

  it('reports an error from the server', async () => {
    const callback = await startOAuthCallback({ expectedState: () => 's' });
    const outcome = expect(callback.code).rejects.toThrow('nope');
    await fetch(`${callback.redirectUrl}?error=access_denied&error_description=nope&state=s`);
    await outcome;
  });

  it('closes after the answer and times out otherwise', async () => {
    const callback = await startOAuthCallback({ expectedState: () => 's' });
    await fetch(`${callback.redirectUrl}?code=c&state=s`);
    await expect(fetch(`${callback.redirectUrl}?code=c&state=s`)).rejects.toThrow();

    const slow = await startOAuthCallback({ expectedState: () => 's', timeoutMs: 30 });
    await expect(slow.code).rejects.toThrow('Timed out');
  });

  it('refuses a request that is not addressed to localhost', async () => {
    const callback = await startOAuthCallback({ expectedState: () => 's' });
    try {
      const url = new URL(callback.redirectUrl);
      const status = await new Promise<number>((resolve, reject) => {
        http.get({ host: url.hostname, port: url.port, path: '/callback?code=c&state=s', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).on('error', reject);
      });
      expect(status).toBe(403);
    } finally {
      callback.close();
    }
  });
});

describe('McpOAuthProvider', () => {
  it('only opens a sign-in page that is https or on this machine', () => {
    expect(isSafeAuthorizationUrl(new URL('https://auth.atlassian.com/authorize'))).toBe(true);
    expect(isSafeAuthorizationUrl(new URL('http://127.0.0.1:9/authorize'))).toBe(true);
    expect(isSafeAuthorizationUrl(new URL('http://evil.example/authorize'))).toBe(false);
    expect(isSafeAuthorizationUrl(new URL('javascript:alert(1)'))).toBe(false);
    expect(isSafeAuthorizationUrl(new URL('file:///etc/passwd'))).toBe(false);
  });

  it('refuses to send the browser to an unsafe address', async () => {
    const opened: string[] = [];
    const provider = new McpOAuthProvider({ store: memoryStore(), interactive: { redirectUrl: 'http://127.0.0.1:1/callback', open: async (u) => void opened.push(u) } });
    await expect(provider.redirectToAuthorization(new URL('http://evil.example/authorize'))).rejects.toThrow(/not https/);
    expect(opened).toEqual([]);
  });

  it('never opens a browser or registers a client without the user asking', async () => {
    const provider = new McpOAuthProvider({ store: memoryStore() });
    await expect(provider.redirectToAuthorization(new URL('https://a.example/authorize'))).rejects.toBeInstanceOf(SignInRequired);
    await expect(provider.clientInformation()).rejects.toBeInstanceOf(SignInRequired);
  });

  it('drops a registration made for another loopback port before signing in again', async () => {
    const store = memoryStore();
    store.text = JSON.stringify({ clientInformation: { client_id: 'old', redirect_uris: ['http://127.0.0.1:1111/callback'] }, tokens: { access_token: 'a', token_type: 'bearer' } });
    const provider = new McpOAuthProvider({ store, interactive: { redirectUrl: 'http://127.0.0.1:2222/callback', open: async () => undefined } });
    await provider.prepareForSignIn();
    expect(await provider.clientInformation()).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
    expect(store.text).toBeUndefined();
  });

  it('keeps a registration that matches', async () => {
    const store = memoryStore();
    store.text = JSON.stringify({ clientInformation: { client_id: 'same', redirect_uris: ['http://127.0.0.1:2222/callback'] } });
    const provider = new McpOAuthProvider({ store, interactive: { redirectUrl: 'http://127.0.0.1:2222/callback', open: async () => undefined } });
    await provider.prepareForSignIn();
    expect(await provider.clientInformation()).toMatchObject({ client_id: 'same' });
  });

  it('asks for a fresh, unguessable state each time', () => {
    const provider = new McpOAuthProvider({ store: memoryStore() });
    const a = provider.state();
    const b = provider.state();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(provider.currentState).toBe(b);
  });
});
