import { useState, useRef, useEffect, useCallback } from 'react';
import {
  LANGUAGE_LIST,
  ENGLISH,
  detectLanguageFromText,
  isEnglish,
  UNIQUE_SCRIPT_KEYS,
} from './languages';
import {
  speechSupported,
  stopMic,
  restartMic,
  keepListening,
} from './speech';

/* ─── Translation ───────────────────────────────────────────────────── */
const _cacheInit = (() => {
  try { return JSON.parse(localStorage.getItem('tr_v1') || '[]'); } catch { return []; }
})();
const translationCache = new Map(_cacheInit);

function persistCache() {
  try {
    localStorage.setItem('tr_v1', JSON.stringify([...translationCache.entries()].slice(-900)));
  } catch {}
}

function cleanTranslated(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function translateViaGoogle(text, from, to) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gtx ${res.status}`);
  const data = await res.json();
  const joined = Array.isArray(data?.[0])
    ? data[0].filter(Boolean).map((p) => p?.[0]).join('')
    : '';
  return cleanTranslated(joined);
}

async function translateViaMyMemory(text, from, to) {
  const res = await fetch(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`,
  );
  const data = await res.json();
  if (data.responseStatus !== 200) throw new Error('mymemory');
  return cleanTranslated(data.responseData?.translatedText);
}

async function translateViaLingva(text, from, to) {
  const res = await fetch(`https://lingva.ml/api/v1/${from}/${to}/${encodeURIComponent(text)}`);
  if (!res.ok) throw new Error(`lingva ${res.status}`);
  const data = await res.json();
  return cleanTranslated(data.translation);
}

/**
 * Translate with retries + auto-detect fallback.
 * Returns the best available translation (may equal source for proper nouns).
 */
async function translate(text, from, to) {
  const raw = (text || '').trim();
  if (!raw) return null;
  if (from === to) return raw;

  const key = `${raw}|${from}|${to}`;
  if (translationCache.has(key)) return translationCache.get(key);

  const save = (r) => {
    if (!r) return null;
    translationCache.set(key, r);
    persistCache();
    return r;
  };

  const attempts = [
    () => translateViaGoogle(raw, from, to),
    () => translateViaGoogle(raw, 'auto', to),
    () => translateViaMyMemory(raw, from, to),
    () => translateViaLingva(raw, from, to),
  ];

  let lastSame = null;
  for (const attempt of attempts) {
    try {
      const r = await attempt();
      if (!r) continue;
      // Prefer a result that actually changed; keep same-text as last resort
      if (r.toLowerCase() !== raw.toLowerCase()) return save(r);
      lastSame = r;
    } catch {}
  }
  return lastSame ? save(lastSame) : null;
}

/* ─── Helpers ───────────────────────────────────────────────────────── */
let _id = 0;
const nextId = () => ++_id;

const norm = (t) => (t || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.,!?…]+$/g, '');

const PINNED = ['ja', 'ko', 'fil', 'es', 'fr', 'de', 'zh'];

function formatTime(d = new Date()) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function looksLikeForeign(text, lang) {
  if (!text?.trim()) return false;
  if (UNIQUE_SCRIPT_KEYS.has(lang.key)) {
    if (!lang.isMine?.(text)) return false;
    if (lang.key === 'ja') {
      const hasHiragana = /[ぁ-ん]/.test(text);
      const hasKanji = /[一-鿿]/.test(text);
      if (!hasHiragana && !hasKanji) return false;
    }
    return true;
  }
  // Latin-script: accept anything from that recognizer that isn't clearly English
  return !isEnglish(text);
}

