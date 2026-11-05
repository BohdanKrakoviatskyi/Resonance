import { useEffect } from 'react';
import { useStore } from '../lib/util';
import { Icon } from '../components/Icon';
import { Chip, HRow, Section, type Vars } from '../components/ui';
import { PlaylistCover } from '../components/Cover';
import { MediaCard } from '../components/TrackList';

import { pick, t, tracksLabel } from '../lib/i18n';
import { MOODS } from '../lib/moods';
import { getTrack, library, loadYtMusicPlaylistArtwork } from '../state/library';
import { SOUNDCLOUD_LIKED_ID, soundcloudPlaylistId } from '../lib/soundcloud-library';
import { YTMUSIC_LIKED_ID, ytmusicPlaylistId } from '../lib/ytmusic-library';

function YtMusicCoverCard({ playlistId, title, trackCount, artworkUrl, index }: { playlistId: string; title: string; trackCount: number; artworkUrl?: string | null; index: number }) {
  const artCache = useStore(library, (s) => s.ytmusicPlaylistArt);
  const art = playlistId in artCache ? artCache[playlistId] : undefined;
  useEffect(() => {
    if (!(playlistId in artCache)) void loadYtMusicPlaylistArtwork(playlistId);
  }, [playlistId, artCache]);
  return (
    <button
      type="button"
      data-ripple
      className="mcard sl anim-in"
      style={{ '--i': index } as Vars}
      onClick={() => go({ name: 'playlist', id: ytmusicPlaylistId(playlistId) })}
    >
      <PlaylistCover p={{ id: playlistId, name: title, ids: [], created: 0, artworkUrl: art ?? artworkUrl ?? undefined }} className="mcard-cover" />
      <span className="mcard-title">{title}</span>
      <span className="mcard-sub">{tracksLabel(trackCount)}</span>
    </button>
  );
}

import { go } from '../state/ui';
import type { Track } from '../types';

export default function Home() {
  const recent = useStore(library, (s) => s.recent);
  const soundcloudLiked = useStore(library, (s) => s.soundcloudLiked);
  const soundcloudPlaylists = useStore(library, (s) => s.soundcloudPlaylists);
  const soundcloudLibraryLoading = useStore(library, (s) => s.soundcloudLibraryLoading);
  const soundcloudLibraryError = useStore(library, (s) => s.soundcloudLibraryError);
  const ytmusicPlaylists = useStore(library, (s) => s.ytmusicPlaylists);
  const ytmusicLiked = useStore(library, (s) => s.ytmusicLiked);
  const ytmusicConnected = useStore(library, (s) => s.ytmusicAuthorized);

  const h = new Date().getHours();
  const greet = h < 5 ? 'goodNight' : h < 12 ? 'goodMorning' : h < 18 ? 'goodAfternoon' : 'goodEvening';
  const recentTracks = recent.map((id) => getTrack(id)).filter((x): x is Track => !!x);
  const recentIds = recentTracks.map((x) => x.id);
  const hasSoundCloudLibrary = soundcloudLiked.length > 0 || soundcloudPlaylists.length > 0 || soundcloudLibraryLoading || !!soundcloudLibraryError;
  const arrows: [string, string] = [t('previous'), t('next')];

  return (
    <div className="page">
      <header className="anim-in mb-6 mt-2">
        <h1 className="display text-[clamp(34px,6cqw,60px)]">{t(greet)}</h1>
        <p className="mt-2 text-lg text-on-surface-variant">{t('homeSubtitle')}</p>
      </header>

      {hasSoundCloudLibrary && (
        <Section
          title={t('soundcloudLibrary')}
          subtitle={t('soundcloudLibrarySub')}
          i={2}
        >
          <HRow labels={arrows} cw={180}>
            <button
              type="button"
              data-ripple
              className="mcard sl anim-in"
              onClick={() => go({ name: 'playlist', id: SOUNDCLOUD_LIKED_ID })}
            >
              <PlaylistCover p={{ id: SOUNDCLOUD_LIKED_ID, name: t('soundcloudLiked'), ids: [], created: 0 }} className="mcard-cover" />
              <span className="mcard-title">{t('soundcloudLiked')}</span>
              <span className="mcard-sub">{tracksLabel(soundcloudLiked.length)}</span>
            </button>
            {soundcloudPlaylists.map((p, i) => (
              <button
                key={`sclib:${p.id}`}
                type="button"
                data-ripple
                className="mcard sl anim-in"
                style={{ '--i': i + 1 } as Vars}
                onClick={() => go({ name: 'playlist', id: soundcloudPlaylistId(p.id) })}
              >
                <PlaylistCover p={{ id: p.id, name: p.name, ids: [], created: 0, artworkUrl: p.artworkUrl }} className="mcard-cover" />
                <span className="mcard-title">{p.name}</span>
                <span className="mcard-sub">{tracksLabel(p.trackCount)}</span>
              </button>
            ))}
          </HRow>
        </Section>
      )}

      {ytmusicConnected && (
        <Section
          title={t('ytmusicLibrary')}
          subtitle={t('ytmusicLibrarySub')}
          i={3}
        >
          <HRow labels={arrows} cw={180}>
            <button
              type="button"
              data-ripple
              className="mcard sl anim-in"
              onClick={() => go({ name: 'playlist', id: YTMUSIC_LIKED_ID })}
            >
              <PlaylistCover p={{ id: YTMUSIC_LIKED_ID, name: t('ytmusicLiked'), ids: [], created: 0 }} className="mcard-cover" />
              <span className="mcard-title">{t('ytmusicLiked')}</span>
              <span className="mcard-sub">{tracksLabel(ytmusicLiked.length)}</span>
            </button>
            {ytmusicPlaylists.map((p, i) => (
              <YtMusicCoverCard key={`ytmusic-pl:${p.playlistId}`} playlistId={p.playlistId} title={p.title} trackCount={p.trackCount} artworkUrl={p.artworkUrl} index={i + 1} />
            ))}
          </HRow>
        </Section>
      )}

      {recentTracks.length > 0 && (
        <Section title={t('recent')} i={4} action={<Icon name="history" className="text-on-surface-variant" size={26} />}>
          <HRow labels={arrows}>
            {recentTracks.map((tr, i) => (
              <MediaCard key={tr.id} track={tr} list={recentIds} index={i} />
            ))}
          </HRow>
        </Section>
      )}

      <Section title={t('moods')} i={5}>
        <div className="flex flex-wrap gap-2">
          {MOODS.map((m) => (
            <Chip key={m.q} icon={m.icon} label={pick(m.ru, m.en)} onClick={() => go({ name: 'search', q: m.q })} />
          ))}
        </div>
      </Section>
    </div>
  );
}
