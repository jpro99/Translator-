# Translator

**Table Mode & Earbuds** — next-level two-person translator for travel. Built for Italy: on-device speech, multi-provider translation, no Google dependency.

## Open the app

**Live:** [https://jpro99.github.io/Translator-/](https://jpro99.github.io/Translator-/)

### On your phone in Italy

1. Open **Chrome** → **https://jpro99.github.io/Translator-/**
2. **Add to Home Screen** (PWA) for offline UI + cached assets
3. Choose a mode:
   - **Table Mode** — phone face-up between two people. Split screen; top half rotated 180° so each person reads upright.
   - **Earbuds** — one earbud each. Person A = left, Person B = right. Hear only your translation.
4. Tap **Start** / **Inizia** → allow microphone
5. First launch downloads on-device Whisper model (~80MB, cached). Works without Wi-Fi after that for speech.
6. Speak — auto-detect languages, translate both ways. Chip shows provider (e.g. `via MyMemory`).

## Modes

### Table Mode
Place the phone on the table between you. Person A sits at the bottom, Person B at the top. Each side shows:
- What was said (smaller)
- Translation in huge type (readable from across the table)
- Provider chip when translation succeeds

### Earbuds
- **Person A** wears the **left** earbud
- **Person B** wears the **right** earbud
- When A speaks → translation plays in B's right ear
- When B speaks → translation plays in A's left ear
- Stereo cue + TTS (Azure TTS if key set, else Web Speech)

## Engine

### Speech (no Google)
1. **On-device Whisper** (WebGPU → WASM) — primary, works offline after first download
2. **Web Speech API** — fallback if Whisper can't load

### Translation (no Google primary)
Failover chain (~1.5s each):
1. **MyMemory** (EU-based, reliable in Italy)
2. **Lingva** (EU mirrors)
3. **LibreTranslate**
4. **DeepL** (optional key)
5. **Azure** (optional key)
6. **Google gtx** — last resort only

Cached in IndexedDB + localStorage. Offline: transcript shown + Retry button; auto-retry when back online.

### Optional API keys

Copy `.env.example` → `.env.local`:

```bash
VITE_DEEPL_API_KEY=           # Best Italian ↔ English quality
VITE_AZURE_TRANSLATOR_KEY=    # Azure translate + stereo TTS
VITE_AZURE_TRANSLATOR_REGION=westeurope
```

## Local dev

```bash
npm install
npm run dev
npm run verify
GITHUB_ACTIONS=true npm run build
```

## Deploy

Pushes to `main` → GitHub Pages (~1–2 min).

**URL:** https://jpro99.github.io/Translator-/

## Tech

- React 18 + Vite 5 PWA
- Transformers.js Whisper-base (on-device STT)
- Multi-provider translation failover
- Web Audio stereo routing for earbuds
- Bilingual EN/IT UI
