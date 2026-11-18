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
export async function transcribeTrack(track: Track): Promise<boolean> {
  if (!inTauri() || !isModelReady()) return false;
  // Already running for this track (e.g. both the panel and fullscreen lyrics asked).
  if (whisper.get().activeTrack === track.id) return false;
  cancelTranscription();
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  whisper.set({ activeTrack: track.id, error: '' });
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
    if (whisper.get().activeTrack === track.id) whisper.set({ activeTrack: null });
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
    const active = whisper.get().activeTrack;
    if (active && active !== id) {
      abort?.abort();
      cancelTranscription();
    }
  });
}
