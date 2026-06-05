// Character-set validators — used to confirm which language was actually recognized
const HAS_HIRAGANA_KATAKANA = t => /[ぁ-ヿ]/.test(t);
const HAS_HANGUL             = t => /[가-힣ᄀ-ᇿ]/.test(t);
const HAS_CJK                = t => /[一-鿿]/.test(t);
const HAS_DEVANAGARI         = t => /[ऀ-ॿ]/.test(t);
const HAS_THAI               = t => /[฀-๿]/.test(t);
const HAS_ARABIC             = t => /[؀-ۿ]/.test(t);
const HAS_HEBREW             = t => /[֐-׿]/.test(t);
const HAS_CYRILLIC           = t => /[Ѐ-ӿ]/.test(t);
const HAS_GREEK              = t => /[Ͱ-Ͽ]/.test(t);
const LATIN_MIN2             = t => /[a-zA-Z]{2,}/.test(t) && t.trim().length >= 2;

// Generic Android offline speech download instructions
const OFFLINE_STEPS = (lang) => [
  'Open  Android Settings  on your phone',
  'Search for  "Voice Input"  or  "On-device recognition"',
  `Find  ${lang}  in the language list and tap  Download`,
  'Restart Chrome, then return to the app',
];

export const LANGUAGES = {
  // ── East Asia ─────────────────────────────────────────────────────────
  ja:  { key:'ja',  name:'Japanese',   native:'日本語',         flag:'🇯🇵', region:'East Asia',       speechCode:'ja-JP', apiCode:'ja', isMine: HAS_HIRAGANA_KATAKANA },
  ko:  { key:'ko',  name:'Korean',     native:'한국어',          flag:'🇰🇷', region:'East Asia',       speechCode:'ko-KR', apiCode:'ko', isMine: HAS_HANGUL },
  zh:  { key:'zh',  name:'Chinese',    native:'中文 (简体)',     flag:'🇨🇳', region:'East Asia',       speechCode:'zh-CN', apiCode:'zh', isMine: t => HAS_CJK(t) && !HAS_HIRAGANA_KATAKANA(t) },
  'zh-TW': { key:'zh-TW', name:'Chinese (Traditional)', native:'中文 (繁體)', flag:'🇹🇼', region:'East Asia', speechCode:'zh-TW', apiCode:'zh-TW', isMine: t => HAS_CJK(t) && !HAS_HIRAGANA_KATAKANA(t) },

  // ── South / Southeast Asia ────────────────────────────────────────────
  hi:  { key:'hi',  name:'Hindi',      native:'हिन्दी',         flag:'🇮🇳', region:'South Asia',      speechCode:'hi-IN', apiCode:'hi', isMine: HAS_DEVANAGARI },
  th:  { key:'th',  name:'Thai',       native:'ภาษาไทย',        flag:'🇹🇭', region:'Southeast Asia',  speechCode:'th-TH', apiCode:'th', isMine: HAS_THAI },
  vi:  { key:'vi',  name:'Vietnamese', native:'Tiếng Việt',    flag:'🇻🇳', region:'Southeast Asia',  speechCode:'vi-VN', apiCode:'vi', isMine: LATIN_MIN2 },
  id:  { key:'id',  name:'Indonesian', native:'Bahasa Indonesia',flag:'🇮🇩', region:'Southeast Asia', speechCode:'id-ID', apiCode:'id', isMine: LATIN_MIN2 },
  ms:  { key:'ms',  name:'Malay',      native:'Bahasa Melayu', flag:'🇲🇾', region:'Southeast Asia',  speechCode:'ms-MY', apiCode:'ms', isMine: LATIN_MIN2 },
  fil: { key:'fil', name:'Tagalog',    native:'Tagalog',       flag:'🇵🇭', region:'Southeast Asia',  speechCode:'fil-PH',apiCode:'tl', isMine: LATIN_MIN2 },

  // ── Middle East ───────────────────────────────────────────────────────
  ar:  { key:'ar',  name:'Arabic',     native:'العربية',        flag:'🇸🇦', region:'Middle East',     speechCode:'ar-SA', apiCode:'ar', isMine: HAS_ARABIC },
  he:  { key:'he',  name:'Hebrew',     native:'עברית',          flag:'🇮🇱', region:'Middle East',     speechCode:'he-IL', apiCode:'he', isMine: HAS_HEBREW },
  fa:  { key:'fa',  name:'Persian',    native:'فارسی',          flag:'🇮🇷', region:'Middle East',     speechCode:'fa-IR', apiCode:'fa', isMine: HAS_ARABIC },

  // ── Europe (unique scripts) ───────────────────────────────────────────
  ru:  { key:'ru',  name:'Russian',    native:'Русский',        flag:'🇷🇺', region:'Europe',          speechCode:'ru-RU', apiCode:'ru', isMine: HAS_CYRILLIC },
  uk:  { key:'uk',  name:'Ukrainian',  native:'Українська',     flag:'🇺🇦', region:'Europe',          speechCode:'uk-UA', apiCode:'uk', isMine: HAS_CYRILLIC },
  el:  { key:'el',  name:'Greek',      native:'Ελληνικά',       flag:'🇬🇷', region:'Europe',          speechCode:'el-GR', apiCode:'el', isMine: HAS_GREEK },

  // ── Europe (Latin script) ─────────────────────────────────────────────
  es:  { key:'es',  name:'Spanish',    native:'Español',        flag:'🇪🇸', region:'Europe',          speechCode:'es-ES', apiCode:'es', isMine: LATIN_MIN2 },
  fr:  { key:'fr',  name:'French',     native:'Français',       flag:'🇫🇷', region:'Europe',          speechCode:'fr-FR', apiCode:'fr', isMine: LATIN_MIN2 },
  de:  { key:'de',  name:'German',     native:'Deutsch',        flag:'🇩🇪', region:'Europe',          speechCode:'de-DE', apiCode:'de', isMine: LATIN_MIN2 },
  it:  { key:'it',  name:'Italian',    native:'Italiano',       flag:'🇮🇹', region:'Europe',          speechCode:'it-IT', apiCode:'it', isMine: LATIN_MIN2 },
  pt:  { key:'pt',  name:'Portuguese', native:'Português',      flag:'🇧🇷', region:'Europe',          speechCode:'pt-BR', apiCode:'pt', isMine: LATIN_MIN2 },
  nl:  { key:'nl',  name:'Dutch',      native:'Nederlands',     flag:'🇳🇱', region:'Europe',          speechCode:'nl-NL', apiCode:'nl', isMine: LATIN_MIN2 },
  pl:  { key:'pl',  name:'Polish',     native:'Polski',         flag:'🇵🇱', region:'Europe',          speechCode:'pl-PL', apiCode:'pl', isMine: LATIN_MIN2 },
  tr:  { key:'tr',  name:'Turkish',    native:'Türkçe',         flag:'🇹🇷', region:'Europe',          speechCode:'tr-TR', apiCode:'tr', isMine: LATIN_MIN2 },
  sv:  { key:'sv',  name:'Swedish',    native:'Svenska',        flag:'🇸🇪', region:'Europe',          speechCode:'sv-SE', apiCode:'sv', isMine: LATIN_MIN2 },
  no:  { key:'no',  name:'Norwegian',  native:'Norsk',          flag:'🇳🇴', region:'Europe',          speechCode:'nb-NO', apiCode:'no', isMine: LATIN_MIN2 },
  da:  { key:'da',  name:'Danish',     native:'Dansk',          flag:'🇩🇰', region:'Europe',          speechCode:'da-DK', apiCode:'da', isMine: LATIN_MIN2 },
  fi:  { key:'fi',  name:'Finnish',    native:'Suomi',          flag:'🇫🇮', region:'Europe',          speechCode:'fi-FI', apiCode:'fi', isMine: LATIN_MIN2 },
  cs:  { key:'cs',  name:'Czech',      native:'Čeština',        flag:'🇨🇿', region:'Europe',          speechCode:'cs-CZ', apiCode:'cs', isMine: LATIN_MIN2 },
  ro:  { key:'ro',  name:'Romanian',   native:'Română',         flag:'🇷🇴', region:'Europe',          speechCode:'ro-RO', apiCode:'ro', isMine: LATIN_MIN2 },
  hu:  { key:'hu',  name:'Hungarian',  native:'Magyar',         flag:'🇭🇺', region:'Europe',          speechCode:'hu-HU', apiCode:'hu', isMine: LATIN_MIN2 },
  sk:  { key:'sk',  name:'Slovak',     native:'Slovenčina',     flag:'🇸🇰', region:'Europe',          speechCode:'sk-SK', apiCode:'sk', isMine: LATIN_MIN2 },
  hr:  { key:'hr',  name:'Croatian',   native:'Hrvatski',       flag:'🇭🇷', region:'Europe',          speechCode:'hr-HR', apiCode:'hr', isMine: LATIN_MIN2 },

  // ── Africa ────────────────────────────────────────────────────────────
  sw:  { key:'sw',  name:'Swahili',    native:'Kiswahili',      flag:'🇰🇪', region:'Africa',          speechCode:'sw-KE', apiCode:'sw', isMine: LATIN_MIN2 },
  af:  { key:'af',  name:'Afrikaans',  native:'Afrikaans',      flag:'🇿🇦', region:'Africa',          speechCode:'af-ZA', apiCode:'af', isMine: LATIN_MIN2 },
};

