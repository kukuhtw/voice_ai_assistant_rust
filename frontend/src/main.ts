// # frontend/src/main.ts
// frontend/src/main.ts
import { els, showStart, showStop } from "./ui";
import { uploadAudio, askStream, searchStream, tts, pingBackend } from "./api";
import { TalkingAvatar } from "./avatar";

let mediaRecorder: MediaRecorder | null = null;
let chunks: BlobPart[] = [];
let isRecording = false;

const debugEl = document.getElementById("debug") as HTMLPreElement;
function dlog(msg: string, obj?: any) {
  const line = `[${new Date().toISOString()}] ${msg}` + (obj ? ` ${JSON.stringify(obj, null, 2)}` : "");
  console.log(msg, obj ?? "");
  if (debugEl) debugEl.textContent += line + "\n";
}

const els2 = {
  canvas: document.getElementById("avatarCanvas") as HTMLCanvasElement,
  voiceSelect: document.getElementById("voiceSelect") as HTMLSelectElement,
  modelSelect: document.getElementById("avatarModel") as HTMLSelectElement,
};

let avatar: TalkingAvatar | null = null;

// ====== Perapihan spasi HASIL STT ======
function repairSpacing(input: string): string {
  if (!input) return input;
  let s = input.replace(/\r\n?/g, "\n");
  s = s.replace(/(^|\n)(#{1,6})([^\s#])/g, "$1$2 $3");
  s = s.replace(/([,.!?;:])([^\s\n])/g, "$1 $2");
  s = s.replace(/([a-zà-ÿ])([A-ZÀ-ß])/g, "$1 $2");
  s = s.replace(/([0-9])([A-Za-zÀ-ÿ])/g, "$1 $2");
  s = s.replace(/([A-Za-zÀ-ÿ])([0-9])/g, "$1 $2");
  s = s.replace(/[ \t]+/g, " ");
  s = s
    .split("\n")
    .map((line) => (!/\s/.test(line) && line.length > 100 ? line.replace(/(\S{80})(?=\S)/g, "$1 ") : line))
    .join("\n");
  return s.trim();
}

// Router intent sederhana → gunakan web search untuk query “berita/terbaru/cari…”
function isWebSearchIntent(s: string): boolean {
  const q = s.toLowerCase();
  return (
    /\b(berita|kabar|terbaru|hari ini|minggu ini|bulan ini|tren|trend|trending|update)\b/.test(q) ||
    /\b(cari|carikan|telusuri|search)\b/.test(q) ||
    /\b(sumber|link|tautan|referensi)\b/.test(q)
  );
}

window.addEventListener("error", (e) =>
  dlog("window.error", { message: (e as any).message, stack: (e as any).error?.stack })
);
window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) =>
  dlog("unhandledrejection", { reason: String(e.reason) })
);

// ========= Boot tunggal =========
(async function boot() {
  try { await pingBackend(dlog); } catch (e) { dlog("BOOT: ping failed", e); }
  if (els2.canvas) {
    avatar = new TalkingAvatar(els2.canvas);
    await avatar.init();
    // optional: expose utk debug
    (window as any).avatar = avatar;
  }
})();

async function startSpeak() {
  if (isRecording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    chunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = onStopRecording;
    mediaRecorder.start(100);
    isRecording = true;
    showStop();
    dlog("REC START");
  } catch (e) {
    dlog("REC START ERROR", e);
  }
}

async function stopSpeak() {
  if (!isRecording) return;
  try {
    mediaRecorder?.stop();
    mediaRecorder?.stream.getTracks().forEach((t) => t.stop());
    mediaRecorder = null;
    isRecording = false;
    showStart();
    dlog("REC STOP");
  } catch (e) {
    dlog("REC STOP ERROR", e);
  }
}

async function onStopRecording() {
  try {
    const blob = new Blob(chunks, { type: "audio/webm" });
    chunks = [];
    dlog("UPLOAD AUDIO len", { size: blob.size });

    const text = await uploadAudio(blob);

    const fixed = repairSpacing(text);
    els.transcript.textContent = fixed;

    els.answer.textContent = "";
    els.progress.textContent = "";

    const useSearch = isWebSearchIntent(fixed);
    els.progress.textContent += useSearch
      ? "[router] using /api/search (web_search)\n"
      : "[router] using /api/ask (chat only)\n";

    const full = useSearch
      ? await searchStream(
          fixed,
          (delta) => { els.answer.textContent += delta; },
          (msg)    => { els.progress.textContent += `${msg}\n`; },
        )
      : await askStream(
          fixed,
          (delta) => { els.answer.textContent += delta; },
          (msg)    => { els.progress.textContent += `${msg}\n`; },
        );

    // TTS + sinkron mulut avatar
    const chosenVoice = els2.voiceSelect?.value || "alloy";
    const t = await tts(full, chosenVoice);
    const b = Uint8Array.from(atob(t.audio_base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
    els.audio.src = url;

    // pasang analyser SEBELUM play
    if (avatar && els.audio) {
      avatar.attachAudioAnalyser(els.audio);
    }

    // resume audio context saat mulai play (beberapa browser butuh ini)
    if (avatar && (avatar as any).getAudioContext) {
      els.audio.addEventListener("play", async () => {
        try { await (avatar as any).getAudioContext()?.resume?.(); } catch {}
      }, { once: true });
    }

    await els.audio.play();

    // jaga-jaga: resume lagi sesudah play
    try { await (avatar as any).getAudioContext()?.resume?.(); } catch {}

  } catch (err: any) {
    const msg = `Error: ${err?.message || err}`;
    els.answer.textContent = msg;
    dlog("FLOW ERROR", { message: msg, stack: err?.stack });
  }
}

// UI wiring
els.startBtn.addEventListener("click", startSpeak);
els.stopBtn.addEventListener("click", stopSpeak);

els2.modelSelect?.addEventListener("change", async () => {
  try {
    await avatar?.loadModel(els2.modelSelect.value as "female" | "male");
  } catch (e) {
    dlog("switch model error", e);
  }
});
