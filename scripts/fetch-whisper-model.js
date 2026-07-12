/**
 * Download quantized Whisper-tiny into public/models so the phone loads it
 * from the same origin (no Hugging Face download at runtime).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..', 'public', 'models', 'Xenova', 'whisper-tiny');
const BASE = 'https://huggingface.co/Xenova/whisper-tiny/resolve/main';

const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'merges.txt',
  'normalizer.json',
  'vocab.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'translator-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        fetchToFile(next, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function main() {
  let missing = 0;
  for (const file of FILES) {
    const dest = path.join(ROOT, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
      console.log('exists', file, fs.statSync(dest).size);
      continue;
    }
    missing += 1;
    process.stdout.write(`download ${file} … `);
    await fetchToFile(`${BASE}/${file}`, dest);
    console.log(fs.statSync(dest).size);
  }
  if (missing === 0) console.log('Whisper model already present');
  else console.log(`Fetched ${missing} Whisper model file(s) → public/models/Xenova/whisper-tiny`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
