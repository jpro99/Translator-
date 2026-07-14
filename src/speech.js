/**
 * Silent speech capture via Web Audio + on-device Whisper.
 *
 * Chrome SpeechRecognition is never used (Android beep loop).
 * Capture is voice-activated so silence/noise never hits Whisper —
 * that was producing "o o o o" / "Nangangangan…" hallucinations.
 */

let gen = 0;
let media = null;
let transcriberPromise = null;
let forceEndCapture = false;
let engineMode = null; // 'whisper' | 'error'

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

/** Known Whisper-tiny garbage / YouTube watermark hallucinations. */
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
  'mbc 뉴스',
  '시청해 주셔서',
  'ご視聴ありがとうございました',
  'ご視聴',
  '字幕',
];

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

/** Stricter gate used before sending audio to Whisper. */
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
    if (rms >= 0.01) activeWindows += 1;
  }

  // Need a real burst of speech, not room tone.
  return peak >= 0.03 && activeWindows >= 5;
}

/**
 * Reject Whisper silence/noise hallucinations and stuck-syllable loops.
 * Examples from the field: "o o o o o", "Nangangangangan…", "goggaggag withg withg"
 */
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

  // "o o o o o" / single-letter tokens dominating
  if (words.length >= 3) {
    const tiny = words.filter((w) => w.length <= 1).length;
    if (tiny / words.length >= 0.5) return true;
  }

  // Same word repeated 3+ times in a row
  let run = 1;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i] === words[i - 1]) {
      run += 1;
      if (run >= 3) return true;
    } else {
      run = 1;
    }
  }

  // One word is most of the utterance
  if (words.length >= 4) {
    const counts = Object.create(null);
    for (const w of words) counts[w] = (counts[w] || 0) + 1;
    const max = Math.max(...Object.values(counts));
    if (max / words.length >= 0.5) return true;
  }

  // Stuck syllable / n-gram loops: "nangangangangan", "gaggaggag"
  const compact = plain.replace(/\s+/g, '');
  if (compact.length >= 10) {
    const unique = new Set(compact).size;
    if (unique / compact.length < 0.2) return true;

    for (const n of [1, 2, 3, 4]) {
      const grams = Object.create(null);
      for (let i = 0; i <= compact.length - n; i += 1) {
        const g = compact.slice(i, i + n);
        grams[g] = (grams[g] || 0) + 1;
      }
      const maxG = Math.max(0, ...Object.values(grams));
      if (maxG >= 5 && (maxG * n) / compact.length >= 0.5) return true;
    }

    // Whole-string is unit repeated (aaaa / ababab)
    for (const n of [1, 2, 3, 4]) {
      if (compact.length < n * 5) continue;
      const unit = compact.slice(0, n);
      if (unit.repeat(Math.floor(compact.length / n)) === compact.slice(0, n * Math.floor(compact.length / n))
          && compact.length / n >= 5) {
        return true;
      }
    }
  }

  // Bracket-only crumbs like "[lidong]"
  if (/^\[[^\]]+\]$/.test(raw.trim()) && raw.trim().length < 16) return true;

  return false;
}

export function cleanTranscript(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/^\[|\]$/g, '')
    .trim();
}

/** Near-duplicate check for "same line over and over". */
export function isNearDuplicate(a, b) {
  const x = cleanTranscript(a).toLowerCase();
  const y = cleanTranscript(b).toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) {
    const shorter = Math.min(x.length, y.length);
    const longer = Math.max(x.length, y.length);
    if (shorter >= 8 && shorter / longer >= 0.72) return true;
  }
  // Token Jaccard
  const ax = new Set(x.split(/\s+/).filter((w) => w.length > 1));
  const ay = new Set(y.split(/\s+/).filter((w) => w.length > 1));
  if (!ax.size || !ay.size) return false;
  let inter = 0;
  for (const t of ax) if (ay.has(t)) inter += 1;
  const union = ax.size + ay.size - inter;
  return union > 0 && inter / union >= 0.78;
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
  analyser.smoothingTimeConstant = 0.8;

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

    const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL)
      ? import.meta.env.BASE_URL
      : '/';
    env.localModelPath = `${base}models/`;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
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
  // Need at least ~0.4s of audio
  if (audio.length < 6400) return '';

  const opts = {
    task: 'transcribe',
    chunk_length_s: 15,
    stride_length_s: 2,
    // Critical: stop Whisper from looping the previous phrase forever
    condition_on_previous_text: false,
    no_speech_threshold: 0.55,
    compression_ratio_threshold: 2.2,
    logprob_threshold: -0.9,
    temperature: 0,
  };
  const lang = WHISPER_LANG[apiCode];
  if (lang) opts.language = lang;

  const result = await transcriber(audio, opts);
  return cleanTranscript(typeof result === 'string' ? result : result?.text || '');
}

