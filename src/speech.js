/**
 * Silent speech capture — NO Chrome SpeechRecognition (that API always beeps
 * on Android). We keep a quiet mic open, detect voice, then transcribe with
 * on-device Whisper (WebAssembly). Zero beeps.
 */

let gen = 0;
let media = null; // { stream, ctx, source, analyser, processor, gain, buffer }
let transcriberPromise = null;
let forceEndCapture = false;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WHISPER_LANG = {
  en: 'english',
  ja: 'japanese',
  ko: 'korean',
  zh: 'chinese',
  'zh-TW': 'chinese',
  es: 'spanish',
  fr: 'french',
  de: 'german',
  it: 'italian',
  pt: 'portuguese',
  ru: 'russian',
  uk: 'ukrainian',
  ar: 'arabic',
  he: 'hebrew',
  fa: 'persian',
  hi: 'hindi',
  th: 'thai',
  vi: 'vietnamese',
  id: 'indonesian',
  ms: 'malay',
  tl: 'tagalog',
  fil: 'tagalog',
  nl: 'dutch',
  pl: 'polish',
  tr: 'turkish',
  sv: 'swedish',
  no: 'norwegian',
  da: 'danish',
  fi: 'finnish',
  cs: 'czech',
  ro: 'romanian',
  hu: 'hungarian',
  sk: 'slovak',
  hr: 'croatian',
  el: 'greek',
  sw: 'swahili',
  af: 'afrikaans',
};

export function speechSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    && (window.AudioContext || window.webkitAudioContext));
}

function teardownMedia() {
  if (!media) return;
  try { media.processor?.disconnect(); } catch {}
  try { media.gain?.disconnect(); } catch {}
  try { media.analyser?.disconnect(); } catch {}
  try { media.source?.disconnect(); } catch {}
  try { media.processor.onaudioprocess = null; } catch {}
  try { media.ctx?.close(); } catch {}
  try { media.stream?.getTracks?.().forEach((t) => t.stop()); } catch {}
  media = null;
}

/** Soft “restart” — end the current utterance capture early (language switch). */
export function restartMic() {
  forceEndCapture = true;
}

/** Hard stop — ends keepListening and releases the mic. */
export async function stopMic() {
  gen += 1;
  forceEndCapture = true;
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
    const idx = Math.min(input.length - 1, Math.floor(i * ratio));
    out[i] = input[idx];
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

  // ScriptProcessor captures PCM without using SpeechRecognition (no beep).
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const gain = ctx.createGain();
  gain.gain.value = 0; // mute monitor path

  const capture = { on: false, chunks: [] };
  processor.onaudioprocess = (event) => {
    if (!capture.on) return;
    const input = event.inputBuffer.getChannelData(0);
    capture.chunks.push(new Float32Array(input));
  };

  source.connect(analyser);
  source.connect(processor);
  processor.connect(gain);
  gain.connect(ctx.destination);

  media = { stream, ctx, source, analyser, processor, gain, capture };
  return media;
}

async function getTranscriber(onModel) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      onModel?.({ status: 'loading', progress: 0 });
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      const transcriber = await pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny',
        {
          progress_callback: (p) => {
            if (!p) return;
            const progress = typeof p.progress === 'number' ? p.progress : undefined;
            onModel?.({
              status: 'loading',
              progress,
              file: p.file,
            });
          },
        },
      );
      onModel?.({ status: 'ready', progress: 100 });
      return transcriber;
    })().catch((err) => {
      transcriberPromise = null;
      throw err;
    });
  }
  return transcriberPromise;
}

async function transcribePcm(pcm, sampleRate, apiCode) {
  const transcriber = await getTranscriber();
  const audio = downsampleTo16k(pcm, sampleRate);
  if (audio.length < 1600) return ''; // < ~0.1s — ignore

  const opts = {
    task: 'transcribe',
    // chunking helps longer utterances on tiny model
    chunk_length_s: 20,
    stride_length_s: 3,
  };
  const lang = WHISPER_LANG[apiCode];
  if (lang) opts.language = lang;

  const result = await transcriber(audio, opts);
  const text = (typeof result === 'string' ? result : result?.text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
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

/**
 * Always-on silent listen until Stop.
 * Speaks → capture PCM → Whisper → onFinal(text). No browser beeps.
 */
export async function keepListening({
  activeRef,
  getLang,
  onInterim,
  onFinal,
  onError,
  onPhase,
  onModel,
}) {
  if (!speechSupported()) {
    onError?.('This browser can’t access the microphone.');
    return;
  }

  const myGen = ++gen;
  forceEndCapture = false;

  try {
    await ensureMedia();
  } catch {
    onError?.('Microphone access denied — allow it in browser settings.');
    activeRef.current = false;
    return;
  }

  try {
    await getTranscriber(onModel);
  } catch (err) {
    console.error(err);
    onError?.('Couldn’t load the speech engine. Check your connection and try again.');
    activeRef.current = false;
    teardownMedia();
    return;
  }

  if (!activeRef.current || myGen !== gen) {
    teardownMedia();
    return;
  }

  onPhase?.('idle');

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
      if (text && activeRef.current && myGen === gen) {
        await onFinal?.(text);
      }
    } catch (err) {
      console.error(err);
      onInterim?.('');
    } finally {
      busy = false;
      if (activeRef.current && myGen === gen) onPhase?.('idle');
    }
  };

  while (activeRef.current && myGen === gen) {
    if (media?.ctx?.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }

    // Don’t start a new capture while Whisper is working
    if (busy) {
      await sleep(POLL_MS);
      continue;
    }

    const level = voiceLevel(analyser, levelBuf);
    const speaking = level >= THRESHOLD;

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
      } else {
        voicedFor = 0;
      }
    } else {
      if (speaking) silenceFor = 0;
      else silenceFor += POLL_MS;

      const timedOut = Date.now() - captureStartedAt > MAX_UTTER_MS;
      if (forceEndCapture || silenceFor >= END_SILENCE_MS || timedOut) {
        await finishUtterance();
        voicedFor = 0;
        silenceFor = 0;
      }
    }

    await sleep(POLL_MS);
  }

  capture.on = false;
  if (myGen === gen) teardownMedia();
}

export const listenLoop = keepListening;
