import type { HostToWebview, WebviewToHost } from '../../src/webview/protocol';

interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function postToHost(message: WebviewToHost): void {
  api.postMessage(message);
}

export function onHostMessage(handler: (message: HostToWebview) => void): () => void {
  const listener = (event: MessageEvent<HostToWebview>) => handler(event.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
