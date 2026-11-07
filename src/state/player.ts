import { useSyncExternalStore } from 'react';
import Hls from 'hls.js';
import { createStore, persist, clamp, shuffled, useStore } from '../lib/util';
import { getTrack, library, pushRecent, isDisliked, ensureCached, registerTracks } from './library';
import { snack } from './ui';
import { t } from '../lib/i18n';
import { findYouTubeFallback, relatedSoundCloudTracks, searchYouTubeRecommendations, trackStream, ytDlpTrackStream } from '../lib/api';
import { rankRecommendations } from '../lib/recommendations';
import { createPendingAudioSeek, pendingAudioSeekFor, type PendingAudioSeek } from '../lib/pending-audio-seek';
import { onProviderState, providerCommand } from '../lib/provider-player';
import type { Track } from '../types';

export type Repeat = 'off' | 'all' | 'one';

export const audio = new Audio();
audio.preload = 'auto';

export const player = createStore({
  queue: [] as string[],
  index: -1,
  playing: false,
  loading: false,
  duration: 0,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off' as Repeat,
  pos: 0,
});

let original: string[] | null = null;
let pendingSeek: PendingAudioSeek | null = null;
let errors = 0;
let loadId = 0;
let hls: Hls | undefined;
let fallbackAttemptedGeneration = -1;
const relatedFetched = new Set<string>();
const recommendationSource = new Map<string, Track>();
const ytStreamPrefetch = new Map<string, Promise<{ url: string }>>();
const usesProviderPlayback = (track: Track | null | undefined) => !!track && track.source === 'youtube' && track.playback !== 'direct';

const YT_STREAM_PREFETCH_AHEAD = 3;

function prefetchYtStream(id?: string | null) {
  if (!id) return;
  if (ytStreamPrefetch.has(id)) return;
  // Warms the local Go yt-dlp audio cache (download-to-disk). Best-effort.
  const request = ytDlpTrackStream(id)
    .then(async ({ url }) => {
      if (!url) return { url };
      if (url.includes('/yt-audio/') && url.includes('t=')) {
        try {
          await fetch(`${url}&prefetch=1`, { method: 'GET', cache: 'no-store' });
        } catch {
          // Background prefetch; playback path will handle misses.
        }
      }
      return { url };
    })
    .catch(() => ({ url: '' }))
    .finally(() => {
      if (ytStreamPrefetch.get(id) === request) ytStreamPrefetch.delete(id);
    });
  ytStreamPrefetch.set(id, request);
}

function prefetchUpcomingYtStreams(index = player.get().index) {
  const { queue, repeat } = player.get();
  if (!queue.length || index < 0) return;
  let queued = 0;
  for (let offset = 1; offset <= queue.length && queued < YT_STREAM_PREFETCH_AHEAD; offset += 1) {
    let nextIndex = index + offset;
    if (nextIndex >= queue.length) {
      if (repeat === 'off') break;
      nextIndex %= queue.length;
    }
    const track = getTrack(queue[nextIndex]);
    if (!track) continue;
    if (isDisliked(track.id)) continue;
    if (track.source === 'youtube' && track.playback === 'direct' && track.nativeId) {
      prefetchYtStream(track.nativeId);
      queued += 1;
    } else if (track.source === 'youtube' && track.playback === 'direct') {
      queued += 1;
    }
  }
}

export const currentTrack = (): Track | null => {
  const s = player.get();
  const id = s.queue[s.index];
  return id ? getTrack(id) ?? null : null;
};

export function useCurrentTrack(): Track | null {
  const id = useStore(player, (s) => s.queue[s.index] ?? null);
  return useStore(library, () => (id ? getTrack(id) ?? null : null));
}

/* ---------------- time / frame clock ---------------- */
export const dur = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : player.get().duration);
const curTime = () => (audio.src && audio.readyState > 0 ? audio.currentTime : player.get().pos);

const frameSubs = new Set<(t: number, d: number) => void>();
let raf = 0;
function emitFrame() {
  const ct = curTime();
  const d = dur();
  frameSubs.forEach((f) => f(ct, d));
}
function tick() {
  raf = 0;
  emitFrame();
  if (!audio.paused && frameSubs.size) raf = requestAnimationFrame(tick);
}
const kick = () => {
  if (!raf) raf = requestAnimationFrame(tick);
};
/** Per-frame callback while playing (DOM writes only — avoids React re-renders). */
export function onFrame(f: (t: number, d: number) => void) {
  frameSubs.add(f);
  f(curTime(), dur());
  kick();
  return () => {
    frameSubs.delete(f);
  };
}

