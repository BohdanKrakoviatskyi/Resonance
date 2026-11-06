import { memo, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Menu, MenuItem, type Vars } from './ui';
import { Cover, Eq, PlaylistCover } from './Cover';
import { cx, fmtTime, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { getTrack, library, toggleDislike, toggleLike, togglePlaylistTrack } from '../state/library';
import { addToQueue, player, playNext, playQueue, toggle } from '../state/player';
import { go, openDialog } from '../state/ui';
import type { Track } from '../types';
import soundcloudLogo from '../assets/soundcloud.svg';
import youtubeMusicLogo from '../assets/youtube-music.svg';

export function LikeButton({ id, size = 'md', variant, className }: { id: string; size?: 'sm' | 'md' | 'lg'; variant?: 'tonal'; className?: string }) {
  const liked = useStore(library, (s) => s.liked.includes(id));
  const [burst, setBurst] = useState(0);
  const label = t(liked ? 'unlike' : 'like');
  return (
    <span className={cx('like-wrap', className)} data-keep={liked}>
      <button
        type="button"
        data-ripple
        aria-pressed={liked}
        aria-label={label}
        data-tip={label}
        data-on={liked ? '' : undefined}
        className={cx('ib sl', size !== 'md' && `ib-${size}`, variant && `ib-${variant}`)}
        onClick={(e) => {
          e.stopPropagation();
          if (toggleLike(id)) setBurst((b) => b + 1);
        }}
      >
        <Icon key={liked ? 'on' : 'off'} name="favorite" fill={liked} className={liked ? 'pop text-primary' : ''} />
      </button>
      {burst > 0 && (
        <span key={burst} className="burst" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((k) => (
            <i key={k} style={{ '--k': k } as Vars} />
          ))}
        </span>
      )}
    </span>
  );
}

export function DislikeButton({ id, variant, size }: { id: string; variant?: 'tonal'; size?: 'lg' }) {
  const on = useStore(library, (s) => s.disliked.includes(id));
  return <IconButton icon="thumb_down" label={t(on ? 'undislike' : 'dislike')} variant={variant} size={size} selected={on} toggle={!variant} onClick={() => toggleDislike(id)} />;
}

export function PlaylistPicker({ id, onClose, onBack }: { id: string; onClose: () => void; onBack?: () => void }) {
  const playlists = useStore(library, (s) => s.playlists);
  return (
    <>
      <div className="menu-head">
        {onBack && <IconButton icon="arrow_back" label={t('back')} size="sm" tip={false} onClick={onBack} />}
        <span>{t('addToPlaylist')}</span>
      </div>
      {playlists.map((p, i) => (
        <MenuItem
          key={p.id}
          i={i}
          leading={<PlaylistCover p={p} className="h-9 w-9 rounded-[10px]" />}
          label={p.name}
          checked={p.ids.includes(id)}
          onClick={() => togglePlaylistTrack(p.id, id)}
        />
      ))}
      <div className="menu-div" />
      <MenuItem
        icon="add"
        i={playlists.length}
        label={t('newPlaylist')}
        onClick={() => {
          onClose();
          openDialog({ kind: 'create', trackId: id });
        }}
      />
    </>
  );
}

export function TrackMenu({ track, anchor, onClose, playlistId }: { track: Track; anchor: HTMLElement | null; onClose: () => void; playlistId?: string }) {
  const [sub, setSub] = useState(false);
  const close = () => {
    setSub(false);
    onClose();
  };
  return (
    <Menu anchor={anchor} open={!!anchor} onClose={close}>
      {sub ? (
        <PlaylistPicker id={track.id} onClose={close} onBack={() => setSub(false)} />
      ) : (
        <>
          <MenuItem i={0} icon="queue_play_next" label={t('playNext')} onClick={() => (playNext(track.id), close())} />
          <MenuItem i={1} icon="add_to_queue" label={t('addToQueue')} onClick={() => (addToQueue(track.id), close())} />
          <MenuItem i={2} icon="playlist_add" label={t('addToPlaylist')} trailing="chevron_right" onClick={() => setSub(true)} />
          {playlistId && <MenuItem i={3} icon="playlist_remove" label={t('removeFromPlaylist')} onClick={() => (togglePlaylistTrack(playlistId, track.id), close())} />}
          <div className="menu-div" />
          <MenuItem i={4} icon="person" label={t('goToArtist')} onClick={() => (go({ name: 'search', q: track.artist }), close())} />
          <MenuItem i={5} icon="thumb_down" label={t('dislike')} onClick={() => (toggleDislike(track.id), close())} />
        </>
      )}
    </Menu>
  );
}

