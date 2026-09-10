/**
 * Speech capture: Web Speech (reliable on Android) with optional Whisper.
 * VAD + MediaRecorder recording for Whisper path.
 */
import { resampleTo16k, whisperSupported } from './audioUtils';
import { whisperLangCode } from './languages';

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

export function isAndroid() {
  return /android/i.test(navigator.userAgent);
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
  try { if (media.recorder?.state === 'recording') media.recorder.stop(); } catch {}
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
    apiCode: v.apiCode || v.whisperLang || 'auto',
    fallbackCodes: v.fallbackCodes || [],
    whisperLang: v.whisperLang ?? null,
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
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);

  // ScriptProcessor backup (unreliable on some Android builds)
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

  // MediaRecorder — more reliable on Android
  let recorder = null;
  let mrChunks = [];
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

  async function stopRecordPcm() {
    recording = false;
    const { sampleRate } = ctx;

    // Try MediaRecorder first
    if (recorder && recorder.state !== 'inactive') {
      try {
        const blob = await new Promise((resolve, reject) => {
          const chunks = [...mrChunks];
          recorder.onstop = () => {
            resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
          };
          recorder.onerror = reject;
          try { recorder.stop(); } catch (e) { reject(e); }
        });
        if (blob.size > 500) {
          const buf = await blob.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
          const ch = audioBuffer.getChannelData(0);
          return resampleTo16k([ch], audioBuffer.sampleRate);
        }
      } catch {}
    }

    return resampleTo16k(recordChunks, sampleRate);
  }

  media = {
    stream,
    ctx,
    source,
    analyser,
    processor,
    mute,
    recorder: null,
    startRecord: () => {
      recordChunks.length = 0;
      mrChunks = [];
      recording = true;
      if (typeof MediaRecorder !== 'undefined' && mimeType) {
        try {
          recorder = new MediaRecorder(stream, { mimeType });
          media.recorder = recorder;
          recorder.ondataavailable = (ev) => {
            if (ev.data?.size) mrChunks.push(ev.data);
          };
          recorder.start(200);
        } catch {
          recorder = null;
        }
      }
    },
    stopRecord: stopRecordPcm,
  };
  return media;
}

