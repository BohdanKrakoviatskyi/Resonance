import type { LyricLine, LyricWord } from '../types';

/** Rust `WordLine` (milliseconds) → our seconds-based lines. */
export function fromWordLines(lines: { startMs: number; words: { startMs: number; durMs: number; text: string }[] }[]): LyricLine[] {
  return lines
    .map((l) => {
      const words: LyricWord[] = l.words.map((w) => ({ t: w.startMs / 1000, d: Math.max(0.05, w.durMs / 1000), text: w.text }));
      return { t: l.startMs / 1000, text: words.map((w) => w.text).join('').trim(), words };
    })
    .filter((l) => l.text);
}

const WORD_TAG = /<(\d+):(\d+(?:\.\d+)?)>/g;

/**
 * Enhanced LRC (A2): `[00:12.00]<00:12.00>Never <00:12.40>gonna …`.
 * Returns plain text plus per-word timing; a word lasts until the next tag (or `lineEnd`).
 */
export function parseEnhancedWords(body: string, lineEnd?: number): { text: string; words?: LyricWord[] } {
  const tags = [...body.matchAll(WORD_TAG)];
  if (!tags.length) return { text: body.trim() };
  const words: LyricWord[] = [];
  for (let i = 0; i < tags.length; i++) {
    const m = tags[i];
    const start = +m[1] * 60 + +m[2];
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < tags.length ? (tags[i + 1].index ?? body.length) : body.length;
    const text = body.slice(from, to);
    const next = i + 1 < tags.length ? +tags[i + 1][1] * 60 + +tags[i + 1][2] : (lineEnd ?? start + 0.6);
    if (text) words.push({ t: start, d: Math.max(0.05, next - start), text });
  }
  const text = words.map((w) => w.text).join('').trim();
  return words.length ? { text, words } : { text };
}

/** 0..1 progress of each word at `time`; writes into `out`. */
export function wordProgress(words: LyricWord[], time: number, out: number[]): number[] {
  out.length = words.length;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    out[i] = time <= w.t ? 0 : time >= w.t + w.d ? 1 : (time - w.t) / w.d;
  }
  return out;
}
