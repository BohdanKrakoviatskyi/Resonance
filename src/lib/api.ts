import type { LyricLine, Track } from '../types';
import { findYouTubeFallbackCandidate, youtubeFallbackQueries } from './youtube-match';
import { findLyricsCandidate, lyricsSearchQueries, toSeconds, type LyricsCandidate } from './lyrics-match';
import { rpc } from './sidecar';

import {
  searchSoundCloudTracks,
  soundCloudTrackLyrics,
  soundCloudRelatedTracks,
  type SoundCloudTrackCard,
  type SoundCloudSearchTrack,
  searchYtDlpTracks,
  ytDlpTrackStream,
} from './providers-api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function getJson(url: string): Promise<Json> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

type SoundCloudTrackLike = Pick<SoundCloudTrackCard, 'id' | 'trackUrn' | 'title' | 'permalinkUrl' | 'artworkUrl' | 'duration' | 'user'> | Pick<SoundCloudSearchTrack, 'id' | 'urn' | 'title' | 'permalinkUrl' | 'artworkUrl' | 'duration' | 'user'>;

export function mapSoundCloudTrack(track: SoundCloudTrackLike): Track {
  const duration = track.duration / 1000;
  const nativeId = ('trackUrn' in track ? track.trackUrn : track.urn) || `soundcloud:tracks:${track.id}`;
  return {
    id: `sc:${track.id}`, title: track.title, artist: track.user?.username || 'SoundCloud',
    cover: track.artworkUrl || undefined, thumb: track.artworkUrl || undefined,
    src: track.permalinkUrl || '', duration, fullDuration: duration || undefined,
    nativeId, source: 'soundcloud',
  };
}

export async function searchTracks(query: string, signal?: AbortSignal): Promise<Track[]> {
  const results = await Promise.allSettled([
    searchSoundCloudTracks(query, signal),
    searchYtDlpTracks(query, signal),
  ]);
  const [soundcloud, youtube] = results;
  const tracks: Track[] = [];
  if (soundcloud.status === 'fulfilled') tracks.push(...soundcloud.value.map(mapSoundCloudTrack));
  if (youtube.status === 'fulfilled') {
    for (const track of youtube.value) {
      const duration = track.durationMs / 1000;
      tracks.push({
        id: `yt:${track.nativeId}`, title: track.title, artist: track.artist,
        cover: track.artworkUrl || undefined, thumb: track.artworkUrl || undefined,
        src: track.permalink || `https://music.youtube.com/watch?v=${encodeURIComponent(track.nativeId)}`,
        duration, fullDuration: duration || undefined, nativeId: track.nativeId, playback: 'direct', source: 'youtube',
      });
    }
  }
  if (tracks.length) return tracks;
  const firstError = results.find((result) => result.status === 'rejected');
  if (firstError?.status === 'rejected') throw firstError.reason;
  return [];
}


export async function trackStream(trackUrn: string): Promise<{ url: string; hls: boolean; preview: boolean }> {
  const result = await rpc<{ url: string; hls?: boolean; preview?: boolean }>('track.stream', { trackUrn });
  if (!result?.url) throw new Error('SoundCloud did not return an audio stream.');
  return { url: result.url, hls: Boolean(result.hls), preview: Boolean(result.preview) };
}

export async function relatedSoundCloudTracks(trackId: number): Promise<Track[]> {
  return (await soundCloudRelatedTracks(trackId)).map(mapSoundCloudTrack);
}

export async function searchYouTubeRecommendations(track: Track): Promise<Track[]> {
  const results = await searchYtDlpTracks(`${track.artist} songs like ${track.title}`);
  return results.map((item) => {
    const duration = item.durationMs / 1000;
    return {
      id: `yt:${item.nativeId}`, title: item.title, artist: item.artist,
      cover: item.artworkUrl || undefined, thumb: item.artworkUrl || undefined,
      src: item.permalink || `https://music.youtube.com/watch?v=${encodeURIComponent(item.nativeId)}`,
      duration, fullDuration: duration || undefined, nativeId: item.nativeId, playback: 'direct', source: 'youtube',
    };
  });
}

export { ytDlpTrackStream };

