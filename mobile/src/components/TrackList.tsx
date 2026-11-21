import { memo, useLayoutEffect, useRef, useState } from 'react';
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

const ROW_STRIDE_PX = 68;
const VIRTUALIZE_THRESHOLD = 40;
const OVERSCAN_ROWS = 8;

function computeWindow(loaded: number, viewTop: number, viewBottom: number) {
  if (loaded <= VIRTUALIZE_THRESHOLD) return { start: 0, end: loaded };
  const start = Math.max(0, Math.floor(Math.max(0, viewTop) / ROW_STRIDE_PX) - OVERSCAN_ROWS);
  const end = Math.min(loaded, Math.ceil(Math.max(0, viewBottom) / ROW_STRIDE_PX) + OVERSCAN_ROWS);
  return { start, end: Math.max(start, end) };
}

/** Keeps only the rows inside the page scroller's viewport mounted. The list lives in the shared
 *  App scroller, so the scroll host is discovered from the DOM instead of being a prop. */
function useVisibleRows(loaded: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: loaded });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let scroller: HTMLElement | null = null;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        scroller = node;
        break;
      }
    }
    const measure = () => {
      const viewportHeight = scroller ? scroller.clientHeight : window.innerHeight;
      const viewTop = -el.getBoundingClientRect().top;
      const next = computeWindow(loaded, viewTop, viewTop + viewportHeight);
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    measure();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      target.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [loaded]);

  return { listRef, range };
}

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
  const visible = tracks.slice(0, limit);
  const { listRef, range } = useVisibleRows(visible.length);

  if (tracks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center text-on-surface-variant">
        <Icon name="music_note" size={40} className="mb-2 opacity-45" />
        <p className="text-sm">{emptyText ?? t('noResults')}</p>
      </div>
    );
  }

  const virtualized = visible.length > VIRTUALIZE_THRESHOLD;
  const rows = virtualized ? visible.slice(range.start, range.end) : visible;
  return (
    <div
      ref={listRef}
      className="flex flex-col gap-1"
      style={virtualized ? { paddingTop: range.start * ROW_STRIDE_PX, paddingBottom: (visible.length - range.end) * ROW_STRIDE_PX } : undefined}
    >
      {rows.map((tr) => (
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
