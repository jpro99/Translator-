/**
 * On-device Whisper STT via Transformers.js (WebGPU → WASM fallback).
 * No Google / cloud speech required.
 */
import { pipeline, env } from '@huggingface/transformers';

// Side-effect: configure env once
const base = import.meta.env.BASE_URL || '/';
env.allowLocalModels = true;
env.localModelPath = `${base}models/`;
env.useBrowserCache = true;

const MODEL_ID = 'Xenova/whisper-base';
let transcriber = null;
let loadPromise = null;
let backend = 'wasm';

export function getWhisperBackend() {
  return backend;
}

export async function loadWhisper(onProgress) {
  if (transcriber) return transcriber;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
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
  })();

  return loadPromise;
}

export async function transcribeAudio(float32_16k, { language } = {}) {
  if (!transcriber) throw new Error('Whisper not loaded');
  const opts = { task: 'transcribe', return_timestamps: false };
  if (language && language !== 'auto') {
    opts.language = language.split('-')[0];
  }
  const result = await transcriber(float32_16k, opts);
  const text = (result?.text || '').trim();
  return text;
}

export function unloadWhisper() {
  transcriber = null;
  loadPromise = null;
}