export async function findYouTubeFallback(track: Track): Promise<Track | null> {
  const seed = { ...track, duration: track.fullDuration ?? track.duration };
  for (const query of youtubeFallbackQueries(seed)) {
    try {
      const ytCandidates = (await searchYtDlpTracks(query)).filter(
        (c) => `yt:${c.nativeId}` !== track.id && c.nativeId !== track.nativeId
      );
      const match = findYouTubeFallbackCandidate(seed, ytCandidates);
      if (match) {
        const duration = match.durationMs / 1000;
        const fallbackCover = match.nativeId ? `https://i.ytimg.com/vi/${encodeURIComponent(match.nativeId)}/hqdefault.jpg` : undefined;
        const artwork = match.artworkUrl || fallbackCover;
        return {
          id: `yt:${match.nativeId}`, title: match.title, artist: match.artist,
          cover: artwork, thumb: artwork,
          src: match.permalink || `https://music.youtube.com/watch?v=${encodeURIComponent(match.nativeId)}`,
          duration, fullDuration: duration || undefined, nativeId: match.nativeId, playback: 'direct', source: 'youtube',
        };
      }
    } catch {
      // Continue to SoundCloud fallback
    }
    if (track.id.startsWith('yt:')) {
      try {
        const scTracks = await searchSoundCloudTracks(query);
        const scCandidates = scTracks
          .filter((sc) => sc.duration > 60_000)
          .map((sc) => ({
            ...sc,
            artist: sc.user?.username || 'SoundCloud',
            durationMs: sc.duration,
          }));
        const scMatch = findYouTubeFallbackCandidate(seed, scCandidates);
        if (scMatch) {
          return mapSoundCloudTrack(scMatch);
        }
      } catch {
        // Ignore SoundCloud search error
      }
    }
  }
  return null;
}

/* ---------------- lyrics ---------------- */

export function parseLrc(s: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of s.split('\n')) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + +m[2], text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Inserts "• • •" breathing lines for intros and long instrumental breaks. */
export function withGaps(lines: LyricLine[]): LyricLine[] {
  const out: LyricLine[] = [];
  const src = lines.filter((l, i) => l.text || (lines[i + 1] && lines[i + 1].t - l.t > 6));
  if (src.length && src[0].t > 5) out.push({ t: 0, text: '', gap: true });
  src.forEach((l, i) => {
    if (!l.text) {
      out.push({ t: l.t, text: '', gap: true });
      return;
    }
    out.push(l);
    const nx = src[i + 1];
    if (nx && nx.text && nx.t - l.t > 14) out.push({ t: l.t + 6.5, text: '', gap: true });
  });
  return out;
}

export interface LyricsData {
  synced?: LyricLine[];
  plain?: string[];
  instrumental?: boolean;
  preview?: boolean;
  matchedTitle?: string;
  matchedArtist?: string;
}

export interface ManualLyricsChoice {
  id: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration: number;
  syncedLyrics?: string;
  plainLyrics?: string;
  instrumental?: boolean;
}

const MANUAL_LYRICS_STORAGE_KEY = 'resonance.manual_lyrics.v1';
const lyricsCache = new Map<string, Promise<LyricsData | null>>();
let lyricsOverrides: Record<string, ManualLyricsChoice> | null = null;
let lyricsOverridesRestored: Promise<void> | null = null;

function loadLyricsOverrides(): Record<string, ManualLyricsChoice> {
  if (lyricsOverrides) return lyricsOverrides;
  try {
    const raw = localStorage.getItem(MANUAL_LYRICS_STORAGE_KEY);
    lyricsOverrides = raw ? (JSON.parse(raw) as Record<string, ManualLyricsChoice>) : {};
  } catch {
    lyricsOverrides = {};
  }
  return lyricsOverrides;
}

