import { invoke } from '@tauri-apps/api/core';
import { createStore, persist } from '../lib/util';
import { setManualLyricsChoice } from '../lib/api';
import { guessLanguage, pcmToBytes, threadsFor, toEnhancedLrc, type TranscriptLine } from '../lib/transcript-lrc';
import type { Track } from '../types';
import { currentTrack, player, streamUrlForAnalysis } from './player';

export type WhisperLoad = 'low' | 'medium' | 'high';
export interface WhisperModel {
  id: string;
  sizeMb: number;
  installed: boolean;
}

export const whisper = createStore({
  /** Transcribe automatically when no lyrics were found for the playing track. */
  auto: false,
  model: 'small',
  load: 'low' as WhisperLoad,
  /** 'auto' guesses from the title script; otherwise an ISO code. */
  lang: 'auto',
  models: [] as WhisperModel[],
  downloading: null as null | { model: string; received: number; total: number },
  /** Track currently being transcribed. */
  activeTrack: null as string | null,
  /** Current stage of the active recognition job. */
  stage: null as null | 'preparing' | 'transcribing',
  /** True when the active job belongs to the background batch (not cancelled by track changes). */
  activeBackground: false,
  /** Background batch over many tracks: recognize everything that has no lyrics. */
  batch: null as null | { total: number; checked: number; recognized: number; current: string },
  /** `${trackId}:${n}` bumped when recognition stores new lyrics; lyrics views reload on it. */
  completed: '',
  error: '',
});

persist('resonance.whisper.v1', whisper, (s) => ({ auto: s.auto, model: s.model, load: s.load, lang: s.lang }));

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function refreshWhisperModels() {
  if (!inTauri()) return;
  const models = await invoke<WhisperModel[]>('whisper_models').catch(() => [] as WhisperModel[]);
  whisper.set({ models });
}

export const isModelReady = () => whisper.get().models.some((m) => m.id === whisper.get().model && m.installed);

let modelDownload: { model: string; promise: Promise<boolean> } | null = null;
let downloadCancel: (() => void) | null = null;
let cancelDownloadRequested = false;

export function downloadWhisperModel(model: string, opts: { select?: boolean } = {}): Promise<boolean> {
  if (modelDownload) return modelDownload.model === model ? modelDownload.promise : Promise.resolve(false);
  cancelDownloadRequested = false;
  const promise = (async () => {
    whisper.set({ downloading: { model, received: 0, total: 0 }, error: '' });
    let un: (() => void) | undefined;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      un = await listen<{ model: string; received: number; total: number }>('whisper-download', (e) => {
        if (e.payload.model === model) whisper.set({ downloading: e.payload });
      });
      if (cancelDownloadRequested) return false;
      downloadCancel = () => void invoke('whisper_cancel_download').catch(() => {});
      await invoke('whisper_download', { model });
      if (opts.select !== false) whisper.set({ model });
      return true;
    } catch (e) {
      if (String(e) !== 'cancelled') whisper.set({ error: String(e) });
      return false;
    } finally {
      un?.();
      whisper.set({ downloading: null });
      downloadCancel = null;
      modelDownload = null;
      await refreshWhisperModels();
    }
  })();
  modelDownload = { model, promise };
  return promise;
}

export const cancelWhisperDownload = () => {
  cancelDownloadRequested = true;
  downloadCancel?.();
};

export async function deleteWhisperModel(model: string) {
  await invoke('whisper_delete', { model }).catch((e) => whisper.set({ error: String(e) }));
  await refreshWhisperModels();
}

export function cancelTranscription() {
  if (!whisper.get().activeTrack) return;
  abort?.abort();
  whisper.set({ activeTrack: null, activeBackground: false, stage: null });
  void invoke('whisper_cancel').catch(() => {});
  void cancelWhisperDownload();
  void invoke('cancel_soundcloud_analysis_command').catch(() => {});
}

/** Decodes any stream the webview can play into 16 kHz mono PCM (max 10 minutes). */
async function decodeTo16kMono(url: string, signal: AbortSignal): Promise<Float32Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 16000, 16000);
  const buf = await ctx.decodeAudioData(data);
  const len = Math.min(buf.length, 16000 * 600);
  const out = new Float32Array(len);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

let abort: AbortController | null = null;

/**
 * Recognizes the track's vocals and stores them as the track's own lyrics (Enhanced LRC with word
 * timing), so they persist, are backed up, and can be reset from the lyrics picker.
 * Resolves to true when lyrics were produced.
 */
