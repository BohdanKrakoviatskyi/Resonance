import type { LyricLine, Track } from '../types';
import { findYouTubeFallbackCandidate, youtubeFallbackQueries } from './youtube-match';
import {
  detectTempoVariant,
  findLyricsCandidate,
  lyricsSearchQueries,
  resolvePersistentLyricsCacheEntry,
  scaleSyncedLrcTimestamps,
  toSeconds,
  writePersistentLyricsCacheEntry,
  type LyricsCandidate,
  type PersistentLyricsCacheEntry,
} from './lyrics-match';
import { ui } from '../state/ui';
import { rpc } from './sidecar';

import {
  searchSoundCloudTracks,
  soundCloudRelatedTracks,
  type SoundCloudTrackCard,
  type SoundCloudSearchTrack,
  searchYtDlpTracks,
  ytDlpTrackStream,
  type YouTubeTrack,
} from './providers-api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export const LRCLIB_USER_AGENT = 'Resonance/0.4.16 (https://github.com/BohdanKrakoviatskyi/Resonance)';
const LRCLIB_TIMEOUT_MS = 5_000;

async function fetchLrclibJson(url: string, externalSignal?: AbortSignal): Promise<{ ok: boolean; status: number; data: Json | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LRCLIB_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': LRCLIB_USER_AGENT,
      },
    });
    if (response.status === 404) {
      return { ok: true, status: 404, data: null };
    }
    if (!response.ok) {
      throw new Error(`LRCLIB HTTP ${response.status}`);
    }
    const data = (await response.json()) as Json;
    return { ok: true, status: response.status, data };
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
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

export type LyricsProviderSource = 'LRCLIB' | 'Deezer' | 'Кэш' | 'Выбран вручную';

export interface LyricsData {
  synced?: LyricLine[];
  plain?: string[];
  instrumental?: boolean;
  preview?: boolean;
  matchedTitle?: string;
  matchedArtist?: string;
  matchedDurationSec?: number;
  durationDeltaSec?: number;
  sourceLabel?: LyricsProviderSource;
  possibleOffsetWarning?: boolean;
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
const LEGACY_PERSISTENT_LYRICS_CACHE_KEY = 'resonance.lyrics_cache.v1';
const PERSISTENT_LYRICS_CACHE_KEY = 'resonance.lyrics_cache.v2';
const lyricsCache = new Map<string, Promise<LyricsData | null>>();
let lyricsOverrides: Record<string, ManualLyricsChoice> | null = null;
let lyricsOverridesRestored: Promise<void> | null = null;
let persistentLyricsCache: Record<string, PersistentLyricsCacheEntry> | null = null;

try {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(LEGACY_PERSISTENT_LYRICS_CACHE_KEY);
  }
} catch {
  /* ignore storage errors */
}

export function clearAutomaticLyricsCache() {
  lyricsCache.clear();
  persistentLyricsCache = {};
  try {
    localStorage.removeItem(LEGACY_PERSISTENT_LYRICS_CACHE_KEY);
    localStorage.removeItem(PERSISTENT_LYRICS_CACHE_KEY);
  } catch {
    /* ignore storage errors */
  }
}

function loadPersistentLyricsCache(): Record<string, PersistentLyricsCacheEntry> {
  if (persistentLyricsCache) return persistentLyricsCache;
  try {
    const raw = localStorage.getItem(PERSISTENT_LYRICS_CACHE_KEY);
    persistentLyricsCache = raw ? (JSON.parse(raw) as Record<string, PersistentLyricsCacheEntry>) : {};
  } catch {
    persistentLyricsCache = {};
  }
  return persistentLyricsCache;
}

