/**
 * Silent-first speech capture.
 *
 * Primary: Web Audio PCM + on-device Whisper (no beeps).
 * Fallback: voice-activated Web Speech API (one beep when talk starts) if
 * the Whisper model can’t download/init on this device.
 */

let gen = 0;
let media = null;
let activeRec = null;
let transcriberPromise = null;
let forceEndCapture = false;
let engineMode = null; // 'whisper' | 'webspeech'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHISPER_LANG = {
  en: 'english', ja: 'japanese', ko: 'korean', zh: 'chinese', 'zh-TW': 'chinese',
  es: 'spanish', fr: 'french', de: 'german', it: 'italian', pt: 'portuguese',
  ru: 'russian', uk: 'ukrainian', ar: 'arabic', he: 'hebrew', fa: 'persian',
  hi: 'hindi', th: 'thai', vi: 'vietnamese', id: 'indonesian', ms: 'malay',
  tl: 'tagalog', fil: 'tagalog', nl: 'dutch', pl: 'polish', tr: 'turkish',
  sv: 'swedish', no: 'norwegian', da: 'danish', fi: 'finnish', cs: 'czech',
  ro: 'romanian', hu: 'hungarian', sk: 'slovak', hr: 'croatian', el: 'greek',
  sw: 'swahili', af: 'afrikaans',
};

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && (window.AudioContext || window.webkitAudioContext));
}

function clearRecHandlers(rec) {
  if (!rec) return;
  rec.onstart = null;
  rec.onresult = null;
  rec.onerror = null;
  rec.onend = null;
}

function stopRecognitionOnly() {
  const cur = activeRec;
  activeRec = null;
  if (!cur) return;
  clearRecHandlers(cur.rec);
  try { cur.rec.stop(); } catch {
    try { cur.rec.abort(); } catch {}
  }
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

export function restartMic() {
  forceEndCapture = true;
  stopRecognitionOnly();
}

export async function stopMic() {
  gen += 1;
  forceEndCapture = true;
  stopRecognitionOnly();
  teardownMedia();
  await sleep(100);
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

function concatFloat32(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function downsampleTo16k(input, fromRate) {
  if (fromRate === 16000) return input;
  const ratio = fromRate / 16000;
  const newLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i += 1) {
    out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))];
  }
  return out;
}

async function ensureMedia() {
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

  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const gain = ctx.createGain();
  gain.gain.value = 0;

  const capture = { on: false, chunks: [] };
  processor.onaudioprocess = (event) => {
    if (!capture.on) return;
    capture.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };

  source.connect(analyser);
  source.connect(processor);
  processor.connect(gain);
  gain.connect(ctx.destination);

  media = { stream, ctx, source, analyser, processor, gain, capture };
  return media;
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

async function getTranscriber(onModel) {
  if (transcriberPromise) return transcriberPromise;

  transcriberPromise = (async () => {
    onModel?.({ status: 'loading', progress: 0 });
    const { pipeline, env } = await import('@huggingface/transformers');

    // Load the quantized model from THIS site (public/models), not Hugging Face.
    // That avoids mobile download/CORS failures that broke silent mode.
    const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL)
      ? import.meta.env.BASE_URL
      : '/';
    env.localModelPath = `${base}models/`;
    env.allowLocalModels = true;
    env.allowRemoteModels = false; // force same-origin model files
    env.useBrowserCache = true;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;

    onModel?.({ status: 'loading', progress: 10 });

    try {
      const transcriber = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny',
        {
          dtype: 'q8',
          device: 'wasm',
          local_files_only: true,
          progress_callback: (p) => {
            if (!p) return;
            onModel?.({
              status: 'loading',
              progress: typeof p.progress === 'number' ? Math.max(10, p.progress) : undefined,
              file: p.file,
            });
          },
        },
      );
      onModel?.({ status: 'ready', progress: 100 });
      return transcriber;
    } catch (err) {
      // Last chance: allow remote HF if local bundle missing (e.g. old deploy)
      console.warn('Local Whisper failed, trying remote:', err);
      env.allowRemoteModels = true;
      const transcriber = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny',
        {
          dtype: 'q8',
          device: 'wasm',
          progress_callback: (p) => {
            if (!p) return;
            onModel?.({
              status: 'loading',
              progress: typeof p.progress === 'number' ? p.progress : undefined,
              file: p.file,
            });
          },
        },
      );
      onModel?.({ status: 'ready', progress: 100 });
      return transcriber;
    }
  })().catch((err) => {
    transcriberPromise = null;
    throw err;
  });

  return transcriberPromise;
}

