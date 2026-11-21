import type { LyricLine, Track } from '../types';
import { findYouTubeFallbackCandidate, youtubeFallbackQueries } from './youtube-match';
import { youtubeRadioId } from './recommendations';
import { lyricsSearchQueries, speedVariant, stripTrackNoise, toSeconds, type LyricsCandidate } from './lyrics-match';
import { findLyricsMatch, pickBest } from './lyrics-identify';
import { fromWordLines, parseEnhancedWords } from './lyric-words';
import { rpc } from './backend';
import { upscaleYtmArtwork } from './ytmusic-library';

import {
  searchSoundCloudTracks,
  soundCloudTrackLyrics,
  soundCloudRelatedTracks,
  type SoundCloudTrackCard,
  type SoundCloudSearchTrack,
  searchYtDlpTracks,
  ytDlpTrackStream,
  ytRadioTracks,
  type YouTubeTrack,
} from './providers-api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function getJson(url: string): Promise<Json> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

type SoundCloudTrackLike =
  | Pick<SoundCloudTrackCard, 'id' | 'trackUrn' | 'title' | 'permalinkUrl' | 'artworkUrl' | 'duration' | 'user' | 'publisherArtist'>
  | Pick<SoundCloudSearchTrack, 'id' | 'urn' | 'title' | 'permalinkUrl' | 'artworkUrl' | 'duration' | 'user' | 'publisherArtist'>;

export function mapSoundCloudTrack(track: SoundCloudTrackLike): Track {
  const duration = track.duration / 1000;
  const nativeId = ('trackUrn' in track ? track.trackUrn : track.urn) || `soundcloud:tracks:${track.id}`;
  return {
    id: `sc:${track.id}`, title: track.title, artist: track.user?.username || 'SoundCloud',
    cover: track.artworkUrl || undefined, thumb: track.artworkUrl || undefined,
    src: track.permalinkUrl || '', duration, fullDuration: duration || undefined,
    nativeId, source: 'soundcloud',
    ...(track.publisherArtist?.trim() ? { metaArtist: track.publisherArtist.trim() } : {}),
  };
}

