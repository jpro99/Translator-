import { useRef, useCallback, useState, useEffect } from 'react';
import {
  keepListening,
  stopMic,
  restartMic,
  speechSupported,
  getEngineMode,
} from './speech';
import { useConversation } from './useConversation';
import { speakAloud } from './audio';
import { bilingual, t, uiLocale } from './i18n';

export default function TableMode({ onBack }) {
  const locale = uiLocale();
  const [active, setActive] = useState(false);
  const [engine, setEngine] = useState('');
  const [modelStatus, setModelStatus] = useState('');
  const [micError, setMicError] = useState(null);
  const activeRef = useRef(false);

  const onSpeak = useCallback(({ text, target }) => {
    speakAloud(text, target.speechCode);
  }, []);

  const conv = useConversation({ onSpeak });

  useEffect(() => () => {
    activeRef.current = false;
    stopMic();
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    conv.setStatus('');
    conv.setInterim('');
    stopMic();
  }, [conv]);

  const start = useCallback(async () => {
    if (!speechSupported()) {
      setMicError(bilingual('speechUnsupported'));
      return;
    }
    setMicError(null);
    conv.reset();
    activeRef.current = true;
    setActive(true);
    conv.setStatus(locale === 'it' ? 'Avvio…' : 'Starting…');

    await keepListening({
      activeRef,
      getLang: () => {
        const codes = conv.getSpeechLangs();
        return { speechCode: codes[0], fallbackCodes: codes.slice(1), whisperLang: 'auto' };
      },
      onModel: (info) => {
        if (info.status === 'loading') {
          setModelStatus(
            locale === 'it'
              ? `Caricamento voce… ${info.progress || 0}%`
              : `Loading speech model… ${info.progress || 0}%`,
          );
        } else if (info.status === 'ready') {
          setModelStatus('');
          setEngine(getEngineMode() || info.device || '');
          conv.syncPersons();
        }
      },
      onEngine: (e) => setEngine(e),
      onPhase: (phase) => {
        if (phase === 'hearing') {
          conv.setStatus(locale === 'it' ? 'In ascolto…' : 'Listening…');
        } else if (phase === 'transcribing') {
          conv.setStatus(locale === 'it' ? 'Traduzione…' : 'Translating…');
        }
      },
      onInterim: (txt) => conv.setInterim(txt || ''),
      onFinal: (text) => conv.processUtterance(text),
      onError: (code) => {
        const msg = code === 'mic-denied' ? bilingual('micDenied') : bilingual('micRequired');
        setMicError(msg);
        stop();
      },
    });

    if (!activeRef.current) stop();
  }, [conv, locale, stop]);

  const latestA = [...conv.messages].reverse().find((m) => m.speaker === 'a');
  const latestB = [...conv.messages].reverse().find((m) => m.speaker === 'b');

  return (
    <div className="mode-screen table-mode">
      <header className="mode-header">
        <button type="button" className="back-btn" onClick={() => { stop(); onBack(); }}>←</button>
        <div>
          <h1 className="mode-title">Table Mode</h1>
          <p className="mode-sub">
            {locale === 'it' ? 'Telefono al centro del tavolo' : 'Phone face-up between you'}
          </p>
        </div>
        {engine && <span className="engine-chip">{engine === 'whisper' ? 'On-device' : 'Web Speech'}</span>}
      </header>

      <div className="table-split">
        {/* Person B — top, rotated 180° so they read upright */}
        <section className="table-pane table-pane-top rotate-180">
          <div className="pane-label">
            {conv.personB ? `${conv.personB.flag} ${conv.personB.name}` : 'Person B'}
          </div>
          <PaneContent
            msg={latestB}
            interim={conv.interim}
            otherLang={conv.personA}
            locale={locale}
            onRetry={conv.retryMessage}
          />
        </section>

        <div className="table-rail">
          {modelStatus && <p className="rail-status">{modelStatus}</p>}
          {conv.status && !modelStatus && <p className="rail-status">{conv.status}</p>}
          <button
            type="button"
            className={`table-go ${active ? 'table-go-on' : ''}`}
            onClick={active ? stop : start}
          >
            {active
              ? (locale === 'it' ? 'Ferma' : 'Stop')
              : (locale === 'it' ? 'Inizia' : 'Start')}
          </button>
        </div>

        {/* Person A — bottom, normal orientation */}
        <section className="table-pane table-pane-bottom">
          <div className="pane-label">
            {conv.personA ? `${conv.personA.flag} ${conv.personA.name}` : 'Person A'}
          </div>
          <PaneContent
            msg={latestA}
            interim={conv.interim}
            otherLang={conv.personB}
            locale={locale}
            onRetry={conv.retryMessage}
          />
        </section>
      </div>

      {micError && (
        <div className="toast" onClick={() => setMicError(null)}>{micError}</div>
      )}
    </div>
  );
}

function PaneContent({ msg, interim, locale, onRetry }) {
  if (!msg && !interim) {
    return (
      <p className="pane-empty">
        {locale === 'it' ? 'Parla…' : 'Speak…'}
      </p>
    );
  }

  if (interim && !msg?.translating) {
    return <p className="pane-interim">{interim === '…' ? '…' : interim}</p>;
  }

  if (!msg) return null;

  return (
    <div className="pane-content">
      <p className="pane-original">{msg.said}</p>
      <p className={`pane-trans ${msg.failed ? 'is-failed' : ''}`}>
        {msg.translating ? t('translating', locale) : msg.translation}
      </p>
      {msg.provider && !msg.translating && !msg.failed && (
        <span className="provider-chip">{t('viaProvider', locale, msg.provider)}</span>
      )}
      {msg.failed && (
        <button type="button" className="retry-btn" onClick={() => onRetry(msg)}>
          ↻ {locale === 'it' ? 'Riprova' : 'Retry'}
        </button>
      )}
    </div>
  );
}
