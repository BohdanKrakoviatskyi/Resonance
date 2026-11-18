import { useSyncExternalStore } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { clamp, createStore, persist, shuffled, useStore } from '../lib/util';
import { getTrack, isDisliked, library, pushRecent, registerTracks } from './library';
import { snack } from './ui';
import { t } from '../lib/i18n';
import { relatedSoundCloudTracks, searchYouTubeRecommendations, trackStream, ytDlpTrackStream } from '../lib/api';
import { rankRecommendations } from '../lib/recommendations';
import type { Track } from '../types';

export type Repeat = 'off' | 'all' | 'one';
export type PlayerPlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
export type EqPreset = 'flat' | 'bassBoost' | 'vocal' | 'rock' | 'electronic' | 'custom';
export type LoudnessTarget = 'quiet' | 'normal' | 'loud';
export type CrossfadeCurve = 'linear' | 'equalPower' | 'sCurve';

export const EQ_BANDS = [
  { freq: 60, label: '60Hz', type: 'lowshelf' },
  { freq: 230, label: '230Hz', type: 'peaking' },
  { freq: 910, label: '910Hz', type: 'peaking' },
  { freq: 3600, label: '3.6kHz', type: 'peaking' },
  { freq: 14000, label: '14kHz', type: 'highshelf' },
] as const;

export const EQ_PRESETS: Record<Exclude<EqPreset, 'custom'>, readonly [number, number, number, number, number]> = {
  flat: [0, 0, 0, 0, 0],
  bassBoost: [6.5, 4.0, 0, -1.0, 1.5],
  vocal: [-2.0, -1.0, 4.5, 3.5, 1.0],
  rock: [4.5, 2.0, -1.5, 3.0, 4.5],
  electronic: [5.5, 2.5, -1.0, 2.5, 5.0],
};

interface LocalProxyInfo {
  port: number;
  token: string;
}

interface NativeQueueItemPayload {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  streamUrl: string;
  durationMs: number;
}

interface NativeAudioStateDto {
  playing: boolean;
  buffering: boolean;
  currentIndex: number;
  trackId?: string;
  positionMs: number;
  durationMs: number;
  repeatMode: string;
  shuffleEnabled: boolean;
  error?: string;
}

export const player = createStore({
  queue: [] as string[],
  index: -1,
  state: 'idle' as PlayerPlaybackState,
  playing: false,
  loading: false,
  duration: 0,
  pos: 0,
  volume: 1,
  muted: false,
  shuffle: false,
  repeat: 'off' as Repeat,
  eqEnabled: false,
  eqPreset: 'flat' as EqPreset,
  eqGains: [0, 0, 0, 0, 0] as number[],
  normalizationEnabled: false,
  normalizationTarget: 'normal' as LoudnessTarget,
  crossfadeEnabled: false,
  crossfadeDuration: 4,
  crossfadeCurve: 'equalPower' as CrossfadeCurve,
  errorMsg: '',
});

persist('resonance.mobile.player.v1', player, (s) => ({
  queue: s.queue.slice(0, 200),
  index: s.index,
  shuffle: s.shuffle,
  repeat: s.repeat,
  eqEnabled: s.eqEnabled,
  eqPreset: s.eqPreset,
  eqGains: s.eqGains,
  normalizationEnabled: s.normalizationEnabled,
  normalizationTarget: s.normalizationTarget,
  crossfadeEnabled: s.crossfadeEnabled,
  crossfadeDuration: s.crossfadeDuration,
  crossfadeCurve: s.crossfadeCurve,
}));

const isNativeMobileRuntime = (): boolean =>
  isTauri() && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let cachedProxy: LocalProxyInfo | null = null;
let unshuffledQueue: string[] | null = null;
let radioBusyForId: string | null = null;
let lastRecordedTrackId: string | null = null;
let lastShownError: string | null = null;
let fallbackAudio: HTMLAudioElement | null = null;

