/** PCM helpers — no heavy deps. */

export function whisperSupported() {
  return !!(navigator.mediaDevices && (window.AudioContext || window.webkitAudioContext));
}

export function resampleTo16k(chunks, sampleRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (!total) return new Float32Array(0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  if (sampleRate === 16000) return merged;
  const ratio = sampleRate / 16000;
  const outLen = Math.floor(merged.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, merged.length - 1);
    const frac = idx - i0;
    out[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
  }
  return out;
}
