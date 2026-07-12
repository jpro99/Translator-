/** Keep-alive speech recognition — restarts on silence until Stop is pressed. */

let activeRec = null;
let hardStop = false;

export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** Abort the current recognition engine only. The keep-alive loop continues. */
export function restartMic() {
  const rec = activeRec;
  activeRec = null;
  if (!rec) return;
  try { rec.abort(); } catch {}
}

/** Hard-stop: ends keepListening loops. Only call from Stop / tab switch. */
export function stopMic() {
  hardStop = true;
  restartMic();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * Continuous listen that keeps restarting through pauses.
 * Stops only when activeRef.current becomes false or stopMic() is called.
 */
export async function keepListening({ activeRef, getLang, onInterim, onFinal, onError }) {
  const SR = getSR();
  if (!SR) {
    onError?.('Use Chrome or Edge for speech recognition.');
    return;
  }

  hardStop = false;

  const shouldRun = () => activeRef.current && !hardStop;

  while (shouldRun()) {
    const lang = getLang() || 'en-US';
    let gotSpeech = false;
    let restartDelay = 100;

    await new Promise((resolve) => {
      if (!shouldRun()) {
        resolve();
        return;
      }

      let settled = false;
      let rec = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (activeRec === rec) activeRec = null;
        resolve();
      };

      try {
        rec = new SR();
      } catch {
        finish();
        return;
      }

      activeRec = rec;
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (event) => {
        if (!shouldRun()) return;
        gotSpeech = true;

        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = (result[0]?.transcript || '').trim();
          if (!text) continue;
          if (result.isFinal) {
            Promise.resolve(onFinal?.(text)).catch(() => {});
          } else {
            interim = text;
          }
        }
        if (interim) onInterim?.(interim);
      };

      rec.onerror = (e) => {
        const err = e?.error || '';
        if (err === 'no-speech' || err === 'aborted' || err === 'speech-timeout') {
          restartDelay = 60;
          return;
        }
        if (err === 'not-allowed') {
          onError?.('Microphone access denied — allow it in browser settings.');
          activeRef.current = false;
          hardStop = true;
          finish();
          return;
        }
        if (err === 'audio-capture') {
          onError?.('No microphone found.');
          activeRef.current = false;
          hardStop = true;
          finish();
          return;
        }
        restartDelay = err === 'network' ? 1200 : 350;
      };

      // When restartMic() nulls onend before abort, we still need to finish.
      // So wrap: if handlers cleared, poll briefly.
      rec.onend = () => finish();

      try {
        rec.start();
      } catch {
        restartDelay = 350;
        finish();
      }
    });

    if (!shouldRun()) break;
    await sleep(gotSpeech ? 60 : restartDelay);
  }
}

/** Probe whether the given language is being spoken right now. */
export function probeLanguage(lang, timeoutMs = 3500) {
  const SR = getSR();
  if (!SR) return Promise.resolve(null);

  return new Promise((resolve) => {
    hardStop = false;
    let settled = false;
    let rec = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeRec === rec) activeRec = null;
      try {
        if (rec) {
          rec.onresult = null;
          rec.onerror = null;
          rec.onend = null;
          rec.abort();
        }
      } catch {}
      resolve(result);
    };

    try {
      rec = new SR();
    } catch {
      finish(null);
      return;
    }

    activeRec = rec;
    rec.lang = lang.speechCode;
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    const timer = setTimeout(() => finish(null), timeoutMs);

    rec.onresult = (e) => {
      const alt = e.results[0]?.[0];
      const t = alt?.transcript?.trim() ?? '';
      const conf = alt?.confidence ?? 1;
      if (!t || conf < 0.4) return finish(null);

      let match = lang.isMine?.(t);
      if (lang.key === 'ja' && match) {
        const hasHiragana = /[ぁ-ん]/.test(t);
        const hasKanji = /[一-鿿]/.test(t);
        if (!hasHiragana && !hasKanji) match = false;
      }
      finish(match ? { lang, text: t } : null);
    };

    rec.onerror = () => finish(null);
    rec.onend = () => { if (!settled) finish(null); };

    try {
      rec.start();
    } catch {
      finish(null);
    }
  });
}

export async function detectSpokenLanguage(candidates, onTrying, cancelRef) {
  for (const lang of candidates) {
    if (cancelRef && !cancelRef.current) return null;
    onTrying?.(lang);
    const hit = await probeLanguage(lang);
    if (cancelRef && !cancelRef.current) return null;
    if (hit) return hit.lang;
    await sleep(200);
  }
  return null;
}

export { sleep };