const timeSubs = new Set<() => void>();
const emitTime = () => timeSubs.forEach((f) => f());
const subTime = (cb: () => void) => {
  timeSubs.add(cb);
  return () => {
    timeSubs.delete(cb);
  };
};
export const useSecond = () => useSyncExternalStore(subTime, () => Math.floor(curTime()));

/* ---------------- media session ---------------- */
function mediaMeta(tr: Track) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: tr.title,
      artist: tr.artist,
      album: tr.album ?? '',
      artwork: tr.cover ? [{ src: tr.cover, sizes: '600x600', type: 'image/jpeg' }] : [],
    });
  } catch {
    /* unsupported */
  }
}

/* ---------------- controls ---------------- */
async function fallbackSoundCloud(track: Track, index: number, generation: number): Promise<boolean> {
  if (generation !== loadId || fallbackAttemptedGeneration === generation) return true;
  fallbackAttemptedGeneration = generation;
  try {
    const fallback = await findYouTubeFallback(track);
    if (generation !== loadId || currentTrack()?.id !== track.id) return true;
    if (!fallback) {
      player.set({ playing: false, loading: false });
      snack(t('soundcloudFallbackNoMatch'));
      return true;
    }
    registerTracks([fallback]);
    if (player.get().shuffle) recommendationSource.set(fallback.id, track);
    const queue = player.get().queue.slice();
    queue[index] = fallback.id;
    player.set({ queue });
    await load(index, true);
  } catch (error) {
    if (generation !== loadId) return true;
    player.set({ playing: false, loading: false });
    const reason = error instanceof Error ? error.message : t('cantPlay');
    snack(t('streamFallbackFailed', { reason }));
  }
  return true;
}

async function load(i: number, autoplay: boolean) {
  const generation = ++loadId;
  const s = player.get();
  const id = s.queue[i];
  const tr = id ? getTrack(id) : undefined;
  if (!tr) return;
  pendingSeek = pendingSeek?.trackId === id ? pendingSeek : null;
  ensureCached(id);
  hls?.destroy();
  hls = undefined;
  player.set({ index: i, duration: tr.duration, loading: true, playing: false, pos: 0 });
  lastSaved = 0;
  try { audio.pause(); } catch {}
  audio.removeAttribute('src');
  try { audio.load(); } catch {}
  prefetchUpcomingYtStreams(i);
  if (usesProviderPlayback(tr)) {
    player.set({ loading: false });
    if (autoplay) providerCommand('play');
    pushRecent(id);
    mediaMeta(tr);
    emitFrame();
    emitTime();
    return;
  }
  try {
    const stream = tr.source === 'soundcloud' && tr.nativeId
      ? await trackStream(tr.nativeId)
      : tr.source === 'youtube' && tr.playback === 'direct' && tr.nativeId
        ? { ...(await ytDlpTrackStream(tr.nativeId)), hls: false, preview: false }
        : { url: tr.src, hls: false, preview: Boolean(tr.preview) };
    if (tr.source === 'soundcloud' && stream.preview) {
      await fallbackSoundCloud(tr, i, generation);
      return;
    }
    if (!stream.url) throw new Error('This provider did not return a playable preview.');
    if (generation !== loadId) return;
    if (stream.hls && !audio.canPlayType('application/vnd.apple.mpegurl')) {
      if (!Hls.isSupported()) throw new Error('This device cannot play the SoundCloud HLS stream.');
      hls = new Hls();
      const instance = hls;
      await new Promise<void>((resolve, reject) => {
        const ready = () => { instance.off(Hls.Events.ERROR, failed); resolve(); };
        const failed = (_event: string, data: { fatal: boolean; details: string }) => {
          if (data.fatal) {
            instance.off(Hls.Events.MANIFEST_PARSED, ready);
            reject(new Error(`SoundCloud HLS failed: ${data.details}`));
          }
        };
        instance.once(Hls.Events.MANIFEST_PARSED, ready);
        instance.on(Hls.Events.ERROR, failed);
        instance.attachMedia(audio);
        instance.loadSource(stream.url);
      });
    } else {
      audio.src = stream.url;
    }
    if (autoplay) {
      try { await audio.play(); } catch { player.set({ loading: false, playing: false }); }
    } else player.set({ loading: false });
  } catch (e) {
    if (generation !== loadId) return;
    if (tr.source === 'soundcloud') {
      await fallbackSoundCloud(tr, i, generation);
      return;
    }
    player.set({ playing: false, loading: false });
    snack(e instanceof Error ? e.message : t('cantPlay'));
    return;
  }
  if (generation !== loadId) return;
  if (tr.source === 'soundcloud') void prefetchRelated(tr);
  if (tr.source === 'youtube' && tr.playback === 'direct') prefetchUpcomingYtStreams(i);
  pushRecent(id);
  mediaMeta(tr);
  emitFrame();
  emitTime();
}

