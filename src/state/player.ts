import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type Hls from 'hls.js';
import { createStore, persist, clamp, shuffled, useStore } from '../lib/util';
import { getTrack, library, pushRecent, isDisliked, ensureCached, registerTracks } from './library';
import { snack, openSearch, go } from './ui';
import { t } from '../lib/i18n';
import { findYouTubeFallback, relatedSoundCloudTracks, searchYouTubeRecommendations, trackStream, ytDlpTrackStream } from '../lib/api';
import type { YtResolveAttemptTiming, YtStreamResolveResult } from '../lib/providers-api';
import { insertRecommendations, rankRecommendations, recommendationSeedIds } from '../lib/recommendations';
import { playbackAccess } from '../lib/playback-access';
import { createPendingAudioSeek, pendingAudioSeekFor, type PendingAudioSeek } from '../lib/pending-audio-seek';
import { canFallbackToOutgoingDeck, evaluateAutoCrossfadeTrigger, planAutoCrossfade } from '../lib/crossfade-plan';
import { stepQueueIndex, shouldAdvanceAfterError } from '../lib/player-queue';
import { isLocalTrack, localStreamUrl } from './local-library';
import { clampFx, FX_OFF, FX_PRESETS, makeImpulse, type FxPreset, type FxSettings } from '../lib/audio-fx';
import { isWebKitPlaybackUserAgent, webkitDoubledDuration as detectWebkitDoubledDuration } from '../lib/webkit-playback';
import { isSoundCloudAuthError } from '../lib/soundcloud-auth';
import { onProviderState, providerCommand } from '../lib/provider-player';
import type { Track } from '../types';

export const setPlaybackControlLock = (locked: boolean) => playbackAccess.setLocked(locked);
export const withRemotePlayback = <T,>(action: () => T): T => playbackAccess.withRemote(action);

export function usePlaybackControlLocked() {
  return useSyncExternalStore(
    (onChange) => playbackAccess.subscribeLock(() => onChange()),
    () => playbackAccess.isLocked(),
    () => false,
  );
}

playbackAccess.subscribeLock((locked) => {
  if (locked) {
    clearAutoCrossfadeTimer();
    if (autoCrossfadePreparingForLoadId >= 0 && !crossfadeSession) {
      currentRequestId += 1;
      resolveAbort?.abort();
      resolveAbort = null;
      const inactive = getInactiveDeck();
      if (inactive !== getActiveDeck()) stopAndResetDeck(inactive);
      autoCrossfadePreparingForLoadId = -1;
    }
    if (crossfadeSession) cancelCrossfade(true);
  } else {
    scheduleAutoCrossfadeCheck();
  }
});

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

/**
 * hls.js нужен только для HLS-фолбэка SoundCloud, поэтому грузится лениво:
 * разбор и исполнение модуля откладываются до первого HLS-потока (лямбда-обёртка
 * сохраняется даже в single-file сборке), поведение при воспроизведении идентично
 * статическому импорту.
 */
type HlsCtor = typeof Hls;
let hlsCtor: HlsCtor | null = null;
let hlsLoading: Promise<HlsCtor> | null = null;
const loadHls = (): Promise<HlsCtor> => {
  if (hlsCtor) return Promise.resolve(hlsCtor);
  hlsLoading ??= import('hls.js').then((m) => (hlsCtor = m.default));
  return hlsLoading;
};
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
  /** Post-EQ tap for the fullscreen equalizer's live spectrum (never connected to the output). */
  analyser: AnalyserNode;
  /** Parallel wet branch for the reverb effect. */
  convolver: ConvolverNode;
  wetGain: GainNode;
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
  recoveryAttempts?: number;
  forcedEndDone?: boolean;
}

function createAudioElement(): HTMLAudioElement {
  const el = new Audio();
  el.preload = 'auto';
  el.loop = false;
  el.crossOrigin = 'anonymous';
  return el;
}

const decks: [Deck, Deck] = [
  { id: 0, el: createAudioElement(), fadeMultiplier: 1, trackId: null, queueIndex: -1, requestId: 0, recoveryAttempts: 0 },
  { id: 1, el: createAudioElement(), fadeMultiplier: 0, trackId: null, queueIndex: -1, requestId: 0, recoveryAttempts: 0 },
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
  // Speed / pitch / reverb
  fx: FX_OFF as FxSettings,
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
  /** performance.now() последнего кадра (rAF или фолбэк-таймера): сторож не должен дублировать шаги. */
  lastFrameAt: number;
  rafId: number;
  /**
   * Fallback driver: rAF полностью замирает, когда окно уходит в фон (WebKit/App Nap),
   * из-за чего фейд зависает на progress=0 и входящий трек играет с gain=0 (тишина).
   * setInterval продолжает тикать в фоне и доводит фейд до конца.
   */
  fallbackTimer: number | null;
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
let autoCrossfadeTimer: number | null = null;

function clearAutoCrossfadeTimer() {
  if (autoCrossfadeTimer !== null) {
    clearTimeout(autoCrossfadeTimer);
    autoCrossfadeTimer = null;
  }
}

let original: string[] | null = null;
let pendingSeek: PendingAudioSeek | null = null;
let errors = 0;
let currentRequestId = 0;
let fallbackAttemptedTrackId: string | null = null;
let fallbackController: AbortController | null = null;
// Aborted whenever a new load starts, so a stale skip's stream resolve (and its sidecar
// fallback cascade) stops immediately instead of piling up behind newer requests.
let resolveAbort: AbortController | null = null;
const relatedFetched = new Set<string>();
const recommendationSource = new Map<string, Track>();
/** relatedFetched/recommendationSource живут всю сессию: самые старые записи вытесняем, иначе они растут по строке на трек. */
const TRACK_CACHE_LIMIT = 200;
function trimTrackCache<K>(cache: { size: number; keys(): IterableIterator<K>; delete(key: K): unknown }) {
  for (const key of cache.keys()) {
    if (cache.size <= TRACK_CACHE_LIMIT) return;
    cache.delete(key);
  }
}
const ytStreamPrefetch = new Map<string, Promise<YtStreamResolveResult>>();
// Short-lived resolved prefetches so a click shortly after hover/queue warm-up can reuse them (Rust cache lasts longer).
const ytPrefetchResolved = new Map<string, { res: YtStreamResolveResult; at: number }>();
const YT_PREFETCH_REUSE_MS = 120_000;
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
  // Дублируем в файловый журнал (~/.resonance/player-timing.log): в установленном приложении
  // консоль вебвью недоступна, а файл позволяет диагностировать долгую загрузку/удвоение таймера.
  void invoke('frontend_log', { message: `reqId=${reqId} +${sinceClick}ms stage=${stage} ${details}` }).catch(() => {});
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
  if (track.id.startsWith('yt:')) return track.id.slice(3).split('~')[0].trim();
  return '';
};
const isYouTubeTrack = (track: Track | null | undefined): boolean =>
  !!track && (track.source === 'youtube' || (track.source as string) === 'ytmusic' || track.id.startsWith('yt:'));
const usesProviderPlayback = (track: Track | null | undefined) =>
  !!track && isYouTubeTrack(track) && track.playback !== 'direct' && !extractYtVideoId(track);

