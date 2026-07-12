import { useState, useRef, useEffect, useCallback } from 'react';
import { LANGUAGE_LIST, ENGLISH, detectLanguageFromText, isEnglish } from './languages';
import { speechSupported, stopMic, listenContinuous } from './speech';

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

function googleLang(code) {
  if (code === 'zh') return 'zh-CN';
  return code;
}

async function translateGoogle(text, from, to) {
  const sl = googleLang(from);
  const tl = googleLang(to);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const parts = data?.[0]?.map((row) => row?.[0]).filter(Boolean);
  return parts?.join('') || null;
}

async function translate(text, from, to) {
  if (!text.trim() || from === to) return text;
  const key = `${text}|${from}|${to}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const save = (r) => { translationCache.set(key, r); persistCache(); return r; };
  const differs = (r) => r && r.trim().toLowerCase() !== text.trim().toLowerCase();
  try {
    const g = await translateGoogle(text, from, to);
    if (differs(g)) return save(g);
  } catch {}
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`);
    const data = await res.json();
    if (data.responseStatus === 200) { const r = data.responseData.translatedText; if (differs(r)) return save(r); }
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

function classifySpeaker(text, otherLang) {
  if (isEnglish(text)) return 'you';
  const detected = detectLanguageFromText(text);
  if (detected?.key === 'en') return 'you';
  if (detected?.key === otherLang.key) return 'them';
  if (otherLang.isMine?.(text)) return 'them';
  if (detected?.key && detected.key !== '?' && detected.key !== 'en') return 'them';
  return 'them';
}

function resolveLang(text, fallback) {
  return detectLanguageFromText(text) || fallback;
}

