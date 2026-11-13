import type { Track } from '../types';

/** Normalizes any duration value (seconds, milliseconds > 1800, or "m:ss" string) strictly into seconds. */
export function toSeconds(val: unknown): number {
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return 0;
    // Track durations in ms (e.g. 113000) vs seconds (113.0)
    return val > 1800 ? val / 1000 : val;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return 0;
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':').map((p) => Number.parseFloat(p));
      if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
      return parts.reduce((acc, part) => acc * 60 + part, 0);
    }
    const num = Number.parseFloat(trimmed);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return num > 1800 ? num / 1000 : num;
  }
  return 0;
}

export function normalizeLyricsText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function tokenizeLyricsText(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const FILLER_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'the', 'to', 'up', 'we', 'you', 'your',
]);

export function titleWordCount(value: string): number {
  const unique = new Set(tokenizeLyricsText(stripTrackNoise(value)).filter((t) => !FILLER_WORDS.has(t)));
  return unique.size;
}

const firstArtist = (value: string) =>
  value
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .split(/,|&|\s+\|\s+| feat\.? | ft\.? | featuring | x | и /i)[0]
    .trim();

export function stripTrackNoise(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/gi, "'")
    .replace(/\.mp3$|\.wav$|\.flac$/i, '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/\+\S+/g, ' ')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*[[(](?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|4k\b|hd\b|mv\b|prod\b|slowed\b|reverb\b|sped\s*up\b|speed\s*up\b|nightcore\b|pitched\b|tiktok\b|version\b|alt\s*ver\b|tgk?\b|vk\b|by\b|feat\b|ft\b)[^\])]*[\])]/gi, ' ')
    .replace(/\s*[[(][^\])]*(?:prod\.?|slowed|reverb|speed\s*up|sped\s*up|nightcore|pitched|tiktok|version|alt\s*ver|tgk?:|vk:|премьера|клип)[^\])]*[\])]/gi, ' ')
    .replace(/\b(?:prod\.?|tgk?:?|vk:?)\s*[\p{L}\p{N}_.@/-]+/giu, ' ')
    .replace(/\b(?:ft|feat|featuring)\.?\s+[^-–—|()[\]]+/giu, ' ')
    .replace(/\s*(?:[-–—|])\s*(?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|slowed\b|sped\s*up\b|speed\s*up\b|reverb\b|nightcore\b|pitched\b|tiktok\b|alt\s*ver\b).*$/i, '')
    .replace(/[♥𒉭🔥💔]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, '')
    .trim();
}

export function tokenOverlapScore(want: string, have: string): number {
  const a = new Set(tokenizeLyricsText(stripTrackNoise(want)));
  const b = new Set(tokenizeLyricsText(stripTrackNoise(have)));
  if (!a.size || !b.size) return 0;
  let forward = 0;
  for (const t of a) if (b.has(t)) forward++;
  let reverse = 0;
  for (const t of b) if (a.has(t)) reverse++;
  const base = (forward / a.size) * 0.7 + (reverse / b.size) * 0.3;
  const surplus = Math.max(0, b.size - a.size);
  const penalty = Math.min(0.45, (surplus / b.size) * 0.45);
  return base * (1 - penalty);
}

export function artistsMatch(queryArtist: string, candidateArtist: string): boolean {
  const qa = normalizeLyricsText(firstArtist(queryArtist));
  const ca = normalizeLyricsText(firstArtist(candidateArtist));
  if (!qa || !ca) return false;
  if (qa === ca) return true;
  return tokenOverlapScore(queryArtist, candidateArtist) >= 0.65;
}

const stripParentheticalSubtitle = (value: string): string =>
  value.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