export function playQueue(ids: string[], start = 0, shuffle?: boolean) {
  if (!ids.length) return;
  const sh = shuffle ?? player.get().shuffle;
  let q = ids.slice();
  let idx = clamp(start, 0, q.length - 1);
  if (sh) {
    original = q.slice();
    const first = q[idx];
    q = [first, ...shuffled(q.filter((_, k) => k !== idx))];
    idx = 0;
  } else original = null;
  player.set({ queue: q, shuffle: sh });
  load(idx, true);
}

export const shufflePlay = (ids: string[]) => ids.length && playQueue(ids, Math.floor(Math.random() * ids.length), true);

const relatedRequests = new Map<string, Promise<Track[]>>();

function prefetchRelated(track: Track): Promise<Track[]> {
  if (!track.nativeId || relatedFetched.has(track.id)) return Promise.resolve([]);
  let request = relatedRequests.get(track.id);
  if (!request) {
    const numericId = Number(track.nativeId.match(/(\d+)$/)?.[1]);
    if (track.source === 'soundcloud' && !numericId) return Promise.resolve([]);
    const fetch = track.source === 'soundcloud'
      ? relatedSoundCloudTracks(numericId)
      : searchYouTubeRecommendations(track);
    request = fetch.then((tracks) => {
      relatedFetched.add(track.id);
      return tracks;
    }).catch(() => []).finally(() => relatedRequests.delete(track.id));
    relatedRequests.set(track.id, request);
  }
  return request;
}

async function appendRelatedAndContinue(track: Track) {
  const state = player.get();
  if (!state.shuffle || currentTrack()?.id !== track.id) return;

  const source = recommendationSource.get(track.id) ?? track;
  const libraryState = library.get();
  const known = new Set([
    ...libraryState.liked,
    ...libraryState.recent,
    ...libraryState.playlists.flatMap((playlist) => playlist.ids),
    ...libraryState.soundcloudLiked.map((item) => item.id),
    ...Object.values(libraryState.soundcloudPlaylistTracks).flatMap((items) => items.map((item) => item.id)),
    ...Object.keys(libraryState.cache),
  ]);
  const seedIds = [
    ...player.get().queue.slice(0, player.get().index + 1).reverse(),
    ...libraryState.recent,
    ...libraryState.liked,
    ...libraryState.playlists.flatMap((playlist) => playlist.ids),
    ...libraryState.soundcloudLiked.map((item) => item.id),
  ];
  const seeds = [...new Set([source.id, ...seedIds])]
    .map((id) => getTrack(id))
    .filter((item): item is Track => Boolean(item))
    .slice(0, 5);
  const results = await Promise.allSettled(seeds.map(prefetchRelated));
  if (currentTrack()?.id !== track.id) return;

  const related = [...new Map(results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    .map((item) => [item.id, item])).values()];
  const existing = new Set(player.get().queue);
  const disliked = new Set(library.get().disliked);
  const candidates = shuffled(rankRecommendations(seeds, related, existing, disliked, known)).slice(0, 20);
  if (!candidates.length) {
    player.set({ playing: false, loading: false });
    return;
  }
  registerTracks(candidates);
  const queue = [...player.get().queue, ...candidates.map((candidate) => candidate.id)];
  const nextIndex = queue.length - candidates.length;
  if (original) original.push(...candidates.map((candidate) => candidate.id));
  player.set({ queue });
  load(nextIndex, true);
}

export function toggle() {
  const s = player.get();
  if (s.index < 0 || !s.queue.length) return;
  const track = currentTrack();
  if (usesProviderPlayback(track)) {
    const playing = !s.playing;
    providerCommand(playing ? 'play' : 'pause');
    player.set({ playing, loading: false });
    return;
  }
  if (!audio.src) {
    const keep = s.pos;
    const id = s.queue[s.index];
    load(s.index, true);
    pendingSeek = id ? createPendingAudioSeek(id, keep) : null;
    return;
  }
  if (audio.paused) audio.play().catch(() => player.set({ playing: false }));
  else audio.pause();
}

