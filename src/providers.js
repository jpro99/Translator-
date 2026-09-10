import { cleanTranslated } from './translateCore';
import { providerLangVariants } from './languages';

const PROVIDER_TIMEOUT_MS = 1500;

function fetchSignal(ms = PROVIDER_TIMEOUT_MS) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export const LINGVA_HOSTS = [
  'lingva.garudalinux.org',
  'translate.plausibility.cloud',
  'lingva.lunar.icu',
  'lingva.ml',
];

export const LIBRE_HOSTS = [
  'translate.argosopentech.com',
  'libretranslate.com',
];

function sl(from) {
  return from === 'auto' ? 'auto' : from;
}

function providerCode(code) {
  if (!code || code === 'auto') return code;
  const c = code.toLowerCase();
  if (c === 'fil') return 'tl';
  return c;
}

async function withTimeout(promise, ms = PROVIDER_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function ok(text, detected = null) {
  const t = cleanTranslated(text);
  if (!t) throw new Error('empty');
  return { text: t, detected };
}

export async function lingva(text, from, to, host) {
  const froms = from === 'auto' ? ['auto'] : providerLangVariants(from);
  const tos = providerLangVariants(to);
  let lastErr;
  for (const f of froms) {
    for (const t of tos) {
      try {
        const res = await fetch(
          `https://${host}/api/v1/${sl(providerCode(f))}/${providerCode(t)}/${encodeURIComponent(text)}`,
          { signal: fetchSignal() },
        );
        if (!res.ok) throw new Error(`lingva ${res.status}`);
        const data = await res.json();
        return ok(data.translation);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error('lingva');
}

export async function myMemory(text, from, to) {
  const froms = from === 'auto' ? ['Autodetect'] : providerLangVariants(from).map(providerCode);
  const tos = providerLangVariants(to).map(providerCode);
  let lastErr;
  for (const pairFrom of froms) {
    for (const pairTo of tos) {
      try {
        const res = await fetch(
          `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pairFrom}|${pairTo}`,
          { signal: fetchSignal() },
        );
        const data = await res.json();
        if (data.responseStatus !== 200) throw new Error('mymemory');
        return ok(data.responseData?.translatedText, data.responseData?.detectedSourceLanguage);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error('mymemory');
}

export async function libreTranslate(text, from, to, host) {
  const body = {
    q: text,
    source: from === 'auto' ? 'auto' : from,
    target: to,
    format: 'text',
  };
  const res = await fetch(`https://${host}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: fetchSignal(),
  });
  if (!res.ok) throw new Error(`libre ${res.status}`);
  const data = await res.json();
  return ok(data.translatedText, data.detectedLanguage?.language);
}

export async function deepL(text, from, to, apiKey) {
  const params = new URLSearchParams({
    text,
    target_lang: to.toUpperCase().split('-')[0],
  });
  if (from !== 'auto') params.set('source_lang', from.toUpperCase().split('-')[0]);
  const res = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: fetchSignal(),
  });
  if (!res.ok) throw new Error(`deepl ${res.status}`);
  const data = await res.json();
  const translated = data.translations?.[0]?.text;
  const detected = data.translations?.[0]?.detected_source_language?.toLowerCase();
  return ok(translated, detected);
}

export async function azureTranslator(text, from, to, key, region) {
  const route = from === 'auto'
    ? `translate?api-version=3.0&to=${to}`
    : `translate?api-version=3.0&from=${from}&to=${to}`;
  const res = await fetch(
    `https://api.cognitive.microsofttranslator.com/${route}`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Ocp-Apim-Subscription-Region': region || 'westeurope',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ text }]),
      signal: fetchSignal(),
    },
  );
  if (!res.ok) throw new Error(`azure ${res.status}`);
  const data = await res.json();
  const block = data?.[0]?.translations?.[0];
  const detected = data?.[0]?.detectedLanguage?.language;
  return ok(block?.text, detected);
}

/** Google last — often blocked in EU. */
export async function googleGtx(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl(from))}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal: fetchSignal() });
  if (!res.ok) throw new Error(`gtx ${res.status}`);
  const data = await res.json();
  const joined = Array.isArray(data?.[0])
    ? data[0].filter(Boolean).map((p) => p?.[0]).join('')
    : '';
  const detected = typeof data?.[2] === 'string' ? data[2] : null;
  return ok(joined, detected);
}

export async function runProvider(fn) {
  return withTimeout(fn());
}
