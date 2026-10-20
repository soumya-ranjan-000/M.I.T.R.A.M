import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { renderVoicePage } from '../src/voice/voicePage';
import { startVoiceSession } from '../src/voice/voiceServer';
import { authHeaders, endpointProblem, transcribe, transcriptionUrl } from '../src/voice/transcribe';

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string; path?: string } = {}): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: target.hostname, port: target.port, path: init.path ?? `${target.pathname}${target.search}`, method: init.method ?? 'GET', headers: init.headers },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;
const origin = (url: string) => new URL(url).origin;
const wav = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)]);

describe('voice session server', () => {
  it('serves the listening page only with the token, and listens on loopback', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: 'en-US' });
    try {
      expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
      const ok = await request(session.url);
      expect(ok.status).toBe(200);
      expect(ok.body).toContain('window.__VOICE__');
      expect(ok.headers['content-security-policy']).toContain("default-src 'none'");
      expect(ok.headers['cache-control']).toBe('no-store');

      const bad = await request(`${origin(session.url)}/?t=wrong`);
      expect(bad.status).toBe(403);
      const none = await request(`${origin(session.url)}/`);
      expect(none.status).toBe(403);
    } finally {
      session.cancel();
    }
  });

  it('tells a window that loaded the page from one that never did', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '' });
    try {
      expect(await session.waitForPage(30)).toBe(false);
      await request(session.url);
      expect(await session.waitForPage(30)).toBe(true);
    } finally {
      session.cancel();
    }
  });

  it('does not count a request with the wrong token as the page loading', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '' });
    try {
      await request(`${origin(session.url)}/?t=wrong`);
      expect(await session.waitForPage(30)).toBe(false);
    } finally {
      session.cancel();
    }
  });

  it('refuses a request whose Host is not localhost (DNS rebinding)', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '' });
    try {
      const reply = await request(session.url, { headers: { host: 'evil.example:80' } });
      expect(reply.status).toBe(403);
    } finally {
      session.cancel();
    }
  });

  it('resolves with the text the page sends, then shuts down', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '' });
    const reply = await request(`${origin(session.url)}/result`, {
      method: 'POST',
      headers: { 'x-mitram-token': tokenOf(session.url), 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  fix the login bug  ' }),
    });
    expect(reply.status).toBe(200);
    await expect(session.result).resolves.toBe('fix the login bug');
    // The server is gone: the port no longer answers.
    await expect(request(session.url)).rejects.toThrow();
  });

  it('refuses a result without the token', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '' });
    try {
      const reply = await request(`${origin(session.url)}/result`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
      expect(reply.status).toBe(403);
    } finally {
      session.cancel();
    }
  });

  it('rejects an empty result', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '' });
    try {
      const reply = await request(`${origin(session.url)}/result`, {
        method: 'POST',
        headers: { 'x-mitram-token': tokenOf(session.url) },
        body: JSON.stringify({ text: '   ' }),
      });
      expect(reply.status).toBe(400);
    } finally {
      session.cancel();
    }
  });

  it('transcribes a recording and returns the text', async () => {
    const seen: number[] = [];
    const session = await startVoiceSession({
      mode: 'record',
      language: '',
      transcribe: async (audio) => {
        seen.push(audio.length);
        return ' add a unit test ';
      },
    });
    const reply = await request(`${origin(session.url)}/audio`, {
      method: 'POST',
      headers: { 'x-mitram-token': tokenOf(session.url), 'content-type': 'audio/wav' },
      body: wav(),
    });
    expect(JSON.parse(reply.body)).toEqual({ text: 'add a unit test' });
    expect(seen).toEqual([wav().length]);
    await expect(session.result).resolves.toBe('add a unit test');
  });

  it('refuses audio that is not a WAV file, without calling the transcriber', async () => {
    let called = false;
    const session = await startVoiceSession({ mode: 'record', language: '', transcribe: async () => ((called = true), 'x') });
    try {
      const reply = await request(`${origin(session.url)}/audio`, {
        method: 'POST',
        headers: { 'x-mitram-token': tokenOf(session.url) },
        body: Buffer.alloc(200, 1),
      });
      expect(reply.status).toBe(400);
      expect(called).toBe(false);
    } finally {
      session.cancel();
    }
  });

  it('reports a transcription failure to the page and to the caller', async () => {
    const session = await startVoiceSession({
      mode: 'record',
      language: '',
      transcribe: async () => {
        throw new Error('The transcription endpoint answered 401.');
      },
    });
    const outcome = expect(session.result).rejects.toThrow('answered 401');
    const reply = await request(`${origin(session.url)}/audio`, {
      method: 'POST',
      headers: { 'x-mitram-token': tokenOf(session.url) },
      body: wav(),
    });
    expect(reply.status).toBe(502);
    await outcome;
  });

  it('turns the page reporting an error into a rejection', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '' });
    const outcome = expect(session.result).rejects.toThrow('The browser blocked the microphone');
    await request(`${origin(session.url)}/error`, {
      method: 'POST',
      headers: { 'x-mitram-token': tokenOf(session.url) },
      body: JSON.stringify({ message: 'The browser blocked the microphone.' }),
    });
    await outcome;
  });

  it('cancel rejects with "Cancelled" and closes the port', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '' });
    const outcome = expect(session.result).rejects.toThrow('Cancelled');
    session.cancel();
    await outcome;
    await expect(request(session.url)).rejects.toThrow();
  });

  it('gives up if nobody speaks', async () => {
    const session = await startVoiceSession({ mode: 'browser', language: '', timeoutMs: 50 });
    await expect(session.result).rejects.toThrow('Timed out');
  });
});