function step(dir: 1 | -1, auto: boolean) {
  const s = player.get();
  const n = s.queue.length;
  if (!n) return;
  if (auto && s.repeat === 'one') {
    if (usesProviderPlayback(currentTrack())) {
      providerCommand('seek', 0);
      providerCommand('play');
      return;
    }
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  let i = s.index;
  for (let k = 0; k < n; k++) {
    i += dir;
    if (i >= n) {
      if (auto && s.repeat === 'off') {
        const track = currentTrack();
        if (s.shuffle && track && (track.source === 'soundcloud' || track.source === 'youtube' || recommendationSource.has(track.id))) {
          void appendRelatedAndContinue(track);
          return;
        }
        player.set({ playing: false });
        return;
      }
      i = 0;
    }
    if (i < 0) i = n - 1;
    if (!isDisliked(s.queue[i])) break;
  }
  if (isDisliked(s.queue[i])) {
    player.set({ playing: false });
    return;
  }
  load(i, true);
}

export const next = (auto = false) => step(1, auto);
export function prev() {
  if (curTime() > 3) seek(0);
  else step(-1, false);
}
export const jumpTo = (i: number) => load(i, true);

export function seek(sec: number) {
  if (usesProviderPlayback(currentTrack())) {
    pendingSeek = null;
    const position = Math.max(0, sec);
    player.set({ pos: position });
    providerCommand('seek', position);
  } else if (!audio.src || audio.readyState < 1) {
    const position = Math.max(0, sec);
    const id = currentTrack()?.id;
    pendingSeek = id ? createPendingAudioSeek(id, position) : null;
    player.set({ pos: position });
  } else {
    pendingSeek = null;
    audio.currentTime = clamp(sec, 0, dur() || sec);
  }
  emitFrame();
  emitTime();
}
export const seekBy = (d: number) => seek(curTime() + d);

/**
 * Perceptual (cubic) volume curve.
 *
 * `audio.volume` is a linear amplitude, but loudness grows roughly
 * logarithmically, so a linear slider jumps by huge dB amounts near zero
 * and barely moves near full volume — the low end is almost impossible to
 * set precisely. Mapping slider position `p` to gain `p³` (and back with
 * the cube root) spreads the quiet range over most of the track: equal
 * moves of the handle sound like roughly equal loudness steps everywhere.
 * The stored `volume` (linear gain) is unchanged, so old values persist.
 */
export const volumeToPos = (v: number) => Math.cbrt(clamp(v, 0, 1));
export const posToVolume = (p: number) => {
  const c = clamp(p, 0, 1);
  return c * c * c;
};
export function setVolumePos(p: number) {
  setVolume(posToVolume(p));
}
export function adjustVolumePos(d: number) {
  setVolumePos(volumeToPos(player.get().volume) + d);
}

export function setVolume(v: number) {
  // Quantize to 0.1% so a specific value (e.g. exactly 5%) is reachable
  // and cube/cube-root round-trips don't accumulate float noise.
  v = Math.round(clamp(v, 0, 1) * 1000) / 1000;
  audio.volume = v;
  if (usesProviderPlayback(currentTrack())) providerCommand('setVolume', v);
  audio.muted = false;
  player.set({ volume: v, muted: false });
}
export function toggleMute() {
  const m = !player.get().muted;
  if (usesProviderPlayback(currentTrack())) providerCommand('setVolume', m ? 0 : player.get().volume);
  audio.muted = m;
  player.set({ muted: m });
}

export function toggleShuffle() {
  const s = player.get();
  const cur = s.queue[s.index];
  if (!s.shuffle) {
    original = s.queue.slice();
    const rest = shuffled(s.queue.filter((_, k) => k !== s.index));
    player.set({ shuffle: true, queue: cur ? [cur, ...rest] : rest, index: cur ? 0 : -1 });
  } else {
    const q = original ?? s.queue;
    player.set({ shuffle: false, queue: q, index: Math.max(0, q.indexOf(cur)) });
    original = null;
  }
}

export function cycleRepeat() {
  const r = player.get().repeat;
  player.set({ repeat: r === 'off' ? 'all' : r === 'all' ? 'one' : 'off' });
}

export function playNext(id: string) {
  const s = player.get();
  if (s.index < 0) return playQueue([id]);
  const curId = s.queue[s.index];
  const q = s.queue.filter((x) => x !== id || x === curId);
  const ci = q.indexOf(curId);
  q.splice(ci + 1, 0, id);
  if (original && !original.includes(id)) original.push(id);
  player.set({ queue: q, index: ci });
  snack(t('playingNext'));
}

export function addToQueue(id: string) {
  const s = player.get();
  if (s.index < 0) return playQueue([id]);
  if (!s.queue.includes(id)) {
    player.set({ queue: [...s.queue, id] });
    if (original) original.push(id);
  }
  snack(t('addedToQueue'));
}

/* ---------------- audio events ---------------- */
onProviderState((state) => {
  if (state.ended) {
    next(true);
    return;
  }
  player.set({ playing: state.playing, loading: state.loading, pos: state.position, duration: state.duration });
  emitFrame();
  emitTime();
});

audio.addEventListener('play', () => {
  player.set({ playing: true });
  kick();
});
audio.addEventListener('playing', () => {
  player.set({ loading: false });
  errors = 0;
});
audio.addEventListener('pause', () => {
  if (player.get().loading) return;
  player.set({ playing: false, pos: audio.src ? audio.currentTime : 0 });
});
audio.addEventListener('waiting', () => {
  if (audio.src) player.set({ loading: true });
});
audio.addEventListener('canplay', () => player.set({ loading: false }));
audio.addEventListener('ended', () => next(true));
audio.addEventListener('loadedmetadata', () => {
  const track = currentTrack();
  if (track?.source === 'soundcloud' && track.duration > 75 && audio.duration > 0 && audio.duration <= 60 && audio.duration + 10 < track.duration) {
    void fallbackSoundCloud(track, player.get().index, loadId);
    return;
  }
  const seekTo = track ? pendingAudioSeekFor(pendingSeek, track.id) : null;
  if (seekTo !== null) {
    audio.currentTime = Math.min(seekTo, audio.duration || seekTo);
    pendingSeek = null;
  }
  if (isFinite(audio.duration)) player.set({ duration: audio.duration });
  emitFrame();
  emitTime();
});
let lastSaved = 0;
audio.addEventListener('timeupdate', () => {
  const track = currentTrack();
  const duration = dur();
  if (player.get().shuffle && track?.source === 'soundcloud' && duration > 0 && duration - audio.currentTime <= 20) {
    void prefetchRelated(track);
  }
  emitTime();
  if (audio.paused) emitFrame();
  if (Math.abs(audio.currentTime - lastSaved) > 4) {
    lastSaved = audio.currentTime;
    player.set({ pos: audio.currentTime });
  }
});
audio.addEventListener('seeked', () => {
  emitFrame();
  emitTime();
});
audio.addEventListener('error', () => {
  if (!audio.src || !audio.error) return;
  const track = currentTrack();
  const index = player.get().index;
  const generation = loadId;
  if (track?.source === 'soundcloud') {
    void fallbackSoundCloud(track, index, generation);
    return;
  }
  player.set({ loading: false, playing: false });
  snack(t('cantPlay'));
  if (++errors < 3) setTimeout(() => next(true), 900);
});

export function initPlayer() {
  persist('lyra.player.v1', player, (s) => ({
    queue: s.queue, index: s.index, volume: s.volume, muted: s.muted, shuffle: s.shuffle, repeat: s.repeat, pos: s.pos, duration: s.duration,
  }));
  const s = player.get();
  const curId = s.queue[s.index];
  const q = s.queue.filter((id) => getTrack(id));
  const idx = curId ? q.indexOf(curId) : -1;
  player.set({ queue: q, index: idx, playing: false, loading: false, pos: idx >= 0 ? s.pos : 0 });
  audio.volume = s.volume;
  audio.muted = s.muted;
  pendingSeek = idx >= 0 && q[idx] ? createPendingAudioSeek(q[idx], s.pos) : null;
  const cur = currentTrack();
  if (cur) mediaMeta(cur);
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const h: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => toggle()],
      ['pause', () => {
        if (usesProviderPlayback(currentTrack())) {
          providerCommand('pause');
          player.set({ playing: false });
        } else audio.pause();
      }],
      ['previoustrack', () => prev()],
      ['nexttrack', () => next()],
      ['seekbackward', () => seekBy(-10)],
      ['seekforward', () => seekBy(10)],
      ['seekto', (d) => d.seekTime != null && seek(d.seekTime)],
    ];
    for (const [a, fn] of h) {
      try {
        ms.setActionHandler(a, fn);
      } catch {
        /* unsupported action */
      }
    }
  }
  window.addEventListener('pagehide', () => player.set({ pos: curTime() }));
}
