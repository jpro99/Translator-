import { useState, useRef, useEffect, useCallback } from 'react';
import { LANGUAGE_LIST, ENGLISH, detectLanguageFromText, isEnglish } from './languages';
import { speechSupported, speechErrorMessage, stopMic, listenOnce, listenLoop } from './speech';

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
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`
    );
    if (res.ok) {
      const data = await res.json();
      if (data.responseStatus === 200) {
        const r = data.responseData?.translatedText;
        if (differs(r)) return save(r);
      }
    }
  } catch {}

  try {
    const res = await fetch(
      `https://lingva.ml/api/v1/${from}/${to}/${encodeURIComponent(text)}`
    );
    if (res.ok) {
      const data = await res.json();
      if (differs(data.translation)) return save(data.translation);
    }
  } catch {}

  try {
    const res = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`
    );
    if (res.ok) {
      const data = await res.json();
      const r = data?.[0]?.map((x) => x[0]).join('').trim();
      if (differs(r)) return save(r);
    }
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

function classifySpeaker(text, targetLang) {
  if (isEnglish(text)) return 'you';
  const detected = detectLanguageFromText(text);
  if (detected?.key === targetLang.key) return 'them';
  if (detected?.key === 'en') return 'you';
  if (!isEnglish(text)) return 'them';
  return 'you';
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
    LANGUAGE_LIST.find((l) => l.key === 'ja') || LANGUAGE_LIST[0]
  );
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langSearch, setLangSearch] = useState('');
  const [messages, setMessages] = useState([]);
  const [turn, setTurn] = useState(null);
  const [turnInterim, setTurnInterim] = useState('');
  const [conversing, setConversing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ttsOn, setTtsOn] = useState(true);
  const [micError, setMicError] = useState(null);

  const convActiveRef = useRef(false);
  const convLangRef = useRef(ENGLISH);
  const listEndRef = useRef(null);
  const chatEndRef = useRef(null);
  const seenRef = useRef(new Set());
  const lastSpeakerRef = useRef('you');

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [listenLines, listenInterim]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, turnInterim]);

  useEffect(() => () => stopMic(), []);

  const showError = useCallback((msg) => {
    if (msg) setMicError(msg);
  }, []);

  const remember = useCallback((text) => {
    const n = norm(text);
    if (!n || seenRef.current.has(n)) return false;
    seenRef.current.add(n);
    if (seenRef.current.size > 40) {
      seenRef.current = new Set([...seenRef.current].slice(-20));
    }
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

  const pushMessage = useCallback(async ({ who, said, fromCode, toCode, speakCode }) => {
    const translated = await translate(said, fromCode, toCode);
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        who,
        said,
        translation: translated || '(translation unavailable)',
        failed: !translated,
      },
    ]);
    if (translated) speak(translated, speakCode);
    else showError('Could not translate that phrase. Check your connection.');
  }, [speak, showError]);

  /* ── Listen tab: capture speech + translate to English ── */
  const addListenLine = useCallback(async (text) => {
    const n = norm(text);
    if (!n || listenSeenRef.current.has(n)) return;
    listenSeenRef.current.add(n);
    if (listenSeenRef.current.size > 50) {
      listenSeenRef.current = new Set([...listenSeenRef.current].slice(-25));
    }

    const lang = detectLanguageFromText(text) || ENGLISH;
    if (lang.speechCode) listenLangRef.current = lang;

    const lineId = nextId();
    setListenLines((prev) => [
      ...prev,
      { id: lineId, text, lang, time: formatTime(), translation: null, translating: true },
    ]);
    setListenInterim('');

    if (lang.apiCode === 'en' || lang.key === '?') {
      setListenLines((prev) =>
        prev.map((l) => (l.id === lineId ? { ...l, translating: false } : l))
      );
      return;
    }

    const translation = await translate(text, lang.apiCode, 'en');
    setListenLines((prev) =>
      prev.map((l) =>
        l.id === lineId ? { ...l, translation, translating: false } : l
      )
    );
    if (!translation) showError('Heard speech but could not translate. Check your connection.');
  }, [showError]);

  const toggleListen = useCallback(() => {
    if (!speechSupported()) {
      showError('Use Chrome or Edge for speech recognition.');
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
    listenLangRef.current = ENGLISH;

    listenLoop({
      activeRef: listenActiveRef,
      langRef: listenLangRef,
      gapMs: 1200,
      onInterim: (t) => { if (listenActiveRef.current) setListenInterim(t); },
      onLine: addListenLine,
      onError: (msg) => {
        if (listenActiveRef.current) {
          showError(msg);
          if (msg.includes('blocked') || msg.includes('No microphone')) {
            listenActiveRef.current = false;
            setListening(false);
          }
        }
      },
    }).finally(() => {
      if (!listenActiveRef.current) setListening(false);
    });
  }, [listening, addListenLine, showError]);

  /* ── Live conversation: auto-detect who spoke, translate both ways ── */
  const handleConversationLine = useCallback(async (text) => {
    if (!remember(text)) return;

    const who = classifySpeaker(text, language);
    lastSpeakerRef.current = who;

    if (who === 'you') {
      convLangRef.current = language;
      await pushMessage({
        who: 'you',
        said: text,
        fromCode: 'en',
        toCode: language.apiCode,
        speakCode: language.speechCode,
      });
    } else {
      convLangRef.current = ENGLISH;
      await pushMessage({
        who: 'them',
        said: text,
        fromCode: language.apiCode,
        toCode: 'en',
        speakCode: ENGLISH.speechCode,
      });
    }
  }, [language, remember, pushMessage]);

  const toggleConversation = useCallback(() => {
    if (!speechSupported()) {
      showError('Use Chrome or Edge for speech recognition.');
      return;
    }

    if (conversing) {
      convActiveRef.current = false;
      setConversing(false);
      stopMic();
      setTurnInterim('');
      return;
    }

    stopMic();
    setMicError(null);
    setTurn(null);
    convActiveRef.current = true;
    convLangRef.current = ENGLISH;
    setConversing(true);

    listenLoop({
      activeRef: convActiveRef,
      langRef: convLangRef,
      gapMs: 1000,
      onInterim: (t) => { if (convActiveRef.current) setTurnInterim(t); },
      onLine: handleConversationLine,
      onError: (msg) => {
        if (convActiveRef.current) {
          showError(msg);
          if (msg.includes('blocked') || msg.includes('No microphone')) {
            convActiveRef.current = false;
            setConversing(false);
          }
        }
      },
    }).finally(() => {
      if (!convActiveRef.current) setConversing(false);
    });
  }, [conversing, handleConversationLine, showError]);

  /* ── Manual turn: tap You or Them when auto-detect is unsure ── */
  const runTurn = useCallback(async (who) => {
    if (!speechSupported()) {
      showError('Use Chrome or Edge for speech recognition.');
      return;
    }
    if (busy || conversing) return;

    stopMic();
    setMicError(null);
    setBusy(true);
    setTurn(who);
    setTurnInterim('');

    const isYou = who === 'you';
    const recLang = isYou ? ENGLISH.speechCode : language.speechCode;

    const { text, error } = await listenOnce({
      lang: recLang,
      onInterim: setTurnInterim,
    });

    setTurn(null);
    setTurnInterim('');

    if (error) {
      const msg = speechErrorMessage(error);
      if (msg) showError(msg);
      setBusy(false);
      return;
    }

    if (!text || !remember(text)) {
      setBusy(false);
      return;
    }

    if (isYou) {
      await pushMessage({
        who: 'you',
        said: text,
        fromCode: 'en',
        toCode: language.apiCode,
        speakCode: language.speechCode,
      });
    } else {
      await pushMessage({
        who: 'them',
        said: text,
        fromCode: language.apiCode,
        toCode: 'en',
        speakCode: ENGLISH.speechCode,
      });
    }
    setBusy(false);
  }, [busy, conversing, language, remember, pushMessage, showError]);

  const stopAll = useCallback(() => {
    listenActiveRef.current = false;
    convActiveRef.current = false;
    setListening(false);
    setConversing(false);
    stopMic();
    setTurnInterim('');
    setListenInterim('');
  }, []);

  const filteredLangs = langSearch.trim()
    ? LANGUAGE_LIST.filter(
        (l) =>
          l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
          l.native.toLowerCase().includes(langSearch.toLowerCase())
      )
    : LANGUAGE_LIST;

  const pinnedLangs = PINNED.map((k) => LANGUAGE_LIST.find((l) => l.key === k)).filter(Boolean);

  return (
    <div className="app">
      <main className="main">
        {tab === 'listen' && (
          <div className="panel">
            <header className="header">
              <h1 className="header-title">Listen</h1>
              <p className="header-sub">Overheard speech · auto-translated to English</p>
            </header>

            <div className="scroll">
              {listenLines.length === 0 && !listenInterim && (
                <div className="empty">
                  <span className="empty-icon">👂</span>
                  <p>Tap the button below to hear nearby conversation.</p>
                  <p className="empty-note">Speech is labeled by language and translated to English.</p>
                </div>
              )}
              {listenLines.map((line) => (
                <article key={line.id} className="line-card">
                  <div className="line-meta">
                    <span>{line.lang.flag} {line.lang.name}</span>
                    <span className="line-time">{line.time}</span>
                  </div>
                  <p className="line-text">{line.text}</p>
                  {line.translating && <p className="line-trans line-trans-pending">Translating…</p>}
                  {line.translation && (
                    <>
                      <p className="line-arrow">↓ English</p>
                      <p className="line-trans">{line.translation}</p>
                    </>
                  )}
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
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => { setListenLines([]); listenSeenRef.current.clear(); }}
                >
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
                onClick={() => setTtsOn((v) => !v)}
                aria-label="Speaker"
              >
                {ttsOn ? '🔊' : '🔇'}
              </button>
            </header>

            <div className="scroll scroll-chat">
              {messages.length === 0 && !turnInterim && !conversing && (
                <div className="empty">
                  <span className="empty-icon">💬</span>
                  <p>Tap <strong>Start conversation</strong> for real-time two-way translation.</p>
                  <p className="empty-note">Or use You / Them if auto-detect is unsure.</p>
                </div>
              )}
              {messages.map((msg) => (
                <article key={msg.id} className={`chat ${msg.who === 'you' ? 'chat-you' : 'chat-them'}`}>
                  <div className="chat-label">
                    {msg.who === 'you' ? 'You said' : `They said · ${language.name}`}
                  </div>
                  <p className="chat-said">{msg.said}</p>
                  <p className="chat-arrow">↓</p>
                  <p className={`chat-trans ${msg.failed ? 'chat-trans-failed' : ''}`}>{msg.translation}</p>
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
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => { setMessages([]); seenRef.current.clear(); }}
                >
                  Clear
                </button>
              )}

              <button
                type="button"
                className={`conv-btn ${conversing ? 'conv-btn-on' : ''}`}
                onClick={toggleConversation}
                disabled={busy && !conversing}
              >
                <span className="listen-btn-dot" />
                {conversing ? 'Conversation live · tap to stop' : 'Start conversation'}
              </button>

              <p className="turn-or">or tap who is speaking</p>

              <div className="turn-btns">
                <button
                  type="button"
                  className={`turn-btn turn-you ${turn === 'you' ? 'turn-active' : ''}`}
                  disabled={(busy && turn !== 'you') || conversing}
                  onClick={() => runTurn('you')}
                >
                  <span className="turn-emoji">🇺🇸</span>
                  <span className="turn-label">You</span>
                  <span className="turn-hint">English</span>
                </button>
                <button
                  type="button"
                  className={`turn-btn turn-them ${turn === 'them' ? 'turn-active' : ''}`}
                  disabled={(busy && turn !== 'them') || conversing}
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
        <button
          type="button"
          className={`tab ${tab === 'listen' ? 'tab-active' : ''}`}
          onClick={() => { stopAll(); setTab('listen'); }}
        >
          <span className="tab-icon">👂</span>
          Listen
        </button>
        <button
          type="button"
          className={`tab ${tab === 'translate' ? 'tab-active' : ''}`}
          onClick={() => { stopAll(); setTab('translate'); }}
        >
          <span className="tab-icon">💬</span>
          Translate
        </button>
      </nav>

      {showLangPicker && (
        <div className="sheet-overlay" onClick={() => setShowLangPicker(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grab" />
            <h2 className="sheet-title">Their language</h2>
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
              {filteredLangs.map((lang) => (
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
