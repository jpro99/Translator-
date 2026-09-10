/**
 * Stereo earbud routing — translation TTS to left/right channel.
 */
const AZURE_KEY = import.meta.env.VITE_AZURE_TRANSLATOR_KEY || '';
const AZURE_REGION = import.meta.env.VITE_AZURE_TRANSLATOR_REGION || 'westeurope';

let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/** Short stereo cue so wearer knows which ear is active. */
export function playEarCue(ear) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const pan = ctx.createStereoPanner();
  const gain = ctx.createGain();
  osc.frequency.value = ear === 'left' ? 520 : 680;
  gain.gain.value = 0.08;
  pan.pan.value = ear === 'left' ? -1 : 1;
  osc.connect(gain);
  gain.connect(pan);
  pan.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.12);
}

async function azureTtsBlob(text, langCode) {
  if (!AZURE_KEY || !text) return null;
  const voice = langCode.startsWith('it') ? 'it-IT-ElsaNeural' : 'en-US-JennyNeural';
  const ssml = `<speak version="1.0" xml:lang="${langCode}"><voice name="${voice}">${text}</voice></speak>`;
  const res = await fetch(
    `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      },
      body: ssml,
      signal: AbortSignal.timeout?.(8000) ?? undefined,
    },
  );
  if (!res.ok) return null;
  return res.arrayBuffer();
}

async function playBufferPanned(arrayBuffer, pan) {
  const ctx = getCtx();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const src = ctx.createBufferSource();
  const panner = ctx.createStereoPanner();
  src.buffer = audioBuffer;
  panner.pan.value = pan;
  src.connect(panner);
  panner.connect(ctx.destination);
  return new Promise((resolve) => {
    src.onended = resolve;
    src.start();
  });
}

function speakMono(text, langCode) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = langCode;
  u.rate = 0.92;
  const prefix = (langCode || 'en').split('-')[0];
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith(prefix));
  if (voice) u.voice = voice;
  window.speechSynthesis.speak(u);
}

/**
 * Play translation in the target earbud channel.
 * @param {'left'|'right'} ear — left = Person A, right = Person B
 */
export async function speakToEar(text, langCode, ear) {
  if (!text) return;
  const pan = ear === 'left' ? -1 : 1;

  try {
    const buf = await azureTtsBlob(text, langCode);
    if (buf) {
      await playBufferPanned(buf, pan);
      return;
    }
  } catch {}

  playEarCue(ear);
  speakMono(text, langCode);
}

/** Table mode — standard TTS. */
export function speakAloud(text, langCode) {
  speakMono(text, langCode);
}
