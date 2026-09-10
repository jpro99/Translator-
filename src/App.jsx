import { useState, useRef, useEffect, useCallback } from 'react';
import {
  LANGUAGE_LIST,
  ENGLISH,
  detectLanguageFromText,
} from './languages';
import {
  speechSupported,
  stopMic,
  restartMic,
  keepListening,
  isGarbageTranscript,
  isNearDuplicate,
  cleanTranscript,
} from './speech';
import { translate, translateWithDetection } from './translate';
import {
  createConversationState,
  assignSpeaker,
  getOtherLanguage,
  getRecognitionSpeechCodes,
  speakerLabel,
  findLanguage,
} from './conversation';

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
  const [personA, setPersonA] = useState(null);
  const [personB, setPersonB] = useState(null);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langPickerFor, setLangPickerFor] = useState('listen');
  const [langSearch, setLangSearch] = useState('');
  const [messages, setMessages] = useState([]);
  const [conversing, setConversing] = useState(false);
  const [turnInterim, setTurnInterim] = useState('');
  const [converseStatus, setConverseStatus] = useState('');
  const [ttsOn, setTtsOn] = useState(false);
  const [micError, setMicError] = useState(null);

  const converseActiveRef = useRef(false);
  const converseStateRef = useRef(createConversationState());
  const personAOverrideRef = useRef(null);
  const personBOverrideRef = useRef(null);
  const ttsOnRef = useRef(false);
  const seenRef = useRef(new Set());
  // Short lock so we don't print the same final twice from overlapping restarts
  const recentLockRef = useRef([]);

  const listEndRef = useRef(null);
  const chatEndRef = useRef(null);

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
    recentLockRef.current = recentLockRef.current.filter((u) => now - u.t < 12000);
    if (recentLockRef.current.some((u) => u.n === n || isNearDuplicate(u.raw, text))) {
      return true;
    }
    recentLockRef.current.push({ n, raw: text, t: now });
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
    const cleaned = cleanTranscript(text);
    if (!cleaned || isGarbageTranscript(cleaned)) return;
    if (isRecentDupe(cleaned) || !remember(cleaned, listenSeenRef)) return;
    const detected = detectLanguageFromText(cleaned);
    const lineLang = listenLangRef.current || detected || lang;
    const id = nextId();
    const time = formatTime();
    setListenLines((prev) => [...prev, {
      id, text: cleaned, translation: null, translating: true, lang: lineLang, time,
    }]);
    setListenInterim('');
    let english = await translate(cleaned, 'auto', 'en');
    if (!english) english = await translate(cleaned, lineLang.apiCode, 'en');

    setListenLines((prev) => prev.map((line) => (
      line.id === id
        ? {
          ...line,
          translation: english || '(couldn’t translate — try again)',
          translating: false,
        }
        : line
    )));
  }, [remember, isRecentDupe]);

  const [typedListen, setTypedListen] = useState('');

  const submitTypedListen = useCallback(async () => {
    const text = typedListen.trim();
    if (!text) return;
    const lang = listenLangRef.current
      || LANGUAGE_LIST.find((l) => l.key === 'fil')
      || LANGUAGE_LIST[0];
    setTypedListen('');
    await addListenLine(text, lang);
  }, [typedListen, addListenLine]);

  const runListenLoop = useCallback(async (lang) => {
    setListenStatus('Starting…');
    listenLangRef.current = lang;
    setListenLang(lang);

    await keepListening({
      activeRef: listenActiveRef,
      getLang: () => ({
        speechCode: listenLangRef.current?.speechCode || lang.speechCode,
        apiCode: listenLangRef.current?.apiCode || lang.apiCode,
      }),
      onModel: (info) => {
        if (!listenActiveRef.current) return;
        if (info.status === 'ready') {
          setListenStatus(`Ready · ${listenLangRef.current?.name || lang.name} — speak anytime`);
        }
      },
      onEngine: () => {},
      onPhase: (phase) => {
        if (!listenActiveRef.current) return;
        const name = listenLangRef.current?.name || lang.name;
        if (phase === 'hearing') setListenStatus(`Listening · ${name}`);
        else if (phase === 'transcribing') setListenStatus('Translating…');
        else setListenStatus(`Listening · ${name}`);
      },
      onInterim: (t) => {
        if (!listenActiveRef.current) return;
        setListenInterim(t || '');
      },
      onFinal: async (text) => {
        if (!listenActiveRef.current) return;
        setListenInterim('');
        const cleaned = cleanTranscript(text);
        if (!cleaned || isGarbageTranscript(cleaned)) return;
        const current = listenLangRef.current || lang;
        void addListenLine(cleaned, current);
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
      setMicError('Microphone access is required. Allow it when prompted.');
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

    const lang = listenLangRef.current || ENGLISH;
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

  const syncPersonUi = useCallback((state) => {
    setPersonA(personAOverrideRef.current || state.personA);
    setPersonB(personBOverrideRef.current || state.personB);
    const a = personAOverrideRef.current || state.personA;
    const b = personBOverrideRef.current || state.personB;
    if (a && b) {
      setConverseStatus(`On · ${a.name} ↔ ${b.name} — speak anytime`);
    } else if (a) {
      setConverseStatus(`On · heard ${a.name} — waiting for second language`);
    } else {
      setConverseStatus('On · auto-detecting languages — speak anytime');
    }
  }, []);

  const handleConverseFinal = useCallback(async (text) => {
    if (!converseActiveRef.current) return;
    setTurnInterim('');
    const cleaned = cleanTranscript(text);
    if (!cleaned || isGarbageTranscript(cleaned)) return;
    if (isRecentDupe(cleaned) || !remember(cleaned, seenRef)) return;

    const state = converseStateRef.current;
    if (personAOverrideRef.current) state.personA = personAOverrideRef.current;
    if (personBOverrideRef.current) state.personB = personBOverrideRef.current;

    const tentativeOther = state.lastSpeaker === 'a'
      ? (state.personB || ENGLISH)
      : state.lastSpeaker === 'b'
        ? (state.personA || ENGLISH)
        : ENGLISH;

    const id = nextId();
    setMessages((prev) => [...prev, {
      id,
      speaker: '?',
      said: cleaned,
      sourceLang: null,
      targetLang: null,
      translation: null,
      translating: true,
    }]);

    let result = await translateWithDetection(cleaned, 'auto', tentativeOther.apiCode);
    const detectedCode = result?.detectedLang
      || detectLanguageFromText(cleaned)?.apiCode
      || 'en';
    const { speaker, lang } = assignSpeaker(state, detectedCode, cleaned);
    const target = getOtherLanguage(state, speaker);

    let translation = result?.translation;
    if (target.apiCode !== tentativeOther.apiCode) {
      const retry = await translateWithDetection(cleaned, detectedCode, target.apiCode);
      translation = retry?.translation || translation;
    }
    const out = translation && !isGarbageTranscript(translation) ? translation : cleaned;

    setMessages((prev) => prev.map((m) => (
      m.id === id
        ? {
          ...m,
          speaker,
          sourceLang: lang,
          targetLang: target,
          translation: out,
          translating: false,
        }
        : m
    )));

    syncPersonUi(state);
    if (out && out !== cleaned) speak(out, target.speechCode);
    if (converseActiveRef.current) restartMic();
  }, [remember, speak, isRecentDupe, syncPersonUi]);

  const runConversationLoop = useCallback(async () => {
    setConverseStatus('Starting…');

    await keepListening({
      activeRef: converseActiveRef,
      getLang: () => {
        const codes = getRecognitionSpeechCodes(converseStateRef.current);
        return { speechCode: codes[0], fallbackCodes: codes.slice(1), apiCode: 'auto' };
      },
      onModel: (info) => {
        if (!converseActiveRef.current) return;
        if (info.status === 'ready') {
          syncPersonUi(converseStateRef.current);
        }
      },
      onEngine: () => {},
      onPhase: (phase) => {
        if (!converseActiveRef.current) return;
        const state = converseStateRef.current;
        const codes = getRecognitionSpeechCodes(state);
        const label = codes.length > 1
          ? `${findLanguage(codes[0])?.name || 'auto'}…`
          : (findLanguage(codes[0])?.name || 'auto');
        if (phase === 'hearing') setConverseStatus(`Listening · ${label}`);
        else if (phase === 'transcribing') setConverseStatus('Translating…');
        else syncPersonUi(state);
      },
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
  }, [handleConverseFinal, syncPersonUi]);

  const toggleConverse = useCallback(async () => {
    if (!speechSupported()) {
      setMicError('Microphone access is required. Allow it when prompted.');
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
    converseStateRef.current = createConversationState();
    if (personAOverrideRef.current) converseStateRef.current.personA = personAOverrideRef.current;
    if (personBOverrideRef.current) converseStateRef.current.personB = personBOverrideRef.current;
    setPersonA(personAOverrideRef.current);
    setPersonB(personBOverrideRef.current);
    converseActiveRef.current = true;
    setConversing(true);
    await runConversationLoop();
  }, [conversing, stopConverse, stopListen, runConversationLoop, syncPersonUi]);

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
    if (langPickerFor === 'personA') {
      personAOverrideRef.current = lang;
      setPersonA(lang);
      if (converseStateRef.current) converseStateRef.current.personA = lang;
    } else if (langPickerFor === 'personB') {
      personBOverrideRef.current = lang;
      setPersonB(lang);
      if (converseStateRef.current) converseStateRef.current.personB = lang;
    }
    setShowLangPicker(false);
    setLangSearch('');
    if (converseActiveRef.current) {
      syncPersonUi(converseStateRef.current);
      restartMic();
    }
  }, [langPickerFor, pickListenLanguage, syncPersonUi]);

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
                    : 'Auto-detect ▾'}
                </button>
              </div>
            </header>

            <div className="scroll">
              {listenLines.length === 0 && !listenInterim && !detecting && (
                <div className="empty">
                  <span className="empty-icon">👂</span>
                  <p>Tap Start — languages are auto-detected. It waits silently, then listens only while someone talks.</p>
                  <p className="empty-note">Or type a sentence below to test translation anytime.</p>
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
                  <div className="line-meta">
                    <span>Live</span>
                    <span className="line-time">updating…</span>
                  </div>
                  <p className="line-text">{listenInterim === '…' ? 'Listening…' : listenInterim}</p>
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
              <form
                className="type-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitTypedListen();
                }}
              >
                <input
                  className="type-input"
                  placeholder="Type what they said to translate…"
                  value={typedListen}
                  onChange={(e) => setTypedListen(e.target.value)}
                />
                <button type="submit" className="type-go" disabled={!typedListen.trim()}>
                  Go
                </button>
              </form>
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
                <p className="header-sub">Two-way auto-detect conversation</p>
                <div className="person-chips">
                  <button
                    type="button"
                    className="lang-chip"
                    onClick={() => {
                      setLangPickerFor('personA');
                      setShowLangPicker(true);
                    }}
                  >
                    {personA ? `${personA.flag} ${personA.name}` : 'Person A · Auto'} ▾
                  </button>
                  <span className="person-swap">↔</span>
                  <button
                    type="button"
                    className="lang-chip"
                    onClick={() => {
                      setLangPickerFor('personB');
                      setShowLangPicker(true);
                    }}
                  >
                    {personB ? `${personB.flag} ${personB.name}` : 'Person B · Auto'} ▾
                  </button>
                </div>
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
                  <p>Tap Start conversation. Two people speak — each utterance is auto-detected and translated for the other.</p>
                  <p className="empty-note">
                    Languages are learned from speech. Optional overrides above.
                  </p>
                </div>
              )}

              {messages.map((msg) => (
                <article key={msg.id} className={`chat ${msg.speaker === 'a' ? 'chat-you' : 'chat-them'}`}>
                  <div className="chat-label">
                    {msg.sourceLang
                      ? `${msg.speaker === 'a' ? 'Person A' : 'Person B'} · ${msg.sourceLang.flag} ${msg.sourceLang.name}`
                      : speakerLabel(msg.speaker, converseStateRef.current)}
                  </div>
                  <p className="chat-said chat-said-lg">{msg.said}</p>
                  <p className="chat-arrow">
                    ↓ {msg.targetLang ? `${msg.targetLang.flag} ${msg.targetLang.name}` : 'Translation'}
                  </p>
                  <p className={`chat-trans chat-trans-lg ${msg.translating ? 'is-pending' : ''}`}>
                    {msg.translating ? 'Translating…' : msg.translation}
                  </p>
                </article>
              ))}

              {turnInterim && (
                <article className="chat chat-interim">
                  <div className="chat-label">Live</div>
                  <p className="chat-said chat-said-lg">{turnInterim === '…' ? 'Listening…' : turnInterim}</p>
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
                    converseStateRef.current = createConversationState();
                    setPersonA(personAOverrideRef.current);
                    setPersonB(personBOverrideRef.current);
                  }}
                >
                  Clear
                </button>
              )}

              {converseStatus && <p className="turn-status">{converseStatus}</p>}

              <button
                type="button"
                className={`listen-btn ${conversing ? 'listen-btn-on' : ''}`}
                onClick={toggleConverse}
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
              {langPickerFor === 'listen' && 'Speech language override (optional)'}
              {langPickerFor === 'personA' && 'Person A language override (optional)'}
              {langPickerFor === 'personB' && 'Person B language override (optional)'}
            </h2>
            <input
              className="sheet-search"
              placeholder="Search…"
              value={langSearch}
              onChange={(e) => setLangSearch(e.target.value)}
              autoFocus
            />
            {(langPickerFor === 'personA' || langPickerFor === 'personB' || langPickerFor === 'listen') && (
              <button
                type="button"
                className="lang-row lang-row-auto"
                onClick={() => {
                  if (langPickerFor === 'listen') {
                    listenLangRef.current = null;
                    setListenLang(null);
                  } else if (langPickerFor === 'personA') {
                    personAOverrideRef.current = null;
                    setPersonA(converseStateRef.current?.personA || null);
                  } else {
                    personBOverrideRef.current = null;
                    setPersonB(converseStateRef.current?.personB || null);
                  }
                  setShowLangPicker(false);
                  setLangSearch('');
                }}
              >
                <span>🌐</span>
                <span>Use auto-detect</span>
              </button>
            )}
            {!langSearch && (
              <div className="sheet-pinned">
                {(langPickerFor === 'personA' || langPickerFor === 'personB'
                  ? [ENGLISH, ...pinnedLangs]
                  : pinnedLangs
                ).map((lang) => (
                  <button
                    key={lang.key}
                    type="button"
                    className={`lang-row ${(
                      langPickerFor === 'listen' ? listenLang?.key
                        : langPickerFor === 'personA' ? personA?.key
                          : personB?.key
                    ) === lang.key ? 'lang-row-on' : ''}`}
                    onClick={() => selectLanguage(lang)}
                  >
                    <span>{lang.flag}</span>
                    <span>{lang.name}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="sheet-list">
              {(langPickerFor === 'personA' || langPickerFor === 'personB'
                ? [ENGLISH, ...filteredLangs.filter((l) => l.key !== ENGLISH.key)]
                : filteredLangs
              ).map((lang) => (
                <button
                  key={lang.key}
                  type="button"
                  className={`lang-row ${(
                    langPickerFor === 'listen' ? listenLang?.key
                      : langPickerFor === 'personA' ? personA?.key
                        : personB?.key
                  ) === lang.key ? 'lang-row-on' : ''}`}
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