/* ---------- Smooth 60/120Hz Playback Clock Interpolation ---------- */

type FrameCallback = (visualTime: number, duration: number, realTime: number) => void;
const frameListeners = new Set<FrameCallback>();
let frameRafId = 0;
let clockAnchorSec = 0;
let clockAnchorPerf = typeof performance !== 'undefined' ? performance.now() : 0;
let clockAdvancing = false;

function syncClockAnchor(posSec: number, advancing: boolean) {
  clockAnchorSec = Math.max(0, posSec);
  clockAnchorPerf = performance.now();
  clockAdvancing = advancing;
  ensureFrameLoop();
}

export function getLivePosition(): number {
  const st = player.get();
  if (fallbackAudio && !isNativeMobileRuntime()) {
    return fallbackAudio.currentTime || st.pos;
  }
  if (!clockAdvancing) return clockAnchorSec;
  const elapsed = Math.max(0, (performance.now() - clockAnchorPerf) / 1000);
  const raw = clockAnchorSec + elapsed;
  return st.duration > 0 ? Math.min(st.duration, raw) : raw;
}

export function dur(): number {
  const st = player.get();
  if (st.duration > 0) return st.duration;
  return currentTrack()?.duration ?? 0;
}

function runFrameLoop() {
  frameRafId = 0;
  if (frameListeners.size === 0 || (typeof document !== 'undefined' && document.hidden)) {
    return;
  }
  const nowPos = getLivePosition();
  const totalDur = dur();
  frameListeners.forEach((cb) => {
    try {
      cb(nowPos, totalDur, nowPos);
    } catch {
      /* ignore listener errors */
    }
  });
  if (frameListeners.size > 0 && (clockAdvancing || player.get().playing)) {
    frameRafId = requestAnimationFrame(runFrameLoop);
  }
}

function ensureFrameLoop() {
  if (frameRafId || frameListeners.size === 0) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  frameRafId = requestAnimationFrame(runFrameLoop);
}

/**
 * Subscribes a high-frequency (60/120Hz rAF) UI animation callback (Lyrics karaoke fill, wavy Seek bar).
 * Automatically idles at 0% CPU when paused or hidden.
 */
export function onFrame(cb: FrameCallback): () => void {
  frameListeners.add(cb);
  const p = getLivePosition();
  cb(p, dur(), p);
  ensureFrameLoop();
  return () => {
    frameListeners.delete(cb);
    if (frameListeners.size === 0 && frameRafId) {
      cancelAnimationFrame(frameRafId);
      frameRafId = 0;
    }
  };
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ensureFrameLoop();
  });
}

/* ---------- Native Proxy & Queue Helpers ---------- */

async function ensureProxyInfo(): Promise<LocalProxyInfo | null> {
  if (cachedProxy) return cachedProxy;
  if (!isTauri()) return null;
  try {
    cachedProxy = await invoke<LocalProxyInfo>('get_local_proxy_info');
    return cachedProxy;
  } catch {
    return null;
  }
}

function extractYtVideoId(track: Track): string | null {
  if (track.nativeId && /^[\w-]{11}$/.test(track.nativeId)) return track.nativeId;
  if (track.id.startsWith('yt:')) {
    const candidate = track.id.slice(3).trim();
    if (/^[\w-]{11}$/.test(candidate)) return candidate;
  }
  return null;
}

function buildLocalStreamUrl(track: Track, proxy: LocalProxyInfo | null): string {
  if (proxy) {
    const ytId = track.source === 'youtube' ? extractYtVideoId(track) : null;
    if (ytId) {
      return `http://127.0.0.1:${proxy.port}/yt-stream/${ytId}?t=${proxy.token}`;
    }
    if (track.source === 'soundcloud' && track.nativeId) {
      return `http://127.0.0.1:${proxy.port}/sc-stream/${encodeURIComponent(track.nativeId)}/index.m3u8?t=${proxy.token}`;
    }
  }
  return track.src;
}

