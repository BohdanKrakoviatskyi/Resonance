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

export const DEFAULT_CROSSFADE_DURATION = 4;
const MANUAL_CROSSFADE_SECONDS = 0.8;
const PRELOAD_AHEAD_SECONDS = 14;

type DeckId = 0 | 1;
interface Deck {
  readonly id: DeckId;
  readonly el: HTMLAudioElement;
  hls?: Hls;
  fadeMultiplier: number;
  trackId: string | null;
  queueIndex: number;
  preloadedForLoadId?: number;
}

const decks: [Deck, Deck] = [
  { id: 0, el: new Audio(), fadeMultiplier: 1, trackId: null, queueIndex: -1 },
  { id: 1, el: new Audio(), fadeMultiplier: 0, trackId: null, queueIndex: -1 },
];
decks[0].el.preload = 'auto';
decks[1].el.preload = 'auto';
decks[0].el.loop = false;
decks[1].el.loop = false;

let activeDeckIdx: DeckId = 0;
export let audio: HTMLAudioElement = decks[0].el;

export const getActiveDeck = (): Deck => decks[activeDeckIdx];
const getInactiveDeck = (): Deck => decks[activeDeckIdx === 0 ? 1 : 0];

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
  crossfadeDuration: DEFAULT_CROSSFADE_DURATION,
  isCrossfading: false,
  fadeProgress: 0,
});

interface CrossfadeSession {
  id: number;
  fromDeck: Deck;
  toDeck: Deck;
  durationSec: number;
  elapsedSec: number;
  lastTs: number | null;
  rafId: number;
  paused: boolean;
  kind: 'auto' | 'manual';
  /** Visual progress ratio (0..1) of the outgoing bar at the exact moment crossfade began. */
  startFadeFraction: number;
  /** Target visual progress ratio (0..1) when fadeProgress reaches 1 (matches new track's elapsed position). */
  endFadeFraction: number;
}

let crossfadeSession: CrossfadeSession | null = null;
let crossfadeEpoch = 0;
let autoCrossfadePreparingForLoadId = -1;
let preloadingNextForLoadId = -1;

let original: string[] | null = null;
let pendingSeek: PendingAudioSeek | null = null;
let errors = 0;
let loadId = 0;
let fallbackAttemptedGeneration = -1;
const relatedFetched = new Set<string>();
const recommendationSource = new Map<string, Track>();
const ytStreamPrefetch = new Map<string, Promise<{ url: string }>>();
const usesProviderPlayback = (track: Track | null | undefined) => !!track && track.source === 'youtube' && track.playback !== 'direct';

const YT_STREAM_PREFETCH_AHEAD = 3;

/* ---------------- S-Curve + Equal-Power math ---------------- */
/** Smooth S-curve (`easeInOutSine`) mapping 0..1 -> 0..1 with zero-slope endpoints. */
export const easeInOutSine = (x: number): number => {
  const c = clamp(x, 0, 1);
  return -(Math.cos(Math.PI * c) - 1) / 2;
};

/* ---------------- volume & equal-power crossfade ---------------- */
function syncDeckVolumes() {
  const { volume, muted } = player.get();
  const master = clamp(volume, 0, 1);
  for (const deck of decks) {
    deck.el.muted = muted;
    deck.el.volume = clamp(master * clamp(deck.fadeMultiplier, 0, 1), 0, 1);
  }
}

function stopAndResetDeck(deck: Deck) {
  if (deck.hls) {
    try {
      deck.hls.destroy();
    } catch {
      /* ignore */
    }
    deck.hls = undefined;
  }
  try {
    deck.el.pause();
  } catch {
    /* ignore */
  }
  try {
    deck.el.currentTime = 0;
  } catch {
    /* ignore */
  }
  deck.el.removeAttribute('src');
  try {
    deck.el.load();
  } catch {
    /* ignore */
  }
  deck.fadeMultiplier = 0;
  deck.trackId = null;
  deck.queueIndex = -1;
  deck.preloadedForLoadId = undefined;
  syncDeckVolumes();
}

/**
 * Cancels any in-flight or active crossfade immediately.
 * Stops and unloads the outgoing/inactive deck and restores the active deck to 100% master volume.
 */
