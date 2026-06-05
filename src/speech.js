/** One mic session at a time — prevents duplicate results and overlapping beeps. */
let busy = false;
let activeRec = null;

export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function stopMic() {
  busy = false;
  try { activeRec?.abort(); } catch {}
  activeRec = null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Listen for a single utterance, then stop. Resolves transcript or null.
 */
export function listenOnce({ lang, onInterim }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || busy) return Promise.resolve(null);

  return new Promise((resolve) => {
    busy = true;
    let settled = false;
    const rec = new SR();
    activeRec = rec;
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      busy = false;
      if (activeRec === rec) activeRec = null;
      resolve(text);
    };

    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      const text = r[0]?.transcript ?? '';
      if (!r.isFinal) { onInterim?.(text); return; }
      finish(text.trim() || null);
    };

    rec.onerror = (e) => {
      if (e.error !== 'aborted') finish(null);
    };

    rec.onend = () => { if (!settled) finish(null); };

    try { rec.start(); } catch { finish(null); }
  });
}

/** Passive listen loop — one phrase at a time, pause between sessions. */
export async function listenLoop({ activeRef, langRef, gapMs, onInterim, onLine }) {
  while (activeRef.current) {
    const text = await listenOnce({
      lang: langRef.current.speechCode,
      onInterim: activeRef.current ? onInterim : undefined,
    });
    if (!activeRef.current) break;
    if (text) onLine(text);
    await sleep(gapMs);
  }
}
