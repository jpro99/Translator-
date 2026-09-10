/** Bilingual UI strings (English + Italian) for travelers. */

export const STR = {
  micRequired: {
    en: 'Microphone access is required. Allow it when prompted.',
    it: 'Serve l\'accesso al microfono. Consenti quando richiesto.',
  },
  micDenied: {
    en: 'Microphone access denied — allow it in browser settings.',
    it: 'Microfono negato — consenti nelle impostazioni del browser.',
  },
  speechUnsupported: {
    en: 'Speech recognition needs Chrome or Edge.',
    it: 'Il riconoscimento vocale richiede Chrome o Edge.',
  },
  translateFailed: {
    en: 'Translation unavailable — tap to retry',
    it: 'Traduzione non disponibile — tocca per riprovare',
  },
  translating: {
    en: 'Translating…',
    it: 'Traduzione…',
  },
  listening: {
    en: 'Listening',
    it: 'In ascolto',
  },
  offline: {
    en: 'You\'re offline — translations will retry when connected.',
    it: 'Sei offline — riproveremo quando sei connesso.',
  },
  startConverse: {
    en: 'Start conversation',
    it: 'Inizia conversazione',
  },
  stopConverse: {
    en: 'Stop conversation',
    it: 'Ferma conversazione',
  },
  viaProvider: {
    en: (p) => `via ${p}`,
    it: (p) => `tramite ${p}`,
  },
};

export function t(key, locale = 'en', ...args) {
  const entry = STR[key];
  if (!entry) return key;
  const val = entry[locale] || entry.en;
  return typeof val === 'function' ? val(...args) : val;
}

/** Pick Italian if browser locale is Italian. */
export function uiLocale() {
  const lang = (navigator.language || 'en').toLowerCase();
  return lang.startsWith('it') ? 'it' : 'en';
}

export function bilingual(key, ...args) {
  const loc = uiLocale();
  const primary = t(key, loc, ...args);
  if (loc === 'en') return primary;
  const en = t(key, 'en', ...args);
  return en === primary ? primary : `${primary}\n${en}`;
}
