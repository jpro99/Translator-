import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';

const rootEl = document.getElementById('root');

try {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (err) {
  console.error(err);
  const boot = document.getElementById('boot-msg');
  if (boot) boot.textContent = 'App failed to start. Tap reload.';
  const btn = document.getElementById('boot-btn');
  if (btn) btn.hidden = false;
}

// When a new service worker takes over, reload once so we don't keep stale JS.
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