function ensureLyricsOverridesRestored(): Promise<void> {
  if (lyricsOverridesRestored) return lyricsOverridesRestored;
  lyricsOverridesRestored = import('./providers-api')
    .then(({ restoreFrontendState }) => restoreFrontendState())
    .then((entries) => {
      const raw = entries?.[MANUAL_LYRICS_STORAGE_KEY];
      if (!raw) return;
      const restored = JSON.parse(raw) as Record<string, ManualLyricsChoice>;
      if (!restored || typeof restored !== 'object') return;
      const current = loadLyricsOverrides();
      const merged = { ...restored, ...current };
      lyricsOverrides = merged;
      try {
        localStorage.setItem(MANUAL_LYRICS_STORAGE_KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
  return lyricsOverridesRestored;
}

function saveLyricsOverrides(map: Record<string, ManualLyricsChoice>) {
  lyricsOverrides = map;
  try {
    localStorage.setItem(MANUAL_LYRICS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota errors */
  }
  void import('./util')
    .then(({ flushFrontendStateBackup }) => flushFrontendStateBackup())
    .catch(() => {});
}

export function lyricsDataFromRecord(rec: LyricsCandidate): LyricsData | null {
  if (rec.instrumental) {
    return { instrumental: true, matchedTitle: rec.trackName, matchedArtist: rec.artistName };
  }
  if (rec.syncedLyrics) {
    const synced = withGaps(parseLrc(rec.syncedLyrics));
    if (synced.length) {
      return { synced, matchedTitle: rec.trackName, matchedArtist: rec.artistName };
    }
  }
  const plainSrc: string = rec.plainLyrics || (rec.syncedLyrics ? String(rec.syncedLyrics).replace(/\[[^\]]*\]/g, '') : '');
  const plain = plainSrc.split('\n').map((s) => s.trim()).filter(Boolean);
  return plain.length ? { plain, matchedTitle: rec.trackName, matchedArtist: rec.artistName } : null;
}

export function setManualLyricsChoice(trackId: string, choice: ManualLyricsChoice | null): LyricsData | null {
  const overrides = { ...loadLyricsOverrides() };
  if (choice) {
    overrides[trackId] = choice;
    saveLyricsOverrides(overrides);
    const data = lyricsDataFromRecord(choice);
    lyricsCache.set(trackId, Promise.resolve(data));
    return data;
  }
  delete overrides[trackId];
  saveLyricsOverrides(overrides);
  lyricsCache.delete(trackId);
  return null;
}

export function hasManualLyricsChoice(trackId: string): boolean {
  return Boolean(loadLyricsOverrides()[trackId]);
}

export async function searchLyricsManual(query: string, signal?: AbortSignal): Promise<ManualLyricsChoice[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ q });
  const response = await fetch(`https://lrclib.net/api/search?${params}`, { signal });
  if (!response.ok) return [];
  const data = await response.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((item: Json) => item && (item.syncedLyrics || item.plainLyrics || item.instrumental))
    .slice(0, 20)
    .map((item: Json, idx: number) => ({
      id: Number(item.id) || idx + 1,
      trackName: String(item.trackName || 'Unknown'),
      artistName: String(item.artistName || 'Unknown'),
      albumName: item.albumName ? String(item.albumName) : undefined,
      duration: toSeconds(item.duration),
      syncedLyrics: typeof item.syncedLyrics === 'string' ? item.syncedLyrics : undefined,
      plainLyrics: typeof item.plainLyrics === 'string' ? item.plainLyrics : undefined,
      instrumental: Boolean(item.instrumental),
    }));
}

export async function getLyrics(t: Track, forceRefresh = false): Promise<LyricsData | null> {
  if (t.lyrics) return { synced: t.lyrics };
  if (!loadLyricsOverrides()[t.id]) {
    await ensureLyricsOverridesRestored();
  }
  const override = loadLyricsOverrides()[t.id];
  if (override) {
    const overriddenData = lyricsDataFromRecord(override);
    if (overriddenData) return overriddenData;
  }
  if (forceRefresh) lyricsCache.delete(t.id);
  let p = lyricsCache.get(t.id);
  if (!p) {
    p = (t.source === 'soundcloud' ? fetchSoundCloudLyrics(t) : fetchLyrics(t))
      .catch(() => null)
      .then((value) => {
        if (!value) lyricsCache.delete(t.id);
        return value;
      });
    lyricsCache.set(t.id, p);
  }
  return p;
}

async function fetchSoundCloudLyrics(track: Track): Promise<LyricsData | null> {
  const match = track.nativeId?.match(/(\d+)$/);
  const trackId = Number(match?.[1]);
  const durationSec = toSeconds(track.fullDuration ?? track.duration);
  if (!trackId) return fetchLyrics(track);
  const result = await soundCloudTrackLyrics({
    trackId,
    title: track.title,
    artist: track.artist,
    durationMs: Math.round(durationSec * 1000),
  });
  if (result.isSynced && result.lines.length) {
    const synced = withGaps(result.lines.map((line) => ({ t: line.startMs / 1000, text: line.text })));
    if (synced.length) return { synced };
  }
  const plain = result.lines.map((line) => line.text.trim()).filter(Boolean);
  if (plain.length) return { plain };
  return fetchLyrics(track);
}

async function fetchLyrics(t: Track): Promise<LyricsData | null> {
  const durationSec = toSeconds(t.fullDuration ?? t.duration);
  const tolerance = t.source === 'youtube' ? 8 : 4;
  const queries = lyricsSearchQueries(t);
  let rec: LyricsCandidate | null = null;
  for (const query of queries) {
    const params = new URLSearchParams({ track_name: query.title, artist_name: query.artist });
    const results = await getJson(`https://lrclib.net/api/search?${params}`);
    rec = findLyricsCandidate(Array.isArray(results) ? results : [], query, durationSec, tolerance);
    if (rec) break;
  }
  if (!rec) return null;
  return lyricsDataFromRecord(rec);
}
