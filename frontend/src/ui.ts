// frontend/src/ui.ts
function must<T>(el: T | null, id: string): T {
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

export const els = {
  startBtn: must(document.getElementById("startBtn") as HTMLButtonElement | null, "startBtn"),
  stopBtn: must(document.getElementById("stopBtn") as HTMLButtonElement | null, "stopBtn"),
  transcript: must(document.getElementById("transcript") as HTMLPreElement | null, "transcript"),
  progress: must(document.getElementById("progress") as HTMLPreElement | null, "progress"),
  answer: must(document.getElementById("answer") as HTMLPreElement | null, "answer"),
  audio: must(document.getElementById("answerAudio") as HTMLAudioElement | null, "answerAudio"),
};

export function showStop(): void {
  els.startBtn.style.display = "none";
  els.stopBtn.style.display = "inline-block";
}

export function showStart(): void {
  els.startBtn.style.display = "inline-block";
  els.stopBtn.style.display = "none";
}
