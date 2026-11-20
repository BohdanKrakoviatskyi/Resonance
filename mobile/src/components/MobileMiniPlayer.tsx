import { useEffect, useRef } from 'react';
import { Icon } from './Icon';
import { IconButton } from './ui';
import { ArtCover } from './Cover';
import { LikeButton, SourcePill } from './TrackList';
import { clamp, cx, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { next, onFrame, player, prev, toggle, useCurrentTrack } from '../state/player';
import { ui } from '../state/ui';

export function MobileMiniPlayer() {
  const track = useCurrentTrack();
  const playing = useStore(player, (s) => s.playing);
  const loading = useStore(player, (s) => s.loading);
  const barRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    return onFrame((pos, totalDur) => {
      if (!barRef.current) return;
      const f = totalDur > 0 ? clamp(pos / totalDur, 0, 1) : 0;
      barRef.current.style.transform = `scaleX(${f.toFixed(4)})`;
    });
  }, []);

  if (!track) return null;

  const active = playing || loading;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => ui.set({ nowPlayingOpen: true })}
      onKeyDown={(e) =>
        (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ui.set({ nowPlayingOpen: true }))
      }
      onTouchStart={(e) => {
        const touch = e.touches[0];
        swipeRef.current = { x: touch.clientX, y: touch.clientY };
      }}
      onTouchEnd={(e) => {
        if (!swipeRef.current) return;
        const touch = e.changedTouches[0];
        const dx = touch.clientX - swipeRef.current.x;
        const dy = touch.clientY - swipeRef.current.y;
        swipeRef.current = null;
        if (Math.abs(dx) > 54 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          e.stopPropagation();
          if (dx < 0) void next();
          else void prev();
        }
      }}
      className="mobile-mini panel pointer-events-auto relative flex items-center gap-3 px-2.5 py-2"
    >
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[15px] shadow-md">
        <ArtCover src={track.thumb || track.cover} className="h-full w-full rounded-[15px]" />
        {playing && !loading && (
          <span className="pointer-events-none absolute bottom-1 right-1 grid h-5 w-5 place-items-center rounded-full bg-black/55 backdrop-blur-sm">
            <span className="eq on !h-2.5 !w-3">
              <i />
              <i />
              <i />
            </span>
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-extrabold leading-tight">{track.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-on-surface-variant">
          <SourcePill track={track} />
          <span className="truncate">{track.artist}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        <LikeButton id={track.id} />
        <button
          type="button"
          data-ripple
          data-playing={active}
          aria-label={active ? t('pause') : t('play')}
          onClick={toggle}
          className={cx(
            'play-btn sl !h-10 !w-10',
            active ? '!rounded-[13px]' : '!rounded-full',
          )}
        >
          <Icon name="play_arrow" fill className="pi-play !text-[22px]" />
          <Icon name="pause" fill className="pi-pause !text-[22px]" />
          {loading && (
            <svg className="play-spin" viewBox="0 0 66 66" aria-hidden="true">
              <circle cx="33" cy="33" r="31" />
            </svg>
          )}
        </button>
        <IconButton
          icon="skip_next"
          label={t('next')}
          size="sm"
          fill
          tip={false}
          onClick={() => void next()}
        />
      </div>

      {/* Hairline 60/120Hz progress along bottom edge */}
      <div className="pointer-events-none absolute inset-x-4 bottom-0 h-[2.5px] overflow-hidden rounded-full bg-on-surface/10">
        <div
          ref={barRef}
          className="h-full w-full origin-left bg-primary will-change-transform"
          style={{ transform: 'scaleX(0)' }}
        />
      </div>
    </div>
  );
}
