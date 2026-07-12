/**
 * Voice-activated speech recognition (Android-friendly).
 *
 * Chrome on Android BEEPS every time SpeechRecognition.start() runs.
 * So we keep one quiet getUserMedia stream open for voice detection,
 * and only start SpeechRecognition when someone is actually talking.
 * Silence → no restarts → no beep loop.
 */

let gen = 0;
let activeRec = null; // { rec, stop }
let media = null; // { stream, ctx, analyser }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechSupported() {
  return !!getSR() && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function clearHandlers(rec) {
  if (!rec) return;
  rec.onstart = null;
  rec.onresult = null;
  rec.onspeechstart = null;
  rec.onspeechend = null;
  rec.onnomatch = null;
  rec.onerror = null;
  rec.onend = null;
}

function stopRecognitionOnly() {
  const cur = activeRec;
  activeRec = null;
  if (!cur) return;
  clearHandlers(cur.rec);
  try { cur.rec.stop(); } catch {
    try { cur.rec.abort(); } catch {}
  }
}

function teardownMedia() {
  if (!media) return;
  try { media.analyser?.disconnect(); } catch {}
  try { media.source?.disconnect(); } catch {}
  try { media.ctx?.close(); } catch {}
  try {
    media.stream?.getTracks?.().forEach((t) => t.stop());
  } catch {}
  media = null;
}

/** Soft restart — drop current recognition so the next speech uses a new language. */
export function restartMic() {
  stopRecognitionOnly();
}

/** Hard stop — ends keepListening and releases the mic. */
export async function stopMic() {
  gen += 1;
  stopRecognitionOnly();
  teardownMedia();
  await sleep(150);
}

function voiceLevel(analyser, buffer) {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const v = (buffer[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buffer.length);
}

async function ensureMedia() {
  if (media?.analyser) return media;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);

  media = { stream, ctx, source, analyser };
  return media;
}

function startRecognition({
  lang, myGen, activeRef, onInterim, onFinal, onError, onPhase, state,
}) {
  if (activeRec) return;
  const SR = getSR();
  if (!SR) return;

  let rec;
  try {
    rec = new SR();
  } catch {
    return;
  }

  rec.lang = lang || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  const session = { rec };
  activeRec = session;
  onPhase?.('hearing');

  rec.onresult = (event) => {
    if (myGen !== gen || !activeRef.current) return;

    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = (result[0]?.transcript || '').trim();
      if (!text) continue;
      if (result.isFinal) {
        Promise.resolve(onFinal?.(text)).catch(() => {});
      } else {
        interim = text;
      }
    }
    if (interim) onInterim?.(interim);
    else if (event.results[event.results.length - 1]?.isFinal) onInterim?.('');
  };

  rec.onerror = (event) => {
    const err = event?.error || '';
    if (err === 'no-speech' || err === 'aborted' || err === 'speech-timeout') return;
    if (err === 'not-allowed') {
      onError?.('Microphone access denied — allow it in browser settings.');
      activeRef.current = false;
      return;
    }
    if (err === 'audio-capture') {
      onError?.('No microphone found.');
      activeRef.current = false;
    }
  };

  rec.onend = () => {
    if (activeRec === session) activeRec = null;
    clearHandlers(rec);
    // Require a beat of quiet / fresh speech before the next start (kills beep loops)
    state.cooldownUntil = Date.now() + 700;
    state.voicedFor = 0;
    onPhase?.('idle');
  };

  try {
    rec.start();
  } catch {
    if (activeRec === session) activeRec = null;
    state.cooldownUntil = Date.now() + 700;
    onPhase?.('idle');
  }
}

/**
 * Always-on listen until Stop.
 * Mic stream stays open quietly; SpeechRecognition only runs while talking
 * so Android doesn't beep on/off forever.
 */
export async function keepListening({
  activeRef,
  getLang,
  onInterim,
  onFinal,
  onError,
  onPhase,
}) {
  if (!speechSupported()) {
    onError?.('Use Chrome or Edge for speech recognition.');
    return;
  }

  const myGen = ++gen;

  try {
    await ensureMedia();
  } catch {
    onError?.('Microphone access denied — allow it in browser settings.');
    activeRef.current = false;
    return;
  }

  onPhase?.('idle');

  const analyser = media.analyser;
  const buffer = new Uint8Array(analyser.fftSize);

  // Tuned for phone mics in a normal room
  const THRESHOLD = 0.04;
  const SPEAK_MS = 200; // voice must be present this long before starting SR
  const POLL_MS = 80;
  const state = { cooldownUntil: 0, voicedFor: 0 };

  while (activeRef.current && myGen === gen) {
    if (media?.ctx?.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }

    const level = voiceLevel(analyser, buffer);
    const speaking = level >= THRESHOLD;

    if (speaking) state.voicedFor += POLL_MS;
    else state.voicedFor = 0;

    const lang = (typeof getLang === 'function' ? getLang() : getLang) || 'en-US';
    const canStart = !activeRec
      && Date.now() >= state.cooldownUntil
      && state.voicedFor >= SPEAK_MS;

    if (canStart) {
      startRecognition({
        lang,
        myGen,
        activeRef,
        onInterim,
        onFinal,
        onError,
        onPhase,
        state,
      });
      state.voicedFor = 0;
    }

    await sleep(POLL_MS);
  }

  if (myGen === gen) {
    stopRecognitionOnly();
    teardownMedia();
  }
}

export const listenLoop = keepListening;

/** Rare one-shot (not used for main Listen/Talk loops). */
export async function listenOnce({ lang, onInterim, timeoutMs = 12000 } = {}) {
  if (!getSR()) return null;
  return new Promise((resolve) => {
    const SR = getSR();
    let settled = false;
    const rec = new SR();
    rec.lang = lang || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearHandlers(rec);
      resolve(text);
    };

    const timer = setTimeout(() => {
      try { rec.stop(); } catch { finish(null); }
    }, timeoutMs);

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = (result[0]?.transcript || '').trim();
        if (!text) continue;
        if (result.isFinal) {
          finish(text);
          return;
        }
        interim = text;
      }
      if (interim) onInterim?.(interim);
    };
    rec.onerror = () => {};
    rec.onend = () => { if (!settled) finish(null); };

    try { rec.start(); } catch { finish(null); }
  });
}
