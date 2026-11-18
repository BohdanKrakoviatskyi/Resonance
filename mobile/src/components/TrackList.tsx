import { memo, useState } from 'react';
import { Icon } from './Icon';
import { IconButton } from './ui';
import { Cover } from './Cover';
import { cx, fmtTime, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { isLiked, library, toggleLike } from '../state/library';
import { playTrack, player } from '../state/player';
import { openTrackMenu } from '../state/ui';
import type { Track } from '../types';
import soundcloudLogo from '../assets/soundcloud.svg';
import youtubeMusicLogo from '../assets/youtube-music.svg';

export function SourcePill({ track }: { track: Track }) {
  const isSc = track.source === 'soundcloud';
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-container-highest/90 p-0.5"
      title={isSc ? 'SoundCloud' : 'YouTube Music'}
    >
      <img src={isSc ? soundcloudLogo : youtubeMusicLogo} alt="" className="h-3 w-3 object-contain" />
    </span>
  );
}

export function LikeButton({ id, size = 'md', className }: { id: string; size?: 'sm' | 'md'; className?: string }) {
  const liked = useStore(library, () => isLiked(id));
  return (
    <IconButton
      icon="favorite"
      label={t('like')}
      size={size}
      fill={liked}
      selected={liked}
      tip={false}
      className={cx(liked && 'text-primary', className)}
      onClick={(e) => {
        e.stopPropagation();
        toggleLike(id);
      }}
    />
  );
}

export const MobileTrackRow = memo(function MobileTrackRow({
  track,
  active,
  playing,
  onSelect,
  trailingAction,
}: {
  track: Track;
  active: boolean;
  playing: boolean;
  onSelect: () => void;
  trailingAction?: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}
      className={cx(
        'sl flex items-center gap-3 rounded-2xl px-2.5 py-2 transition-colors active:scale-[0.99]',
        active ? 'bg-primary-container/55 text-on-primary-container' : 'hover:bg-surface-container-low',
      )}
    >
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl">
        <Cover src={track.thumb || track.cover} className="h-12 w-12 rounded-xl" />
        {active && (
          <div className="absolute inset-0 grid place-items-center bg-black/45 text-white">
            <Icon name={playing ? 'graphic_eq' : 'pause'} size={20} />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-[15px] font-semibold leading-snug', active && 'text-primary')}>
          {track.title}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] text-on-surface-variant">
          <SourcePill track={track} />
          <span className="truncate">{track.artist}</span>
          {track.duration > 0 && (
            <>
              <span className="opacity-50">·</span>
              <span className="shrink-0 tabular-nums">{fmtTime(track.duration)}</span>
            </>
          )}
        </div>
      </div>

      <LikeButton id={track.id} size="sm" />
      <IconButton
        icon="more_vert"
        label={t('menu')}
        size="sm"
        tip={false}
        onClick={(e) => {
          e.stopPropagation();
          if (trailingAction) trailingAction();
          else openTrackMenu(track.id);
        }}
      />
    </div>
  );
});

export function MobileTrackList({
  tracks,
  emptyText,
}: {
  tracks: Track[];
  emptyText?: string;
}) {
  const [limit, setLimit] = useState(60);
  const activeId = useStore(player, (s) => (s.index >= 0 ? s.queue[s.index] : undefined));
  const isPlaying = useStore(player, (s) => s.playing);

  if (tracks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center text-on-surface-variant">
        <Icon name="music_note" size={40} className="mb-2 opacity-45" />
        <p className="text-sm">{emptyText ?? t('noResults')}</p>
      </div>
    );
  }

  const visible = tracks.slice(0, limit);
  return (
    <div className="flex flex-col gap-1">
      {visible.map((tr) => (
        <MobileTrackRow
          key={tr.id}
          track={tr}
          active={activeId === tr.id}
          playing={activeId === tr.id && isPlaying}
          onSelect={() => void playTrack(tr, tracks)}
        />
      ))}
      {tracks.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + 80)}
          className="sl mx-auto mt-3 rounded-full bg-surface-container-high px-5 py-2.5 text-sm font-semibold text-primary"
        >
          Показать ещё ({tracks.length - limit})
        </button>
      )}
    </div>
  );
}
