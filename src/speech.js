/**
 * Crash-safe speech recognition for Chrome (esp. Android).
 * One session at a time; stop waits for native teardown; generation
 * tokens ignore stale callbacks so loops never overlap or hang.
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
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}

/**
 * Hard-stop the mic and wait until the native session is gone.
 * Safe to call repeatedly (including without await).
 */
export async function stopMic() {
  gen += 1;
  const session = active;
  if (!session) return;

  try {
    session.rec.stop();
  } catch {
    try {
      session.rec.abort();
    } catch {
      session.finish(null);
    }
  }

  await Promise.race([session.ended, sleep(800)]);
  if (active === session) {
    clearHandlers(session.rec);
    active = null;
    session.finish(null);
  }
  // Android Chrome needs a short gap before the next start().
  await sleep(220);
}

/**
 * Wait until any in-flight session has fully ended.
 */
async function waitUntilIdle(myGen) {
  while (active) {
    if (myGen !== gen) return false;
    await Promise.race([active.ended, sleep(500)]);
    if (active) await sleep(100);
  }
  if (myGen !== gen) return false;
  await sleep(180);
  return myGen === gen;
}

/**
 * Listen for a single utterance. Resolves transcript string or null.
 * Never leaves the mic stuck; always settles.
 */
export async function listenOnce({ lang, onInterim, timeoutMs = 12000 } = {}) {
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
    const ended = new Promise((r) => {
      endResolve = r;
    });

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
      try {
        rec.stop();
      } catch {
        finish(null);
      }
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
          try {
            rec.stop();
          } catch {}
          return;
        }
        interim = text;
      }
      if (interim) onInterim?.(interim);
    };

    rec.onerror = (event) => {
      // no-speech / aborted are normal on mobile — onend settles.
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
 * Passive listen loop — one phrase at a time with a short gap between sessions.
 * onLine may be async; mic stays off until it finishes.
 */
export async function listenLoop({
  activeRef,
  langRef,
  gapMs = 600,
  onInterim,
  onLine,
}) {
  const myGen = ++gen;

  while (activeRef.current && myGen === gen) {
    const lang = typeof langRef === 'function'
      ? langRef()
      : (langRef.current?.speechCode || langRef.current);

    let text = null;
    try {
      text = await listenOnce({
        lang,
        onInterim: activeRef.current && myGen === gen ? onInterim : undefined,
      });
    } catch {
      await sleep(500);
      continue;
    }

    if (!activeRef.current || myGen !== gen) break;

    if (text) {
      try {
        await onLine(text);
      } catch {}
    }

    if (!activeRef.current || myGen !== gen) break;
    await sleep(gapMs);
  }
}

/**
 * Probe whether the given language is being spoken right now.
 */
export async function probeLanguage(lang, timeoutMs = 3500) {
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
    const ended = new Promise((r) => {
      endResolve = r;
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active?.rec === rec) active = null;
      clearHandlers(rec);
      endResolve();
      resolve(result);
    };

    const rec = makeRec(lang.speechCode);
    if (!rec) {
      resolve(null);
      return;
    }

    active = { rec, finish, ended };
    rec.interimResults = false;

    const timer = setTimeout(() => {
      try {
        rec.stop();
      } catch {
        finish(null);
      }
    }, timeoutMs);

    rec.onresult = (e) => {
      if (myGen !== gen) return;
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

    rec.onerror = (event) => {
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
 * Scan unique-script languages until one matches spoken audio.
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