// Предзагружаем следующие N+1..N+4 трека вперёд и топ-8 треков плейлиста через нативный InnerTube-прокси
const YT_STREAM_PREFETCH_AHEAD = 4;
const YT_Playlist_TOP_PREFETCH = 8;

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

/** How many views currently want the live spectrum (it needs the Web Audio graph to exist). */
let spectrumConsumers = 0;

const isReverbActive = () => player.get().fx.reverb > 0.001;

function isDspNeeded(): boolean {
  return player.get().normalizationEnabled || isEqActive() || isReverbActive() || spectrumConsumers > 0;
}

/** Both decks share one impulse response; it only depends on the sample rate. */
let impulseBuffer: AudioBuffer | null = null;
function getImpulse(ctx: AudioContext): AudioBuffer {
  if (impulseBuffer && impulseBuffer.sampleRate === ctx.sampleRate) return impulseBuffer;
  const [l, r] = makeImpulse(ctx.sampleRate);
  const buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
  buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
  impulseBuffer = buf;
  return buf;
}

/** Applies speed/pitch to both decks; defaultPlaybackRate makes it survive new sources. */
function applyPlaybackRate() {
  const { speed, keepPitch } = player.get().fx;
  for (const deck of decks) {
    const el = deck.el as HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean };
    el.preservesPitch = keepPitch;
    el.webkitPreservesPitch = keepPitch;
    el.defaultPlaybackRate = speed;
    el.playbackRate = speed;
  }
}

export function setFx(patch: Partial<FxSettings>) {
  const next = clampFx({ ...player.get().fx, ...patch });
  player.set({ fx: next });
  applyPlaybackRate();
  refreshAllDspChains();
}