export function cancelCrossfade(stopOutgoing = true) {
  crossfadeEpoch += 1;
  autoCrossfadePreparingForLoadId = -1;
  preloadingNextForLoadId = -1;
  if (crossfadeSession) {
    if (crossfadeSession.rafId) {
      cancelAnimationFrame(crossfadeSession.rafId);
    }
    const { fromDeck } = crossfadeSession;
    crossfadeSession = null;
    if (stopOutgoing && fromDeck !== getActiveDeck()) {
      stopAndResetDeck(fromDeck);
    }
  }
  const active = getActiveDeck();
  const inactive = getInactiveDeck();
  active.fadeMultiplier = 1;
  if (stopOutgoing) {
    stopAndResetDeck(inactive);
  } else {
    inactive.fadeMultiplier = 0;
  }
  syncDeckVolumes();
  if (player.get().isCrossfading || player.get().fadeProgress !== 0) {
    player.set({ isCrossfading: false, fadeProgress: 0 });
  }
}

function applyEqualPowerGains(fromDeck: Deck, toDeck: Deck, progress: number) {
  // Smooth S-curve shaping fed into Equal-Power (cos/sin) so start/end are imperceptible and midpoint has 0 dB dip
  const shaped = easeInOutSine(progress);
  const angle = shaped * 0.5 * Math.PI;
  fromDeck.fadeMultiplier = Math.cos(angle);
  toDeck.fadeMultiplier = Math.sin(angle);
  syncDeckVolumes();
}

function stepCrossfadeFrame(now: number) {
  const session = crossfadeSession;
  if (!session || session.paused) return;
  if (session.lastTs !== null) {
    const dt = Math.max(0, (now - session.lastTs) / 1000);
    session.elapsedSec += dt;
  }
  session.lastTs = now;

  const progress = session.durationSec > 0 ? clamp(session.elapsedSec / session.durationSec, 0, 1) : 1;
  applyEqualPowerGains(session.fromDeck, session.toDeck, progress);

  // Keep target endFadeFraction synced with real duration of the incoming track once metadata arrives
  const toDur = dur();
  if (toDur > 0) {
    session.endFadeFraction = clamp(session.durationSec / toDur, 0, 0.95);
  }

  player.set({ fadeProgress: progress });
  emitFrame();
  emitTime();

  if (progress >= 1) {
    finishCrossfade(session);
    return;
  }
  session.rafId = requestAnimationFrame(stepCrossfadeFrame);
}

function finishCrossfade(session: CrossfadeSession) {
  if (crossfadeSession !== session) return;
  if (session.rafId) cancelAnimationFrame(session.rafId);
  crossfadeSession = null;
  if (session.fromDeck !== getActiveDeck()) {
    stopAndResetDeck(session.fromDeck);
  }
  const active = getActiveDeck();
  active.fadeMultiplier = 1;
  syncDeckVolumes();
  player.set({ isCrossfading: false, fadeProgress: 0 });
  emitFrame();
  emitTime();
  kick();
}

function startCrossfadeRamp(
  fromDeck: Deck,
  toDeck: Deck,
  durationSec: number,
  kind: 'auto' | 'manual',
  startFadeFraction: number,
  nextTrackDuration: number,
) {
  if (crossfadeSession?.rafId) {
    cancelAnimationFrame(crossfadeSession.rafId);
  }
  if (durationSec <= 0.05) {
    stopAndResetDeck(fromDeck);
    toDeck.fadeMultiplier = 1;
    syncDeckVolumes();
    player.set({ isCrossfading: false, fadeProgress: 0 });
    return;
  }
  const safeStart = clamp(startFadeFraction, 0, 1);
  const safeEnd = nextTrackDuration > 0 ? clamp(durationSec / nextTrackDuration, 0, Math.max(0, safeStart)) : 0;
  applyEqualPowerGains(fromDeck, toDeck, 0);
  const session: CrossfadeSession = {
    id: ++crossfadeEpoch,
    fromDeck,
    toDeck,
    durationSec,
    elapsedSec: 0,
    lastTs: null,
    rafId: 0,
    paused: false,
    kind,
    startFadeFraction: safeStart,
    endFadeFraction: safeEnd,
  };
  crossfadeSession = session;
  player.set({ isCrossfading: true, fadeProgress: 0 });
  session.rafId = requestAnimationFrame(stepCrossfadeFrame);
}

function pauseCrossfadeIfActive() {
  if (!crossfadeSession) return;
  crossfadeSession.paused = true;
  crossfadeSession.lastTs = null;
  if (crossfadeSession.rafId) {
    cancelAnimationFrame(crossfadeSession.rafId);
    crossfadeSession.rafId = 0;
  }
  try {
    crossfadeSession.fromDeck.el.pause();
  } catch {
    /* ignore */
  }
}

