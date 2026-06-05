import { useState, useRef, useEffect, useCallback } from 'react';
import { LANGUAGE_LIST, ENGLISH, detectLanguageFromText } from './languages';
import { speechSupported, stopMic, listenOnce, listenLoop } from './speech';

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
  if (!text.trim() || from === to) return text;
  const key = `${text}|${from}|${to}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const save = (r) => { translationCache.set(key, r); persistCache(); return r; };
  const differs = (r) => r && r.trim().toLowerCase() !== text.trim().toLowerCase();
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`);
    const data = await res.json();
    if (data.responseStatus === 200) { const r = data.responseData.translatedText; if (differs(r)) return save(r); }
  } catch {}
  try {
    const res = await fetch(`https://lingva.ml/api/v1/${from}/${to}/${encodeURIComponent(text)}`);
    const data = await res.json();
    if (differs(data.translation)) return save(data.translation);
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

/* ─── App ───────────────────────────────────────────────────────────── */
export default function App() {
  const [tab, setTab] = useState('listen');

  /* Listen tab */
  const [listening, setListening] = useState(false);
  const [listenLines, setListenLines] = useState([]);
  const [listenInterim, setListenInterim] = useState('');
  const listenActiveRef = useRef(false);
  const listenLangRef = useRef(ENGLISH);
  const listenSeenRef = useRef(new Set());

  /* Translate tab */
  const [language, setLanguage] = useState(() =>
    LANGUAGE_LIST.find(l => l.key === 'ja') || LANGUAGE_LIST[0]
  );
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langSearch, setLangSearch] = useState('');
  const [messages, setMessages] = useState([]);
  const [turn, setTurn] = useState(null); // 'you' | 'them' | null
  const [turnInterim, setTurnInterim] = useState('');
  const [busy, setBusy] = useState(false);
  const [ttsOn, setTtsOn] = useState(false);
  const [micError, setMicError] = useState(null);

  const listEndRef = useRef(null);
  const chatEndRef = useRef(null);
  const seenRef = useRef(new Set());
  const lockUntilRef = useRef(0);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [listenLines, listenInterim]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, turnInterim]);

  useEffect(() => () => stopMic(), []);

  const remember = useCallback((text) => {
    const n = norm(text);
    if (!n || seenRef.current.has(n)) return false;
    seenRef.current.add(n);
    if (seenRef.current.size > 40) {
      seenRef.current = new Set([...seenRef.current].slice(-20));
    }
    lockUntilRef.current = Date.now() + 8000;
    return true;
  }, []);

  const speak = useCallback((text, langCode) => {
    if (!ttsOn || !text || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langCode;
    u.rate = 0.92;
    window.speechSynthesis.speak(u);
  }, [ttsOn]);

  /* ── Listen tab: one toggle, one line at a time ── */
  const addListenLine = useCallback((text) => {
    const n = norm(text);
    if (!n || listenSeenRef.current.has(n)) return;
    listenSeenRef.current.add(n);
    if (listenSeenRef.current.size > 50) {
      listenSeenRef.current = new Set([...listenSeenRef.current].slice(-25));
    }
    const lang = detectLanguageFromText(text) || ENGLISH;
    if (lang.speechCode) listenLangRef.current = lang;
    setListenLines(prev => [...prev, { id: nextId(), text, lang, time: formatTime() }]);
    setListenInterim('');
  }, []);

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
      return;
    }
    setMicError(null);
    listenActiveRef.current = true;
    setListening(true);
    listenLoop({
      activeRef: listenActiveRef,
      langRef: listenLangRef,
      gapMs: 1800,
      onInterim: (t) => { if (listenActiveRef.current) setListenInterim(t); },
      onLine: addListenLine,
    });
  }, [listening, addListenLine]);

  /* ── Translate tab: tap You or Them, one utterance each ── */
  const runTurn = useCallback(async (who) => {
    if (!speechSupported()) {
      setMicError('Use Chrome or Edge for speech recognition.');
      return;
    }
    if (busy || Date.now() < lockUntilRef.current) return;

    stopMic();
    setMicError(null);
    setBusy(true);
    setTurn(who);
    setTurnInterim('');

    const isYou = who === 'you';
    const recLang = isYou ? ENGLISH.speechCode : language.speechCode;

    const text = await listenOnce({
      lang: recLang,
      onInterim: setTurnInterim,
    });

    setTurn(null);
    setTurnInterim('');

    if (!text || !remember(text)) {
      setBusy(false);
      return;
    }

    if (isYou) {
      const translated = await translate(text, 'en', language.apiCode);
      if (translated) {
        setMessages(prev => [...prev, {
          id: nextId(), who: 'you',
          said: text, translation: translated,
        }]);
        speak(translated, language.speechCode);
      }
    } else {
      const translated = await translate(text, language.apiCode, 'en');
      if (translated) {
        setMessages(prev => [...prev, {
          id: nextId(), who: 'them',
          said: text, translation: translated,
        }]);
        speak(translated, ENGLISH.speechCode);
      }
    }
    setBusy(false);
  }, [busy, language, remember, speak]);

  const filteredLangs = langSearch.trim()
    ? LANGUAGE_LIST.filter(l =>
        l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
        l.native.toLowerCase().includes(langSearch.toLowerCase()))
    : LANGUAGE_LIST;

  const pinnedLangs = PINNED.map(k => LANGUAGE_LIST.find(l => l.key === k)).filter(Boolean);

  return (
    <div className="app">
      <main className="main">
        {tab === 'listen' && (
          <div className="panel">
            <header className="header">
              <h1 className="header-title">Listen</h1>
              <p className="header-sub">Overheard speech · auto-labeled</p>
            </header>

            <div className="scroll">
              {listenLines.length === 0 && !listenInterim && (
                <div className="empty">
                  <span className="empty-icon">👂</span>
                  <p>Tap the button below to capture nearby conversation.</p>
                  <p className="empty-note">You don&apos;t speak — just listen.</p>
                </div>
              )}
              {listenLines.map(line => (
                <article key={line.id} className="line-card">
                  <div className="line-meta">
                    <span>{line.lang.flag} {line.lang.name}</span>
                    <span className="line-time">{line.time}</span>
                  </div>
                  <p className="line-text">{line.text}</p>
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
                <h1 className="header-title">Translate</h1>
                <button type="button" className="lang-chip" onClick={() => setShowLangPicker(true)}>
                  {language.flag} {language.name} ▾
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
              {messages.length === 0 && !turnInterim && (
                <div className="empty">
                  <span className="empty-icon">💬</span>
                  <p>Tap <strong>You</strong> when you speak English.</p>
                  <p>Tap <strong>Them</strong> when they speak {language.name}.</p>
                </div>
              )}
              {messages.map(msg => (
                <article key={msg.id} className={`chat ${msg.who === 'you' ? 'chat-you' : 'chat-them'}`}>
                  <div className="chat-label">{msg.who === 'you' ? 'You said' : `They said · ${language.name}`}</div>
                  <p className="chat-said">{msg.said}</p>
                  <p className="chat-arrow">↓</p>
                  <p className="chat-trans">{msg.translation}</p>
                </article>
              ))}
              {turnInterim && (
                <article className="chat chat-interim">
                  <p className="chat-said">{turnInterim}</p>
                </article>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="turn-bar">
              {messages.length > 0 && (
                <button type="button" className="text-btn" onClick={() => { setMessages([]); seenRef.current.clear(); }}>
                  Clear
                </button>
              )}
              <div className="turn-btns">
                <button
                  type="button"
                  className={`turn-btn turn-you ${turn === 'you' ? 'turn-active' : ''}`}
                  disabled={busy && turn !== 'you'}
                  onClick={() => runTurn('you')}
                >
                  <span className="turn-emoji">🇺🇸</span>
                  <span className="turn-label">You</span>
                  <span className="turn-hint">English</span>
                </button>
                <button
                  type="button"
                  className={`turn-btn turn-them ${turn === 'them' ? 'turn-active' : ''}`}
                  disabled={busy && turn !== 'them'}
                  onClick={() => runTurn('them')}
                >
                  <span className="turn-emoji">{language.flag}</span>
                  <span className="turn-label">Them</span>
                  <span className="turn-hint">{language.native}</span>
                </button>
              </div>
              {turn && <p className="turn-status">Speak now…</p>}
            </div>
          </div>
        )}
      </main>

      <nav className="tabbar">
        <button type="button" className={`tab ${tab === 'listen' ? 'tab-active' : ''}`} onClick={() => { stopMic(); listenActiveRef.current = false; setListening(false); setTab('listen'); }}>
          <span className="tab-icon">👂</span>
          Listen
        </button>
        <button type="button" className={`tab ${tab === 'translate' ? 'tab-active' : ''}`} onClick={() => { stopMic(); listenActiveRef.current = false; setListening(false); setTab('translate'); }}>
          <span className="tab-icon">💬</span>
          Translate
        </button>
      </nav>

      {showLangPicker && (
        <div className="sheet-overlay" onClick={() => setShowLangPicker(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-grab" />
            <h2 className="sheet-title">Their language</h2>
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
                    className={`lang-row ${language.key === lang.key ? 'lang-row-on' : ''}`}
                    onClick={() => { setLanguage(lang); setShowLangPicker(false); setLangSearch(''); }}
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
                  className={`lang-row ${language.key === lang.key ? 'lang-row-on' : ''}`}
                  onClick={() => { setLanguage(lang); setShowLangPicker(false); setLangSearch(''); }}
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