// Languages whose scripts are unique enough for fully-automatic hands-free detection.
// Latin-script languages (Spanish, French, etc.) share characters with English and
// require manual tap-to-speak buttons to avoid the two recognizers racing each other.
export const UNIQUE_SCRIPT_KEYS = new Set([
  'ja','ko','zh','zh-TW','hi','th','ar','he','fa','ru','uk','el'
]);

// Sorted array for display (grouped by region, then alphabetical)
const REGION_ORDER = ['East Asia','South Asia','Southeast Asia','Middle East','Europe','Africa'];

export const LANGUAGE_LIST = Object.values(LANGUAGES).sort((a, b) => {
  const ri = REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region);
  return ri !== 0 ? ri : a.name.localeCompare(b.name);
});

// English text detector (Latin chars, no CJK/special scripts)
export function isEnglish(text) {
  if (!text || text.trim().length < 2) return false;
  const hasCJK      = /[一-鿿぀-ヿ]/.test(text);
  const hasArabic   = /[؀-ۿ]/.test(text);
  const hasCyrillic = /[Ѐ-ӿ]/.test(text);
  const hasHebrew   = /[֐-׿]/.test(text);
  const hasThai     = /[฀-๿]/.test(text);
  const hasDevan    = /[ऀ-ॿ]/.test(text);
  const hasLatin    = /[a-zA-Z]{2,}/.test(text);
  const hasGreek    = /[Ͱ-Ͽ]/.test(text);
  return hasLatin && !hasCJK && !hasArabic && !hasCyrillic && !hasHebrew && !hasThai && !hasDevan && !hasGreek;
}

export const ENGLISH = {
  key: 'en', name: 'English', native: 'English', flag: '🇺🇸',
  speechCode: 'en-US', apiCode: 'en', isMine: isEnglish,
};

/** Guess language from transcript text (for labeling listen-mode lines). */
export function detectLanguageFromText(text) {
  if (!text?.trim()) return null;
  if (isEnglish(text)) return ENGLISH;
  for (const lang of LANGUAGE_LIST) {
    if (!lang.isMine(text)) continue;
    if (lang.key === 'ja' && !/[ぁ-ん]/.test(text) && !/[一-鿿]/.test(text)) continue;
    return lang;
  }
  return { key: '?', name: 'Speech', native: '?', flag: '🌐', speechCode: 'en-US', apiCode: 'en' };
}

export { OFFLINE_STEPS };
