import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Menu, MenuItem, type Vars } from './ui';
import { Cover, Eq, PlaylistCover } from './Cover';
import { cx, fmtTime, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import {
  computeTrackWindow,
  nextLoadedCount,
  TRACK_LIST_PAGE_SIZE,
  TRACK_VIRTUALIZE_THRESHOLD,
} from '../lib/track-window';
import { getTrack, isDisliked, isLiked, library, toggleDislike, toggleLike, togglePlaylistTrack } from '../state/library';
import { addToQueue, player, playNext, playQueue, prefetchTrackByIdLowPriority, toggle } from '../state/player';
import { canDownload, downloadTracks, removeDownload, useIsDownloaded, useIsQueued } from '../state/offline';
import { openDialog, openSearch } from '../state/ui';
import type { Track } from '../types';
import soundcloudLogo from '../assets/soundcloud.svg';
import youtubeMusicLogo from '../assets/youtube-music.svg';

export function LikeButton({ id, size = 'md', variant, className }: { id: string; size?: 'sm' | 'md' | 'lg'; variant?: 'tonal'; className?: string }) {
  const liked = useStore(library, () => isLiked(id));
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
        <Icon key={liked ? 'on' : 'off'} name="favorite" fill={liked} className={cx(liked && 'text-primary', burst > 0 && liked && 'pop')} />
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
  const on = useStore(library, () => isDisliked(id));
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
          {canDownload(track) && <DownloadMenuItem track={track} onDone={close} />}
          <div className="menu-div" />
          <MenuItem i={4} icon="person" label={t('goToArtist')} onClick={() => (openSearch(track.artist), close())} />
          <MenuItem i={5} icon="thumb_down" label={t('dislike')} onClick={() => (toggleDislike(track.id), close())} />
        </>
      )}
    </Menu>
  );
}

function DownloadMenuItem({ track, onDone }: { track: Track; onDone: () => void }) {
  const downloaded = useIsDownloaded(track);
  const queued = useIsQueued(track);
  if (queued) return <MenuItem i={3} icon="download" label={t('offlineDownloading')} />;
  return downloaded ? (
    <MenuItem i={3} icon="delete" label={t('offlineRemove')} onClick={() => (void removeDownload(track), onDone())} />
  ) : (
    <MenuItem i={3} icon="download" label={t('offlineDownload')} onClick={() => (downloadTracks([track]), onDone())} />
  );
}

export function SourcePill({ track }: { track: Track }) {
  if (track.source === 'local') {
    return (
      <span className="provider-logo grid place-items-center text-on-surface-variant" title={t('localFiles')} aria-label={t('localFiles')}>
        <Icon name="folder" fill size={16} />
      </span>
    );
  }
  const label = track.source === 'soundcloud' ? 'SoundCloud' : 'YouTube Music';
  const logo = track.source === 'soundcloud' ? soundcloudLogo : youtubeMusicLogo;
  return <img className="provider-logo" src={logo} alt={label} title={label} />;
}

type RowProps = {
  id: string;
  index: number;
  isCurrent: boolean;
  isPlaying: boolean;
  animateRow?: boolean;
  playlistId?: string;
  onPlayIndex: (index: number) => void;
};

