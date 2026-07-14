/**
 * Hybrid speech capture — correct text WITHOUT the Android beep loop.
 *
 * Why Whisper alone failed: on-device Whisper-base mishears Tagalog badly
 * (tested: Tagalog TTS → "Thank you for watching" / garbage).
 *
 * Why Web Speech alone failed: Android ends the session every few seconds
 * even during silence, and restarting beeps every time.
 *
 * Fix used by practical mobile web apps:
 *  1) Keep a silent getUserMedia VAD running (no beeps).
 *  2) Only start Chrome SpeechRecognition when real speech is detected.
 *  3) When they pause, stop recognition and WAIT — do not restart until
 *     the next speech burst. One beep per utterance, not beep-beep-beep.
 *  4) Google’s speech engine gives real Tagalog/Spanish sentences.
 */

let gen = 0;
let media = null;
let activeRec = null;
let forceEndCapture = false;
let engineMode = null;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HALLUCINATION_PHRASES = [
  'thank you for watching',
  'thanks for watching',
  'please subscribe',
  'like and subscribe',
  'subscribe to',
  'subtitles by',
  'amara.org',
  'www.',
  'http://',
  'https://',
];

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechSupported() {
  return !!getSR()
    || !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      && (window.AudioContext || window.webkitAudioContext));
}

function teardownMedia() {
  if (!media) return;
  try { media.processor?.disconnect(); } catch {}
  try { media.gain?.disconnect(); } catch {}
  try { media.analyser?.disconnect(); } catch {}
  try { media.source?.disconnect(); } catch {}
  try { if (media.processor) media.processor.onaudioprocess = null; } catch {}
  try { media.ctx?.close(); } catch {}
  try { media.stream?.getTracks?.().forEach((t) => t.stop()); } catch {}
  media = null;
}

function stopRecognition() {
  const rec = activeRec;
  activeRec = null;
  if (!rec) return;
  try {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.onstart = null;
    rec.stop();
  } catch {
    try { rec.abort(); } catch {}
  }
}

export function restartMic() {
  forceEndCapture = true;
  stopRecognition();
}

export async function stopMic() {
  gen += 1;
  forceEndCapture = true;
  stopRecognition();
  teardownMedia();
  await sleep(120);
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

export function isGarbageTranscript(text) {
  const raw = (text || '').trim();
  if (!raw) return true;
  const plain = raw
    .replace(/[\[\](){}「」『』<>]/g, ' ')
    .replace(/[.,!?;:'"…\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!plain || plain.length < 2) return true;
  for (const phrase of HALLUCINATION_PHRASES) {
    if (plain.includes(phrase)) return true;
  }
  const words = plain.split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  if (words.length >= 3) {
    const tiny = words.filter((w) => w.length <= 1).length;
    if (tiny / words.length >= 0.5) return true;
  }
  let run = 1;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i] === words[i - 1]) {
      run += 1;
      if (run >= 3) return true;
    } else run = 1;
  }
  if (words.length >= 4) {
    const counts = Object.create(null);
    for (const w of words) counts[w] = (counts[w] || 0) + 1;
    if (Math.max(...Object.values(counts)) / words.length >= 0.55) return true;
  }
  const compact = plain.replace(/\s+/g, '');
  if (compact.length >= 12 && new Set(compact).size / compact.length < 0.18) return true;
  return false;
}

export function cleanTranscript(text) {
  return (text || '').replace(/\s+/g, ' ').replace(/^\[|\]$/g, '').trim();
}

export function isNearDuplicate(a, b) {
  const x = cleanTranscript(a).toLowerCase();
  const y = cleanTranscript(b).toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) {
    const shorter = Math.min(x.length, y.length);
    const longer = Math.max(x.length, y.length);
    if (shorter >= 6 && shorter / longer >= 0.75) return true;
  }
  return false;
}

function resolveLang(getLang) {
  const v = typeof getLang === 'function' ? getLang() : getLang;
  if (!v) return { speechCode: 'en-US', apiCode: 'en' };
  if (typeof v === 'string') return { speechCode: v, apiCode: 'en' };
  return {
    speechCode: v.speechCode || 'en-US',
    apiCode: v.apiCode || 'en',
  };
}