function resumeCrossfadeIfPaused() {
  if (!crossfadeSession || !crossfadeSession.paused) return;
  crossfadeSession.paused = false;
  crossfadeSession.lastTs = null;
  try {
    if (!crossfadeSession.fromDeck.el.ended) {
      void crossfadeSession.fromDeck.el.play().catch(() => {});
    }
  } catch {
    /* ignore */
  }
  if (!crossfadeSession.rafId) {
    crossfadeSession.rafId = requestAnimationFrame(stepCrossfadeFrame);
  }
}

/** Port for configuring crossfade duration (0 disables crossfade, capped at 12s). */
export function setCrossfadeDuration(seconds: number) {
  const nextSec = Math.round(clamp(seconds, 0, 12) * 10) / 10;
  player.set({ crossfadeDuration: nextSec });
  if (nextSec <= 0 && crossfadeSession) {
    cancelCrossfade(true);
  }
}

export const getCrossfadeDuration = (): number => player.get().crossfadeDuration;

function effectiveAutoCrossfadeSeconds(trackDuration: number): number {
  const configured = player.get().crossfadeDuration;
  if (configured <= 0 || !isFinite(trackDuration) || trackDuration <= 0) return 0;
  // Requirement 6: If track is shorter than or equal to crossfadeDuration * 2, do not enable auto-crossfade
  if (trackDuration <= configured * 2) return 0;
  return configured;
}

function resolveNextQueueIndex(dir: 1 | -1, auto: boolean): number | 'repeat-one' | 'end-shuffle' | null {
  const s = player.get();
  const n = s.queue.length;
  if (!n) return null;
  if (auto && s.repeat === 'one') return 'repeat-one';
  let i = s.index;
  for (let k = 0; k < n; k++) {
    i += dir;
    if (i >= n) {
      if (auto && s.repeat === 'off') {
        const track = currentTrack();
        if (s.shuffle && track && (track.source === 'soundcloud' || track.source === 'youtube' || recommendationSource.has(track.id))) {
          return 'end-shuffle';
        }
        return null;
      }
      i = 0;
    }
    if (i < 0) i = n - 1;
    if (!isDisliked(s.queue[i])) return i;
  }
  return null;
}

