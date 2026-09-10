/**
 * On-device Whisper STT via Transformers.js (WebGPU → WASM fallback).
 */
import { pipeline, env } from '@huggingface/transformers';

const base = import.meta.env.BASE_URL || '/';
env.allowLocalModels = true;
env.localModelPath = `${base}models/`;
env.useBrowserCache = true;

const MODEL_ID = 'Xenova/whisper-base';
const LOAD_TIMEOUT_MS = 45000;
const TRANSCRIBE_TIMEOUT_MS = 12000;

let transcriber = null;
let loadPromise = null;
let backend = 'wasm';

export function getWhisperBackend() {
  return backend;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    }),
  ]);
}

export async function loadWhisper(onProgress) {
  if (transcriber) return transcriber;
  if (loadPromise) return loadPromise;

  loadPromise = withTimeout((async () => {
    const devices = [];
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) devices.push('webgpu');
      } catch {}
    }
    devices.push('wasm');

    let lastErr;
    for (const device of devices) {
      try {
        onProgress?.({ status: 'loading', device, progress: 0 });
        transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
          device,
          dtype: device === 'webgpu' ? 'fp32' : 'q8',
          progress_callback: (p) => {
            if (p.status === 'progress') {
              onProgress?.({
                status: 'loading',
                device,
                progress: Math.round((p.progress || 0) * 100),
                file: p.file,
              });
            }
          },
        });
        backend = device;
        onProgress?.({ status: 'ready', device, progress: 100 });
        return transcriber;
      } catch (e) {
        lastErr = e;
        transcriber = null;
      }
    }
    loadPromise = null;
    throw lastErr || new Error('Whisper failed to load');
  })(), LOAD_TIMEOUT_MS, 'Whisper load');

  try {
    return await loadPromise;
  } catch (e) {
    loadPromise = null;
    throw e;
  }
}

function normalizeWhisperLang(language) {
  if (!language || language === 'auto') return null;
  const c = language.split('-')[0].toLowerCase();
  if (c === 'fil') return 'tl';
  return c;
}

export async function transcribeAudio(float32_16k, { language } = {}) {
  if (!transcriber) throw new Error('Whisper not loaded');
  const opts = { task: 'transcribe', return_timestamps: false };
  const lang = normalizeWhisperLang(language);
  if (lang) opts.language = lang;
  const result = await withTimeout(
    transcriber(float32_16k, opts),
    TRANSCRIBE_TIMEOUT_MS,
    'Whisper transcribe',
  );
  return (result?.text || '').trim();
}

export function unloadWhisper() {
  transcriber = null;
  loadPromise = null;
}
