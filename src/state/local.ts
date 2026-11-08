import { createStore, uid } from '../lib/util';
import type { LocalFolder, Track } from '../types';
import { library, registerTracks, ensureCached, getTrack } from './library';
import { idbGetAll, idbPutFile, idbDeleteFile, idbClearFiles } from '../lib/local-idb';
import { isAudioFile, buildTrackFromFile, folderNameFromFiles, probeDurations } from '../lib/local-import';
import { snack, go } from './ui';
import { t } from '../lib/i18n';

export const local = createStore({
  initDone: false,
  importing: false,
  durations: {} as Record<string, number>,
});

let hydrating = false;

async function hydrate() {
  if (hydrating) return;
  hydrating = true;
  try {
    const folders = library.get().localFolders ?? [];
    if (!folders.length) return;
    const files = await idbGetAll().catch(() => [] as [string, Blob][]);
    const map = new Map(files);
    const tracks: Track[] = [];
    for (const folder of folders) {
      for (const id of folder.trackIds) {
        if (getTrack(id)) continue;
        const blob = map.get(id);
        if (!blob) continue;
        // восстановить Track из кэша (title/artist и т.д.) или собрать заново
        const cached = library.get().cache[id];
        if (cached) {
          tracks.push({ ...cached, src: URL.createObjectURL(blob) });
        } else {
          const rel = id.replace(`local:${folder.id}:`, '');
          const name = rel.split('/').pop() ?? rel;
          const tr = buildTrackFromFile(new File([blob], name, { type: blob.type }), folder.id, folder.name);
          // переопределить id/src чтобы совпало
          tr.id = id;
          tracks.push(tr);
        }
      }
    }
    registerTracks(tracks);
    if (tracks.length) {
      const cache = { ...library.get().cache };
      for (const tr of tracks) cache[tr.id] = tr;
      library.set({ cache });
      // доделать длительности в фоне
      void probeDurations(tracks, (id, d) => {
        local.set((s) => ({ durations: { ...s.durations, [id]: d } }));
        const tr = getTrack(id);
        if (tr) library.set((s) => ({ cache: { ...s.cache, [id]: { ...tr, duration: d } } }));
      });
    }
  } finally {
    hydrating = false;
    local.set({ initDone: true });
  }
}

export function initLocal() {
  if (!local.get().initDone) void hydrate();
}

export function getLocalFolderTracks(folder: LocalFolder): Track[] {
  return folder.trackIds.map((id) => getTrack(id)).filter((x): x is Track => !!x);
}

export async function importFolder(files: File[]): Promise<string | null> {
  const audio = files.filter((f) => isAudioFile(f.name));
  if (!audio.length) {
    snack(t('noAudioFiles'));
    return null;
  }
  const existing = library.get().localFolders ?? [];
  const name = folderNameFromFiles(audio);
  // проверка на дубль папки по имени + числу файлов (простой дедуп)
  const duplicate = existing.find((f) => f.name === name && f.trackIds.length === audio.length);
  if (duplicate) {
    snack(t('folderUnsupported'));
    return duplicate.id;
  }
  local.set({ importing: true });
  try {
    const folderId = uid();
    const tracks = audio.map((f) => buildTrackFromFile(f, folderId, name));
    // сохранить файлы в IndexedDB
    for (let i = 0; i < audio.length; i++) {
      await idbPutFile(tracks[i].id, audio[i]).catch(() => {});
    }
    registerTracks(tracks);
    const cache = { ...library.get().cache };
    for (const tr of tracks) cache[tr.id] = tr;
    const folder: LocalFolder = { id: folderId, name, trackIds: tracks.map((tr) => tr.id), created: Date.now() };
    library.set({ cache, localFolders: [...existing, folder] });
    snack(t('folderImported', { name }));
    void probeDurations(tracks, (id, d) => {
      local.set((s) => ({ durations: { ...s.durations, [id]: d } }));
      const tr = getTrack(id);
      if (tr) library.set((s) => ({ cache: { ...s.cache, [id]: { ...tr, duration: d } } }));
    });
    return folderId;
  } finally {
    local.set({ importing: false });
  }
}

export async function removeFolder(folderId: string) {
  const folder = library.get().localFolders.find((f) => f.id === folderId);
  if (!folder) return;
  // отменить воспроизведение если играем оттуда — просто убрать из библиотеки
  const ids = folder.trackIds;
  for (const id of ids) await idbDeleteFile(id).catch(() => {});
  await idbClearFiles(ids).catch(() => {});
  library.set((s) => ({ localFolders: s.localFolders.filter((f) => f.id !== folderId) }));
  const r = (await import('../state/ui')).ui.get().route;
  if (r.name === 'local' && r.id === folderId) go({ name: 'home' }, true);
}

// Убеждаемся что track в cache (для likes/playlists)
export function ensureLocalCached(id: string) {
  ensureCached(id);
}
