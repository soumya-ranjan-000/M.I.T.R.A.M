// The page that listens. VS Code webviews cannot use the microphone, so voice input runs in the
// user's own browser, on a localhost page served for one dictation. Pure: a string in, a string out.

export type VoiceMode = 'browser' | 'record';

export interface VoicePageOptions {
  /** One-time secret the page sends back with every request. */
  token: string;
  /** `browser`: the browser's own speech recognition. `record`: capture audio for the transcription endpoint. */
  mode: VoiceMode;
  /** BCP 47 tag such as `en-US`, or '' for the browser's language. */
  language: string;
  /** A transcription endpoint is configured, so a browser with no speech recognition can still record. */
  canRecord: boolean;
  /** Stop listening after this long. */
  maxSeconds: number;
  nonce: string;
}

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --accent: #0969da; --rec: #cf222e; --card: #f6f8fa; --line: #d0d7de; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --accent: #4493f8; --rec: #f85149; --card: #161b22; --line: #30363d; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
main { width: min(520px, 92vw); text-align: center; padding: 24px 0; }
h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 4px; letter-spacing: 0.02em; }
p.sub { margin: 0 0 24px; color: var(--muted); font-size: 0.9rem; }
.mic { position: relative; width: 96px; height: 96px; margin: 0 auto 20px; border-radius: 50%; background: var(--card); border: 2px solid var(--line); display: grid; place-items: center; }
.mic svg { width: 40px; height: 40px; stroke: var(--muted); fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.mic::after { content: ''; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid var(--rec); opacity: 0; transform: scale(var(--level, 1)); transition: transform 0.08s linear, opacity 0.2s; }
body[data-state='listening'] .mic { border-color: var(--rec); }
body[data-state='listening'] .mic svg { stroke: var(--rec); }
body[data-state='listening'] .mic::after { opacity: 0.45; }
body[data-state='done'] .mic { border-color: #1a7f37; }
body[data-state='done'] .mic svg { stroke: #1a7f37; }
body[data-state='error'] .mic { border-color: var(--rec); }
#status { font-weight: 600; min-height: 1.5em; margin-bottom: 12px; }
#transcript { min-height: 5.5em; max-height: 40vh; overflow: auto; text-align: left; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: 18px; }
#transcript:empty::before { content: 'Your words appear here as you speak.'; color: var(--muted); }
#transcript .interim { color: var(--muted); }
.actions { display: flex; gap: 10px; justify-content: center; }
button { font: inherit; padding: 8px 18px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: 0.5; cursor: default; }
small { display: block; margin-top: 18px; color: var(--muted); font-size: 0.8rem; }
`;

// Plain ES2017 with no dependencies: it runs unchanged in every current browser.
const SCRIPT = `
(function () {
  var cfg = window.__VOICE__;
  var body = document.body;
  var statusEl = document.getElementById('status');
  var transcriptEl = document.getElementById('transcript');
  var stopBtn = document.getElementById('stop');
  var cancelBtn = document.getElementById('cancel');
  var hintEl = document.getElementById('hint');
  var finished = false;
  var stopFn = null;

  function setState(state, text) { body.setAttribute('data-state', state); statusEl.textContent = text; }

  function post(path, init) {
    init = init || {};
    init.method = 'POST';
    init.headers = Object.assign({ 'x-mitram-token': cfg.token }, init.headers || {});
    return fetch(path, init);
  }

  function finish(kind, payload) {
    if (finished) return;
    finished = true;
    stopBtn.disabled = true;
    var request;
    if (kind === 'text') request = post('/result', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: payload }) });
    else if (kind === 'audio') request = post('/audio', { headers: { 'content-type': 'audio/wav' }, body: payload });
    else request = post('/error', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: payload }) });
    request.then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (answer) {
      if (kind === 'error' || answer.error) { setState('error', answer.error || payload); hintEl.textContent = 'Go back to VS Code and try again.'; }
      else { transcriptEl.textContent = answer.text || (kind === 'text' ? payload : ''); setState('done', 'Sent to VS Code'); hintEl.textContent = 'You can close this tab.'; try { window.close(); } catch (e) {} }
      cancelBtn.hidden = true; stopBtn.hidden = true;
    }).catch(function () { setState('error', 'Could not reach VS Code'); hintEl.textContent = 'VS Code may have stopped listening. Go back and try again.'; });
  }

  function fail(message) { if (!finished) finish('error', message); }

  cancelBtn.onclick = function () { finish('error', 'Cancelled'); if (stopFn) stopFn(true); };
  stopBtn.onclick = function () { if (stopFn) stopFn(false); };

  // ---- Mode 1: the browser's own speech recognition ----
  function startRecognition(SR) {
    var recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    if (cfg.language) recognition.lang = cfg.language;
    var finals = '';
    var lastHeard = Date.now();
    var ended = false;
    var cancelled = false;
    var silenceTimer = setInterval(function () {
      // A pause of a few seconds after speech means the person has finished.
      if (finals && Date.now() - lastHeard > 2800) recognition.stop();
    }, 400);
    var limit = setTimeout(function () { recognition.stop(); }, cfg.maxSeconds * 1000);

    recognition.onstart = function () { setState('listening', 'Listening… speak now'); };
    recognition.onresult = function (event) {
      lastHeard = Date.now();
      var interim = '';
      finals = '';
      for (var i = 0; i < event.results.length; i++) {
        var r = event.results[i];
        if (r.isFinal) finals += r[0].transcript; else interim += r[0].transcript;
      }
      transcriptEl.textContent = '';
      transcriptEl.appendChild(document.createTextNode(finals));
      var span = document.createElement('span'); span.className = 'interim'; span.textContent = interim; transcriptEl.appendChild(span);
    };
    recognition.onerror = function (event) {
      var messages = {
        'not-allowed': 'The browser blocked the microphone. Allow it for this page (the icon in the address bar) and try again.',
        'service-not-allowed': 'The browser does not allow speech recognition here.',
        'no-speech': 'No speech was heard. Check your microphone and try again.',
        'audio-capture': 'No microphone was found.',
        'network': 'Speech recognition needs an internet connection in this browser.'
      };
      if (event.error === 'aborted') return;
      ended = true;
      fail(messages[event.error] || ('Speech recognition failed: ' + event.error));
    };
    recognition.onend = function () {
      clearInterval(silenceTimer); clearTimeout(limit);
      if (ended || cancelled) return;
      ended = true;
      var text = (finals || transcriptEl.textContent || '').trim();
      if (text) finish('text', text); else fail('No speech was heard. Check your microphone and try again.');
    };
    stopFn = function (cancel) { cancelled = !!cancel; try { recognition.stop(); } catch (e) {} };
    try { recognition.start(); } catch (e) { fail('Could not start speech recognition: ' + e.message); }
  }

  // ---- Mode 2: record audio and let VS Code transcribe it ----
  function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { fail('This browser cannot use the microphone on this page.'); return; }
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      var ctx = new AudioCtx();
      var source = ctx.createMediaStreamSource(stream);
      var processor = ctx.createScriptProcessor(4096, 1, 1);
      var chunks = [];
      var spoke = false;
      var quietSince = Date.now();
      var done = false;
      var micEl = document.querySelector('.mic');
      var limit = setTimeout(function () { stop(false); }, cfg.maxSeconds * 1000);

      processor.onaudioprocess = function (e) {
        if (done) return;
        var data = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        var sum = 0; for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
        var rms = Math.sqrt(sum / data.length);
        micEl.style.setProperty('--level', String(1 + Math.min(rms * 6, 0.5)));
        if (rms > 0.02) { spoke = true; quietSince = Date.now(); }
        else if (spoke && Date.now() - quietSince > 2200) stop(false);
      };
      source.connect(processor); processor.connect(ctx.destination);
      setState('listening', 'Listening… speak now');
      transcriptEl.textContent = '';

      function release() {
        stream.getTracks().forEach(function (t) { t.stop(); });
        try { processor.disconnect(); source.disconnect(); } catch (e) {}
        ctx.close();
      }
      function stop(cancel) {
        if (done) return;
        done = true; clearTimeout(limit);
        var rate = ctx.sampleRate;
        release();
        if (cancel) return;
        if (!spoke) { fail('No speech was heard. Check your microphone and try again.'); return; }
        setState('working', 'Transcribing…');
        finish('audio', encodeWav(chunks, rate, 16000));
      }
      stopFn = stop;
    }).catch(function (err) {
      fail(err && err.name === 'NotAllowedError'
        ? 'The browser blocked the microphone. Allow it for this page (the icon in the address bar) and try again.'
        : err && err.name === 'NotFoundError' ? 'No microphone was found.' : 'Could not open the microphone: ' + (err && err.message));
    });
  }

  function encodeWav(chunks, fromRate, toRate) {
    var length = 0; chunks.forEach(function (c) { length += c.length; });
    var merged = new Float32Array(length); var offset = 0;
    chunks.forEach(function (c) { merged.set(c, offset); offset += c.length; });
    var ratio = fromRate / toRate;
    var outLength = Math.floor(merged.length / ratio);
    var buffer = new ArrayBuffer(44 + outLength * 2);
    var view = new DataView(buffer);
    function str(at, s) { for (var i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); view.setUint32(4, 36 + outLength * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, toRate, true); view.setUint32(28, toRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, outLength * 2, true);
    for (var i = 0; i < outLength; i++) {
      // Average the source samples that fall in this output sample, which also low-passes.
      var start = Math.floor(i * ratio); var end = Math.min(merged.length, Math.floor((i + 1) * ratio)) || start + 1;
      var acc = 0; for (var j = start; j < end; j++) acc += merged[j];
      var s = Math.max(-1, Math.min(1, acc / Math.max(1, end - start)));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (cfg.mode === 'browser' && SR) startRecognition(SR);
  else if (cfg.mode === 'record' || cfg.canRecord) startRecording();
  else fail('This browser has no speech recognition. Use Chrome, Edge or Safari, or set mitram.voice.provider to "endpoint".');
})();
`;

const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

/** The HTML of the listening page. Every dynamic value is JSON-encoded into one script block, never into markup. */
export function renderVoicePage(options: VoicePageOptions): string {
  const config = JSON.stringify({
    token: options.token,
    mode: options.mode,
    language: options.language,
    canRecord: options.canRecord,
    maxSeconds: options.maxSeconds,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>M.I.T.R.A.M voice</title>
<style nonce="${options.nonce}">${STYLE}</style>
</head>
<body data-state="starting">
<main>
  <h1>M.I.T.R.A.M voice prompt</h1>
  <p class="sub">Speak your request. It goes straight to the chat in VS Code.</p>
  <div class="mic">${MIC}</div>
  <div id="status" role="status" aria-live="polite">Starting the microphone…</div>
  <div id="transcript" aria-live="polite"></div>
  <div class="actions">
    <button id="cancel" type="button">Cancel</button>
    <button id="stop" type="button" class="primary">Done</button>
  </div>
  <small id="hint">Allow the microphone if your browser asks.</small>
</main>
<script nonce="${options.nonce}">window.__VOICE__ = ${config};</script>
<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;
}