export const setFxPreset = (preset: Exclude<FxPreset, 'custom'>) => setFx(FX_PRESETS[preset]);

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
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.78;
    analyser.minDecibels = -92;
    analyser.maxDecibels = -18;

    // Brickwall safety limiter at -1.0 dBFS to guarantee zero clipping even when preGain or EQ boost > 1.0
    limiter.threshold.value = -1.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;

    const convolver = ctx.createConvolver();
    convolver.buffer = getImpulse(ctx);
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0;
    convolver.connect(wetGain);

    deck.dsp = { ctx, source, preGain, eqFilters, compressor, limiter, channelGain, analyser, convolver, wetGain };
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
    dsp.wetGain.disconnect();
  } catch {
    /* ignore */
  }

  applyEqGainsToDsp(dsp);
  const reverbOn = isReverbActive();
  // Up to ~-1.5 dB wet at full mix: a pleasant hall, never a wash.
  dsp.wetGain.gain.setTargetAtTime(reverbOn ? player.get().fx.reverb * 0.85 : 0, now, 0.05);

  if (normalizationEnabled || eqActive || reverbOn) {
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

    if (reverbOn) {
      prev.connect(dsp.convolver);
      dsp.wetGain.connect(dsp.limiter);
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
  // Side tap only: an analyser that feeds nothing, so the audible signal is untouched.
  dsp.channelGain.connect(dsp.analyser);
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
      const g = deck.dsp.channelGain.gain;
      const now = deck.dsp.ctx.currentTime;
      if (isWebKitPlayback()) {
        // WebKit (macOS WKWebView) does not reliably apply a stream of setTargetAtTime events
        // (the volume slider fires one per pointer move): the parameter can stay at its old value.
        // Cancel what is pending and ramp linearly; a suspended context can't run automation
        // at all, so there the value is assigned directly.
        g.cancelScheduledValues(now);
        if (deck.dsp.ctx.state === 'running') {
          g.setValueAtTime(g.value, now);
          g.linearRampToValueAtTime(finalGain, now + 0.02);
        } else {
          g.value = finalGain;
        }
      } else {
        g.setTargetAtTime(finalGain, now, 0.008);
      }
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
  deck.recoveryAttempts = 0;
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
  clearAutoCrossfadeTimer();
  if (crossfadeSession) {
    if (crossfadeSession.rafId) {
      cancelAnimationFrame(crossfadeSession.rafId);
    }
    if (crossfadeSession.fallbackTimer !== null) {
      clearInterval(crossfadeSession.fallbackTimer);
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

function stepCrossfadeFrame(now: number, schedule = true) {
  const session = crossfadeSession;
  if (!session || session.paused) return;
  session.lastFrameAt = now;
  if (session.lastTs !== null) {
    const dt = Math.max(0, (now - session.lastTs) / 1000);
    session.elapsedSec += dt;
  }
  session.lastTs = now;

  // Keep incoming deck alive if WebKit momentarily throttled or failed to resume it during crossfade
  const toEl = session.toDeck.el;
  if (toEl.paused && !toEl.ended && toEl.readyState >= 2 && session.toDeck === getActiveDeck()) {
    resumeAudioContextIfNeeded();
    void toEl.play().catch(() => {});
  }

  const progress = session.durationSec > 0 ? clamp(session.elapsedSec / session.durationSec, 0, 1) : 1;
  applyCrossfadeGains(session.fromDeck, session.toDeck, progress);

  const toDur = dur();
  if (toDur > 0) {
    session.endFadeFraction = clamp(session.durationSec / toDur, 0, 0.95);
  }

  // Подписчиков у fadeProgress нет: стор дёргаем только когда шаг визуально заметен.
  const rounded = Math.round(progress * 100) / 100;
  if (player.get().fadeProgress !== rounded) player.set({ fadeProgress: rounded });
  emitFrame();
  emitTime();

  if (progress >= 1) {
    finishCrossfade(session);
    return;
  }
  // Цепочку rAF заводит только она сама: фолбэк-таймер шагает без неё, иначе на каждый тик
  // появлялась лишняя параллельная цепочка (у 4-секундного фейда их набиралось ~17), и
  // отменить можно было только последнюю.
  if (schedule) session.rafId = requestAnimationFrame(stepCrossfadeFrame);
}

const CROSSFADE_FRAME_GRACE_MS = 200;

function startCrossfadeFallbackTimer(session: CrossfadeSession) {
  if (session.fallbackTimer !== null) return;
  session.fallbackTimer = window.setInterval(() => {
    if (crossfadeSession !== session || session.paused) return;
    const now = performance.now();
    if (now - session.lastFrameAt < CROSSFADE_FRAME_GRACE_MS) return;
    stepCrossfadeFrame(now, false);
  }, 250);
}

function stopCrossfadeFallbackTimer(session: CrossfadeSession) {
  if (session.fallbackTimer !== null) {
    clearInterval(session.fallbackTimer);
    session.fallbackTimer = null;
  }
}

function finishCrossfade(session: CrossfadeSession) {
  if (crossfadeSession !== session) return;
  if (session.rafId) cancelAnimationFrame(session.rafId);
  stopCrossfadeFallbackTimer(session);
  crossfadeSession = null;
  if (session.fromDeck !== getActiveDeck()) {
    stopAndResetDeck(session.fromDeck);
  }
  const active = getActiveDeck();
  active.fadeMultiplier = 1;
  syncDeckVolumes();
  const isActuallyPaused = active.el.paused && !active.el.ended;
  if (!isActuallyPaused) {
    player.set({ isCrossfading: false, fadeProgress: 0 });
  } else if (active.el.readyState >= 2) {
    resumeAudioContextIfNeeded();
    void active.el.play().catch(() => {});
    player.set({ isCrossfading: false, fadeProgress: 0 });
  } else {
    player.set({ isCrossfading: false, fadeProgress: 0 });
  }
  scheduleAutoCrossfadeCheck();
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
  if (crossfadeSession) {
    if (crossfadeSession.rafId) {
      cancelAnimationFrame(crossfadeSession.rafId);
    }
    stopCrossfadeFallbackTimer(crossfadeSession);
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
    lastFrameAt: performance.now(),
    rafId: 0,
    fallbackTimer: null,
    paused: false,
    kind,
    startFadeFraction: safeStart,
    endFadeFraction: safeEnd,
  };
  crossfadeSession = session;
  player.set({ isCrossfading: true, fadeProgress: 0 });
  session.rafId = requestAnimationFrame(stepCrossfadeFrame);
  startCrossfadeFallbackTimer(session);
}

function pauseCrossfadeIfActive() {
  if (!crossfadeSession) return;
  crossfadeSession.paused = true;
  crossfadeSession.lastTs = null;
  if (crossfadeSession.rafId) {
    cancelAnimationFrame(crossfadeSession.rafId);
    crossfadeSession.rafId = 0;
  }
  stopCrossfadeFallbackTimer(crossfadeSession);
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
  startCrossfadeFallbackTimer(crossfadeSession);
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
  if (!on) {
    clearAutoCrossfadeTimer();
    if (crossfadeSession) cancelCrossfade(true);
  } else {
    scheduleAutoCrossfadeCheck();
  }
}

export function setCrossfadeDuration(seconds: number) {
  if (seconds <= 0) {
    setCrossfadeEnabled(false);
    return;
  }
  const nextSec = Math.round(clamp(seconds, 1, 12) * 2) / 2;
  player.set({ crossfadeDuration: nextSec, crossfadeEnabled: true });
  scheduleAutoCrossfadeCheck();
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

/**
 * Asks for the live spectrum. Builds the Web Audio graph if it does not exist yet (the same graph
 * the equalizer and normalisation use) and returns a release function. The graph is not torn down on
 * release: a media element can only be wrapped once.
 */
export function acquireSpectrum(): () => void {
  spectrumConsumers++;
  refreshAllDspChains();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    spectrumConsumers = Math.max(0, spectrumConsumers - 1);
  };
}

/** Fills `out` with the current magnitude spectrum (0..255 per bin); returns the sample rate, or 0 if unavailable. */
export function readSpectrum(out: Uint8Array<ArrayBuffer>): number {
  const dsp = getActiveDeck().dsp;
  if (!dsp || dsp.ctx.state !== 'running') return 0;
  dsp.analyser.getByteFrequencyData(out);
  return dsp.ctx.sampleRate;
}

/** Number of bins `readSpectrum` expects. */
export const SPECTRUM_BINS = 2048;

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
  const track = currentTrack();
  const canExtendShuffle = Boolean(
    s.shuffle && track && (track.source === 'soundcloud' || isYouTubeTrack(track) || recommendationSource.has(track.id)),
  );
  return stepQueueIndex({
    queue: s.queue,
    index: s.index,
    dir,
    auto,
    repeat: s.repeat,
    shuffle: s.shuffle,
    isDisliked,
    canExtendShuffle,
  });
}

function prefetchYtStream(id?: string | null) {
  if (!id) return;
  if (ytStreamPrefetch.has(id)) return;
  const request = ytDlpTrackStream(id, { priority: false })
    .then(async (res) => {
      if (!res.url) return res;
      if (res.url.includes('/yt-stream/') && res.url.includes('t=')) {
        try {
          // Warm-up: triggers proxy 256 KiB head cache + waits out TVHTML5 CDN 403 activation window in background.
          const warm = await fetch(`${res.url}&prefetch=1`, { method: 'GET', cache: 'no-store' });
          void warm.body?.cancel().catch(() => {});
        } catch {
          // Background prefetch; playback path will handle misses.
        }
      }
      if (res.url) {
        for (const [key, hit] of ytPrefetchResolved) {
          if (Date.now() - hit.at >= YT_PREFETCH_REUSE_MS) ytPrefetchResolved.delete(key);
        }
        ytPrefetchResolved.set(id, { res, at: Date.now() });
      }
      return res;
    })
    .catch(() => ({ url: '' }))
    .finally(() => {
      if (ytStreamPrefetch.get(id) === request) ytStreamPrefetch.delete(id);
    });
  ytStreamPrefetch.set(id, request);
}

/** Click path: waits for an in-flight prefetch of the same video, then reuses it if still fresh (one-shot). */
async function takePrefetchedYtStream(id: string): Promise<YtStreamResolveResult | null> {
  const inflight = ytStreamPrefetch.get(id);
  if (inflight) await inflight;
  const hit = ytPrefetchResolved.get(id);
  ytPrefetchResolved.delete(id);
  return hit && Date.now() - hit.at < YT_PREFETCH_REUSE_MS ? hit.res : null;
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

    // Вперёд: N+1..N+2 (низкий приоритет), чтобы следующий трек чаще был готов до клика.
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
  }, 50);
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

/**
 * WebKit (Safari / macOS & iOS WKWebView) reports ~2x duration for YouTube/googlevideo audio
 * streams and pads the second half with silence (invidious#913, audioplayers#1730).
 * Detect the doubling against the known track metadata and clamp to the real duration.
 */
export function isWebKitPlayback(): boolean {
  return isWebKitPlaybackUserAgent(navigator.userAgent);
}

/** Returns the real duration when WebKit doubled it, otherwise null. */
function webkitDoubledDuration(track: Track | null | undefined, elDuration: number): number | null {
  if (!isWebKitPlayback() || !track || !isYouTubeTrack(track)) return null;
  return detectWebkitDoubledDuration(track.duration, elDuration);
}

export const dur = () => {
  const el = getActiveDeck().el;
  const doubled = webkitDoubledDuration(currentTrack(), el.duration);
  if (doubled !== null) return doubled;
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
let rafAt = 0;
function emitFrame() {
  const d = dur();
  const ct = curTime();
  const rt = realCurTime();
  frameSubs.forEach((f) => {
    // Один упавший подписчик не должен убивать цикл кадров для всех остальных.
    try {
      f(ct, d, rt);
    } catch (e) {
      console.error('[frame] subscriber failed', e);
    }
  });
}
function scheduleTick() {
  rafAt = performance.now();
  raf = requestAnimationFrame(tick);
}
function tick() {
  raf = 0;
  emitFrame();
  if (!getActiveDeck().el.paused && !crossfadeSession && frameSubs.size) scheduleTick();
}
/** WKWebView на macOS может заморозить/выбросить rAF при переходе окна в fullscreen: handle
 *  остаётся «живым», kick() видел `raf !== 0` и цикл больше не перезапускался — вся анимация,
 *  завязанная на onFrame (заливка строк лирики, seek, обложка), пропадала. Если коллбэк не
 *  приходил дольше STALL_MS, считаем rAF потерянным и ставим его заново. */
const RAF_STALL_MS = 500;
const kick = () => {
  if (crossfadeSession) return;
  if (raf && performance.now() - rafAt > RAF_STALL_MS) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  if (!raf) scheduleTick();
};
const revive = () => {
  try {
    if (frameSubs.size && !getActiveDeck().el.paused) kick();
  } catch {
    /* decks ещё не инициализированы */
  }
};
let reviveTimer: number | null = null;
/** Сторож нужен только пока есть подписчики onFrame: без них он бы тикал всю жизнь вхолостую. */
function startReviveTimer() {
  if (reviveTimer === null) reviveTimer = window.setInterval(revive, 400);
}
function stopReviveTimer() {
  if (reviveTimer !== null) {
    clearInterval(reviveTimer);
    reviveTimer = null;
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', revive);
  document.addEventListener('webkitfullscreenchange', revive);
  document.addEventListener('visibilitychange', revive);
  window.addEventListener('resize', revive);
  window.addEventListener('focus', revive);
}
/** Per-frame callback while playing (DOM writes only — avoids React re-renders). */
export function onFrame(f: (t: number, d: number, realT: number) => void) {
  frameSubs.add(f);
  // Страховочный сторож на случай, когда ни одно из событий выше не пришло.
  startReviveTimer();
  f(curTime(), dur(), realCurTime());
  kick();
  return () => {
    frameSubs.delete(f);
    if (!frameSubs.size) stopReviveTimer();
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
  signal?: AbortSignal,
  analysis = false,
): Promise<ResolvedPlayableStream> {
  const t0 = performance.now();
  const ytId = extractYtVideoId(tr);
  if (isYouTubeTrack(tr) && ytId) {
    const reused = priority ? await takePrefetchedYtStream(ytId) : null;
    const res = reused ?? (await ytDlpTrackStream(ytId, { requestId, clickTsMs: clickEpochMs, priority, signal }));
    return {
      url: res.url,
      hls: false,
      preview: false,
      cacheHit: res.cacheHit,
      resolveMs: res.resolveMs ?? Math.round(performance.now() - t0),
      attempts: res.attempts,
    };
  }
  if (isLocalTrack(tr)) {
    return {
      url: await localStreamUrl(tr),
      hls: false,
      preview: false,
      resolveMs: Math.round(performance.now() - t0),
      attempts: [{ method: 'local_file', outcome: 'ok', durationMs: Math.round(performance.now() - t0) }],
    };
  }
  if (tr.source === 'soundcloud' && tr.nativeId) {
    const scRes = await trackStream(tr.nativeId, analysis);
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

/** Stream URL for offline analysis (speech recognition). Uses the same resolver as playback. */
export async function streamUrlForAnalysis(tr: Track): Promise<{ url: string; hls: boolean }> {
  const s = await resolvePlayableStream(tr, undefined, undefined, false, undefined, true);
  return { url: s.url, hls: s.hls };
}

/**
 * Ждёт готовности потока на `<audio>` (`canplay` / `loadeddata` или `readyState >= 2`) с проверкой `requestId`
 * перед вызовом `el.play()`, чтобы исключить ложные `pause`/`error` во время резолва.
 */
async function waitForAudioStreamReady(deck: Deck, expectedRequestId: number, timeoutMs = 4500): Promise<boolean> {
  const el = deck.el;
  if (expectedRequestId !== currentRequestId || deck.requestId !== expectedRequestId) return false;
  if (el.readyState >= 2) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener('loadeddata', onLoadedData);
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('error', onError);
      const valid = ok && expectedRequestId === currentRequestId && deck.requestId === expectedRequestId;
      if (!valid) {
        logTrackTiming(
          expectedRequestId,
          'wait_ready_failed',
          `reason=${reason} readyState=${el.readyState} networkState=${el.networkState} errCode=${el.error?.code ?? 0} activeReq=${currentRequestId} deckReq=${deck.requestId}`,
        );
      }
      resolve(valid);
    };
    const onLoadedData = () => finish(true, 'loadeddata');
    const onCanPlay = () => finish(true, 'canplay');
    const onError = () => finish(false, 'audio_error');
    const timer = setTimeout(() => {
      // Если по таймауту метаданные уже есть — пробуем запустить play()
      finish(el.readyState >= 1, 'timeout');
    }, timeoutMs);

    el.addEventListener('loadeddata', onLoadedData, { once: true });
    el.addEventListener('canplay', onCanPlay, { once: true });
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
  deck.forcedEndDone = false;
  if (stream.hls && !deck.el.canPlayType('application/vnd.apple.mpegurl')) {
    const Hls = await loadHls();
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
    if (triggerRequestId !== currentRequestId || crossfadeSession) {
      if (preloadingNextForLoadId === triggerRequestId) preloadingNextForLoadId = -1;
      return;
    }
    if (!stream.url || (nextTr.source === 'soundcloud' && stream.preview)) {
      if (preloadingNextForLoadId === triggerRequestId) preloadingNextForLoadId = -1;
      return;
    }

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
      if (preloadingNextForLoadId === triggerRequestId) preloadingNextForLoadId = -1;
      return;
    }
    try {
      toDeck.el.load();
    } catch {
      /* ignore */
    }
  } catch {
    if (preloadingNextForLoadId === triggerRequestId) preloadingNextForLoadId = -1;
  }
}

function isConfirmedYtUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
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
/**
 * SoundCloud failed for the session, not for the track: no search can fix that, so the queue stays
 * as it is and the user is sent to the provider page to sign in again. Returns true in every case —
 * the caller has nothing left to do for this track.
 */
function reportSessionExpired(track: Track, reqId: number): true {
  logTrackTiming(reqId, 'fallback_skipped', `track="${track.title}" reason=soundcloud_session_expired`);
  setPlayerMachineState('error');
  snack(t('scSessionExpired'), {
    label: t('scSessionExpiredAction'),
    run: () => go({ name: 'providers' }),
  });
  return true;
}

async function fallbackSoundCloud(track: Track, index: number, reqId: number, cause?: unknown): Promise<boolean> {
  if (reqId !== currentRequestId || fallbackAttemptedTrackId === track.id) return true;
  fallbackAttemptedTrackId = track.id;
  if (isSoundCloudAuthError(cause)) return reportSessionExpired(track, reqId);
  logTrackTiming(reqId, 'fallback_start', `track="${track.title}" source=${track.source}`);
  const manualSearchQuery = `${track.artist ? `${track.artist} - ` : ''}${track.title}`.trim();
  const controller = new AbortController();
  fallbackController?.abort();
  fallbackController = controller;
  try {
    const rawFallback = await findYouTubeFallback(track, controller.signal);
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
    if (player.get().shuffle) {
      recommendationSource.set(fallback.id, track);
      trimTrackCache(recommendationSource);
    }
    const queue = player.get().queue.slice();
    queue[index] = fallback.id;
    player.set({ queue });
    snack(`Заменён на доступную версию: ${fallback.artist} — ${fallback.title}`);
    await load(index, true);
  } catch {
    if (reqId !== currentRequestId || controller.signal.aborted) return true;
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
  fallbackController?.abort();
  if (errorAdvanceTimer !== null) {
    clearTimeout(errorAdvanceTimer);
    errorAdvanceTimer = null;
  }
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

  resolveAbort?.abort();
  resolveAbort = new AbortController();

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
    savePlayhead(0);

    try {
      activeTrace.resolveStartedPerfMs = performance.now();
      logTrackTiming(reqId, 'resolve_start', `mode=crossfade source=${tr.source ?? 'unknown'}`, clickPerfMs);

      const stream = await resolvePlayableStream(tr, reqId, clickEpochMs, true, resolveAbort?.signal);
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
        stopAndResetDeck(fromDeck);
        toDeck.fadeMultiplier = 1;
        syncDeckVolumes();
        await fallbackSoundCloud(tr, i, reqId);
        return;
      }
      await attachStreamToDeck(toDeck, stream);
      logTrackTiming(reqId, 'audio_src_assigned', `mode=crossfade src="${toDeck.el.src}"`, clickPerfMs);
      if (reqId !== currentRequestId) return;

      const streamReady = await waitForAudioStreamReady(toDeck, reqId);
      if (reqId !== currentRequestId) return;
      if (!streamReady) {
        logTrackTiming(
          reqId,
          'stream_ready_failed',
          `mode=crossfade track="${tr.title}" readyState=${toDeck.el.readyState} errCode=${toDeck.el.error?.code ?? 0}`,
          clickPerfMs,
        );
        stopAndResetDeck(toDeck);
        stopAndResetDeck(fromDeck);
        toDeck.fadeMultiplier = 1;
        syncDeckVolumes();
        setPlayerMachineState('error', { isCrossfading: false, fadeProgress: 0 });
        snack(t('cantPlay'));
        return;
      }

      resumeAudioContextIfNeeded();
      await toDeck.el.play();
      if (reqId !== currentRequestId) return;
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
      logTrackTiming(
        reqId,
        'load_exception',
        `mode=crossfade track="${tr.title}" err="${e instanceof Error ? e.message : String(e)}"`,
        clickPerfMs,
      );
      stopAndResetDeck(toDeck);
      stopAndResetDeck(fromDeck);
      toDeck.fadeMultiplier = 1;
      syncDeckVolumes();
      if (tr.source === 'soundcloud' || (isYouTubeTrack(tr) && isConfirmedYtUnavailableError(e))) {
        await fallbackSoundCloud(tr, i, reqId, e);
        return;
      }
      setPlayerMachineState('error', { isCrossfading: false, fadeProgress: 0 });
      snack(e instanceof Error ? e.message : t('cantPlay'));
      return;
    }

    if (reqId !== currentRequestId) return;
    if (tr.source === 'soundcloud' || isYouTubeTrack(tr)) void prefetchRelated(tr);
    maybeExtendShuffleQueue(tr);
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
  savePlayhead(0);

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

    const stream = await resolvePlayableStream(tr, reqId, clickEpochMs, true, resolveAbort?.signal);
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
      if (reqId !== currentRequestId) return;
      if (!streamReady) {
        logTrackTiming(
          reqId,
          'stream_ready_failed',
          `mode=direct track="${tr.title}" readyState=${deck.el.readyState} errCode=${deck.el.error?.code ?? 0}`,
          clickPerfMs,
        );
        stopAndResetDeck(deck);
        deck.fadeMultiplier = 1;
        syncDeckVolumes();
        setPlayerMachineState('error');
        snack(t('cantPlay'));
        return;
      }
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
    logTrackTiming(
      reqId,
      'load_exception',
      `mode=direct track="${tr.title}" err="${e instanceof Error ? e.message : String(e)}"`,
      clickPerfMs,
    );
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
      await fallbackSoundCloud(tr, i, reqId, e);
      return;
    }
    stopAndResetDeck(deck);
    deck.fadeMultiplier = 1;
    syncDeckVolumes();
    setPlayerMachineState('error');
    snack(e instanceof Error ? e.message : t('cantPlay'));
    return;
  }
  if (reqId !== currentRequestId) return;
  if (tr.source === 'soundcloud' || isYouTubeTrack(tr)) void prefetchRelated(tr);
  maybeExtendShuffleQueue(tr);
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
  if (!playbackAccess.canControl()) {
    clearAutoCrossfadeTimer();
    return;
  }
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
  clearAutoCrossfadeTimer();

  const toDeck = getInactiveDeck();
  let streamAssigned = false;

  try {
    const alreadyPreloaded =
      toDeck.trackId === nextId &&
      toDeck.queueIndex === nextIdx &&
      toDeck.preloadedForLoadId === triggerRequestId &&
      Boolean(toDeck.el.src);

    if (!alreadyPreloaded) {
      const stream = await resolvePlayableStream(nextTr);
      if (triggerRequestId !== currentRequestId || crossfadeSession || fromDeck.el.paused || fromDeck.el.ended) {
        if (autoCrossfadePreparingForLoadId === triggerRequestId) autoCrossfadePreparingForLoadId = -1;
        return;
      }
      if (!stream.url || (nextTr.source === 'soundcloud' && stream.preview)) {
        // Leave `autoCrossfadePreparingForLoadId` set for this track so `ended` cleanly hands off to fallback
        return;
      }
      stopAndResetDeck(toDeck);
      toDeck.trackId = nextId;
      toDeck.queueIndex = nextIdx;
      toDeck.fadeMultiplier = 0;
      syncDeckVolumes();
      await attachStreamToDeck(toDeck, stream);
      streamAssigned = true;
      if (triggerRequestId !== currentRequestId || crossfadeSession || fromDeck.el.paused || fromDeck.el.ended) {
        stopAndResetDeck(toDeck);
        if (autoCrossfadePreparingForLoadId === triggerRequestId) autoCrossfadePreparingForLoadId = -1;
        return;
      }
    } else {
      streamAssigned = true;
      toDeck.fadeMultiplier = 0;
      try {
        toDeck.el.currentTime = 0;
      } catch {
        /* ignore */
      }
      syncDeckVolumes();
    }

    // Wait for the incoming stream metadata/first frame BEFORE promoting toDeck as active.
    // Assign a temporary matching requestId so waitForAudioStreamReady does not early-abort,
    // while keeping activeDeckIdx on fromDeck until toDeck actually starts playing.
    toDeck.requestId = triggerRequestId;
    const streamReady = await waitForAudioStreamReady(toDeck, triggerRequestId, 4000);
    if (triggerRequestId !== currentRequestId || crossfadeSession) {
      if (streamAssigned && toDeck !== getActiveDeck()) stopAndResetDeck(toDeck);
      return;
    }
    if (!streamReady) {
      stopAndResetDeck(toDeck);
      // If outgoing track already ended while we waited, advance immediately instead of stalling
      if (fromDeck.el.ended) next(true);
      return;
    }

    // If outgoing track finished while resolving/buffering, fall through to normal transition instead of deadlocking
    if (fromDeck.el.ended || fromDeck.el.paused) {
      stopAndResetDeck(toDeck);
      if (fromDeck.el.ended && triggerRequestId === currentRequestId) {
        next(true);
      } else if (autoCrossfadePreparingForLoadId === triggerRequestId) {
        autoCrossfadePreparingForLoadId = -1;
      }
      return;
    }

    const plan = planAutoCrossfade({
      baseFadeSec: baseFade,
      elDuration: fromDeck.el.duration,
      metaDuration: curTr.duration || trackDur,
      currentTime: fromDeck.el.currentTime,
    });

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

    const prevState = player.get();
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
    try {
      await toDeck.el.play();
    } catch {
      if (reqId === currentRequestId) {
        if (canFallbackToOutgoingDeck(fromDeck.el.paused, fromDeck.el.ended, fromDeck.el.src)) {
          currentRequestId = triggerRequestId;
          activeDeckIdx = fromDeck.id;
          audio = fromDeck.el;
          stopAndResetDeck(toDeck);
          fromDeck.fadeMultiplier = 1;
          syncDeckVolumes();
          setPlayerMachineState(prevState.state, { requestId: prevState.requestId, index: prevState.index, duration: prevState.duration, pos: prevState.pos });
        } else {
          // Outgoing deck already ended; fall back to standard load so playback never stalls on pause
          stopAndResetDeck(fromDeck);
          void load(nextIdx, true);
        }
      }
      return;
    }
    if (reqId !== currentRequestId) {
      stopAndResetDeck(fromDeck);
      return;
    }

    startCrossfadeRamp(fromDeck, toDeck, plan.fadeSec, 'auto', plan.startFraction, nextDur || nextTr.duration);
    if (nextTr.source === 'soundcloud' || isYouTubeTrack(nextTr)) void prefetchRelated(nextTr);
    scheduleLowPriorityUpcomingPrefetch(reqId, nextIdx);
    pushRecent(nextId);
    mediaMeta(nextTr);
    emitFrame();
    emitTime();
  } catch {
    if (streamAssigned && toDeck !== getActiveDeck()) stopAndResetDeck(toDeck);
    if (fromDeck.el.ended && triggerRequestId === currentRequestId) {
      next(true);
    }
  }
}

export function playQueue(ids: string[], start = 0, shuffle?: boolean) {
  if (!playbackAccess.canControl() || !ids.length) return;
  const sh = shuffle ?? player.get().shuffle;
  let q = ids.slice();
  let idx = clamp(start, 0, q.length - 1);
  if (sh) {
    original = q.slice();
    const first = q[idx];
    q = [first, ...shuffled(q.filter((_, k) => k !== idx))];
    idx = 0;
  } else {
    original = null;
  }
  player.set({ queue: q, shuffle: sh });
  const manualFade = getCrossfadeDuration() > 0 ? MANUAL_CROSSFADE_SECONDS : 0;
  void load(idx, true, { crossfadeSec: manualFade });
}

export const shufflePlay = (ids: string[]) => ids.length && playQueue(ids, Math.floor(Math.random() * ids.length), true);

const relatedRequests = new Map<string, Promise<Track[]>>();

/** Keep at least this many upcoming tracks in the queue while shuffle is on ("infinite radio"). */
const SHUFFLE_KEEP_AHEAD = 4;


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
      trimTrackCache(relatedFetched);
      return tracks;
    }).catch(() => []).finally(() => relatedRequests.delete(track.id));
    relatedRequests.set(track.id, request);
  }
  return request;
}

