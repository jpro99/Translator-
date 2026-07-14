/**
 * Live speech capture — Google Translate style sentences.
 *
 * Prefer Chrome SpeechRecognition (same engine Google Translate uses)
 * so continuous talk produces real phrases, not one-word scraps.
 *
 * Whisper remains a silent fallback when Web Speech isn’t available.
 */

let gen = 0;
let media = null;
let activeRec = null;
let transcriberPromise = null;
let forceEndCapture = false;
let engineMode = null; // 'webspeech' | 'whisper' | 'error'

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

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechSupported() {
  if (getSR()) return true;
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

function stopRecognition() {
  const rec = activeRec;
  activeRec = null;
  if (!rec) return;
  try {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.stop();
  } catch {
    try { rec.abort(); } catch {}
  }
}

export function restartMic() {
  forceEndCapture = true;
  // Nudge Web Speech to end so the next session picks up a new language
  try { activeRec?.stop(); } catch {}
}

export async function stopMic() {
  gen += 1;
  forceEndCapture = true;
  stopRecognition();
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
    if (rms >= 0.008) activeWindows += 1;
  }

  return peak >= 0.025 && activeWindows >= 4;
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
    } else {
      run = 1;
    }
  }

  if (words.length >= 4) {
    const counts = Object.create(null);
    for (const w of words) counts[w] = (counts[w] || 0) + 1;
    const max = Math.max(...Object.values(counts));
    if (max / words.length >= 0.5) return true;
  }

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
  }

  if (/^\[[^\]]+\]$/.test(raw.trim()) && raw.trim().length < 16) return true;
  return false;
}

export function cleanTranscript(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/^\[|\]$/g, '')
    .trim();
}

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
  const ax = new Set(x.split(/\s+/).filter((w) => w.length > 1));
  const ay = new Set(y.split(/\s+/).filter((w) => w.length > 1));
  if (!ax.size || !ay.size) return false;
  let inter = 0;
  for (const t of ax) if (ay.has(t)) inter += 1;
  const union = ax.size + ay.size - inter;
  return union > 0 && inter / union >= 0.78;
}

/** Only lock in real phrases — not one-word scraps. */
export function isCommitWorthy(text, { allowShort = false } = {}) {
  const t = cleanTranscript(text);
  if (!t || isGarbageTranscript(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (allowShort) return words.length >= 1 && t.length >= 2;
  // Prefer sentences / multi-word phrases
  if (words.length >= 4) return true;
  if (words.length >= 3 && t.length >= 16) return true;
  if (words.length >= 2 && t.length >= 24) return true;
  // Single long compound (some languages)
  if (words.length === 1 && t.length >= 18) return true;
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

/* ── Chrome / Google speech (best for live sentences) ─────────────── */
async function keepListeningWebSpeech({
  activeRef, getLang, onInterim, onFinal, onPhase, myGen,
}) {
  const SR = getSR();
  let lastAccepted = '';

  onPhase?.('hearing');

  while (activeRef.current && myGen === gen) {
    forceEndCapture = false;

    await new Promise((resolve) => {
      if (!activeRef.current || myGen !== gen) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (activeRec === rec) activeRec = null;
        resolve();
      };

      const rec = new SR();
      activeRec = rec;

      const { speechCode } = resolveLang(getLang);
      rec.lang = speechCode;
      // Continuous + interim = Google Translate style live text
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onstart = () => {
        if (activeRef.current && myGen === gen) onPhase?.('hearing');
      };

      rec.onresult = (event) => {
        if (!activeRef.current || myGen !== gen) return;

        let interim = '';
        const finals = [];

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = cleanTranscript(result[0]?.transcript || '');
          if (!text) continue;
          if (result.isFinal) finals.push(text);
          else interim = text;
        }

        // Live draft while they keep talking
        if (interim) onInterim?.(interim);

        for (const text of finals) {
          if (isGarbageTranscript(text)) continue;
          if (isNearDuplicate(text, lastAccepted)) continue;
          // Web Speech finals are usually real phrases — accept 2+ words
          // or anything reasonably long so short replies still work.
          const words = text.split(/\s+/).filter(Boolean);
          if (words.length < 2 && text.length < 12) continue;

          lastAccepted = text;
          onInterim?.('');
          void onFinal?.(text);
        }
      };

      rec.onerror = (event) => {
        // no-speech / aborted are normal when they pause or we stop
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        if (event.error === 'network') {
          // Will restart via onend
        }
      };

      rec.onend = () => finish();

      try {
        rec.start();
      } catch {
        finish();
      }

      // If UI requested language switch / stop mid-session
      const watch = setInterval(() => {
        if (!activeRef.current || myGen !== gen || forceEndCapture) {
          clearInterval(watch);
          forceEndCapture = false;
          try { rec.stop(); } catch { finish(); }
        }
      }, 200);
    });

    if (!activeRef.current || myGen !== gen) break;
    // Brief gap before Android will allow start() again
    await sleep(320);
  }

  stopRecognition();
  onInterim?.('');
}

/* ── Whisper fallback (silent, sentence-sized chunks) ─────────────── */
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
  // Prefer ~1s+ of audio for usable phrases
  if (audio.length < 16000) return '';

  const opts = {
    task: 'transcribe',
    chunk_length_s: 20,
    stride_length_s: 3,
    condition_on_previous_text: false,
    no_speech_threshold: 0.6,
    compression_ratio_threshold: 2.4,
    logprob_threshold: -1.0,
    temperature: 0,
  };
  const lang = WHISPER_LANG[apiCode];
  if (lang) opts.language = lang;

  const result = await transcriber(audio, opts);
  return cleanTranscript(typeof result === 'string' ? result : result?.text || '');
}