function buildNativeQueuePayload(ids: string[], proxy: LocalProxyInfo | null): NativeQueueItemPayload[] {
  const out: NativeQueueItemPayload[] = [];
  for (const id of ids) {
    const tr = getTrack(id);
    if (!tr) continue;
    const streamUrl = buildLocalStreamUrl(tr, proxy);
    if (!streamUrl) continue;
    out.push({
      id: tr.id,
      title: tr.title,
      artist: tr.artist,
      album: tr.album,
      artworkUrl: tr.cover || tr.thumb,
      streamUrl,
      durationMs: Math.max(0, Math.round((tr.fullDuration ?? tr.duration ?? 0) * 1000)),
    });
  }
  return out;
}

function applyNativeState(dto: NativeAudioStateDto) {
  const cur = player.get();
  let nextIdx = cur.index;
  if (dto.trackId) {
    const found = cur.queue.indexOf(dto.trackId);
    if (found >= 0) nextIdx = found;
  } else if (dto.currentIndex >= 0 && dto.currentIndex < cur.queue.length) {
    nextIdx = dto.currentIndex;
  }

  const activeTrack = nextIdx >= 0 ? getTrack(cur.queue[nextIdx]) : undefined;
  const durSec = dto.durationMs > 0 ? dto.durationMs / 1000 : activeTrack?.duration ?? cur.duration;
  const posSec = dto.positionMs / 1000;
  const advancing = dto.playing && !dto.buffering;

  syncClockAnchor(posSec, advancing);

  const playbackState: PlayerPlaybackState = dto.error
    ? 'error'
    : dto.buffering
      ? 'loading'
      : dto.playing
        ? 'playing'
        : nextIdx >= 0
          ? 'paused'
          : 'idle';

  player.set({
    index: nextIdx,
    playing: dto.playing,
    loading: dto.buffering,
    pos: posSec,
    duration: durSec,
    state: playbackState,
    errorMsg: dto.error ?? '',
  });

  if (dto.error && dto.error !== lastShownError) {
    lastShownError = dto.error;
    snack(dto.error);
  } else if (!dto.error) {
    lastShownError = null;
  }

  if (activeTrack && activeTrack.id !== lastRecordedTrackId) {
    lastRecordedTrackId = activeTrack.id;
    pushRecent(activeTrack.id);
    void maybeExtendRadioQueue(activeTrack);
  }
}

async function maybeExtendRadioQueue(seed: Track) {
  const st = player.get();
  if (st.queue.length === 0 || st.queue.length - st.index > 2) return;
  if (radioBusyForId === seed.id) return;
  radioBusyForId = seed.id;
  try {
    let candidates: Track[] = [];
    if (seed.source === 'soundcloud' && seed.id.startsWith('sc:')) {
      const numId = Number(seed.id.slice(3));
      if (numId > 0) candidates = await relatedSoundCloudTracks(numId);
    } else {
      candidates = await searchYouTubeRecommendations(seed);
    }
    const existing = new Set(player.get().queue);
    const ranked = rankRecommendations(seed, candidates)
      .filter((tr) => !existing.has(tr.id) && !isDisliked(tr.id))
      .slice(0, 12);
    if (ranked.length === 0) return;
    registerTracks(ranked);
    const cur = player.get();
    const updatedQueue = [...cur.queue, ...ranked.map((r) => r.id)];
    player.set({ queue: updatedQueue });
    if (isNativeMobileRuntime()) {
      const proxy = await ensureProxyInfo();
      const items = buildNativeQueuePayload(updatedQueue, proxy);
      const latest = player.get();
      await invoke<NativeAudioStateDto>('mobile_audio_set_queue', {
        req: {
          items,
          startIndex: Math.max(0, latest.index),
          autoPlay: latest.playing,
          startPositionMs: Math.max(0, Math.round(latest.pos * 1000)),
        },
      });
    }
  } catch {
    /* recommendation extension is best-effort */
  } finally {
    if (radioBusyForId === seed.id) radioBusyForId = null;
  }
}