function prefetchYtStream(id?: string | null) {
  if (!id) return;
  if (ytStreamPrefetch.has(id)) return;
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

/* ---------------- time / frame clock & visual rollback during crossfade ---------------- */
export const dur = () => {
  const el = getActiveDeck().el;
  return isFinite(el.duration) && el.duration > 0 ? el.duration : player.get().duration;
};

/** Real playback position of the active (incoming) track in seconds (used for lyrics sync). */
export const realCurTime = () => {
  const el = getActiveDeck().el;
  return el.src && el.readyState > 0 ? el.currentTime : player.get().pos;
};

/**
 * Displayed progress fraction (0..1) for the progress bar.
 * During crossfade, smoothly rolls back from `startFadeFraction` to `endFadeFraction`
 * (`crossfadeDuration / nextTrackDuration`), so when `fadeProgress === 1` the thumb
 * lands on the exact current second of the new track with zero jump!
 */
export function displayedProgressFraction(): number {
  const d = dur();
  if (crossfadeSession) {
    const progress = clamp(
      crossfadeSession.durationSec > 0 ? crossfadeSession.elapsedSec / crossfadeSession.durationSec : 1,
      0,
      1,
    );
    const eased = easeInOutSine(progress);
    const startF = crossfadeSession.startFadeFraction;
    const endF = d > 0 ? clamp(crossfadeSession.durationSec / d, 0, Math.max(0, startF)) : crossfadeSession.endFadeFraction;
    return clamp(startF + (endF - startF) * eased, 0, 1);
  }
  return d > 0 ? clamp(realCurTime() / d, 0, 1) : 0;
}

const curTime = () => {
  if (crossfadeSession) {
    return displayedProgressFraction() * dur();
  }
  return realCurTime();
};

const frameSubs = new Set<(t: number, d: number, realT: number) => void>();
let raf = 0;
function emitFrame() {
  const d = dur();
  const ct = curTime();
  const rt = realCurTime();
  frameSubs.forEach((f) => f(ct, d, rt));
}
function tick() {
  raf = 0;
  emitFrame();
  if (!getActiveDeck().el.paused && !crossfadeSession && frameSubs.size) raf = requestAnimationFrame(tick);
}
const kick = () => {
  if (!raf && !crossfadeSession) raf = requestAnimationFrame(tick);
};
/** Per-frame callback while playing (DOM writes only — avoids React re-renders). */
export function onFrame(f: (t: number, d: number, realT: number) => void) {
  frameSubs.add(f);
  f(curTime(), dur(), realCurTime());
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

/* ---------------- stream resolution & deck attachment ---------------- */
async function resolvePlayableStream(tr: Track): Promise<{ url: string; hls: boolean; preview: boolean }> {
  if (tr.source === 'soundcloud' && tr.nativeId) {
    return trackStream(tr.nativeId);
  }
  if (tr.source === 'youtube' && tr.playback === 'direct' && tr.nativeId) {
    const res = await ytDlpTrackStream(tr.nativeId);
    return { ...res, hls: false, preview: false };
  }
  return { url: tr.src, hls: false, preview: Boolean(tr.preview) };
}

async function attachStreamToDeck(deck: Deck, stream: { url: string; hls: boolean }) {
  if (deck.hls) {
    try {
      deck.hls.destroy();
    } catch {
      /* ignore */
    }
    deck.hls = undefined;
  }
  deck.el.loop = false;
  if (stream.hls && !deck.el.canPlayType('application/vnd.apple.mpegurl')) {
    if (!Hls.isSupported()) throw new Error('This device cannot play the SoundCloud HLS stream.');
    const instance = new Hls();
    deck.hls = instance;
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        instance.off(Hls.Events.ERROR, failed);
        resolve();
      };
      const failed = (_event: string, data: { fatal: boolean; details: string }) => {
        if (data.fatal) {
          instance.off(Hls.Events.MANIFEST_PARSED, ready);
          reject(new Error(`SoundCloud HLS failed: ${data.details}`));
        }
      };
      instance.once(Hls.Events.MANIFEST_PARSED, ready);
      instance.on(Hls.Events.ERROR, failed);
      instance.attachMedia(deck.el);
      instance.loadSource(stream.url);
    });
  } else {
    deck.el.src = stream.url;
  }
  try {
    deck.el.currentTime = 0;
  } catch {
    /* ignore */
  }
}

/**
 * Preloads the next track (or the same track when Repeat One is active) into the inactive deck
 * 10–15 seconds before the end of the current track so there is zero buffering delay when crossfade starts.
 */
