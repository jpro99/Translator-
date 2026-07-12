/** Single mic session — avoids overlapping recognizers and duplicate beeps. */
let busy = false;
let activeRec = null;

export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function stopMic() {
  const rec = activeRec;
  busy = false;
  activeRec = null;
  try { rec?.abort(); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRec(lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = lang;
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}

/**
 * Listen for a single utterance. Resolves transcript or null.
 * @param {{ lang: string, onInterim?: (t: string) => void, timeoutMs?: number }} opts
 */
export function listenOnce({ lang, onInterim, timeoutMs = 12000 }) {
  if (!speechSupported() || busy) return Promise.resolve(null);

  return new Promise((resolve) => {
    busy = true;
    let settled = false;
    const rec = makeRec(lang);
    if (!rec) {
      busy = false;
      resolve(null);
      return;
    }
    activeRec = rec;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeRec === rec) {
        activeRec = null;
        busy = false;
      }
      resolve(text);
    };

    const timer = setTimeout(() => {
      try { rec.stop(); } catch {}
      setTimeout(() => finish(null), 400);
    }, timeoutMs);

    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      const text = r[0]?.transcript ?? '';
      if (!r.isFinal) {
        onInterim?.(text);
        return;
      }
      finish(text.trim() || null);
    };

    rec.onerror = (e) => {
      if (e.error === 'aborted') {
        finish(null);
        return;
      }
      finish(null);
    };

    rec.onend = () => {
      if (!settled) finish(null);
    };

    try {
      rec.start();
    } catch {
      finish(null);
    }
  });
}

/**
 * Passive listen loop — one phrase at a time with a short gap between sessions.
 */
export async function listenLoop({ activeRef, langRef, gapMs = 600, onInterim, onLine }) {
  while (activeRef.current) {
    const lang = typeof langRef === 'function'
      ? langRef()
      : (langRef.current?.speechCode || langRef.current);
    const text = await listenOnce({
      lang,
      onInterim: activeRef.current ? onInterim : undefined,
    });
    if (!activeRef.current) break;
    if (text) {
      try {
        await onLine(text);
      } catch {}
    }
    await sleep(gapMs);
  }
}

/**
 * Probe whether the given language is being spoken right now.
 * Used for auto language detection (unique-script languages).
 */
export function probeLanguage(lang, timeoutMs = 3500) {
  if (!speechSupported() || busy) return Promise.resolve(null);

  return new Promise((resolve) => {
    busy = true;
    let settled = false;
    const rec = makeRec(lang.speechCode);
    if (!rec) {
      busy = false;
      resolve(null);
      return;
    }
    activeRec = rec;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeRec === rec) {
        activeRec = null;
        busy = false;
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { rec.stop(); } catch {}
      setTimeout(() => finish(null), 300);
    }, timeoutMs);

    rec.onresult = (e) => {
      const alt = e.results[0]?.[0];
      const t = alt?.transcript?.trim() ?? '';
      const conf = alt?.confidence ?? 1;
      if (!t || conf < 0.4) {
        finish(null);
        return;
      }
      let match = lang.isMine?.(t);
      // Chrome often phonetically maps other speech into pure katakana for ja-JP.
      if (lang.key === 'ja' && match) {
        const hasHiragana = /[ぁ-ん]/.test(t);
        const hasKanji = /[一-鿿]/.test(t);
        if (!hasHiragana && !hasKanji) match = false;
      }
      finish(match ? { lang, text: t } : null);
    };

    rec.onerror = () => finish(null);
    rec.onend = () => {
      if (!settled) finish(null);
    };

    try {
      rec.start();
    } catch {
      finish(null);
    }
  });
}

/**
 * Scan unique-script languages until one matches spoken audio.
 * @param {(lang) => void} onTrying - called as each candidate is probed
 * @param {{ current: boolean }} cancelRef - set current=false to abort
 */
export async function detectSpokenLanguage(candidates, onTrying, cancelRef) {
  for (const lang of candidates) {
    if (cancelRef && !cancelRef.current) return null;
    onTrying?.(lang);
    const hit = await probeLanguage(lang);
    if (cancelRef && !cancelRef.current) return null;
    if (hit) return hit.lang;
    await sleep(250);
  }
  return null;
}

export { sleep };