/**
 * Extends the shuffle queue with style-matched recommendations (YouTube Music radio / SoundCloud related)
 * seeded by the current and previously played tracks from the same provider.
 * Returns how many tracks were appended (0 when nothing was added).
 */
async function extendShuffleQueue(track: Track): Promise<number> {
  const state = player.get();
  if (!state.shuffle || currentTrack()?.id !== track.id) return 0;

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
  const history = player.get().queue.slice(0, player.get().index + 1).reverse();
  const seeds = recommendationSeedIds(source.id, history)
    .map((id) => getTrack(id))
    .filter((item): item is Track => item !== undefined && item.source === source.source);
  const results = await Promise.allSettled(seeds.map(prefetchRelated));
  if (currentTrack()?.id !== track.id) return 0;

  const related = [...new Map(results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    .map((item) => [item.id, item])).values()];
  const existing = new Set(player.get().queue);
  const disliked = new Set(library.get().disliked);
  const candidates = shuffled(rankRecommendations(seeds, related, existing, disliked, known)).slice(0, 20);
  if (!candidates.length) return 0;
  registerTracks(candidates);
  const queue = insertRecommendations(
    player.get().queue,
    player.get().index,
    candidates.map((candidate) => candidate.id),
  );
  if (original) original.push(...candidates.map((candidate) => candidate.id));
  player.set({ queue });
  return candidates.length;
}

