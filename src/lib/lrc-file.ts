/** Turns a user-supplied .lrc/.txt file into the same record shape LRCLIB returns. */

export interface LrcFileRecord {
  trackName: string;
  artistName: string;
  albumName?: string;
  syncedLyrics?: string;
  plainLyrics?: string;
  /** Value of the [offset:] tag converted to seconds (LRC spec: ms, positive = earlier). */
  offsetSec: number;
}

const TIME_TAG = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/;
const META_TAG = /^\[(ar|ti|al|offset|by|re|ve|length|au|#):([^\]]*)\]\s*$/i;

export function parseLrcFile(text: string, fallback: { title: string; artist: string }): LrcFileRecord | null {
  const meta: Record<string, string> = {};
  const body: string[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const m = raw.trim().match(META_TAG);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
    else body.push(raw.trimEnd());
  }
  const joined = body.join('\n').trim();
  if (!joined) return null;
  const offsetMs = Number(meta.offset);
  const rec: LrcFileRecord = {
    trackName: meta.ti || fallback.title,
    artistName: meta.ar || fallback.artist,
    albumName: meta.al || undefined,
    // A positive LRC offset shows lyrics earlier, which is a negative shift in our model.
    offsetSec: Number.isFinite(offsetMs) ? -offsetMs / 1000 : 0,
  };
  if (body.some((l) => TIME_TAG.test(l))) rec.syncedLyrics = joined;
  else rec.plainLyrics = joined;
  return rec;
}
