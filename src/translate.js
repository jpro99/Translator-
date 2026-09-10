import { cacheGet, cacheSet } from './cache';
import { cleanTranslated, isUsefulTranslation } from './translateCore';
import { providerLangVariants } from './languages';
import {
  LINGVA_HOSTS,
  LIBRE_HOSTS,
  lingva,
  myMemory,
  libreTranslate,
  deepL,
  azureTranslator,
  googleGtx,
  runProvider,
} from './providers';

export { cleanTranslated } from './translateCore';

const DEEPL_KEY = import.meta.env.VITE_DEEPL_API_KEY || '';
const AZURE_KEY = import.meta.env.VITE_AZURE_TRANSLATOR_KEY || '';
const AZURE_REGION = import.meta.env.VITE_AZURE_TRANSLATOR_REGION || 'westeurope';

/** Build ordered provider list — EU-friendly first, Google last. */
export function buildProviderChain(from, to) {
  const chain = [];

  // MyMemory (Italian company) — most reliable free tier from EU
  chain.push({
    id: 'MyMemory',
    short: 'MyMemory',
    run: (text) => myMemory(text, from, to),
  });

  for (const host of LINGVA_HOSTS) {
    chain.push({
      id: `Lingva (${host.split('.')[0]})`,
      short: 'Lingva',
      run: (text) => lingva(text, from, to, host),
    });
  }

  for (const host of LIBRE_HOSTS) {
    chain.push({
      id: `LibreTranslate (${host.split('.')[0]})`,
      short: 'LibreTranslate',
      run: (text) => libreTranslate(text, from, to, host),
    });
  }

  if (DEEPL_KEY) {
    chain.push({
      id: 'DeepL',
      short: 'DeepL',
      run: (text) => deepL(text, from, to, DEEPL_KEY),
    });
  }

  if (AZURE_KEY) {
    chain.push({
      id: 'Azure',
      short: 'Azure',
      run: (text) => azureTranslator(text, from, to, AZURE_KEY, AZURE_REGION),
    });
  }

  chain.push({
    id: 'Google',
    short: 'Google',
    run: (text) => googleGtx(text, from, to),
  });

  return chain;
}

/** Exported for tests — failover without network. */
export async function translateWithChain(text, from, to, chain, { timeoutMs = 1500 } = {}) {
  const raw = (text || '').trim();
  if (!raw) return null;
  if (from !== 'auto' && from === to) {
    return { translation: cleanTranslated(raw), detectedLang: from, provider: 'local' };
  }

  let lastSame = null;
  let lastDetected = null;
  let lastProvider = null;

  for (const provider of chain) {
    try {
      const { text: translated, detected } = await runProvider(
        () => provider.run(raw),
        timeoutMs,
      );
      if (detected) lastDetected = detected;
      if (!translated) continue;
      lastProvider = provider.short;
      if (isUsefulTranslation(raw, translated)) {
        return {
          translation: translated,
          detectedLang: lastDetected,
          provider: provider.short,
        };
      }
      lastSame = translated;
    } catch {
      // try next provider
    }
  }

  if (lastSame) {
    return { translation: lastSame, detectedLang: lastDetected, provider: lastProvider || 'fallback' };
  }
  return null;
}

export async function translate(text, from, to) {
  const result = await translateWithDetection(text, from, to);
  return result?.translation ?? null;
}

export async function translateWithDetection(text, from, to) {
  const raw = (text || '').trim();
  if (!raw) return null;
  if (from !== 'auto' && from === to) {
    return { translation: cleanTranslated(raw), detectedLang: from, provider: 'local' };
  }

  const cached = await cacheGet(raw, from, to);
  if (cached?.translation) return cached;

  const attempts = [{ from: 'auto', to }];
  if (from !== 'auto') {
    const fromCodes = [...new Set(providerLangVariants(from))];
    const toCodes = [...new Set(providerLangVariants(to))];
    for (const f of fromCodes) {
      for (const t of toCodes) {
        attempts.push({ from: f, to: t });
      }
    }
  }

  for (const { from: f, to: t } of attempts) {
    const chain = buildProviderChain(f, t);
    const result = await translateWithChain(raw, f, t, chain);
    if (result?.translation) {
      await cacheSet(raw, from, to, result);
      return result;
    }
  }

  return null;
}

/** Re-export chain builder pieces for verify script. */
export { LINGVA_HOSTS, LIBRE_HOSTS } from './providers';