export function lyricsSearchQueries(track: Pick<Track, 'title' | 'artist' | 'source'>) {
  const cleanedTitle = stripTrackNoise(track.title);
  const uploader = firstArtist(stripTrackNoise(track.artist));
  const queries: { title: string; artist: string }[] = [];

  const add = (nextTitle: string, nextArtist: string) => {
    const clean = { title: stripTrackNoise(nextTitle), artist: firstArtist(stripTrackNoise(nextArtist)) };
    if (
      clean.title &&
      clean.artist &&
      !queries.some(
        (query) =>
          normalizeLyricsText(query.title) === normalizeLyricsText(clean.title) &&
          normalizeLyricsText(query.artist) === normalizeLyricsText(clean.artist),
      )
    ) {
      queries.push(clean);
    }
    const shortTitle = stripParentheticalSubtitle(clean.title);
    if (
      shortTitle &&
      shortTitle !== clean.title &&
      clean.artist &&
      !queries.some(
        (query) =>
          normalizeLyricsText(query.title) === normalizeLyricsText(shortTitle) &&
          normalizeLyricsText(query.artist) === normalizeLyricsText(clean.artist),
      )
    ) {
      queries.push({ title: shortTitle, artist: clean.artist });
    }
  };

  // Pattern: "Track Title by Artist Name"
  const byMatch = cleanedTitle.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    add(byMatch[1].trim(), byMatch[2].trim());
  }

  // Both SoundCloud and YouTube frequently encode "Real Artist - Track Name" or "Track Name - Real Artist"
  const parts =
    cleanedTitle.match(/^(.+?)\s+[–—-]\s+(.+)$/) ||
    cleanedTitle.match(/^([\p{L}\p{N}\s.&,'’]+?)[–—-]([\p{L}\p{N}\s.&,'’()!?]+)$/u);
  if (parts) {
    const left = parts[1].trim();
    const right = parts[2].trim();
    if (normalizeLyricsText(right) === normalizeLyricsText(uploader)) {
      add(left, right);
    } else {
      add(right, left);
      add(left, right);
      if (uploader && normalizeLyricsText(left) !== normalizeLyricsText(uploader)) {
        add(right, uploader);
      }
    }
  }

  add(cleanedTitle, uploader);
  if (cleanedTitle !== track.title.trim()) add(track.title, uploader);
  return queries;
}

export type LyricsCandidate = {
  id?: number | string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string;
  plainLyrics?: string;
  instrumental?: boolean;
  possibleOffsetWarning?: boolean;
};

export type TempoVariant = 'slowed' | 'sped_up' | null;

export function detectTempoVariant(title: string, artist = ''): TempoVariant {
  const combined = `${title} ${artist}`;
  if (/\b(?:sped\s*up|speed\s*up|nightcore|fast\s*version)\b/i.test(combined)) {
    return 'sped_up';
  }
  if (/\b(?:slowed|slow\s*version|reverb\s*&\s*slowed|slowed\s*[+&]\s*reverb)\b/i.test(combined)) {
    return 'slowed';
  }
  return null;
}

export function scaleSyncedLrcTimestamps(
  lrc: string,
  trackDuration: unknown,
  originalDuration: unknown,
  enabled = true,
): string {
  if (!enabled || !lrc) return lrc;
  const trackSec = toSeconds(trackDuration);
  const origSec = toSeconds(originalDuration);
  if (trackSec <= 0 || origSec <= 0) return lrc;
  const ratio = trackSec / origSec;
  if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 1.75 || Math.abs(ratio - 1) < 0.01) {
    return lrc;
  }
  return lrc.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, (_match, mmRaw: string, ssRaw: string) => {
    const totalSec = Math.max(0, (Number(mmRaw) * 60 + Number(ssRaw)) * ratio);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec - mins * 60;
    const mm = String(mins).padStart(2, '0');
    const ss = secs.toFixed(2).padStart(5, '0');
    return `[${mm}:${ss}]`;
  });
}

export type LyricsMatchOptions = {
  scaleSlowedLyrics?: boolean;
  rawTitle?: string;
  rawArtist?: string;
};