function savePersistentLyricsCache(map: Record<string, PersistentLyricsCacheEntry>) {
  persistentLyricsCache = map;
  try {
    localStorage.setItem(PERSISTENT_LYRICS_CACHE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota errors */
  }
}

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

export function lyricsDataFromRecord(
  rec: LyricsCandidate,
  opts?: {
    playingDurationSec?: number;
    sourceLabel?: LyricsProviderSource;
    possibleOffsetWarning?: boolean;
  },
): LyricsData | null {
  const matchedDurationSec = toSeconds(rec.duration);
  const playingSec = toSeconds(opts?.playingDurationSec);
  const durationDeltaSec =
    playingSec > 0 && matchedDurationSec > 0
      ? Number((playingSec - matchedDurationSec).toFixed(1))
      : 0;
  const meta = {
    matchedTitle: rec.trackName,
    matchedArtist: rec.artistName,
    matchedDurationSec: matchedDurationSec > 0 ? matchedDurationSec : undefined,
    durationDeltaSec,
    sourceLabel: opts?.sourceLabel ?? 'LRCLIB',
    possibleOffsetWarning: opts?.possibleOffsetWarning,
  };
  if (rec.instrumental) {
    return { instrumental: true, ...meta };
  }
  if (rec.syncedLyrics) {
    const synced = withGaps(parseLrc(rec.syncedLyrics));
    if (synced.length) {
      return { synced, ...meta };
    }
  }
  const plainSrc: string = rec.plainLyrics || (rec.syncedLyrics ? String(rec.syncedLyrics).replace(/\[[^\]]*\]/g, '') : '');
  const plain = plainSrc.split('\n').map((s) => s.trim()).filter(Boolean);
  return plain.length ? { plain, ...meta } : null;
}

export function formatLyricsDebugSummary(data: LyricsData, track?: Track | null): string {
  const src = data.sourceLabel ?? 'LRCLIB';
  const type = data.synced?.length ? 'Synced' : data.plain?.length ? 'Plain' : data.instrumental ? 'Instrumental' : 'None';
  const artist = data.matchedArtist || track?.artist || 'Unknown';
  const title = data.matchedTitle || track?.title || 'Unknown';
  const playingSec = track ? toSeconds(track.fullDuration ?? track.duration) : 0;
  const delta =
    typeof data.durationDeltaSec === 'number'
      ? data.durationDeltaSec
      : playingSec > 0 && data.matchedDurationSec
        ? Number((playingSec - data.matchedDurationSec).toFixed(1))
        : 0;
  const sign = delta > 0 ? '+' : '';
  const warn = data.possibleOffsetWarning ? ' · ⚠️ Возможен сдвиг' : '';
  return `[Lyrics] Источник: ${src} · Тип: ${type} · ${artist} — ${title} (Δ ${sign}${delta.toFixed(1)} с)${warn}`;
}

export function setManualLyricsChoice(
  trackId: string,
  choice: ManualLyricsChoice | null,
  playingDurationSec?: number,
): LyricsData | null {
  const overrides = { ...loadLyricsOverrides() };
  if (choice) {
    overrides[trackId] = choice;
    saveLyricsOverrides(overrides);
    const data = lyricsDataFromRecord(choice, {
      playingDurationSec,
      sourceLabel: 'Выбран вручную',
    });
    lyricsCache.set(trackId, Promise.resolve(data));
    if (data) {
      savePersistentLyricsCache(writePersistentLyricsCacheEntry(loadPersistentLyricsCache(), trackId, { status: 'found', data }));
    }
    return data;
  }
  delete overrides[trackId];
  saveLyricsOverrides(overrides);
  lyricsCache.delete(trackId);
  const nextPersistent = { ...loadPersistentLyricsCache() };
  delete nextPersistent[trackId];
  savePersistentLyricsCache(nextPersistent);
  return null;
}

export function hasManualLyricsChoice(trackId: string): boolean {
  return Boolean(loadLyricsOverrides()[trackId]);
}

