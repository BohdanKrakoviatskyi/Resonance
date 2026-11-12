import { useSyncExternalStore } from 'react';
import Hls from 'hls.js';
import { createStore, persist, clamp, shuffled, useStore } from '../lib/util';
import { getTrack, library, pushRecent, isDisliked, ensureCached, registerTracks } from './library';
import { snack, openSearch } from './ui';
import { t } from '../lib/i18n';
import { findYouTubeFallback, relatedSoundCloudTracks, searchYouTubeRecommendations, trackStream, ytDlpTrackStream } from '../lib/api';
import type { YtResolveAttemptTiming, YtStreamResolveResult } from '../lib/providers-api';
import { rankRecommendations } from '../lib/recommendations';
import { createPendingAudioSeek, pendingAudioSeekFor, type PendingAudioSeek } from '../lib/pending-audio-seek';
import { onProviderState, providerCommand } from '../lib/provider-player';
import type { Track } from '../types';

export type Repeat = 'off' | 'all' | 'one';
export type PlayerPlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
export type NormalizationTarget = 'quiet' | 'normal' | 'loud';
export type CrossfadeCurve = 'linear' | 'equalPower' | 'sCurve';
export type EqPreset = 'flat' | 'bassBoost' | 'vocal' | 'rock' | 'electronic' | 'custom';

export const EQ_BANDS = [
  { freq: 60, label: '60Hz', type: 'lowshelf' as BiquadFilterType },
  { freq: 230, label: '230Hz', type: 'peaking' as BiquadFilterType },
  { freq: 910, label: '910Hz', type: 'peaking' as BiquadFilterType },
  { freq: 3600, label: '3.6kHz', type: 'peaking' as BiquadFilterType },
  { freq: 14000, label: '14kHz', type: 'highshelf' as BiquadFilterType },
] as const;

export const EQ_PRESETS: Record<Exclude<EqPreset, 'custom'>, readonly [number, number, number, number, number]> = {
  flat: [0, 0, 0, 0, 0],
  bassBoost: [6.5, 4.0, 0, -1.0, 1.5],
  vocal: [-2.0, -1.0, 4.5, 3.5, 1.0],
  rock: [4.5, 2.0, -1.5, 3.0, 4.5],
  electronic: [5.5, 2.5, -1.0, 2.5, 5.0],
};

export const DEFAULT_CROSSFADE_DURATION = 4;
const MANUAL_CROSSFADE_SECONDS = 0.8;
const PRELOAD_AHEAD_SECONDS = 14;

type DeckId = 0 | 1;
interface DeckDsp {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  preGain: GainNode;
  eqFilters: BiquadFilterNode[];
  compressor: DynamicsCompressorNode;
  limiter: DynamicsCompressorNode;
  channelGain: GainNode;
}

interface Deck {
  readonly id: DeckId;
  readonly el: HTMLAudioElement;
  hls?: Hls;
  dsp?: DeckDsp;
  fadeMultiplier: number;
  trackId: string | null;
  queueIndex: number;
  requestId: number;
  preloadedForLoadId?: number;
}

function createAudioElement(): HTMLAudioElement {
  const el = new Audio();
  el.preload = 'auto';
  el.loop = false;
  el.crossOrigin = 'anonymous';
  return el;
}

const decks: [Deck, Deck] = [
  { id: 0, el: createAudioElement(), fadeMultiplier: 1, trackId: null, queueIndex: -1, requestId: 0 },
  { id: 1, el: createAudioElement(), fadeMultiplier: 0, trackId: null, queueIndex: -1, requestId: 0 },
];

let activeDeckIdx: DeckId = 0;
export let audio: HTMLAudioElement = decks[0].el;

export const getActiveDeck = (): Deck => decks[activeDeckIdx];
const getInactiveDeck = (): Deck => decks[activeDeckIdx === 0 ? 1 : 0];