async function transcribePcm(pcm, sampleRate, apiCode) {
  const transcriber = await getTranscriber();
  const audio = downsampleTo16k(pcm, sampleRate);
  if (audio.length < 1600) return '';

  const opts = {
    task: 'transcribe',
    chunk_length_s: 20,
    stride_length_s: 3,
  };
  const lang = WHISPER_LANG[apiCode];
  if (lang) opts.language = lang;

  const result = await transcriber(audio, opts);
  return (typeof result === 'string' ? result : result?.text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Whisper loop (silent) ─────────────────────────────────────────── */
async function keepListeningWhisper({
  activeRef, getLang, onInterim, onFinal, onError, onPhase, myGen,
}) {
  const { analyser, ctx, capture } = media;
  const levelBuf = new Uint8Array(analyser.fftSize);

  const THRESHOLD = 0.04;
  const START_MS = 180;
  const END_SILENCE_MS = 900;
  const MAX_UTTER_MS = 20000;
  const POLL_MS = 70;
  const MIN_SAMPLES = ctx.sampleRate * 0.35;

  let voicedFor = 0;
  let silenceFor = 0;
  let capturing = false;
  let captureStartedAt = 0;
  let busy = false;

  const finishUtterance = async () => {
    if (!capturing) return;
    capturing = false;
    capture.on = false;
    const chunks = capture.chunks;
    capture.chunks = [];
    forceEndCapture = false;

    const pcm = concatFloat32(chunks);
    if (pcm.length < MIN_SAMPLES) {
      onPhase?.('idle');
      onInterim?.('');
      return;
    }

    onPhase?.('transcribing');
    onInterim?.('…');
    busy = true;
    try {
      const { apiCode } = resolveLang(getLang);
      const text = await transcribePcm(pcm, ctx.sampleRate, apiCode);
      onInterim?.('');
      if (text && activeRef.current && myGen === gen) await onFinal?.(text);
    } catch (err) {
      console.error(err);
      onInterim?.('');
    } finally {
      busy = false;
      if (activeRef.current && myGen === gen) onPhase?.('idle');
    }
  };

  onPhase?.('idle');

  while (activeRef.current && myGen === gen) {
    if (media?.ctx?.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }
    if (busy) {
      await sleep(POLL_MS);
      continue;
    }

    const speaking = voiceLevel(analyser, levelBuf) >= THRESHOLD;

    if (!capturing) {
      if (speaking) {
        voicedFor += POLL_MS;
        if (voicedFor >= START_MS) {
          capturing = true;
          captureStartedAt = Date.now();
          silenceFor = 0;
          capture.chunks = [];
          capture.on = true;
          onPhase?.('hearing');
          onInterim?.('Listening…');
        }
      } else voicedFor = 0;
    } else {
      if (speaking) silenceFor = 0;
      else silenceFor += POLL_MS;

      if (forceEndCapture || silenceFor >= END_SILENCE_MS
        || Date.now() - captureStartedAt > MAX_UTTER_MS) {
        await finishUtterance();
        voicedFor = 0;
        silenceFor = 0;
      }
    }

    await sleep(POLL_MS);
  }

  capture.on = false;
}

/* ── Web Speech fallback (may beep once when speech starts) ─────────── */
function startWebSpeech({ lang, myGen, activeRef, onInterim, onFinal, onError, onPhase, state }) {
  if (activeRec) return;
  const SR = getSR();
  if (!SR) return;

  let rec;
  try { rec = new SR(); } catch { return; }

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
      if (result.isFinal) Promise.resolve(onFinal?.(text)).catch(() => {});
      else interim = text;
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
    }
  };

  rec.onend = () => {
    if (activeRec === session) activeRec = null;
    clearRecHandlers(rec);
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

async function keepListeningWebSpeech({
  activeRef, getLang, onInterim, onFinal, onError, onPhase, myGen,
}) {
  if (!getSR()) {
    onError?.('Speech isn’t supported in this browser. Try Chrome.');
    activeRef.current = false;
    return;
  }

  const { analyser } = media;
  const levelBuf = new Uint8Array(analyser.fftSize);
  const state = { cooldownUntil: 0, voicedFor: 0 };
  const THRESHOLD = 0.04;
  const SPEAK_MS = 200;
  const POLL_MS = 80;

  onPhase?.('idle');

  while (activeRef.current && myGen === gen) {
    if (media?.ctx?.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }

    const speaking = voiceLevel(analyser, levelBuf) >= THRESHOLD;
    if (speaking) state.voicedFor += POLL_MS;
    else state.voicedFor = 0;

    const { speechCode } = resolveLang(getLang);
    if (!activeRec && Date.now() >= state.cooldownUntil && state.voicedFor >= SPEAK_MS) {
      startWebSpeech({
        lang: speechCode,
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

  stopRecognitionOnly();
}

/**
 * Always-on listen until Stop. Prefers silent Whisper; falls back if needed.
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
    onError?.('This browser can’t access the microphone.');
    return;
  }

  const myGen = ++gen;
  forceEndCapture = false;
  engineMode = null;

  try {
    await ensureMedia();
  } catch {
    onError?.('Microphone access denied — allow it in browser settings.');
    activeRef.current = false;
    return;
  }

  // Try silent engine first
  let useWhisper = false;
  try {
    await getTranscriber(onModel);
    useWhisper = true;
    engineMode = 'whisper';
    onEngine?.('whisper');
  } catch (err) {
    console.warn('Silent speech engine failed, falling back:', err);
    engineMode = 'webspeech';
    onEngine?.('webspeech');
    // Don’t hard-fail — keep the app usable
    onModel?.({ status: 'fallback' });
  }

  if (!activeRef.current || myGen !== gen) {
    teardownMedia();
    return;
  }

  try {
    if (useWhisper) {
      await keepListeningWhisper({
        activeRef, getLang, onInterim, onFinal, onError, onPhase, myGen,
      });
    } else {
      await keepListeningWebSpeech({
        activeRef, getLang, onInterim, onFinal, onError, onPhase, myGen,
      });
    }
  } finally {
    if (myGen === gen) {
      stopRecognitionOnly();
      teardownMedia();
    }
  }
}

export const listenLoop = keepListening;
export function getEngineMode() {
  return engineMode;
}
