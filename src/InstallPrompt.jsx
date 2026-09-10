import { useState, useEffect, useCallback } from 'react';
import {
  isStandalone, isIosSafari, getDeferredInstall, clearDeferredInstall,
} from './pwaInstall';
import { t, uiLocale } from './i18n';

/**
 * Home-screen install affordance:
 * - Android Chrome: Install app button (beforeinstallprompt)
 * - iOS Safari: Add to Home Screen steps
 * - Already installed: Installed ✓
 */
export default function InstallPrompt() {
  const locale = uiLocale();
  const [state, setState] = useState('checking');
  const [deferred, setDeferred] = useState(null);
  const [iosDismissed, setIosDismissed] = useState(false);

  useEffect(() => {
    if (isStandalone()) {
      setState('installed');
      return;
    }

    if (isIosSafari()) {
      setState('ios');
      return;
    }

    const existing = getDeferredInstall();
    if (existing) {
      setDeferred(existing);
      setState('promptable');
    } else {
      setState('waiting');
    }

    const onAvailable = () => {
      const prompt = getDeferredInstall();
      if (prompt) {
        setDeferred(prompt);
        setState('promptable');
      }
    };

    const onInstalled = () => {
      setDeferred(null);
      setState('installed');
    };

    window.addEventListener('pwa-install-available', onAvailable);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('pwa-install-available', onAvailable);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    clearDeferredInstall();
    setDeferred(null);
    if (outcome === 'accepted') setState('installed');
    else setState('waiting');
  }, [deferred]);

  if (state === 'checking' || state === 'waiting') return null;

  if (state === 'installed') {
    return (
      <div className="install-banner install-banner-done" role="status">
        <span className="install-icon">✓</span>
        <span>{t('installed', locale)}</span>
      </div>
    );
  }

  if (state === 'promptable') {
    return (
      <div className="install-banner install-banner-cta">
        <div className="install-cta-text">
          <span className="install-icon">📲</span>
          <div>
            <strong>{t('installTitle', locale)}</strong>
            <p>{t('installSubtitle', locale)}</p>
          </div>
        </div>
        <button type="button" className="install-btn" onClick={install}>
          {t('installButton', locale)}
        </button>
      </div>
    );
  }

  if (state === 'ios' && !iosDismissed) {
    return (
      <div className="install-banner install-banner-ios">
        <div className="install-ios-header">
          <span className="install-icon">📲</span>
          <strong>{t('iosInstallTitle', locale)}</strong>
          <button
            type="button"
            className="install-dismiss"
            onClick={() => setIosDismissed(true)}
            aria-label={locale === 'it' ? 'Chiudi' : 'Dismiss'}
          >
            ×
          </button>
        </div>
        <ol className="install-ios-steps">
          <li>
            <span className="step-icon" aria-hidden="true">⎋</span>
            <span>{t('iosStep1', locale)}</span>
          </li>
          <li>
            <span className="step-icon" aria-hidden="true">➕</span>
            <span>{t('iosStep2', locale)}</span>
          </li>
        </ol>
        {locale === 'it' && (
          <p className="install-ios-en">{t('iosInstallTitle', 'en')} · Share → Add to Home Screen</p>
        )}
      </div>
    );
  }

  return null;
}
