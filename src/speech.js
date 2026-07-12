/**
 * Continuous speech recognition that stays open while you talk.
 * Final phrases stream out as Chrome finalizes them — we do NOT stop
 * the mic between phrases (that was the in/out / beep cycle).
 *
 * Chrome eventually ends a session on long silence; we quietly reopen
 * with a short gap so listening feels always-on until Stop.
 */

let gen = 0;
let active = null; // { rec, endedResolve, ended }

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
  rec.onspeechstart = null;
  rec.onspeechend = null;
  rec.onnomatch = null;
  rec.onerror = null;
  rec.onend = null;
}

/** Soft-stop current session (language switch). Outer loop keeps running. */
export function restartMic() {
  const session = active;
  if (!session) return;
  try {
    session.rec.stop();
  } catch {
    try { session.rec.abort(); } catch {
      session.endedResolve?.();
    }
  }
}

/** Hard-stop — ends keepListening. Call from Stop / tab switch. */
export async function stopMic() {
  gen += 1;
  const session = active;
  if (!session) return;

  try {
    session.rec.stop();
  } catch {
    try { session.rec.abort(); } catch {
      session.endedResolve?.();
    }
  }

  await Promise.race([session.ended, sleep(800)]);
  if (active === session) {
    clearHandlers(session.rec);
    active = null;
    session.endedResolve?.();
  }
  await sleep(200);
}

/**
 * Stay listening until activeRef is false or stopMic().
 * Phrases are delivered through onFinal as they complete; interim text
 * streams through onInterim while the person is mid-sentence.
 */
export async function keepListening({
  activeRef,
  getLang,
  onInterim,
  onFinal,
  onError,
}) {
  const SR = getSR();
  if (!SR) {
    onError?.('Use Chrome or Edge for speech recognition.');
    return;
  }

  const myGen = ++gen;
  let emptyDeaths = 0;

  while (activeRef.current && myGen === gen) {
    const lang = (typeof getLang === 'function' ? getLang() : getLang) || 'en-US';
    let gotSpeech = false;
    let startedAt = Date.now();

    await new Promise((resolve) => {
      if (!activeRef.current || myGen !== gen || active) {
        resolve();
        return;
      }

      let endedResolve;
      const ended = new Promise((r) => { endedResolve = r; });
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (active?.rec === rec) active = null;
        clearHandlers(rec);
        endedResolve();
        resolve();
      };

      let rec;
      try {
        rec = new SR();
      } catch {
        resolve();
        return;
      }

      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      active = { rec, endedResolve, ended };

      rec.onresult = (event) => {
        if (myGen !== gen || !activeRef.current) return;
        gotSpeech = true;
        emptyDeaths = 0;

        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = (result[0]?.transcript || '').trim();
          if (!text) continue;

          if (result.isFinal) {
            // Keep the session open — do NOT stop/abort here.
            Promise.resolve(onFinal?.(text)).catch(() => {});
          } else {
            interim = text;
          }
        }
        if (interim) onInterim?.(interim);
        else if (event.results[event.results.length - 1]?.isFinal) {
          // Clear interim bubble once a final lands
          onInterim?.('');
        }
      };

      rec.onerror = (event) => {
        const err = event?.error || '';
        // Silence / abort: normal. Session will end → we reopen.
        if (err === 'no-speech' || err === 'aborted' || err === 'speech-timeout') return;
        if (err === 'not-allowed') {
          onError?.('Microphone access denied — allow it in browser settings.');
          activeRef.current = false;
          finish();
          return;
        }
        if (err === 'audio-capture') {
          onError?.('No microphone found.');
          activeRef.current = false;
          finish();
          return;
        }
        // network etc. — let onend reopen after a pause
      };

      rec.onend = () => finish();

      try {
        rec.start();
      } catch {
        finish();
      }
    });

    if (!activeRef.current || myGen !== gen) break;

    // Chrome closed the session. Reopen quietly so listening never "stops".
    const livedMs = Date.now() - startedAt;
    if (!gotSpeech) {
      emptyDeaths += 1;
      // Back off if the engine is dying instantly (avoids beep storms)
      const delay = emptyDeaths >= 3 ? 2000 : emptyDeaths >= 2 ? 1000 : 450;
      await sleep(delay);
    } else if (livedMs < 800) {
      await sleep(600);
    } else {
      // Normal end after speech/silence — reopen fast
      await sleep(280);
    }
  }
}

export const listenLoop = keepListening;

/** Single-utterance helper (language probe / rare one-shots). */
export async function listenOnce({ lang, onInterim, timeoutMs = 12000 } = {}) {
  if (!speechSupported()) return null;
  if (active) {
    restartMic();
    await sleep(300);
  }

  return new Promise((resolve) => {
    const SR = getSR();
    if (!SR) {
      resolve(null);
      return;
    }

    let settled = false;
    let endedResolve;
    const ended = new Promise((r) => { endedResolve = r; });
    let rec;

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (active?.rec === rec) active = null;
      clearHandlers(rec);
      endedResolve();
      resolve(text);
    };

    try {
      rec = new SR();
    } catch {
      resolve(null);
      return;
    }

    rec.lang = lang || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    active = { rec, endedResolve, ended };

    const timer = setTimeout(() => {
      try { rec.stop(); } catch { finish(null); }
    }, timeoutMs);

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = (result[0]?.transcript || '').trim();
        if (!text) continue;
        if (result.isFinal) {
          finish(text);
          return;
        }
        interim = text;
      }
      if (interim) onInterim?.(interim);
    };

    rec.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      finish(null);
    };

    rec.onend = () => { if (!settled) finish(null); };

    try {
      rec.start();
    } catch {
      finish(null);
    }
  });
}

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