async function preloadNextTrackIntoInactiveDeck() {
  const triggerLoadId = loadId;
  if (preloadingNextForLoadId === triggerLoadId || crossfadeSession) return;

  const s = player.get();
  const curTr = currentTrack();
  if (!curTr || usesProviderPlayback(curTr)) return;

  const target = resolveNextQueueIndex(1, true);
  if (target === null || target === 'end-shuffle') return;

  const nextIdx = target === 'repeat-one' ? s.index : target;
  const nextId = s.queue[nextIdx];
  const nextTr = nextId ? getTrack(nextId) : undefined;
  if (!nextTr || usesProviderPlayback(nextTr)) return;

  preloadingNextForLoadId = triggerLoadId;

  try {
    const stream = await resolvePlayableStream(nextTr);
    if (triggerLoadId !== loadId || crossfadeSession) return;
    if (!stream.url || (nextTr.source === 'soundcloud' && stream.preview)) return;

    const toDeck = getInactiveDeck();
    if (toDeck.trackId === nextId && toDeck.queueIndex === nextIdx && toDeck.preloadedForLoadId === triggerLoadId && toDeck.el.src) {
      return;
    }
    stopAndResetDeck(toDeck);
    toDeck.trackId = nextId;
    toDeck.queueIndex = nextIdx;
    toDeck.fadeMultiplier = 0;
    toDeck.preloadedForLoadId = triggerLoadId;
    syncDeckVolumes();

    await attachStreamToDeck(toDeck, stream);
    if (triggerLoadId !== loadId || crossfadeSession) {
      stopAndResetDeck(toDeck);
      return;
    }
    try {
      toDeck.el.load();
    } catch {
      /* ignore */
    }
  } catch {
    /* best-effort preload */
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

interface LoadOptions {
  crossfadeSec?: number;
}

async function load(i: number, autoplay: boolean, opts?: LoadOptions) {
  // Capture visual progress fraction before cancelling any active crossfade so manual skip rolls back from current visual position
  const priorVisualFraction = displayedProgressFraction();
  const generation = ++loadId;
  const s = player.get();
  const id = s.queue[i];
  const tr = id ? getTrack(id) : undefined;
  if (!tr) return;

  const currentDeck = getActiveDeck();
  const canCrossfadeFromCurrent =
    autoplay &&
    (opts?.crossfadeSec ?? 0) > 0 &&
    !usesProviderPlayback(tr) &&
    Boolean(currentDeck.el.src) &&
    !currentDeck.el.paused &&
    !currentDeck.el.ended &&
    currentDeck.el.currentTime > 0.25;

  // Cancel any prior crossfade so at most 2 decks can ever run (prevents 3+ tracks on rapid Next/Prev spam).
  if (crossfadeSession) {
    cancelCrossfade(true);
  } else {
    stopAndResetDeck(getInactiveDeck());
  }

  pendingSeek = pendingSeek?.trackId === id ? pendingSeek : null;
  ensureCached(id);
  lastSaved = 0;
  prefetchUpcomingYtStreams(i);

  if (canCrossfadeFromCurrent) {
    const fadeDuration = opts!.crossfadeSec!;
    const fromDeck = getActiveDeck();
    const toDeck = getInactiveDeck();
    stopAndResetDeck(toDeck);
    toDeck.trackId = id;
    toDeck.queueIndex = i;
    toDeck.fadeMultiplier = 0;
    syncDeckVolumes();

    activeDeckIdx = toDeck.id;
    audio = toDeck.el;
    player.set({ index: i, duration: tr.duration, loading: true, pos: 0 });

    try {
      const stream = await resolvePlayableStream(tr);
      if (tr.source === 'soundcloud' && stream.preview) {
        stopAndResetDeck(fromDeck);
        toDeck.fadeMultiplier = 1;
        syncDeckVolumes();
        await fallbackSoundCloud(tr, i, generation);
        return;
      }
      if (!stream.url) throw new Error('This provider did not return a playable preview.');
      if (generation !== loadId) {
        stopAndResetDeck(fromDeck);
        return;
      }
      await attachStreamToDeck(toDeck, stream);
      if (generation !== loadId) {
        stopAndResetDeck(fromDeck);
        return;
      }
      await toDeck.el.play();
      if (generation !== loadId) {
        stopAndResetDeck(fromDeck);
        return;
      }
      const nextDur = (isFinite(toDeck.el.duration) && toDeck.el.duration > 0 ? toDeck.el.duration : tr.duration) || 0;
      startCrossfadeRamp(
        fromDeck,
        toDeck,
        fadeDuration,
        fadeDuration <= MANUAL_CROSSFADE_SECONDS + 0.1 ? 'manual' : 'auto',
        priorVisualFraction > 0.02 ? priorVisualFraction : 0.15,
        nextDur,
      );
    } catch (e) {
      if (generation !== loadId) return;
      stopAndResetDeck(fromDeck);
      toDeck.fadeMultiplier = 1;
      syncDeckVolumes();
      if (tr.source === 'soundcloud') {
        await fallbackSoundCloud(tr, i, generation);
        return;
      }
      player.set({ playing: false, loading: false, isCrossfading: false, fadeProgress: 0 });
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
    return;
  }

  // Standard single-deck load (no crossfade)
  cancelCrossfade(true);
  const deck = getActiveDeck();
  stopAndResetDeck(deck);
  deck.trackId = id;
  deck.queueIndex = i;
  deck.fadeMultiplier = 1;
  syncDeckVolumes();
  audio = deck.el;

  player.set({ index: i, duration: tr.duration, loading: true, playing: false, pos: 0, isCrossfading: false, fadeProgress: 0 });

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
    const stream = await resolvePlayableStream(tr);
    if (tr.source === 'soundcloud' && stream.preview) {
      await fallbackSoundCloud(tr, i, generation);
      return;
    }
    if (!stream.url) throw new Error('This provider did not return a playable preview.');
    if (generation !== loadId) return;
    await attachStreamToDeck(deck, stream);
    if (autoplay) {
      try {
        await deck.el.play();
      } catch {
        player.set({ loading: false, playing: false });
      }
    } else {
      player.set({ loading: false });
    }
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

/**
 * Automatic end-of-track crossfade (including Repeat One self-crossfade on Deck B).
 * Uses preloaded inactive deck when available so audio crossfade and progress-bar rollback start in sync.
 */
async function startAutoCrossfade() {
  const triggerLoadId = loadId;
  if (autoCrossfadePreparingForLoadId === triggerLoadId || crossfadeSession) return;

  const s = player.get();
  const curTr = currentTrack();
  if (!curTr || usesProviderPlayback(curTr)) return;

  const fromDeck = getActiveDeck();
  const trackDur = dur();
  const baseFade = effectiveAutoCrossfadeSeconds(trackDur);
  if (baseFade <= 0) return;

  const target = resolveNextQueueIndex(1, true);
  if (target === null) return; // End of playlist with repeat off — do not crossfade
  if (target === 'end-shuffle') return; // Let ended handler append recommendations

  const nextIdx = target === 'repeat-one' ? s.index : target;
  const nextId = s.queue[nextIdx];
  const nextTr = nextId ? getTrack(nextId) : undefined;
  if (!nextTr || usesProviderPlayback(nextTr)) return;

  autoCrossfadePreparingForLoadId = triggerLoadId;

  try {
    const toDeck = getInactiveDeck();
    const alreadyPreloaded =
      toDeck.trackId === nextId &&
      toDeck.queueIndex === nextIdx &&
      toDeck.preloadedForLoadId === triggerLoadId &&
      Boolean(toDeck.el.src);

    if (!alreadyPreloaded) {
      const stream = await resolvePlayableStream(nextTr);
      if (triggerLoadId !== loadId || crossfadeSession || fromDeck.el.paused) return;
      if (!stream.url || (nextTr.source === 'soundcloud' && stream.preview)) {
        return;
      }
      stopAndResetDeck(toDeck);
      toDeck.trackId = nextId;
      toDeck.queueIndex = nextIdx;
      toDeck.fadeMultiplier = 0;
      syncDeckVolumes();
      await attachStreamToDeck(toDeck, stream);
      if (triggerLoadId !== loadId || crossfadeSession || fromDeck.el.paused) {
        stopAndResetDeck(toDeck);
        return;
      }
    } else {
      toDeck.fadeMultiplier = 0;
      try {
        toDeck.el.currentTime = 0;
      } catch {
        /* ignore */
      }
      syncDeckVolumes();
    }

    const fromDuration = isFinite(fromDeck.el.duration) && fromDeck.el.duration > 0 ? fromDeck.el.duration : trackDur;
    const startFraction = fromDuration > 0 ? clamp(fromDeck.el.currentTime / fromDuration, 0.05, 1) : 0.92;
    const remaining = Math.max(0.2, fromDuration - fromDeck.el.currentTime);
    const fadeSec = clamp(Math.min(baseFade, remaining), 0.2, baseFade);

    // Promote incoming deck to active and start playback + progress rollback simultaneously
    const generation = ++loadId;
    activeDeckIdx = toDeck.id;
    audio = toDeck.el;
    lastSaved = 0;
    ensureCached(nextId);
    const nextDur = (isFinite(toDeck.el.duration) && toDeck.el.duration > 0 ? toDeck.el.duration : nextTr.duration) || 0;
    player.set({ index: nextIdx, duration: nextDur || nextTr.duration, loading: false, playing: true, pos: 0 });

    await toDeck.el.play();
    if (generation !== loadId) {
      stopAndResetDeck(fromDeck);
      return;
    }

    startCrossfadeRamp(fromDeck, toDeck, fadeSec, 'auto', startFraction, nextDur || nextTr.duration);
    if (nextTr.source === 'soundcloud') void prefetchRelated(nextTr);
    if (nextTr.source === 'youtube' && nextTr.playback === 'direct') prefetchUpcomingYtStreams(nextIdx);
    pushRecent(nextId);
    mediaMeta(nextTr);
    emitFrame();
    emitTime();
  } catch {
    // If preloading/play fails, normal `ended` event on `fromDeck` will advance the queue cleanly.
  }
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
  const manualFade = player.get().crossfadeDuration > 0 ? MANUAL_CROSSFADE_SECONDS : 0;
  void load(idx, true, { crossfadeSec: manualFade });
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
  void load(nextIndex, true);
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
  const activeEl = getActiveDeck().el;
  if (!activeEl.src) {
    const keep = s.pos;
    const id = s.queue[s.index];
    void load(s.index, true);
    pendingSeek = id ? createPendingAudioSeek(id, keep) : null;
    return;
  }
  if (activeEl.paused) {
    resumeCrossfadeIfPaused();
    activeEl.play().catch(() => player.set({ playing: false }));
  } else {
    pauseCrossfadeIfActive();
    activeEl.pause();
  }
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
    // If crossfade is enabled (> 0), repeat-one crossfades onto the second deck; otherwise loop from 0
    if (s.crossfadeDuration > 0 && dur() > s.crossfadeDuration * 2) {
      void load(s.index, true, { crossfadeSec: s.crossfadeDuration });
      return;
    }
    const el = getActiveDeck().el;
    el.currentTime = 0;
    el.play().catch(() => {});
    return;
  }
  const target = resolveNextQueueIndex(dir, auto);
  if (target === 'end-shuffle') {
    const track = currentTrack();
    if (track) void appendRelatedAndContinue(track);
    return;
  }
  if (target === null || target === 'repeat-one') {
    player.set({ playing: false });
    return;
  }
  const manualFade = !auto && s.crossfadeDuration > 0 ? MANUAL_CROSSFADE_SECONDS : 0;
  void load(target, true, { crossfadeSec: manualFade });
}

export const next = (auto = false) => step(1, auto);
export function prev() {
  if (realCurTime() > 3 && !crossfadeSession) seek(0);
  else step(-1, false);
}
export const jumpTo = (i: number) => {
  const manualFade = player.get().crossfadeDuration > 0 ? MANUAL_CROSSFADE_SECONDS : 0;
  return load(i, true, { crossfadeSec: manualFade });
};

export function seek(sec: number) {
  const active = getActiveDeck();
  const activeEl = active.el;
  const totalDur = dur();

  // Requirement 4.2: Seeking during crossfade/rollback immediately cancels crossfade,
  // unloads the outgoing track, gives the incoming track 100% masterVolume, and seeks it to `sec`.
  if (crossfadeSession) {
    cancelCrossfade(true);
  }
  autoCrossfadePreparingForLoadId = -1;

  if (usesProviderPlayback(currentTrack())) {
    pendingSeek = null;
    const position = Math.max(0, sec);
    player.set({ pos: position });
    providerCommand('seek', position);
  } else if (!activeEl.src || activeEl.readyState < 1) {
    const position = Math.max(0, sec);
    const id = currentTrack()?.id;
    pendingSeek = id ? createPendingAudioSeek(id, position) : null;
    player.set({ pos: position });
  } else {
    pendingSeek = null;
    const clamped = clamp(sec, 0, totalDur || sec);
    activeEl.currentTime = clamped;
    player.set({ pos: clamped });
    const fadeWindow = effectiveAutoCrossfadeSeconds(totalDur);
    if (fadeWindow > 0 && totalDur > 0 && !activeEl.paused) {
      const remaining = totalDur - clamped;
      if (remaining > 0.25 && remaining <= fadeWindow) {
        void startAutoCrossfade();
      }
    }
  }
  emitFrame();
  emitTime();
  kick();
}
export const seekBy = (d: number) => seek(realCurTime() + d);

/**
 * Perceptual (cubic) volume curve.
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
  v = Math.round(clamp(v, 0, 1) * 1000) / 1000;
  if (usesProviderPlayback(currentTrack())) providerCommand('setVolume', v);
  player.set({ volume: v, muted: false });
  syncDeckVolumes();
}
export function toggleMute() {
  const m = !player.get().muted;
  if (usesProviderPlayback(currentTrack())) providerCommand('setVolume', m ? 0 : player.get().volume);
  player.set({ muted: m });
  syncDeckVolumes();
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

/* ---------------- audio events (strictly isolated during crossfade) ---------------- */
onProviderState((state) => {
  if (state.ended) {
    next(true);
    return;
  }
  player.set({ playing: state.playing, loading: state.loading, pos: state.position, duration: state.duration });
  emitFrame();
  emitTime();
});

let lastSaved = 0;

function bindDeckEvents(deck: Deck) {
  const el = deck.el;

  el.addEventListener('play', () => {
    if (deck !== getActiveDeck()) return;
    player.set({ playing: true });
    kick();
  });

  el.addEventListener('playing', () => {
    if (deck !== getActiveDeck()) return;
    player.set({ loading: false, playing: true });
    errors = 0;
  });

  el.addEventListener('pause', () => {
    if (deck !== getActiveDeck()) return;
    if (player.get().loading) return;
    player.set({ playing: false, pos: el.src ? el.currentTime : 0 });
  });

  el.addEventListener('waiting', () => {
    if (deck !== getActiveDeck()) return;
    if (el.src) player.set({ loading: true });
  });

  el.addEventListener('canplay', () => {
    if (deck !== getActiveDeck()) return;
    player.set({ loading: false });
  });

  el.addEventListener('ended', () => {
    if (deck !== getActiveDeck()) {
      // Outgoing deck finished playing its tail: stop & clean up without advancing queue or touching UI
      if (crossfadeSession && crossfadeSession.fromDeck === deck) {
        stopAndResetDeck(deck);
      } else {
        stopAndResetDeck(deck);
      }
      return;
    }
    next(true);
  });

  el.addEventListener('loadedmetadata', () => {
    if (deck !== getActiveDeck()) return;
    const track = currentTrack();
    if (track?.source === 'soundcloud' && track.duration > 75 && el.duration > 0 && el.duration <= 60 && el.duration + 10 < track.duration) {
      void fallbackSoundCloud(track, player.get().index, loadId);
      return;
    }
    const seekTo = track ? pendingAudioSeekFor(pendingSeek, track.id) : null;
    if (seekTo !== null) {
      el.currentTime = Math.min(seekTo, el.duration || seekTo);
      pendingSeek = null;
    }
    if (isFinite(el.duration) && el.duration > 0) player.set({ duration: el.duration });
    if (!crossfadeSession) {
      emitFrame();
      emitTime();
    }
  });

  el.addEventListener('timeupdate', () => {
    if (deck !== getActiveDeck()) return;

    // Requirement 4.1: While crossfading, do NOT let timeupdate overwrite visual progress or jitter the thumb.
    // The unified requestAnimationFrame loop (`stepCrossfadeFrame`) owns visual progress during crossfade.
    if (crossfadeSession) return;

    const track = currentTrack();
    const duration = dur();
    const remaining = duration - el.currentTime;

    if (player.get().shuffle && track?.source === 'soundcloud' && duration > 0 && remaining <= 20) {
      void prefetchRelated(track);
    }

    const fadeSec = effectiveAutoCrossfadeSeconds(duration);
    if (fadeSec > 0 && duration > 0 && !el.paused && el.currentTime >= 1) {
      // Requirement 6: Preload next track (or same track on Repeat One) 10-15s before the end
      if (
        preloadingNextForLoadId !== loadId &&
        remaining > fadeSec + 0.5 &&
        remaining <= Math.max(fadeSec + 8, PRELOAD_AHEAD_SECONDS)
      ) {
        void preloadNextTrackIntoInactiveDeck();
      }
      // Start crossfade when entering the crossfade window
      if (autoCrossfadePreparingForLoadId !== loadId && remaining > 0.25 && remaining <= fadeSec + 0.25) {
        void startAutoCrossfade();
        return;
      }
    }

    emitTime();
    if (el.paused) emitFrame();
    if (Math.abs(el.currentTime - lastSaved) > 4) {
      lastSaved = el.currentTime;
      player.set({ pos: el.currentTime });
    }
  });

  el.addEventListener('seeked', () => {
    if (deck !== getActiveDeck() || crossfadeSession) return;
    emitFrame();
    emitTime();
  });

  el.addEventListener('error', () => {
    if (!el.src || !el.error) return;
    if (deck !== getActiveDeck()) {
      stopAndResetDeck(deck);
      return;
    }
    const track = currentTrack();
    const index = player.get().index;
    const generation = loadId;
    if (track?.source === 'soundcloud') {
      void fallbackSoundCloud(track, index, generation);
      return;
    }
    player.set({ loading: false, playing: false, isCrossfading: false, fadeProgress: 0 });
    snack(t('cantPlay'));
    if (++errors < 3) setTimeout(() => next(true), 900);
  });
}

bindDeckEvents(decks[0]);
bindDeckEvents(decks[1]);

export function initPlayer() {
  persist('lyra.player.v1', player, (s) => ({
    queue: s.queue,
    index: s.index,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    pos: s.pos,
    duration: s.duration,
    crossfadeDuration: s.crossfadeDuration,
  }));
  const s = player.get();
  const curId = s.queue[s.index];
  const q = s.queue.filter((id) => getTrack(id));
  const idx = curId ? q.indexOf(curId) : -1;
  player.set({
    queue: q,
    index: idx,
    playing: false,
    loading: false,
    pos: idx >= 0 ? s.pos : 0,
    isCrossfading: false,
    fadeProgress: 0,
  });
  syncDeckVolumes();
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
        } else {
          pauseCrossfadeIfActive();
          getActiveDeck().el.pause();
        }
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
  window.addEventListener('pagehide', () => player.set({ pos: realCurTime() }));
}