function recognizeUtterance({ lang, onInterim, onFinal, myGen, continuous = true }) {
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
    rec.continuous = continuous;
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

function webSpeechLangs(getLang) {
  const { speechCode, fallbackCodes = [] } = resolveLang(getLang);
  return [...new Set(
    [speechCode, ...fallbackCodes, 'fil-PH', 'tl-PH', 'it-IT', 'en-US'].filter(Boolean),
  )];
}

async function runWebSpeechBurst({ getLang, onInterim, onFinal, onPhase, myGen }) {
  const unique = webSpeechLangs(getLang);

  onPhase?.('webspeech');
  let accepted = false;
  for (const lang of unique) {
    if (!accepted && myGen === gen) {
      await recognizeUtterance({
        lang,
        onInterim,
        onFinal: async (text) => {
          if (isGarbageTranscript(text)) return;
          accepted = true;
          onPhase?.('transcribing');
          await onFinal?.(text);
        },
        myGen,
      });
    }
    if (accepted) break;
  }
  return accepted;
}

async function vadLoop({
  activeRef, getLang, onInterim, onFinal, onPhase, onLevel, onStatus, myGen,
  useWhisperRef, transcribeAudioFn, outdoor = false,
}) {
  const levelBuf = new Uint8Array(media.analyser.fftSize);
  const SPEECH_ON = outdoor ? 0.005 : 0.010;
  const SPEECH_OFF = outdoor ? 0.0025 : 0.005;
  const START_HOLD_MS = outdoor ? 100 : 150;
  const END_SILENCE_MS = outdoor ? 900 : 700;
  const POLL_MS = 50;
  const MAX_UTTERANCE_MS = 28000;
  const MIN_PCM_SAMPLES = 4000;
  const SILENT_LEVEL = 0.0015;
  const SILENT_WARN_MS = 8000;

  let speechHold = 0;
  let silenceHold = 0;
  let inSpeech = false;
  let recognizing = false;
  let utteranceStart = 0;
  let whisperMisses = 0;
  let silentSince = Date.now();
  let hadAnyLevel = false;

  onPhase?.('hearing');
  onStatus?.('mic ok · waiting for speech');
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
    onLevel?.(level);
    if (level > SILENT_LEVEL) {
      hadAnyLevel = true;
      silentSince = Date.now();
    } else if (Date.now() - silentSince > SILENT_WARN_MS && hadAnyLevel === false) {
      onStatus?.('mic silent — check permission');
    }

    const useWhisper = useWhisperRef.current;

    if (!inSpeech) {
      if (level >= SPEECH_ON) {
        speechHold += POLL_MS;
        if (speechHold >= START_HOLD_MS / 2) {
          onInterim?.('Heard something…');
          onStatus?.('vad speech detected');
        }
      } else if (level < SPEECH_OFF) {
        speechHold = 0;
      }

      if (speechHold >= START_HOLD_MS) {
        inSpeech = true;
        silenceHold = 0;
        utteranceStart = Date.now();
        onPhase?.('hearing');
        onStatus?.(useWhisper ? 'recording · whisper' : 'webspeech listening');

        if (useWhisper) {
          media.startRecord();
        } else {
          recognizing = true;
          await runWebSpeechBurst({
            getLang, onInterim, onFinal, onPhase, myGen,
          });
          recognizing = false;
          inSpeech = false;
          onInterim?.('');
          onPhase?.('hearing');
          onStatus?.('mic ok · waiting for speech');
          await sleep(350);
        }
      }
    } else if (useWhisper) {
      if (level < SPEECH_OFF) {
        silenceHold += POLL_MS;
      } else {
        silenceHold = 0;
        onInterim?.('Recording…');
      }

      const timedOut = Date.now() - utteranceStart > MAX_UTTERANCE_MS;
      if (silenceHold >= END_SILENCE_MS || timedOut) {
        inSpeech = false;
        onPhase?.('transcribing');
        onStatus?.('whisper running…');
        const pcm = await media.stopRecord();
        let gotText = false;

        if (pcm.length >= MIN_PCM_SAMPLES && transcribeAudioFn) {
          try {
            const { whisperLang, apiCode } = resolveLang(getLang);
            const text = await transcribeAudioFn(
              pcm,
              { language: whisperLang || whisperLangCode(apiCode) || 'auto' },
            );
            if (text && !isGarbageTranscript(text) && activeRef.current && myGen === gen) {
              gotText = true;
              whisperMisses = 0;
              onStatus?.('transcribed · translating');
              await onFinal?.(text);
            }
          } catch {
            onStatus?.('whisper failed');
          }
        }

        if (!gotText) {
          whisperMisses += 1;
          onStatus?.(`whisper miss ${whisperMisses} — trying webspeech`);
          if (whisperMisses >= 1) {
            useWhisperRef.current = false;
            engineMode = 'webspeech';
          }
          recognizing = true;
          const accepted = await runWebSpeechBurst({
            getLang, onInterim, onFinal, onPhase, myGen,
          });
          recognizing = false;
          if (!accepted && pcm.length < MIN_PCM_SAMPLES) {
            onStatus?.('no audio captured — speak louder');
          }
        }

        onInterim?.('');
        onPhase?.('hearing');
        onStatus?.('mic ok · waiting for speech');
        await sleep(350);
      }
    }

    await sleep(POLL_MS);
  }

  stopRecognition();
  onInterim?.('');
}

