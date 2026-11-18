/** Speech-recognition output → Enhanced LRC (line stamps + <mm:ss.xx> word tags). */

export interface TranscriptLine {
  startMs: number;
  words: { startMs: number; durMs: number; text: string }[];
}

const stamp = (ms: number) => {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

export function toEnhancedLrc(lines: TranscriptLine[]): string {
  return lines
    .filter((l) => l.words.length)
    .map((l) => `[${stamp(l.startMs)}]` + l.words.map((w) => `<${stamp(w.startMs)}>${w.text}`).join(''))
    .join('\n');
}

/** Whisper language hint from the title/artist script; "auto" when undecidable. */
export function guessLanguage(text: string): string {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (!letters) return 'auto';
  const cyr = (letters.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  if (cyr / letters.length > 0.5) return /[іїєґ]/i.test(text) ? 'uk' : 'ru';
  return 'auto';
}

/** Thread count per load level; keeps a big margin so playback and the UI never starve. */
export function threadsFor(level: 'low' | 'medium' | 'high', cores: number): number {
  const c = Math.max(1, Math.floor(cores) || 4);
  if (level === 'low') return Math.min(2, c);
  if (level === 'medium') return Math.max(2, Math.floor(c / 4));
  return Math.max(2, Math.floor(c / 2));
}

/** 16 kHz mono PCM → little-endian bytes for the raw IPC body. */
export function pcmToBytes(pcm: Float32Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) view.setFloat32(i * 4, pcm[i], true);
  return out;
}