/* ---------- Browser fallback audio for desktop Vite preview ---------- */

function applyBrowserFallbackVolume() {
  if (!fallbackAudio) return;
  const { normalizationEnabled, normalizationTarget, muted, volume } = player.get();
  if (muted) {
    fallbackAudio.volume = 0;
    return;
  }
  const normScale = !normalizationEnabled
    ? 1
    : normalizationTarget === 'quiet'
      ? 0.65
      : normalizationTarget === 'loud'
        ? 1
        : 0.88;
  fallbackAudio.volume = clamp(volume * normScale, 0, 1);
}

async function playBrowserFallback(tr: Track, autoPlay: boolean) {
  if (!fallbackAudio) {
    fallbackAudio = new Audio();
    fallbackAudio.addEventListener('timeupdate', () => {
      if (!fallbackAudio) return;
      const pos = fallbackAudio.currentTime || 0;
      syncClockAnchor(pos, !fallbackAudio.paused);
      player.set({
        pos,
        duration: Number.isFinite(fallbackAudio.duration) && fallbackAudio.duration > 0 ? fallbackAudio.duration : tr.duration,
      });
    });
    fallbackAudio.addEventListener('playing', () => {
      syncClockAnchor(fallbackAudio?.currentTime || 0, true);
      player.set({ playing: true, loading: false, state: 'playing' });
    });
    fallbackAudio.addEventListener('pause', () => {
      syncClockAnchor(fallbackAudio?.currentTime || 0, false);
      player.set({ playing: false, loading: false, state: 'paused' });
    });
    fallbackAudio.addEventListener('ended', () => void next());
  }
  applyBrowserFallbackVolume();
  syncClockAnchor(0, false);
  player.set({ loading: true, state: 'loading', duration: tr.duration, pos: 0 });
  try {
    let url = tr.src;
    if (isTauri()) {
      const ytId = extractYtVideoId(tr);
      if (tr.source === 'youtube' && ytId) {
        const r = await ytDlpTrackStream(ytId);
        url = r.url;
      } else if (tr.source === 'soundcloud' && tr.nativeId) {
        const r = await trackStream(tr.nativeId);
        url = r.url;
      }
    }
    fallbackAudio.src = url;
    if (autoPlay) await fallbackAudio.play();
  } catch (e) {
    player.set({ playing: false, loading: false, state: 'error' });
    snack(e instanceof Error ? e.message : t('cantPlay'));
  }
}

/* ---------- Public Player API ---------- */

export function currentTrack(): Track | undefined {
  const { queue, index } = player.get();
  return index >= 0 && index < queue.length ? getTrack(queue[index]) : undefined;
}

export function useCurrentTrack(): Track | undefined {
  const id = useStore(player, (s) => (s.index >= 0 && s.index < s.queue.length ? s.queue[s.index] : undefined));
  return useStore(library, () => (id ? getTrack(id) : undefined));
}

export function useSecond(): number {
  return useSyncExternalStore(
    player.subscribe,
    () => Math.floor(player.get().pos),
    () => Math.floor(player.get().pos),
  );
}

