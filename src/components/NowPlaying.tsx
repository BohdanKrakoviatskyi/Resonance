import { Fragment, useState } from 'react';
import { IconButton, Menu, Segmented, EmptyState, type Vars } from './ui';
import { ArtCover, Cover, Eq } from './Cover';
import { Lyrics } from './Lyrics';
import { ProviderEmbed } from './ProviderEmbed';
import { DislikeButton, LikeButton, PlaylistPicker, SourcePill } from './TrackList';
import { useVtSource } from './MiniPlayer';
import { cx, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { getTrack, library } from '../state/library';
import { jumpTo, player, useCurrentTrack } from '../state/player';
import { openSearch, setImmersive, ui } from '../state/ui';

function QueueList() {
  const queue = useStore(player, (s) => s.queue);
  const index = useStore(player, (s) => s.index);
  const playing = useStore(player, (s) => s.playing);
  const items = queue.slice(Math.max(0, index), index + 60);
  if (items.length <= 1) return <div className="lyrics-state">{t('queueEmpty')}</div>;
  return (
    <div className="np-queue">
      {items.map((id, k) => {
        const tr = getTrack(id);
        if (!tr) return null;
        const cur = k === 0;
        return (
          <button
            key={id + k}
            type="button"
            data-ripple
            className={cx('track-row sl anim-in w-full !h-14 text-left', cur && 'pointer-events-none')}
            data-current={cur}
            style={{ '--i': k } as Vars}
            onClick={() => jumpTo(index + k)}
          >
            <Cover src={tr.thumb} className="ml-1 h-10 w-10 rounded-xl" />
            <span className="min-w-0 flex-1">
              <span className={cx('block truncate text-sm font-semibold', cur && 'text-primary')}>{tr.title}</span>
              <span className="block truncate text-xs text-on-surface-variant">{tr.artist}</span>
            </span>
            {cur && <Eq on={playing} className="mr-2" />}
          </button>
        );
      })}
    </div>
  );
}

export function NowPlaying({ mode }: { mode: 'inline' | 'drawer' }) {
  const open = useStore(ui, (s) => mode === 'drawer' || s.panel);
  const tab = useStore(ui, (s) => s.tab);
  const track = useCurrentTrack();
  const vt = useVtSource();
  const inPlaylist = useStore(library, (s) => !!track && s.playlists.some((p) => p.ids.includes(track.id)));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <aside className="panel panel-side np" data-open={open} data-mode={mode} aria-label={t('nowPlaying')} aria-hidden={!open}>
      <div className="np-inner">
        {track ? (
          <Fragment key={track.id}>
            <ArtCover
              src={track.cover}
              vt={mode === 'inline' && vt === 'panel' ? 'np-cover' : undefined}
              className="np-cover"
              onClick={() => setImmersive(true)}
              label={t('fullscreenLyrics')}
            />
            <div className="meta-in">
              <h2 className="np-title headline">{track.title}</h2>
              <div className="flex items-center gap-2">
                <SourcePill track={track} />
                <button type="button" className="np-artist truncate" onClick={() => openSearch(track.artist)}>
                  {track.artist}
                </button>
              </div>
            </div>
            <ProviderEmbed key={track.id} track={track} />
            <div className="mt-4 flex items-center gap-2">
              <LikeButton id={track.id} variant="tonal" />
              <DislikeButton id={track.id} variant="tonal" />
              <IconButton
                icon={inPlaylist ? 'playlist_add_check' : 'playlist_add'}
                label={t('addToPlaylist')}
                variant="tonal"
                selected={!!anchor}
                onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
              />
            </div>
            <Segmented
              size="sm"
              className="mt-4"
              value={tab}
              onChange={(v) => ui.set({ tab: v })}
              options={[
                { value: 'lyrics', label: t('lyrics'), icon: 'lyrics' },
                { value: 'queue', label: t('upNext'), icon: 'queue_music' },
              ]}
            />
            <div className="np-body">{tab === 'lyrics' ? <Lyrics track={track} variant="panel" /> : <QueueList />}</div>
            <Menu anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
              <PlaylistPicker id={track.id} onClose={() => setAnchor(null)} />
            </Menu>
          </Fragment>
        ) : (
          <div className="flex flex-1 items-center">
            <EmptyState icon="music_note" title={t('nothingPlaying')} text={t('pickSomething')} />
          </div>
        )}
      </div>
    </aside>
  );
}
