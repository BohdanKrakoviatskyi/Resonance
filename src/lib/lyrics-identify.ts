/**
 * Fuzzy "is this the same song?" scoring used to identify a track in a catalogue
 * (YouTube Music search) and to rank lyrics candidates. Replaces hard pass/fail rules with a
 * weighted score, while still refusing obvious false positives (other song, other artist).
 */
import { artistsMatch, normalizeLyricsText, stripTrackNoise, titleWordCount, tokenOverlapScore, toSeconds, type LyricsCandidate } from './lyrics-match.ts';

export type SpeedKind = 'slowed' | 'spedUp' | null;

export interface CatalogCandidate {
  title: string;
  artist: string;
  /** Seconds (or ms; normalized). */
  duration: number;
}

export interface MatchResult {
  score: number;
  /**
   * playing duration / original duration. 1 for normal copies; for speed-altered uploads the
   * original lyrics' timestamps must be multiplied by this to line up.
   */
  timeScale: number;
}

const SLOWED = [1.05, 1.4] as const;
const SPED_UP = [0.7, 0.96] as const;

function durationScore(wantSec: number, candSec: number, speed: SpeedKind): { score: number; timeScale: number } | null {
  if (!(wantSec > 0) || !(candSec > 0)) return { score: 0.5, timeScale: 1 };
  const ratio = wantSec / candSec;
  if (speed) {
    const [lo, hi] = speed === 'slowed' ? SLOWED : SPED_UP;
    if (ratio >= lo && ratio <= hi) return { score: 1, timeScale: ratio };
  }
  const delta = Math.abs(wantSec - candSec);
  if (delta <= 3) return { score: 1, timeScale: 1 };
  if (delta <= 8) return { score: 0.75, timeScale: 1 };
  // Music videos often add an intro/outro of up to ~half a minute.
  if (delta <= 35) return { score: 0.35, timeScale: 1 };
  return null;
}

export function matchScore(
  query: { title: string; artist: string },
  cand: CatalogCandidate,
  wantDuration: number,
  speed: SpeedKind = null,
): MatchResult | null {
  const qt = normalizeLyricsText(stripTrackNoise(query.title));
  const ct = normalizeLyricsText(stripTrackNoise(cand.title));
  if (!qt || !ct) return null;
  const exactTitle = qt === ct;
  const titleSim = exactTitle ? 1 : tokenOverlapScore(query.title, cand.title);
  if (titleSim < 0.6) return null;

  const artistSim = !query.artist
    ? 0.5
    : artistsMatch(query.artist, cand.artist)
      ? 1
      : Math.min(1, tokenOverlapScore(query.artist, cand.artist));

  const dur = durationScore(toSeconds(wantDuration), toSeconds(cand.duration), speed);
  if (!dur) return null;

  // Without any artist evidence only a distinctive (3+ word) exact title with a matching length is
  // believable; one- and two-word titles collide across thousands of unrelated songs.
  if (artistSim < 0.3 && !(exactTitle && dur.score === 1 && titleWordCount(query.title) >= 3)) return null;

  const score = titleSim * 0.5 + artistSim * 0.3 + dur.score * 0.2;
  return score >= 0.62 ? { score, timeScale: dur.timeScale } : null;
}

/**
 * LRCLIB-style lyrics records → best usable record plus the time scale to apply.
 * Synced lyrics get a small bonus over plain text for otherwise equal matches.
 */
export function findLyricsMatch<T extends LyricsCandidate>(
  candidates: T[],
  queries: { title: string; artist: string }[],
  wantDuration: number,
  speed: SpeedKind = null,
): { candidate: T; timeScale: number } | null {
  // Any record that passes the match check with timestamps wins over plain text, however the
  // scores compare: losing sync is far worse than a slightly weaker (but accepted) match.
  type Best = { candidate: T; timeScale: number; score: number } | null;
  let synced: Best = null;
  let other: Best = null;
  for (const c of candidates) {
    if (!c.syncedLyrics && !c.plainLyrics && !c.instrumental) continue;
    for (const q of queries) {
      const m = matchScore(q, { title: c.trackName ?? '', artist: c.artistName ?? '', duration: c.duration ?? 0 }, wantDuration, speed);
      if (!m) continue;
      const entry = { candidate: c, timeScale: m.timeScale, score: m.score };
      if (c.syncedLyrics) {
        if (!synced || entry.score > synced.score) synced = entry;
      } else if (!other || entry.score > other.score) other = entry;
    }
  }
  const best = synced ?? other;
  return best && { candidate: best.candidate, timeScale: best.timeScale };
}

/** Best candidate across several query variants, or null. */
export function pickBest<T extends CatalogCandidate>(
  queries: { title: string; artist: string }[],
  candidates: T[],
  wantDuration: number,
  speed: SpeedKind = null,
): { candidate: T; match: MatchResult } | null {
  let best: { candidate: T; match: MatchResult } | null = null;
  for (const q of queries) {
    for (const c of candidates) {
      const m = matchScore(q, c, wantDuration, speed);
      if (m && (!best || m.score > best.match.score)) best = { candidate: c, match: m };
    }
  }
  return best;
}
