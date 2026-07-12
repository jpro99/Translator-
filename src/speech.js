/**
 * Android-safe speech recognition.
 * One session at a time. continuous=false (Chrome mobile beeps on every start,
 * so we must NOT rapid-restart). Keeps looping until Stop — with calm gaps.
 */

let gen = 0;
let active = null; // { rec, finish, ended }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function speechSupported() {
  return !!getSR();
}

function clearHandlers(rec) {
  if (!rec) return;
  rec.onstart = null;
  rec.onresult = null;
  rec.onspeechend = null;
  rec.onnomatch = null;
  rec.onerror = null;
  rec.onend = null;
}

function makeRec(lang) {
  const SR = getSR();
  if (!SR) return null;
  const rec = new SR();
  rec.lang = lang || 'en-US';
  // continuous=true causes constant start/stop beeps on Android Chrome
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}

/** Soft-stop current utterance so the outer loop can restart with a new language. */
export function restartMic() {
  const session = active;
  if (!session) return;
  try {
    session.rec.stop();
  } catch {
    try { session.rec.abort(); } catch {
      session.finish(null);
    }
  }
}

/** Hard-stop — ends listen loops. Call from Stop / tab switch. */
export async function stopMic() {
  gen += 1;
  const session = active;
  if (!session) return;

  try {
    session.rec.stop();
  } catch {
    try { session.rec.abort(); } catch {
      session.finish(null);
    }
  }

  await Promise.race([session.ended, sleep(800)]);
  if (active === session) {
    clearHandlers(session.rec);
    active = null;
    session.finish(null);
  }
  // Android needs a gap before the next start()
  await sleep(250);
}

async function waitUntilIdle(myGen) {
  while (active) {
    if (myGen !== gen) return false;
    await Promise.race([active.ended, sleep(500)]);
    if (active) await sleep(120);
  }
  if (myGen !== gen) return false;
  await sleep(200);
  return myGen === gen;
}

/**
 * Listen for a single utterance. Resolves transcript or null.
 */
export async function listenOnce({ lang, onInterim, timeoutMs = 15000 } = {}) {
  if (!speechSupported()) return null;

  const myGen = gen;
  const ready = await waitUntilIdle(myGen);
  if (!ready) return null;

  return new Promise((resolve) => {
    if (myGen !== gen || active) {
      resolve(null);
      return;
    }

    let settled = false;
    let endResolve;
    const ended = new Promise((r) => { endResolve = r; });

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active?.rec === rec) active = null;
      clearHandlers(rec);
      endResolve();
      resolve(text);
    };

    const rec = makeRec(lang);
    if (!rec) {
      resolve(null);
      return;
    }

    active = { rec, finish, ended };

    const timer = setTimeout(() => {
      try { rec.stop(); } catch { finish(null); }
    }, timeoutMs);

    rec.onresult = (event) => {
      if (myGen !== gen) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = (result[0]?.transcript || '').trim();
        if (!text) continue;
        if (result.isFinal) {
          finish(text);
          try { rec.stop(); } catch {}
          return;
        }
        interim = text;
      }
      if (interim) onInterim?.(interim);
    };

    rec.onerror = (event) => {
      // Normal on mobile — let onend settle
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      finish(null);
    };

    rec.onend = () => {
      if (!settled) finish(null);
      else endResolve();
    };

    try {
      rec.start();
    } catch {
      finish(null);
    }
  });
}

/**
 * Keep listening until activeRef is false / stopMic().
 * Uses calm gaps so Android doesn't beep-loop.
 *   - after speech: ~1.2s
 *   - after silence: ~2.2s
 */
export async function keepListening({
  activeRef,
  getLang,
  onInterim,
  onFinal,
  onError,
  afterSpeechMs = 1200,
  afterSilenceMs = 2200,
}) {
  if (!speechSupported()) {
    onError?.('Use Chrome or Edge for speech recognition.');
    return;
  }

  const myGen = ++gen;

  while (activeRef.current && myGen === gen) {
    const lang = (typeof getLang === 'function' ? getLang() : getLang) || 'en-US';

    let text = null;
    try {
      text = await listenOnce({
        lang,
        onInterim: activeRef.current && myGen === gen ? onInterim : undefined,
      });
    } catch {
      if (!activeRef.current || myGen !== gen) break;
      await sleep(1500);
      continue;
    }

    if (!activeRef.current || myGen !== gen) break;

    if (text) {
      try {
        // Await so we don't immediately re-open the mic over ourselves,
        // but onFinal should still be fast (fire translation without blocking).
        await onFinal?.(text);
      } catch {}
      if (!activeRef.current || myGen !== gen) break;
      await sleep(afterSpeechMs);
    } else {
      // Silence — stay "listening" in the UI, just don't beep every 60ms
      await sleep(afterSilenceMs);
    }
  }
}

/** Back-compat alias */
export const listenLoop = keepListening;

/**
 * One-shot language probe. Prefer picking a language in the UI instead —
 * scanning many languages causes a beep storm on Android.
 */
export function probeLanguage(lang, timeoutMs = 4000) {
  return listenOnce({ lang: lang.speechCode, timeoutMs }).then((text) => {
    if (!text) return null;
    let match = lang.isMine?.(text);
    if (lang.key === 'ja' && match) {
      const hasHiragana = /[ぁ-ん]/.test(text);
      const hasKanji = /[一-鿿]/.test(text);
      if (!hasHiragana && !hasKanji) match = false;
    }
    return match ? { lang, text } : null;
  });
}

export async function detectSpokenLanguage(candidates, onTrying, cancelRef) {
  for (const lang of candidates) {
    if (cancelRef && !cancelRef.current) return null;
    onTrying?.(lang);
    const hit = await probeLanguage(lang);
    if (cancelRef && !cancelRef.current) return null;
    if (hit) return hit.lang;
    await sleep(500);
  }
  return null;
}
