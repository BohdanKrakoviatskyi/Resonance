import { invoke } from '@tauri-apps/api/core';
import { createStore, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import type { Track } from '../types';
import { snack } from './ui';

/** Downloads are tracked by YouTube video id; the files themselves live in the Rust audio cache. */
export const offline = createStore({
  downloaded: {} as Record<string, number>,
  queue: [] as string[],
  active: null as string | null,
  failed: 0,
});

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Only YouTube Music tracks can be downloaded (SoundCloud streams are HLS/time-limited). */
export function offlineId(track: Track | null | undefined): string | null {
  if (!track) return null;
  const id = track.nativeId ?? (track.id.startsWith('yt:') ? track.id.slice(3).split('~')[0] : '');
  return (track.source === 'youtube' || track.id.startsWith('yt:')) && /^[\w-]{11}$/.test(id) ? id : null;
}

export const canDownload = (track: Track | null | undefined) => offlineId(track) !== null;
export const useIsDownloaded = (track: Track | null | undefined) => {
  const id = offlineId(track);
  return useStore(offline, (s) => (id ? id in s.downloaded : false));
};
export const useIsQueued = (track: Track | null | undefined) => {
  const id = offlineId(track);
  return useStore(offline, (s) => (id ? s.active === id || s.queue.includes(id) : false));
};

let running = false;
async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const [next, ...rest] = offline.get().queue;
      if (!next) break;
      offline.set({ queue: rest, active: next });
      try {
        const bytes = await invoke<number>('offline_download', { videoId: next });
        offline.set((s) => ({ downloaded: { ...s.downloaded, [next]: bytes } }));
      } catch {
        offline.set((s) => ({ failed: s.failed + 1 }));
      }
    }
  } finally {
    const { failed } = offline.get();
    offline.set({ active: null, failed: 0 });
    running = false;
    snack(failed ? t('offlineDoneWithErrors', { n: failed }) : t('offlineDone'));
  }
}

export function downloadTracks(tracks: Track[]) {
  if (!inTauri()) return;
  const s = offline.get();
  const ids = tracks
    .map(offlineId)
    .filter((id): id is string => !!id && !(id in s.downloaded) && s.active !== id && !s.queue.includes(id));
  if (!ids.length) {
    snack(t('offlineNothingToDo'));
    return;
  }
  offline.set({ queue: [...s.queue, ...ids] });
  snack(t('offlineQueued', { n: ids.length }));
  void pump();
}

export async function removeDownload(track: Track) {
  const id = offlineId(track);
  if (!id) return;
  await invoke('offline_remove', { videoId: id }).catch(() => {});
  offline.set((s) => {
    const downloaded = { ...s.downloaded };
    delete downloaded[id];
    return { downloaded, queue: s.queue.filter((q) => q !== id) };
  });
}

export function initOffline() {
  if (!inTauri()) return;
  invoke<{ videoId: string; bytes: number }[]>('offline_list')
    .then((items) => offline.set({ downloaded: Object.fromEntries(items.map((i) => [i.videoId, i.bytes])) }))
    .catch(() => {});
}
