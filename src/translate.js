const CACHE_KEY = 'tr_v2';

const _cacheInit = (() => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch { return []; }
})();
const translationCache = new Map(_cacheInit);

try { localStorage.removeItem('tr_v1'); } catch {}

function persistCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify([...translationCache.entries()].slice(-900)));
  } catch {}
}

export function cleanTranslated(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function translateViaGoogle(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gtx ${res.status}`);
  const data = await res.json();
  const joined = Array.isArray(data?.[0])
    ? data[0].filter(Boolean).map((p) => p?.[0]).join('')
    : '';
  const detected = typeof data?.[2] === 'string' ? data[2] : null;
  return { text: cleanTranslated(joined), detected };
}

async function translateViaMyMemory(text, from, to) {
  const pairFrom = from === 'auto' ? 'Autodetect' : from;
  const res = await fetch(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pairFrom}|${to}`,
  );
  const data = await res.json();
  if (data.responseStatus !== 200) throw new Error('mymemory');
  const detected = data.responseData?.detectedSourceLanguage || null;
  return { text: cleanTranslated(data.responseData?.translatedText), detected };
}

async function translateViaLingva(text, from, to) {
  const sl = from === 'auto' ? 'auto' : from;
  const res = await fetch(`https://lingva.ml/api/v1/${sl}/${to}/${encodeURIComponent(text)}`);
  if (!res.ok) throw new Error(`lingva ${res.status}`);
  const data = await res.json();
  return { text: cleanTranslated(data.translation), detected: null };
}

/**
 * Translate with auto-detect first, then explicit lang. Returns translated text.
 */
export async function translate(text, from, to) {
  const result = await translateWithDetection(text, from, to);
  return result?.translation ?? null;
}

/**
 * Translate and return detected source language (Google gtx index 2 when available).
 */
export async function translateWithDetection(text, from, to) {
  const raw = (text || '').trim();
  if (!raw) return null;
  if (from !== 'auto' && from === to) {
    return { translation: cleanTranslated(raw), detectedLang: from };
  }

  const key = `${raw}|${from}|${to}`;
  const cached = translationCache.get(key);
  if (cached) {
    return typeof cached === 'string'
      ? { translation: cached, detectedLang: from === 'auto' ? null : from }
      : cached;
  }

  const save = (result) => {
    if (!result?.translation) return null;
    translationCache.set(key, result);
    persistCache();
    return result;
  };

  const attempts = [
    () => translateViaGoogle(raw, 'auto', to),
    () => translateViaGoogle(raw, from === 'auto' ? 'auto' : from, to),
    () => translateViaMyMemory(raw, from === 'auto' ? 'Autodetect' : from, to),
    () => translateViaLingva(raw, from === 'auto' ? 'auto' : from, to),
  ];

  let lastSame = null;
  let lastDetected = null;
  for (const attempt of attempts) {
    try {
      const { text: translated, detected } = await attempt();
      if (detected) lastDetected = detected;
      if (!translated) continue;
      if (translated.toLowerCase() !== raw.toLowerCase()) {
        return save({ translation: translated, detectedLang: lastDetected });
      }
      lastSame = translated;
    } catch {}
  }

  if (lastSame) {
    return save({ translation: lastSame, detectedLang: lastDetected });
  }
  return null;
}