async function appendRelatedAndContinue(track: Track) {
  const appended = await extendShuffleQueue(track);
  if (appended <= 0) {
    setPlayerMachineState('paused');
    return;
  }
  const queue = player.get().queue;
  const nextIndex = queue.length - appended;
  void load(nextIndex, true);
}

/** Keeps the queue topped up while shuffle is on so it behaves like an infinite radio. */
function maybeExtendShuffleQueue(track: Track | null | undefined) {
  if (!track) return;
  const s = player.get();
  if (!s.shuffle || currentTrack()?.id !== track.id) return;
  const upcoming = s.queue.length - 1 - s.index;
  if (upcoming >= SHUFFLE_KEEP_AHEAD) return;
  void extendShuffleQueue(track).catch(() => {});
}

export function toggle() {
  if (!playbackAccess.canControl()) return;
  const s = player.get();
  if (s.index < 0 || !s.queue.length) return;
  const track = currentTrack();
  if (usesProviderPlayback(track)) {
    if (s.state === 'loading' || s.loading) return;
    const playing = !s.playing;
    providerCommand(playing ? 'play' : 'pause');
    setPlayerMachineState(playing ? 'playing' : 'paused');
    return;
  }
  const activeEl = getActiveDeck().el;
  if (s.state === 'error' || !activeEl.src) {
    const keep = s.state === 'error' ? 0 : s.pos;
    const id = s.queue[s.index];
    void load(s.index, true);
    pendingSeek = keep > 0 && id ? createPendingAudioSeek(id, keep) : null;
    return;
  }
  // Во время 'loading' не дёргаем <audio> до готовности потока
  if (s.state === 'loading' || s.loading) return;
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
  if (!playbackAccess.canControl()) return;
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
  if (!playbackAccess.canControl()) return;
  const manualFade = getCrossfadeDuration() > 0 ? MANUAL_CROSSFADE_SECONDS : 0;
  return load(i, true, { crossfadeSec: manualFade });
};

