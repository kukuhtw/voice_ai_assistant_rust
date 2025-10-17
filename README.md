

# 🎙️ Voice AI Assistant (Rust + TypeScript)

**Real-time multimodal Voice AI**: listen → transcribe → reason → speak → lip-sync avatar 3D.
Backend **Rust (Axum)**, Frontend **TypeScript (Vite + Three.js)**.

---
🎥 Demo Video

Check out the live demo on YouTube: “AI Voice Assistant + Avatar Interaktif!” — Watch here
 
youtube.com


## 🧠 Overview

Pipeline end-to-end (low latency):

1. **STT**: Mic → Whisper (`/api/stt`)
2. **LLM**: Intent/reasoning via GPT-4o / 4.1-mini (`/api/ask`, `/api/search`)
3. **TTS**: Natural voice output (`/api/tts`, returns base64 WAV)
4. **Avatar**: Lip-sync via WebAudio Analyser → blendshape/viseme on GLB

---

## 📁 Project Structure

```
.
├── Makefile
├── docker-compose.yml
├── backend/
│   ├── Cargo.toml
│   ├── rust-toolchain.toml
│   ├── src/main.rs
│   └── Dockerfile
└── frontend/
    ├── index.html
    ├── src/
    │   ├── api.ts
    │   ├── main.ts        # mic record, router intent (ask vs search), TTS, play & lip-sync
    │   ├── ui.ts
    │   └── avatar.ts      # Three.js avatar, morph targets, fallback jaw, analyser hookup
    ├── public/assets/
    │   └── avatar_female.glb
    ├── vite.config.ts
    └── Dockerfile
```

---

## ⚙️ Backend (Axum)

**Endpoints**

| Path                 | Method     | Use                                                            |
| -------------------- | ---------- | -------------------------------------------------------------- |
| `/api/stt`           | POST       | Multipart audio → Whisper transcript                           |
| `/api/ask`           | POST (SSE) | Chat completion stream (text only)                             |
| `/api/search`        | POST (SSE) | Responses API + `web_search` tool (for “berita/terbaru/cari…”) |
| `/api/tts`           | POST       | TTS → base64 WAV                                               |
| `/debug/env`         | GET        | Probe env (`PORT`, presence of API key)                        |
| `/debug/ping-openai` | GET        | Test OpenAI connectivity                                       |
| `/health`            | GET        | Healthcheck                                                    |

**Notes**

* CORS enabled, graceful shutdown, tracing logs.
* `OPENAI_API_KEY` required.
* `PORT` default **8080**.

---

## 💻 Frontend (Vite + Three.js)

### 1) Voice flow & router intent (from `src/main.ts`)

* Records mic as `audio/webm` using `MediaRecorder`.
* Uploads to `/api/stt`, fixes spacing (punctuation & word-boundary healer).
* **Router**: if transcript suggests news/search intent, use `/api/search` else `/api/ask`.

```ts
// intent routing (ID keywords)
function isWebSearchIntent(s: string): boolean {
  const q = s.toLowerCase();
  return (
    /\b(berita|kabar|terbaru|hari ini|minggu ini|bulan ini|tren|trend|trending|update)\b/.test(q) ||
    /\b(cari|carikan|telusuri|search)\b/.test(q) ||
    /\b(sumber|link|tautan|referensi)\b/.test(q)
  );
}
```

* Streams answer via SSE, then calls `/api/tts`, plays audio, **attaches analyser** to drive mouth.

```ts
// After receiving full answer:
const t = await tts(full, chosenVoice);
const b = Uint8Array.from(atob(t.audio_base64), c => c.charCodeAt(0));
const url = URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
els.audio.src = url;
avatar?.attachAudioAnalyser(els.audio);
await els.audio.play();
```

* **Transcript healer** for nicer display:

```ts
function repairSpacing(input: string): string {
  if (!input) return input;
  let s = input.replace(/\r\n?/g, "\n");
  s = s.replace(/(^|\n)(#{1,6})([^\s#])/g, "$1$2 $3");
  s = s.replace(/([,.!?;:])([^\s\n])/g, "$1 $2");
  s = s.replace(/([a-zà-ÿ])([A-ZÀ-ß])/g, "$1 $2");
  s = s.replace(/([0-9])([A-Za-zÀ-ÿ])/g, "$1 $2");
  s = s.replace(/([A-Za-zÀ-ÿ])([0-9])/g, "$1 $2");
  s = s.replace(/[ \t]+/g, " ");
  s = s.split("\n")
       .map((line) => (!/\s/.test(line) && line.length > 100 ? line.replace(/(\S{80})(?=\S)/g, "$1 ") : line))
       .join("\n");
  return s.trim();
}
```

