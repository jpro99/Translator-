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
  listenOnce,
  listenLoop,
  detectSpokenLanguage,
  sleep,
} from './speech';

/* ─── Translation cache ─────────────────────────────────────────────── */
const _cacheInit = (() => {
  try { return JSON.parse(localStorage.getItem('tr_v1') || '[]'); } catch { return []; }
})();
const translationCache = new Map(_cacheInit);

function persistCache() {
  try {
    localStorage.setItem('tr_v1', JSON.stringify([...translationCache.entries()].slice(-900)));
  } catch {}
}

async function translate(text, from, to) {
  if (!text?.trim()) return null;
  if (from !== 'auto' && from === to) return text;
  const key = `${text}|${from}|${to}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const save = (r) => { translationCache.set(key, r); persistCache(); return r; };
  const differs = (r) => r && r.trim().toLowerCase() !== text.trim().toLowerCase();

  // Google translate (unofficial, reliable for short phrases; supports auto)
  try {
    const sl = from === 'auto' ? 'auto' : from;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const data = await res.json();
    const r = Array.isArray(data?.[0])
      ? data[0].filter(Boolean).map((p) => p?.[0]).join('')
      : '';
    if (r && (from === 'auto' || differs(r) || r.trim())) return save(r.trim());
  } catch {}

  try {
    const pair = `${from === 'auto' ? 'Autodetect' : from}|${to}`;
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}`);
    const data = await res.json();
    if (data.responseStatus === 200) {
      const r = data.responseData.translatedText;
      if (differs(r)) return save(r);
      if (r) return save(r);
    }
  } catch {}

  try {
    const sl = from === 'auto' ? 'auto' : from;
    const res = await fetch(`https://lingva.ml/api/v1/${sl}/${to}/${encodeURIComponent(text)}`);
    const data = await res.json();
    if (differs(data.translation)) return save(data.translation);
    if (data.translation) return save(data.translation);
  } catch {}

  return null;
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
  if (isEnglish(text)) return false;
  if (UNIQUE_SCRIPT_KEYS.has(lang.key)) {
    if (!lang.isMine?.(text)) return false;
    // Reject pure-katakana Japanese fakes
    if (lang.key === 'ja') {
      const hasHiragana = /[ぁ-ん]/.test(text);
      const hasKanji = /[一-鿿]/.test(text);
      if (!hasHiragana && !hasKanji) return false;
    }
    return true;
  }
  // Latin-script: accept non-English transcripts from that recognizer
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
  const [langPickerFor, setLangPickerFor] = useState('converse'); // 'converse' | 'listen'
  const [langSearch, setLangSearch] = useState('');
  const [messages, setMessages] = useState([]);
  const [conversing, setConversing] = useState(false);
  const [converseFocus, setConverseFocus] = useState('them'); // 'you' | 'them'
  const [turnInterim, setTurnInterim] = useState('');
  const [converseStatus, setConverseStatus] = useState('');
  const [ttsOn, setTtsOn] = useState(false);
  const [micError, setMicError] = useState(null);

  const converseActiveRef = useRef(false);
  const converseFocusRef = useRef('them');
  const languageRef = useRef(language);
  const seenRef = useRef(new Set());

  const listEndRef = useRef(null);
  const chatEndRef = useRef(null);

  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { converseFocusRef.current = converseFocus; }, [converseFocus]);
  useEffect(() => { listenLangRef.current = listenLang; }, [listenLang]);

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

  const remember = useCallback((text, store = seenRef) => {
    const n = norm(text);
    if (!n || store.current.has(n)) return false;
    store.current.add(n);
    if (store.current.size > 50) {
      store.current = new Set([...store.current].slice(-25));
    }
    return true;
  }, []);

  const speak = useCallback((text, langCode) => {
    return new Promise((resolve) => {
      if (!ttsOn || !text || !window.speechSynthesis) {
        resolve();
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langCode;
      u.rate = 0.92;
      const done = () => resolve();
      u.onend = done;
      u.onerror = done;
      window.speechSynthesis.speak(u);
      setTimeout(done, Math.min(12000, 800 + text.length * 80));
    });
  }, [ttsOn]);

  /* ── Listen: capture → detect language → translate to English ── */
  const addListenLine = useCallback(async (text, lang) => {
    if (!remember(text, listenSeenRef)) return;
    const id = nextId();
    const time = formatTime();
    // Optimistic row while translating
    setListenLines((prev) => [...prev, {
      id, text, translation: null, translating: true, lang, time,
    }]);
    setListenInterim('');

    const toEn = lang.key === 'en'
      ? text
      : (await translate(text, lang.apiCode, 'en')) || (await translate(text, 'auto', 'en'));
    setListenLines((prev) => prev.map((line) => (
      line.id === id
        ? { ...line, translation: toEn || '(translation unavailable)', translating: false }
        : line
    )));
  }, [remember]);

  const runListenLoop = useCallback(async (lang) => {
    setListenStatus(`Listening · ${lang.name}`);
    listenLangRef.current = lang;
    setListenLang(lang);

    await listenLoop({
      activeRef: listenActiveRef,
      langRef: listenLangRef,
      gapMs: 500,
      onInterim: (t) => { if (listenActiveRef.current) setListenInterim(t); },
      onLine: async (text) => {
        if (!listenActiveRef.current) return;
        const current = listenLangRef.current || lang;
        // Re-label if script clearly points elsewhere
        const guessed = detectLanguageFromText(text);
        const useLang = (guessed && guessed.key !== '?' && guessed.key !== 'en' && UNIQUE_SCRIPT_KEYS.has(guessed.key))
          ? guessed
          : current;
        if (useLang.key !== current.key && useLang.speechCode) {
          listenLangRef.current = useLang;
          setListenLang(useLang);
          setListenStatus(`Listening · ${useLang.name}`);
        }
        await addListenLine(text, useLang.key === 'en' ? ENGLISH : useLang);
      },
    });
  }, [addListenLine]);

  const stopListen = useCallback(() => {
    listenActiveRef.current = false;
    listenDetectRef.current = false;
    setListening(false);
    setDetecting(false);
    setDetectingLang(null);
    setListenInterim('');
    setListenStatus('');
    stopMic();
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

    // Stop conversation if running
    converseActiveRef.current = false;
    setConversing(false);
    stopMic();

    setMicError(null);
    listenSeenRef.current.clear();
    listenActiveRef.current = true;
    listenDetectRef.current = true;
    setListening(true);

    // If we already know the language, skip detection
    let lang = listenLangRef.current;

    if (!lang) {
      setDetecting(true);
      setListenStatus('Detecting language… speak now');
      const candidates = LANGUAGE_LIST.filter((l) => UNIQUE_SCRIPT_KEYS.has(l.key));
      lang = await detectSpokenLanguage(
        candidates,
        (l) => { if (listenDetectRef.current) setDetectingLang(l); },
        listenDetectRef,
      );
      setDetecting(false);
      setDetectingLang(null);

      if (!listenActiveRef.current) return;

      if (!lang) {
        // Couldn't auto-detect (likely Latin script) — ask user to pick
        setListening(false);
        listenActiveRef.current = false;
        setListenStatus('');
        setLangPickerFor('listen');
        setShowLangPicker(true);
        setMicError('Couldn’t auto-detect. Pick their language, then tap Start again.');
        return;
      }
    }

    await runListenLoop(lang);
  }, [listening, detecting, runListenLoop, stopListen]);

  const pickListenLanguage = useCallback(async (lang) => {
    setShowLangPicker(false);
    setLangSearch('');
    setMicError(null);

    // If already listening, just switch the recognizer language — don't spawn another loop
    if (listenActiveRef.current) {
      listenLangRef.current = lang;
      setListenLang(lang);
      setListenStatus(`Listening · ${lang.name}`);
      stopMic(); // current listenOnce aborts; loop continues with new lang
      return;
    }

    listenLangRef.current = lang;
    setListenLang(lang);

    if (!speechSupported()) {
      setMicError('Use Chrome or Edge for speech recognition.');
      return;
    }

    converseActiveRef.current = false;
    setConversing(false);
    stopMic();

    listenActiveRef.current = true;
    setListening(true);
    await runListenLoop(lang);
  }, [runListenLoop]);

  /* ── Conversation: continuous EN ↔ other, print both ── */
  const stopConverse = useCallback(() => {
    converseActiveRef.current = false;
    setConversing(false);
    setTurnInterim('');
    setConverseStatus('');
    stopMic();
  }, []);

  const addConverseMessage = useCallback(async (who, said, fromCode, toCode, speakLang) => {
    if (!remember(said, seenRef)) return;
    const id = nextId();
    setMessages((prev) => [...prev, {
      id, who, said, translation: null, translating: true,
    }]);
    setTurnInterim('');

    const translated = await translate(said, fromCode, toCode)
      || (toCode === 'en' ? await translate(said, 'auto', 'en') : null);
    setMessages((prev) => prev.map((m) => (
      m.id === id
        ? { ...m, translation: translated || '(translation unavailable)', translating: false }
        : m
    )));
    if (translated) await speak(translated, speakLang);
  }, [remember, speak]);

  const runConversationLoop = useCallback(async () => {
    while (converseActiveRef.current) {
      const lang = languageRef.current;
      const focus = converseFocusRef.current;
      const listeningForYou = focus === 'you';

      setConverseStatus(
        listeningForYou
          ? 'Listening for English…'
          : `Listening for ${lang.name}…`,
      );

      const recLang = listeningForYou ? ENGLISH.speechCode : lang.speechCode;
      const text = await listenOnce({
        lang: recLang,
        timeoutMs: 10000,
        onInterim: (t) => {
          if (converseActiveRef.current) setTurnInterim(t);
        },
      });

      if (!converseActiveRef.current) break;
      setTurnInterim('');

      if (!text) {
        // No speech — gently flip focus so the other person gets a turn
        const next = listeningForYou ? 'them' : 'you';
        converseFocusRef.current = next;
        setConverseFocus(next);
        await sleep(300);
        continue;
      }

      if (listeningForYou) {
        // Expect English from you
        if (!isEnglish(text) && looksLikeForeign(text, lang)) {
          // They spoke while we were on English — treat as them
          await addConverseMessage('them', text, lang.apiCode, 'en', ENGLISH.speechCode);
          converseFocusRef.current = 'you';
          setConverseFocus('you');
        } else {
          await addConverseMessage('you', text, 'en', lang.apiCode, lang.speechCode);
          // After you speak, listen for them
          converseFocusRef.current = 'them';
          setConverseFocus('them');
        }
      } else {
        // Expect their language
        if (isEnglish(text) || !looksLikeForeign(text, lang)) {
          // English (or unclear) while listening for them → treat as you if English
          if (isEnglish(text)) {
            await addConverseMessage('you', text, 'en', lang.apiCode, lang.speechCode);
            converseFocusRef.current = 'them';
            setConverseFocus('them');
          } else if (!UNIQUE_SCRIPT_KEYS.has(lang.key)) {
            // Latin-script languages: accept transcript as "them"
            await addConverseMessage('them', text, lang.apiCode, 'en', ENGLISH.speechCode);
            converseFocusRef.current = 'you';
            setConverseFocus('you');
          }
          // else: unique-script mismatch — ignore garbage
        } else {
          await addConverseMessage('them', text, lang.apiCode, 'en', ENGLISH.speechCode);
          converseFocusRef.current = 'you';
          setConverseFocus('you');
        }
      }

      await sleep(400);
    }
  }, [addConverseMessage]);

  const toggleConverse = useCallback(async () => {
    if (!speechSupported()) {
      setMicError('Use Chrome or Edge for speech recognition.');
      return;
    }
    if (conversing) {
      stopConverse();
      return;
    }

    // Stop listen mode
    stopListen();

    setMicError(null);
    seenRef.current.clear();
    converseActiveRef.current = true;
    converseFocusRef.current = 'them';
    setConverseFocus('them');
    setConversing(true);
    await runConversationLoop();
  }, [conversing, stopConverse, stopListen, runConversationLoop]);

  const setFocus = useCallback((who) => {
    converseFocusRef.current = who;
    setConverseFocus(who);
    // Restart current utterance so language switches immediately
    if (converseActiveRef.current) stopMic();
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
    // If conversation is running, mic will pick up new language via languageRef
    if (converseActiveRef.current) stopMic();
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
                {listenLang && (
                  <button
                    type="button"
                    className="lang-chip"
                    onClick={() => {
                      setLangPickerFor('listen');
                      setShowLangPicker(true);
                    }}
                  >
                    {listenLang.flag} {listenLang.name} ▾
                  </button>
                )}
              </div>
            </header>

            <div className="scroll">
              {listenLines.length === 0 && !listenInterim && !detecting && (
                <div className="empty">
                  <span className="empty-icon">👂</span>
                  <p>Tap Start. I’ll pick up their language when I can, then show what they say in English.</p>
                  <p className="empty-note">You don’t speak — just hold the phone near them.</p>
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
                {listening || detecting ? 'Listening… tap to stop' : 'Start listening'}
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
                  <p>Tap Start. I’ll print both languages as each person talks.</p>
                  <p className="empty-note">
                    English ↔ {language.name}. Use You / Them to steer the mic if needed.
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
                {conversing ? 'In conversation… tap to stop' : 'Start conversation'}
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