export const TrackRow = memo(function TrackRow({ id, index, isCurrent, isPlaying, animateRow = true, playlistId, onPlayIndex }: RowProps) {
  const disliked = useStore(library, () => isDisliked(id));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, []);

  const tr = getTrack(id);
  if (!tr) return null;
  const play = () => {
    if (isCurrent) {
      const st = player.get();
      if (st.state === 'error' || st.state === 'loading' || st.loading) onPlayIndex(index);
      else toggle();
    } else {
      onPlayIndex(index);
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx('track-row sl', animateRow && 'anim-in')}
      data-ripple
      data-current={isCurrent}
      data-disliked={disliked}
      style={{ '--i': index } as Vars}
      onMouseEnter={() => {
        if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
          hoverTimerRef.current = null;
          prefetchTrackByIdLowPriority(id);
        }, 120);
      }}
      onMouseLeave={() => {
        // При уходе курсора отменяем только таймер дебаунса, не убивая уже запущенный процесс
        if (hoverTimerRef.current !== null) {
          clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
      }}
      onClick={(e) => {
        if (hoverTimerRef.current !== null) {
          clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
        e.preventDefault();
        e.stopPropagation();
        play();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          play();
        }
      }}
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

export function TrackList({
  ids,
  playlistId,
  animateRows = true,
  paginated = false,
  resetKey,
  radioOnPlay = false,
}: {
  ids: string[];
  playlistId?: string;
  animateRows?: boolean;
  paginated?: boolean;
  resetKey?: string;
  radioOnPlay?: boolean;
}) {
  const cur = useStore(player, (s) => s.queue[s.index] ?? null);
  const playing = useStore(player, (s) => s.playing);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const radioOnPlayRef = useRef(radioOnPlay);
  radioOnPlayRef.current = radioOnPlay;

  const [loadedCount, setLoadedCount] = useState(() =>
    paginated ? Math.min(ids.length, TRACK_LIST_PAGE_SIZE) : ids.length,
  );
  const [viewportBounds, setViewportBounds] = useState<{ top: number; bottom: number }>({
    top: 0,
    bottom: 900,
  });

  const identityKey = resetKey ?? `${playlistId ?? 'list'}`;
  const prevIdentityRef = useRef(identityKey);

  useEffect(() => {
    if (!paginated) {
      setLoadedCount(ids.length);
      return;
    }
    if (prevIdentityRef.current !== identityKey) {
      prevIdentityRef.current = identityKey;
      setLoadedCount(Math.min(ids.length, TRACK_LIST_PAGE_SIZE));
      return;
    }
    setLoadedCount((prev) => nextLoadedCount(prev, ids.length, TRACK_LIST_PAGE_SIZE, false));
  }, [identityKey, ids.length, paginated]);

  const effectiveCount = paginated ? Math.min(loadedCount, ids.length) : ids.length;
  const shouldVirtualize = effectiveCount > TRACK_VIRTUALIZE_THRESHOLD;

  const loadNextBatch = useCallback(() => {
    if (!paginated) return;
    setLoadedCount((prev) => nextLoadedCount(prev, idsRef.current.length, TRACK_LIST_PAGE_SIZE, true));
  }, [paginated]);

  // Progressive 20-by-20 loading as the user scrolls near the bottom of the loaded slice
  useEffect(() => {
    if (!paginated || effectiveCount >= ids.length) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const scroller = sentinel.closest('.center-scroll') as HTMLElement | null;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadNextBatch();
        }
      },
      {
        root: scroller,
        rootMargin: '0px 0px 280px 0px',
        threshold: 0.01,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [paginated, effectiveCount, ids.length, loadNextBatch]);

  // Trigger another 20-track page when scrolling near the bottom (covers short viewports and rapid scrolls)
  useEffect(() => {
    if (!paginated || effectiveCount >= ids.length) return;
    const listEl = listRef.current;
    const scroller = listEl?.closest('.center-scroll') as HTMLElement | null;
    if (!scroller || !listEl) return;

    const checkNeedMore = () => {
      const sRect = scroller.getBoundingClientRect();
      const lRect = listEl.getBoundingClientRect();
      if (lRect.bottom - sRect.bottom < 260) {
        loadNextBatch();
      }
    };

    const raf = requestAnimationFrame(checkNeedMore);
    scroller.addEventListener('scroll', checkNeedMore, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      scroller.removeEventListener('scroll', checkNeedMore);
    };
  }, [paginated, effectiveCount, ids.length, loadNextBatch]);

  // Windowed rendering once >40 tracks are loaded so 500+ tracks keep ~30 DOM nodes and zero scroll jank
  useLayoutEffect(() => {
    if (!shouldVirtualize) return;

    const listEl = listRef.current;
    if (!listEl) return;
    const scroller = (listEl.closest('.center-scroll') as HTMLElement | null) ?? null;
    let rafId = 0;

    const computeBounds = () => {
      rafId = 0;
      if (!listEl) return;
      const sRect = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const lRect = listEl.getBoundingClientRect();
      const nextTop = Math.max(0, sRect.top - lRect.top);
      const nextBottom = Math.max(0, sRect.bottom - lRect.top);

      setViewportBounds((prev) =>
        Math.abs(prev.top - nextTop) < 32 && Math.abs(prev.bottom - nextBottom) < 32
          ? prev
          : { top: nextTop, bottom: nextBottom },
      );
    };

    const schedule = () => {
      if (!rafId) rafId = requestAnimationFrame(computeBounds);
    };

    computeBounds();
    const target: EventTarget = scroller ?? window;
    target.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    let resizeObs: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(schedule);
      if (scroller) resizeObs.observe(scroller);
      resizeObs.observe(listEl);
    }
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      target.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      resizeObs?.disconnect();
    };
  }, [shouldVirtualize, effectiveCount]);

  const onPlayIndex = useRef((idx: number) => {
    if (radioOnPlayRef.current) {
      const id = idsRef.current[idx];
      if (id) playQueue([id], 0, true);
    } else {
      playQueue(idsRef.current, idx);
    }
  }).current;

  const { start, end, topPad, bottomPad } = useMemo(
    () =>
      computeTrackWindow({
        loadedCount: effectiveCount,
        viewTop: viewportBounds.top,
        viewBottom: viewportBounds.bottom,
      }),
    [effectiveCount, viewportBounds.top, viewportBounds.bottom],
  );

  const slice = ids.slice(start, end);

  return (
    <div>
      <div
        ref={listRef}
        className={cx('flex flex-col gap-0.5', !animateRows && 'track-list-no-anim')}
        style={
          shouldVirtualize
            ? {
                paddingTop: topPad,
                paddingBottom: bottomPad,
              }
            : undefined
        }
      >
        {slice.map((id, offset) => {
          const idx = start + offset;
          return (
            <TrackRow
              key={id}
              id={id}
              index={idx}
              isCurrent={id === cur}
              isPlaying={id === cur && playing}
              animateRow={animateRows && idx < TRACK_LIST_PAGE_SIZE}
              playlistId={playlistId}
              onPlayIndex={onPlayIndex}
            />
          );
        })}
      </div>
      {paginated && effectiveCount < ids.length && (
        <div ref={sentinelRef} className="h-4 w-full" aria-hidden="true" />
      )}
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
      onClick={() => {
        if (isCur) {
          const st = player.get();
          if (st.state === 'error' || st.state === 'loading' || st.loading) playQueue(list, index);
          else toggle();
        } else {
          playQueue(list, index);
        }
      }}
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
