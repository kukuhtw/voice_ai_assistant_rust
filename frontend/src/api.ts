// # frontend/src/api.ts
// frontend/src/api.ts
const BACKEND_URL = (import.meta as any).env?.VITE_BACKEND_URL ?? "";

// Logger opsional untuk ping
type Logger = (msg: string, obj?: any) => void;

export async function pingBackend(log: Logger) {
  try {
    const r1 = await fetch(`${BACKEND_URL}/health`, { method: "GET" });
    const body = await r1.text();
    log?.("PING /health", { status: r1.status, body });

    try {
      const r2 = await fetch(`${BACKEND_URL}/debug/env`, { method: "GET" });
      const envProbe = await r2.json().catch(() => ({}));
      log?.("PING /debug/env", { status: r2.status, envProbe });
    } catch (e) {
      log?.("PING /debug/env failed (ignored)", String(e));
    }
  } catch (e) {
    log?.("PING backend FAILED", String(e));
    throw e;
  }
}

export async function uploadAudio(blob: Blob): Promise<string> {
  const fd = new FormData();
  fd.append("audio", blob, "audio.webm");
  const res = await fetch(`${BACKEND_URL}/api/stt`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`STT failed: ${res.status}`);
  const json = await res.json();
  return json.text || "";
}

/** Parser SSE bersama dengan fix "jangan trim payload data:" */
async function sseStream(
  url: string,
  body: any,
  onChunkAnswer: (txt: string) => void,
  onProgress: (msg: string) => void
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error("no stream");

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = "";
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    // Frame SSE dipisah dengan \n\n
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let ev: "answer" | "progress" | "debug" | "message" = "message";
      const dataLines: string[] = [];

      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          const et = line.slice(6).trim();
          ev = et === "answer" ? "answer"
             : et === "progress" ? "progress"
             : et === "debug" ? "debug"
             : "message";
        } else if (line.startsWith("data:")) {
          // SSE: setelah "data:" boleh ada SATU spasi opsional → jangan trim payload!
          const raw = line.slice(5);
          dataLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
        }
      }

      const payload = dataLines.join("\n"); // jangan .trim()
      if (!payload) continue;

      if (ev === "progress") onProgress(payload);
      else if (ev === "debug") onProgress(`[DEBUG] ${payload}`);
      else {
        full += payload;
        onChunkAnswer(payload);
      }
    }
  }
  return full;
}

/** Chat biasa (tanpa web search) */
export function askStream(
  prompt: string,
  onChunkAnswer: (txt: string) => void,
  onProgress: (msg: string) => void
): Promise<string> {
  return sseStream(`${BACKEND_URL}/api/ask`, { prompt }, onChunkAnswer, onProgress);
}

/** Web search (Responses API + tool web_search) */
export function searchStream(
  query: string,
  onChunkAnswer: (txt: string) => void,
  onProgress: (msg: string) => void
): Promise<string> {
  return sseStream(`${BACKEND_URL}/api/search`, { query }, onChunkAnswer, onProgress);
}

export async function tts(text: string, voice?: string): Promise<{ audio_base64: string }> {
  const res = await fetch(`${BACKEND_URL}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice })
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  return res.json();
}