export function findLyricsCandidate<T extends LyricsCandidate>(
  candidates: T[],
  query: { title: string; artist: string },
  rawDuration: number,
  tolerance = 4,
  options?: LyricsMatchOptions,
): T | null {
  const wantSec = toSeconds(rawDuration);
  const queryTitleNorm = normalizeLyricsText(stripTrackNoise(query.title));
  if (!queryTitleNorm) return null;
  const wordCount = titleWordCount(query.title);
  const tempoVariant =
    options?.scaleSlowedLyrics
      ? detectTempoVariant(options.rawTitle ?? query.title, options.rawArtist ?? query.artist)
      : null;

  const scored: { candidate: T; score: number }[] = [];

  for (const candidate of candidates) {
    if (!candidate.syncedLyrics && !candidate.plainLyrics && !candidate.instrumental) continue;

    const candTitle = candidate.trackName ?? '';
    const candArtist = candidate.artistName ?? '';
    const candSec = toSeconds(candidate.duration);

    const titleSim = tokenOverlapScore(query.title, candTitle);
    const exactTitle = normalizeLyricsText(stripTrackNoise(candTitle)) === queryTitleNorm;
    if (!exactTitle && titleSim < 0.75) continue;

    const artistOk = artistsMatch(query.artist, candArtist);
    const highConfidenceMatch = artistOk && (exactTitle || titleSim >= 0.85);
    const effectiveTolerance = highConfidenceMatch ? Math.max(tolerance, 10) : tolerance;
    const deltaSec = wantSec > 0 && candSec > 0 ? Math.abs(wantSec - candSec) : 0;
    const ratio = wantSec > 0 && candSec > 0 ? wantSec / candSec : 1;
    const tempoRatioOk =
      Boolean(tempoVariant) &&
      highConfidenceMatch &&
      wantSec > 0 &&
      candSec > 0 &&
      (tempoVariant === 'slowed'
        ? ratio >= 0.95 && ratio <= 1.65
        : ratio >= 0.6 && ratio <= 1.15);

    if (wantSec > 0 && candSec > 0) {
      if (deltaSec > effectiveTolerance && !tempoRatioOk) continue;
    }

    // Strict anti-false-positive rule:
    // If the artist does NOT match, we ONLY allow the candidate when the title has at least
    // 3 unique words AND exact title match AND duration matches within ±1.5 seconds.
    // Otherwise (e.g. 1-word title "самолёт" or "молчи" from a different artist), reject immediately!
    if (!artistOk) {
      if (wordCount < 3 || !exactTitle || wantSec <= 0 || candSec <= 0 || deltaSec > 1.5) {
        continue;
      }
    }

    const durBonus =
      wantSec > 0 && candSec > 0
        ? deltaSec <= effectiveTolerance
          ? Math.max(0, 1 - deltaSec / Math.max(effectiveTolerance, 1))
          : tempoRatioOk
            ? 0.65
            : 0
        : 0.5;
    const syncBonus = candidate.syncedLyrics ? 0.15 : 0;
    const score = (exactTitle ? 1 : titleSim) * 0.55 + (artistOk ? 0.35 : 0) + durBonus * 0.1 + syncBonus;
    scored.push({ candidate, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.candidate ?? null;
}

export type PersistentLyricsCacheEntry = {
  data: {
    synced?: { t: number; text: string; gap?: boolean }[];
    plain?: string[];
    instrumental?: boolean;
    preview?: boolean;
    matchedTitle?: string;
    matchedArtist?: string;
    matchedDurationSec?: number;
    durationDeltaSec?: number;
    sourceLabel?: 'LRCLIB' | 'Deezer' | 'Кэш' | 'Выбран вручную';
    possibleOffsetWarning?: boolean;
  } | null;
  savedAt: number;
};

export const LYRICS_NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LYRICS_CACHE_MAX_ENTRIES = 400;

export function resolvePersistentLyricsCacheEntry(
  cache: Record<string, PersistentLyricsCacheEntry>,
  trackId: string,
  now = Date.now(),
  manualOverride = false,
): { hit: boolean; data: PersistentLyricsCacheEntry['data'] } {
  if (manualOverride) return { hit: false, data: null };
  const entry = cache[trackId];
  if (!entry || typeof entry.savedAt !== 'number') return { hit: false, data: null };
  if (entry.data === null) {
    if (now - entry.savedAt >= LYRICS_NEGATIVE_CACHE_TTL_MS) {
      return { hit: false, data: null };
    }
    return { hit: true, data: null };
  }
  return { hit: true, data: entry.data };
}

export function writePersistentLyricsCacheEntry(
  cache: Record<string, PersistentLyricsCacheEntry>,
  trackId: string,
  outcome: { status: 'found'; data: NonNullable<PersistentLyricsCacheEntry['data']> } | { status: 'not_found' } | { status: 'network_error' },
  now = Date.now(),
): Record<string, PersistentLyricsCacheEntry> {
  if (outcome.status === 'network_error') {
    return cache;
  }
  const next: Record<string, PersistentLyricsCacheEntry> = {
    ...cache,
    [trackId]: {
      data: outcome.status === 'found' ? outcome.data : null,
      savedAt: now,
    },
  };
  const keys = Object.keys(next);
  if (keys.length > LYRICS_CACHE_MAX_ENTRIES) {
    keys
      .sort((a, b) => (next[a]?.savedAt ?? 0) - (next[b]?.savedAt ?? 0))
      .slice(0, keys.length - LYRICS_CACHE_MAX_ENTRIES)
      .forEach((k) => {
        delete next[k];
      });
  }
  return next;
}

/** Strict validator for Genius / external candidates that lack a reliable duration field. */
export function matchesGeniusCandidate(
  query: { title: string; artist: string },
  candidate: { title?: string; artist?: string },
): boolean {
  const candTitle = candidate.title ?? '';
  const candArtist = candidate.artist ?? '';
  if (!candTitle || !candArtist) return false;
  // Genius does not provide duration in search results, so BOTH artist and title MUST match strictly!
  if (!artistsMatch(query.artist, candArtist)) return false;
  const exactTitle = normalizeLyricsText(stripTrackNoise(candTitle)) === normalizeLyricsText(stripTrackNoise(query.title));
  return exactTitle || tokenOverlapScore(query.title, candTitle) >= 0.8;
}
