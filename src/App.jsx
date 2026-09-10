import { useState, useEffect } from 'react';
import TableMode from './TableMode';
import EarbudMode from './EarbudMode';
import { bilingual, uiLocale } from './i18n';
import { onOnlineRetry, dequeueRetry } from './retryQueue';
import { translateWithDetection } from './translate';

const LIVE_URL = 'https://jpro99.github.io/Translator-/';

export default function App() {
  const [mode, setMode] = useState('home');
  const [offline, setOffline] = useState(!navigator.onLine);
  const locale = uiLocale();

  useEffect(() => {
    const onOff = () => setOffline(!navigator.onLine);
    window.addEventListener('online', onOff);
    window.addEventListener('offline', onOff);
    const unsub = onOnlineRetry(async (item) => {
      const result = await translateWithDetection(item.text, item.from, item.to);
      if (result?.translation) dequeueRetry(item.id);
    });
    return () => {
      window.removeEventListener('online', onOff);
      window.removeEventListener('offline', onOff);
      unsub();
    };
  }, []);

  if (mode === 'table') return <TableMode onBack={() => setMode('home')} />;
  if (mode === 'earbuds') return <EarbudMode onBack={() => setMode('home')} />;

  return (
    <div className="app home-app">
      {offline && <div className="offline-banner">{bilingual('offline')}</div>}

      <main className="home-main">
        <header className="home-hero">
          <p className="home-brand">Translator</p>
          <h1 className="home-headline">
            {locale === 'it' ? 'Parlate. Capite.' : 'Talk. Understand.'}
          </h1>
          <p className="home-tagline">
            {locale === 'it'
              ? 'Auto-rilevamento · Traduzione senza Google · Funziona in Italia'
              : 'Auto-detect · No Google required · Works in Italy'}
          </p>
        </header>

        <div className="mode-cards">
          <button type="button" className="mode-card mode-card-primary" onClick={() => setMode('table')}>
            <span className="mode-card-icon">🍽️</span>
            <span className="mode-card-name">Table Mode</span>
            <span className="mode-card-desc">
              {locale === 'it'
                ? 'Telefono al centro. Schermo diviso, testo capovolto per l\'altra persona.'
                : 'Phone between you. Split screen — their side reads upright.'}
            </span>
          </button>

          <button type="button" className="mode-card" onClick={() => setMode('earbuds')}>
            <span className="mode-card-icon">🎧</span>
            <span className="mode-card-name">Earbuds</span>
            <span className="mode-card-desc">
              {locale === 'it'
                ? 'Ognuno sente la traduzione nel proprio auricolare.'
                : 'Each person hears translations in their earbud.'}
            </span>
          </button>
        </div>

        <ul className="home-features">
          <li>{locale === 'it' ? 'Voce on-device (Whisper)' : 'On-device speech (Whisper)'}</li>
          <li>{locale === 'it' ? 'Traduzione multi-provider' : 'Multi-provider translation'}</li>
          <li>{locale === 'it' ? 'Italiano ↔ Inglese ecc.' : 'Italian ↔ English & more'}</li>
        </ul>
      </main>

      <footer className="home-footer">
        <a className="home-link" href={LIVE_URL}>{LIVE_URL.replace('https://', '')}</a>
      </footer>
    </div>
  );
}