export const player = createStore({
  queue: [] as string[],
  index: -1,
  state: 'idle' as PlayerPlaybackState,
  requestId: 0,
  playing: false,
  loading: false,
  duration: 0,
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off' as Repeat,
  pos: 0,
  // Audio Normalization settings
  normalizationEnabled: false,
  normalizationTarget: 'normal' as NormalizationTarget,
  // Crossfade settings
  crossfadeEnabled: true,
  crossfadeDuration: DEFAULT_CROSSFADE_DURATION,
  crossfadeCurve: 'equalPower' as CrossfadeCurve,
  // 5-band Equalizer settings
  eqPreset: 'flat' as EqPreset,
  eqGains: [0, 0, 0, 0, 0] as number[],
  // Runtime crossfade progress state
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
let currentRequestId = 0;
let fallbackAttemptedGeneration = -1;
const relatedFetched = new Set<string>();
const recommendationSource = new Map<string, Track>();
const ytStreamPrefetch = new Map<string, Promise<YtStreamResolveResult>>();
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

interface TrackLoadTrace {
  requestId: number;
  trackId: string;
  title: string;
  source: string;
  clickPerfMs: number;
  clickEpochMs: number;
  resolveStartedPerfMs?: number;
  resolveDonePerfMs?: number;
  attempts: YtResolveAttemptTiming[];
  proxyTtfbLogged?: boolean;
  canplayLogged?: boolean;
  playingLogged?: boolean;
}

let activeTrace: TrackLoadTrace | null = null;

function logTrackTiming(reqId: number, stage: string, details: string, basePerfMs?: number) {
  const nowPerf = performance.now();
  const sinceClick =
    basePerfMs !== undefined
      ? Math.round(nowPerf - basePerfMs)
      : activeTrace?.requestId === reqId
        ? Math.round(nowPerf - activeTrace.clickPerfMs)
        : 0;
  console.info(`[PlayerTiming][reqId=${reqId}][+${sinceClick}ms] stage=${stage} ${details}`);
}

type PlayerStatePatch = Omit<Partial<ReturnType<typeof player.get>>, 'state' | 'playing' | 'loading'>;

function setPlayerMachineState(nextState: PlayerPlaybackState, patch?: PlayerStatePatch) {
  player.set({
    ...patch,
    state: nextState,
    loading: nextState === 'loading',
    playing: nextState === 'playing' || nextState === 'loading',
  });
}

const extractYtVideoId = (track: Track | null | undefined): string => {
  if (!track) return '';
  if (track.nativeId) return String(track.nativeId).trim();
  if (track.id.startsWith('yt:')) return track.id.slice(3).trim();
  return '';
};
const isYouTubeTrack = (track: Track | null | undefined): boolean =>
  !!track && (track.source === 'youtube' || (track.source as string) === 'ytmusic' || track.id.startsWith('yt:'));
const usesProviderPlayback = (track: Track | null | undefined) =>
  !!track && isYouTubeTrack(track) && track.playback !== 'direct' && !extractYtVideoId(track);

// Предзагружаем следующие N+1..N+3 трека вперёд и N-1 назад в низкоприоритетном пуле (background_semaphore)
const YT_STREAM_PREFETCH_AHEAD = 3;
const YT_Playlist_TOP_PREFETCH = 2;

/* ---------------- Web Audio API DSP Normalization + Brickwall Limiter ---------------- */
let sharedAudioCtx: AudioContext | null = null;

interface NormalizationPresetSpec {
  lufsLabel: string;
  preGainLinear: number;
  compThresholdDb: number;
  compKneeDb: number;
  compRatio: number;
  makeupLinear: number;
}

const NORMALIZATION_PRESETS: Record<NormalizationTarget, NormalizationPresetSpec> = {
  // -18 LUFS (Quiet): gentle dynamic leveling, preserves wide dynamic range
  quiet: {
    lufsLabel: '-18 LUFS',
    preGainLinear: 0.78,
    compThresholdDb: -24,
    compKneeDb: 24,
    compRatio: 2.5,
    makeupLinear: 0.85,
  },
  // -14 LUFS (Standard streaming loudness): balanced leveling + makeup gain
  normal: {
    lufsLabel: '-14 LUFS',
    preGainLinear: 1.18,
    compThresholdDb: -21,
    compKneeDb: 20,
    compRatio: 3.5,
    makeupLinear: 1.0,
  },
  // -11 LUFS (Loud): stronger upward boost for quiet tracks, protected by brickwall limiter
  loud: {
    lufsLabel: '-11 LUFS',
    preGainLinear: 1.55,
    compThresholdDb: -18,
    compKneeDb: 16,
    compRatio: 5.0,
    makeupLinear: 1.0,
  },
};

function isEqActive(): boolean {
  const { eqGains } = player.get();
  return eqGains.some((g) => Math.abs(g) > 0.05);
}

function isDspNeeded(): boolean {
  return player.get().normalizationEnabled || isEqActive();
}

function ensureDeckDsp(deck: Deck): DeckDsp | undefined {
  if (deck.dsp) return deck.dsp;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return undefined;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
    const ctx = sharedAudioCtx;

    const source = ctx.createMediaElementSource(deck.el);
    const preGain = ctx.createGain();
    const eqFilters = EQ_BANDS.map((band) => {
      const filter = ctx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.freq;
      filter.Q.value = band.type === 'peaking' ? 1.1 : 0.707;
      filter.gain.value = 0;
      return filter;
    });
    const compressor = ctx.createDynamicsCompressor();
    const limiter = ctx.createDynamicsCompressor();
    const channelGain = ctx.createGain();

    // Brickwall safety limiter at -1.0 dBFS to guarantee zero clipping even when preGain or EQ boost > 1.0
    limiter.threshold.value = -1.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;

    deck.dsp = { ctx, source, preGain, eqFilters, compressor, limiter, channelGain };
    configureDeckDspChain(deck);
    return deck.dsp;
  } catch {
    return undefined;
  }
}

function applyEqGainsToDsp(dsp: DeckDsp) {
  const { eqGains } = player.get();
  const now = dsp.ctx.currentTime;
  dsp.eqFilters.forEach((filter, idx) => {
    const db = clamp(eqGains[idx] ?? 0, -12, 12);
    filter.gain.setTargetAtTime(db, now, 0.015);
  });
}

function configureDeckDspChain(deck: Deck) {
  const dsp = deck.dsp;
  if (!dsp) return;
  const { normalizationEnabled, normalizationTarget } = player.get();
  const eqActive = isEqActive();
  const preset = NORMALIZATION_PRESETS[normalizationTarget] ?? NORMALIZATION_PRESETS.normal;
  const now = dsp.ctx.currentTime;

  try {
    dsp.source.disconnect();
    dsp.preGain.disconnect();
    for (const f of dsp.eqFilters) f.disconnect();
    dsp.compressor.disconnect();
    dsp.limiter.disconnect();
    dsp.channelGain.disconnect();
  } catch {
    /* ignore */
  }

  applyEqGainsToDsp(dsp);

  if (normalizationEnabled || eqActive) {
    dsp.preGain.gain.setTargetAtTime(normalizationEnabled ? preset.preGainLinear : 1.0, now, 0.015);

    let prev: AudioNode = dsp.source;
    prev.connect(dsp.preGain);
    prev = dsp.preGain;

    if (eqActive) {
      for (const f of dsp.eqFilters) {
        prev.connect(f);
        prev = f;
      }
    }

    if (normalizationEnabled) {
      dsp.compressor.threshold.setTargetAtTime(preset.compThresholdDb, now, 0.015);
      dsp.compressor.knee.setTargetAtTime(preset.compKneeDb, now, 0.015);
      dsp.compressor.ratio.setTargetAtTime(preset.compRatio, now, 0.015);
      dsp.compressor.attack.setTargetAtTime(0.008, now, 0.015);
      dsp.compressor.release.setTargetAtTime(0.22, now, 0.015);
      prev.connect(dsp.compressor);
      prev = dsp.compressor;
    }

    // Always route through the brickwall limiter when EQ or normalization is active so +dB EQ boosts never clip
    prev.connect(dsp.limiter);
    dsp.limiter.connect(dsp.channelGain);
    dsp.channelGain.connect(dsp.ctx.destination);
  } else {
    dsp.preGain.gain.setTargetAtTime(1.0, now, 0.015);
    dsp.source.connect(dsp.channelGain);
    dsp.channelGain.connect(dsp.ctx.destination);
  }
}

function resumeAudioContextIfNeeded() {
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    void sharedAudioCtx.resume().catch(() => {});
  }
}

