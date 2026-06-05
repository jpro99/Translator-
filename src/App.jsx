import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { LANGUAGE_LIST, isEnglish, OFFLINE_STEPS, UNIQUE_SCRIPT_KEYS } from './languages';
import { PHRASE_CATEGORIES } from './phrases';

/* ─── Persistent translation cache ──────────────────────────────────── */
const _cacheInit = (() => {
  try { return JSON.parse(localStorage.getItem('tr_v1') || '[]'); } catch { return []; }
})();
const translationCache = new Map(_cacheInit);

function persistCache() {
  try {
    localStorage.setItem('tr_v1', JSON.stringify([...translationCache.entries()].slice(-900)));
  } catch {}
}

/* ─── Translation: MyMemory primary, Lingva fallback ────────────────── */
async function translate(text, from, to) {
  if (!text.trim() || from === to) return text;
  const key = `${text}|${from}|${to}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const save = (r) => { translationCache.set(key, r); persistCache(); return r; };
  const differs = (r) => r && r.trim().toLowerCase() !== text.trim().toLowerCase();
  try {
    const res  = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`);
    const data = await res.json();
    if (data.responseStatus === 200) { const r = data.responseData.translatedText; if (differs(r)) return save(r); }
  } catch {}
  try {
    const res  = await fetch(`https://lingva.ml/api/v1/${from}/${to}/${encodeURIComponent(text)}`);
    const data = await res.json();
    if (differs(data.translation)) return save(data.translation);
  } catch {}
  return null;
}

/* ─── Image resize ───────────────────────────────────────────────────── */
function resizeImageToBlob(file, maxWidth = 1200) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxWidth / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => resolve(b || file), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

/* ─── TTS ────────────────────────────────────────────────────────────── */
let _speakGen = 0;
function speak(text, langCode, onDone) {
  if (!window.speechSynthesis || !text) { onDone?.(); return; }
  const gen = ++_speakGen;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = langCode; utt.rate = 0.9; utt.pitch = 1.0;
  const finish = () => { if (gen === _speakGen) onDone?.(); };
  utt.onend = finish;
  utt.onerror = finish;
  window.speechSynthesis.speak(utt);
}
function stopSpeaking() { _speakGen++; window.speechSynthesis?.cancel(); }

/* ─── Language auto-detection (scanning unique-script languages) ─────── */
function tryRecognizeLanguage(lang, cancelRef) {
  return new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { resolve(false); return; }
    const rec = new SR();
    rec.lang = lang.speechCode; rec.continuous = false; rec.interimResults = false;
    cancelRef.rec = rec;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { try { rec.stop(); } catch {} finish(false); }, 3500);
    rec.onresult = (e) => {
      clearTimeout(timer);
      const alt = e.results[0]?.[0];
      const t = alt?.transcript?.trim() ?? '';
      const conf = alt?.confidence ?? 1; // default 1 when browser omits it
      if (!t || conf < 0.45) { finish(false); return; }
      let match = lang.isMine(t);
      // Japanese: Chrome phonetically transcribes ANY language into katakana.
      // Pure-katakana output (no hiragana particles, no kanji) is a fake match — reject it.
      if (lang.key === 'ja' && match) {
        const hasHiragana = /[ぁ-ん]/.test(t);
        const hasKanji    = /[一-鿿]/.test(t);
        if (!hasHiragana && !hasKanji) match = false;
      }
      finish(match);
    };
    rec.onend   = () => { clearTimeout(timer); finish(false); };
    rec.onerror = () => { clearTimeout(timer); finish(false); };
    try { rec.start(); } catch { finish(false); }
  });
}

async function detectSpeechLanguage(onStatus, cancelRef) {
  const candidates = LANGUAGE_LIST.filter(l => UNIQUE_SCRIPT_KEYS.has(l.key));
  for (const lang of candidates) {
    if (cancelRef.cancelled) return null;
    onStatus(lang);
    if (await tryRecognizeLanguage(lang, cancelRef)) return lang;
  }
  return null;
}

/* ─── Export ─────────────────────────────────────────────────────────── */
async function exportConversation(messages, language) {
  if (!messages.length) return;
  const lines = messages.map(m => {
    const who = m.speaker === 'foreign' ? language.name : 'English';
    return `[${who}]\n${m.foreignText}\n↓ ${m.englishText}`;
  });
  const text = `Conversation – ${language.name} / English\n${'─'.repeat(40)}\n${lines.join('\n\n')}`;
  if (navigator.share) { try { await navigator.share({ title: 'Conversation', text }); return; } catch {} }
  try { await navigator.clipboard.writeText(text); alert('Copied to clipboard!'); } catch {}
}

/* ─── App ────────────────────────────────────────────────────────────── */
let _id = 0;
const nextId = () => ++_id;