export function seek(sec: number) {
  if (!playbackAccess.canControl()) return;
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

let volumeDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleVolumeDiagnostic() {
  if (volumeDiagnosticTimer !== null) clearTimeout(volumeDiagnosticTimer);
  volumeDiagnosticTimer = setTimeout(() => {
    volumeDiagnosticTimer = null;
    const deck = getActiveDeck();
    const dsp = deck.dsp;
    const ctx = dsp?.ctx;
    const gain = dsp?.channelGain.gain.value;
    const s = player.get();
    const preset = NORMALIZATION_PRESETS[s.normalizationTarget] ?? NORMALIZATION_PRESETS.normal;
    const makeup = s.normalizationEnabled ? preset.makeupLinear : 1;
    const expected = s.muted ? 0 : clamp(s.volume * makeup * deck.fadeMultiplier, 0, 1);
    logTrackTiming(
      currentRequestId,
      'volume_sync',
      `track=${currentTrack()?.id ?? 'none'} provider=${usesProviderPlayback(currentTrack())} master=${s.volume} muted=${s.muted} webkit=${isWebKitPlayback()} dsp=${Boolean(dsp)} ctx=${ctx?.state ?? 'none'} element=${deck.el.volume} gain=${gain ?? 'none'} expected=${expected.toFixed(3)}`,
    );
  }, 500);
}

export function setVolume(v: number) {
  v = Math.round(clamp(v, 0, 1) * 1000) / 1000;
  if (usesProviderPlayback(currentTrack())) providerCommand('setVolume', v);
  player.set({ volume: v, muted: false });
  syncDeckVolumes();
  scheduleVolumeDiagnostic();
}
export function toggleMute() {
  const m = !player.get().muted;
  if (usesProviderPlayback(currentTrack())) providerCommand('setVolume', m ? 0 : player.get().volume);
  player.set({ muted: m });
  syncDeckVolumes();
  scheduleVolumeDiagnostic();
}

/** Next-track selection changed: drop any stale preload and re-warm the upcoming queue. */
function invalidateUpcomingPreload() {
  if (crossfadeSession) return;
  const inactive = getInactiveDeck();
  if (inactive.trackId !== null && inactive.preloadedForLoadId !== undefined) stopAndResetDeck(inactive);
  preloadingNextForLoadId = -1;
  autoCrossfadePreparingForLoadId = -1;
  if (currentRequestId > 0) scheduleLowPriorityUpcomingPrefetch(currentRequestId);
}

export function toggleShuffle() {
  if (!playbackAccess.canControl()) return;
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
  invalidateUpcomingPreload();
}

export function cycleRepeat() {
  if (!playbackAccess.canControl()) return;
  const r = player.get().repeat;
  player.set({ repeat: r === 'off' ? 'all' : r === 'all' ? 'one' : 'off' });
  invalidateUpcomingPreload();
}

export function playNext(id: string) {
  if (!playbackAccess.canControl()) return;
  const s = player.get();
  if (s.index < 0) return playQueue([id]);
  const curId = s.queue[s.index];
  const q = s.queue.filter((x) => x !== id || x === curId);
  const ci = q.indexOf(curId);
  q.splice(ci + 1, 0, id);
  if (original && !original.includes(id)) original.push(id);
  player.set({ queue: q, index: ci });
  invalidateUpcomingPreload();
  snack(t('playingNext'));
}

export function addToQueue(id: string) {
  if (!playbackAccess.canControl()) return;
  const s = player.get();
  if (s.index < 0) return playQueue([id]);
  if (!s.queue.includes(id)) {
    player.set({ queue: [...s.queue, id] });
    if (original) original.push(id);
    invalidateUpcomingPreload();
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

/** Плейхед живёт в отдельном мелком ключе, а не в persisted-player: иначе каждый timeupdate
 *  перезаписывал весь стор плеера и через секунду тянул полный бэкап состояния в бэкенд. */
const PLAYHEAD_KEY = 'lyra.player.playhead.v1';
/** Как часто плейхед обновляется на ходу (между паузами/концом трека) — на случай падения. */
const PLAYHEAD_SAVE_STEP_SEC = 30;
let lastSaved = 0;
let errorAdvanceTimer: ReturnType<typeof setTimeout> | null = null;

function savePlayhead(pos = realCurTime()) {
  const id = currentTrack()?.id;
  if (!id) return;
  try {
    localStorage.setItem(PLAYHEAD_KEY, JSON.stringify({ id, pos: Math.max(0, Math.round(pos * 10) / 10) }));
  } catch {
    /* ignore */
  }
}

function savedPlayhead(id: string): number {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYHEAD_KEY) ?? 'null') as { id?: string; pos?: number } | null;
    return parsed?.id === id && typeof parsed.pos === 'number' && isFinite(parsed.pos) ? Math.max(0, parsed.pos) : 0;
  } catch {
    return 0;
  }
}