/* ---------------- Crossfade mathematical curves ---------------- */
/** Smooth S-curve (`easeInOutSine`) mapping 0..1 -> 0..1 with zero-slope endpoints. */
export const easeInOutSine = (x: number): number => {
  const c = clamp(x, 0, 1);
  return -(Math.cos(Math.PI * c) - 1) / 2;
};

/**
 * Computes `[fadeOutMultiplier, fadeInMultiplier]` for progress `t` in `[0, 1]`
 * according to the user's selected transition curve:
 * - `linear`: `volA = 1 - t`, `volB = t`
 * - `equalPower`: `volA = cos(t * 0.5 * PI)`, `volB = sin(t * 0.5 * PI)` (eliminates -3 dB midpoint dip)
 * - `sCurve`: S-shaped `easeInOutSine` fed into equal-power cosine/sine for imperceptible start & end
 */
export function computeCrossfadePair(progress: number, curve: CrossfadeCurve): [number, number] {
  const t = clamp(progress, 0, 1);
  if (curve === 'linear') {
    return [1 - t, t];
  }
  if (curve === 'equalPower') {
    const angle = t * 0.5 * Math.PI;
    return [Math.cos(angle), Math.sin(angle)];
  }
  const shaped = easeInOutSine(t);
  const angle = shaped * 0.5 * Math.PI;
  return [Math.cos(angle), Math.sin(angle)];
}

/* ---------------- Master Volume + Normalization + Crossfade Gain Sync ---------------- */
function syncDeckVolumes() {
  const { volume, muted, normalizationEnabled, normalizationTarget } = player.get();
  const master = clamp(volume, 0, 1);
  const preset = NORMALIZATION_PRESETS[normalizationTarget] ?? NORMALIZATION_PRESETS.normal;
  const makeup = normalizationEnabled ? preset.makeupLinear : 1.0;

  for (const deck of decks) {
    const fade = clamp(deck.fadeMultiplier, 0, 1);
    deck.el.muted = muted;

    if (deck.dsp && deck.dsp.ctx.state !== 'closed') {
      deck.el.volume = 1;
      const finalGain = muted ? 0 : clamp(master * makeup * fade, 0, 1);
      deck.dsp.channelGain.gain.setTargetAtTime(finalGain, deck.dsp.ctx.currentTime, 0.008);
    } else {
      deck.el.volume = muted ? 0 : clamp(master * makeup * fade, 0, 1);
    }
  }
}

function refreshAllDspChains() {
  const needDsp = isDspNeeded();
  for (const deck of decks) {
    if (needDsp && !deck.dsp) {
      ensureDeckDsp(deck);
    }
    if (deck.dsp) {
      configureDeckDspChain(deck);
    }
  }
  if (needDsp) {
    resumeAudioContextIfNeeded();
  }
  syncDeckVolumes();
}

