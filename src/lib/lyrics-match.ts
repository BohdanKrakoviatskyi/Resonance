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
    .split(/,|&| feat\.? | ft\.? | featuring | x | и /i)[0]
    .trim();

export function stripTrackNoise(value: string): string {
  return value
    // Emoji and pictographs ("🔥 song 🔥"), plus variation selectors / ZWJ left behind.
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
    .replace(/[«»“”„]/g, ' ')
    .replace(/\s*[[(]\s*(?:free(?:\s*(?:dl|download))?|out now|premiere|new|exclusive|explicit|clean|bass\s*boosted)\s*[\])]/gi, ' ')
    .replace(/\b(?:free\s+download|out\s+now)\b/gi, ' ')
    // Release-version markers: same words, same lyrics ("(Remastered 2011)", "- Radio Edit").
    .replace(/\s*[[(][^\])]*\b(?:remaster(?:ed)?|radio\s+edit|single\s+version|album\s+version|original\s+version|mono|stereo|deluxe|bonus\s+track|edit)\b[^\])]*[\])]/gi, ' ')
    .replace(/\s+[-–—]\s+(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?|radio\s+edit|single\s+version|album\s+version|mono|stereo)\s*$/i, '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/\+\S+/g, ' ')
    .replace(/\s*[[(](?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|4k\b|hd\b|mv\b|prod\b|slowed\b|reverb\b|sped\s*up\b|speed\s*up\b|nightcore\b|alt\s*ver\b|tgk?\b|vk\b|by\b|feat\b|ft\b)[^\])]*[\])]/gi, ' ')
    .replace(/\s*[[(][^\])]*(?:prod\.?|slowed|reverb|speed\s*up|sped\s*up|nightcore|alt\s*ver|tgk?:|vk:)[^\])]*[\])]/gi, ' ')
    .replace(/\b(?:prod\.?|tgk?:?|vk:?)\s*[\p{L}\p{N}_.@/-]+/giu, ' ')
    .replace(/\b(?:ft|feat|featuring)\.?\s+[\p{L}\p{N}&,'’. -]+/giu, ' ')
    .replace(/\s*(?:[-–—|])\s*(?:official\b|lyrics?\b|audio\b|music video\b|visuali[sz]er\b|slowed\b|sped\s*up\b|speed\s*up\b|reverb\b|nightcore\b|alt\s*ver\b).*$/i, '')
    .replace(/\s+/g, ' ')
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

/**
 * Speed-altered re-uploads ("slowed + reverb", "sped up", "nightcore"). Their lyrics are the
 * original's, stretched in time; `kind` tells the matcher to accept a proportional duration.
 */
export function speedVariant(title: string): 'slowed' | 'spedUp' | null {
  if (/\b(?:slowed|slow(?:ed)?\s*\+?\s*reverb|daycore)\b/i.test(title)) return 'slowed';
  if (/\b(?:sped\s*up|speed\s*up|nightcore|fast(?:er)?\s*version)\b/i.test(title)) return 'spedUp';
  return null;
}

export function lyricsSearchQueries(track: Pick<Track, 'title' | 'artist' | 'source'> & { metaArtist?: string }) {
  const cleanedTitle = stripTrackNoise(track.title);
  // On SoundCloud the uploader is frequently a repost/fan account, so it is the weakest hint.
  const uploader = firstArtist(stripTrackNoise(track.artist));
  const meta = track.metaArtist ? firstArtist(stripTrackNoise(track.metaArtist)) : '';
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
  };

  // Both SoundCloud and YouTube frequently encode "Real Artist - Track Name" inside `title`
  const parts = cleanedTitle.match(/^(.+?)\s+[–—-]\s+(.+)$/);
  // Publisher metadata is the most trustworthy artist; pair it with the title part that isn't the artist.
  if (meta) {
    if (parts && normalizeLyricsText(parts[1]) === normalizeLyricsText(meta)) add(parts[2], meta);
    else if (parts && normalizeLyricsText(parts[2]) === normalizeLyricsText(meta)) add(parts[1], meta);
    else if (parts) add(parts[2], meta);
    add(cleanedTitle, meta);
  }
  if (parts) {
    const left = parts[1].trim();
    const right = parts[2].trim();
    if (normalizeLyricsText(right) === normalizeLyricsText(uploader)) {
      add(left, right);
    } else {
      add(right, left);
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
};

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