/**
 * Voice-activated listen: record only while someone is talking,
 * then transcribe that utterance. Never feed silence to Whisper.
 */
async function keepListeningWhisper({
  activeRef, getLang, onInterim, onFinal, onPhase, myGen,
}) {
  const { analyser, capture } = media;
  const levelBuf = new Uint8Array(analyser.fftSize);

  // Hysteresis thresholds (RMS) — phone mics at conversation distance
  const SPEECH_ON = 0.015;
  const SPEECH_OFF = 0.008;
  const SILENCE_END_MS = 900;
  const MAX_UTTER_MS = 9000;
  const MIN_UTTER_MS = 450;
  const POLL_MS = 70;

  let speaking = false;
  let silenceMs = 0;
  let utterStartedAt = 0;
  let lastAccepted = '';

  capture.chunks = [];
  capture.on = false;
  onInterim?.('');
  onPhase?.('hearing');

  const finishUtterance = async () => {
    capture.on = false;
    const chunks = capture.chunks;
    capture.chunks = [];
    speaking = false;
    silenceMs = 0;

    const elapsed = Date.now() - utterStartedAt;
    onInterim?.('');

    if (elapsed < MIN_UTTER_MS || !chunks.length) {
      onPhase?.('hearing');
      return;
    }

    const pcm = concatFloat32(chunks);
    if (!hasAudibleSpeech(pcm)) {
      onPhase?.('hearing');
      return;
    }

    onPhase?.('transcribing');
    try {
      const { apiCode } = resolveLang(getLang);
      const text = await transcribePcm(pcm, media.ctx.sampleRate, apiCode);
      if (!activeRef.current || myGen !== gen) return;

      if (!text || isGarbageTranscript(text)) {
        onPhase?.('hearing');
        return;
      }
      if (isNearDuplicate(text, lastAccepted)) {
        onPhase?.('hearing');
        return;
      }

      lastAccepted = text;
      await onFinal?.(text);
    } catch (err) {
      console.error('Whisper transcription failed:', err);
    }
    if (activeRef.current && myGen === gen) onPhase?.('hearing');
  };

  while (activeRef.current && myGen === gen) {
    if (media?.ctx?.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }

    // Language switch / hard restart from UI
    if (forceEndCapture) {
      forceEndCapture = false;
      if (speaking) {
        await finishUtterance();
      }
      continue;
    }

    const level = voiceLevel(analyser, levelBuf);

    if (!speaking) {
      if (level >= SPEECH_ON) {
        speaking = true;
        silenceMs = 0;
        utterStartedAt = Date.now();
        capture.chunks = [];
        capture.on = true;
        onInterim?.('…');
        onPhase?.('hearing');
      }
    } else if (level >= SPEECH_OFF) {
      silenceMs = 0;
      const elapsed = Date.now() - utterStartedAt;
      if (elapsed >= MAX_UTTER_MS) {
        await finishUtterance();
      }
    } else {
      silenceMs += POLL_MS;
      if (silenceMs >= SILENCE_END_MS) {
        await finishUtterance();
      }
    }

    await sleep(POLL_MS);
  }

  capture.on = false;
  if (speaking && capture.chunks.length && activeRef.current && myGen === gen) {
    await finishUtterance();
  }
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
      activeRef, getLang, onInterim, onFinal, onPhase, myGen,
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
