import { useState, useRef, useCallback, useEffect } from 'react';
import { ENGLISH, detectLanguageFromText } from './languages';
import { translateWithDetection } from './translate';
import {
  createConversationState,
  assignSpeaker,
  getOtherLanguage,
  getRecognitionSpeechCodes,
} from './conversation';
import { cleanTranscript, isGarbageTranscript, isNearDuplicate } from './speech';
import { bilingual } from './i18n';
import { enqueueRetry, dequeueRetry } from './retryQueue';

let _id = 0;
const nextId = () => ++_id;
const norm = (t) => (t || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.,!?…]+$/g, '');

export function useConversation({ onSpeak } = {}) {
  const [messages, setMessages] = useState([]);
  const [personA, setPersonA] = useState(null);
  const [personB, setPersonB] = useState(null);
  const [interim, setInterim] = useState('');
  const [status, setStatus] = useState('');
  const stateRef = useRef(createConversationState());
  const personAOverride = useRef(null);
  const personBOverride = useRef(null);
  const seenRef = useRef(new Set());
  const recentLockRef = useRef([]);

  const syncPersons = useCallback(() => {
    const s = stateRef.current;
    setPersonA(personAOverride.current || s.personA);
    setPersonB(personBOverride.current || s.personB);
  }, []);

  const isRecentDupe = useCallback((text) => {
    const n = norm(text);
    if (!n) return true;
    const now = Date.now();
    recentLockRef.current = recentLockRef.current.filter((u) => now - u.t < 12000);
    if (recentLockRef.current.some((u) => u.n === n)) return true;
    recentLockRef.current.push({ n, raw: text, t: now });
    return false;
  }, []);

  const remember = useCallback((text) => {
    const n = norm(text);
    if (!n || seenRef.current.has(n)) return false;
    seenRef.current.add(n);
    if (seenRef.current.size > 60) {
      seenRef.current = new Set([...seenRef.current].slice(-30));
    }
    return true;
  }, []);

  const processUtterance = useCallback(async (text) => {
    const cleaned = cleanTranscript(text);
    if (!cleaned || isGarbageTranscript(cleaned)) return null;
    if (isRecentDupe(cleaned) || !remember(cleaned)) return null;

    const state = stateRef.current;
    if (personAOverride.current) state.personA = personAOverride.current;
    if (personBOverride.current) state.personB = personBOverride.current;

    const tentativeOther = state.lastSpeaker === 'a'
      ? (state.personB || ENGLISH)
      : state.lastSpeaker === 'b'
        ? (state.personA || ENGLISH)
        : ENGLISH;

    const id = nextId();
    setMessages((prev) => [...prev, {
      id,
      speaker: '?',
      said: cleaned,
      sourceLang: null,
      targetLang: null,
      translation: null,
      provider: null,
      translating: true,
      failed: false,
    }]);
    setInterim('');

    let result = await translateWithDetection(cleaned, 'auto', tentativeOther.apiCode);
    const detectedCode = result?.detectedLang
      || detectLanguageFromText(cleaned)?.apiCode
      || 'en';
    const { speaker, lang } = assignSpeaker(state, detectedCode, cleaned);
    const target = getOtherLanguage(state, speaker);

    if (target.apiCode !== tentativeOther.apiCode) {
      const retry = await translateWithDetection(cleaned, detectedCode, target.apiCode);
      if (retry?.translation) result = retry;
    }

    const failed = !result?.translation;
    const out = failed
      ? bilingual('translateFailed')
      : result.translation;

    if (failed) {
      enqueueRetry({ id, kind: 'chat', text: cleaned, from: detectedCode, to: target.apiCode });
    }

    const msg = {
      id,
      speaker,
      said: cleaned,
      sourceLang: lang,
      targetLang: target,
      translation: out,
      provider: result?.provider || null,
      translating: false,
      failed,
    };

    setMessages((prev) => prev.map((m) => (m.id === id ? msg : m)));
    syncPersons();

    if (!failed && out && onSpeak) {
      onSpeak({ text: out, target, speaker, msg });
    }

    return msg;
  }, [isRecentDupe, remember, syncPersons, onSpeak]);

  const retryMessage = useCallback(async (msg) => {
    if (!msg?.said || !msg.targetLang) return;
    setMessages((prev) => prev.map((m) => (
      m.id === msg.id ? { ...m, translating: true, failed: false } : m
    )));
    const from = msg.sourceLang?.apiCode || 'auto';
    const result = await translateWithDetection(msg.said, from, msg.targetLang.apiCode);
    if (!result?.translation) {
      setMessages((prev) => prev.map((m) => (
        m.id === msg.id
          ? { ...m, translating: false, failed: true, translation: bilingual('translateFailed') }
          : m
      )));
      return;
    }
    setMessages((prev) => prev.map((m) => (
      m.id === msg.id
        ? {
          ...m,
          translation: result.translation,
          provider: result.provider,
          translating: false,
          failed: false,
        }
        : m
    )));
    if (onSpeak) {
      onSpeak({
        text: result.translation,
        target: msg.targetLang,
        speaker: msg.speaker,
        msg,
      });
    }
    dequeueRetry(msg.id);
  }, [onSpeak]);

  const reset = useCallback(() => {
    stateRef.current = createConversationState();
    if (personAOverride.current) stateRef.current.personA = personAOverride.current;
    if (personBOverride.current) stateRef.current.personB = personBOverride.current;
    seenRef.current.clear();
    recentLockRef.current = [];
    setMessages([]);
    setInterim('');
    syncPersons();
  }, [syncPersons]);

  const getSpeechLangs = useCallback(() => {
    return getRecognitionSpeechCodes(stateRef.current);
  }, []);

  const setPersonOverride = useCallback((side, lang) => {
    if (side === 'a') {
      personAOverride.current = lang;
      if (stateRef.current) stateRef.current.personA = lang;
      setPersonA(lang);
    } else {
      personBOverride.current = lang;
      if (stateRef.current) stateRef.current.personB = lang;
      setPersonB(lang);
    }
    syncPersons();
  }, [syncPersons]);

  const clearPersonOverride = useCallback((side) => {
    if (side === 'a') {
      personAOverride.current = null;
      setPersonA(stateRef.current?.personA || null);
    } else {
      personBOverride.current = null;
      setPersonB(stateRef.current?.personB || null);
    }
  }, []);

  return {
    messages,
    personA,
    personB,
    interim,
    status,
    setStatus,
    setInterim,
    processUtterance,
    retryMessage,
    reset,
    getSpeechLangs,
    setPersonOverride,
    clearPersonOverride,
    stateRef,
    syncPersons,
  };
}