function stopAndResetDeck(deck: Deck) {
  deck.requestId = -1;
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

function applyCrossfadeGains(fromDeck: Deck, toDeck: Deck, progress: number) {
  const curve = player.get().crossfadeCurve;
  const [outGain, inGain] = computeCrossfadePair(progress, curve);
  fromDeck.fadeMultiplier = outGain;
  toDeck.fadeMultiplier = inGain;
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
  applyCrossfadeGains(session.fromDeck, session.toDeck, progress);

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
  applyCrossfadeGains(fromDeck, toDeck, 0);
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

/* ---------------- Public Audio Settings API ---------------- */
export function setNormalizationEnabled(enabled: boolean) {
  player.set({ normalizationEnabled: Boolean(enabled) });
  refreshAllDspChains();
}

export function setNormalizationTarget(target: NormalizationTarget) {
  player.set({ normalizationTarget: target });
  refreshAllDspChains();
}

export function setCrossfadeEnabled(enabled: boolean) {
  const on = Boolean(enabled);
  player.set({ crossfadeEnabled: on });
  if (!on && crossfadeSession) {
    cancelCrossfade(true);
  }
}

export function setCrossfadeDuration(seconds: number) {
  if (seconds <= 0) {
    setCrossfadeEnabled(false);
    return;
  }
  const nextSec = Math.round(clamp(seconds, 1, 12) * 2) / 2;
  player.set({ crossfadeDuration: nextSec, crossfadeEnabled: true });
}

export function setCrossfadeCurve(curve: CrossfadeCurve) {
  player.set({ crossfadeCurve: curve });
  if (crossfadeSession) {
    const progress =
      crossfadeSession.durationSec > 0
        ? clamp(crossfadeSession.elapsedSec / crossfadeSession.durationSec, 0, 1)
        : 1;
    applyCrossfadeGains(crossfadeSession.fromDeck, crossfadeSession.toDeck, progress);
  }
}

export function setEqPreset(preset: EqPreset) {
  if (preset === 'custom') {
    player.set({ eqPreset: 'custom' });
    return;
  }
  const gains = [...EQ_PRESETS[preset]];
  player.set({ eqPreset: preset, eqGains: gains });
  refreshAllDspChains();
}

export function setEqBandGain(bandIndex: number, db: number) {
  const cur = player.get().eqGains.slice();
  while (cur.length < EQ_BANDS.length) cur.push(0);
  cur[bandIndex] = Math.round(clamp(db, -12, 12) * 2) / 2;
  player.set({ eqPreset: 'custom', eqGains: cur });
  refreshAllDspChains();
}

export const getCrossfadeDuration = (): number => {
  const s = player.get();
  return s.crossfadeEnabled ? s.crossfadeDuration : 0;
};

function effectiveAutoCrossfadeSeconds(trackDuration: number): number {
  const s = player.get();
  if (!s.crossfadeEnabled || s.crossfadeDuration <= 0 || !isFinite(trackDuration) || trackDuration <= 0) return 0;
  // If track is shorter than or equal to crossfadeDuration * 2, disable auto-crossfade
  if (trackDuration <= s.crossfadeDuration * 2) return 0;
  return s.crossfadeDuration;
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
  const request = ytDlpTrackStream(id, { priority: false })
    .then(async (res) => {
      if (!res.url) return res;
      if (res.url.includes('/yt-audio/') && res.url.includes('t=')) {
        try {
          await fetch(`${res.url}&prefetch=1`, { method: 'GET', cache: 'no-store' });
        } catch {
          // Background prefetch; playback path will handle misses.
        }
      }
      return res;
    })
    .catch(() => ({ url: '' }))
    .finally(() => {
      if (ytStreamPrefetch.get(id) === request) ytStreamPrefetch.delete(id);
    });
  ytStreamPrefetch.set(id, request);
}

/**
 * Низкоприоритетная предзагрузка при наведении курсора (hover >= 350–400 мс) или для отдельных треков.
 * Использует фоновый семафор (`priority: false`) и in-flight дедупликацию по `video_id`.
 */
export function prefetchTrackByIdLowPriority(trackId?: string | null) {
  if (!trackId || isDisliked(trackId)) return;
  const track = getTrack(trackId);
  if (!track || !isYouTubeTrack(track)) return;
  const ytId = extractYtVideoId(track);
  if (ytId) {
    prefetchYtStream(ytId);
  }
}

/**
 * При открытии плейлиста (с задержкой ~300 мс) ставит в фоновый префетч ТОЛЬКО топ-2 первых трека.
 */
export function prefetchPlaylistTopTracks(trackIds: string[]) {
  if (!trackIds.length) return;
  let count = 0;
  for (const trackId of trackIds) {
    if (count >= YT_Playlist_TOP_PREFETCH) break;
    if (!trackId || isDisliked(trackId)) continue;
    const track = getTrack(trackId);
    if (!track) continue;
    const ytId = extractYtVideoId(track);
    if (isYouTubeTrack(track) && ytId) {
      prefetchYtStream(ytId);
      count += 1;
    }
  }
}

/**
 * Низкоприоритетная фоновая предзагрузка для очереди воспроизведения:
 * прогревает `N+1..N+3` трека вперёд и `N-1` назад через фоновый семафор (`priority: false`).
 * Запускается после старта текущего трека и не блокирует прямые пользовательские клики.
 */
function scheduleLowPriorityUpcomingPrefetch(forRequestId: number, index = player.get().index) {
  if (prefetchTimer !== null) {
    clearTimeout(prefetchTimer);
    prefetchTimer = null;
  }
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    if (forRequestId !== currentRequestId) return;
    const { queue, repeat } = player.get();
    if (!queue.length || index < 0) return;

    // 1. Вперёд: N+1 .. N+3
    let queuedAhead = 0;
    for (let offset = 1; offset <= queue.length && queuedAhead < YT_STREAM_PREFETCH_AHEAD; offset += 1) {
      let nextIndex = index + offset;
      if (nextIndex >= queue.length) {
        if (repeat === 'off') break;
        nextIndex %= queue.length;
      }
      if (nextIndex === index) continue;
      const track = getTrack(queue[nextIndex]);
      if (!track || isDisliked(track.id)) continue;
      const ytId = extractYtVideoId(track);
      if (isYouTubeTrack(track) && ytId) {
        prefetchYtStream(ytId);
        queuedAhead += 1;
      } else if (isYouTubeTrack(track)) {
        queuedAhead += 1;
      }
    }

    // 2. Назад: N-1
    let prevIndex = index - 1;
    if (prevIndex < 0 && repeat !== 'off') {
      prevIndex = queue.length - 1;
    }
    if (prevIndex >= 0 && prevIndex < queue.length && prevIndex !== index) {
      const prevTrack = getTrack(queue[prevIndex]);
      if (prevTrack && !isDisliked(prevTrack.id)) {
        const prevYtId = extractYtVideoId(prevTrack);
        if (isYouTubeTrack(prevTrack) && prevYtId) {
          prefetchYtStream(prevYtId);
        }
      }
    }
  }, 350);
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
interface ResolvedPlayableStream {
  url: string;
  hls: boolean;
  preview: boolean;
  cacheHit?: boolean;
  resolveMs?: number;
  attempts?: YtResolveAttemptTiming[];
}

async function resolvePlayableStream(
  tr: Track,
  requestId?: number,
  clickEpochMs?: number,
  priority = true,
): Promise<ResolvedPlayableStream> {
  const t0 = performance.now();
  const ytId = extractYtVideoId(tr);
  if (isYouTubeTrack(tr) && ytId) {
    const res = await ytDlpTrackStream(ytId, { requestId, clickTsMs: clickEpochMs, priority });
    return {
      url: res.url,
      hls: false,
      preview: false,
      cacheHit: res.cacheHit,
      resolveMs: res.resolveMs ?? Math.round(performance.now() - t0),
      attempts: res.attempts,
    };
  }
  if (tr.source === 'soundcloud' && tr.nativeId) {
    const scRes = await trackStream(tr.nativeId);
    const scMs = Math.round(performance.now() - t0);
    return {
      ...scRes,
      resolveMs: scMs,
      attempts: [{ method: 'soundcloud: trackStream', outcome: scRes.url ? 'ok' : 'empty', durationMs: scMs }],
    };
  }
  return {
    url: tr.src,
    hls: false,
    preview: Boolean(tr.preview),
    resolveMs: 0,
    attempts: [{ method: 'direct_src', outcome: 'ok', durationMs: 0 }],
  };
}

/**
 * Ждёт готовности потока на `<audio>` (`canplay` / `loadeddata` или `readyState >= 2`) с проверкой `requestId`
 * перед вызовом `el.play()`, чтобы исключить ложные `pause`/`error` во время резолва.
 */
async function waitForAudioStreamReady(deck: Deck, expectedRequestId: number, timeoutMs = 12000): Promise<boolean> {
  const el = deck.el;
  if (expectedRequestId !== currentRequestId || deck.requestId !== expectedRequestId) return false;
  if (el.readyState >= 2) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener('loadeddata', onReady);
      el.removeEventListener('canplay', onReady);
      el.removeEventListener('error', onError);
      resolve(ok && expectedRequestId === currentRequestId && deck.requestId === expectedRequestId);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => {
      // Если по таймауту метаданные уже есть — пробуем запустить play()
      finish(el.readyState >= 1);
    }, timeoutMs);

    el.addEventListener('loadeddata', onReady, { once: true });
    el.addEventListener('canplay', onReady, { once: true });
    el.addEventListener('error', onError, { once: true });
  });
}

