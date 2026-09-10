import { useRef, useCallback, useState, useEffect } from 'react';
import {
  keepListening,
  stopMic,
  speechSupported,
  getEngineMode,
  isGarbageTranscript,
  cleanTranscript,
} from './speech';
import { translateWithDetection } from './translate';
import { detectLanguageFromText, ENGLISH, LANGUAGE_LIST } from './languages';
import { speakAloud } from './audio';
import { bilingual, t, uiLocale } from './i18n';
import { enqueueRetry, dequeueRetry } from './retryQueue';

let _id = 0;
const nextId = () => ++_id;

function formatTime(d = new Date()) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const PINNED = ['it', 'en', 'es', 'fr', 'de', 'pt'];
const SOURCE_HINT_KEY = 'expert_source_hint_v1';

export default function ExpertListenerMode({ onBack }) {
  const locale = uiLocale();
  const [active, setActive] = useState(false);
  const [lines, setLines] = useState([]);
  const [interim, setInterim] = useState('');
  const [phase, setPhase] = useState('idle');
  const [micLevel, setMicLevel] = useState(0);
  const [engine, setEngine] = useState('');
  const [modelStatus, setModelStatus] = useState('');
  const [debugStatus, setDebugStatus] = useState('');
  const [micError, setMicError] = useState(null);
  const [targetLang, setTargetLang] = useState(ENGLISH);
  const [sourceHint, setSourceHint] = useState(null);
  const [ttsOn, setTtsOn] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(null);
  const [langSearch, setLangSearch] = useState('');

  const activeRef = useRef(false);
  const targetRef = useRef(ENGLISH);
  const sourceRef = useRef(null);
  const ttsRef = useRef(false);
  const seenRef = useRef(new Set());
  const listEndRef = useRef(null);
  const silentWarnedRef = useRef(false);

  useEffect(() => {
    // Never sticky-wrong guide language from old sessions
    try { localStorage.removeItem(SOURCE_HINT_KEY); } catch {}
    setSourceHint(null);
    sourceRef.current = null;
  }, []);

  useEffect(() => { targetRef.current = targetLang; }, [targetLang]);
  useEffect(() => { sourceRef.current = sourceHint; }, [sourceHint]);
  useEffect(() => { ttsRef.current = ttsOn; }, [ttsOn]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, interim]);

  useEffect(() => () => {
    activeRef.current = false;
    stopMic();
  }, []);

  const remember = useCallback((text) => {
    const n = (text || '').trim().toLowerCase();
    if (!n || seenRef.current.has(n)) return false;
    seenRef.current.add(n);
    if (seenRef.current.size > 80) {
      seenRef.current = new Set([...seenRef.current].slice(-40));
    }
    return true;
  }, []);

  const addLine = useCallback(async (text) => {
    const cleaned = cleanTranscript(text);
    if (!cleaned || isGarbageTranscript(cleaned)) return;
    if (!remember(cleaned)) return;

    const id = nextId();
    const time = formatTime();
    const detected = detectLanguageFromText(cleaned);
    const sourceLang = sourceRef.current || detected;

    // Show transcript immediately — translate in background
    setLines((prev) => [...prev, {
      id,
      text: cleaned,
      sourceLang,
      translation: null,
      provider: null,
      translating: true,
      failed: false,
      time,
      isLive: true,
    }]);
    setInterim('');
    setDebugStatus('translate…');

    const result = await translateWithDetection(cleaned, 'auto', targetRef.current.apiCode)
      || await translateWithDetection(cleaned, sourceLang?.apiCode || 'auto', targetRef.current.apiCode);

    if (!result?.translation) {
      enqueueRetry({
        id, kind: 'expert', text: cleaned, from: 'auto', to: targetRef.current.apiCode,
      });
      setLines((prev) => prev.map((l) => (
        l.id === id
          ? {
            ...l,
            translation: bilingual('translateFailed'),
            translating: false,
            failed: true,
            isLive: false,
          }
          : { ...l, isLive: false }
      )));
      setDebugStatus('translate failed');
      return;
    }

    setLines((prev) => prev.map((l) => (
      l.id === id
        ? {
          ...l,
          translation: result.translation,
          provider: result.provider,
          sourceLang: result.detectedLang
            ? (LANGUAGE_LIST.find((x) => x.apiCode === result.detectedLang
              || x.key === result.detectedLang) || sourceLang)
            : sourceLang,
          translating: false,
          failed: false,
          isLive: false,
        }
        : { ...l, isLive: false }
    )));
    setDebugStatus(`done · ${result.provider || 'ok'}`);

    if (ttsRef.current && result.translation) {
      speakAloud(result.translation, targetRef.current.speechCode);
    }
  }, [remember]);

  const retryLine = useCallback(async (line) => {
    setLines((prev) => prev.map((l) => (
      l.id === line.id ? { ...l, translating: true, failed: false } : l
    )));
    const result = await translateWithDetection(line.text, 'auto', targetRef.current.apiCode);
    if (!result?.translation) {
      setLines((prev) => prev.map((l) => (
        l.id === line.id
          ? { ...l, translating: false, failed: true, translation: bilingual('translateFailed') }
          : l
      )));
      return;
    }
    setLines((prev) => prev.map((l) => (
      l.id === line.id
        ? {
          ...l,
          translation: result.translation,
          provider: result.provider,
          translating: false,
          failed: false,
        }
        : l
    )));
    dequeueRetry(line.id);
    if (ttsRef.current) speakAloud(result.translation, targetRef.current.speechCode);
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setPhase('idle');
    setInterim('');
    setMicLevel(0);
    setDebugStatus('');
    silentWarnedRef.current = false;
    stopMic();
  }, []);

  const start = useCallback(async () => {
    if (!speechSupported()) {
      setMicError(bilingual('speechUnsupported'));
      return;
    }
    setMicError(null);
    silentWarnedRef.current = false;
    seenRef.current.clear();
    activeRef.current = true;
    setActive(true);
    setPhase('loading');
    setDebugStatus('starting…');

    await keepListening({
      activeRef,
      outdoor: true,
      profile: 'expert',
      getLang: () => {
        if (sourceRef.current) {
          return {
            speechCode: sourceRef.current.speechCode,
            fallbackCodes: ['it-IT', 'en-US', 'es-ES', 'fr-FR', 'de-DE'],
            whisperLang: 'auto',
          };
        }
        // Auto-detect: try common tour languages
        return {
          speechCode: 'it-IT',
          fallbackCodes: ['en-US', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR'],
          whisperLang: 'auto',
        };
      },
      onModel: (info) => {
        if (info.status === 'loading') {
          setModelStatus(
            locale === 'it'
              ? `Caricamento… ${info.progress || 0}%`
              : `Loading speech… ${info.progress || 0}%`,
          );
          setDebugStatus(`loading model ${info.progress || 0}%`);
        } else if (info.status === 'ready') {
          setModelStatus('');
          setEngine(getEngineMode() || info.device || '');
          setPhase('hearing');
        }
      },
      onEngine: (e) => setEngine(e),
      onPhase: (p) => {
        if (p === 'hearing') setPhase('hearing');
        else if (p === 'transcribing') setPhase('translating');
        else if (p === 'webspeech') setPhase('hearing');
      },
      onLevel: (lvl) => {
        setMicLevel(lvl);
        if (lvl < 0.0015 && activeRef.current && !silentWarnedRef.current) {
          // defer warning — onStatus handles after sustained silence
        }
      },
      onStatus: (msg) => {
        setDebugStatus(msg);
        if (msg?.includes('mic silent') && !silentWarnedRef.current) {
          silentWarnedRef.current = true;
          setMicError(bilingual('micSilent'));
        }
      },
      onInterim: (txt) => {
        if (!txt) {
          setInterim('');
          return;
        }
        if (txt === '…' || txt === 'Recording…') {
          setInterim(locale === 'it' ? t('heardSomething', 'it') : t('heardSomething', 'en'));
        } else {
          setInterim(txt);
        }
      },
      onFinal: (text) => addLine(text),
      onError: (code) => {
        setMicError(code === 'mic-denied' ? bilingual('micDenied') : bilingual('micRequired'));
        stop();
      },
    });

    if (!activeRef.current) stop();
  }, [addLine, locale, stop]);

  const filteredLangs = langSearch.trim()
    ? LANGUAGE_LIST.filter((l) =>
      l.name.toLowerCase().includes(langSearch.toLowerCase()) ||
      l.native.toLowerCase().includes(langSearch.toLowerCase()))
    : LANGUAGE_LIST;

  const pinnedLangs = PINNED.map((k) => LANGUAGE_LIST.find((l) => l.key === k)).filter(Boolean);

  const phaseLabel = {
    idle: '',
    loading: modelStatus || (locale === 'it' ? 'Avvio…' : 'Starting…'),
    hearing: locale === 'it' ? 'In ascolto…' : 'Listening…',
    translating: locale === 'it' ? 'Traduzione…' : 'Translating…',
  }[phase];

  const levelPct = Math.min(100, Math.round(micLevel * 3200));

  const engineLabel = engine === 'whisper' ? 'On-device' : (engine === 'webspeech' ? 'Web Speech' : '');

  return (
    <div className="mode-screen expert-mode">
      <header className="mode-header">
        <button type="button" className="back-btn" onClick={() => { stop(); onBack(); }}>←</button>
        <div>
          <h1 className="mode-title">Expert Listener</h1>
          <p className="mode-sub">
            {locale === 'it' ? 'Solo ascolto — guida o oratore' : 'Listen only — tour guide or speaker'}
          </p>
        </div>
        <button
          type="button"
          className={`icon-toggle ${ttsOn ? 'icon-toggle-on' : ''}`}
          onClick={() => setTtsOn((v) => !v)}
          aria-label="TTS"
        >
          {ttsOn ? '🔊' : '🔇'}
        </button>
      </header>

      <div className="expert-toolbar">
        <button
          type="button"
          className="lang-chip"
          onClick={() => setShowLangPicker('target')}
        >
          → {targetLang.flag} {targetLang.name} ▾
        </button>
        <button
          type="button"
          className="lang-chip lang-chip-muted"
          onClick={() => setShowLangPicker('source')}
        >
          {sourceHint
            ? `${sourceHint.flag} ${sourceHint.name} ▾`
            : `🌐 ${locale === 'it' ? 'Auto lingua' : 'Auto-detect'} ▾`}
        </button>
        {engineLabel && <span className="engine-chip">{engineLabel}</span>}
      </div>

      <div className="expert-scroll">
        {lines.length === 0 && !interim && !active && (
          <div className="empty">
            <span className="empty-icon">👂</span>
            <p>
              {locale === 'it'
                ? 'Tap Start. La guida parla — tu leggi e ascolti la traduzione.'
                : 'Tap Start. Guide talks — you read and hear translations continuously.'}
            </p>
          </div>
        )}

        {lines.map((line, idx) => {
          const isNewest = idx === lines.length - 1 && !interim;
          return (
            <article
              key={line.id}
              className={`expert-line ${isNewest ? 'expert-line-live' : ''} ${line.failed ? 'expert-line-fail' : ''}`}
            >
              <div className="expert-line-meta">
                <span>{line.sourceLang?.flag} {line.sourceLang?.name || '?'}</span>
                <span>{line.time}</span>
              </div>
              <p className="expert-original">{line.text}</p>
              <p className={`expert-trans ${line.translating ? 'is-pending' : ''}`}>
                {line.translating ? t('translating', locale) : line.translation}
              </p>
              {line.provider && !line.translating && !line.failed && (
                <span className="provider-chip">{t('viaProvider', locale, line.provider)}</span>
              )}
              {line.failed && (
                <button type="button" className="retry-btn" onClick={() => retryLine(line)}>
                  ↻ {locale === 'it' ? 'Riprova' : 'Retry'}
                </button>
              )}
            </article>
          );
        })}

        {interim && (
          <article className="expert-line expert-line-interim expert-line-live">
            <p className="expert-original">{interim}</p>
            <p className="expert-trans is-pending" style={{ fontSize: '1rem' }}>
              {locale === 'it' ? 'Riconoscimento…' : 'Recognizing…'}
            </p>
          </article>
        )}
        <div ref={listEndRef} />
      </div>

      <div className="expert-bar">
        {active && (
          <>
            <div className="expert-status-row">
              <span className={`expert-pulse ${phase === 'hearing' ? 'expert-pulse-on' : ''}`} />
              <span className="expert-status-text">{phaseLabel}</span>
              <div className="mic-meter" aria-hidden="true">
                <div className="mic-meter-fill" style={{ width: `${levelPct}%` }} />
              </div>
            </div>
            {debugStatus && (
              <p className="expert-debug">{debugStatus}</p>
            )}
          </>
        )}

        {lines.length > 0 && !active && (
          <button
            type="button"
            className="text-btn"
            onClick={() => { setLines([]); seenRef.current.clear(); }}
          >
            {locale === 'it' ? 'Cancella' : 'Clear'}
          </button>
        )}

        <button
          type="button"
          className={`expert-stop ${active ? 'expert-stop-on' : ''}`}
          onClick={active ? stop : start}
        >
          {active
            ? (locale === 'it' ? 'Ferma' : 'Stop')
            : (locale === 'it' ? 'Inizia ascolto' : 'Start listening')}
        </button>
      </div>

      {showLangPicker && (
        <div className="sheet-overlay" onClick={() => { setShowLangPicker(null); setLangSearch(''); }}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grab" />
            <h2 className="sheet-title">
              {showLangPicker === 'target'
                ? (locale === 'it' ? 'Traduci in' : 'Translate into')
                : (locale === 'it' ? 'Lingua guida (opzionale)' : 'Guide language (optional)')}
            </h2>
            {showLangPicker === 'source' && (
              <button
                type="button"
                className="lang-row lang-row-auto"
                onClick={() => {
                  setSourceHint(null);
                  sourceRef.current = null;
                  try { localStorage.removeItem(SOURCE_HINT_KEY); } catch {}
                  setShowLangPicker(null);
                  setLangSearch('');
                }}
              >
                <span>🌐</span>
                <span>{locale === 'it' ? 'Auto-rilevamento' : 'Auto-detect'}</span>
              </button>
            )}
            <input
              className="sheet-search"
              placeholder="Search…"
              value={langSearch}
              onChange={(e) => setLangSearch(e.target.value)}
              autoFocus
            />
            {!langSearch && (
              <div className="sheet-pinned">
                {(showLangPicker === 'target' ? [ENGLISH, ...pinnedLangs] : pinnedLangs).map((lang) => (
                  <button
                    key={lang.key}
                    type="button"
                    className="lang-row"
                    onClick={() => {
                      if (showLangPicker === 'target') {
                        setTargetLang(lang);
                      } else {
                        setSourceHint(lang);
                        sourceRef.current = lang;
                      }
                      setShowLangPicker(null);
                      setLangSearch('');
                    }}
                  >
                    <span>{lang.flag}</span>
                    <span>{lang.name}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="sheet-list">
              {(showLangPicker === 'target'
                ? [ENGLISH, ...filteredLangs.filter((l) => l.key !== 'en')]
                : filteredLangs
              ).map((lang) => (
                <button
                  key={lang.key}
                  type="button"
                  className="lang-row"
                  onClick={() => {
                    if (showLangPicker === 'target') {
                      setTargetLang(lang);
                    } else {
                      setSourceHint(lang);
                      sourceRef.current = lang;
                    }
                    setShowLangPicker(null);
                    setLangSearch('');
                  }}
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
