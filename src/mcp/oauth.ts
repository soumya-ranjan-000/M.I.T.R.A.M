// OAuth 2.1 sign-in for remote MCP servers (Atlassian's, for one): authorization code with PKCE and
// dynamic client registration, so no client id or secret ships with this extension. The protocol
// itself is the SDK's; this file supplies what it asks the host for: where credentials are kept, a
// way to reach the user's browser, and a loopback address for the redirect. No vscode import, so
// tests can drive a whole sign-in against a fake server.

import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/** Where one server's credentials are kept. The host backs it with VS Code's secret storage. */
export interface OAuthStore {
  load(): Promise<string | undefined>;
  save(json: string): Promise<void>;
  clear(): Promise<void>;
}

/** What the host gives the client for OAuth. */
export interface OAuthHost {
  store(serverId: string): OAuthStore;
  /** Opens the authorization page in the user's browser. */
  openBrowser(url: string): Promise<void>;
  /** Turns the loopback redirect into one the user's browser can reach (a forwarded port in a remote window). */
  externalRedirect?(url: string): Promise<string>;
}

interface Persisted {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** The server needs the user to sign in, and this connection is not allowed to open a browser by itself. */
export class SignInRequired extends Error {
  override name = 'SignInRequired';
  constructor() {
    super('sign-in needed');
  }
}

export class OAuthCallbackError extends Error {
  override name = 'OAuthCallbackError';
}

/** Redirect URI the page may send the user to: https, or this machine. */
export function isSafeAuthorizationUrl(url: URL): boolean {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return url.protocol === 'https:' || (url.protocol === 'http:' && local);
}

export interface ProviderOptions {
  store: OAuthStore;
  /**
   * Set for a sign-in the user asked for: the loopback redirect and how to open the browser. Without
   * it the provider only uses credentials it already has, and reports {@link SignInRequired} the
   * moment it would need the user, so connecting never opens a browser unprompted.
   */
  interactive?: { redirectUrl: string; open: (url: string) => Promise<void> };
}

export class McpOAuthProvider implements OAuthClientProvider {
  private data?: Persisted;
  private expectedState?: string;

  constructor(private readonly options: ProviderOptions) {}

  /** The `state` sent with the current authorization request, which the redirect must return. */
  get currentState(): string | undefined {
    return this.expectedState;
  }

  private async read(): Promise<Persisted> {
    if (!this.data) {
      try {
        const text = await this.options.store.load();
        this.data = text ? (JSON.parse(text) as Persisted) : {};
      } catch {
        this.data = {};
      }
    }
    return this.data;
  }

  private async write(change: Persisted): Promise<void> {
    this.data = { ...(await this.read()), ...change };
    await this.options.store.save(JSON.stringify(this.data));
  }

  /** Whether sign-in has produced tokens. */
  async hasTokens(): Promise<boolean> {
    return !!(await this.read()).tokens;
  }

  /**
   * Called before a sign-in the user asked for. A client registered for another redirect address
   * (the loopback port changes between runs) cannot be used with this one, and the tokens that
   * belong to it are already known to be unusable, so both are dropped and registered afresh.
   */
  async prepareForSignIn(): Promise<void> {
    const info = (await this.read()).clientInformation as { redirect_uris?: string[] } | undefined;
    const wanted = this.options.interactive?.redirectUrl;
    if (info && wanted && !info.redirect_uris?.includes(wanted)) {
      this.data = {};
      await this.options.store.clear();
    }
  }

  /**
   * The SDK treats a provider with no redirect address as a machine-to-machine client and skips the
   * refresh-token path, so a connection that may not open a browser still needs one. It is never
   * registered or visited: {@link clientInformation} and {@link redirectToAuthorization} stop first.
   */
  get redirectUrl(): string {
    return this.options.interactive?.redirectUrl ?? 'http://127.0.0.1/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'M.I.T.R.A.M',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A desktop app cannot keep a secret; PKCE protects the code instead.
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    this.expectedState = randomBytes(24).toString('base64url');
    return this.expectedState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = (await this.read()).clientInformation;
    // Registering is a request to the server for a client, which is only worth doing for a sign-in
    // the user asked for.
    if (!stored && !this.options.interactive) throw new SignInRequired();
    return stored;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.write({ clientInformation: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write({ tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.options.interactive) throw new SignInRequired();
    // The address comes from the server's metadata, so it is checked before a browser is sent there.
    if (!isSafeAuthorizationUrl(url)) throw new Error('The server asked for a sign-in page that is not https.');
    await this.options.interactive.open(url.toString());
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.write({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.read()).codeVerifier;
    if (!verifier) throw new Error('No code verifier saved; start the sign-in again.');
    return verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const data = { ...(await this.read()) };
    if (scope === 'all' || scope === 'client') delete data.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete data.tokens;
    if (scope === 'all' || scope === 'verifier') delete data.codeVerifier;
    this.data = data;
    if (Object.keys(data).length) await this.options.store.save(JSON.stringify(data));
    else await this.options.store.clear();
  }
}

export interface Callback {
  /** Where the browser is sent back to, e.g. `http://127.0.0.1:41234/callback`. */
  redirectUrl: string;
  /** Resolves with the authorization code. Rejects if the server reported an error or time ran out. */
  code: Promise<string>;
  /** Stop listening. Safe to call at any time. */
  close(): void;
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>M.I.T.R.A.M</title>` +
  `<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0"><main style="text-align:center;max-width:26em;padding:1em">` +
  `<h1 style="font-size:1.2em">${title}</h1><p style="color:#666">${text}</p></main></body>`;

/**
 * Listens on loopback for the one redirect that ends a sign-in. Only the right `state` is accepted,
 * a request with another is answered and ignored, and the server closes after the first valid answer.
 */
export async function startOAuthCallback(options: { expectedState: () => string | undefined; timeoutMs?: number }): Promise<Callback> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  code.catch(() => undefined);

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const expected = options.expectedState();
    const send = (status: number, title: string, text: string) =>
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(PAGE(title, text));

    if (!expected || url.searchParams.get('state') !== expected) {
      send(400, 'Sign-in did not match', 'This page was not opened by the sign-in M.I.T.R.A.M started. Go back to VS Code and try again.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      send(200, 'Sign-in was not completed', 'You can close this tab and return to VS Code.');
      settle.reject(new OAuthCallbackError(url.searchParams.get('error_description') || error));
      close();
      return;
    }
    const authCode = url.searchParams.get('code');
    if (!authCode) {
      send(400, 'Sign-in failed', 'The server did not send a code. Go back to VS Code and try again.');
      return;
    }
    send(200, 'Signed in', 'You can close this tab and return to VS Code.');
    settle.resolve(authCode);
    close();
  });

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  timer = setTimeout(() => {
    settle.reject(new OAuthCallbackError('Timed out waiting for you to sign in.'));
    close();
  }, options.timeoutMs ?? 5 * 60_000);

  return { redirectUrl: `http://127.0.0.1:${port}/callback`, code, close };
}
