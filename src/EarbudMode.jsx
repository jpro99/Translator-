import { useRef, useCallback, useState, useEffect } from 'react';
import {
  keepListening,
  stopMic,
  speechSupported,
  getEngineMode,
} from './speech';
import { useConversation } from './useConversation';
import { speakToEar } from './audio';
import { bilingual, t, uiLocale } from './i18n';

export default function EarbudMode({ onBack }) {
  const locale = uiLocale();
  const [active, setActive] = useState(false);
  const [ttsOn, setTtsOn] = useState(true);
  const [engine, setEngine] = useState('');
  const [modelStatus, setModelStatus] = useState('');
  const [micError, setMicError] = useState(null);
  const activeRef = useRef(false);
  const ttsRef = useRef(true);
  const chatEndRef = useRef(null);

  useEffect(() => { ttsRef.current = ttsOn; }, [ttsOn]);

  const onSpeak = useCallback(({ text, target, speaker }) => {
    if (!ttsRef.current) return;
    // Person A wears LEFT earbud — hears when B speaks (translation → left)
    // Person B wears RIGHT earbud — hears when A speaks (translation → right)
    const ear = speaker === 'a' ? 'right' : 'left';
    void speakToEar(text, target.speechCode, ear);
  }, []);

  const conv = useConversation({ onSpeak });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conv.messages, conv.interim]);

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

    await keepListening({
      activeRef,
      getLang: () => {
        const codes = conv.getSpeechLangs();
        return { speechCode: codes[0], fallbackCodes: codes.slice(1), whisperLang: 'auto' };
      },
      onModel: (info) => {
        if (info.status === 'loading') {
          setModelStatus(`Loading speech… ${info.progress || 0}%`);
        } else if (info.status === 'ready') {
          setModelStatus('');
          setEngine(getEngineMode() || '');
          conv.syncPersons();
        }
      },
      onEngine: (e) => setEngine(e),
      onPhase: (phase) => {
        if (phase === 'hearing') conv.setStatus(locale === 'it' ? 'In ascolto…' : 'Listening…');
        else if (phase === 'transcribing') conv.setStatus(locale === 'it' ? 'Traduzione…' : 'Translating…');
      },
      onInterim: (txt) => conv.setInterim(txt || ''),
      onFinal: (text) => conv.processUtterance(text),
      onError: () => {
        setMicError(bilingual('micDenied'));
        stop();
      },
    });

    if (!activeRef.current) stop();
  }, [conv, locale, stop]);

  return (
    <div className="mode-screen earbud-mode">
      <header className="mode-header">
        <button type="button" className="back-btn" onClick={() => { stop(); onBack(); }}>←</button>
        <div>
          <h1 className="mode-title">Earbuds</h1>
          <p className="mode-sub">
            {locale === 'it'
              ? 'Sinistra = Persona A · Destra = Persona B'
              : 'Left earbud = Person A · Right = Person B'}
          </p>
        </div>
        <button
          type="button"
          className={`icon-toggle ${ttsOn ? 'icon-toggle-on' : ''}`}
          onClick={() => setTtsOn((v) => !v)}
        >
          {ttsOn ? '🔊' : '🔇'}
        </button>
      </header>

      <div className="earbud-legend">
        <span className="ear-tag ear-left">◀ A</span>
        {engine && <span className="engine-chip">{engine === 'whisper' ? 'On-device' : 'Web Speech'}</span>}
        <span className="ear-tag ear-right">B ▶</span>
      </div>

      <div className="scroll scroll-chat">
        {conv.messages.length === 0 && !conv.interim && (
          <div className="empty">
            <span className="empty-icon">🎧</span>
            <p>{locale === 'it' ? 'Un auricolare ciascuno. Parlate liberamente.' : 'One earbud each. Start and talk.'}</p>
          </div>
        )}

        {conv.messages.map((msg) => (
          <article key={msg.id} className={`chat ${msg.speaker === 'a' ? 'chat-you' : 'chat-them'}`}>
            <div className="chat-label">
              {msg.speaker === 'a' ? '◀ Person A' : 'Person B ▶'}
              {msg.sourceLang && ` · ${msg.sourceLang.flag} ${msg.sourceLang.name}`}
            </div>
            <p className="chat-said chat-said-lg">{msg.said}</p>
            <p className="chat-arrow">
              → {msg.speaker === 'a' ? 'Right ear' : 'Left ear'}
              {msg.targetLang && ` · ${msg.targetLang.name}`}
            </p>
            <p className={`chat-trans chat-trans-lg ${msg.failed ? 'is-failed' : ''}`}>
              {msg.translating ? t('translating', locale) : msg.translation}
            </p>
            {msg.provider && !msg.failed && (
              <span className="provider-chip">{t('viaProvider', locale, msg.provider)}</span>
            )}
            {msg.failed && (
              <button type="button" className="retry-btn" onClick={() => conv.retryMessage(msg)}>
                ↻ {locale === 'it' ? 'Riprova' : 'Retry'}
              </button>
            )}
          </article>
        ))}

        {conv.interim && (
          <article className="chat chat-interim">
            <p className="chat-said chat-said-lg">{conv.interim}</p>
          </article>
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="turn-bar">
        {modelStatus && <p className="turn-status">{modelStatus}</p>}
        {conv.status && !modelStatus && <p className="turn-status">{conv.status}</p>}
        <button
          type="button"
          className={`listen-btn ${active ? 'listen-btn-on' : ''}`}
          onClick={active ? stop : start}
        >
          <span className="listen-btn-dot" />
          {active ? t('stopConverse', locale) : t('startConverse', locale)}
        </button>
      </div>

      {micError && (
        <div className="toast" onClick={() => setMicError(null)}>{micError}</div>
      )}
    </div>
  );
}