function scheduleErrorAdvance(reqId: number) {
  if (!shouldAdvanceAfterError(errors)) return;
  errors += 1;
  if (errorAdvanceTimer !== null) clearTimeout(errorAdvanceTimer);
  errorAdvanceTimer = setTimeout(() => {
    errorAdvanceTimer = null;
    if (reqId === currentRequestId) next(true);
  }, 900);
}

function isCurrentDeckEvent(deck: Deck): boolean {
  return deck === getActiveDeck() && deck.requestId > 0 && deck.requestId === currentRequestId;
}

function scheduleAutoCrossfadeCheck() {
  clearAutoCrossfadeTimer();
  if (!playbackAccess.canControl() || crossfadeSession) return;
  const deck = getActiveDeck();
  const el = deck.el;
  if (!el.src || el.paused || el.ended) return;
  if (deck.requestId <= 0 || deck.requestId !== currentRequestId) return;
  const track = currentTrack();
  if (!track || usesProviderPlayback(track)) return;
  const duration = dur();
  const fadeSec = effectiveAutoCrossfadeSeconds(duration);
  if (fadeSec <= 0 || !isFinite(duration) || duration <= 0) return;
  const remaining = duration - el.currentTime;
  // Schedule a direct timer for the crossfade start (and webkit forced end) so background
  // WebKit timeupdate throttling cannot skip the window or stall after end.
  const delaySec = Math.max(0.15, remaining - fadeSec);
  if (delaySec <= 45) {
    const expectedReqId = deck.requestId;
    autoCrossfadeTimer = window.setTimeout(() => {
      autoCrossfadeTimer = null;
      if (expectedReqId !== currentRequestId || crossfadeSession) return;
      const curDeck = getActiveDeck();
      if (curDeck !== deck || curDeck.el.paused || curDeck.el.ended) return;
      const d = dur();
      const f = effectiveAutoCrossfadeSeconds(d);
      if (f <= 0) return;
      const rem = d - curDeck.el.currentTime;
      if (rem <= f + 0.35 && rem > 0.25 && autoCrossfadePreparingForLoadId !== currentRequestId) {
        void startAutoCrossfade();
      } else {
        scheduleAutoCrossfadeCheck();
      }
    }, Math.round(delaySec * 1000));
  }
}

