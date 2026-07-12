/**
 * Silent-first speech capture.
 *
 * Web Audio PCM + on-device Whisper. Chrome SpeechRecognition is never
 * used, because Android beeps every time that API starts.
 */

let gen = 0;
let media = null;
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
  try { if (media.processor) media.processor.onaudioprocess = null; } catch {}
  try { media.ctx?.close(); } catch {}
  try { media.stream?.getTracks?.().forEach((t) => t.stop()); } catch {}
  media = null;
}

export function restartMic() {
  forceEndCapture = true;
}

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
    out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))];
  }
  return out;
}

function hasAudibleSpeech(pcm) {
  if (!pcm?.length) return false;
  const windowSize = 1024;
  let activeWindows = 0;
  let peak = 0;

  for (let start = 0; start < pcm.length; start += windowSize) {
    const end = Math.min(start + windowSize, pcm.length);
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      const sample = pcm[i];
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    // Phone speech is commonly 0.008–0.15 RMS. The previous 0.04 gate
    // dropped normal/quiet voices before they were ever recorded.
    if (rms >= 0.0035) activeWindows += 1;
  }

  return peak >= 0.012 && activeWindows >= 3;
}

function cleanTranscript(raw) {
  const text = (raw || '')
    .replace(/\[(?:music|song|singing|applause|noise|silence)\]/gi, ' ')
    .replace(/\((?:music|song|singing|applause|noise|silence)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || text.length > 280) return '';
  if (/^\([^)]*\)$/.test(text) || /^\[[^\]]*\]$/.test(text)) return '';

  const words = text
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}']+/gu) || [];

  if (words.length >= 5) {
    let longestRun = 1;
    let run = 1;
    const counts = new Map();

    for (let i = 0; i < words.length; i += 1) {
      counts.set(words[i], (counts.get(words[i]) || 0) + 1);
      if (i > 0 && words[i] === words[i - 1]) {
        run += 1;
        longestRun = Math.max(longestRun, run);
      } else {
        run = 1;
      }
    }

    const mostCommon = Math.max(...counts.values());
    const uniqueRatio = counts.size / words.length;

    // Reject classic Whisper loops: "the the the…", repeated fragments,
    // or hundreds of tokens from a five-second audio segment.
    if (longestRun >= 4) return '';
    if (words.length >= 8 && mostCommon / words.length >= 0.45) return '';
    if (words.length >= 12 && uniqueRatio < 0.28) return '';
    if (words.length > 55) return '';
  }

  // Reject invented syllable loops such as "kagakagagagang".
  if (words.some((word) => /(.{1,3})\1{3,}/iu.test(word))) return '';

  return text;
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
        'Xenova/whisper-base',
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
        'Xenova/whisper-base',
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
    max_new_tokens: 64,
    repetition_penalty: 1.15,
    no_repeat_ngram_size: 3,
    do_sample: false,
  };
  const lang = WHISPER_LANG[apiCode];
  if (lang) opts.language = lang;

  const result = await transcriber(audio, opts);
  return cleanTranscript(typeof result === 'string' ? result : result?.text || '');
}

/* ── Whisper loop (silent) ─────────────────────────────────────────── */
async function keepListeningWhisper({
  activeRef, getLang, onInterim, onFinal, onError, onPhase, myGen,
}) {
  const { analyser, ctx, capture } = media;
  const POLL_MS = 70;
  const START_MS = 140;
  const END_SILENCE_MS = 850;
  const MAX_UTTERANCE_MS = 14000;
  const PRE_ROLL_CHUNKS = Math.max(8, Math.ceil(ctx.sampleRate / 4096));
  const MIN_SAMPLES = ctx.sampleRate * 0.5;
  const levelBuffer = new Uint8Array(analyser.fftSize);
  const queue = [];
  let processing = false;
  let speechActive = false;
  let voicedFor = 0;
  let silenceFor = 0;
  let speechStartedAt = 0;
  let noiseFloor = 0.002;

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    while (queue.length && activeRef.current && myGen === gen) {
      const pcm = queue.shift();
      if (pcm.length < MIN_SAMPLES || !hasAudibleSpeech(pcm)) continue;

      try {
        const { apiCode } = resolveLang(getLang);
        const text = await transcribePcm(pcm, ctx.sampleRate, apiCode);
        if (text && activeRef.current && myGen === gen) await onFinal?.(text);
      } catch (err) {
        console.error('Whisper transcription failed:', err);
      }
    }
    processing = false;
  };

  const queueUtterance = () => {
    const chunks = capture.chunks;
    capture.chunks = [];
    if (chunks.length) {
      queue.push(concatFloat32(chunks));
      void processQueue();
    }
    speechActive = false;
    voicedFor = 0;
    silenceFor = 0;
    forceEndCapture = false;
  };

  // Always record a short pre-roll so we never cut off the first word.
  // Adaptive thresholds handle quiet phone microphones without transcribing
  // room noise forever.
  capture.chunks = [];
  capture.on = true;
  onInterim?.('');
  onPhase?.('hearing');

  while (activeRef.current && myGen === gen) {
    if (media?.ctx?.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }

    const level = voiceLevel(analyser, levelBuffer);
    const startThreshold = Math.min(0.02, Math.max(0.004, noiseFloor * 2.4));
    const endThreshold = Math.min(0.014, Math.max(0.003, noiseFloor * 1.6));

    if (!speechActive) {
      if (forceEndCapture) {
        capture.chunks = [];
        forceEndCapture = false;
      }
      if (level < startThreshold) {
        noiseFloor = noiseFloor * 0.96 + level * 0.04;
        voicedFor = 0;
        // Keep about one second before speech, discard older silence.
        if (capture.chunks.length > PRE_ROLL_CHUNKS) {
          capture.chunks.splice(0, capture.chunks.length - PRE_ROLL_CHUNKS);
        }
      } else {
        voicedFor += POLL_MS;
        if (voicedFor >= START_MS) {
          speechActive = true;
          speechStartedAt = Date.now();
          silenceFor = 0;
        }
      }
    } else {
      if (level >= endThreshold) silenceFor = 0;
      else silenceFor += POLL_MS;

      const utteranceTooLong = Date.now() - speechStartedAt >= MAX_UTTERANCE_MS;
      if (forceEndCapture || silenceFor >= END_SILENCE_MS || utteranceTooLong) {
        queueUtterance();
      }
    }

    await sleep(POLL_MS);
  }

  capture.on = false;
  if (speechActive && capture.chunks.length) queueUtterance();
  capture.chunks = [];
}

/**
 * Always-on silent listen until Stop.
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

  // Silent engine only. Never fall back to Chrome SpeechRecognition because
  // that would bring the Android beep loop back.
  try {
    await getTranscriber(onModel);
    engineMode = 'whisper';
    onEngine?.('whisper');
  } catch (err) {
    console.error('Silent speech engine failed:', err);
    engineMode = 'error';
    onEngine?.('error');
    onModel?.({ status: 'error' });
    onError?.('Silent speech engine couldn’t start. Reload the app and try again.');
    activeRef.current = false;
    teardownMedia();
    return;
  }

  if (!activeRef.current || myGen !== gen) {
    teardownMedia();
    return;
  }

  try {
    await keepListeningWhisper({
      activeRef, getLang, onInterim, onFinal, onError, onPhase, myGen,
    });
  } finally {
    if (myGen === gen) {
      teardownMedia();
    }
  }
}

export const listenLoop = keepListening;
export function getEngineMode() {
  return engineMode;
}
