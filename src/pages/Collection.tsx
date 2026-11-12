import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, EmptyState, IconButton, Loader } from '../components/ui';
import { FavCover, PlaylistCover } from '../components/Cover';
import { TrackList } from '../components/TrackList';
import { useStore } from '../lib/util';
import { durLabel, t, tracksLabel } from '../lib/i18n';
import {
  getFavoriteIds,
  getTrack,
  library,
  loadSoundCloudLibrary,
  loadSoundCloudPlaylistTracks,
  loadYtMusicLibrary,
  loadYtMusicPlaylistArtwork,
  loadYtMusicPlaylistTracks,
  reloadSoundCloudPlaylistTracks,
  reloadYtMusicPlaylistTracks,
} from '../state/library';
import { player, playQueue, prefetchPlaylistTopTracks, shufflePlay, toggle } from '../state/player';
import { go, openDialog, openSearch, ui } from '../state/ui';
import { parseSoundCloudCollectionId } from '../lib/soundcloud-library';
import { parseYtMusicCollectionId } from '../lib/ytmusic-library';
import soundcloudLogo from '../assets/soundcloud.svg';
import youtubeMusicLogo from '../assets/youtube-music.svg';

export default function Collection({ kind, id }: { kind: 'favorites' | 'playlist'; id?: string }) {
  const liked = useStore(library, (s) => s.liked);
  const soundcloudLiked = useStore(library, (s) => s.soundcloudLiked);
  const localPlaylist = useStore(library, (s) => (kind === 'playlist' ? s.playlists.find((p) => p.id === id) : undefined));
  const scCollection = kind === 'playlist' ? parseSoundCloudCollectionId(id) : null;
  const remoteId = scCollection?.kind === 'playlist' ? scCollection.playlistId : undefined;
  const remotePlaylist = useStore(library, (s) => (remoteId ? s.soundcloudPlaylists.find((p) => p.id === remoteId) : undefined));
  const cachedRemoteTracks = useStore(library, (s) => (remotePlaylist ? s.soundcloudPlaylistTracks[remotePlaylist.urn] ?? null : null));

  const ytCollection = kind === 'playlist' ? parseYtMusicCollectionId(id) : null;
  const ytPlaylistId = ytCollection?.kind === 'playlist' ? ytCollection.playlistId : undefined;
  const ytPlaylist = useStore(library, (s) => (ytPlaylistId ? s.ytmusicPlaylists.find((p) => p.playlistId === ytPlaylistId) : undefined));
  const cachedYtTracks = useStore(library, (s) => (ytPlaylistId ? s.ytmusicPlaylistTracks[ytPlaylistId] ?? null : null));
  const ytmusicLiked = useStore(library, (s) => s.ytmusicLiked);
  const ytmusicArtCache = useStore(library, (s) => s.ytmusicPlaylistArt);
  const ytmusicLibraryLoading = useStore(library, (s) => s.ytmusicLibraryLoading);
  const ytmusicLibraryError = useStore(library, (s) => s.ytmusicLibraryError);
  const soundcloudLibraryLoading = useStore(library, (s) => s.soundcloudLibraryLoading);
  const soundcloudLibraryError = useStore(library, (s) => s.soundcloudLibraryError);

  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [ytLoading, setYtLoading] = useState(false);
  const [ytError, setYtError] = useState('');
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const cache = useStore(library, (s) => s.cache);

  const ytCollectionTracks = ytCollection?.kind === 'liked' ? ytmusicLiked : cachedYtTracks ?? [];
  const ytCollectionName = ytCollection?.kind === 'liked' ? t('ytmusicLiked') : ytPlaylist?.title;
  const ytArt = ytPlaylistId ? ytmusicArtCache[ytPlaylistId] ?? ytPlaylist?.artworkUrl ?? undefined : undefined;
  useEffect(() => {
    if (ytPlaylistId && !(ytPlaylistId in ytmusicArtCache)) void loadYtMusicPlaylistArtwork(ytPlaylistId);
  }, [ytPlaylistId, ytmusicArtCache]);

  const ytPl =
    ytCollection && (ytCollection.kind !== 'playlist' || ytPlaylist)
      ? {
          id: id!,
          name: ytCollectionName ?? t('notFound'),
          ids: ytCollectionTracks.map((track) => track.id),
          created: 0,
          artworkUrl: ytArt,
        }
      : undefined;

  const scPl =
    scCollection?.kind === 'liked'
      ? {
          id: id!,
          name: t('soundcloudLiked'),
          ids: soundcloudLiked.map((track) => track.id),
          created: 0,
        }
      : remotePlaylist
      ? {
          id: `scpl:${remotePlaylist.id}`,
          name: remotePlaylist.name,
          ids: cachedRemoteTracks?.map((track) => track.id) ?? [],
          created: 0,
          artworkUrl: remotePlaylist.artworkUrl,
        }
      : undefined;

  const pl = localPlaylist ?? scPl ?? ytPl;
  const isProviderPlaylist = Boolean(scCollection) || Boolean(ytCollection);

  useEffect(() => {
    if (!remotePlaylist) {
      setRemoteLoading(false);
      return;
    }
    const hasCached = Boolean(cachedRemoteTracks && cachedRemoteTracks.length > 0);
    let alive = true;
    setRemoteLoading(!hasCached);
    setRemoteError('');
    void loadSoundCloudPlaylistTracks(remotePlaylist.urn)
      .catch((error: unknown) => {
        if (alive && !hasCached) setRemoteError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => alive && setRemoteLoading(false));
    return () => {
      alive = false;
    };
  }, [remotePlaylist?.urn]);

  useEffect(() => {
    if (!ytPlaylistId) {
      setYtLoading(false);
      return;
    }
    const hasCached = Boolean(cachedYtTracks && cachedYtTracks.length > 0);
    let alive = true;
    setYtLoading(!hasCached);
    setYtError('');
    void loadYtMusicPlaylistTracks(ytPlaylistId)
      .catch((error: unknown) => {
        if (alive && !hasCached) setYtError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => alive && setYtLoading(false));
    return () => {
      alive = false;
    };
  }, [ytPlaylistId]);

  const disliked = useStore(library, (s) => s.disliked);
  const favProvider = useStore(ui, (s) => s.favProvider);

  const ids = useMemo(() => {
    if (kind === 'favorites') {
      return getFavoriteIds(favProvider);
    }
    const sourceIds = pl?.ids ?? [];
    return sourceIds.filter((trackId) => !!getTrack(trackId));
  }, [kind, liked, soundcloudLiked, ytmusicLiked, disliked, cache, favProvider, pl]);

  // При открытии плейлиста (с задержкой 300 мс) ставим в фоновый префетч (priority: false) только топ-2 первых трека
  useEffect(() => {
    if (!ids.length) return;
    const timer = setTimeout(() => {
      prefetchPlaylistTopTracks(ids);
    }, 300);
    return () => clearTimeout(timer);
  }, [kind, id, favProvider, ids[0], ids[1]]);

  const playingHere = useStore(player, (s) => s.playing && ids.includes(s.queue[s.index]));

  const virtualCollection = ytCollection?.kind === 'liked';
  const favProviderLoading =
    favProvider === 'soundcloud'
      ? soundcloudLibraryLoading
      : ytmusicLibraryLoading;
  const isRefreshingFavorites = manualRefreshing || soundcloudLibraryLoading || ytmusicLibraryLoading;

  const refreshFavoritesAndPlaylists = async () => {
    if (isRefreshingFavorites) return;
    setManualRefreshing(true);
    try {
      await Promise.allSettled([
        loadSoundCloudLibrary(true),
        loadYtMusicLibrary(true),
      ]);
    } finally {
      setManualRefreshing(false);
    }
  };

  const loading =
    remoteLoading ||
    ytLoading ||
    Boolean(ytPlaylistId && (!cachedYtTracks || cachedYtTracks.length === 0) && !ytError) ||
    Boolean(virtualCollection && ytmusicLibraryLoading && !ids.length) ||
    Boolean(kind === 'favorites' && favProviderLoading && !ids.length);

  const providerError =
    remoteError ||
    ytError ||
    (ytCollection?.kind === 'liked' && !ids.length ? ytmusicLibraryError : '');

  const retryRemote = async () => {
    try {
      if (remotePlaylist) await reloadSoundCloudPlaylistTracks(remotePlaylist.urn);
      else if (ytPlaylistId) await reloadYtMusicPlaylistTracks(ytPlaylistId);
      else if (ytCollection) await loadYtMusicLibrary(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (remotePlaylist) setRemoteError(message);
      else setYtError(message);
    }
  };

  if (kind === 'playlist' && !pl && remoteId && soundcloudLibraryLoading) {
    return (
      <div className="page grid min-h-48 place-items-center">
        <Loader />
      </div>
    );
  }
  if (kind === 'playlist' && !pl && remoteId && soundcloudLibraryError) {
    return (
      <div className="page">
        <EmptyState
          icon="wifi_off"
          title={t('loadError')}
          text={soundcloudLibraryError}
          action={
            <Button icon="home" onClick={() => go({ name: 'home' })}>
              {t('home')}
            </Button>
          }
        />
      </div>
    );
  }
  if (kind === 'playlist' && !pl && ytCollection && ytmusicLibraryLoading) {
    return (
      <div className="page grid min-h-48 place-items-center">
        <Loader />
      </div>
    );
  }
  if (kind === 'playlist' && !pl && ytCollection && ytmusicLibraryError) {
    return (
      <div className="page">
        <EmptyState
          icon="wifi_off"
          title={t('loadError')}
          text={ytmusicLibraryError}
          action={
            <Button icon="home" onClick={() => go({ name: 'home' })}>
              {t('home')}
            </Button>
          }
        />
      </div>
    );
  }

  if (kind === 'playlist' && !pl)
    return (
      <div className="page">
        <EmptyState
          icon="queue_music"
          title={t('notFound')}
          action={
            <Button icon="home" onClick={() => go({ name: 'home' })}>
              {t('home')}
            </Button>
          }
        />
      </div>
    );

  const total = ids.reduce((a, x) => a + (getTrack(x)?.duration ?? 0), 0);
  const name = kind === 'favorites' ? t('favorites') : pl!.name;

  return (
    <div className="page">
      <header className="anim-in relative mb-8 mt-2 flex flex-col items-center gap-6 text-center @2xl:flex-row @2xl:items-end @2xl:text-left">
        {kind === 'favorites' && (
          <div className="flex items-center gap-1.5 self-end @2xl:absolute @2xl:right-0 @2xl:top-0">
            <div className="seg seg-sm" role="group" aria-label={t('providers')}>
              <button
                type="button"
                data-ripple
                className="sl"
                aria-pressed={favProvider === 'soundcloud'}
                onClick={() => ui.set({ favProvider: 'soundcloud' })}
              >
                <img src={soundcloudLogo} alt="" aria-hidden="true" className="provider-logo" />
                <span>SoundCloud</span>
              </button>
              <button
                type="button"
                data-ripple
                className="sl"
                aria-pressed={favProvider === 'youtube'}
                onClick={() => ui.set({ favProvider: 'youtube' })}
              >
                <img src={youtubeMusicLogo} alt="" aria-hidden="true" className="provider-logo" />
                <span>YouTube Music</span>
              </button>
            </div>
            <button
              type="button"
              data-ripple
              disabled={isRefreshingFavorites}
              aria-label={t('providerRefresh')}
              title={t('providerRefresh')}
              onClick={() => void refreshFavoritesAndPlaylists()}
              className="sl inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--md-on-surface)_8%,transparent)] text-on-surface-variant transition-colors disabled:pointer-events-none disabled:opacity-50"
            >
              <Icon
                name="refresh"
                size={19}
                className={isRefreshingFavorites ? 'animate-[spin_0.9s_linear_infinite]' : undefined}
              />
            </button>
          </div>
        )}
        {kind === 'favorites' ? (
          <FavCover size={220} className="h-[220px] w-[220px] rounded-[36px] shadow-2xl" />
        ) : (
          <PlaylistCover p={pl!} className="h-[220px] w-[220px] rounded-[36px] shadow-2xl" />
        )}
        <div className="min-w-0 flex-1">
          <div className="label-up">{t(kind === 'favorites' ? 'collection' : 'playlist')}</div>
          <h1 className="display my-2 break-words text-[clamp(34px,6.5cqw,72px)]">{name}</h1>
          <div className="font-medium text-on-surface-variant">
            {tracksLabel(ids.length)}
            {total > 0 && ` · ${durLabel(total)}`}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 @2xl:justify-start">
            <Button
              size="lg"
              icon={playingHere ? 'pause' : 'play_arrow'}
              disabled={!ids.length}
              onClick={() => (playingHere ? toggle() : playQueue(ids, 0, false))}
            >
              {playingHere ? t('pause') : t('play')}
            </Button>
            <Button size="lg" variant="tonal" icon="shuffle" disabled={!ids.length} onClick={() => shufflePlay(ids)}>
              {t('shuffle')}
            </Button>
            {kind === 'playlist' && !isProviderPlaylist && (
              <>
                <IconButton icon="edit" label={t('rename')} size="lg" onClick={() => openDialog({ kind: 'rename', id: pl!.id })} />
                <IconButton icon="delete" label={t('delete')} size="lg" onClick={() => openDialog({ kind: 'delete', id: pl!.id })} />
              </>
            )}
          </div>
        </div>
      </header>
      {loading ? (
        <div className="grid min-h-48 place-items-center">
          <Loader />
        </div>
      ) : providerError ? (
        <EmptyState
          icon="wifi_off"
          title={t('loadError')}
          text={providerError}
          action={
            <Button icon="refresh" onClick={() => void retryRemote()}>
              {t('retry')}
            </Button>
          }
        />
      ) : ids.length ? (
        <TrackList ids={ids} playlistId={kind === 'playlist' && !isProviderPlaylist ? pl!.id : undefined} />
      ) : (
        <EmptyState
          icon={kind === 'favorites' ? 'favorite' : 'queue_music'}
          title={t('favoritesEmpty')}
          text={kind === 'favorites' ? t('favoritesEmptyText') : t('playlistEmptyText')}
          action={
            <Button icon="search" onClick={() => openSearch('')}>
              {t('findMusic')}
            </Button>
          }
        />
      )}
    </div>
  );
}
