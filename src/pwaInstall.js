/** PWA install detection helpers. */

let deferredInstall = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    window.dispatchEvent(new Event('pwa-install-available'));
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
  });
}

export function getDeferredInstall() {
  return deferredInstall;
}

export function clearDeferredInstall() {
  deferredInstall = null;
}

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
  );
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isIosSafari() {
  if (!isIos()) return false;
  const ua = navigator.userAgent.toLowerCase();
  return /safari/.test(ua) && !/crios|fxios|edgios|chrome/.test(ua);
}
