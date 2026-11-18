import { invoke } from '@tauri-apps/api/core';
import { createStore, persist } from '../lib/util';
import { t } from '../lib/i18n';
import type { Playlist, Track } from '../types';
import { library, registerTracks } from './library';

/** Fixed id of the auto-maintained "Local files" playlist. */
export const LOCAL_PLAYLIST_ID = 'local-library';

interface LocalTrackDto {
  id: string;
  path: string;
  title: string;
  artist: string;
  album?: string | null;
  duration: number;
  hasCover: boolean;
}

export const localLibrary = createStore({
  folders: [] as string[],
  scanning: false,
  count: 0,
  error: '',
});

persist('resonance.local.v1', localLibrary, (s) => ({ folders: s.folders, count: s.count }));

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Relay base + token; both change on every launch, so they are fetched, never persisted. */
let relay: Promise<[string, string]> | null = null;
const getRelay = () => (relay ??= invoke<[string, string]>('local_base_url').catch((e) => ((relay = null), Promise.reject(e))));

export async function localStreamUrl(track: Track): Promise<string> {
  const [base, token] = await getRelay();
  return `${base}/local/${encodeURIComponent(track.nativeId ?? '')}?t=${encodeURIComponent(token)}`;
}

export function isLocalTrack(track: Track | null | undefined): boolean {
  return !!track && (track.source as string) === 'local';
}

function toTrack(d: LocalTrackDto, base: string, token: string): Track {
  return {
    id: `local:${d.id}`,
    nativeId: d.id,
    title: d.title,
    artist: d.artist,
    album: d.album ?? undefined,
    cover: d.hasCover ? `${base}/local-cover/${d.id}?t=${encodeURIComponent(token)}` : undefined,
    src: `local:${d.id}`,
    duration: Math.round(d.duration),
    playback: 'direct',
    source: 'local',
  };
}

export async function rescanLocal() {
  if (!inTauri()) return;
  const { folders } = localLibrary.get();
  localLibrary.set({ scanning: true, error: '' });
  try {
    const [dtos, [base, token]] = await Promise.all([invoke<LocalTrackDto[]>('local_scan', { folders }), getRelay()]);
    const tracks = dtos.map((d) => toTrack(d, base, token));
    registerTracks(tracks);
    library.set((s) => {
      const cache = { ...s.cache };
      // Drop entries for files that disappeared, refresh the rest (cover URLs change per launch).
      for (const id of Object.keys(cache)) if (id.startsWith('local:')) delete cache[id];
      for (const tr of tracks) cache[tr.id] = tr;
      const ids = tracks.map((tr) => tr.id);
      const existing = s.playlists.find((p) => p.id === LOCAL_PLAYLIST_ID);
      let playlists: Playlist[];
      if (!ids.length) playlists = s.playlists.filter((p) => p.id !== LOCAL_PLAYLIST_ID);
      else if (existing) playlists = s.playlists.map((p) => (p.id === LOCAL_PLAYLIST_ID ? { ...p, ids, name: t('localFiles') } : p));
      else playlists = [...s.playlists, { id: LOCAL_PLAYLIST_ID, name: t('localFiles'), ids, created: Date.now() }];
      return { cache, playlists };
    });
    localLibrary.set({ count: tracks.length });
  } catch (e) {
    localLibrary.set({ error: String(e) });
  } finally {
    localLibrary.set({ scanning: false });
  }
}

export async function addLocalFolder() {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: true, title: t('localAddFolder') });
  const list = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(Boolean) as string[];
  if (!list.length) return;
  localLibrary.set((s) => ({ folders: [...new Set([...s.folders, ...list])] }));
  await rescanLocal();
}

export async function removeLocalFolder(folder: string) {
  localLibrary.set((s) => ({ folders: s.folders.filter((f) => f !== folder) }));
  await rescanLocal();
}

export function initLocalLibrary() {
  if (localLibrary.get().folders.length) void rescanLocal();
}