describe('renderVoicePage', () => {
  it('encodes its settings so a value cannot break out of the script', () => {
    const html = renderVoicePage({ token: 't', nonce: 'n', mode: 'browser', language: '</script><script>alert(1)</script>', canRecord: false, maxSeconds: 60 });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });
});

describe('transcription endpoint', () => {
  it('accepts https and this machine, and nothing else', () => {
    expect(endpointProblem('https://api.openai.com/v1')).toBeNull();
    expect(endpointProblem('http://localhost:8000/v1')).toBeNull();
    expect(endpointProblem('http://127.0.0.1:9000')).toBeNull();
    expect(endpointProblem('http://example.com/v1')).toMatch(/https/);
    expect(endpointProblem('')).toMatch(/No transcription endpoint/);
    expect(endpointProblem('nope')).toMatch(/not a valid URL/);
  });

  it('adds the transcription path to a base URL only', () => {
    expect(transcriptionUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(transcriptionUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(transcriptionUrl('https://api.openai.com/v1/audio/transcriptions')).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(transcriptionUrl('https://x.openai.azure.com/openai/deployments/w/audio/transcriptions?api-version=2024-06-01')).toBe(
      'https://x.openai.azure.com/openai/deployments/w/audio/transcriptions?api-version=2024-06-01',
    );
  });

  it('sends the key the way each provider expects', () => {
    expect(authHeaders('https://api.openai.com/v1', 'k')).toEqual({ authorization: 'Bearer k' });
    expect(authHeaders('https://res.openai.azure.com/openai', 'k')).toEqual({ 'api-key': 'k' });
    expect(authHeaders('http://localhost:8000', undefined)).toEqual({});
  });

  it('posts the audio as multipart and returns the text', async () => {
    let seen: { url: string; headers: Record<string, string>; form: FormData } | undefined;
    const text = await transcribe(
      Buffer.from('RIFFxxxxWAVE'),
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'whisper-1', language: 'en' },
      undefined,
      async (url, init) => {
        seen = { url, headers: init.headers, form: init.body };
        return { ok: true, status: 200, text: async () => JSON.stringify({ text: ' hello there ' }) };
      },
    );
    expect(text).toBe('hello there');
    expect(seen!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(seen!.headers).toEqual({ authorization: 'Bearer sk-test' });
    expect(seen!.form.get('model')).toBe('whisper-1');
    expect(seen!.form.get('language')).toBe('en');
    expect((seen!.form.get('file') as File).name).toBe('speech.wav');
  });

  it('explains a rejected key without echoing the response body', async () => {
    const run = transcribe(Buffer.from('x'), { endpoint: 'https://api.openai.com/v1', apiKey: 'bad', model: 'm', language: '' }, undefined, async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
    }));
    await expect(run).rejects.toThrow(/401: Incorrect API key provided.*Set Voice API Key/);
  });

  it('refuses an endpoint that would send a key in the clear', async () => {
    await expect(transcribe(Buffer.from('x'), { endpoint: 'http://example.com/v1', apiKey: 'k', model: 'm', language: '' })).rejects.toThrow(/https/);
  });
});