export function SourcePill({ track }: { track: Track }) {
  const label = track.source === 'soundcloud' ? 'SoundCloud' : 'YouTube Music';
  const logo = track.source === 'soundcloud' ? soundcloudLogo : youtubeMusicLogo;
  return <img className="provider-logo" src={logo} alt={label} title={label} />;
}

type RowProps = { id: string; index: number; list: string[]; isCurrent: boolean; isPlaying: boolean; playlistId?: string };

export const TrackRow = memo(function TrackRow({ id, index, list, isCurrent, isPlaying, playlistId }: RowProps) {
  const disliked = useStore(library, (s) => s.disliked.includes(id));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tr = getTrack(id);
  if (!tr) return null;
  return (
    <div
      role="listitem"
      className="track-row sl anim-in"
      data-ripple
      data-current={isCurrent}
      data-disliked={disliked}
      style={{ '--i': index } as Vars}
      onClick={() => (isCurrent ? toggle() : playQueue(list, index))}
    >
      <div className="row-idx">
        {isCurrent ? <Eq on={isPlaying} /> : <span className="row-num">{index + 1}</span>}
        <Icon name={isCurrent && isPlaying ? 'pause' : 'play_arrow'} fill className="row-play" />
      </div>
      <Cover src={tr.thumb} className="h-11 w-11 rounded-[14px]" />
      <div className="min-w-0 flex-1">
        <div className={cx('truncate font-semibold', isCurrent && 'text-primary')}>{tr.title}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-sm text-on-surface-variant">
          <SourcePill track={tr} />
          <span className="truncate">{tr.artist}</span>
        </div>
      </div>
      <div className="row-album">{tr.album}</div>
      <LikeButton id={id} size="sm" className="row-hover" />
      <span className="row-dur">{fmtTime(tr.duration)}</span>
      <IconButton
        icon="more_vert"
        label={t('addToPlaylist')}
        size="sm"
        tip={false}
        className="row-hover"
        data-keep={!!anchor}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : e.currentTarget);
        }}
      />
      <TrackMenu track={tr} anchor={anchor} onClose={() => setAnchor(null)} playlistId={playlistId} />
    </div>
  );
});

export function TrackList({ ids, playlistId }: { ids: string[]; playlistId?: string }) {
  const cur = useStore(player, (s) => s.queue[s.index] ?? null);
  const playing = useStore(player, (s) => s.playing);
  return (
    <div role="list" className="flex flex-col gap-0.5">
      {ids.map((id, i) => (
        <TrackRow key={id} id={id} index={i} list={ids} isCurrent={id === cur} isPlaying={id === cur && playing} playlistId={playlistId} />
      ))}
    </div>
  );
}

export function SkeletonRows({ n = 5 }: { n?: number }) {
  return (
    <div className="flex flex-col gap-1" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex h-[62px] items-center gap-3 px-2" style={{ opacity: 1 - i * 0.15 }}>
          <div className="skel h-11 w-11 rounded-[14px]" />
          <div className="flex-1">
            <div className="skel mb-2 h-3.5 w-2/5 rounded-full" />
            <div className="skel h-3 w-1/4 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function MediaCard({ track, list, index }: { track: Track; list: string[]; index: number }) {
  const isCur = useStore(player, (s) => s.queue[s.index] === track.id);
  const playing = useStore(player, (s) => s.playing);
  return (
    <button
      type="button"
      data-ripple
      className="mcard sl anim-in"
      data-current={isCur}
      style={{ '--i': index } as Vars}
      onClick={() => (isCur ? toggle() : playQueue(list, index))}
    >
      <div className="relative">
        <Cover src={track.cover} className="mcard-cover" />
        <span className="mcard-fab">
          <Icon name={isCur && playing ? 'pause' : 'play_arrow'} fill size={26} />
        </span>
      </div>
      <span className="mcard-title">{track.title}</span>
      <span className="mcard-sub">{track.artist}</span>
    </button>
  );
}
