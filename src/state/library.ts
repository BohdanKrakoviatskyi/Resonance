import { createStore, persist, uid } from '../lib/util';
import type { Playlist, SoundCloudPlaylist, Track } from '../types';
import {
  soundCloudAuthStatus, soundCloudPlaylistTracks, soundCloudPlaylistsMine, soundCloudTracksMine,
  ytMusicAuthStatus, ytMusicLibrarySync, ytMusicPlaylistArtwork, ytMusicPlaylistTracks,
} from '../lib/providers-api';
import { mapSoundCloudTrack } from '../lib/api';
import { mapYtMusicTracks, normalizeYtMusicPlaylist, type YtMusicPlaylist, type YtMusicProfile } from '../lib/ytmusic-library';
import { snack, ui, go } from './ui';
import { t } from '../lib/i18n';
import { player, next } from './player';

const volatile = new Map<string, Track>();
let librarySaveErrorShown = false;

/** Одноразовая зачистка устаревших данных Spotify в localStorage при старте */
function purgeRetiredSpotifyStorage() {
  try {
    const rawLib = localStorage.getItem('lyra.lib.v1');
    if (rawLib) {
      const parsed = JSON.parse(rawLib) as Record<string, unknown>;
      let changed = false;
      for (const k of ['spotifyLiked', 'spotifyPlaylists', 'spotifyPlaylistTracks', 'spotifyAuthorized', 'spotifyProfile']) {
        if (k in parsed) {
          delete parsed[k];
          changed = true;
        }
      }
      if (Array.isArray(parsed.liked)) {
        const nextLiked = (parsed.liked as string[]).filter((id) => !String(id).startsWith('sp:'));
        if (nextLiked.length !== (parsed.liked as string[]).length) {
          parsed.liked = nextLiked;
          changed = true;
        }
      }
      if (Array.isArray(parsed.recent)) {
        const nextRecent = (parsed.recent as string[]).filter((id) => !String(id).startsWith('sp:'));
        if (nextRecent.length !== (parsed.recent as string[]).length) {
          parsed.recent = nextRecent;
          changed = true;
        }
      }
      if (parsed.cache && typeof parsed.cache === 'object') {
        const cacheObj = parsed.cache as Record<string, unknown>;
        for (const id of Object.keys(cacheObj)) {
          if (id.startsWith('sp:')) {
            delete cacheObj[id];
            changed = true;
          }
        }
      }
      if (changed) {
        localStorage.setItem('lyra.lib.v1', JSON.stringify(parsed));
      }
    }

    const rawUi = localStorage.getItem('lyra.ui.v1');
    if (rawUi) {
      const parsedUi = JSON.parse(rawUi) as Record<string, unknown>;
      let changedUi = false;
      if ('foldSpotify' in parsedUi) {
        delete parsedUi.foldSpotify;
        changedUi = true;
      }
      if (parsedUi.favProvider !== 'soundcloud' && parsedUi.favProvider !== 'youtube') {
        parsedUi.favProvider = 'soundcloud';
        changedUi = true;
      }
      if (changedUi) {
        localStorage.setItem('lyra.ui.v1', JSON.stringify(parsedUi));
      }
    }
  } catch {
    /* ignore storage parse error */
  }
}

purgeRetiredSpotifyStorage();

export const library = createStore({
  liked: [] as string[],
  disliked: [] as string[],
  playlists: [] as Playlist[],
  soundcloudLiked: [] as Track[],
  soundcloudPlaylists: [] as SoundCloudPlaylist[],
  soundcloudPlaylistTracks: {} as Record<string, Track[]>,
  soundcloudLibraryLoading: false,
  soundcloudLibraryError: '',
  ytmusicLiked: [] as Track[],
  ytmusicPlaylists: [] as YtMusicPlaylist[],
  ytmusicPlaylistArt: {} as Record<string, string | null>,
  ytmusicPlaylistTracks: {} as Record<string, Track[]>,
  ytmusicLibraryLoading: false,
  ytmusicLibraryError: '',
  ytmusicAuthorized: false,
  ytmusicProfile: null as YtMusicProfile | null,
  cache: {} as Record<string, Track>,
  recent: [] as string[],
  _libraryCachedAt: 0,
});