async function keepListeningWhisper({
  activeRef, getLang, onInterim, onFinal, onPhase, myGen,
}) {
  const { analyser, capture, ctx } = media;
  const levelBuf = new Uint8Array(analyser.fftSize);

  const SPEECH_ON = 0.012;
  const SPEECH_OFF = 0.006;
  const SILENCE_END_MS = 1400;     // wait for a real pause between sentences
  const MIN_UTTER_MS = 900;
  const PARTIAL_EVERY_MS = 2200;
  const AUTO_COMMIT_MS = 6500;    // sentence-sized windows while they keep talking
  const OVERLAP_SEC = 0.6;
  const POLL_MS = 70;

  let speaking = false;
  let silenceMs = 0;
  let utterStartedAt = 0;
  let lastPartialAt = 0;
  let lastAccepted = '';
  let lastInterim = '';
  let transcribing = false;
  let wantPartial = false;
  let wantFinal = false;
  let wantCommit = false;

  capture.chunks = [];
  capture.on = false;
  onInterim?.('');
  onPhase?.('hearing');

  const snapshotPcm = () => {
    if (!capture.chunks.length) return null;
    return concatFloat32(capture.chunks.slice());
  };

  const keepOverlapOnly = () => {
    const keepSamples = Math.floor(ctx.sampleRate * OVERLAP_SEC);
    if (!capture.chunks.length || keepSamples <= 0) {
      capture.chunks = [];
      return;
    }
    const pcm = concatFloat32(capture.chunks);
    capture.chunks = pcm.length > keepSamples
      ? [pcm.slice(pcm.length - keepSamples)]
      : [pcm];
  };

  const emitFinal = async (text) => {
    const t = cleanTranscript(text);
    if (!t || isGarbageTranscript(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    // Require a real phrase (not a lone scrap) unless it's a long single token
    if (words.length < 2 && t.length < 14) return false;
    if (isNearDuplicate(t, lastAccepted)) return false;
    lastAccepted = t;
    lastInterim = '';
    onInterim?.('');
    await onFinal?.(t);
    return true;
  };

  const runTranscribe = async (kind) => {
    if (!activeRef.current || myGen !== gen) return;

    if (transcribing) {
      if (kind === 'final') wantFinal = true;
      else if (kind === 'commit') wantCommit = true;
      else wantPartial = true;
      return;
    }

    const pcm = snapshotPcm();
    const elapsed = Date.now() - utterStartedAt;
    if (!pcm || elapsed < MIN_UTTER_MS || !hasAudibleSpeech(pcm)) {
      if (kind === 'final') {
        capture.chunks = [];
        speaking = false;
        silenceMs = 0;
        lastInterim = '';
        onInterim?.('');
        onPhase?.('hearing');
      }
      return;
    }

    transcribing = true;
    if (kind === 'final' || kind === 'commit') onPhase?.('transcribing');

    try {
      const { apiCode } = resolveLang(getLang);
      const text = await transcribePcm(pcm, ctx.sampleRate, apiCode);
      if (!activeRef.current || myGen !== gen) return;

      if (!text || isGarbageTranscript(text)) {
        if (kind === 'final') {
          if (isCommitWorthy(lastInterim)) await emitFinal(lastInterim);
          capture.chunks = [];
          speaking = false;
          silenceMs = 0;
          lastInterim = '';
          onInterim?.('');
          onPhase?.('hearing');
        }
        return;
      }

      if (kind === 'partial') {
        lastInterim = text;
        lastPartialAt = Date.now();
        onInterim?.(text);
        onPhase?.('hearing');
        return;
      }

      if (kind === 'commit') {
        // Mid-speech: only lock in if it's a real phrase
        if (!isCommitWorthy(text)) {
          lastInterim = text;
          onInterim?.(text);
          onPhase?.('hearing');
          return;
        }
        const ok = await emitFinal(text);
        keepOverlapOnly();
        utterStartedAt = Date.now();
        lastPartialAt = Date.now();
        silenceMs = 0;
        capture.on = true;
        speaking = true;
        if (ok) onInterim?.('…');
        onPhase?.('hearing');
        return;
      }

      // final (pause)
      const ok = await emitFinal(text);
      if (!ok && isCommitWorthy(lastInterim)) await emitFinal(lastInterim);
      capture.chunks = [];
      speaking = false;
      silenceMs = 0;
      onPhase?.('hearing');
    } catch (err) {
      console.error('Whisper transcription failed:', err);
      if (kind === 'final' || kind === 'commit') onPhase?.('hearing');
    } finally {
      transcribing = false;
      if (!activeRef.current || myGen !== gen) return;

      if (wantFinal) {
        wantFinal = false;
        wantPartial = false;
        wantCommit = false;
        await runTranscribe('final');
      } else if (wantCommit && speaking) {
        wantCommit = false;
        wantPartial = false;
        await runTranscribe('commit');
      } else if (wantPartial && speaking) {
        wantPartial = false;
        await runTranscribe('partial');
      }
    }
  };

  while (activeRef.current && myGen === gen) {
    if (media?.ctx?.state === 'suspended') {
      try { await media.ctx.resume(); } catch {}
    }

    if (forceEndCapture) {
      forceEndCapture = false;
      if (speaking) {
        capture.on = false;
        void runTranscribe('final');
      }
      await sleep(POLL_MS);
      continue;
    }

    const level = voiceLevel(analyser, levelBuf);
    const now = Date.now();

    if (!speaking) {
      if (level >= SPEECH_ON) {
        speaking = true;
        silenceMs = 0;
        utterStartedAt = now;
        lastPartialAt = now;
        lastInterim = '';
        capture.chunks = [];
        capture.on = true;
        onInterim?.('…');
        onPhase?.('hearing');
      }
    } else {
      if (level >= SPEECH_OFF) silenceMs = 0;
      else silenceMs += POLL_MS;

      const elapsed = now - utterStartedAt;

      if (
        capture.on
        && elapsed >= MIN_UTTER_MS
        && now - lastPartialAt >= PARTIAL_EVERY_MS
        && !transcribing
      ) {
        lastPartialAt = now;
        void runTranscribe('partial');
      }

      if (elapsed >= AUTO_COMMIT_MS && !transcribing) {
        // Fresh Whisper on the full buffer — never commit a 1-word draft
        void runTranscribe('commit');
        // Avoid re-triggering until utterStartedAt resets inside commit
        utterStartedAt = now - Math.floor(AUTO_COMMIT_MS / 2);
      } else if (silenceMs >= SILENCE_END_MS) {
        capture.on = false;
        void runTranscribe('final');
        while (transcribing && activeRef.current && myGen === gen) {
          await sleep(80);
        }
      }
    }

    await sleep(POLL_MS);
  }

  capture.on = false;
  if (speaking && capture.chunks.length && activeRef.current && myGen === gen) {
    void runTranscribe('final');
    while (transcribing && activeRef.current && myGen === gen) {
      await sleep(80);
    }
  }
}

/**
 * Always-on listen until Stop.
 * Prefers Chrome/Google speech for real sentences; Whisper is fallback.
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

  const SR = getSR();
  if (SR) {
    engineMode = 'webspeech';
    onEngine?.('webspeech');
    onModel?.({ status: 'ready', progress: 100 });
    try {
      await keepListeningWebSpeech({
        activeRef, getLang, onInterim, onFinal, onPhase, myGen,
      });
    } finally {
      if (myGen === gen) stopRecognition();
    }
    return;
  }

  // Silent Whisper fallback (no Web Speech in this browser)
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
    onError?.('Speech engine couldn’t start. Use Chrome, then reload.');
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
    if (myGen === gen) teardownMedia();
  }
}

export const listenLoop = keepListening;
export function getEngineMode() {
  return engineMode;
}