async function attachStreamToDeck(deck: Deck, stream: { url: string; hls: boolean }) {
  if (isDspNeeded()) {
    ensureDeckDsp(deck);
    resumeAudioContextIfNeeded();
  }
  if (deck.hls) {
    try {
      deck.hls.destroy();
    } catch {
      /* ignore */
    }
    deck.hls = undefined;
  }
  deck.el.loop = false;
  deck.el.crossOrigin = 'anonymous';
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
  const triggerRequestId = currentRequestId;
  if (preloadingNextForLoadId === triggerRequestId || crossfadeSession) return;

  const s = player.get();
  const curTr = currentTrack();
  if (!curTr || usesProviderPlayback(curTr)) return;

  const target = resolveNextQueueIndex(1, true);
  if (target === null || target === 'end-shuffle') return;

  const nextIdx = target === 'repeat-one' ? s.index : target;
  const nextId = s.queue[nextIdx];
  const nextTr = nextId ? getTrack(nextId) : undefined;
  if (!nextTr || usesProviderPlayback(nextTr)) return;

  preloadingNextForLoadId = triggerRequestId;

  try {
    const stream = await resolvePlayableStream(nextTr, undefined, undefined, false);
    if (triggerRequestId !== currentRequestId || crossfadeSession) return;
    if (!stream.url || (nextTr.source === 'soundcloud' && stream.preview)) return;

    const toDeck = getInactiveDeck();
    if (toDeck.trackId === nextId && toDeck.queueIndex === nextIdx && toDeck.preloadedForLoadId === triggerRequestId && toDeck.el.src) {
      return;
    }
    stopAndResetDeck(toDeck);
    toDeck.trackId = nextId;
    toDeck.queueIndex = nextIdx;
    toDeck.fadeMultiplier = 0;
    toDeck.preloadedForLoadId = triggerRequestId;
    syncDeckVolumes();

    await attachStreamToDeck(toDeck, stream);
    if (triggerRequestId !== currentRequestId || crossfadeSession) {
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

function isConfirmedYtUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (!msg.includes('yt-dlp')) return false;
  return (
    msg.includes('video unavailable') ||
    msg.includes('video is not available') ||
    msg.includes('private video') ||
    msg.includes('has been removed') ||
    msg.includes('account associated with this video has been terminated') ||
    msg.includes('copyright claim') ||
    msg.includes('not available in your country') ||
    msg.includes('blocked it in your country') ||
    msg.includes('members-only') ||
    msg.includes('join this channel to get access') ||
    msg.includes('sign in to confirm your age') ||
    msg.includes('inappropriate for some users')
  );
}

/* ---------------- controls ---------------- */
async function fallbackSoundCloud(track: Track, index: number, reqId: number): Promise<boolean> {
  if (reqId !== currentRequestId || fallbackAttemptedGeneration === reqId) return true;
  fallbackAttemptedGeneration = reqId;
  logTrackTiming(reqId, 'fallback_start', `track="${track.title}" source=${track.source}`);
  const manualSearchQuery = `${track.artist ? `${track.artist} - ` : ''}${track.title}`.trim();
  try {
    const rawFallback = await findYouTubeFallback(track);
    if (reqId !== currentRequestId || currentTrack()?.id !== track.id) return true;
    if (!rawFallback) {
      setPlayerMachineState('error');
      snack('Не удалось воспроизвести оригинал', {
        label: 'Найти вручную',
        run: () => openSearch(manualSearchQuery),
      });
      return true;
    }
    const fallback: Track = {
      ...rawFallback,
    };
    registerTracks([fallback]);
    if (player.get().shuffle) recommendationSource.set(fallback.id, track);
    const queue = player.get().queue.slice();
    queue[index] = fallback.id;
    player.set({ queue });
    snack(`Заменён на доступную версию: ${fallback.artist} — ${fallback.title}`);
    await load(index, true);
  } catch {
    if (reqId !== currentRequestId) return true;
    setPlayerMachineState('error');
    snack('Не удалось воспроизвести оригинал', {
      label: 'Найти вручную',
      run: () => openSearch(manualSearchQuery),
    });
  }
  return true;
}

interface LoadOptions {
  crossfadeSec?: number;
}

async function load(i: number, autoplay: boolean, opts?: LoadOptions) {
  const priorVisualFraction = displayedProgressFraction();
  const reqId = ++currentRequestId;
  const clickPerfMs = performance.now();
  const clickEpochMs = Date.now();
  const s = player.get();
  const id = s.queue[i];
  const tr = id ? getTrack(id) : undefined;
  if (!tr) return;

  activeTrace = {
    requestId: reqId,
    trackId: tr.id,
    title: tr.title,
    source: tr.source ?? 'unknown',
    clickPerfMs,
    clickEpochMs,
    attempts: [],
  };

  logTrackTiming(
    reqId,
    'track_click',
    `track="${tr.title}" id=${tr.id} source=${tr.source ?? 'unknown'} clickEpochMs=${clickEpochMs}`,
    clickPerfMs,
  );

  // При новом клике отменяем отложенный низкоприоритетный префетч старого трека
  if (prefetchTimer !== null) {
    clearTimeout(prefetchTimer);
    prefetchTimer = null;
  }

  const currentDeck = getActiveDeck();
  const canCrossfadeFromCurrent =
    autoplay &&
    s.crossfadeEnabled &&
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

  if (canCrossfadeFromCurrent) {
    const fadeDuration = opts!.crossfadeSec!;
    const fromDeck = getActiveDeck();
    const toDeck = getInactiveDeck();
    stopAndResetDeck(toDeck);
    toDeck.trackId = id;
    toDeck.queueIndex = i;
    toDeck.requestId = reqId;
    toDeck.fadeMultiplier = 0;
    syncDeckVolumes();

    activeDeckIdx = toDeck.id;
    audio = toDeck.el;
    setPlayerMachineState('loading', { requestId: reqId, index: i, duration: tr.duration, pos: 0 });

    try {
      activeTrace.resolveStartedPerfMs = performance.now();
      logTrackTiming(reqId, 'resolve_start', `mode=crossfade source=${tr.source ?? 'unknown'}`, clickPerfMs);

      const stream = await resolvePlayableStream(tr, reqId, clickEpochMs);
      if (reqId !== currentRequestId) {
        logTrackTiming(reqId, 'stale_aborted', `after=resolve_stream currentRequestId=${currentRequestId}`, clickPerfMs);
        stopAndResetDeck(fromDeck);
        return;
      }

      if (stream.attempts?.length) {
        activeTrace.attempts = stream.attempts;
        stream.attempts.forEach((att, idx) => {
          logTrackTiming(
            reqId,
            'resolve_attempt',
            `#${idx + 1} method="${att.method}" outcome="${att.outcome}" duration_ms=${att.durationMs}`,
            clickPerfMs,
          );
        });
      }
      logTrackTiming(
        reqId,
        'resolve_complete',
        `cacheHit=${Boolean(stream.cacheHit)} resolve_ms=${stream.resolveMs ?? 0}`,
        clickPerfMs,
      );

      if ((tr.source === 'soundcloud' && stream.preview) || !stream.url) {
        stopAndResetDeck(fromDeck);
        toDeck.fadeMultiplier = 1;
        syncDeckVolumes();
        await fallbackSoundCloud(tr, i, reqId);
        return;
      }
      await attachStreamToDeck(toDeck, stream);
      logTrackTiming(reqId, 'audio_src_assigned', `mode=crossfade src="${toDeck.el.src}"`, clickPerfMs);
      if (reqId !== currentRequestId) {
        stopAndResetDeck(fromDeck);
        return;
      }

      const streamReady = await waitForAudioStreamReady(toDeck, reqId);
      if (!streamReady || reqId !== currentRequestId) {
        stopAndResetDeck(fromDeck);
        return;
      }

      resumeAudioContextIfNeeded();
      await toDeck.el.play();
      if (reqId !== currentRequestId) {
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
      if (reqId !== currentRequestId) return;
      stopAndResetDeck(fromDeck);
      toDeck.fadeMultiplier = 1;
      syncDeckVolumes();
      if (tr.source === 'soundcloud' || (isYouTubeTrack(tr) && isConfirmedYtUnavailableError(e))) {
        await fallbackSoundCloud(tr, i, reqId);
        return;
      }
      setPlayerMachineState('error', { isCrossfading: false, fadeProgress: 0 });
      snack(e instanceof Error ? e.message : t('cantPlay'));
      return;
    }

    if (reqId !== currentRequestId) return;
    if (tr.source === 'soundcloud') void prefetchRelated(tr);
    scheduleLowPriorityUpcomingPrefetch(reqId, i);
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
  deck.requestId = reqId;
  deck.fadeMultiplier = 1;
  syncDeckVolumes();
  audio = deck.el;

  // Строгий переход в состояние 'loading' сразу по клику до начала резолва
  setPlayerMachineState('loading', {
    requestId: reqId,
    index: i,
    duration: tr.duration,
    pos: 0,
    isCrossfading: false,
    fadeProgress: 0,
  });

  if (usesProviderPlayback(tr)) {
    setPlayerMachineState(autoplay ? 'playing' : 'paused');
    if (autoplay) providerCommand('play');
    pushRecent(id);
    mediaMeta(tr);
    emitFrame();
    emitTime();
    return;
  }
  try {
    activeTrace.resolveStartedPerfMs = performance.now();
    logTrackTiming(reqId, 'resolve_start', `mode=direct source=${tr.source ?? 'unknown'}`, clickPerfMs);

    const stream = await resolvePlayableStream(tr, reqId, clickEpochMs);
    if (reqId !== currentRequestId) {
      logTrackTiming(reqId, 'stale_aborted', `after=resolve_stream currentRequestId=${currentRequestId}`, clickPerfMs);
      return;
    }

    if (stream.attempts?.length) {
      activeTrace.attempts = stream.attempts;
      stream.attempts.forEach((att, idx) => {
        logTrackTiming(
          reqId,
          'resolve_attempt',
          `#${idx + 1} method="${att.method}" outcome="${att.outcome}" duration_ms=${att.durationMs}`,
          clickPerfMs,
        );
      });
    }
    logTrackTiming(
      reqId,
      'resolve_complete',
      `cacheHit=${Boolean(stream.cacheHit)} resolve_ms=${stream.resolveMs ?? 0}`,
      clickPerfMs,
    );

    if ((tr.source === 'soundcloud' && stream.preview) || !stream.url) {
      await fallbackSoundCloud(tr, i, reqId);
      return;
    }
    await attachStreamToDeck(deck, stream);
    logTrackTiming(reqId, 'audio_src_assigned', `mode=direct src="${deck.el.src}"`, clickPerfMs);
    if (reqId !== currentRequestId) return;

    if (autoplay) {
      const streamReady = await waitForAudioStreamReady(deck, reqId);
      if (!streamReady || reqId !== currentRequestId) return;
      try {
        resumeAudioContextIfNeeded();
        await deck.el.play();
      } catch (playErr) {
        if (reqId !== currentRequestId) return;
        logTrackTiming(
          reqId,
          'play_rejected',
          `err="${playErr instanceof Error ? playErr.message : String(playErr)}"`,
          clickPerfMs,
        );
        setPlayerMachineState('paused');
      }
    } else {
      setPlayerMachineState('paused');
    }
  } catch (e) {
    if (reqId !== currentRequestId) return;
    const errAttempts = (e as Error & { attempts?: YtResolveAttemptTiming[] })?.attempts;
    if (errAttempts?.length) {
      errAttempts.forEach((att, idx) => {
        logTrackTiming(
          reqId,
          'resolve_attempt',
          `#${idx + 1} method="${att.method}" outcome="${att.outcome}" duration_ms=${att.durationMs}`,
          clickPerfMs,
        );
      });
    }
    if (tr.source === 'soundcloud' || (isYouTubeTrack(tr) && isConfirmedYtUnavailableError(e))) {
      await fallbackSoundCloud(tr, i, reqId);
      return;
    }
    setPlayerMachineState('error');
    snack(e instanceof Error ? e.message : t('cantPlay'));
    return;
  }
  if (reqId !== currentRequestId) return;
  if (tr.source === 'soundcloud') void prefetchRelated(tr);
  scheduleLowPriorityUpcomingPrefetch(reqId, i);
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
  const triggerRequestId = currentRequestId;
  if (autoCrossfadePreparingForLoadId === triggerRequestId || crossfadeSession) return;

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

  autoCrossfadePreparingForLoadId = triggerRequestId;

  try {
    const toDeck = getInactiveDeck();
    const alreadyPreloaded =
      toDeck.trackId === nextId &&
      toDeck.queueIndex === nextIdx &&
      toDeck.preloadedForLoadId === triggerRequestId &&
      Boolean(toDeck.el.src);

    if (!alreadyPreloaded) {
      const stream = await resolvePlayableStream(nextTr);
      if (triggerRequestId !== currentRequestId || crossfadeSession || fromDeck.el.paused) return;
      if (!stream.url || (nextTr.source === 'soundcloud' && stream.preview)) {
        return;
      }
      stopAndResetDeck(toDeck);
      toDeck.trackId = nextId;
      toDeck.queueIndex = nextIdx;
      toDeck.fadeMultiplier = 0;
      syncDeckVolumes();
      await attachStreamToDeck(toDeck, stream);
      if (triggerRequestId !== currentRequestId || crossfadeSession || fromDeck.el.paused) {
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
    const reqId = ++currentRequestId;
    const clickPerfMs = performance.now();
    const clickEpochMs = Date.now();
    activeTrace = {
      requestId: reqId,
      trackId: nextTr.id,
      title: nextTr.title,
      source: nextTr.source ?? 'unknown',
      clickPerfMs,
      clickEpochMs,
      attempts: [{ method: 'auto_crossfade_preload', outcome: 'ok', durationMs: 0 }],
    };
    logTrackTiming(reqId, 'track_click', `mode=auto_crossfade track="${nextTr.title}" id=${nextTr.id}`, clickPerfMs);

    toDeck.requestId = reqId;
    activeDeckIdx = toDeck.id;
    audio = toDeck.el;
    lastSaved = 0;
    ensureCached(nextId);
    const nextDur = (isFinite(toDeck.el.duration) && toDeck.el.duration > 0 ? toDeck.el.duration : nextTr.duration) || 0;
    setPlayerMachineState('playing', {
      requestId: reqId,
      index: nextIdx,
      duration: nextDur || nextTr.duration,
      pos: 0,
    });

    resumeAudioContextIfNeeded();
    await toDeck.el.play();
    if (reqId !== currentRequestId) {
      stopAndResetDeck(fromDeck);
      return;
    }

    startCrossfadeRamp(fromDeck, toDeck, fadeSec, 'auto', startFraction, nextDur || nextTr.duration);
    if (nextTr.source === 'soundcloud') void prefetchRelated(nextTr);
    scheduleLowPriorityUpcomingPrefetch(reqId, nextIdx);
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
  const manualFade = getCrossfadeDuration() > 0 ? MANUAL_CROSSFADE_SECONDS : 0;
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
    setPlayerMachineState('paused');
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
  // Запрещаем дёргать <audio> во время резолва трека (state === 'loading'), чтобы не провоцировать ложные pause/error
  if (s.state === 'loading' || s.loading) return;
  const track = currentTrack();
  if (usesProviderPlayback(track)) {
    const playing = !s.playing;
    providerCommand(playing ? 'play' : 'pause');
    setPlayerMachineState(playing ? 'playing' : 'paused');
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
    resumeAudioContextIfNeeded();
    resumeCrossfadeIfPaused();
    activeEl.play().catch(() => setPlayerMachineState('paused'));
  } else {
    pauseCrossfadeIfActive();
    activeEl.pause();
  }
}

function step(dir: 1 | -1, auto: boolean) {
  const s = player.get();
  const n = s.queue.length;
  if (!n) return;
  const activeFadeSec = getCrossfadeDuration();
  if (auto && s.repeat === 'one') {
    if (usesProviderPlayback(currentTrack())) {
      providerCommand('seek', 0);
      providerCommand('play');
      return;
    }
    if (activeFadeSec > 0 && dur() > activeFadeSec * 2) {
      void load(s.index, true, { crossfadeSec: activeFadeSec });
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
    setPlayerMachineState('paused');
    return;
  }
  const manualFade = !auto && activeFadeSec > 0 ? MANUAL_CROSSFADE_SECONDS : 0;
  void load(target, true, { crossfadeSec: manualFade });
}

export const next = (auto = false) => step(1, auto);
export function prev() {
  if (realCurTime() > 3 && !crossfadeSession) seek(0);
  else step(-1, false);
}
export const jumpTo = (i: number) => {
  const manualFade = getCrossfadeDuration() > 0 ? MANUAL_CROSSFADE_SECONDS : 0;
  return load(i, true, { crossfadeSec: manualFade });
};

export function seek(sec: number) {
  const active = getActiveDeck();
  const activeEl = active.el;
  const totalDur = dur();

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

/* ---------------- audio events (strictly isolated by deck & requestId) ---------------- */
onProviderState((state) => {
  if (state.ended) {
    next(true);
    return;
  }
  const nextState: PlayerPlaybackState = state.loading
    ? 'loading'
    : state.playing
      ? 'playing'
      : 'paused';
  setPlayerMachineState(nextState, { pos: state.position, duration: state.duration });
  emitFrame();
  emitTime();
});

let lastSaved = 0;

function isCurrentDeckEvent(deck: Deck): boolean {
  return deck === getActiveDeck() && deck.requestId > 0 && deck.requestId === currentRequestId;
}

function bindDeckEvents(deck: Deck) {
  const el = deck.el;

  el.addEventListener('play', () => {
    if (!isCurrentDeckEvent(deck)) return;
    // Во время 'loading' ждём фактического 'playing', чтобы кнопка Play/Pause не мигала раньше времени
    if (player.get().state !== 'loading') {
      setPlayerMachineState('playing');
    }
    kick();
  });

  el.addEventListener('playing', () => {
    if (!isCurrentDeckEvent(deck)) return;
    const reqId = deck.requestId;
    if (activeTrace && activeTrace.requestId === reqId && !activeTrace.playingLogged) {
      activeTrace.playingLogged = true;
      logTrackTiming(
        reqId,
        'audio_playing',
        `track="${activeTrace.title}" readyState=${el.readyState} currentTime=${el.currentTime.toFixed(2)}s`,
        activeTrace.clickPerfMs,
      );
    }
    setPlayerMachineState('playing');
    errors = 0;
    kick();
  });

  el.addEventListener('pause', () => {
    if (!isCurrentDeckEvent(deck)) return;
    // Игнорируем паразитные события pause, пока идёт резолв/буферизация ('loading') или автопереход ('ended')
    if (player.get().state === 'loading' || player.get().loading || el.ended) return;
    setPlayerMachineState('paused', { pos: el.src ? el.currentTime : 0 });
  });

  el.addEventListener('waiting', () => {
    if (!isCurrentDeckEvent(deck)) return;
    if (el.src && player.get().state === 'playing') {
      setPlayerMachineState('loading');
    }
  });

  el.addEventListener('loadeddata', () => {
    if (!isCurrentDeckEvent(deck)) return;
    const reqId = deck.requestId;
    if (activeTrace && activeTrace.requestId === reqId && !activeTrace.proxyTtfbLogged) {
      activeTrace.proxyTtfbLogged = true;
      logTrackTiming(
        reqId,
        'proxy_first_byte_received',
        `readyState=${el.readyState} src="${el.currentSrc || el.src}"`,
        activeTrace.clickPerfMs,
      );
    }
  });

  el.addEventListener('canplay', () => {
    if (!isCurrentDeckEvent(deck)) return;
    const reqId = deck.requestId;
    if (activeTrace && activeTrace.requestId === reqId && !activeTrace.canplayLogged) {
      activeTrace.canplayLogged = true;
      logTrackTiming(
        reqId,
        'audio_canplay',
        `readyState=${el.readyState} src="${el.currentSrc || el.src}"`,
        activeTrace.clickPerfMs,
      );
    }
    if (!el.paused) {
      setPlayerMachineState('playing');
    }
  });

  el.addEventListener('ended', () => {
    if (deck !== getActiveDeck()) {
      stopAndResetDeck(deck);
      return;
    }
    if (deck.requestId !== currentRequestId) return;
    next(true);
  });

  el.addEventListener('loadedmetadata', () => {
    if (!isCurrentDeckEvent(deck)) return;
    const reqId = deck.requestId;
    const track = currentTrack();
    if (track?.source === 'soundcloud' && track.duration > 75 && el.duration > 0 && el.duration <= 60 && el.duration + 10 < track.duration) {
      void fallbackSoundCloud(track, player.get().index, reqId);
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
    if (!isCurrentDeckEvent(deck)) return;
    if (crossfadeSession) return;

    const track = currentTrack();
    const duration = dur();
    const remaining = duration - el.currentTime;

    if (player.get().shuffle && track?.source === 'soundcloud' && duration > 0 && remaining <= 20) {
      void prefetchRelated(track);
    }

    const fadeSec = effectiveAutoCrossfadeSeconds(duration);
    if (fadeSec > 0 && duration > 0 && !el.paused && el.currentTime >= 1) {
      if (
        preloadingNextForLoadId !== currentRequestId &&
        remaining > fadeSec + 0.5 &&
        remaining <= Math.max(fadeSec + 8, PRELOAD_AHEAD_SECONDS)
      ) {
        void preloadNextTrackIntoInactiveDeck();
      }
      if (autoCrossfadePreparingForLoadId !== currentRequestId && remaining > 0.25 && remaining <= fadeSec + 0.25) {
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
    if (!isCurrentDeckEvent(deck) || crossfadeSession) return;
    emitFrame();
    emitTime();
  });

  el.addEventListener('error', () => {
    if (!el.src || !el.error) return;
    if (deck !== getActiveDeck()) {
      stopAndResetDeck(deck);
      return;
    }
    if (deck.requestId !== currentRequestId) return;
    const reqId = deck.requestId;
    logTrackTiming(reqId, 'audio_error', `code=${el.error?.code ?? 0} message="${el.error?.message ?? ''}"`);
    const track = currentTrack();
    const index = player.get().index;
    if (track && track.source === 'soundcloud') {
      void fallbackSoundCloud(track, index, reqId);
      return;
    }
    setPlayerMachineState('error', { isCrossfading: false, fadeProgress: 0 });
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
    normalizationEnabled: s.normalizationEnabled,
    normalizationTarget: s.normalizationTarget,
    crossfadeEnabled: s.crossfadeEnabled,
    crossfadeDuration: s.crossfadeDuration,
    crossfadeCurve: s.crossfadeCurve,
    eqPreset: s.eqPreset,
    eqGains: s.eqGains,
  }));
  const s = player.get();
  const curId = s.queue[s.index];
  const q = s.queue.filter((id) => getTrack(id));
  const idx = curId ? q.indexOf(curId) : -1;
  setPlayerMachineState('idle', {
    queue: q,
    index: idx,
    pos: idx >= 0 ? s.pos : 0,
    crossfadeDuration: clamp(s.crossfadeDuration || DEFAULT_CROSSFADE_DURATION, 1, 12),
    isCrossfading: false,
    fadeProgress: 0,
  });
  refreshAllDspChains();
  pendingSeek = idx >= 0 && q[idx] ? createPendingAudioSeek(q[idx], s.pos) : null;
  const cur = currentTrack();
  if (cur) mediaMeta(cur);
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const h: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => toggle()],
      ['pause', () => {
        if (player.get().state === 'loading') return;
        if (usesProviderPlayback(currentTrack())) {
          providerCommand('pause');
          setPlayerMachineState('paused');
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
