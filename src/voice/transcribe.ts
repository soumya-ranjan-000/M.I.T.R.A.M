// Speech to text through any OpenAI-compatible `/audio/transcriptions` endpoint: OpenAI, Azure OpenAI,
// Groq, or a local server such as faster-whisper-server. Pure apart from `fetch`, which is injectable.

export interface TranscribeOptions {
  /** A full transcription URL, or a base URL such as https://api.openai.com/v1. */
  endpoint: string;
  apiKey?: string;
  model: string;
  /** Language hint such as `en`, or ''. */
  language: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: FormData; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Why an endpoint setting cannot be used, or null. Keys are never sent over plain http except to this machine. */
export function endpointProblem(endpoint: string): string | null {
  if (!endpoint.trim()) return 'No transcription endpoint is set (mitram.voice.endpoint).';
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return 'mitram.voice.endpoint is not a valid URL.';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return url.protocol === 'https:' || local ? null : 'mitram.voice.endpoint must use https, unless it points at this machine.';
}

/** The URL to post to: a base URL gets `/audio/transcriptions` added. */
export function transcriptionUrl(endpoint: string): string {
  const url = new URL(endpoint.trim());
  if (!/\/transcriptions\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/+$/, '')}/audio/transcriptions`;
  return url.toString();
}

/** Azure OpenAI takes the key in `api-key`; everyone else expects a Bearer token. */
export function authHeaders(endpoint: string, apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {};
  const host = new URL(endpoint.trim()).hostname;
  return /\.(openai\.azure\.com|cognitiveservices\.azure\.com)$/.test(host) ? { 'api-key': apiKey } : { authorization: `Bearer ${apiKey}` };
}

/** Sends a WAV recording and returns the text. Throws an Error whose message is safe to show the user. */
export async function transcribe(wav: Buffer, options: TranscribeOptions, signal?: AbortSignal, doFetch: FetchLike = fetch as unknown as FetchLike): Promise<string> {
  const problem = endpointProblem(options.endpoint);
  if (problem) throw new Error(problem);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', options.model);
  form.append('response_format', 'json');
  if (options.language) form.append('language', options.language);

  let response;
  try {
    response = await doFetch(transcriptionUrl(options.endpoint), {
      method: 'POST',
      headers: authHeaders(options.endpoint, options.apiKey),
      body: form,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('Cancelled');
    throw new Error(`Could not reach the transcription endpoint (${(error as Error).message}).`);
  }

  const body = await response.text();
  if (!response.ok) {
    // The body may echo request details, so only the status and a short provider message are shown.
    let detail = '';
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string };
      detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? '');
    } catch {
      // Not JSON: leave the detail out.
    }
    const hint = response.status === 401 || response.status === 403 ? ' Check the voice API key (command "M.I.T.R.A.M: Set Voice API Key").' : '';
    throw new Error(`The transcription endpoint answered ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}.${hint}`);
  }
  try {
    const { text } = JSON.parse(body) as { text?: unknown };
    return typeof text === 'string' ? text.trim() : '';
  } catch {
    // Some servers answer with the bare text.
    return body.trim();
  }
}