/* ─── App ───────────────────────────────────────────────────────────── */
export default function App() {
  const [tab, setTab] = useState('listen');

  /* Listen tab */
  const [listening, setListening] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectingLang, setDetectingLang] = useState(null);
  const [listenLang, setListenLang] = useState(null);
  const [listenLines, setListenLines] = useState([]);
  const [listenInterim, setListenInterim] = useState('');
  const [listenStatus, setListenStatus] = useState('');
  const listenActiveRef = useRef(false);
  const listenDetectRef = useRef(true);
  const listenLangRef = useRef(null);
  const listenSeenRef = useRef(new Set());

  /* Conversation tab */
  const [language, setLanguage] = useState(() =>
    LANGUAGE_LIST.find((l) => l.key === 'ja') || LANGUAGE_LIST[0]
  );
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langPickerFor, setLangPickerFor] = useState('converse');
  const [langSearch, setLangSearch] = useState('');
  const [messages, setMessages] = useState([]);
  const [conversing, setConversing] = useState(false);
  const [converseFocus, setConverseFocus] = useState('them');
  const [turnInterim, setTurnInterim] = useState('');
  const [converseStatus, setConverseStatus] = useState('');
  const [ttsOn, setTtsOn] = useState(false);
  const [micError, setMicError] = useState(null);

  const converseActiveRef = useRef(false);
  const converseFocusRef = useRef('them');
  const languageRef = useRef(language);
  const ttsOnRef = useRef(false);
  const seenRef = useRef(new Set());
  // Short lock so we don't print the same final twice from overlapping restarts
  const recentLockRef = useRef([]);

  const listEndRef = useRef(null);
  const chatEndRef = useRef(null);

  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { converseFocusRef.current = converseFocus; }, [converseFocus]);
  useEffect(() => { listenLangRef.current = listenLang; }, [listenLang]);
  useEffect(() => { ttsOnRef.current = ttsOn; }, [ttsOn]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [listenLines, listenInterim]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, turnInterim]);

  useEffect(() => () => {
    listenActiveRef.current = false;
    converseActiveRef.current = false;
    listenDetectRef.current = false;
    stopMic();
  }, []);

  const isRecentDupe = useCallback((text) => {
    const n = norm(text);
    if (!n) return true;
    const now = Date.now();
    recentLockRef.current = recentLockRef.current.filter((u) => now - u.t < 8000);
    if (recentLockRef.current.some((u) => u.n === n)) return true;
    recentLockRef.current.push({ n, t: now });
    if (recentLockRef.current.length > 30) {
      recentLockRef.current = recentLockRef.current.slice(-20);
    }
    return false;
  }, []);

  const remember = useCallback((text, store = seenRef) => {
    const n = norm(text);
    if (!n || store.current.has(n)) return false;
    store.current.add(n);
    if (store.current.size > 60) {
      store.current = new Set([...store.current].slice(-30));
    }
    return true;
  }, []);

  const speak = useCallback((text, langCode) => {
    if (!ttsOnRef.current || !text || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langCode;
    u.rate = 0.92;
    window.speechSynthesis.speak(u);
  }, []);

  /* ── Listen mode ── */
  const addListenLine = useCallback(async (text, lang) => {
    if (isRecentDupe(text) || !remember(text, listenSeenRef)) return;
    const id = nextId();
    const time = formatTime();
    setListenLines((prev) => [...prev, {
      id, text, translation: null, translating: true, lang, time,
    }]);
    setListenInterim('');

    const toEn = lang.key === 'en'
      ? text
      : await translate(text, lang.apiCode, 'en');

    setListenLines((prev) => prev.map((line) => (
      line.id === id
        ? { ...line, translation: toEn || text, translating: false }
        : line
    )));
  }, [remember, isRecentDupe]);

  const runListenLoop = useCallback(async (lang) => {
    setListenStatus(`Listening · ${lang.name}`);
    listenLangRef.current = lang;
    setListenLang(lang);

    await keepListening({
      activeRef: listenActiveRef,
      getLang: () => listenLangRef.current?.speechCode || lang.speechCode,
      onInterim: (t) => {
        if (listenActiveRef.current) setListenInterim(t || '');
      },
      onFinal: async (text) => {
        if (!listenActiveRef.current) return;
        setListenInterim('');
        const current = listenLangRef.current || lang;
        const guessed = detectLanguageFromText(text);
        const useLang = (guessed && guessed.key !== '?' && guessed.key !== 'en' && UNIQUE_SCRIPT_KEYS.has(guessed.key))
          ? guessed
          : current;
        if (useLang.key !== current.key && useLang.speechCode) {
          listenLangRef.current = useLang;
          setListenLang(useLang);
          setListenStatus(`Listening · ${useLang.name}`);
        }
        void addListenLine(text, useLang.key === 'en' ? ENGLISH : useLang);
      },
      onError: (msg) => {
        setMicError(msg);
        listenActiveRef.current = false;
        setListening(false);
        setListenStatus('');
      },
    });

    if (!listenActiveRef.current) {
      setListening(false);
      setListenInterim('');
      setListenStatus('');
    }
  }, [addListenLine]);

  const stopListen = useCallback(() => {
    listenActiveRef.current = false;
    listenDetectRef.current = false;
    setListening(false);
    setDetecting(false);
    setDetectingLang(null);
    setListenInterim('');
    setListenStatus('');
    void stopMic();
  }, []);

  const toggleListen = useCallback(async () => {
    if (!speechSupported()) {
      setMicError('Use Chrome or Edge for speech recognition.');
      return;
    }
    if (listening || detecting) {
      stopListen();
      return;
    }

    converseActiveRef.current = false;
    setConversing(false);
    await stopMic();

    setMicError(null);
    listenSeenRef.current.clear();
    recentLockRef.current = [];

    // Don't auto-scan languages — each probe beeps on Android.
    // Pick once, then Start listens calmly.
    let lang = listenLangRef.current;
    if (!lang) {
      setLangPickerFor('listen');
      setShowLangPicker(true);
      setMicError('Pick their language, then tap Start listening.');
      return;
    }

    listenActiveRef.current = true;
    listenDetectRef.current = true;
    setListening(true);
    await runListenLoop(lang);
  }, [listening, detecting, runListenLoop, stopListen]);

  const pickListenLanguage = useCallback(async (lang) => {
    setShowLangPicker(false);
    setLangSearch('');
    setMicError(null);

    listenLangRef.current = lang;
    setListenLang(lang);

    if (listenActiveRef.current) {
      setListenStatus(`Listening · ${lang.name}`);
      restartMic();
      return;
    }

    // Choosing a language shouldn't auto-start — user taps Start.
    // Unless they came from the Start flow toast.
  }, []);

  /* ── Conversation mode ── */
  const stopConverse = useCallback(() => {
    converseActiveRef.current = false;
    setConversing(false);
    setTurnInterim('');
    setConverseStatus('');
    void stopMic();
  }, []);

  const addConverseMessage = useCallback(async (who, said, fromCode, toCode, speakLang) => {
    if (isRecentDupe(said) || !remember(said, seenRef)) return;
    const id = nextId();
    setMessages((prev) => [...prev, {
      id, who, said, translation: null, translating: true,
    }]);
    setTurnInterim('');

    const translated = await translate(said, fromCode, toCode);
    setMessages((prev) => prev.map((m) => (
      m.id === id
        ? { ...m, translation: translated || said, translating: false }
        : m
    )));
    if (translated && translated !== said) speak(translated, speakLang);
  }, [remember, speak, isRecentDupe]);

  const handleConverseFinal = useCallback(async (text) => {
    if (!converseActiveRef.current) return;
    setTurnInterim('');
    const lang = languageRef.current;
    const focus = converseFocusRef.current;
    const listeningForYou = focus === 'you';

    if (listeningForYou) {
      if (!isEnglish(text) && looksLikeForeign(text, lang)) {
        void addConverseMessage('them', text, lang.apiCode, 'en', ENGLISH.speechCode);
        return;
      }
      void addConverseMessage('you', text, 'en', lang.apiCode, lang.speechCode);
      converseFocusRef.current = 'them';
      setConverseFocus('them');
      setConverseStatus(`Listening · ${lang.name}`);
      restartMic(); // switch recognizer language, stay in continuous mode
      return;
    }

    // Listening for them
    if (isEnglish(text) && !looksLikeForeign(text, lang)) {
      void addConverseMessage('you', text, 'en', lang.apiCode, lang.speechCode);
      return;
    }

    if (looksLikeForeign(text, lang) || !UNIQUE_SCRIPT_KEYS.has(lang.key)) {
      void addConverseMessage('them', text, lang.apiCode, 'en', ENGLISH.speechCode);
      converseFocusRef.current = 'you';
      setConverseFocus('you');
      setConverseStatus('Listening · English');
      restartMic();
    }
  }, [addConverseMessage]);

  const runConversationLoop = useCallback(async () => {
    setConverseStatus(`Listening · ${languageRef.current.name}`);

    await keepListening({
      activeRef: converseActiveRef,
      getLang: () => (
        converseFocusRef.current === 'you'
          ? ENGLISH.speechCode
          : (languageRef.current?.speechCode || 'en-US')
      ),
      onInterim: (t) => {
        if (converseActiveRef.current) setTurnInterim(t || '');
      },
      onFinal: handleConverseFinal,
      onError: (msg) => {
        setMicError(msg);
        converseActiveRef.current = false;
        setConversing(false);
        setConverseStatus('');
      },
    });

    if (!converseActiveRef.current) {
      setConversing(false);
      setTurnInterim('');
      setConverseStatus('');
    }
  }, [handleConverseFinal]);

  const toggleConverse = useCallback(async () => {
    if (!speechSupported()) {
      setMicError('Use Chrome or Edge for speech recognition.');
      return;
    }
    if (conversing) {
      stopConverse();
      return;
    }

    stopListen();
    await stopMic();

    setMicError(null);
    seenRef.current.clear();
    recentLockRef.current = [];
    converseActiveRef.current = true;
    converseFocusRef.current = 'them';
    setConverseFocus('them');
    setConversing(true);
    await runConversationLoop();
  }, [conversing, stopConverse, stopListen, runConversationLoop]);

  const setFocus = useCallback((who) => {
    if (converseFocusRef.current === who) return;
    converseFocusRef.current = who;
    setConverseFocus(who);
    const lang = languageRef.current;
    setConverseStatus(
      who === 'you'
        ? 'Listening · English'
        : `Listening · ${lang.name}`,
    );
    setTurnInterim('');
    if (converseActiveRef.current) restartMic();
  }, []);

  /* ── Language picker ── */
  const filteredLangs = langSearch.trim()
    ? LANGUAGE_LIST.filter((l) =>
      l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
      l.native.toLowerCase().includes(langSearch.toLowerCase()))
    : LANGUAGE_LIST;

  const pinnedLangs = PINNED.map((k) => LANGUAGE_LIST.find((l) => l.key === k)).filter(Boolean);

  const selectLanguage = useCallback((lang) => {
    if (langPickerFor === 'listen') {
      pickListenLanguage(lang);
      return;
    }
    setLanguage(lang);
    setShowLangPicker(false);
    setLangSearch('');
    if (converseActiveRef.current) {
      setConverseStatus(
        converseFocusRef.current === 'you'
          ? 'Listening · English'
          : `Listening · ${lang.name}`,
      );
      restartMic();
    }
  }, [langPickerFor, pickListenLanguage]);

  const switchTab = (next) => {
    stopListen();
    stopConverse();
    setTab(next);
  };

  return (
    <div className="app">
      <main className="main">
        {tab === 'listen' && (
          <div className="panel">
            <header className="header header-row">
              <div>
                <h1 className="header-title">Listen</h1>
                <p className="header-sub">Overhear → English translation</p>
                <button
                  type="button"
                  className="lang-chip"
                  onClick={() => {
                    setLangPickerFor('listen');
                    setShowLangPicker(true);
                  }}
                >
                  {listenLang
                    ? `${listenLang.flag} ${listenLang.name} ▾`
                    : 'Pick language ▾'}
                </button>
              </div>
            </header>

            <div className="scroll">
              {listenLines.length === 0 && !listenInterim && !detecting && (
                <div className="empty">
                  <span className="empty-icon">👂</span>
                  <p>Pick their language, then tap Start. It stays on and types as they talk.</p>
                  <p className="empty-note">Tap Stop only when you’re finished.</p>
                </div>
              )}

              {detecting && (
                <div className="empty">
                  <span className="empty-icon">🔎</span>
                  <p>Detecting language…</p>
                  {detectingLang && (
                    <p className="empty-note">Trying {detectingLang.flag} {detectingLang.name}</p>
                  )}
                  <p className="empty-note">Ask them to keep talking for a few seconds.</p>
                </div>
              )}

              {listenLines.map((line) => (
                <article key={line.id} className="line-card">
                  <div className="line-meta">
                    <span>{line.lang.flag} {line.lang.name}</span>
                    <span className="line-time">{line.time}</span>
                  </div>
                  <p className="line-text">{line.text}</p>
                  <p className="line-arrow">↓ English</p>
                  <p className={`line-trans ${line.translating ? 'is-pending' : ''}`}>
                    {line.translating ? 'Translating…' : line.translation}
                  </p>
                </article>
              ))}

              {listenInterim && (
                <article className="line-card line-interim">
                  <p className="line-text">{listenInterim}</p>
                </article>
              )}
              <div ref={listEndRef} />
            </div>

            <div className="action-bar">
              {(listenLines.length > 0 || listenLang) && !listening && (
                <div className="action-row">
                  {listenLines.length > 0 && (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        setListenLines([]);
                        listenSeenRef.current.clear();
                      }}
                    >
                      Clear
                    </button>
                  )}
                  {listenLang && (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        listenLangRef.current = null;
                        setListenLang(null);
                      }}
                    >
                      Reset language
                    </button>
                  )}
                </div>
              )}
              {listenStatus && <p className="turn-status">{listenStatus}</p>}
              <button
                type="button"
                className={`listen-btn ${listening || detecting ? 'listen-btn-on' : ''}`}
                onClick={toggleListen}
              >
                <span className="listen-btn-dot" />
                {listening || detecting ? 'Stop listening' : 'Start listening'}
              </button>
            </div>
          </div>
        )}

        {tab === 'translate' && (
          <div className="panel">
            <header className="header header-row">
              <div>
                <h1 className="header-title">Talk</h1>
                <button
                  type="button"
                  className="lang-chip"
                  onClick={() => {
                    setLangPickerFor('converse');
                    setShowLangPicker(true);
                  }}
                >
                  {language.flag} {language.name} ↔ English ▾
                </button>
              </div>
              <button
                type="button"
                className={`icon-toggle ${ttsOn ? 'icon-toggle-on' : ''}`}
                onClick={() => setTtsOn((v) => !v)}
                aria-label="Speaker"
              >
                {ttsOn ? '🔊' : '🔇'}
              </button>
            </header>

            <div className="scroll scroll-chat">
              {messages.length === 0 && !turnInterim && (
                <div className="empty">
                  <span className="empty-icon">💬</span>
                  <p>Tap Start. It stays on and prints both languages as each person talks.</p>
                  <p className="empty-note">
                    English ↔ {language.name}. Tap You / Them to switch who the mic is set for.
                  </p>
                </div>
              )}

              {messages.map((msg) => (
                <article key={msg.id} className={`chat ${msg.who === 'you' ? 'chat-you' : 'chat-them'}`}>
                  <div className="chat-label">
                    {msg.who === 'you' ? 'You · English' : `Them · ${language.name}`}
                  </div>
                  <p className="chat-said">{msg.said}</p>
                  <p className="chat-arrow">↓ {msg.who === 'you' ? language.name : 'English'}</p>
                  <p className={`chat-trans ${msg.translating ? 'is-pending' : ''}`}>
                    {msg.translating ? 'Translating…' : msg.translation}
                  </p>
                </article>
              ))}

              {turnInterim && (
                <article className="chat chat-interim">
                  <div className="chat-label">
                    {converseFocus === 'you' ? 'You · English' : `Them · ${language.name}`}
                  </div>
                  <p className="chat-said">{turnInterim}</p>
                </article>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="turn-bar">
              {messages.length > 0 && !conversing && (
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    setMessages([]);
                    seenRef.current.clear();
                  }}
                >
                  Clear
                </button>
              )}

              {conversing && (
                <div className="turn-btns">
                  <button
                    type="button"
                    className={`turn-btn turn-you ${converseFocus === 'you' ? 'turn-active' : ''}`}
                    onClick={() => setFocus('you')}
                  >
                    <span className="turn-emoji">🇺🇸</span>
                    <span className="turn-label">You</span>
                    <span className="turn-hint">English</span>
                  </button>
                  <button
                    type="button"
                    className={`turn-btn turn-them ${converseFocus === 'them' ? 'turn-active' : ''}`}
                    onClick={() => setFocus('them')}
                  >
                    <span className="turn-emoji">{language.flag}</span>
                    <span className="turn-label">Them</span>
                    <span className="turn-hint">{language.native}</span>
                  </button>
                </div>
              )}

              {converseStatus && <p className="turn-status">{converseStatus}</p>}

              <button
                type="button"
                className={`listen-btn ${conversing ? 'listen-btn-on' : ''}`}
                onClick={toggleConverse}
                style={{ marginTop: conversing ? 10 : 0 }}
              >
                <span className="listen-btn-dot" />
                {conversing ? 'Stop conversation' : 'Start conversation'}
              </button>
            </div>
          </div>
        )}
      </main>

      <nav className="tabbar">
        <button
          type="button"
          className={`tab ${tab === 'listen' ? 'tab-active' : ''}`}
          onClick={() => switchTab('listen')}
        >
          <span className="tab-icon">👂</span>
          Listen
        </button>
        <button
          type="button"
          className={`tab ${tab === 'translate' ? 'tab-active' : ''}`}
          onClick={() => switchTab('translate')}
        >
          <span className="tab-icon">💬</span>
          Talk
        </button>
      </nav>

      {showLangPicker && (
        <div className="sheet-overlay" onClick={() => setShowLangPicker(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grab" />
            <h2 className="sheet-title">
              {langPickerFor === 'listen' ? 'Language to listen for' : 'Their language'}
            </h2>
            <input
              className="sheet-search"
              placeholder="Search…"
              value={langSearch}
              onChange={(e) => setLangSearch(e.target.value)}
              autoFocus
            />
            {!langSearch && (
              <div className="sheet-pinned">
                {pinnedLangs.map((lang) => (
                  <button
                    key={lang.key}
                    type="button"
                    className={`lang-row ${(langPickerFor === 'listen' ? listenLang?.key : language.key) === lang.key ? 'lang-row-on' : ''}`}
                    onClick={() => selectLanguage(lang)}
                  >
                    <span>{lang.flag}</span>
                    <span>{lang.name}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="sheet-list">
              {filteredLangs.map((lang) => (
                <button
                  key={lang.key}
                  type="button"
                  className={`lang-row ${(langPickerFor === 'listen' ? listenLang?.key : language.key) === lang.key ? 'lang-row-on' : ''}`}
                  onClick={() => selectLanguage(lang)}
                >
                  <span>{lang.flag}</span>
                  <span>{lang.name}</span>
                  <span className="lang-native">{lang.native}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {micError && (
        <div className="toast" onClick={() => setMicError(null)}>{micError}</div>
      )}
    </div>
  );
}