async function ensureVadMedia() {
  if (media?.ctx) {
    if (media.ctx.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }
    return media;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
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
  analyser.smoothingTimeConstant = 0.85;
  // Analyser only — no ScriptProcessor speaker path needed for VAD
  source.connect(analyser);

  media = { stream, ctx, source, analyser };
  return media;
}

/**
 * Run one Web Speech utterance. Resolves when recognition ends.
 * Does NOT auto-restart — caller waits for next VAD trigger.
 */
function recognizeUtterance({ lang, onInterim, onFinal, myGen }) {
  const SR = getSR();
  if (!SR) return Promise.resolve();

  return new Promise((resolve) => {
    if (myGen !== gen) {
      resolve();
      return;
    }

    let settled = false;
    let lastAccepted = '';
    const finish = () => {
      if (settled) return;
      settled = true;
      if (activeRec === rec) activeRec = null;
      clearTimeout(maxTimer);
      resolve();
    };

    const rec = new SR();
    activeRec = rec;
    rec.lang = lang || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Hard cap so a stuck session can't hold the mic forever
    const maxTimer = setTimeout(() => {
      try { rec.stop(); } catch { finish(); }
    }, 28000);

    rec.onresult = (event) => {
      if (myGen !== gen) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = cleanTranscript(result[0]?.transcript || '');
        if (!text) continue;
        if (result.isFinal) {
          if (isGarbageTranscript(text)) continue;
          if (isNearDuplicate(text, lastAccepted)) continue;
          lastAccepted = text;
          onInterim?.('');
          void onFinal?.(text);
        } else {
          interim = text;
        }
      }
      if (interim) onInterim?.(interim);
    };

    rec.onerror = () => {
      // no-speech / aborted / network → end; caller will wait for next VAD
    };

    rec.onend = () => finish();

    try {
      rec.start();
    } catch {
      finish();
    }
  });
}

/**
 * Silent VAD watches for speech. Only then start Google speech once.
 * After it ends, wait for the next speech — never restart into silence.
 */
async function keepListeningHybrid({
  activeRef, getLang, onInterim, onFinal, onPhase, myGen,
}) {
  const SR = getSR();
  if (!SR) {
    onPhase?.('error');
    return;
  }

  const { analyser } = media;
  const levelBuf = new Uint8Array(analyser.fftSize);

  const SPEECH_ON = 0.014;
  const SPEECH_OFF = 0.007;
  const START_HOLD_MS = 180;   // need sustained voice before starting SR
  const POLL_MS = 60;

  let speechHold = 0;
  let recognizing = false;

  onPhase?.('hearing');
  onInterim?.('');

  while (activeRef.current && myGen === gen) {
    if (media?.ctx?.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }

    if (forceEndCapture) {
      forceEndCapture = false;
      stopRecognition();
      recognizing = false;
      onInterim?.('');
      onPhase?.('hearing');
      await sleep(POLL_MS);
      continue;
    }

    if (recognizing) {
      await sleep(POLL_MS);
      continue;
    }

    const level = voiceLevel(analyser, levelBuf);
    if (level >= SPEECH_ON) {
      speechHold += POLL_MS;
    } else if (level < SPEECH_OFF) {
      speechHold = 0;
    }

    if (speechHold >= START_HOLD_MS) {
      speechHold = 0;
      recognizing = true;
      onPhase?.('hearing');
      const { speechCode } = resolveLang(getLang);

      // One beep here when recognition starts — then it runs until they pause.
      await recognizeUtterance({
        lang: speechCode,
        onInterim: (t) => {
          if (activeRef.current && myGen === gen) onInterim?.(t);
        },
        onFinal: async (text) => {
          if (!activeRef.current || myGen !== gen) return;
          onPhase?.('transcribing');
          await onFinal?.(text);
          if (activeRef.current && myGen === gen) onPhase?.('hearing');
        },
        myGen,
      });

      recognizing = false;
      onInterim?.('');
      // Cool-down so we don't immediately re-trigger on trailing noise
      await sleep(450);
      if (activeRef.current && myGen === gen) onPhase?.('hearing');
    } else {
      await sleep(POLL_MS);
    }
  }

  stopRecognition();
  onInterim?.('');
}

/**
 * Always-on listen until Stop.
 */
export async function keepListening({
  activeRef,
  getLang,
  onInterim,
  onFinal,
  onError,
  onPhase,
  onModel,
  onEngine,
}) {
  if (!speechSupported()) {
    onError?.('This browser can’t access the microphone. Use Chrome.');
    return;
  }

  const myGen = ++gen;
  forceEndCapture = false;
  engineMode = null;

  if (!getSR()) {
    onError?.('Speech recognition needs Chrome or Edge.');
    activeRef.current = false;
    return;
  }

  try {
    await ensureVadMedia();
  } catch {
    onError?.('Microphone access denied — allow it in browser settings.');
    activeRef.current = false;
    return;
  }

  // Ready immediately — no huge model download
  engineMode = 'hybrid';
  onEngine?.('hybrid');
  onModel?.({ status: 'ready', progress: 100 });

  if (!activeRef.current || myGen !== gen) {
    teardownMedia();
    return;
  }

  try {
    await keepListeningHybrid({
      activeRef, getLang, onInterim, onFinal, onPhase, myGen,
    });
  } finally {
    if (myGen === gen) {
      stopRecognition();
      teardownMedia();
    }
  }
}

export const listenLoop = keepListening;
export function getEngineMode() {
  return engineMode;
}