function bindDeckEvents(deck: Deck) {
  const el = deck.el;

  el.addEventListener('play', () => {
    if (!isCurrentDeckEvent(deck)) return;
    // Во время 'loading' ждём фактического 'playing', чтобы кнопка Play/Pause не мигала раньше времени
    if (player.get().state !== 'loading') {
      setPlayerMachineState('playing');
    }
    scheduleAutoCrossfadeCheck();
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
    scheduleAutoCrossfadeCheck();
    kick();
  });

  el.addEventListener('pause', () => {
    // Only handle pause for the active deck and ignore spurious pause events triggered on the
    // outgoing deck when crossfade ends or when it is stopped/reset.
    if (!isCurrentDeckEvent(deck)) return;
    // Also ignore spurious pause during active crossfade transition if the active deck is still
    // legitimately ending or buffering, or while loading/ending.
    if (player.get().state === 'loading' || player.get().loading || el.ended) return;
    if (crossfadeSession && !crossfadeSession.paused && deck === crossfadeSession.toDeck) {
      // On WKWebView, starting/stopping a second audio element can emit a spurious pause on
      // toDeck even though the user never paused; keep it playing until crossfade completes.
      resumeAudioContextIfNeeded();
      void el.play().catch(() => {
        if (isCurrentDeckEvent(deck) && el.paused && !el.ended) {
          pauseCrossfadeIfActive();
          setPlayerMachineState('paused', { pos: el.src ? el.currentTime : 0 });
          savePlayhead();
        }
      });
      return;
    }
    clearAutoCrossfadeTimer();
    setPlayerMachineState('paused', { pos: el.src ? el.currentTime : 0 });
    savePlayhead();
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
      // Outgoing deck finished during crossfade: stop & reset it cleanly, and ensure incoming
      // active deck is still playing.
      stopAndResetDeck(deck);
      const cur = getActiveDeck();
      if (cur.el.paused && !cur.el.ended && cur.el.src && cur.requestId === currentRequestId && !crossfadeSession?.paused) {
        resumeAudioContextIfNeeded();
        void cur.el.play().catch(() => {});
      }
      return;
    }
    if (deck.requestId !== currentRequestId) return;
    savePlayhead(0);
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
    if (isFinite(el.duration) && el.duration > 0) {
      const doubled = webkitDoubledDuration(track, el.duration);
      logTrackTiming(
        deck.requestId,
        'loadedmetadata_duration',
        `track="${track?.title ?? '?'}" id=${track?.id ?? '?'} src=${el.currentSrc.slice(0, 60)} meta=${track?.duration} elDuration=${el.duration} doubled=${doubled}`,
      );
      player.set({ duration: doubled ?? el.duration });
    }
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

    // WebKit удваивает длительность YouTube-потоков: 'ended' не наступит до конца "тишины".
    // Принудительно завершаем трек на реальной длительности.
    if (track && !el.paused && !deck.forcedEndDone) {
      const doubled = webkitDoubledDuration(track, el.duration);
      if (doubled !== null && el.currentTime >= doubled - 0.25) {
        deck.forcedEndDone = true;
        logTrackTiming(deck.requestId, 'webkit_forced_end', `track="${track.title}" meta=${track.duration} elDuration=${el.duration} at=${el.currentTime.toFixed(2)}`);
        if (deck === getActiveDeck() && deck.requestId === currentRequestId) next(true);
        return;
      }
    }

    const remaining = duration - el.currentTime;

    if (player.get().shuffle && track && (track.source === 'soundcloud' || isYouTubeTrack(track)) && duration > 0 && remaining <= 20) {
      void prefetchRelated(track);
    }

    const fadeSec = effectiveAutoCrossfadeSeconds(duration);
    if (fadeSec > 0 && duration > 0 && !el.paused && el.currentTime >= 1) {
      const decision = evaluateAutoCrossfadeTrigger({
        duration,
        currentTime: el.currentTime,
        fadeSec,
        paused: el.paused,
        ended: el.ended,
        preloadedAlready: preloadingNextForLoadId === currentRequestId,
        preparingAlready: autoCrossfadePreparingForLoadId === currentRequestId,
        preloadAheadSec: PRELOAD_AHEAD_SECONDS,
      });
      if (decision.shouldPreload) {
        void preloadNextTrackIntoInactiveDeck();
      }
      if (decision.shouldStart) {
        void startAutoCrossfade();
        return;
      }
      if (autoCrossfadeTimer === null && duration - el.currentTime <= 45) {
        scheduleAutoCrossfadeCheck();
      }
    }

    emitTime();
    if (el.paused) emitFrame();
    if (Math.abs(el.currentTime - lastSaved) > PLAYHEAD_SAVE_STEP_SEC) {
      lastSaved = el.currentTime;
      player.set({ pos: el.currentTime });
      savePlayhead(el.currentTime);
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
    if (crossfadeSession && crossfadeSession.toDeck === deck) {
      cancelCrossfade(true);
    }
    const reqId = deck.requestId;
    logTrackTiming(reqId, 'audio_error', `code=${el.error?.code ?? 0} message="${el.error?.message ?? ''}"`);
    const track = currentTrack();
    const index = player.get().index;
    if (track && track.source === 'soundcloud') {
      void fallbackSoundCloud(track, index, reqId);
      return;
    }
    if (track && isYouTubeTrack(track)) {
      const ytId = extractYtVideoId(track);
      const playedSec = Number.isFinite(el.currentTime) ? el.currentTime : 0;
      const attempts = deck.recoveryAttempts ?? 0;
      if (ytId && attempts < 1) {
        deck.recoveryAttempts = attempts + 1;
        void (async () => {
          try {
            logTrackTiming(reqId, 'stream_recover_start', `track="${track.title}" at=${playedSec.toFixed(2)}s`);
            const fallback = await ytDlpTrackStream(ytId, { requestId: reqId, priority: true });
            if (reqId !== currentRequestId || deck !== getActiveDeck() || deck.trackId !== track.id) return;
            if (!fallback?.url) throw new Error('No fallback stream URL');
            const resumeAt = Math.max(0, playedSec - 1);
            pendingSeek = createPendingAudioSeek(track.id, resumeAt);
            await attachStreamToDeck(deck, { url: fallback.url, hls: false });
            const streamReady = await waitForAudioStreamReady(deck, reqId);
            if (!streamReady || reqId !== currentRequestId || deck !== getActiveDeck() || deck.trackId !== track.id) return;
            const seekTo = pendingAudioSeekFor(pendingSeek, track.id);
            if (seekTo !== null) {
              try {
                deck.el.currentTime = Math.min(seekTo, deck.el.duration || seekTo);
              } catch {
                /* ignore */
              }
              pendingSeek = null;
            }
            resumeAudioContextIfNeeded();
            await deck.el.play();
            logTrackTiming(reqId, 'stream_recover_ok', `url="${fallback.url}"`);
            return;
          } catch (recoverErr) {
            if (reqId !== currentRequestId || deck !== getActiveDeck()) return;
            logTrackTiming(
              reqId,
              'stream_recover_failed',
              `err="${recoverErr instanceof Error ? recoverErr.message : String(recoverErr)}"`,
            );
          }
          if (reqId !== currentRequestId) return;
          setPlayerMachineState('error', { isCrossfading: false, fadeProgress: 0 });
          snack(t('cantPlay'));
          scheduleErrorAdvance(reqId);
        })();
        return;
      }
    }
    setPlayerMachineState('error', { isCrossfading: false, fadeProgress: 0 });
    snack(t('cantPlay'));
    scheduleErrorAdvance(reqId);
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
    normalizationEnabled: s.normalizationEnabled,
    normalizationTarget: s.normalizationTarget,
    crossfadeEnabled: s.crossfadeEnabled,
    crossfadeDuration: s.crossfadeDuration,
    crossfadeCurve: s.crossfadeCurve,
    eqPreset: s.eqPreset,
    eqGains: s.eqGains,
    fx: s.fx,
  }));
  player.set({ fx: clampFx(player.get().fx ?? FX_OFF) });
  applyPlaybackRate();
  const s = player.get();
  const curId = s.queue[s.index];
  const q = s.queue.filter((id) => getTrack(id));
  const idx = curId ? q.indexOf(curId) : -1;
  const restoredPos = curId ? savedPlayhead(curId) : 0;
  setPlayerMachineState('idle', {
    queue: q,
    index: idx,
    pos: idx >= 0 ? restoredPos : 0,
    crossfadeDuration: clamp(s.crossfadeDuration || DEFAULT_CROSSFADE_DURATION, 1, 12),
    isCrossfading: false,
    fadeProgress: 0,
  });
  refreshAllDspChains();
  pendingSeek = idx >= 0 && q[idx] ? createPendingAudioSeek(q[idx], restoredPos) : null;
  const cur = currentTrack();
  if (cur) mediaMeta(cur);
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const h: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => toggle()],
      ['pause', () => {
        if (!playbackAccess.canControl() || player.get().state === 'loading') return;
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
  window.addEventListener('pagehide', () => savePlayhead());
}
