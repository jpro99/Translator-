import { ENGLISH, LANGUAGE_LIST, TAGALOG, LANGUAGES, detectLanguageFromText } from './languages';

/** Normalize Google / MyMemory API codes to our apiCode keys. */
export function normalizeApiCode(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c === 'tl' || c === 'fil') return 'tl';
  if (c.startsWith('zh-tw') || c === 'zh-hant') return 'zh-TW';
  if (c.startsWith('zh')) return 'zh';
  return c.split('-')[0];
}

export function findLanguage(apiCode) {
  const norm = normalizeApiCode(apiCode);
  if (!norm || norm === 'en') return ENGLISH;
  const hit = LANGUAGE_LIST.find((l) => l.apiCode === norm || l.key === norm);
  return hit || {
    key: norm,
    name: norm.toUpperCase(),
    native: norm,
    flag: '🌐',
    speechCode: `${norm}-${norm.toUpperCase()}`,
    apiCode: norm,
  };
}

/**
 * Track two speakers and their learned languages.
 */
export function createConversationState() {
  return {
    personA: null,
    personB: null,
    lastSpeaker: null,
  };
}

function slotForLang(state, lang) {
  if (!lang) return null;
  const code = lang.apiCode || lang.key;
  if (state.personA?.apiCode === code) return 'a';
  if (state.personB?.apiCode === code) return 'b';
  return null;
}

/**
 * Assign utterance to person A or B; learn language on first clear utterance per slot.
 */
export function assignSpeaker(state, detectedLang, textHint) {
  const fromApi = detectedLang ? findLanguage(detectedLang) : null;
  const fromText = textHint ? detectLanguageFromText(textHint) : null;
  const lang = fromApi?.apiCode !== 'en' || fromText?.key !== '?'
    ? (fromApi || fromText)
    : (fromText || fromApi || ENGLISH);

  const existing = slotForLang(state, lang);
  if (existing) {
    state.lastSpeaker = existing;
    return { speaker: existing, lang, learned: false };
  }

  if (!state.personA) {
    state.personA = lang;
    state.lastSpeaker = 'a';
    return { speaker: 'a', lang, learned: true };
  }
  if (!state.personB) {
    state.personB = lang;
    state.lastSpeaker = 'b';
    return { speaker: 'b', lang, learned: true };
  }

  // Both slots taken but new/different detection — alternate from last speaker
  const next = state.lastSpeaker === 'a' ? 'b' : 'a';
  state[next] = lang;
  state.lastSpeaker = next;
  return { speaker: next, lang, learned: true };
}

export function getOtherLanguage(state, speaker) {
  if (speaker === 'a') return state.personB || ENGLISH;
  return state.personA || ENGLISH;
}

/**
 * Pick speech-recognition language(s) for the next utterance.
 * Expect turn-taking: listen in the other person's language when known.
 */
export function getRecognitionSpeechCodes(state) {
  const codes = [];
  const push = (lang) => {
    if (!lang?.speechCode) return;
    if (!codes.includes(lang.speechCode)) codes.push(lang.speechCode);
  };

  if (!state.personA && !state.personB) {
    push(TAGALOG);
    push(LANGUAGES.it);
    push(ENGLISH);
    return codes;
  }

  const last = state.lastSpeaker;
  if (last === 'a' && state.personB) push(state.personB);
  else if (last === 'b' && state.personA) push(state.personA);
  else {
    push(state.personA);
    push(state.personB);
  }

  push(ENGLISH);
  return codes.length ? codes : [ENGLISH.speechCode];
}

export function speakerLabel(speaker, state) {
  const lang = speaker === 'a' ? state.personA : state.personB;
  if (!lang) return speaker === 'a' ? 'Person A' : 'Person B';
  return `${speaker === 'a' ? 'Person A' : 'Person B'} · ${lang.flag} ${lang.name}`;
}