/** Always-on Web Speech for Expert Listener — avoids VAD-missed utterances on Android. */
async function expertWebSpeechLoop({
  activeRef, getLang, onInterim, onFinal, onPhase, onLevel, onStatus, myGen,
}) {
  const levelBuf = new Uint8Array(media.analyser.fftSize);
  const SILENT_LEVEL = 0.0015;
  const SILENT_WARN_MS = 8000;
  const SPEECH_LEVEL = 0.005;
  let silentSince = Date.now();
  let hadAnyLevel = false;
  let polling = true;

  onPhase?.('hearing');
  onStatus?.('mic ok · webspeech continuous');

  const pollLevels = async () => {
    while (polling && activeRef.current && myGen === gen) {
      const level = voiceLevel(media.analyser, levelBuf);
      onLevel?.(level);
      if (level > SILENT_LEVEL) {
        hadAnyLevel = true;
        silentSince = Date.now();
        if (level >= SPEECH_LEVEL) onStatus?.('vad speech · listening');
      } else if (!hadAnyLevel && Date.now() - silentSince > SILENT_WARN_MS) {
        onStatus?.('mic silent — check permission');
      }
      await sleep(80);
    }
  };

  void pollLevels();

  while (activeRef.current && myGen === gen) {
    if (forceEndCapture) {
      forceEndCapture = false;
      stopRecognition();
      await sleep(200);
      continue;
    }

    const langs = webSpeechLangs(getLang);
    let accepted = false;
    for (const lang of langs) {
      if (accepted || myGen !== gen || !activeRef.current) break;
      onStatus?.(`webspeech · ${lang}`);
      await recognizeUtterance({
        lang,
        onInterim: (txt) => {
          if (txt) onInterim?.(txt);
        },
        onFinal: async (text) => {
          if (!text || isGarbageTranscript(text) || myGen !== gen || !activeRef.current) return;
          accepted = true;
          onStatus?.('recognized · translating');
          onPhase?.('transcribing');
          await onFinal?.(text);
          onPhase?.('hearing');
          onStatus?.('webspeech listening');
        },
        myGen,
      });
      if (accepted) break;
    }
    await sleep(150);
  }

  polling = false;
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
  onLevel,
  onStatus,
  onModel,
  onEngine,
  outdoor = false,
  profile = 'default',
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

  onStatus?.('mic ok');

  // Expert Listener on Android: Web Speech first (Whisper WASM + ScriptProcessor unreliable)
  const preferWebSpeech = profile === 'expert' && isAndroid();
  const useWhisperRef = { current: false };
  let transcribeAudio = null;

  if (!preferWebSpeech) {
    try {
      onStatus?.('loading whisper…');
      const whisper = await import('./whisper');
      await whisper.loadWhisper((info) => onModel?.(info));
      transcribeAudio = whisper.transcribeAudio;
      useWhisperRef.current = true;
      engineMode = 'whisper';
      onEngine?.('whisper');
      onStatus?.('mic ok · whisper ready');
    } catch {
      onStatus?.('whisper unavailable');
    }
  }

  if (!useWhisperRef.current) {
    if (!getSR()) {
      onError?.('no-speech');
      activeRef.current = false;
      teardownMedia();
      return;
    }
    engineMode = 'webspeech';
    onEngine?.('webspeech');
    onModel?.({ status: 'ready', progress: 100, device: 'webspeech' });
    onStatus?.('mic ok · webspeech ready');
  }

  if (!activeRef.current || myGen !== gen) {
    teardownMedia();
    return;
  }

  const useExpertContinuous = profile === 'expert' && !useWhisperRef.current;

  try {
    if (useExpertContinuous) {
      await expertWebSpeechLoop({
        activeRef, getLang, onInterim, onFinal, onPhase, onLevel, onStatus, myGen,
      });
    } else {
      await vadLoop({
        activeRef, getLang, onInterim, onFinal, onPhase, onLevel, onStatus, myGen,
        useWhisperRef, transcribeAudioFn: transcribeAudio, outdoor,
      });
    }
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
