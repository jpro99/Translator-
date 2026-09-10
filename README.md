# Translator

Real-time two-person conversation translator — a mobile-friendly PWA built with React and Vite. Built for travel: **works in Italy and the EU even when Google Translate is blocked or slow.**

## Open the app

**Live:** [https://jpro99.github.io/Translator-/](https://jpro99.github.io/Translator-/)

Use that URL (note `/Translator-/`). Root `https://jpro99.github.io/` is not this app.

### On your phone in Italy

1. Open **Chrome** (Android) or **Safari/Chrome** (iOS — speech works best in Chrome).
2. Go to **https://jpro99.github.io/Translator-/**
3. Optional: **Add to Home Screen** (install PWA) for offline UI + cached assets.
4. Tap **Talk** → **Inizia conversazione** / **Start conversation**.
5. Allow **microphone** when prompted.
6. Person A speaks Italian, Person B speaks English (or any pair) — translations appear automatically.
7. Small chip shows which provider worked (e.g. `via Lingva`) so you know it's not stuck.
8. Toggle **🔊** to hear translations (uses Italian voice when available).

If translation fails (bad network), the transcript still shows with a **Retry / Riprova** button. Retries queue automatically when you're back online.

## What it does

- **Talk tab**: Two people speak any languages. Auto-detect each utterance, translate both ways. Person A / Person B languages learned from speech (optional overrides).
- **Listen tab**: Overhear speech → English translation with auto-detect.

## Translation engine (EU-resilient)

**No Google dependency.** Provider chain (auto-failover ~1.5s each):

1. **MyMemory** (EU-based, reliable in Italy)
2. **Lingva** (multiple EU instances)
3. **LibreTranslate** (public instances)
4. **DeepL** (if `VITE_DEEPL_API_KEY` set — recommended for Italy)
5. **Azure Translator** (if `VITE_AZURE_TRANSLATOR_KEY` set)
6. **Google gtx** (last resort only)

Recent translations cached in **IndexedDB + localStorage** for flaky networks.

### Optional API keys (better quality)

Copy `.env.example` → `.env.local` for local dev:

```bash
VITE_DEEPL_API_KEY=your-deepl-free-key        # Best for Italian ↔ English
VITE_AZURE_TRANSLATOR_KEY=your-azure-key
VITE_AZURE_TRANSLATOR_REGION=westeurope
```

The app works **without keys** using free public providers.

## Requirements

- **Browser**: Chrome or Edge (desktop or Android). Safari has limited SpeechRecognition.
- **Microphone**: Allow when prompted. Error messages in English + Italian.
- **Network**: Needed for translation (speech runs in-browser).

## Local dev

```bash
npm install
npm run dev          # http://localhost:5173
npm run verify       # conversation + failover tests
GITHUB_ACTIONS=true npm run build   # same as CI (base /Translator-/)
```

## Deploy

Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy.yml` (~1–2 min).

**Production URL:** https://jpro99.github.io/Translator-/

## Tech stack

- React 18 + Vite 5 + PWA (service worker, manifest, icons)
- Web Speech API + VAD hybrid (`src/speech.js`)
- Multi-provider translation (`src/translate.js`, `src/providers.js`)
- Two-person state machine (`src/conversation.js`)
- Bilingual UI (`src/i18n.js`) — English + Italian