export async function playQueue(tracksOrIds: (Track | string)[], startIndex = 0, autoPlay = true) {
  const tracks: Track[] = [];
  const ids: string[] = [];
  for (const item of tracksOrIds) {
    if (typeof item === 'string') {
      const tr = getTrack(item);
      if (tr) {
        tracks.push(tr);
        ids.push(tr.id);
      }
    } else if (item) {
      tracks.push(item);
      ids.push(item.id);
    }
  }
  if (ids.length === 0) return;
  registerTracks(tracks);

  const safeStart = clamp(startIndex, 0, ids.length - 1);
  let activeQueue = ids;
  let activeIndex = safeStart;
  if (player.get().shuffle && ids.length > 1) {
    unshuffledQueue = ids.slice();
    const picked = ids[safeStart];
    const rest = shuffled(ids.filter((_, idx) => idx !== safeStart));
    activeQueue = [picked, ...rest];
    activeIndex = 0;
  } else {
    unshuffledQueue = null;
  }

  const targetTrack = getTrack(activeQueue[activeIndex]);
  syncClockAnchor(0, false);
  player.set({
    queue: activeQueue,
    index: activeIndex,
    playing: autoPlay,
    loading: autoPlay,
    pos: 0,
    duration: targetTrack?.duration ?? 0,
    state: autoPlay ? 'loading' : 'paused',
    errorMsg: '',
  });

  if (targetTrack) {
    lastRecordedTrackId = targetTrack.id;
    pushRecent(targetTrack.id);
  }

  if (isNativeMobileRuntime()) {
    try {
      const proxy = await ensureProxyInfo();
      const items = buildNativeQueuePayload(activeQueue, proxy);
      const dto = await invoke<NativeAudioStateDto>('mobile_audio_set_queue', {
        req: {
          items,
          startIndex: activeIndex,
          autoPlay,
          startPositionMs: 0,
        },
      });
      applyNativeState(dto);
      if (targetTrack && activeQueue.length <= 2) {
        void maybeExtendRadioQueue(targetTrack);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      player.set({ playing: false, loading: false, state: 'error', errorMsg: msg });
      snack(msg);
    }
  } else if (targetTrack) {
    await playBrowserFallback(targetTrack, autoPlay);
  }
}

export async function playTrack(track: Track, contextTracks?: Track[]) {
  if (contextTracks && contextTracks.length > 0) {
    const idx = contextTracks.findIndex((c) => c.id === track.id);
    await playQueue(contextTracks, idx >= 0 ? idx : 0, true);
  } else {
    await playQueue([track], 0, true);
  }
}

export async function playNextInQueue(track: Track) {
  registerTracks([track]);
  const cur = player.get();
  if (cur.queue.length === 0 || cur.index < 0) {
    await playQueue([track], 0, true);
    return;
  }
  const nextQueue = cur.queue.slice();
  nextQueue.splice(cur.index + 1, 0, track.id);
  player.set({ queue: nextQueue });
  snack(`${t('playNext')}: ${track.title}`);
  if (isNativeMobileRuntime()) {
    const proxy = await ensureProxyInfo();
    const items = buildNativeQueuePayload(nextQueue, proxy);
    await invoke<NativeAudioStateDto>('mobile_audio_set_queue', {
      req: {
        items,
        startIndex: cur.index,
        autoPlay: cur.playing,
        startPositionMs: Math.max(0, Math.round(cur.pos * 1000)),
      },
    }).catch(() => {});
  }
}

export async function addToQueue(track: Track) {
  registerTracks([track]);
  const cur = player.get();
  if (cur.queue.length === 0 || cur.index < 0) {
    await playQueue([track], 0, true);
    return;
  }
  const nextQueue = [...cur.queue, track.id];
  player.set({ queue: nextQueue });
  snack(`${t('addToQueue')}: ${track.title}`);
  if (isNativeMobileRuntime()) {
    const proxy = await ensureProxyInfo();
    const items = buildNativeQueuePayload(nextQueue, proxy);
    await invoke<NativeAudioStateDto>('mobile_audio_set_queue', {
      req: {
        items,
        startIndex: cur.index,
        autoPlay: cur.playing,
        startPositionMs: Math.max(0, Math.round(cur.pos * 1000)),
      },
    }).catch(() => {});
  }
}

export async function skipToIndex(index: number) {
  const cur = player.get();
  if (index < 0 || index >= cur.queue.length) return;
  const tr = getTrack(cur.queue[index]);
  syncClockAnchor(0, false);
  player.set({ index, pos: 0, duration: tr?.duration ?? 0, loading: true });
  if (isNativeMobileRuntime()) {
    const dto = await invoke<NativeAudioStateDto>('mobile_audio_skip_to', { index, autoPlay: true });
    applyNativeState(dto);
  } else if (tr) {
    await playBrowserFallback(tr, true);
  }
}

export const jumpTo = skipToIndex;

export async function play() {
  const cur = player.get();
  if (cur.queue.length === 0) return;
  if (isNativeMobileRuntime()) {
    const dto = await invoke<NativeAudioStateDto>('mobile_audio_play');
    applyNativeState(dto);
  } else if (fallbackAudio) {
    await fallbackAudio.play().catch(() => {});
  } else {
    const tr = currentTrack();
    if (tr) await playBrowserFallback(tr, true);
  }
}

export async function pause() {
  if (isNativeMobileRuntime()) {
    const dto = await invoke<NativeAudioStateDto>('mobile_audio_pause');
    applyNativeState(dto);
  } else {
    fallbackAudio?.pause();
    syncClockAnchor(fallbackAudio?.currentTime || player.get().pos, false);
    player.set({ playing: false, state: 'paused' });
  }
}

export function toggle() {
  if (player.get().playing) void pause();
  else void play();
}

export async function seek(seconds: number) {
  const clamped = Math.max(0, seconds);
  syncClockAnchor(clamped, player.get().playing && !player.get().loading);
  player.set({ pos: clamped });
  if (isNativeMobileRuntime()) {
    const dto = await invoke<NativeAudioStateDto>('mobile_audio_seek', {
      positionMs: Math.round(clamped * 1000),
    });
    applyNativeState(dto);
  } else if (fallbackAudio) {
    fallbackAudio.currentTime = clamped;
  }
}

export function seekBy(deltaSec: number) {
  void seek(getLivePosition() + deltaSec);
}

export async function next() {
  const cur = player.get();
  if (cur.queue.length === 0) return;
  if (isNativeMobileRuntime()) {
    const dto = await invoke<NativeAudioStateDto>('mobile_audio_next');
    applyNativeState(dto);
  } else {
    const nx = cur.index + 1 < cur.queue.length ? cur.index + 1 : cur.repeat === 'all' ? 0 : -1;
    if (nx >= 0) await skipToIndex(nx);
  }
}

export async function prev() {
  const cur = player.get();
  if (cur.queue.length === 0) return;
  if (isNativeMobileRuntime()) {
    const dto = await invoke<NativeAudioStateDto>('mobile_audio_prev');
    applyNativeState(dto);
  } else {
    if (cur.pos > 3.5) {
      await seek(0);
    } else if (cur.index > 0) {
      await skipToIndex(cur.index - 1);
    } else {
      await seek(0);
    }
  }
}

export async function toggleShuffle() {
  const cur = player.get();
  const nextShuffle = !cur.shuffle;
  player.set({ shuffle: nextShuffle });
  if (cur.queue.length > 1 && cur.index >= 0) {
    const activeId = cur.queue[cur.index];
    if (nextShuffle) {
      unshuffledQueue = cur.queue.slice();
      const rest = shuffled(cur.queue.filter((id) => id !== activeId));
      player.set({ queue: [activeId, ...rest], index: 0 });
    } else if (unshuffledQueue) {
      const restoredIdx = Math.max(0, unshuffledQueue.indexOf(activeId));
      player.set({ queue: unshuffledQueue, index: restoredIdx });
      unshuffledQueue = null;
    }
  }
  if (isNativeMobileRuntime()) {
    const updated = player.get();
    await invoke<NativeAudioStateDto>('mobile_audio_set_repeat_shuffle', {
      repeatMode: updated.repeat,
      shuffleEnabled: updated.shuffle,
    }).catch(() => {});
  }
}

export async function cycleRepeat() {
  const cur = player.get().repeat;
  const nextRepeat: Repeat = cur === 'off' ? 'all' : cur === 'all' ? 'one' : 'off';
  player.set({ repeat: nextRepeat });
  if (isNativeMobileRuntime()) {
    await invoke<NativeAudioStateDto>('mobile_audio_set_repeat_shuffle', {
      repeatMode: nextRepeat,
      shuffleEnabled: player.get().shuffle,
    }).catch(() => {});
  }
}

/* ---------- Equalizer, Normalization & Crossfade Sync ---------- */

async function syncEqToNative() {
  if (!isTauri()) return;
  const { eqEnabled, eqGains } = player.get();
  await invoke('mobile_audio_set_eq', {
    enabled: eqEnabled,
    gainsDb: eqGains,
  }).catch(() => {});
}

async function syncAudioConfigToNative() {
  applyBrowserFallbackVolume();
  if (!isTauri()) return;
  const {
    normalizationEnabled,
    normalizationTarget,
    crossfadeEnabled,
    crossfadeDuration,
    crossfadeCurve,
  } = player.get();
  await invoke('mobile_audio_set_config', {
    normalizationEnabled,
    normalizationTarget,
    crossfadeEnabled,
    crossfadeDurationMs: Math.round(clamp(crossfadeDuration, 0, 12) * 1000),
    crossfadeCurve,
  }).catch(() => {});
}

export function setEqEnabled(enabled: boolean) {
  player.set({ eqEnabled: enabled });
  void syncEqToNative();
}

export function setEqPreset(preset: EqPreset) {
  if (preset === 'custom') {
    player.set({ eqPreset: 'custom', eqEnabled: true });
  } else {
    player.set({
      eqPreset: preset,
      eqGains: [...EQ_PRESETS[preset]],
      eqEnabled: preset !== 'flat',
    });
  }
  void syncEqToNative();
}

export function setEqBandGain(bandIdx: number, db: number) {
  const gains = player.get().eqGains.slice();
  gains[bandIdx] = clamp(Math.round(db * 2) / 2, -12, 12);
  player.set({ eqPreset: 'custom', eqGains: gains, eqEnabled: true });
  void syncEqToNative();
}

export function setNormalizationEnabled(enabled: boolean) {
  player.set({ normalizationEnabled: enabled });
  void syncAudioConfigToNative();
}

export function setNormalizationTarget(target: LoudnessTarget) {
  player.set({ normalizationTarget: target });
  void syncAudioConfigToNative();
}

export function setCrossfadeEnabled(enabled: boolean) {
  const cur = player.get();
  player.set({
    crossfadeEnabled: enabled,
    crossfadeDuration: enabled && cur.crossfadeDuration <= 0 ? 4 : cur.crossfadeDuration,
  });
  void syncAudioConfigToNative();
}

export function setCrossfadeDuration(seconds: number) {
  if (seconds <= 0) {
    player.set({ crossfadeEnabled: false });
  } else {
    player.set({
      crossfadeEnabled: true,
      crossfadeDuration: clamp(Math.round(seconds * 2) / 2, 1, 12),
    });
  }
  void syncAudioConfigToNative();
}

export function setCrossfadeCurve(curve: CrossfadeCurve) {
  player.set({ crossfadeCurve: curve });
  void syncAudioConfigToNative();
}

let pollTimer: number | null = null;

function startStatePolling() {
  if (!isNativeMobileRuntime()) return;
  const pollOnce = () => {
    if (document.hidden) return;
    void invoke<NativeAudioStateDto>('mobile_audio_get_state')
      .then((dto) => {
        if (dto.currentIndex >= 0 || player.get().playing) {
          applyNativeState(dto);
        }
      })
      .catch(() => {});
  };
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(pollOnce, 450);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollOnce();
  });
  pollOnce();
}

export function initPlayer() {
  void ensureProxyInfo();
  void syncEqToNative();
  void syncAudioConfigToNative();
  if (isNativeMobileRuntime()) {
    const st = player.get();
    void invoke('mobile_audio_set_repeat_shuffle', {
      repeatMode: st.repeat,
      shuffleEnabled: st.shuffle,
    }).catch(() => {});
    startStatePolling();
  }
}
