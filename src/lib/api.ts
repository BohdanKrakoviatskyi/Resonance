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
  type YouTubeTrack,
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

export function mapYouTubeTrack(item: YouTubeTrack): Track {
  const duration = item.durationMs / 1000;
  const artwork = item.artworkUrl || `https://i.ytimg.com/vi/${encodeURIComponent(item.nativeId)}/hqdefault.jpg`;
  return {
    id: `yt:${item.nativeId}`, title: item.title, artist: item.artist,
    cover: artwork, thumb: artwork,
    src: item.permalink || `https://music.youtube.com/watch?v=${encodeURIComponent(item.nativeId)}`,
    duration, fullDuration: duration || undefined, nativeId: item.nativeId, playback: 'direct', source: 'youtube',
  };
}

function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

export async function searchTracks(query: string, signal?: AbortSignal): Promise<Track[]> {
  const results = await Promise.allSettled([
    searchSoundCloudTracks(query, signal),
    searchYtDlpTracks(query, signal),
  ]);
  const [soundcloud, youtube] = results;
  const scTracks = soundcloud.status === 'fulfilled' ? soundcloud.value.map(mapSoundCloudTrack) : [];
  const ytTracks = youtube.status === 'fulfilled' ? youtube.value.map(mapYouTubeTrack) : [];
  const tracks = interleave(scTracks, ytTracks);
  if (tracks.length) return tracks;
  const firstError = results.find((result) => result.status === 'rejected');
  if (firstError?.status === 'rejected') throw firstError.reason;
  return [];
}


const streamInflight = new Map<string, Promise<{ url: string; hls: boolean; preview: boolean }>>();

export function trackStream(trackUrn: string): Promise<{ url: string; hls: boolean; preview: boolean }> {
  let request = streamInflight.get(trackUrn);
  if (!request) {
    request = rpc<{ url: string; hls?: boolean; preview?: boolean }>('track.stream', { trackUrn })
      .then((result) => {
        if (!result?.url) throw new Error('SoundCloud did not return an audio stream.');
        return { url: result.url, hls: Boolean(result.hls), preview: Boolean(result.preview) };
      })
      .finally(() => streamInflight.delete(trackUrn));
    streamInflight.set(trackUrn, request);
  }
  return request;
}

export async function relatedSoundCloudTracks(trackId: number): Promise<Track[]> {
  return (await soundCloudRelatedTracks(trackId)).map(mapSoundCloudTrack);
}

const RECOMMENDATION_MAX_MS = 15 * 60_000;
const NON_SONG_TITLE = /\b(?:mix|reaction|reacts?|playlist|compilation|karaoke|hours?|full album)\b/i;

export async function searchYouTubeRecommendations(track: Track, signal?: AbortSignal): Promise<Track[]> {
  const query = track.artist ? `${track.artist} official audio` : track.title;
  const results = await searchYtDlpTracks(query, signal);
  const seen = new Set<string>();
  return results
    .filter((item) => item.nativeId !== track.nativeId && `yt:${item.nativeId}` !== track.id)
    .filter((item) => !(item.durationMs > RECOMMENDATION_MAX_MS) && !NON_SONG_TITLE.test(item.title))
    .filter((item) => (seen.has(item.nativeId) ? false : seen.add(item.nativeId)))
    .map(mapYouTubeTrack);
}

export { ytDlpTrackStream };

const FALLBACK_MEMO_TTL_MS = 10 * 60_000;
type FallbackEntry = { promise: Promise<Track | null>; controller: AbortController; refs: number };
const fallbackInflight = new Map<string, FallbackEntry>();
const fallbackMemo = new Map<string, { track: Track; expires: number }>();

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

async function searchFallbackRound(track: Track, query: string, signal: AbortSignal) {
  const [yt, sc] = await Promise.allSettled([searchYtDlpTracks(query, signal), searchSoundCloudTracks(query, signal)]);
  return {
    yt: yt.status === 'fulfilled'
      ? yt.value.filter((c) => `yt:${c.nativeId}` !== track.id && c.nativeId !== track.nativeId)
      : [],
    sc: sc.status === 'fulfilled'
      ? sc.value
        .filter((c) => c.duration > 60_000 && `sc:${c.id}` !== track.id && c.urn !== track.nativeId)
        .map((c) => ({ ...c, artist: c.user?.username || 'SoundCloud', durationMs: c.duration }))
      : [],
  };
}

async function runYouTubeFallback(track: Track, signal: AbortSignal): Promise<Track | null> {
  const seed = { ...track, duration: track.fullDuration ?? track.duration };
  const [primary, ...rest] = youtubeFallbackQueries(seed);
  if (!primary) return null;
  const pick = (round: Awaited<ReturnType<typeof searchFallbackRound>>): Track | null => {
    const yt = findYouTubeFallbackCandidate(seed, round.yt);
    if (yt) return mapYouTubeTrack(yt);
    const sc = findYouTubeFallbackCandidate(seed, round.sc);
    return sc ? mapSoundCloudTrack(sc) : null;
  };
  const first = pick(await searchFallbackRound(track, primary, signal));
  if (signal.aborted) throw abortError();
  if (first || !rest.length) return first;
  const rounds = await Promise.all(rest.map((query) => searchFallbackRound(track, query, signal)));
  if (signal.aborted) throw abortError();
  for (const round of rounds) {
    const match = pick(round);
    if (match) return match;
  }
  return null;
}

export function findYouTubeFallback(track: Track, signal?: AbortSignal): Promise<Track | null> {
  if (signal?.aborted) return Promise.reject(abortError());
  const memo = fallbackMemo.get(track.id);
  if (memo && memo.expires > Date.now()) return Promise.resolve(memo.track);
  let entry = fallbackInflight.get(track.id);
  if (!entry) {
    const key = track.id;
    const controller = new AbortController();
    const created: FallbackEntry = {
      controller,
      refs: 0,
      promise: runYouTubeFallback(track, controller.signal)
        .then((match) => {
          if (match) fallbackMemo.set(key, { track: match, expires: Date.now() + FALLBACK_MEMO_TTL_MS });
          return match;
        })
        .finally(() => {
          if (fallbackInflight.get(key) === created) fallbackInflight.delete(key);
        }),
    };
    entry = created;
    fallbackInflight.set(key, entry);
  }
  const shared = entry;
  shared.refs++;
  return new Promise<Track | null>((resolve, reject) => {
    const onAbort = () => {
      shared.refs--;
      if (shared.refs === 0) {
        shared.controller.abort();
        if (fallbackInflight.get(track.id) === shared) fallbackInflight.delete(track.id);
      }
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
  });
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