/* ─── App ───────────────────────────────────────────────────────────── */
export default function App() {
  const [tab, setTab] = useState('listen');

  /* Shared other language */
  const [language, setLanguage] = useState(() =>
    LANGUAGE_LIST.find(l => l.key === 'ja') || LANGUAGE_LIST[0]
  );
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langSearch, setLangSearch] = useState('');
  const [autoDetect, setAutoDetect] = useState(true);
  const [micError, setMicError] = useState(null);

  /* Listen tab */
  const [listening, setListening] = useState(false);
  const [listenLines, setListenLines] = useState([]);
  const [listenInterim, setListenInterim] = useState('');
  const [listenInterimTrans, setListenInterimTrans] = useState('');
  const listenActiveRef = useRef(false);
  const listenLangRef = useRef(language);
  const listenSeenRef = useRef(new Set());
  const listenTransTimerRef = useRef(null);

  /* Conversation tab */
  const [conversing, setConversing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [convInterim, setConvInterim] = useState('');
  const [convInterimTrans, setConvInterimTrans] = useState('');
  const [convInterimWho, setConvInterimWho] = useState(null);
  const [ttsOn, setTtsOn] = useState(false);
  const convActiveRef = useRef(false);
  const convLangRef = useRef(ENGLISH);
  const convSeenRef = useRef(new Set());
  const convTransTimerRef = useRef(null);

  const listEndRef = useRef(null);
  const chatEndRef = useRef(null);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [listenLines, listenInterim, listenInterimTrans]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, convInterim, convInterimTrans]);

  useEffect(() => () => {
    stopMic();
    clearTimeout(listenTransTimerRef.current);
    clearTimeout(convTransTimerRef.current);
  }, []);

  useEffect(() => {
    if (!autoDetect) listenLangRef.current = language;
  }, [language, autoDetect]);

  const speak = useCallback((text, langCode) => {
    if (!ttsOn || !text || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langCode;
    u.rate = 0.92;
    window.speechSynthesis.speak(u);
  }, [ttsOn]);

  const remember = useCallback((text, seenRef) => {
    const n = norm(text);
    if (!n || seenRef.current.has(n)) return false;
    seenRef.current.add(n);
    if (seenRef.current.size > 40) {
      seenRef.current = new Set([...seenRef.current].slice(-20));
    }
    return true;
  }, []);

  const translateInterim = useCallback((text, from, to, timerRef, setTrans) => {
    clearTimeout(timerRef.current);
    if (!text?.trim() || from === to) { setTrans(''); return; }
    timerRef.current = setTimeout(async () => {
      const r = await translate(text, from, to);
      if (r) setTrans(r);
    }, 450);
  }, []);

  /* ── Listen: hear them speak, show original + English translation ── */
  const handleListenFinal = useCallback(async (text) => {
    if (!remember(text, listenSeenRef)) return;

    const detected = resolveLang(text, autoDetect ? language : language);
    if (detected?.speechCode) listenLangRef.current = detected;

    const fromCode = isEnglish(text) ? 'en' : (detected.apiCode || language.apiCode);
    const translation = fromCode === 'en'
      ? null
      : await translate(text, fromCode, 'en');

    setListenLines(prev => [...prev, {
      id: nextId(),
      text,
      lang: detected,
      translation,
      time: formatTime(),
    }]);
    setListenInterim('');
    setListenInterimTrans('');

    if (autoDetect && detected?.speechCode && detected.key !== 'en') {
      listenLangRef.current = detected;
    } else if (!autoDetect) {
      listenLangRef.current = language;
    }
  }, [autoDetect, language, remember]);

  const handleListenInterim = useCallback((text) => {
    setListenInterim(text);
    const detected = resolveLang(text, language);
    const fromCode = isEnglish(text) ? 'en' : (detected?.apiCode || language.apiCode);
    if (fromCode === 'en') {
      setListenInterimTrans('');
      return;
    }
    translateInterim(text, fromCode, 'en', listenTransTimerRef, setListenInterimTrans);
    if (autoDetect && detected?.speechCode && detected.key !== 'en' && detected.key !== '?') {
      listenLangRef.current = detected;
    }
  }, [autoDetect, language, translateInterim]);

  const toggleListen = useCallback(() => {
    if (!speechSupported()) {
      setMicError('Use Chrome or Edge for speech recognition.');
      return;
    }
    if (listening) {
      listenActiveRef.current = false;
      setListening(false);
      stopMic();
      setListenInterim('');
      setListenInterimTrans('');
      return;
    }
    setMicError(null);
    listenActiveRef.current = true;
    setListening(true);
    listenLangRef.current = autoDetect ? language : language;
    listenContinuous({
      activeRef: listenActiveRef,
      langRef: listenLangRef,
      onInterim: handleListenInterim,
      onFinal: handleListenFinal,
    });
  }, [listening, autoDetect, language, handleListenInterim, handleListenFinal]);

  /* ── Conversation: auto-detect speaker, show both languages live ── */
  const handleConvFinal = useCallback(async (text) => {
    if (!remember(text, convSeenRef)) return;

    const who = classifySpeaker(text, language);
    const isYou = who === 'you';
    convLangRef.current = isYou ? ENGLISH : language;

    if (isYou) {
      const translated = await translate(text, 'en', language.apiCode);
      setMessages(prev => [...prev, {
        id: nextId(), who: 'you',
        said: text,
        translation: translated,
        lang: ENGLISH,
      }]);
      if (translated) speak(translated, language.speechCode);
    } else {
      const detected = resolveLang(text, language);
      const fromCode = detected.apiCode || language.apiCode;
      const translated = await translate(text, fromCode, 'en');
      setMessages(prev => [...prev, {
        id: nextId(), who: 'them',
        said: text,
        translation: translated,
        lang: detected,
      }]);
      if (translated) speak(translated, ENGLISH.speechCode);
      if (detected?.speechCode) convLangRef.current = detected;
    }

    setConvInterim('');
    setConvInterimTrans('');
    setConvInterimWho(null);
  }, [language, remember, speak]);

  const handleConvInterim = useCallback((text) => {
    const who = classifySpeaker(text, language);
    setConvInterim(text);
    setConvInterimWho(who);

    if (who === 'you') {
      translateInterim(text, 'en', language.apiCode, convTransTimerRef, setConvInterimTrans);
      convLangRef.current = ENGLISH;
    } else {
      const detected = resolveLang(text, language);
      const fromCode = detected?.apiCode || language.apiCode;
      translateInterim(text, fromCode, 'en', convTransTimerRef, setConvInterimTrans);
      if (detected?.speechCode) convLangRef.current = detected;
      else convLangRef.current = language;
    }
  }, [language, translateInterim]);

  const toggleConversation = useCallback(() => {
    if (!speechSupported()) {
      setMicError('Use Chrome or Edge for speech recognition.');
      return;
    }
    if (conversing) {
      convActiveRef.current = false;
      setConversing(false);
      stopMic();
      setConvInterim('');
      setConvInterimTrans('');
      setConvInterimWho(null);
      return;
    }
    setMicError(null);
    convActiveRef.current = true;
    setConversing(true);
    convLangRef.current = ENGLISH;
    listenContinuous({
      activeRef: convActiveRef,
      langRef: convLangRef,
      onInterim: handleConvInterim,
      onFinal: handleConvFinal,
    });
  }, [conversing, handleConvInterim, handleConvFinal]);

  const filteredLangs = langSearch.trim()
    ? LANGUAGE_LIST.filter(l =>
        l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
        l.native.toLowerCase().includes(langSearch.toLowerCase()))
    : LANGUAGE_LIST;

  const pinnedLangs = PINNED.map(k => LANGUAGE_LIST.find(l => l.key === k)).filter(Boolean);

  const stopAll = () => {
    listenActiveRef.current = false;
    convActiveRef.current = false;
    setListening(false);
    setConversing(false);
    stopMic();
  };

  return (
    <div className="app">
      <main className="main">
        {tab === 'listen' && (
          <div className="panel">
            <header className="header header-row">
              <div>
                <h1 className="header-title">Listen</h1>
                <p className="header-sub">Hear &amp; translate to English</p>
                <button type="button" className="lang-chip" onClick={() => setShowLangPicker(true)}>
                  {autoDetect ? '🌐 Auto-detect' : `${language.flag} ${language.name}`} ▾
                </button>
              </div>
            </header>

            <div className="scroll">
              {listenLines.length === 0 && !listenInterim && (
                <div className="empty">
                  <span className="empty-icon">👂</span>
                  <p>Tap the button to hear what someone is saying.</p>
                  <p className="empty-note">Translation appears as they talk — English on the bottom.</p>
                </div>
              )}
              {listenLines.map(line => (
                <article key={line.id} className="line-card">
                  <div className="line-meta">
                    <span>{line.lang.flag} {line.lang.name}</span>
                    <span className="line-time">{line.time}</span>
                  </div>
                  <p className="line-text">{line.text}</p>
                  {line.translation && (
                    <>
                      <p className="chat-arrow">↓ English</p>
                      <p className="line-trans">{line.translation}</p>
                    </>
                  )}
                </article>
              ))}
              {listenInterim && (
                <article className="line-card line-interim">
                  <p className="line-text">{listenInterim}</p>
                  {listenInterimTrans && (
                    <>
                      <p className="chat-arrow">↓ English</p>
                      <p className="line-trans">{listenInterimTrans}</p>
                    </>
                  )}
                </article>
              )}
              <div ref={listEndRef} />
            </div>

            <div className="action-bar">
              {listenLines.length > 0 && (
                <button type="button" className="text-btn" onClick={() => { setListenLines([]); listenSeenRef.current.clear(); }}>
                  Clear
                </button>
              )}
              <button
                type="button"
                className={`listen-btn ${listening ? 'listen-btn-on' : ''}`}
                onClick={toggleListen}
              >
                <span className="listen-btn-dot" />
                {listening ? 'Listening… tap to stop' : 'Start listening'}
              </button>
            </div>
          </div>
        )}

        {tab === 'translate' && (
          <div className="panel">
            <header className="header header-row">
              <div>
                <h1 className="header-title">Conversation</h1>
                <button type="button" className="lang-chip" onClick={() => setShowLangPicker(true)}>
                  {language.flag} {language.name} ↔ English ▾
                </button>
              </div>
              <button
                type="button"
                className={`icon-toggle ${ttsOn ? 'icon-toggle-on' : ''}`}
                onClick={() => setTtsOn(v => !v)}
                aria-label="Speaker"
              >
                {ttsOn ? '🔊' : '🔇'}
              </button>
            </header>

            <div className="scroll scroll-chat">
              {messages.length === 0 && !convInterim && (
                <div className="empty">
                  <span className="empty-icon">💬</span>
                  <p>Tap the button and just talk.</p>
                  <p className="empty-note">English and {language.name} appear together automatically.</p>
                </div>
              )}
              {messages.map(msg => (
                <article key={msg.id} className={`chat ${msg.who === 'you' ? 'chat-you' : 'chat-them'}`}>
                  <div className="chat-label">
                    {msg.who === 'you' ? '🇺🇸 English' : `${msg.lang?.flag || language.flag} ${msg.lang?.name || language.name}`}
                  </div>
                  <p className="chat-said">{msg.said}</p>
                  {msg.translation && (
                    <>
                      <p className="chat-arrow">↓ {msg.who === 'you' ? language.name : 'English'}</p>
                      <p className="chat-trans">{msg.translation}</p>
                    </>
                  )}
                </article>
              ))}
              {convInterim && (
                <article className={`chat chat-interim ${convInterimWho === 'you' ? 'chat-you' : 'chat-them'}`}>
                  <div className="chat-label">
                    {convInterimWho === 'you' ? '🇺🇸 English' : `${language.flag} ${language.name}`}
                  </div>
                  <p className="chat-said">{convInterim}</p>
                  {convInterimTrans && (
                    <>
                      <p className="chat-arrow">↓ {convInterimWho === 'you' ? language.name : 'English'}</p>
                      <p className="chat-trans">{convInterimTrans}</p>
                    </>
                  )}
                </article>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="action-bar">
              {messages.length > 0 && (
                <button type="button" className="text-btn" onClick={() => { setMessages([]); convSeenRef.current.clear(); }}>
                  Clear
                </button>
              )}
              <button
                type="button"
                className={`listen-btn ${conversing ? 'listen-btn-on' : ''}`}
                onClick={toggleConversation}
              >
                <span className="listen-btn-dot" />
                {conversing ? 'Talking… tap to stop' : 'Start conversation'}
              </button>
            </div>
          </div>
        )}
      </main>

      <nav className="tabbar">
        <button type="button" className={`tab ${tab === 'listen' ? 'tab-active' : ''}`} onClick={() => { stopAll(); setTab('listen'); }}>
          <span className="tab-icon">👂</span>
          Listen
        </button>
        <button type="button" className={`tab ${tab === 'translate' ? 'tab-active' : ''}`} onClick={() => { stopAll(); setTab('translate'); }}>
          <span className="tab-icon">💬</span>
          Talk
        </button>
      </nav>

      {showLangPicker && (
        <div className="sheet-overlay" onClick={() => setShowLangPicker(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-grab" />
            <h2 className="sheet-title">Their language</h2>
            {tab === 'listen' && (
              <button
                type="button"
                className={`lang-row lang-auto ${autoDetect ? 'lang-row-on' : ''}`}
                onClick={() => { setAutoDetect(true); setShowLangPicker(false); setLangSearch(''); }}
              >
                <span>🌐</span>
                <span>Auto-detect</span>
                <span className="lang-native">recommended</span>
              </button>
            )}
            <input
              className="sheet-search"
              placeholder="Search…"
              value={langSearch}
              onChange={e => setLangSearch(e.target.value)}
              autoFocus
            />
            {!langSearch && (
              <div className="sheet-pinned">
                {pinnedLangs.map(lang => (
                  <button
                    key={lang.key}
                    type="button"
                    className={`lang-row ${!autoDetect && language.key === lang.key ? 'lang-row-on' : ''}`}
                    onClick={() => { setLanguage(lang); setAutoDetect(false); setShowLangPicker(false); setLangSearch(''); listenLangRef.current = lang; }}
                  >
                    <span>{lang.flag}</span>
                    <span>{lang.name}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="sheet-list">
              {filteredLangs.map(lang => (
                <button
                  key={lang.key}
                  type="button"
                  className={`lang-row ${!autoDetect && language.key === lang.key ? 'lang-row-on' : ''}`}
                  onClick={() => { setLanguage(lang); setAutoDetect(false); setShowLangPicker(false); setLangSearch(''); listenLangRef.current = lang; }}
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
