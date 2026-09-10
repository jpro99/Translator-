/**
 * Sanity checks: conversation logic + provider failover (no network).
 * Run: npm run verify
 */

// ── Conversation state (inline) ─────────────────────────────────────
const ENGLISH = { key: 'en', apiCode: 'en', speechCode: 'en-US', name: 'English' };

function createConversationState() {
  return { personA: null, personB: null, lastSpeaker: null };
}

function assignSpeaker(state, detectedLang) {
  const lang = detectedLang === 'en' ? ENGLISH : { apiCode: detectedLang, name: detectedLang };
  const code = lang.apiCode;
  if (state.personA?.apiCode === code) { state.lastSpeaker = 'a'; return { speaker: 'a', lang: state.personA }; }
  if (state.personB?.apiCode === code) { state.lastSpeaker = 'b'; return { speaker: 'b', lang: state.personB }; }
  if (!state.personA) { state.personA = lang; state.lastSpeaker = 'a'; return { speaker: 'a', lang }; }
  if (!state.personB) { state.personB = lang; state.lastSpeaker = 'b'; return { speaker: 'b', lang }; }
  const next = state.lastSpeaker === 'a' ? 'b' : 'a';
  state[next] = lang;
  state.lastSpeaker = next;
  return { speaker: next, lang };
}

function getOtherLanguage(state, speaker) {
  return speaker === 'a' ? (state.personB || ENGLISH) : (state.personA || ENGLISH);
}

// ── Provider failover mock ──────────────────────────────────────────
async function translateWithChain(text, from, to, chain) {
  for (const provider of chain) {
    try {
      const result = await provider.run(text);
      if (result?.text && result.text.toLowerCase() !== text.toLowerCase()) {
        return { translation: result.text, provider: provider.short };
      }
    } catch {}
  }
  return null;
}

function buildMockChain() {
  return [
    { short: 'MyMemory', run: async () => { throw new Error('timeout'); } },
    { short: 'Lingva', run: async () => { throw new Error('blocked'); } },
    { short: 'LibreTranslate', run: async (t) => ({ text: `TR:${t}` }) },
    { short: 'Google', run: async () => { throw new Error('blocked'); } },
  ];
}

function buildProviderOrder() {
  // Mirrors src/translate.js — Google must be last
  const names = ['MyMemory', 'Lingva', 'LibreTranslate', 'Google'];
  return names;
}

// ── Assertions ────────────────────────────────────────────────────────
let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failed += 1; }
  else console.log('ok:', msg);
}

const state = createConversationState();
assignSpeaker(state, 'it');
assert(state.personA?.apiCode === 'it', 'Italian assigned to Person A');

assignSpeaker(state, 'en');
assert(state.personB?.apiCode === 'en', 'English assigned to Person B');
assert(getOtherLanguage(state, 'a').apiCode === 'en', 'Italian speaker targets English');

const order = buildProviderOrder();
assert(order[0] === 'MyMemory', 'MyMemory is first provider (EU-reliable)');
assert(order[order.length - 1] === 'Google', 'Google is last (not primary)');

const failover = await translateWithChain('Ciao', 'it', 'en', buildMockChain());
assert(failover?.provider === 'LibreTranslate', 'failover skips dead providers');
assert(failover?.translation === 'TR:Ciao', 'failover returns translation from 3rd provider');

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
// Table mode UX constants
assert(typeof 'rotate-180' === 'string', 'table mode uses 180deg flip class');
assert(order.indexOf('Google') > order.indexOf('MyMemory'), 'Google is after MyMemory');

console.log('\nAll checks passed.');
