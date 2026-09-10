/**
 * Speech capture: on-device Whisper (primary) → Web Speech fallback.
 * VAD avoids Android beep loops; records PCM for Whisper.
 */
import { resampleTo16k, whisperSupported } from './audioUtils';

let gen = 0;
let media = null;
let activeRec = null;
let forceEndCapture = false;
let engineMode = null;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HALLUCINATION_PHRASES = [
  'thank you for watching', 'thanks for watching', 'please subscribe',
  'like and subscribe', 'subscribe to', 'subtitles by', 'amara.org',
];

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechSupported() {
  return whisperSupported() || !!getSR();
}

function teardownMedia() {
  if (!media) return;
  try { media.processor?.disconnect(); } catch {}
  try { media.mute?.disconnect(); } catch {}
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
  if (Array.isArray(v)) {
    return { speechCode: v[0] || 'en-US', apiCode: 'auto', fallbackCodes: v.slice(1) };
  }
  return {
    speechCode: v.speechCode || 'en-US',
    apiCode: v.apiCode || 'en',
    fallbackCodes: v.fallbackCodes || [],
    whisperLang: v.whisperLang || null,
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
  source.connect(analyser);

  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  const recordChunks = [];
  let recording = false;

  processor.onaudioprocess = (e) => {
    if (!recording) return;
    recordChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };

  media = {
    stream,
    ctx,
    source,
    analyser,
    processor,
    mute,
    startRecord: () => {
      recordChunks.length = 0;
      recording = true;
    },
    stopRecord: () => {
      recording = false;
      return resampleTo16k(recordChunks, ctx.sampleRate);
    },
  };
  return media;
}

function recognizeUtterance({ lang, onInterim, onFinal, myGen }) {
  const SR = getSR();
  if (!SR) return Promise.resolve();

  return new Promise((resolve) => {
    if (myGen !== gen) { resolve(); return; }

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

    rec.onerror = () => {};
    rec.onend = () => finish();

    try { rec.start(); } catch { finish(); }
  });
}

async function vadLoop({
  activeRef, getLang, onInterim, onFinal, onPhase, myGen, useWhisper, transcribeAudioFn,
}) {
  const levelBuf = new Uint8Array(media.analyser.fftSize);
  const SPEECH_ON = 0.014;
  const SPEECH_OFF = 0.007;
  const START_HOLD_MS = 180;
  const END_SILENCE_MS = 700;
  const POLL_MS = 60;
  const MAX_UTTERANCE_MS = 28000;

  let speechHold = 0;
  let silenceHold = 0;
  let inSpeech = false;
  let recognizing = false;
  let utteranceStart = 0;

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
      inSpeech = false;
      onInterim?.('');
      onPhase?.('hearing');
      await sleep(POLL_MS);
      continue;
    }

    if (recognizing) {
      await sleep(POLL_MS);
      continue;
    }

    const level = voiceLevel(media.analyser, levelBuf);

    if (!inSpeech) {
      if (level >= SPEECH_ON) {
        speechHold += POLL_MS;
      } else if (level < SPEECH_OFF) {
        speechHold = 0;
      }

      if (speechHold >= START_HOLD_MS) {
        inSpeech = true;
        silenceHold = 0;
        utteranceStart = Date.now();
        onPhase?.('hearing');
        if (useWhisper) media.startRecord();
        else {
          recognizing = true;
          const { speechCode, fallbackCodes = [] } = resolveLang(getLang);
          const langs = [speechCode, ...fallbackCodes].filter(Boolean);
          let accepted = false;
          for (const lang of langs) {
            if (!activeRef.current || myGen !== gen || accepted) break;
            await recognizeUtterance({
              lang,
              onInterim: (t) => { if (activeRef.current && myGen === gen) onInterim?.(t); },
              onFinal: async (text) => {
                if (!activeRef.current || myGen !== gen || isGarbageTranscript(text)) return;
                accepted = true;
                onPhase?.('transcribing');
                await onFinal?.(text);
                if (activeRef.current && myGen === gen) onPhase?.('hearing');
              },
              myGen,
            });
            if (accepted) break;
          }
          recognizing = false;
          inSpeech = false;
          onInterim?.('');
          await sleep(450);
        }
      }
    } else if (useWhisper) {
      if (level < SPEECH_OFF) {
        silenceHold += POLL_MS;
      } else {
        silenceHold = 0;
        onInterim?.('…');
      }

      const timedOut = Date.now() - utteranceStart > MAX_UTTERANCE_MS;
      if (silenceHold >= END_SILENCE_MS || timedOut) {
        inSpeech = false;
        onPhase?.('transcribing');
        const pcm = media.stopRecord();
        if (pcm.length > 8000) {
          try {
            const { whisperLang } = resolveLang(getLang);
            const text = await transcribeAudioFn?.(pcm, { language: whisperLang || 'auto' });
            if (text && !isGarbageTranscript(text) && activeRef.current && myGen === gen) {
              await onFinal?.(text);
            }
          } catch {}
        }
        onInterim?.('');
        onPhase?.('hearing');
        await sleep(450);
      }
    }

    await sleep(POLL_MS);
  }

  stopRecognition();
  onInterim?.('');
}

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
    onError?.('no-mic');
    return;
  }

  const myGen = ++gen;
  forceEndCapture = false;
  engineMode = null;

  try {
    await ensureVadMedia();
  } catch {
    onError?.('mic-denied');
    activeRef.current = false;
    return;
  }

  let useWhisper = false;
  let transcribeAudio;
  try {
    const whisper = await import('./whisper');
    await whisper.loadWhisper((info) => onModel?.(info));
    transcribeAudio = whisper.transcribeAudio;
    useWhisper = true;
    engineMode = 'whisper';
    onEngine?.('whisper');
  } catch {
    if (!getSR()) {
      onError?.('no-speech');
      activeRef.current = false;
      teardownMedia();
      return;
    }
    engineMode = 'webspeech';
    onEngine?.('webspeech');
    onModel?.({ status: 'ready', progress: 100, device: 'webspeech' });
  }

  if (!activeRef.current || myGen !== gen) {
    teardownMedia();
    return;
  }

  try {
    await vadLoop({
      activeRef, getLang, onInterim, onFinal, onPhase, myGen, useWhisper,
      transcribeAudioFn: transcribeAudio,
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
