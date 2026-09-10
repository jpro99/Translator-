/**
 * Quick sanity check for conversation speaker assignment (no browser needed).
 * Run: node scripts/verify-conversation.mjs
 */

const ENGLISH = { key: 'en', apiCode: 'en', speechCode: 'en-US', name: 'English' };

function normalizeApiCode(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c === 'tl' || c === 'fil') return 'tl';
  if (c.startsWith('zh-tw') || c === 'zh-hant') return 'zh-TW';
  if (c.startsWith('zh')) return 'zh';
  return c.split('-')[0];
}

function createConversationState() {
  return { personA: null, personB: null, lastSpeaker: null };
}

function assignSpeaker(state, detectedLang, textHint) {
  const lang = detectedLang === 'en' ? ENGLISH : { apiCode: normalizeApiCode(detectedLang), name: detectedLang };
  const code = lang.apiCode;
  if (state.personA?.apiCode === code) {
    state.lastSpeaker = 'a';
    return { speaker: 'a', lang: state.personA };
  }
  if (state.personB?.apiCode === code) {
    state.lastSpeaker = 'b';
    return { speaker: 'b', lang: state.personB };
  }
  if (!state.personA) {
    state.personA = lang;
    state.lastSpeaker = 'a';
    return { speaker: 'a', lang };
  }
  if (!state.personB) {
    state.personB = lang;
    state.lastSpeaker = 'b';
    return { speaker: 'b', lang };
  }
  const next = state.lastSpeaker === 'a' ? 'b' : 'a';
  state[next] = lang;
  state.lastSpeaker = next;
  return { speaker: next, lang };
}

function getOtherLanguage(state, speaker) {
  return speaker === 'a' ? (state.personB || ENGLISH) : (state.personA || ENGLISH);
}

function getRecognitionSpeechCodes(state) {
  const codes = [];
  const push = (lang) => {
    if (lang?.speechCode && !codes.includes(lang.speechCode)) codes.push(lang.speechCode);
  };
  if (!state.personA && !state.personB) {
    push(ENGLISH);
    return codes;
  }
  if (state.lastSpeaker === 'a' && state.personB) push(state.personB);
  else if (state.lastSpeaker === 'b' && state.personA) push(state.personA);
  else {
    push(state.personA);
    push(state.personB);
  }
  push(ENGLISH);
  return codes.length ? codes : [ENGLISH.speechCode];
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  } else {
    console.log('ok:', msg);
  }
}

const state = createConversationState();
assignSpeaker(state, 'es', 'Hola');
assert(state.personA?.apiCode === 'es', 'first speaker learns Spanish');

assignSpeaker(state, 'en', 'Hello');
assert(state.personB?.apiCode === 'en', 'second speaker learns English');

assert(getOtherLanguage(state, 'a').apiCode === 'en', 'person A translates to English');
assert(getRecognitionSpeechCodes(state).includes('en-US'), 'recognition includes English');
assert(normalizeApiCode('tl') === 'tl', 'Tagalog code normalizes');

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll conversation checks passed.');
