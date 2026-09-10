# Translator

Real-time two-person conversation translator — a mobile-friendly PWA built with React and Vite.

## What it does

- **Talk tab**: Two people speak any languages. Tap **Start conversation** — each utterance is auto-detected and translated for the other person. Languages are learned from the first clear phrases (optional overrides for Person A / Person B).
- **Listen tab**: Overhear speech and see English translations (also auto-detects language by default).

Speech uses the browser Web Speech API (Chrome/Edge) with a silent voice-activity detector to avoid Android beep loops. Translation uses free public endpoints (Google gtx, MyMemory, Lingva) — no API keys required.

## Requirements

- **Browser**: Chrome or Edge (desktop or Android). Safari has limited SpeechRecognition support.
- **Microphone**: Allow mic access when prompted.
- **Network**: Needed for translation (speech runs in-browser).

## Quick start (local dev)

```bash
npm install
npm run dev
```

Open the URL shown (usually `http://localhost:5173`) in Chrome.

### Happy-path manual test — two-person conversation

1. Open the **Talk** tab.
2. Tap **Start conversation** and allow the microphone.
3. **Person A** says a phrase in one language (e.g. Spanish: *"Hola, ¿cómo estás?"*).
   - You should see the original text and an English translation.
   - Person A chip updates to show Spanish.
4. **Person B** replies in another language (e.g. English: *"I'm fine, thanks."*).
   - You should see the English original and a Spanish translation.
   - Person B chip updates to show English.
5. Continue alternating — each side should see/hear (if 🔊 is on) the other language.
6. Tap **Stop conversation** when done.

### Listen mode test

1. Open the **Listen** tab → **Start listening**.
2. Speak in any language (or type a sentence in the box and tap **Go**).
3. Original + English translation should appear with auto-detected language label.

### Automated sanity check

```bash
node scripts/verify-conversation.mjs
```

## What was broken (and fixed)

| Issue | Fix |
|-------|-----|
| Talk mode was English ↔ one picked language only | Auto-detect per utterance; learn Person A / Person B languages |
| Manual You/Them mic toggle required each turn | Continuous listen with smart recognition language switching |
| Latin-script languages (Tagalog, Spanish) treated as English | Never skip translation based on `isEnglish()` alone; use Google `sl=auto` detection |
| Language picker required before Listen | Default to auto-detect; picker is optional override |
| Listen mode required picking language first | Start immediately with auto-detect |

## Optional overrides

- **Talk**: Tap Person A / Person B chips to lock a language before or during a conversation.
- **Listen**: Tap the language chip to bias speech recognition toward one language.

## Build & deploy

```bash
npm run build
npm run preview
```

Deploys via GitHub Pages (`/Translator-/`) or Vercel — see `vite.config.js` and `.github/workflows/deploy.yml`.

## Tech stack

- React 18 + Vite 5
- Web Speech API + VAD hybrid (`src/speech.js`)
- Free translation APIs (`src/translate.js`)
- Two-person state machine (`src/conversation.js`)
