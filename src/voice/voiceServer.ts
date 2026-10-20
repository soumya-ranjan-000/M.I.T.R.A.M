import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VoiceMode, renderVoicePage } from './voicePage';

/** Largest recording accepted: about 8 minutes of 16 kHz mono 16-bit audio. */
export const MAX_AUDIO_BYTES = 16_000_000;
/** The page stops listening by itself after this long; the server waits a little longer than that. */
export const MAX_LISTEN_SECONDS = 120;
const GRACE_MS = 30_000;
const MAX_JSON_BYTES = 64_000;

export interface VoiceServerOptions {
  mode: VoiceMode;
  language: string;
  /** Turns a WAV recording into text. Absent when no transcription endpoint is configured. */
  transcribe?: (wav: Buffer, signal: AbortSignal) => Promise<string>;
  /** Replaces the listening time limit shown to the page, for tests. */
  maxSeconds?: number;
  /** Replaces how long the server waits for any answer before giving up, for tests. */
  timeoutMs?: number;
}

/** One dictation: where to send the user and what they said. */
export interface VoiceSession {
  /** Open this in a browser. It only works on this machine. */
  url: string;
  /** Resolves with the text. Rejects with a message fit to show the user if listening failed or was cancelled. */
  result: Promise<string>;
  /** True once the page has been fetched, false if that does not happen within `ms`. Tells a window that opened from one that crashed. */
  waitForPage(ms: number): Promise<boolean>;
  /** Stop listening and close the server. Safe to call at any time. */
  cancel(): void;
}

export class VoiceError extends Error {
  override name = 'VoiceError';
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new VoiceError('The recording is too long.'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/**
 * Serves the listening page for one dictation, on 127.0.0.1 only, and closes when it has an answer.
 *
 * Anything else on the machine can connect to a localhost port, and so can a web page the user has
 * open (through DNS rebinding), so the page and every request need a random token, requests must
 * carry a localhost Host header, and the server lives only as long as one dictation.
 */
export async function startVoiceSession(options: VoiceServerOptions): Promise<VoiceSession> {
  const token = randomBytes(24).toString('base64url');
  const nonce = randomBytes(16).toString('base64');
  const maxSeconds = options.maxSeconds ?? MAX_LISTEN_SECONDS;
  const abort = new AbortController();

  let settle!: { resolve: (text: string) => void; reject: (error: VoiceError) => void };
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller reads `result`, but a cancel with nobody waiting must not be an unhandled rejection.
  result.catch(() => undefined);

  let pageLoaded!: () => void;
  const loaded = new Promise<true>((resolve) => {
    pageLoaded = () => resolve(true);
  });

  let port = 0;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  const server = http.createServer((req, res) => void handle(req, res));

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    abort.abort();
    server.close();
    server.closeAllConnections();
  }

  function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json'): void {
    res.writeHead(status, {
      'content-type': `${type}; charset=utf-8`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Only the hostname is checked: a forwarded port (Remote SSH, WSL) arrives on a different one.
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'Forbidden' });
      const url = new URL(req.url ?? '/', `http://${host}`);

      if (req.method === 'GET' && url.pathname === '/') {
        if (!sameSecret(url.searchParams.get('t') ?? '', token)) return send(res, 403, { error: 'Forbidden' });
        pageLoaded();
        res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`);
        return send(
          res,
          200,
          renderVoicePage({ token, nonce, mode: options.mode, language: options.language, canRecord: !!options.transcribe, maxSeconds }),
          'text/html',
        );
      }

      if (req.method !== 'POST' || !sameSecret(String(req.headers['x-mitram-token'] ?? ''), token)) {
        return send(res, 403, { error: 'Forbidden' });
      }

      if (url.pathname === '/result') {
        const { text } = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8')) as { text?: unknown };
        const clean = typeof text === 'string' ? text.trim() : '';
        if (!clean) return send(res, 400, { error: 'No speech was heard.' });
        send(res, 200, { text: clean });
        settle.resolve(clean);
        close();
        return;
      }

      if (url.pathname === '/audio') {
        if (!options.transcribe) return send(res, 400, { error: 'No transcription endpoint is configured.' });
        const wav = await readBody(req, MAX_AUDIO_BYTES);
        // "RIFF....WAVE": refuse anything that is not what the page sends.
        if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
          return send(res, 400, { error: 'That was not a recording.' });
        }
        let text: string;
        try {
          text = (await options.transcribe(wav, abort.signal)).trim();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Transcription failed.';
          send(res, 502, { error: message });
          settle.reject(new VoiceError(message));
          close();
          return;
        }
        if (!text) {
          send(res, 200, { error: 'No speech was recognised.' });
          settle.reject(new VoiceError('No speech was recognised.'));
        } else {
          send(res, 200, { text });
          settle.resolve(text);
        }
        close();
        return;
      }

      if (url.pathname === '/error') {
        const { message } = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8')) as { message?: unknown };
        send(res, 200, {});
        settle.reject(new VoiceError(typeof message === 'string' && message ? message.slice(0, 300) : 'Voice input failed.'));
        close();
        return;
      }

      send(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof VoiceError ? 413 : 400, { error: 'Bad request' });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  timer = setTimeout(() => {
    settle.reject(new VoiceError('Timed out waiting for you to speak.'));
    close();
  }, options.timeoutMs ?? maxSeconds * 1000 + GRACE_MS);

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    result,
    waitForPage: (ms) =>
      Promise.race([
        loaded,
        new Promise<false>((resolve) => {
          const t = setTimeout(() => resolve(false), ms);
          t.unref();
        }),
      ]),
    cancel: () => {
      settle.reject(new VoiceError('Cancelled'));
      close();
    },
  };
}