export function mapYouTubeTrack(item: YouTubeTrack): Track {
  const duration = item.durationMs / 1000;
  const artwork = upscaleYtmArtwork(item.artworkUrl) || `https://i.ytimg.com/vi/${encodeURIComponent(item.nativeId)}/hqdefault.jpg`;
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

export function trackStream(trackUrn: string, analysis = false): Promise<{ url: string; hls: boolean; preview: boolean }> {
  const key = `${analysis ? 'analysis:' : 'playback:'}${trackUrn}`;
  let request = streamInflight.get(key);
  if (!request) {
    request = rpc<{ url: string; hls?: boolean; preview?: boolean }>('track.stream', { trackUrn, analysis })
      .then((result) => {
        if (!result?.url) throw new Error('SoundCloud did not return an audio stream.');
        return { url: result.url, hls: Boolean(result.hls), preview: Boolean(result.preview) };
      })
      .finally(() => streamInflight.delete(key));
    streamInflight.set(key, request);
  }
  return request;
}


export async function relatedSoundCloudTracks(trackId: number): Promise<Track[]> {
  return (await soundCloudRelatedTracks(trackId)).map(mapSoundCloudTrack);
}

const RECOMMENDATION_MAX_MS = 15 * 60_000;
const NON_SONG_TITLE = /\b(?:mix|reaction|reacts?|playlist|compilation|karaoke|hours?|full album)\b/i;

export async function searchYouTubeRecommendations(track: Track, signal?: AbortSignal): Promise<Track[]> {
  // A recommendation must be based on the selected video, never a text search for its title.
  const nativeId = youtubeRadioId(track);
  if (!nativeId) return [];
  try {
    const radio = await ytRadioTracks(nativeId, signal);
    const seen = new Set<string>();
    return radio
      .filter((item) => item.nativeId !== nativeId)
      .filter((item) => !(item.durationMs > RECOMMENDATION_MAX_MS) && !NON_SONG_TITLE.test(item.title))
      .filter((item) => (seen.has(item.nativeId) ? false : seen.add(item.nativeId)))
      .map(mapYouTubeTrack);
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
}

export { ytDlpTrackStream };

const FALLBACK_MEMO_TTL_MS = 10 * 60_000;
const FALLBACK_MEMO_MAX = 200;
type FallbackEntry = { promise: Promise<Track | null>; controller: AbortController; refs: number };
const fallbackInflight = new Map<string, FallbackEntry>();
const fallbackMemo = new Map<string, { track: Track; expires: number }>();

/** Drops expired memos and keeps the map bounded (insertion order = oldest first). */
function pruneFallbackMemo() {
  const now = Date.now();
  for (const [id, entry] of fallbackMemo) {
    if (entry.expires <= now) fallbackMemo.delete(id);
  }
  for (const id of fallbackMemo.keys()) {
    if (fallbackMemo.size <= FALLBACK_MEMO_MAX) break;
    fallbackMemo.delete(id);
  }
}

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
  if (memo) {
    if (memo.expires > Date.now()) return Promise.resolve(memo.track);
    fallbackMemo.delete(track.id);
  }
  let entry = fallbackInflight.get(track.id);
  if (!entry) {
    const key = track.id;
    const controller = new AbortController();
    const created: FallbackEntry = {
      controller,
      refs: 0,
      promise: runYouTubeFallback(track, controller.signal)
        .then((match) => {
          if (match) {
            pruneFallbackMemo();
            fallbackMemo.set(key, { track: match, expires: Date.now() + FALLBACK_MEMO_TTL_MS });
          }
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
    const body = line.replace(/\[[^\]]*\]/g, '');
    // Enhanced LRC carries <mm:ss.xx> word tags; repeated stamps share one text, so only the first gets words.
    const enhanced = parseEnhancedWords(body);
    stamps.forEach((m, i) => {
      const entry: LyricLine = { t: +m[1] * 60 + +m[2], text: enhanced.text };
      if (enhanced.words && i === 0) entry.words = enhanced.words;
      out.push(entry);
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Stretches synced timestamps for slowed / sped-up copies (scale = playing length / original length). */
export function scaleLyrics(d: LyricsData | null, scale: number): LyricsData | null {
  if (!d?.synced || Math.abs(scale - 1) < 0.005) return d;
  return {
    ...d,
    synced: d.synced.map((l) => ({
      ...l,
      t: l.t * scale,
      ...(l.words ? { words: l.words.map((w) => ({ ...w, t: w.t * scale, d: w.d * scale })) } : {}),
    })),
  };
}

/**
 * Lyrics from YouTube Music (LyricFind / Musixmatch licensed, timed when available).
 * YouTube tracks use their own video id; anything else is first identified in the YouTube Music
 * catalogue by fuzzy title/artist/duration matching, including slowed / sped-up re-uploads whose
 * timestamps are stretched by the duration ratio.
 */
async function fetchYtmLyrics(t: Track): Promise<LyricsData | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  type Res = { synced: { startMs: number; text: string }[]; plain: string[]; source: string };
  const toData = (r: Res | null, timeScale: number): LyricsData | null => {
    if (!r) return null;
    if (r.synced.filter((l) => l.text).length >= 3) {
      return { synced: withGaps(r.synced.map((l) => ({ t: (l.startMs / 1000) * timeScale, text: l.text }))) };
    }
    const plain = r.plain.map((s) => s.trim()).filter(Boolean);
    return plain.length >= 3 ? { plain } : null;
  };
  const speed = speedVariant(t.title);
  const ownId = t.nativeId ?? (t.id.startsWith('yt:') ? t.id.slice(3).split('~')[0] : '');
  if ((t.source === 'youtube' || t.id.startsWith('yt:')) && /^[\w-]{11}$/.test(ownId) && !speed) {
    const own = toData(await invoke<Res>('ytm_lyrics', { videoId: ownId }).catch(() => null), 1);
    if (own) return own;
  }
  const queries = lyricsSearchQueries(t);
  const wantSec = toSeconds(t.fullDuration ?? t.duration);
  const searches = queries.slice(0, 2).map((q) => searchYtDlpTracks(`${q.artist} ${q.title}`).catch(() => [] as YouTubeTrack[]));
  const found = (await Promise.all(searches)).flat().filter((c, i, all) => all.findIndex((x) => x.nativeId === c.nativeId) === i);
  const best = pickBest(
    queries,
    found.map((c) => ({ title: c.title, artist: c.artist, duration: c.durationMs / 1000, id: c.nativeId })),
    wantSec,
    speed,
  );
  if (!best || best.candidate.id === ownId) return null;
  return toData(await invoke<Res>('ytm_lyrics', { videoId: best.candidate.id }).catch(() => null), best.match.timeScale);
}

/** Word-timed lyrics from the backend (NetEase YRC), or null when no trustworthy match exists. */
async function fetchWordLyrics(t: Track): Promise<{ wordLevel: boolean; lines: LyricLine[] } | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const durationMs = Math.round(toSeconds(t.fullDuration ?? t.duration) * 1000);
  // Line lyrics wait for this, so keep it short; a slow lookup just means line timing.
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 3500));
  const res = await Promise.race([
    invoke<{ wordLevel: boolean; lines: { startMs: number; words: { startMs: number; durMs: number; text: string }[] }[] }>('lyrics_word_synced', {
      title: stripTrackNoise(t.title) || t.title,
      artist: (t.metaArtist || t.artist).replace(/\s+-\s+Topic$/i, ''),
      durationMs,
      speed: speedVariant(t.title),
    }).catch(() => null),
    timeout,
  ]);
  const mapped = res ? fromWordLines(res.lines) : [];
  if (mapped.length < 4) return null;
  // Line-only results carry one "word" per line; drop it so they render like normal synced lyrics.
  const lines = res!.wordLevel ? mapped : mapped.map(({ words: _w, ...l }) => l);
  return { wordLevel: res!.wordLevel, lines: withGaps(lines) };
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
  generatedBy?: 'whisper';
}

const MANUAL_LYRICS_STORAGE_KEY = 'resonance.manual_lyrics.v1';
const MAX_LYRICS_CACHE = 200;
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
      const merged = capLyricsOverrides({ ...restored, ...current });
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

function capLyricsOverrides(map: Record<string, ManualLyricsChoice>) {
  const keys = Object.keys(map);
  if (keys.length <= MAX_LYRICS_CACHE) return map;
  // Object keys iterate in insertion order: drop the oldest entries past the cap.
  const trimmed: Record<string, ManualLyricsChoice> = {};
  for (const k of keys.slice(keys.length - MAX_LYRICS_CACHE)) trimmed[k] = map[k];
  return trimmed;
}

function saveLyricsOverrides(map: Record<string, ManualLyricsChoice>) {
  lyricsOverrides = capLyricsOverrides(map);
  try {
    localStorage.setItem(MANUAL_LYRICS_STORAGE_KEY, JSON.stringify(lyricsOverrides));
  } catch {
    // storage is full: the map still works this session but the set did not persist
    console.warn('lyrics overrides could not be saved to localStorage');
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
    evictLyricsCache();
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

export function hasWhisperLyricsChoice(trackId: string): boolean {
  const choice = loadLyricsOverrides()[trackId];
  return Boolean(
    choice?.generatedBy === 'whisper' ||
      (!choice?.generatedBy && choice?.syncedLyrics && /<\d{2}:\d{2}\.\d{2}>/.test(choice.syncedLyrics)),
  );
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

function evictLyricsCache() {
  // Maps iterate in insertion order: drop the oldest entries past the cap.
  while (lyricsCache.size > MAX_LYRICS_CACHE) {
    const oldest = lyricsCache.keys().next().value;
    if (oldest === undefined) break;
    lyricsCache.delete(oldest);
  }
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
  if (forceRefresh) {
    lyricsCache.delete(t.id);
    persistedLyrics.remove(t.id);
  }
  let p = lyricsCache.get(t.id);
  if (!p) {
    const stored = persistedLyrics.get(t.id);
    if (stored) {
      p = Promise.resolve(stored);
      lyricsCache.set(t.id, p);
      evictLyricsCache();
      return p;
    }
  }
  if (!p) {
    const lineLevel = (t.source === 'soundcloud' ? fetchSoundCloudLyrics(t) : fetchLyrics(t)).catch(() => null);
    const wordLevel = fetchWordLyrics(t).catch(() => null);
    const ytm = Promise.race([fetchYtmLyrics(t).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 6000))]);
    // All run in parallel. Priority: karaoke (NetEase YRC) > LRCLIB synced > YouTube Music synced >
    // NetEase line synced > YouTube Music plain > LRCLIB plain.
    p = Promise.all([lineLevel, wordLevel, ytm])
      .then(([lines, ne, ym]): LyricsData | null => {
        if (ne?.wordLevel) return { ...(lines ?? {}), synced: ne.lines, plain: undefined };
        if (lines?.synced?.length) return lines;
        if (ym?.synced?.length) return { ...ym, matchedTitle: lines?.matchedTitle, matchedArtist: lines?.matchedArtist };
        if (ne?.lines.length) return { ...(lines ?? {}), synced: ne.lines, plain: undefined, instrumental: undefined };
        if (ym?.plain?.length) return ym;
        return lines;
      })
      .then((value) => {
        if (!value) lyricsCache.delete(t.id);
        // Only timed lyrics are final. Plain text may be the result of a synced source timing out,
        // so it is kept for this session only and looked up again after a restart.
        else if (value.synced?.length) persistedLyrics.put(t.id, value);
        return value;
      });
    lyricsCache.set(t.id, p);
    evictLyricsCache();
  }
  return p;
}

/**
 * Found lyrics survive restarts so a track is looked up once, not on every play.
 * localStorage, LRU-capped and expiring, so stale or wrong results eventually refresh.
 */
const persistedLyrics = (() => {
  // v2: v1 could hold plain-text results that hid timed lyrics found later.
  const KEY = 'resonance.lyrics_cache.v2';
  try {
    localStorage.removeItem('resonance.lyrics_cache.v1');
  } catch {
    /* ignore */
  }
  const MAX = 400;
  const TTL = 30 * 86400_000;
  type Entry = { at: number; d: LyricsData };
  let map: Record<string, Entry> | null = null;
  const load = () => {
    if (map) return map;
    try {
      map = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Entry>;
    } catch {
      map = {};
    }
    return map;
  };
  let saveTimer = 0;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const m = load();
      const ids = Object.keys(m);
      if (ids.length > MAX) for (const id of ids.sort((a, b) => m[a].at - m[b].at).slice(0, ids.length - MAX)) delete m[id];
      try {
        localStorage.setItem(KEY, JSON.stringify(m));
      } catch {
        // Quota: drop the older half and retry once.
        for (const id of Object.keys(m).sort((a, b) => m[a].at - m[b].at).slice(0, Math.ceil(ids.length / 2))) delete m[id];
        try {
          localStorage.setItem(KEY, JSON.stringify(m));
        } catch {
          /* give up; in-memory cache still works */
        }
      }
    }, 800);
  };
  return {
    get(id: string): LyricsData | null {
      const e = load()[id];
      if (!e) return null;
      if (Date.now() - e.at > TTL) {
        delete load()[id];
        save();
        return null;
      }
      return e.d;
    },
    put(id: string, d: LyricsData) {
      load()[id] = { at: Date.now(), d };
      save();
    },
    remove(id: string) {
      if (load()[id]) {
        delete load()[id];
        save();
      }
    },
  };
})();

async function fetchSoundCloudLyrics(track: Track): Promise<LyricsData | null> {
  const match = track.nativeId?.match(/(\d+)$/);
  const trackId = Number(match?.[1]);
  const durationSec = toSeconds(track.fullDuration ?? track.duration);
  if (!trackId) return fetchLyrics(track);
  const result = await soundCloudTrackLyrics({
    trackId,
    title: track.title,
    artist: track.metaArtist || track.artist,
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
  const queries = lyricsSearchQueries(t);
  const speed = speedVariant(t.title);
  const search = async (params: Record<string, string>): Promise<LyricsCandidate[]> => {
    const results = await getJson(`https://lrclib.net/api/search?${new URLSearchParams(params)}`).catch(() => null);
    return Array.isArray(results) ? (results as LyricsCandidate[]) : [];
  };
  // Fuzzy-scored across every query variant instead of first-strict-hit.
  let pool = (await Promise.all(queries.slice(0, 3).map((q) => search({ track_name: q.title, artist_name: q.artist })))).flat();
  let match = findLyricsMatch(pool, queries, durationSec, speed);
  if (!match && queries[0]) {
    // The artist may be a nickname: search by title alone and let scoring sort it out.
    pool = await search({ q: queries[0].title });
    match = findLyricsMatch(pool, queries, durationSec, speed);
  }
  if (!match) return null;
  return scaleLyrics(lyricsDataFromRecord(match.candidate), match.timeScale);
}
