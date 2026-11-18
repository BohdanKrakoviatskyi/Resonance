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

export async function downloadWhisperModel(model: string) {
  whisper.set({ downloading: { model, received: 0, total: 0 }, error: '' });
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ model: string; received: number; total: number }>('whisper-download', (e) => whisper.set({ downloading: e.payload }));
  try {
    await invoke('whisper_download', { model });
    whisper.set({ model });
  } catch (e) {
    if (String(e) !== 'cancelled') whisper.set({ error: String(e) });
  } finally {
    un();
    whisper.set({ downloading: null });
    await refreshWhisperModels();
  }
}

export const cancelWhisperDownload = () => invoke('whisper_cancel_download').catch(() => {});

export async function deleteWhisperModel(model: string) {
  await invoke('whisper_delete', { model }).catch((e) => whisper.set({ error: String(e) }));
  await refreshWhisperModels();
}

export function cancelTranscription() {
  if (!whisper.get().activeTrack) return;
  whisper.set({ activeTrack: null });
  void invoke('whisper_cancel').catch(() => {});
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
export async function transcribeTrack(track: Track, opts: { background?: boolean } = {}): Promise<boolean> {
  if (!inTauri() || !isModelReady()) return false;
  // Already running for this track (e.g. both the panel and fullscreen lyrics asked).
  if (whisper.get().activeTrack === track.id) return false;
  // A foreground request (the track you're listening to) preempts a background batch job.
  cancelTranscription();
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  whisper.set({ activeTrack: track.id, activeBackground: !!opts.background, error: '' });
  try {
    const stream = await streamUrlForAnalysis(track);
    if (stream.hls || !stream.url) throw new Error('unsupported stream');
    const pcm = await decodeTo16kMono(stream.url, signal);
    if (signal.aborted || whisper.get().activeTrack !== track.id) return false;
    const { model, load, lang } = whisper.get();
    const lines = await invoke<TranscriptLine[]>('whisper_transcribe', pcmToBytes(pcm), {
      headers: {
        'x-model': model,
        'x-threads': String(threadsFor(load, navigator.hardwareConcurrency || 4)),
        'x-lang': lang === 'auto' ? guessLanguage(`${track.title} ${track.artist}`) : lang,
      },
    });
    if (whisper.get().activeTrack !== track.id || lines.length < 2) return false;
    setManualLyricsChoice(track.id, {
      id: -Date.now(),
      trackName: track.title,
      artistName: track.metaArtist || track.artist,
      duration: track.fullDuration ?? track.duration,
      syncedLyrics: toEnhancedLrc(lines),
    });
    whisper.set({ completed: `${track.id}:${Date.now()}` });
    return true;
  } catch (e) {
    const msg = String(e);
    if (!/cancel|abort/i.test(msg)) whisper.set({ error: msg });
    return false;
  } finally {
    if (whisper.get().activeTrack === track.id) whisper.set({ activeTrack: null, activeBackground: false });
  }
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
  if (!inTauri() || !isModelReady() || whisper.get().batch) return;
  const { getLyrics, hasManualLyricsChoice } = await import('../lib/api');
  const list = tracks.filter((t) => t && (t.fullDuration ?? t.duration) <= 600);
  batchStop = false;
  whisper.set({ batch: { total: list.length, checked: 0, recognized: 0, current: '' } });
  const bump = (p: Partial<NonNullable<ReturnType<typeof whisper.get>['batch']>>) =>
    whisper.set((s) => (s.batch ? { batch: { ...s.batch, ...p } } : {}));
  try {
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
  if (whisper.get().activeBackground) {
    abort?.abort();
    cancelTranscription();
  }
}