const EXCLUDED_YTMUSIC_PLAYLIST_TITLES = new Set(['episodes for later', 'sounds from shorts', 'liked music']);
const visibleYtMusicPlaylists = (playlists: YtMusicPlaylist[]) =>
  playlists
    .map(normalizeYtMusicPlaylist)
    .filter((playlist) => !EXCLUDED_YTMUSIC_PLAYLIST_TITLES.has((playlist.title || '').trim().toLocaleLowerCase()));

function sanitizeStoredTrack(tr: Track): Track {
  if (!tr || typeof tr !== 'object') return tr;
  const id = String(tr.id || '');
  if (id.startsWith('yt:') || (tr.source as string) === 'ytmusic' || tr.source === 'youtube') {
    const videoId = String(tr.nativeId || (id.startsWith('yt:') ? id.slice(3) : '')).trim();
    const fallbackCover = videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : undefined;
    const cover = tr.cover || tr.thumb || fallbackCover;
    return {
      ...tr,
      id: videoId ? `yt:${videoId}` : id,
      cover,
      thumb: tr.thumb || cover,
      src: videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}` : tr.src || '',
      nativeId: videoId || tr.nativeId,
      playback: 'direct',
      preview: false,
      source: 'youtube',
    };
  }
  return tr;
}

/** Only keep external track metadata that is still referenced somewhere. */
function pruned(s: ReturnType<typeof library.get>) {
  const keep = new Set<string>([...s.liked, ...s.disliked, ...s.recent, ...s.playlists.flatMap((p) => p.ids), ...player.get().queue]);
  const out: Record<string, Track> = {};
  for (const id in s.cache) if (keep.has(id) && !id.startsWith('sp:')) out[id] = s.cache[id];
  return out;
}
persist('lyra.lib.v1', library, (s) => ({
  liked: s.liked, disliked: s.disliked, playlists: s.playlists, cache: pruned(s), recent: s.recent,
  soundcloudLiked: s.soundcloudLiked,
  soundcloudPlaylists: s.soundcloudPlaylists,
  soundcloudPlaylistTracks: s.soundcloudPlaylistTracks,
  ytmusicLiked: s.ytmusicLiked,
  ytmusicPlaylists: s.ytmusicPlaylists,
  ytmusicPlaylistArt: s.ytmusicPlaylistArt,
  ytmusicPlaylistTracks: s.ytmusicPlaylistTracks,
  ytmusicAuthorized: s.ytmusicAuthorized,
  ytmusicProfile: s.ytmusicProfile,
  _libraryCachedAt: Date.now(),
}), 350, () => {
  if (librarySaveErrorShown) return;
  librarySaveErrorShown = true;
  snack(t('librarySaveError'));
});

export const CORRUPTED_REPLACED_FAVORITE_IDS = new Set(['yt:hfMqB_XAH6k', 'yt:zHdQniNNTu0']);

const storedLibrary = library.get();
const sanitizedCache: Record<string, Track> = {};
for (const [k, v] of Object.entries(storedLibrary.cache ?? {})) {
  if (v && !k.startsWith('sp:')) sanitizedCache[k] = sanitizeStoredTrack(v);
}
const sanitizedYtPlaylistTracks: Record<string, Track[]> = {};
for (const [pid, tracks] of Object.entries(storedLibrary.ytmusicPlaylistTracks ?? {})) {
  if (Array.isArray(tracks) && tracks.length > 0) {
    sanitizedYtPlaylistTracks[pid] = tracks.map(sanitizeStoredTrack);
  }
}
const sanitizedScPlaylistTracks: Record<string, Track[]> = {};
for (const [urn, tracks] of Object.entries(storedLibrary.soundcloudPlaylistTracks ?? {})) {
  if (Array.isArray(tracks) && tracks.length > 0) {
    sanitizedScPlaylistTracks[urn] = tracks;
  }
}
const cleanedLiked = (storedLibrary.liked ?? []).filter((id) => !id.startsWith('sp:'));
const suspectReplacedFavoriteIds = ['yt:hfMqB_XAH6k', 'yt:zHdQniNNTu0'].filter((id) =>
  cleanedLiked.includes(id) || (storedLibrary.ytmusicLiked ?? []).some((tr) => tr?.id === id),
);
if (suspectReplacedFavoriteIds.length > 0) {
  console.warn(
    `[Library][FavoritesWarning] В Favorites обнаружены треки, сохранённые после старой авто-подмены (${suspectReplacedFavoriteIds.join(', ')}). Перелайкните оригинальные треки из плейлиста вручную.`,
  );
}
library.set({
  cache: sanitizedCache,
  liked: cleanedLiked,
  recent: (storedLibrary.recent ?? []).filter((id) => !id.startsWith('sp:')),
  soundcloudPlaylistTracks: sanitizedScPlaylistTracks,
  ytmusicLiked: (storedLibrary.ytmusicLiked ?? []).map(sanitizeStoredTrack),
  ytmusicPlaylists: visibleYtMusicPlaylists(storedLibrary.ytmusicPlaylists ?? []),
  ytmusicPlaylistTracks: sanitizedYtPlaylistTracks,
});

library.subscribe(() => {
  const s = library.get();
  registerTracks(s.soundcloudLiked ?? []);
  registerTracks(s.ytmusicLiked ?? []);
});

registerTracks(storedLibrary.soundcloudLiked ?? []);
registerTracks(storedLibrary.ytmusicLiked ?? []);
for (const tracks of Object.values(storedLibrary.soundcloudPlaylistTracks ?? {})) registerTracks(tracks);
for (const tracks of Object.values(sanitizedYtPlaylistTracks)) registerTracks(tracks);

const obsoletePlaylistNames = new Set([
  'вечерний чилл', 'evening chill', 'заряд энергии', 'energy boost', 'ночная дорога', 'night drive',
]);
library.set((s) => ({ playlists: s.playlists.filter((playlist) => !obsoletePlaylistNames.has(playlist.name.trim().toLocaleLowerCase())) }));

let libraryLoad: Promise<void> | undefined;
const playlistLoads = new Map<string, Promise<Track[]>>();
let ytmusicLoad: Promise<void> | undefined;
let ytmusicEpoch = 0;
const ytmusicPlaylistLoads = new Map<string, Promise<Track[]>>();
const ytmusicArtworkLoads = new Map<string, Promise<string | null>>();

export function loadSoundCloudLibrary(force = false): Promise<void> {
  if (libraryLoad) return force ? libraryLoad.then(() => loadSoundCloudLibrary(true)) : libraryLoad;
  library.set({ soundcloudLibraryLoading: true, soundcloudLibraryError: '' });
  libraryLoad = (async () => {
    try {
      const auth = await soundCloudAuthStatus();
      if (!auth.authorized) {
        clearSoundCloudLibrary();
        return;
      }
      const [likesResult, playlistsResult] = await Promise.allSettled([soundCloudTracksMine(), soundCloudPlaylistsMine()]);
      const current = library.get();
      const fetchedLiked = likesResult.status === 'fulfilled'
        ? likesResult.value
            .map(mapSoundCloudTrack)
            .filter((tr) => !CORRUPTED_REPLACED_FAVORITE_IDS.has(tr.id) && !current.disliked.includes(tr.id))
        : [];
      const fetchedPlaylists: SoundCloudPlaylist[] = playlistsResult.status === 'fulfilled'
        ? playlistsResult.value.map((playlist) => ({
            id: playlist.id,
            urn: playlist.urn || `soundcloud:playlists:${playlist.id}`,
            name: playlist.title,
            artworkUrl: playlist.artworkUrl || undefined,
            permalinkUrl: playlist.permalinkUrl || undefined,
            trackCount: playlist.trackCount,
            username: playlist.user?.username || auth.profile?.username || 'SoundCloud',
          }))
        : [];
      if (fetchedLiked.length > 0) registerTracks(fetchedLiked);
      library.set((state) => ({
        // Stale-While-Revalidate: никогда не затираем непустой кэш при ошибке или пустом сбойном ответе
        soundcloudLiked:
          likesResult.status === 'fulfilled' && (fetchedLiked.length > 0 || state.soundcloudLiked.length === 0)
            ? fetchedLiked
            : state.soundcloudLiked,
        soundcloudPlaylists:
          playlistsResult.status === 'fulfilled' && (fetchedPlaylists.length > 0 || state.soundcloudPlaylists.length === 0)
            ? fetchedPlaylists
            : state.soundcloudPlaylists,
        soundcloudLibraryError:
          likesResult.status === 'rejected' && playlistsResult.status === 'rejected'
            ? String(likesResult.reason)
            : likesResult.status === 'rejected'
            ? String(likesResult.reason)
            : playlistsResult.status === 'rejected'
            ? String(playlistsResult.reason)
            : '',
      }));

      // В фоне предзагружаем треки всех сохранённых плейлистов SoundCloud
      const playlistsToWarm = library.get().soundcloudPlaylists;
      void (async () => {
        for (const pl of playlistsToWarm) {
          if (!pl.urn) continue;
          try {
            await loadSoundCloudPlaylistTracks(pl.urn, force);
          } catch {
            /* ignore background playlist warm error */
          }
        }
      })();
    } catch (error) {
      // Никогда не очищаем существующий кэш при сетевой ошибке!
      library.set({ soundcloudLibraryError: error instanceof Error ? error.message : String(error) });
    } finally {
      library.set({ soundcloudLibraryLoading: false });
      libraryLoad = undefined;
    }
  })();
  return libraryLoad;
}

export function clearSoundCloudLibrary() {
  libraryLoad = undefined;
  playlistLoads.clear();
  library.set({
    soundcloudLiked: [], soundcloudPlaylists: [], soundcloudPlaylistTracks: {},
    soundcloudLibraryLoading: false, soundcloudLibraryError: '',
  });
}

export function reloadSoundCloudPlaylistTracks(urn: string): Promise<Track[]> {
  return loadSoundCloudPlaylistTracks(urn, true);
}

export function loadSoundCloudPlaylistTracks(urn: string, force = false): Promise<Track[]> {
  const cached = library.get().soundcloudPlaylistTracks[urn];
  const pending = playlistLoads.get(urn);
  if (pending && !force) return pending;

  const revalidate = () => {
    const existingPending = playlistLoads.get(urn);
    if (existingPending) return existingPending;
    const request = soundCloudPlaylistTracks(urn)
      .then((cards) => {
        const tracks = cards.map(mapSoundCloudTrack);
        if (tracks.length === 0) return cached ?? [];
        registerTracks(tracks);
        library.set((state) => ({
          soundcloudPlaylistTracks: { ...state.soundcloudPlaylistTracks, [urn]: tracks },
        }));
        return tracks;
      })
      .finally(() => playlistLoads.delete(urn));
    playlistLoads.set(urn, request);
    return request;
  };

  if (cached && cached.length > 0 && !force) {
    registerTracks(cached);
    void revalidate().catch(() => {});
    return Promise.resolve(cached);
  }

  return revalidate();
}

export function loadYtMusicLibrary(force = false): Promise<void> {
  if (ytmusicLoad) return force ? ytmusicLoad.then(() => loadYtMusicLibrary(true)) : ytmusicLoad;
  const cached = library.get();
  const epoch = ytmusicEpoch;
  library.set({ ytmusicLibraryLoading: true, ytmusicLibraryError: '' });
  const request = (async () => {
    try {
      const auth = await ytMusicAuthStatus();
      if (epoch !== ytmusicEpoch) return;
      if (!auth.authorized) {
        clearYtMusicLibrary();
        return;
      }
      library.set({ ytmusicAuthorized: true, ytmusicProfile: auth.profile ?? cached.ytmusicProfile });
      const result = await ytMusicLibrarySync();
      if (epoch !== ytmusicEpoch) return;
      const current = library.get();
      const liked = mapYtMusicTracks(result.likedSongs).filter(
        (tr) => !CORRUPTED_REPLACED_FAVORITE_IDS.has(tr.id) && !current.disliked.includes(tr.id),
      );
      const playlists = visibleYtMusicPlaylists(result.playlists);
      if (liked.length > 0) registerTracks(liked);
      library.set((state) => ({
        // Stale-While-Revalidate: никогда не затираем кэш пустым ответом при сбое и не возвращаем повреждённые ID
        ytmusicLiked:
          (liked.length > 0 || state.ytmusicLiked.length === 0 ? liked : state.ytmusicLiked).filter(
            (tr) => !CORRUPTED_REPLACED_FAVORITE_IDS.has(tr.id) && !state.disliked.includes(tr.id),
          ),
        ytmusicPlaylists: playlists.length > 0 || state.ytmusicPlaylists.length === 0 ? playlists : state.ytmusicPlaylists,
        ytmusicProfile: result.profile ?? auth.profile ?? state.ytmusicProfile ?? null,
        ytmusicLibraryError: '',
      }));

      // В фоне предзагружаем/обновляем треки для всех сохранённых плейлистов YouTube Music
      const playlistsToWarm = library.get().ytmusicPlaylists;
      void (async () => {
        for (const pl of playlistsToWarm) {
          if (epoch !== ytmusicEpoch || !pl.playlistId) break;
          try {
            await loadYtMusicPlaylistTracks(pl.playlistId, force);
          } catch {
            /* ignore background playlist warm error */
          }
        }
      })();
    } catch (error) {
      if (epoch !== ytmusicEpoch) return;
      // Никогда не затираем существующий кэш при сетевой ошибке!
      library.set({ ytmusicLibraryError: error instanceof Error ? error.message : String(error) });
    } finally {
      if (epoch === ytmusicEpoch) library.set({ ytmusicLibraryLoading: false });
    }
  })();
  ytmusicLoad = request;
  void request.finally(() => {
    if (ytmusicLoad === request) ytmusicLoad = undefined;
  });
  return request;
}

export function clearYtMusicLibrary() {
  ytmusicEpoch += 1;
  ytmusicLoad = undefined;
  ytmusicArtworkLoads.clear();
  library.set({
    ytmusicLiked: [], ytmusicPlaylists: [], ytmusicPlaylistArt: {}, ytmusicPlaylistTracks: {},
    ytmusicLibraryLoading: false, ytmusicLibraryError: '', ytmusicAuthorized: false, ytmusicProfile: null,
  });
}

export function loadYtMusicPlaylistArtwork(playlistId: string): Promise<string | null> {
  const cached = library.get().ytmusicPlaylistArt;
  if (playlistId in cached) return Promise.resolve(cached[playlistId]);
  const pending = ytmusicArtworkLoads.get(playlistId);
  if (pending) return pending;
  const epoch = ytmusicEpoch;
  const request = ytMusicPlaylistArtwork(playlistId)
    .then((art) => {
      if (epoch === ytmusicEpoch) {
        library.set((state) => ({ ytmusicPlaylistArt: { ...state.ytmusicPlaylistArt, [playlistId]: art ?? null } }));
      }
      return art ?? null;
    })
    .catch(() => null)
    .finally(() => ytmusicArtworkLoads.delete(playlistId));
  ytmusicArtworkLoads.set(playlistId, request);
  return request;
}

export function loadYtMusicPlaylistTracks(playlistId: string, force = false): Promise<Track[]> {
  const cached = library.get().ytmusicPlaylistTracks[playlistId];
  const pending = ytmusicPlaylistLoads.get(playlistId);
  if (pending && !force) return pending;

  const epoch = ytmusicEpoch;
  const revalidate = () => {
    const existingPending = ytmusicPlaylistLoads.get(playlistId);
    if (existingPending) return existingPending;
    const request = ytMusicPlaylistTracks(playlistId).then((playlist) => {
      const tracks = mapYtMusicTracks(playlist.tracks ?? []);
      if (tracks.length === 0) {
        throw new Error('Плейлист YouTube Music вернул 0 треков');
      }
      if (epoch === ytmusicEpoch) {
        registerTracks(tracks);
        const fallbackArt = playlist.artworkUrl || tracks[0]?.cover || null;
        library.set((state) => ({
          ytmusicPlaylistTracks: { ...state.ytmusicPlaylistTracks, [playlistId]: tracks },
          ytmusicPlaylistArt: fallbackArt && !state.ytmusicPlaylistArt[playlistId]
            ? { ...state.ytmusicPlaylistArt, [playlistId]: fallbackArt }
            : state.ytmusicPlaylistArt,
          ytmusicPlaylists: state.ytmusicPlaylists.map((p) =>
            p.playlistId === playlistId
              ? normalizeYtMusicPlaylist({
                  ...p,
                  artworkUrl: p.artworkUrl || fallbackArt,
                  trackCount: p.trackCount > 0 ? p.trackCount : tracks.length,
                })
              : p
          ),
        }));
      }
      return tracks;
    }).finally(() => ytmusicPlaylistLoads.delete(playlistId));
    ytmusicPlaylistLoads.set(playlistId, request);
    return request;
  };

  if (cached && cached.length > 0 && !force) {
    registerTracks(cached);
    void revalidate().catch(() => {});
    return Promise.resolve(cached);
  }

  return revalidate();
}

export function reloadYtMusicPlaylistTracks(playlistId: string): Promise<Track[]> {
  return loadYtMusicPlaylistTracks(playlistId, true);
}

export const getTrack = (id: string): Track | undefined => library.get().cache[id] ?? volatile.get(id);

export function registerTracks(ts: Track[]) {
  for (const x of ts) volatile.set(x.id, x);
}

export function ensureCached(id: string) {
  if (library.get().cache[id]) return;
  const tr =
    volatile.get(id) ??
    library.get().soundcloudLiked.find((x) => x.id === id) ??
    library.get().ytmusicLiked.find((x) => x.id === id) ??
    Object.values(library.get().ytmusicPlaylistTracks).flat().find((x) => x.id === id) ??
    Object.values(library.get().soundcloudPlaylistTracks).flat().find((x) => x.id === id);
  if (tr) {
    volatile.set(id, tr);
    library.set((s) => ({ cache: { ...s.cache, [id]: tr } }));
  }
}

let cachedLibRef: ReturnType<typeof library.get> | null = null;
let cachedLikedRef: string[] | null = null;
let cachedDislikedRef: string[] | null = null;
let cachedScLikedRef: Track[] | null = null;
let cachedYtLikedRef: Track[] | null = null;
let cachedCacheRef: Record<string, Track> | null = null;
let likedIdsSet = new Set<string>();
let dislikedIdsSet = new Set<string>();
let favSoundCloudIds: string[] = [];
let favYouTubeIds: string[] = [];

function ensureLibraryIndexes(s = library.get()) {
  if (
    cachedLibRef === s ||
    (cachedLikedRef === s.liked &&
      cachedDislikedRef === s.disliked &&
      cachedScLikedRef === s.soundcloudLiked &&
      cachedYtLikedRef === s.ytmusicLiked &&
      cachedCacheRef === s.cache)
  ) {
    cachedLibRef = s;
    return;
  }
  cachedLibRef = s;
  cachedLikedRef = s.liked;
  cachedDislikedRef = s.disliked;
  cachedScLikedRef = s.soundcloudLiked;
  cachedYtLikedRef = s.ytmusicLiked;
  cachedCacheRef = s.cache;
  dislikedIdsSet = new Set(s.disliked);
  likedIdsSet = new Set<string>();
  for (const id of s.liked) {
    if (!dislikedIdsSet.has(id)) likedIdsSet.add(id);
  }
  for (const tr of s.soundcloudLiked) {
    if (!dislikedIdsSet.has(tr.id)) likedIdsSet.add(tr.id);
  }
  for (const tr of s.ytmusicLiked) {
    if (!dislikedIdsSet.has(tr.id)) likedIdsSet.add(tr.id);
  }

  const inferProvider = (id: string, tr?: Track): 'soundcloud' | 'youtube' | null => {
    if (tr?.source === 'soundcloud' || id.startsWith('sc:')) return 'soundcloud';
    if (tr?.source === 'youtube' || (tr?.source as string) === 'ytmusic' || id.startsWith('yt:')) return 'youtube';
    return null;
  };

  const buildFavList = (provider: 'soundcloud' | 'youtube', providerTracks: Track[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of s.liked) {
      if (seen.has(id) || dislikedIdsSet.has(id)) continue;
      const tr = s.cache[id] ?? volatile.get(id);
      if (inferProvider(id, tr) === provider) {
        seen.add(id);
        out.push(id);
      }
    }
    for (const tr of providerTracks) {
      const id = tr.id;
      if (seen.has(id) || dislikedIdsSet.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };

  favSoundCloudIds = buildFavList('soundcloud', s.soundcloudLiked);
  favYouTubeIds = buildFavList('youtube', s.ytmusicLiked);
}

export const isLiked = (id: string) => {
  ensureLibraryIndexes();
  return likedIdsSet.has(id);
};

export const isDisliked = (id: string) => {
  ensureLibraryIndexes();
  return dislikedIdsSet.has(id);
};

export const getFavoriteIds = (provider: 'soundcloud' | 'youtube'): string[] => {
  ensureLibraryIndexes();
  if (provider === 'soundcloud') return favSoundCloudIds;
  return favYouTubeIds;
};

export function toggleLike(id: string): boolean {
  ensureCached(id);
  const s = library.get();
  const currentlyLiked = isLiked(id);
  const on = !currentlyLiked;
  library.set({
    liked: on ? [id, ...s.liked.filter((x) => x !== id)] : s.liked.filter((x) => x !== id),
    disliked: !on ? [id, ...s.disliked.filter((x) => x !== id)] : s.disliked.filter((x) => x !== id),
    soundcloudLiked: on ? s.soundcloudLiked : s.soundcloudLiked.filter((t) => t.id !== id),
    ytmusicLiked: on ? s.ytmusicLiked : s.ytmusicLiked.filter((t) => t.id !== id),
  });
  snack(t(on ? 'addedFav' : 'removedFav'));
  return on;
}

export function toggleDislike(id: string) {
  ensureCached(id);
  const s = library.get();
  const on = !s.disliked.includes(id);
  library.set({
    disliked: on ? [id, ...s.disliked] : s.disliked.filter((x) => x !== id),
    liked: on ? s.liked.filter((x) => x !== id) : s.liked,
  });
  if (on) {
    snack(t('dislikedMsg'), { label: t('undo'), run: () => toggleDislike(id) });
    const p = player.get();
    if (p.queue[p.index] === id && p.queue.length > 1) next();
  }
}

export function createPlaylist(name: string, trackId?: string) {
  const p: Playlist = { id: uid(), name: name.trim() || t('newPlaylist'), ids: trackId ? [trackId] : [], created: Date.now() };
  if (trackId) ensureCached(trackId);
  library.set((s) => ({ playlists: [...s.playlists, p] }));
  snack(t('playlistCreated', { name: p.name }));
  return p.id;
}

export function renamePlaylist(id: string, name: string) {
  library.set((s) => ({ playlists: s.playlists.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)) }));
}

export function deletePlaylist(id: string) {
  const r = ui.get().route;
  if (r.name === 'playlist' && r.id === id) go({ name: 'home' }, true);
  library.set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id) }));
}

export function togglePlaylistTrack(pid: string, tid: string) {
  ensureCached(tid);
  const p = library.get().playlists.find((x) => x.id === pid);
  if (!p) return;
  const has = p.ids.includes(tid);
  library.set((s) => ({
    playlists: s.playlists.map((x) => (x.id === pid ? { ...x, ids: has ? x.ids.filter((i) => i !== tid) : [...x.ids, tid] } : x)),
  }));
  snack(t(has ? 'removedFrom' : 'addedTo', { name: p.name }), { label: t('undo'), run: () => togglePlaylistTrack(pid, tid) });
}

export function pushRecent(id: string) {
  library.set((s) => ({ recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, 20) }));
}

export function searchLocal(q: string): string[] {
  const n = q.toLowerCase();
  const s = library.get();
  const all = new Map<string, Track>(Object.entries(s.cache));
  for (const tr of s.soundcloudLiked) all.set(tr.id, tr);
  for (const tr of s.ytmusicLiked) all.set(tr.id, tr);
  return [...all.values()]
    .filter((x) => `${x.title} ${x.artist} ${x.album ?? ''}`.toLowerCase().includes(n))
    .slice(0, 8)
    .map((x) => x.id);
}
