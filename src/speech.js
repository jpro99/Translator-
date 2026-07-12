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

/**
 * Continuous listen — keeps the mic open, emits interim + final transcripts.
 * Auto-restarts after pauses/errors while activeRef is true.
 */
export function listenContinuous({ activeRef, langRef, onInterim, onFinal }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  let rec = null;
  let lastFinal = '';

  const start = () => {
    if (!activeRef.current) return;

    try { rec?.abort(); } catch {}
    rec = new SR();
    activeRec = rec;
    busy = true;
    rec.lang = langRef.current?.speechCode || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      if (!activeRef.current) return;
      let interim = '';
      let finals = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? '';
        if (!text) continue;
        if (r.isFinal) finals.push(text.trim());
        else interim += text;
      }
      if (interim.trim()) onInterim?.(interim.trim());
      for (const text of finals) {
        if (!text || text === lastFinal) continue;
        lastFinal = text;
        onFinal?.(text);
      }
    };

    rec.onerror = (e) => {
      if (!activeRef.current) return;
      if (e.error === 'aborted') return;
      setTimeout(start, 400);
    };

    rec.onend = () => {
      busy = false;
      if (activeRec === rec) activeRec = null;
      if (activeRef.current) setTimeout(start, 200);
    };

    try { rec.start(); } catch {
      busy = false;
      if (activeRef.current) setTimeout(start, 600);
    }
  };

  start();
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