export async function transcribeTrack(
  track: Track,
  opts: { background?: boolean; model?: string; load?: WhisperLoad } = {},
): Promise<boolean> {
  const model = opts.model ?? whisper.get().model;
  if (!inTauri()) return false;
  // Already running for this track (e.g. both the panel and fullscreen lyrics asked).
  if (whisper.get().activeTrack === track.id) return false;
  // A foreground request (the track you're listening to) preempts a background batch job.
  cancelTranscription();
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  const requestId = crypto.randomUUID();
  whisper.set({ activeTrack: track.id, activeBackground: !!opts.background, stage: 'preparing', error: '' });
  try {
    if (!whisper.get().models.some((m) => m.id === model && m.installed)) {
      if (!(await downloadWhisperModel(model, { select: model === whisper.get().model }))) return false;
    }
    if (signal.aborted || whisper.get().activeTrack !== track.id) return false;
    const stream = await streamUrlForAnalysis(track);
    if (!stream.url) throw new Error('Аудиопоток для распознавания не найден.');
    if (signal.aborted || whisper.get().activeTrack !== track.id) return false;
    let pcm: Float32Array;
    if (stream.hls && track.source === 'soundcloud' && track.nativeId) {
      const raw = await invoke<ArrayBuffer>('soundcloud_analysis_pcm_command', { trackUrn: track.nativeId });
      if (raw.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('Некорректные аудиоданные от распознавателя.');
      pcm = new Float32Array(raw);
    } else {
      if (stream.hls) throw new Error('Этот формат аудиопотока пока не поддерживается для распознавания.');
      pcm = await decodeTo16kMono(stream.url, signal);
    }
    if (signal.aborted || whisper.get().activeTrack !== track.id) return false;
    const { load, lang } = whisper.get();
    whisper.set({ stage: 'transcribing' });
    const lines = await invoke<TranscriptLine[]>('whisper_transcribe', pcmToBytes(pcm), {
      headers: {
        'x-model': model,
        'x-request-id': requestId,
        'x-track-id': track.id,
        'x-threads': String(threadsFor(opts.load ?? load, navigator.hardwareConcurrency || 4)),
        'x-lang': lang === 'auto' ? guessLanguage(`${track.title} ${track.artist}`) : lang,
      },
    });
    if (whisper.get().activeTrack !== track.id) return false;
    if (lines.length < 2) {
      whisper.set({ error: 'Не удалось распознать достаточно текста для сохранения.' });
      return false;
    }
    setManualLyricsChoice(track.id, {
      id: -Date.now(),
      trackName: track.title,
      artistName: track.metaArtist || track.artist,
      duration: track.fullDuration ?? track.duration,
      syncedLyrics: toEnhancedLrc(lines),
      generatedBy: 'whisper',
    });
    whisper.set({ completed: `${track.id}:${Date.now()}` });
    return true;
  } catch (e) {
    const msg = String(e);
    if (!/cancel|abort/i.test(msg)) whisper.set({ error: msg });
    return false;
  } finally {
    if (whisper.get().activeTrack === track.id) whisper.set({ activeTrack: null, activeBackground: false, stage: null });
  }
}

export async function transcribeMoreAccurately(track: Track): Promise<boolean> {
  return transcribeTrack(track, { model: 'medium', load: 'high' });
}

export function initWhisper() {
  void refreshWhisperModels();
  // Switching tracks cancels recognition of the previous one right away (frees the CPU).
  // Only an actual change of the current track counts; player state updates don't.
  let lastId = currentTrack()?.id ?? null;
  player.subscribe(() => {
    const id = currentTrack()?.id ?? null;
    if (id === lastId) return;
    lastId = id;
    const { activeTrack: active, activeBackground } = whisper.get();
    if (active && active !== id && !activeBackground) {
      abort?.abort();
      cancelTranscription();
    }
  });
}

let batchStop = false;

/**
 * Background pass over a list of tracks: every track that still has no lyrics after all sources
 * were asked gets recognized, one at a time, at the configured CPU load. Your current track always
 * takes priority (a foreground request preempts the running batch job).
 */
export async function recognizeMissing(tracks: Track[]) {
  if (!inTauri() || whisper.get().batch) return;
  const { getLyrics, hasManualLyricsChoice } = await import('../lib/api');
  const list = tracks.filter((t) => t && (t.fullDuration ?? t.duration) <= 600);
  batchStop = false;
  whisper.set({ batch: { total: list.length, checked: 0, recognized: 0, current: '' } });
  const bump = (p: Partial<NonNullable<ReturnType<typeof whisper.get>['batch']>>) =>
    whisper.set((s) => (s.batch ? { batch: { ...s.batch, ...p } } : {}));
  try {
    if (!isModelReady() && !(await downloadWhisperModel(whisper.get().model))) return;
    for (const t of list) {
      if (batchStop) break;
      bump({ current: `${t.artist} — ${t.title}` });
      let has = hasManualLyricsChoice(t.id);
      if (!has) {
        const d = await getLyrics(t).catch(() => null);
        has = !!(d?.synced?.length || d?.plain?.length || d?.instrumental);
      }
      // Two attempts: a foreground request (your current track) may preempt the first one.
      for (let attempt = 0; !has && !batchStop && attempt < 2; attempt++) {
        while (whisper.get().activeTrack && !whisper.get().activeBackground && !batchStop) await new Promise((r) => setTimeout(r, 1000));
        if (batchStop) break;
        if (await transcribeTrack(t, { background: true })) {
          bump({ recognized: (whisper.get().batch?.recognized ?? 0) + 1 });
          break;
        }
        const preempted = !!whisper.get().activeTrack && !whisper.get().activeBackground;
        if (!preempted) break;
      }
      bump({ checked: (whisper.get().batch?.checked ?? 0) + 1 });
    }
  } finally {
    whisper.set({ batch: null });
  }
}

export function stopRecognizeMissing() {
  batchStop = true;
  if (whisper.get().downloading) void cancelWhisperDownload();
  if (whisper.get().activeBackground) {
    abort?.abort();
    cancelTranscription();
  }
  if (whisper.get().downloading) void cancelWhisperDownload();
}