export async function searchLyricsManual(query: string, signal?: AbortSignal): Promise<ManualLyricsChoice[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ q });
  let data: Json | null = null;
  try {
    const res = await fetchLrclibJson(`https://lrclib.net/api/search?${params}`, signal);
    data = res.data;
  } catch {
    return [];
  }
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
  const durationSec = toSeconds(t.fullDuration ?? t.duration);
  if (t.lyrics) {
    const inlineData: LyricsData = {
      synced: t.lyrics,
      matchedTitle: t.title,
      matchedArtist: t.artist,
      matchedDurationSec: durationSec,
      durationDeltaSec: 0,
      sourceLabel: 'Кэш',
    };
    console.info(formatLyricsDebugSummary(inlineData, t));
    return inlineData;
  }
  if (!loadLyricsOverrides()[t.id]) {
    await ensureLyricsOverridesRestored();
  }
  const override = loadLyricsOverrides()[t.id];
  if (override) {
    const overriddenData = lyricsDataFromRecord(override, {
      playingDurationSec: durationSec,
      sourceLabel: 'Выбран вручную',
    });
    if (overriddenData) {
      console.info(formatLyricsDebugSummary(overriddenData, t));
      return overriddenData;
    }
  }
  if (forceRefresh) {
    lyricsCache.delete(t.id);
  } else {
    const cached = resolvePersistentLyricsCacheEntry(loadPersistentLyricsCache(), t.id, Date.now(), false);
    if (cached.hit) {
      if (!cached.data) return null;
      const cachedData: LyricsData = {
        ...cached.data,
        sourceLabel: 'Кэш',
        durationDeltaSec:
          typeof cached.data.durationDeltaSec === 'number'
            ? cached.data.durationDeltaSec
            : durationSec > 0 && cached.data.matchedDurationSec
              ? Number((durationSec - cached.data.matchedDurationSec).toFixed(1))
              : 0,
      };
      console.info(formatLyricsDebugSummary(cachedData, t));
      return cachedData;
    }
  }
  let p = lyricsCache.get(t.id);
  if (!p) {
    p = fetchLyrics(t).then(
      (value) => {
        const nextCache = writePersistentLyricsCacheEntry(
          loadPersistentLyricsCache(),
          t.id,
          value ? { status: 'found', data: value } : { status: 'not_found' },
        );
        savePersistentLyricsCache(nextCache);
        if (!value) lyricsCache.delete(t.id);
        else console.info(formatLyricsDebugSummary(value, t));
        return value;
      },
      () => {
        lyricsCache.delete(t.id);
        return null;
      },
    );
    lyricsCache.set(t.id, p);
  }
  return p;
}

async function fetchLyrics(t: Track): Promise<LyricsData | null> {
  const durationSec = toSeconds(t.fullDuration ?? t.duration);
  const tolerance = 4;
  const queries = lyricsSearchQueries(t);
  const scaleSlowedLyrics = Boolean(ui.get().scaleSlowedLyrics);
  const matchOpts = { scaleSlowedLyrics, rawTitle: t.title, rawArtist: t.artist };
  let rec: LyricsCandidate | null = null;
  let attempts = 0;
  let networkFailures = 0;
  let lastError: unknown = null;

  for (const query of queries) {
    // 1. Exact lookup via /api/get when track duration is known
    if (durationSec > 0) {
      attempts++;
      try {
        const getParams = new URLSearchParams({
          track_name: query.title,
          artist_name: query.artist,
          duration: String(Math.round(durationSec)),
        });
        const exactRes = await fetchLrclibJson(`https://lrclib.net/api/get?${getParams}`);
        if (exactRes.data && !Array.isArray(exactRes.data)) {
          rec = findLyricsCandidate([exactRes.data as LyricsCandidate], query, durationSec, tolerance, matchOpts);
          if (rec) break;
        }
      } catch (err) {
        networkFailures++;
        lastError = err;
      }
    }

    // 2. Fallback to /api/search with scoring and duration tolerance
    attempts++;
    try {
      const searchParams = new URLSearchParams({ track_name: query.title, artist_name: query.artist });
      const searchRes = await fetchLrclibJson(`https://lrclib.net/api/search?${searchParams}`);
      rec = findLyricsCandidate(
        Array.isArray(searchRes.data) ? (searchRes.data as LyricsCandidate[]) : [],
        query,
        durationSec,
        tolerance,
        matchOpts,
      );
      if (rec) break;
    } catch (err) {
      networkFailures++;
      lastError = err;
    }
  }

  if (!rec && attempts > 0 && networkFailures === attempts) {
    throw lastError ?? new Error('LRCLIB network request failed');
  }
  if (!rec) return null;
  if (
    scaleSlowedLyrics &&
    rec.syncedLyrics &&
    durationSec > 0 &&
    rec.duration &&
    detectTempoVariant(t.title, t.artist)
  ) {
    rec = {
      ...rec,
      syncedLyrics: scaleSyncedLrcTimestamps(rec.syncedLyrics, durationSec, rec.duration, true),
    };
  }
  return lyricsDataFromRecord(rec, {
    playingDurationSec: durationSec,
    sourceLabel: 'LRCLIB',
    possibleOffsetWarning: Boolean(rec.possibleOffsetWarning),
  });
}