export default function App() {
  const [screen, setScreen]           = useState('off');
  const [language, setLanguage]       = useState(null);
  const [detectingLang, setDetectingLang] = useState(null);
  const [langSearch, setLangSearch]   = useState('');

  const [messages, setMessages]       = useState([]);
  const [interim, setInterim]         = useState({ side: null, text: '' });

  const [autoOn, setAutoOn]           = useState(false);
  const [autoStatus, setAutoStatus]   = useState('idle'); // 'idle'|'listening'|'processing'|'paused'
  const [pttActive, setPttActive]     = useState(false);  // user is holding the speak button
  const [foreignPttActive, setForeignPttActive] = useState(false);
  const [micError, setMicError]       = useState(null);
  const [toast, setToast]             = useState(null);

  const [ttsOn, setTtsOn]             = useState(false);
  const [showPhrasebook, setShowPhrasebook] = useState(false);
  const [phraseCategory, setPhraseCategory] = useState(0);
  const [phraseTranslations, setPhraseTranslations] = useState({});
  const [loadingPhrase, setLoadingPhrase] = useState(null);
  const [downloadingPhrases, setDownloadingPhrases] = useState(false);
  const [showTypeInput, setShowTypeInput] = useState(false);
  const [typeText, setTypeText]       = useState('');
  const [typeSide, setTypeSide]       = useState('english');
  const [showOfflineHelp, setShowOfflineHelp] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);

  const detectCancelRef  = useRef({ cancelled: false, rec: null });
  const autoRef          = useRef({ active: false, recs: {}, processing: false });
  const micSessionRef    = useRef({
    lastStart: 0, pendingTimer: null, restartTimes: [], dormantUntil: 0,
    restartAfterProcessing: false, foreignRec: null, foreignLangKey: null,
    processedUpToIndex: 0, staleResultsSkipped: false,
  });
  const foreignHadSpeechRef = useRef(false);
  const startForeignFnRef    = useRef(() => {});
  const pttRecRef        = useRef(null);
  const foreignPttRecRef = useRef(null);
  const foreignScrollRef = useRef(null);
  const englishScrollRef = useRef(null);
  const typeInputRef     = useRef(null);
  const cameraInputRef   = useRef(null);
  const toastTimer       = useRef(null);
  const ttsOnRef         = useRef(ttsOn);
  const listenCooldownUntilRef = useRef(0);
  const speechLockUntilRef       = useRef(0);
  const recentUtterancesRef    = useRef([]);
  const messagesRef            = useRef([]);

  useEffect(() => { ttsOnRef.current = ttsOn; }, [ttsOn]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const normalizeUtterance = (text) =>
    (text || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.,!?…]+$/g, '');

  const isSpeechLocked = () =>
    Date.now() < speechLockUntilRef.current || Date.now() < listenCooldownUntilRef.current;

  const lockSpeech = useCallback((ms = 12000) => {
    const until = Date.now() + ms;
    speechLockUntilRef.current = until;
    listenCooldownUntilRef.current = until;
    setInterim({ side: null, text: '' });
  }, []);

  const isDuplicateUtterance = useCallback((text) => {
    const norm = normalizeUtterance(text);
    if (!norm) return true;
    const now = Date.now();
    recentUtterancesRef.current = recentUtterancesRef.current.filter(u => now - u.time < 60000);
    if (recentUtterancesRef.current.some(u => u.text === norm)) return true;
    recentUtterancesRef.current.push({ text: norm, time: now });
    if (recentUtterancesRef.current.length > 24) {
      recentUtterancesRef.current = recentUtterancesRef.current.slice(-24);
    }
    return false;
  }, []);

  const beginListenCooldown = useCallback((ms = 12000) => {
    listenCooldownUntilRef.current = Date.now() + ms;
  }, []);

  // Always-on foreign mic restarts every few seconds (beeping) and mis-hears English.
  const usesAutoForeignListen = useCallback(() => false, []);

  const appendMessage = useCallback((entry) => {
    const en = normalizeUtterance(entry.englishText);
    const fo = normalizeUtterance(entry.foreignText);
    if (!en && !fo) return;
    const recent = messagesRef.current.slice(-8);
    if (recent.some(m => normalizeUtterance(m.englishText) === en && en.length > 0)) return;
    lockSpeech(12000);
    setMessages(prev => [...prev, entry]);
  }, [lockSpeech]);

  const MIN_MIC_GAP = 7000;
  const IDLE_MIC_DELAY = 14000;
  const ACTIVE_MIC_DELAY = 3000;

  const clearMicPending = useCallback(() => {
    const sess = micSessionRef.current;
    clearTimeout(sess.pendingTimer);
    sess.pendingTimer = null;
  }, []);

  const stopForeignRec = useCallback(() => {
    const auto = autoRef.current;
    const sess = micSessionRef.current;
    const rec = auto.recs['foreign'];
    auto.recs['foreign'] = null;
    clearMicPending();
    try { rec?.abort(); } catch {}
    if (sess.foreignRec) { try { sess.foreignRec.abort(); } catch {} sess.foreignRec = null; sess.foreignLangKey = null; }
  }, [clearMicPending]);

  const recordMicStart = useCallback(() => {
    const sess = micSessionRef.current;
    const now = Date.now();
    sess.lastStart = now;
    sess.restartTimes = sess.restartTimes.filter(t => now - t < 60000);
    sess.restartTimes.push(now);
    if (sess.restartTimes.length >= 4) sess.dormantUntil = now + 45000;
  }, []);

  const requestMicRestart = useCallback((lang, delay, { force = false } = {}) => {
    const auto = autoRef.current;
    const sess = micSessionRef.current;
    if (!auto.active) return;

    const now = Date.now();
    if (!force && now < sess.dormantUntil) {
      setAutoStatus('paused');
      return;
    }

    const gapWait = Math.max(0, MIN_MIC_GAP - (now - sess.lastStart));
    const wait = Math.max(delay, gapWait);

    clearMicPending();
    sess.pendingTimer = setTimeout(() => {
      sess.pendingTimer = null;
      if (!auto.active) return;
      if (auto.processing) { sess.restartAfterProcessing = true; return; }
      if (auto.recs['foreign']) return;
      const now2 = Date.now();
      if (!force && now2 < sess.dormantUntil) { setAutoStatus('paused'); return; }
      startForeignFnRef.current(lang);
    }, wait);
  }, [clearMicPending]);

  const trySoftMicRestart = useCallback((lang, rec, delay) => {
    const auto = autoRef.current;
    const sess = micSessionRef.current;
    clearMicPending();
    sess.pendingTimer = setTimeout(() => {
      sess.pendingTimer = null;
      if (!auto.active || auto.processing) {
        if (auto.processing) sess.restartAfterProcessing = true;
        return;
      }
      if (Date.now() < sess.dormantUntil) { setAutoStatus('paused'); return; }
      if (Date.now() - sess.lastStart < MIN_MIC_GAP) {
        requestMicRestart(lang, MIN_MIC_GAP - (Date.now() - sess.lastStart));
        return;
      }
      try {
        auto.recs['foreign'] = rec;
        rec.start();
        recordMicStart();
        setAutoStatus('listening');
      } catch {
        requestMicRestart(lang, ACTIVE_MIC_DELAY);
      }
    }, delay);
  }, [clearMicPending, recordMicStart, requestMicRestart]);

  const finishMicProcessing = useCallback(() => {
    autoRef.current.processing = false;
    if (autoRef.current.active) setAutoStatus('listening');
  }, []);

  useEffect(() => {
    foreignScrollRef.current?.scrollTo({ top: foreignScrollRef.current.scrollHeight, behavior: 'smooth' });
    englishScrollRef.current?.scrollTo({ top: englishScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, interim]);

  useEffect(() => {
    if (showTypeInput) setTimeout(() => typeInputRef.current?.focus(), 100);
  }, [showTypeInput]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('phrase_v1') || '{}');
      if (Object.keys(stored).length) setPhraseTranslations(stored);
    } catch {}
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const filteredLangs = useMemo(() => {
    const q = langSearch.toLowerCase();
    return q ? LANGUAGE_LIST.filter(l => l.name.toLowerCase().includes(q) || l.native.toLowerCase().includes(q)) : LANGUAGE_LIST;
  }, [langSearch]);

  /* ── Foreign language auto-listener ─────────────────────────────────── */
  const getForeignRec = useCallback((lang) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const auto = autoRef.current;
    const sess = micSessionRef.current;

    if (sess.foreignRec && sess.foreignLangKey === lang.key) return sess.foreignRec;

    if (sess.foreignRec) { try { sess.foreignRec.abort(); } catch {} }

    const rec = new SR();
    sess.foreignRec = rec;
    sess.foreignLangKey = lang.key;
    rec.lang = lang.speechCode;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      foreignHadSpeechRef.current = false;
      sess.staleResultsSkipped = false;
      sess.processedUpToIndex = 0;
    };
    rec.onspeechstart = () => { foreignHadSpeechRef.current = true; };

    rec.onresult = (e) => {
      if (auto.processing) return;
      if (Date.now() < listenCooldownUntilRef.current) return;

      if (!sess.staleResultsSkipped) {
        sess.staleResultsSkipped = true;
        sess.processedUpToIndex = e.results.length;
      }

      const startIdx = Math.max(e.resultIndex, sess.processedUpToIndex);
      for (let i = startIdx; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (!r.isFinal) { setInterim({ side: 'foreign', text }); continue; }

        setInterim({ side: null, text: '' });
        if (isEnglish(text)) {
          isDuplicateUtterance(text);
          beginListenCooldown(12000);
          sess.processedUpToIndex = i + 1;
          continue;
        }
        if (lang.key === 'ja' && !/[ぁ-ん]/.test(text) && !/[一-鿿]/.test(text)) {
          isDuplicateUtterance(text);
          beginListenCooldown(12000);
          sess.processedUpToIndex = i + 1;
          continue;
        }
        if (UNIQUE_SCRIPT_KEYS.has(lang.key) && !lang.isMine(text)) {
          sess.processedUpToIndex = i + 1;
          continue;
        }
        if (isDuplicateUtterance(text)) {
          sess.processedUpToIndex = i + 1;
          continue;
        }

        sess.processedUpToIndex = i + 1;
        auto.processing = true;
        beginListenCooldown();
        stopForeignRec();
        setAutoStatus('processing');
        translate(text, lang.apiCode, 'en').then(translated => {
          if (translated && normalizeUtterance(translated) !== normalizeUtterance(text)) {
            appendMessage({
              id: nextId(), speaker: 'foreign',
              foreignText: text,
              englishText: translated,
            });
            if (ttsOnRef.current) {
              speak(translated, 'en-US', finishMicProcessing);
              return;
            }
          }
          finishMicProcessing();
        });
        return;
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return;
      if (auto.recs['foreign'] !== rec) return;
      auto.recs['foreign'] = null;
      const msgs = { 'not-allowed': 'Microphone access denied — allow it in browser settings.', 'audio-capture': 'No microphone found.' };
      if (msgs[e.error]) { setMicError(msgs[e.error]); return; }
      requestMicRestart(lang, e.error === 'network' ? 8000 : 6000);
    };

    rec.onend = () => {
      if (auto.recs['foreign'] !== rec) return;
      auto.recs['foreign'] = null;
      if (!auto.active) return;
      if (auto.processing) { sess.restartAfterProcessing = true; return; }
      const delay = foreignHadSpeechRef.current ? ACTIVE_MIC_DELAY : IDLE_MIC_DELAY;
      trySoftMicRestart(lang, rec, delay);
    };

    return rec;
  }, [isDuplicateUtterance, finishMicProcessing, requestMicRestart, trySoftMicRestart,
      beginListenCooldown, stopForeignRec, appendMessage]);

  const startForeignListening = useCallback((lang) => {
    const auto = autoRef.current;
    const sess = micSessionRef.current;
    if (!auto.active || auto.processing) return;
    if (Date.now() < sess.dormantUntil) { setAutoStatus('paused'); return; }

    clearMicPending();
    const rec = getForeignRec(lang);
    if (!rec) { setMicError('Speech recognition requires Chrome or Edge.'); return; }

    if (auto.recs['foreign'] === rec) return;

    auto.recs['foreign'] = rec;
    try {
      rec.start();
      recordMicStart();
      setAutoStatus('listening');
    } catch (err) {
      auto.recs['foreign'] = null;
      if (err?.name !== 'InvalidStateError') requestMicRestart(lang, ACTIVE_MIC_DELAY);
    }
  }, [getForeignRec, recordMicStart, requestMicRestart, clearMicPending]);

  useEffect(() => { startForeignFnRef.current = startForeignListening; }, [startForeignListening]);

  const stopListening = useCallback(() => {
    const auto = autoRef.current;
    const sess = micSessionRef.current;
    auto.active = false;
    auto.processing = false;
    sess.restartAfterProcessing = false;
    clearMicPending();
    Object.values(auto.recs).forEach(r => { try { r?.abort(); } catch {} });
    if (sess.foreignRec) { try { sess.foreignRec.abort(); } catch {} }
    sess.foreignRec = null;
    sess.foreignLangKey = null;
    auto.recs = {};
    try { pttRecRef.current?.abort(); } catch {}
    try { foreignPttRecRef.current?.abort(); } catch {}
    pttRecRef.current = null;
    foreignPttRecRef.current = null;
    setPttActive(false);
    setForeignPttActive(false);
    setAutoOn(false); setAutoStatus('idle'); setInterim({ side: null, text: '' });
    recentUtterancesRef.current = [];
    listenCooldownUntilRef.current = 0;
    speechLockUntilRef.current = 0;
    stopSpeaking();
  }, [clearMicPending]);

  /* ── Push-to-talk: hold to speak foreign language (Latin-script langs) ─ */
  const handleForeignPTT = useCallback((action) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !language) return;

    if (action === 'start') {
      if (foreignPttActive || pttActive || isSpeechLocked()) return;
      stopForeignRec();
      setForeignPttActive(true); setMicError(null);

      const rec = new SR();
      rec.lang = language.speechCode;
      rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 1;
      foreignPttRecRef.current = rec;

      rec.onresult = (e) => {
        if (rec._handled || isSpeechLocked()) return;
        const r = e.results[e.results.length - 1];
        const text = r[0].transcript;
        if (!r.isFinal) {
          if (!isEnglish(text)) setInterim({ side: 'foreign', text });
          return;
        }
        rec._handled = true;
        setInterim({ side: null, text: '' });
        const trimmed = text.trim();
        setForeignPttActive(false);
        if (!trimmed || isEnglish(trimmed) || isDuplicateUtterance(trimmed)) {
          finishMicProcessing();
          return;
        }
        if (!language.isMine(trimmed)) {
          finishMicProcessing();
          return;
        }

        autoRef.current.processing = true;
        lockSpeech(12000);
        setAutoStatus('processing');
        translate(trimmed, language.apiCode, 'en').then(translated => {
          const en = translated?.trim();
          if (en && normalizeUtterance(en) !== normalizeUtterance(trimmed)) {
            appendMessage({
              id: nextId(), speaker: 'foreign',
              foreignText: trimmed,
              englishText: en,
            });
            if (ttsOnRef.current) speak(en, 'en-US');
          }
          finishMicProcessing();
        });
      };

      rec.onerror = (e) => {
        if (e.error === 'aborted') return;
        setForeignPttActive(false); setInterim({ side: null, text: '' });
        const msgs = { 'not-allowed': 'Microphone access denied — allow it in browser settings.', 'audio-capture': 'No microphone found.' };
        if (msgs[e.error]) setMicError(msgs[e.error]);
      };

      rec.onend = () => {
        if (rec._handled) return;
        setForeignPttActive(false); setInterim({ side: null, text: '' });
      };

      try { rec.start(); } catch { setForeignPttActive(false); }
    } else {
      try { foreignPttRecRef.current?.stop(); } catch {}
    }
  }, [language, foreignPttActive, pttActive, isDuplicateUtterance, lockSpeech, appendMessage, finishMicProcessing, stopForeignRec]);

  /* ── Push-to-talk: hold to speak English ────────────────────────────── */
  const handlePTT = useCallback((action) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !language) return;

    if (action === 'start') {
      if (pttActive || foreignPttActive || isSpeechLocked()) return;
      stopForeignRec();
      setPttActive(true); setMicError(null);

      const rec = new SR();
      rec.lang = 'en-US';
      rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 1;
      pttRecRef.current = rec;

      rec.onresult = (e) => {
        if (rec._handled || isSpeechLocked()) return;
        const r = e.results[e.results.length - 1];
        const text = r[0].transcript;
        if (!r.isFinal) { setInterim({ side: 'english', text }); return; }
        rec._handled = true;
        setInterim({ side: null, text: '' });
        const trimmed = text.trim();
        setPttActive(false);
        if (!trimmed || isDuplicateUtterance(trimmed)) {
          finishMicProcessing();
          return;
        }
        autoRef.current.processing = true;
        lockSpeech(12000);
        setAutoStatus('processing');
        translate(trimmed, 'en', language.apiCode).then(translated => {
          const fo = translated?.trim();
          if (fo) {
            appendMessage({
              id: nextId(), speaker: 'english',
              foreignText: fo,
              englishText: trimmed,
            });
            if (ttsOnRef.current) speak(fo, language.speechCode);
          }
          finishMicProcessing();
        });
      };

      rec.onerror = (e) => {
        if (e.error === 'aborted') return;
        setPttActive(false); setInterim({ side: null, text: '' });
        const msgs = { 'not-allowed': 'Microphone access denied — allow it in browser settings.', 'audio-capture': 'No microphone found.' };
        if (msgs[e.error]) { setMicError(msgs[e.error]); return; }
        finishMicProcessing();
      };

      rec.onend = () => {
        if (rec._handled) return;
        setPttActive(false); setInterim({ side: null, text: '' });
        finishMicProcessing();
      };

      try { rec.start(); } catch {
        setPttActive(false);
        finishMicProcessing();
      }

    } else { // 'stop' — user released the button
      // stop() (not abort) so Chrome processes whatever was spoken
      try { pttRecRef.current?.stop(); } catch {}
    }
  }, [language, pttActive, finishMicProcessing, isDuplicateUtterance, lockSpeech, appendMessage, stopForeignRec]);

  /* ── Start listening (enter translation mode) ───────────────────────── */
  const startListening = useCallback((lang) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setMicError('Speech recognition requires Chrome or Edge.'); return; }
    const auto = autoRef.current;
    auto.active = true; auto.recs = {};
    setAutoOn(true); setMicError(null);
    setAutoStatus('listening');
    stopForeignRec();
  }, [stopForeignRec]);

  /* ── Detect language ────────────────────────────────────────────────── */
  const handleListen = useCallback(async () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setMicError('Speech recognition requires Chrome or Edge.'); return; }
    setScreen('detecting'); setDetectingLang(null);
    detectCancelRef.current = { cancelled: false, rec: null };
    const lang = await detectSpeechLanguage(l => setDetectingLang(l), detectCancelRef.current);
    if (!detectCancelRef.current.cancelled) {
      if (lang) { setLanguage(lang); setMessages([]); setScreen('translating'); startListening(lang); }
      else { setLangSearch(''); setScreen('pick'); }
    }
  }, [startListening]);

  /* ── Pick language ──────────────────────────────────────────────────── */
  const handlePickLanguage = (lang) => {
    stopListening();
    setLanguage(lang); setMessages([]);
    setLangSearch(''); setScreen('translating');
    startListening(lang);
  };

  /* ── Power off ──────────────────────────────────────────────────────── */
  const handlePowerOff = () => {
    stopListening();
    setMessages([]); setScreen('off'); setLanguage(null);
    setMicError(null); setShowPhrasebook(false); setShowTypeInput(false);
  };

  /* ── Phrasebook ─────────────────────────────────────────────────────── */
  const handlePhrase = async (phrase) => {
    if (!language) return;
    const cacheKey = `${phrase}|${language.key}`;
    setLoadingPhrase(phrase);
    let translated = phraseTranslations[cacheKey];
    if (!translated) {
      translated = await translate(phrase, 'en', language.apiCode);
      if (translated) {
        const updated = { ...phraseTranslations, [cacheKey]: translated };
        setPhraseTranslations(updated);
        try { localStorage.setItem('phrase_v1', JSON.stringify(updated)); } catch {}
      }
    }
    setLoadingPhrase(null);
    if (!translated) return;
    appendMessage({ id: nextId(), speaker: 'english', foreignText: translated, englishText: phrase });
    if (ttsOnRef.current) speak(translated, language.speechCode);
    setShowPhrasebook(false);
  };

  /* ── Offline phrase download ─────────────────────────────────────────── */
  const handleDownloadPhrases = useCallback(async () => {
    if (!language || downloadingPhrases) return;
    setDownloadingPhrases(true);
    const allPhrases = PHRASE_CATEGORIES.flatMap(c => c.phrases);
    const updates = {};
    for (const phrase of allPhrases) {
      const k = `${phrase}|${language.key}`;
      if (!phraseTranslations[k]) {
        const t = await translate(phrase, 'en', language.apiCode);
        if (t) updates[k] = t;
        await new Promise(r => setTimeout(r, 120));
      }
    }
    const merged = { ...phraseTranslations, ...updates };
    setPhraseTranslations(merged);
    try {
      const existing = JSON.parse(localStorage.getItem('phrase_v1') || '{}');
      localStorage.setItem('phrase_v1', JSON.stringify({ ...existing, ...updates }));
    } catch {}
    setDownloadingPhrases(false);
    showToast(`${Object.keys(updates).length || 'All'} ${language.name} phrases saved for offline use`);
  }, [language, downloadingPhrases, phraseTranslations, showToast]);

  /* ── Type input ─────────────────────────────────────────────────────── */
  const handleTypeSubmit = async () => {
    if (!typeText.trim() || !language) return;
    const text = typeText.trim();
    setTypeText(''); setShowTypeInput(false);
    const from = typeSide === 'english' ? 'en' : language.apiCode;
    const to   = typeSide === 'english' ? language.apiCode : 'en';
    const translated = await translate(text, from, to);
    appendMessage({
      id: nextId(), speaker: typeSide,
      foreignText: typeSide === 'foreign' ? text : (translated || '—'),
      englishText: typeSide === 'english' ? text : (translated || '—'),
    });
    if (ttsOnRef.current && translated && autoRef.current.active) {
      autoRef.current.processing = true;
      const code = typeSide === 'english' ? language.speechCode : 'en-US';
      speak(translated, code, finishMicProcessing);
    }
  };

  /* ── Camera OCR ─────────────────────────────────────────────────────── */
  const handleCameraCapture = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !language) return;
    setCameraLoading(true); setMicError(null);
    try {
      const blob = await resizeImageToBlob(file);
      const fd = new FormData();
      fd.append('file', blob, 'photo.jpg');
      fd.append('apikey', localStorage.getItem('ocr_key') || 'helloworld');
      fd.append('language', 'auto');
      fd.append('isOverlayRequired', 'false');
      fd.append('detectOrientation', 'true');
      fd.append('scale', 'true');
      const res  = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.OCRExitCode === 3) { setMicError('OCR quota reached — get a free key at ocr.space'); setCameraLoading(false); return; }
      const detected = data.ParsedResults?.[0]?.ParsedText?.trim().replace(/\r\n|\n/g, ' ');
      if (!detected) { setMicError('No text found — try better lighting or hold closer.'); setCameraLoading(false); return; }
      const side = language.isMine(detected) ? 'foreign' : 'english';
      const from = side === 'foreign' ? language.apiCode : 'en';
      const to   = side === 'foreign' ? 'en'             : language.apiCode;
      const translated = await translate(detected, from, to);
      appendMessage({
        id: nextId(), speaker: side, fromCamera: true,
        foreignText: side === 'foreign' ? detected : (translated || '—'),
        englishText: side === 'english' ? detected : (translated || '—'),
      });
      if (ttsOnRef.current && translated && autoRef.current.active) {
        autoRef.current.processing = true;
        const code = side === 'foreign' ? 'en-US' : language.speechCode;
        speak(translated, code, finishMicProcessing);
      }
    } catch { setMicError('Camera translation failed — check your connection.'); }
    setCameraLoading(false);
  }, [language, finishMicProcessing]);

  /* ── Screens ─────────────────────────────────────────────────────────── */
  const PINNED_KEYS = ['ja', 'ko', 'fil'];
  const pinnedLangs = PINNED_KEYS.map(k => LANGUAGE_LIST.find(l => l.key === k)).filter(Boolean);

  if (screen === 'off') return (
    <div className="screen-center bg-dark">
      <div className="app-logo">🌐</div>
      <h1 className="app-title">Language Translator</h1>
      <p className="app-subtitle">Tap a language below to start</p>
      {micError && <div className="error-banner">{micError}</div>}
      <div className="home-pinned">
        {pinnedLangs.map(lang => (
          <button key={lang.key} className="home-lang-btn" onClick={() => handlePickLanguage(lang)}>
            <span className="home-lang-flag">{lang.flag}</span>
            <span className="home-lang-name">{lang.name}</span>
          </button>
        ))}
      </div>
      <button className="secondary-btn" onClick={() => { setLangSearch(''); setScreen('pick'); }}>🌍 More Languages</button>
    </div>
  );

  if (screen === 'pick') return (
    <div className="screen-pick bg-dark">
      <div className="pick-header">
        <button className="back-btn" onClick={() => setScreen('off')}>←</button>
        <h2 className="pick-title">Choose Language</h2>
        <div />
      </div>
      <input className="lang-search" placeholder="Search languages..." value={langSearch} onChange={e => setLangSearch(e.target.value)} autoFocus />
      <div className="lang-grid-wrapper">
        {!langSearch && (
          <>
            <div className="pick-section-label">Your Languages</div>
            <div className="lang-grid lang-grid-pinned">
              {pinnedLangs.map(lang => (
                <button key={lang.key} className="lang-card lang-card-pinned" onClick={() => handlePickLanguage(lang)}>
                  <span className="lang-card-flag">{lang.flag}</span>
                  <span className="lang-card-name">{lang.name}</span>
                  <span className="lang-card-native">{lang.native}</span>
                </button>
              ))}
            </div>
            <div className="pick-section-label">All Languages</div>
          </>
        )}
        <div className="lang-grid">
          {filteredLangs.filter(l => langSearch || !PINNED_KEYS.includes(l.key)).map(lang => (
            <button key={lang.key} className="lang-card" onClick={() => handlePickLanguage(lang)}>
              <span className="lang-card-flag">{lang.flag}</span>
              <span className="lang-card-name">{lang.name}</span>
              <span className="lang-card-native">{lang.native}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );


  /* ── Main translation screen ─────────────────────────────────────────── */
  const lastMsg = messages[messages.length - 1];
  const currentCategory = PHRASE_CATEGORIES[phraseCategory];
  const offlinePhraseCount = PHRASE_CATEGORIES.flatMap(c => c.phrases).filter(p => phraseTranslations[`${p}|${language?.key}`]).length;
  const totalPhrases = PHRASE_CATEGORIES.flatMap(c => c.phrases).length;

  return (
    <div className="screen-translate">

      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment"
        style={{ display: 'none' }} onChange={handleCameraCapture} />

      {cameraLoading && (
        <div className="camera-loading-overlay">
          <div className="camera-loading-box">
            <div className="camera-spinner" />
            <p>Reading text from photo...</p>
          </div>
        </div>
      )}

      {toast && <div className="toast-bar" onClick={() => setToast(null)}>✓ {toast}</div>}

      {/* ── Offline help modal ── */}
      {showOfflineHelp && (
        <div className="modal-overlay" onClick={() => setShowOfflineHelp(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{language.flag} Download Offline Speech Pack</div>
            <p className="modal-subtitle">So the microphone works without mobile data:</p>
            <ol className="modal-steps">{OFFLINE_STEPS(language.name).map((s, i) => <li key={i}>{s}</li>)}</ol>
            <p className="modal-note">After downloading, speech recognition uses no data at all.</p>
            <button className="modal-close" onClick={() => setShowOfflineHelp(false)}>Got it</button>
          </div>
        </div>
      )}

      {/* ── Phrasebook panel ── */}
      {showPhrasebook && (
        <div className="panel-overlay" onClick={() => setShowPhrasebook(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-header">
              <h3 className="sheet-title">📖 Phrasebook</h3>
              <div className="sheet-header-actions">
                <button className="phrase-download-btn" onClick={handleDownloadPhrases}
                  disabled={downloadingPhrases || offlinePhraseCount === totalPhrases}
                  title={offlinePhraseCount === totalPhrases ? 'All phrases saved offline' : 'Save all phrases offline'}>
                  {downloadingPhrases ? '⏳ Saving...' : offlinePhraseCount === totalPhrases ? '✓ Offline Ready' : '💾 Save Offline'}
                </button>
                <button className="sheet-close" onClick={() => setShowPhrasebook(false)}>✕</button>
              </div>
            </div>
            <div className="phrase-cats">
              {PHRASE_CATEGORIES.map((cat, i) => (
                <button key={cat.id} className={`phrase-cat-btn ${phraseCategory === i ? 'active' : ''}`} onClick={() => setPhraseCategory(i)}>
                  {cat.icon} {cat.label}
                </button>
              ))}
            </div>
            <div className="phrase-list">
              {currentCategory.phrases.map(phrase => {
                const cached = phraseTranslations[`${phrase}|${language.key}`];
                const isLoading = loadingPhrase === phrase;
                return (
                  <button key={phrase} className="phrase-item" onClick={() => handlePhrase(phrase)} disabled={isLoading}>
                    <span className="phrase-en">{phrase}</span>
                    {cached    && <span className="phrase-translated">{cached}</span>}
                    {isLoading && <span className="phrase-loading">translating...</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Type input panel ── */}
      {showTypeInput && (
        <div className="panel-overlay" onClick={() => setShowTypeInput(false)}>
          <div className="sheet sheet-small" onClick={e => e.stopPropagation()}>
            <div className="sheet-handle" />
            <div className="sheet-header">
              <h3 className="sheet-title">⌨️ Type a Message</h3>
              <button className="sheet-close" onClick={() => setShowTypeInput(false)}>✕</button>
            </div>
            <div className="type-side-picker">
              <button className={`type-side-btn ${typeSide === 'english' ? 'active' : ''}`} onClick={() => setTypeSide('english')}>🇺🇸 Type in English</button>
              <button className={`type-side-btn ${typeSide === 'foreign' ? 'active' : ''}`} onClick={() => setTypeSide('foreign')}>{language.flag} Type in {language.native}</button>
            </div>
            <div className="type-input-row">
              <textarea ref={typeInputRef} className="type-textarea"
                placeholder={typeSide === 'english' ? 'Type in English...' : `Type in ${language.native}...`}
                value={typeText} onChange={e => setTypeText(e.target.value)} rows={3}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTypeSubmit(); } }} />
              <button className="type-submit" onClick={handleTypeSubmit} disabled={!typeText.trim()}>↗</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Foreign Language Panel (top) ── */}
      <div className="panel panel-foreign">
        <div className="panel-header">
          <div className="panel-lang-info">
            <span className="panel-lang-label">{language.flag} {language.native}</span>
            <button className="change-lang-btn" onClick={() => { stopListening(); setLangSearch(''); setScreen('pick'); }}>change</button>
          </div>
          <div className="header-actions">
            <button className="header-btn" onClick={() => setShowOfflineHelp(true)} title="Download offline speech pack">⬇️</button>
            {messages.length > 0 && <button className="header-btn" onClick={() => setMessages([])} title="Clear">🗑</button>}
            <button className="header-btn" onClick={handlePowerOff} title="Turn off">⏻</button>
          </div>
        </div>

        <div className="messages" ref={foreignScrollRef}>
          {messages.length === 0 && (
            <div className="empty-hint">
              <p>Hold <strong>{language.name}</strong> to hear them</p>
              <p>Hold <strong>English</strong> when you speak</p>
              <p className="empty-hint-note">Mic only runs while you hold a button — no auto-listen</p>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className={`bubble ${msg.speaker === 'foreign' ? 'bubble-them' : 'bubble-you'}`}
              onClick={() => ttsOn && speak(msg.foreignText, language.speechCode)}>
              <div className="bubble-label">{msg.speaker === 'foreign' ? language.native : '🇺🇸 You →'}{msg.fromCamera ? ' 📷' : ''}</div>
              <div className="bubble-text">{msg.foreignText}</div>
            </div>
          ))}
          {interim.side === 'foreign' && interim.text && !isEnglish(interim.text) && (
            <div className="bubble bubble-them interim">
              <div className="bubble-label">{language.native}</div>
              <div className="bubble-text">{interim.text}<span className="cursor">|</span></div>
            </div>
          )}
          {autoStatus === 'processing' && lastMsg?.speaker === 'english' && (
            <div className="translating-pill">translating...</div>
          )}
        </div>
      </div>

      {/* ── Push-to-talk divider ── */}
      <div className="divider divider-ptt divider-ptt-dual">
        <button
          type="button"
          className={`ptt-btn ptt-btn-foreign ${foreignPttActive ? 'ptt-active' : ''} ${autoStatus === 'processing' && foreignPttActive ? 'ptt-processing' : ''}`}
          onPointerDown={() => handleForeignPTT('start')}
          onPointerUp={() => handleForeignPTT('stop')}
          onPointerCancel={() => handleForeignPTT('stop')}
          onContextMenu={e => e.preventDefault()}
        >
          <span className="ptt-icon">{foreignPttActive ? '🎤' : language.flag}</span>
          <span className="ptt-text">
            {foreignPttActive ? 'Speaking... release when done' : `Hold: ${language.name}`}
          </span>
        </button>
        <button
          type="button"
          className={`ptt-btn ${pttActive ? 'ptt-active' : ''} ${autoStatus === 'processing' && !pttActive && !foreignPttActive ? 'ptt-processing' : ''}`}
          onPointerDown={() => handlePTT('start')}
          onPointerUp={() => handlePTT('stop')}
          onPointerCancel={() => handlePTT('stop')}
          onContextMenu={e => e.preventDefault()}
        >
          <span className="ptt-icon">{pttActive ? '🎤' : '🎙'}</span>
          <span className="ptt-text">
            {pttActive
              ? 'Speaking... release when done'
              : autoStatus === 'processing' && !pttActive && !foreignPttActive
                ? 'Translating...'
                : 'Hold: English'}
          </span>
        </button>
      </div>

      {/* ── English Panel (bottom) ── */}
      <div className="panel panel-english">
        <div className="panel-header panel-header-light">
          <span className="panel-lang-label-dark">🇺🇸 English</span>
          {autoStatus === 'processing' && <span className="translating-label">translating...</span>}
        </div>

        <div className="messages messages-light" ref={englishScrollRef}>
          {messages.length === 0 && (
            <div className="empty-hint-dark">
              <p>Translations appear here</p>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className={`bubble ${msg.speaker === 'english' ? 'bubble-you-en' : 'bubble-them-en'}`}
              onClick={() => ttsOn && speak(msg.englishText, 'en-US')}>
              <div className="bubble-label-dark">{msg.speaker === 'english' ? '🇺🇸 You' : `${language.flag} ${language.name} →`}{msg.fromCamera ? ' 📷' : ''}</div>
              <div className="bubble-text-dark">{msg.englishText}</div>
            </div>
          ))}
          {interim.side === 'english' && interim.text && (
            <div className="bubble bubble-you-en interim">
              <div className="bubble-label-dark">🇺🇸 You</div>
              <div className="bubble-text-dark">{interim.text}<span className="cursor-dark">|</span></div>
            </div>
          )}
          {autoStatus === 'processing' && lastMsg?.speaker === 'foreign' && (
            <div className="translating-pill translating-pill-light">translating...</div>
          )}
        </div>

        {/* ── Bottom toolbar ── */}
        <div className="toolbar">
          <button className={`toolbar-btn ${ttsOn ? 'toolbar-tts-on' : ''}`} onClick={() => setTtsOn(v => !v)}>
            <span>{ttsOn ? '🔊' : '🔇'}</span>
            <span className="toolbar-label">{ttsOn ? 'Speaker On' : 'Speaker Off'}</span>
          </button>
          <button className="toolbar-btn" onClick={() => cameraInputRef.current?.click()} disabled={cameraLoading}>
            <span>{cameraLoading ? '⏳' : '📷'}</span>
            <span className="toolbar-label">Camera</span>
          </button>
          <button className="toolbar-btn" onClick={() => setShowPhrasebook(true)}>
            <span>📖</span><span className="toolbar-label">Phrases</span>
          </button>
          <button className="toolbar-btn" onClick={() => setShowTypeInput(true)}>
            <span>⌨️</span><span className="toolbar-label">Type</span>
          </button>
          <button className="toolbar-btn" onClick={() => exportConversation(messages, language)} disabled={!messages.length}>
            <span>📤</span><span className="toolbar-label">Export</span>
          </button>
        </div>
      </div>

      {micError && (
        <div className="error-bar" onClick={() => setMicError(null)}>⚠️ {micError} — tap to dismiss</div>
      )}
    </div>
  );
}