### 2) Avatar & lip-sync (from `src/avatar.ts`)

* Loads **GLB** (Ready Player Me URLs by default; cross-origin allowed).
* Tries to find common **mouth/jaw** morphs: `jawOpen`, `mouthOpen`, `viseme_aa/ah`, etc.
* If no morphs: adds **invisible jaw helper** and uses **rotation fallback**.
* Lip-sync is **audio-agnostic**: uses WebAudio RMS loudness to drive morph influence.

```ts
attachAudioAnalyser(mediaEl: HTMLMediaElement) {
  const Ctx = (window.AudioContext || (window as any).webkitAudioContext);
  const ctx = new Ctx();
  const src = ctx.createMediaElementSource(mediaEl);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  src.connect(analyser); analyser.connect(ctx.destination);
  this.analyser = analyser; this.dataArray = dataArray; this.audioCtx = ctx;
}
```

**Model switching**

```ts
// select#avatarModel → "female" | "male"
await avatar?.loadModel(els2.modelSelect.value as "female" | "male");
```

**Default model URLs**

```ts
private modelUrlFemale = "https://models.readyplayer.me/68f22154b3dcc5b5f86d6782.glb";
private modelUrlMale   = "https://models.readyplayer.me/68f22390e831796787040291.glb";
```

> You can call `avatar.setModelUrls(femaleUrl, maleUrl)` to override at runtime.

**Fallback head (no “mystery box”)**
When GLB fails or has no morphs, a simple sphere head + invisible `jaw_helper` is spawned—no visible box geometry.

---

## 🚀 Quick Start

### Docker Compose

```bash
git clone https://github.com/kukuhtw/voice_ai_assistant_rust.git
cd voice_ai_assistant_rust
echo "OPENAI_API_KEY=sk-..." > .env
docker-compose up --build
```

Open **[http://localhost:5173](http://localhost:5173)** (frontend). Backend listens on **:8080** by default.

### Local Dev

```bash
# Backend
cd backend
cargo run

# Frontend
cd ../frontend
npm i
npm run dev
```

---

## 🔧 Configuration

* **Env**

  * `OPENAI_API_KEY` — required
  * `PORT` (backend) — default `8080`
* **Frontend**

  * `#voiceSelect` for voice (`alloy` default)
  * `#avatarModel` to switch male/female
  * Canvas `#avatarCanvas` must be present

---

## 🔐 Permissions & Privacy

* Browser will prompt **microphone permission**.
* Audio is posted only to your configured backend `/api/stt`.
* No client-side caching of raw audio; TTS WAV only streamed for playback.

---

## 🧪 Troubleshooting

* **No mouth movement**: GLB may lack blendshapes → fallback jaw rotation should still animate.
* **No audio on iOS/Safari**: Ensure a user gesture before playback and call `audioContext.resume()` (already handled in `main.ts`).
* **CORS errors** loading RPM GLBs: `GLTFLoader().setCrossOrigin("anonymous")` is enabled; also check CDN headers.
* **SSE blocked**: If behind proxies, enable response buffering off / increase timeouts.

---

## 🧠 Tech Stack

Backend: Rust, Axum, Tokio, Reqwest, Tracing
Frontend: TypeScript, Vite, Three.js, Web Audio API
AI: OpenAI Whisper, GPT-4o / 4.1-mini, GPT-4o-mini-tts
Ops: Docker, Nginx

---

## 👨‍💻 Author

**Kukuh Tripamungkas Wicaksono (Kukuh TW)** — MIT License
📧 [kukuhtw@gmail.com](mailto:kukuhtw@gmail.com) · 💬 WhatsApp: [https://wa.me/628129893706](https://wa.me/628129893706) · 💼 LinkedIn: [https://id.linkedin.com/in/kukuhtw](https://id.linkedin.com/in/kukuhtw)

---
