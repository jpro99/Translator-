/** Speech recognition — one mic session at a time, with clear errors. */
let activeRec = null;

const ERROR_MESSAGES = {
  unsupported: 'Use Chrome or Edge for speech recognition.',
  'not-allowed': 'Microphone blocked. Allow mic access in your browser settings.',
  'no-speech': null,
  network: 'Speech needs internet. Check your connection.',
  'audio-capture': 'No microphone found on this device.',
  'service-not-allowed': 'Speech not allowed here. Open the app over HTTPS in Chrome or Edge.',
  aborted: null,
  ended: null,
  'start-failed': 'Could not start the microphone. Tap the button and try again.',
};

export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function speechErrorMessage(error) {
  if (!error) return null;
  return ERROR_MESSAGES[error] ?? 'Speech recognition failed. Try again.';
}

export function stopMic() {
  try {
    activeRec?.abort();
  } catch {}
  activeRec = null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Listen for one utterance. Returns { text, error }.
 * Always aborts any prior session and waits briefly so the mic can release.
 */
export async function listenOnce({ lang, onInterim, timeoutMs = 20000 }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return { text: null, error: 'unsupported' };

  stopMic();
  await delay(200);

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    const rec = new SR();
    activeRec = rec;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (activeRec === rec) activeRec = null;
      resolve(result);
    };

    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      if (!e.results?.length) return;
      const r = e.results[e.results.length - 1];
      if (!r?.length) return;
      const text = r[0]?.transcript ?? '';
      if (!r.isFinal) {
        onInterim?.(text);
        return;
      }
      finish({ text: text.trim() || null, error: null });
    };

    rec.onerror = (e) => {
      if (e.error === 'aborted') {
        finish({ text: null, error: 'aborted' });
        return;
      }
      finish({ text: null, error: e.error || 'ended' });
    };

    rec.onend = () => {
      if (!settled) finish({ text: null, error: 'ended' });
    };

    timeoutId = setTimeout(() => {
      try {
        rec.stop();
      } catch {}
    }, timeoutMs);

    try {
      rec.start();
    } catch {
      finish({ text: null, error: 'start-failed' });
    }
  });
}

/** Passive listen loop — one phrase at a time, pause between sessions. */
export async function listenLoop({
  activeRef,
  langRef,
  gapMs = 1200,
  onInterim,
  onLine,
  onError,
}) {
  let fatalStreak = 0;

  while (activeRef.current) {
    const { text, error } = await listenOnce({
      lang: langRef.current.speechCode,
      onInterim: activeRef.current ? onInterim : undefined,
    });

    if (!activeRef.current) break;

    if (error) {
      const msg = speechErrorMessage(error);
      if (msg) onError?.(msg);

      const fatal = error === 'not-allowed' || error === 'service-not-allowed' || error === 'audio-capture';
      if (fatal) {
        activeRef.current = false;
        break;
      }

      if (error === 'network') {
        fatalStreak += 1;
        if (fatalStreak >= 4) {
          onError?.('Speech keeps failing. Tap stop, check your connection, then try again.');
          fatalStreak = 0;
        }
      } else if (error !== 'no-speech' && error !== 'ended' && error !== 'aborted') {
        fatalStreak = 0;
      }
    } else {
      fatalStreak = 0;
    }

    if (text) onLine(text);
    await delay(gapMs);
  }
}
