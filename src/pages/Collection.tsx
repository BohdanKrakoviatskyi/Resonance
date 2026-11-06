import { useEffect, useMemo, useState } from 'react';
import { Button, EmptyState, IconButton, Loader } from '../components/ui';
import { FavCover, PlaylistCover } from '../components/Cover';
import { TrackList } from '../components/TrackList';
import { useStore } from '../lib/util';
import { durLabel, t, tracksLabel } from '../lib/i18n';
import {
  getTrack, library, loadSoundCloudPlaylistTracks, loadYtMusicLibrary, loadYtMusicPlaylistArtwork, loadYtMusicPlaylistTracks,
  reloadSoundCloudPlaylistTracks, reloadYtMusicPlaylistTracks,
} from '../state/library';
import { player, playQueue, shufflePlay, toggle } from '../state/player';
import { go, openDialog } from '../state/ui';
import { parseSoundCloudCollectionId } from '../lib/soundcloud-library';
import { parseYtMusicCollectionId } from '../lib/ytmusic-library';

export default function Collection({ kind, id }: { kind: 'favorites' | 'playlist'; id?: string }) {
  const liked = useStore(library, (s) => s.liked);
  const soundcloudLiked = useStore(library, (s) => s.soundcloudLiked);
  const localPlaylist = useStore(library, (s) => (kind === 'playlist' ? s.playlists.find((p) => p.id === id) : undefined));
  const scCollection = kind === 'playlist' ? parseSoundCloudCollectionId(id) : null;
  const remoteId = scCollection?.kind === 'playlist' ? scCollection.playlistId : undefined;
  const remotePlaylist = useStore(library, (s) => remoteId ? s.soundcloudPlaylists.find((p) => p.id === remoteId) : undefined);
  const cachedRemoteTracks = useStore(library, (s) => remotePlaylist ? s.soundcloudPlaylistTracks[remotePlaylist.urn] ?? null : null);
  const ytCollection = kind === 'playlist' ? parseYtMusicCollectionId(id) : null;
  const ytPlaylistId = ytCollection?.kind === 'playlist' ? ytCollection.playlistId : undefined;
  const ytPlaylist = useStore(library, (s) => ytPlaylistId ? s.ytmusicPlaylists.find((p) => p.playlistId === ytPlaylistId) : undefined);
  const cachedYtTracks = useStore(library, (s) => ytPlaylistId ? s.ytmusicPlaylistTracks[ytPlaylistId] ?? null : null);
  const ytmusicLiked = useStore(library, (s) => s.ytmusicLiked);
  const ytmusicArtCache = useStore(library, (s) => s.ytmusicPlaylistArt);
  const ytmusicLibraryLoading = useStore(library, (s) => s.ytmusicLibraryLoading);
  const ytmusicLibraryError = useStore(library, (s) => s.ytmusicLibraryError);
  const cache = useStore(library, (s) => s.cache);
  const soundcloudLibraryLoading = useStore(library, (s) => s.soundcloudLibraryLoading);
  const soundcloudLibraryError = useStore(library, (s) => s.soundcloudLibraryError);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [ytLoading, setYtLoading] = useState(false);
  const [ytError, setYtError] = useState('');

  const ytCollectionTracks = ytCollection?.kind === 'liked' ? ytmusicLiked : cachedYtTracks ?? [];
  const ytCollectionName = ytCollection?.kind === 'liked' ? t('ytmusicLiked') : ytPlaylist?.title;
  const ytArt = ytPlaylistId ? ytmusicArtCache[ytPlaylistId] ?? ytPlaylist?.artworkUrl ?? undefined : undefined;
  useEffect(() => {
    if (ytPlaylistId && !(ytPlaylistId in ytmusicArtCache)) void loadYtMusicPlaylistArtwork(ytPlaylistId);
  }, [ytPlaylistId, ytmusicArtCache]);
  const ytPl = ytCollection && (ytCollection.kind !== 'playlist' || ytPlaylist) ? {
    id: id!,
    name: ytCollectionName ?? t('notFound'),
    ids: ytCollectionTracks.map((track) => track.id),
    created: 0,
    artworkUrl: ytArt,
  } : undefined;
  const scPl = scCollection?.kind === 'liked' ? {
    id: id!,
    name: t('soundcloudLiked'),
    ids: soundcloudLiked.map((track) => track.id),
    created: 0,
  } : remotePlaylist ? {
    id: `scpl:${remotePlaylist.id}`, name: remotePlaylist.name,
    ids: cachedRemoteTracks?.map((track) => track.id) ?? [], created: 0, artworkUrl: remotePlaylist.artworkUrl,
  } : undefined;

  const pl = localPlaylist ?? scPl ?? ytPl;
  const isProviderPlaylist = Boolean(scCollection) || Boolean(ytCollection);

  useEffect(() => {
    if (!remotePlaylist || cachedRemoteTracks) {
      setRemoteLoading(false);
      return;
    }
    let alive = true;
    setRemoteLoading(true);
    setRemoteError('');
    void loadSoundCloudPlaylistTracks(remotePlaylist.urn)
      .catch((error: unknown) => alive && setRemoteError(error instanceof Error ? error.message : String(error)))
      .finally(() => alive && setRemoteLoading(false));
    return () => { alive = false; };
  }, [remotePlaylist?.urn, cachedRemoteTracks]);

  useEffect(() => {
    if (!ytPlaylistId || cachedYtTracks) {
      setYtLoading(false);
      return;
    }
    let alive = true;
    setYtLoading(true);
    setYtError('');
    void loadYtMusicPlaylistTracks(ytPlaylistId)
      .catch((error: unknown) => alive && setYtError(error instanceof Error ? error.message : String(error)))
      .finally(() => alive && setYtLoading(false));
    return () => { alive = false; };
  }, [ytPlaylistId, cachedYtTracks]);

  const ids = useMemo(() => {
    const sourceIds = kind === 'favorites' ? liked : pl?.ids ?? [];
    return sourceIds.filter((trackId) => !!getTrack(trackId));
  }, [kind, liked, pl, cache]);
  const playingHere = useStore(player, (s) => s.playing && ids.includes(s.queue[s.index]));

  const virtualCollection = ytCollection?.kind === 'liked';
  const loading = remoteLoading || ytLoading
    || Boolean(ytPlaylistId && !cachedYtTracks && !ytError)
    || Boolean(virtualCollection && ytmusicLibraryLoading && !ids.length);
  const providerError = remoteError || ytError
    || (virtualCollection && !ids.length ? ytmusicLibraryError : '');

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
    return <div className="page grid min-h-48 place-items-center"><Loader /></div>;
  }
  if (kind === 'playlist' && !pl && remoteId && soundcloudLibraryError) {
    return <div className="page"><EmptyState icon="wifi_off" title={t('loadError')} text={soundcloudLibraryError} action={<Button icon="home" onClick={() => go({ name: 'home' })}>{t('home')}</Button>} /></div>;
  }
  if (kind === 'playlist' && !pl && ytCollection && ytmusicLibraryLoading) {
    return <div className="page grid min-h-48 place-items-center"><Loader /></div>;
  }
  if (kind === 'playlist' && !pl && ytCollection && ytmusicLibraryError) {
    return <div className="page"><EmptyState icon="wifi_off" title={t('loadError')} text={ytmusicLibraryError} action={<Button icon="home" onClick={() => go({ name: 'home' })}>{t('home')}</Button>} /></div>;
  }

  if (kind === 'playlist' && !pl)
    return (
      <div className="page">
        <EmptyState icon="queue_music" title={t('notFound')} action={<Button icon="home" onClick={() => go({ name: 'home' })}>{t('home')}</Button>} />
      </div>
    );

  const total = ids.reduce((a, x) => a + (getTrack(x)?.duration ?? 0), 0);
  const name = kind === 'favorites' ? t('favorites') : pl!.name;

  return (
    <div className="page">
      <header className="anim-in mb-8 mt-2 flex flex-col items-center gap-6 text-center @2xl:flex-row @2xl:items-end @2xl:text-left">
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
            <Button size="lg" icon={playingHere ? 'pause' : 'play_arrow'} disabled={!ids.length} onClick={() => (playingHere ? toggle() : playQueue(ids, 0, false))}>
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
        <div className="grid min-h-48 place-items-center"><Loader /></div>
      ) : providerError ? (
        <EmptyState icon="wifi_off" title={t('loadError')} text={providerError} action={<Button icon="refresh" onClick={() => void retryRemote()}>{t('retry')}</Button>} />
      ) : ids.length ? (
        <TrackList ids={ids} playlistId={kind === 'playlist' && !isProviderPlaylist ? pl!.id : undefined} />
      ) : (
        <EmptyState
          icon={kind === 'favorites' ? 'favorite' : 'queue_music'}
          title={t('favoritesEmpty')}
          text={kind === 'favorites' ? t('favoritesEmptyText') : t('playlistEmptyText')}
          action={
            <Button icon="search" onClick={() => go({ name: 'search', q: '' })}>
              {t('findMusic')}
            </Button>
          }
        />
      )}
    </div>
  );
}
