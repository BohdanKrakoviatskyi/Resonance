import { Icon } from './Icon';
import { IconButton } from './ui';
import { Cover } from './Cover';
import { SourcePill } from './TrackList';
import { useStore } from '../lib/util';
import { next, player, toggle, useCurrentTrack } from '../state/player';
import { ui } from '../state/ui';

export function MobileMiniPlayer() {
  const track = useCurrentTrack();
  const playing = useStore(player, (s) => s.playing);
  const loading = useStore(player, (s) => s.loading);
  const pos = useStore(player, (s) => s.pos);
  const duration = useStore(player, (s) => s.duration);

  if (!track) return null;

  const progress = duration > 0 ? Math.min(1, Math.max(0, pos / duration)) : 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => ui.set({ nowPlayingOpen: true })}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ui.set({ nowPlayingOpen: true }))}
      className="mobile-mini panel relative mx-2.5 mb-1.5 flex items-center gap-3 overflow-hidden rounded-2xl px-3 py-2 shadow-xl"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[2.5px] bg-on-surface/10">
        <div
          className="h-full origin-left bg-primary transition-transform duration-300"
          style={{ transform: `scaleX(${progress})` }}
        />
      </div>

      <Cover src={track.thumb || track.cover} className="h-11 w-11 shrink-0 rounded-xl" />

      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-bold leading-tight">{track.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-on-surface-variant">
          <SourcePill track={track} />
          <span className="truncate">{track.artist}</span>
        </div>
      </div>

      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        className="sl grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary text-on-primary"
      >
        <Icon name={loading ? 'graphic_eq' : playing ? 'pause' : 'play_arrow'} fill size={22} />
      </button>

      <IconButton
        icon="skip_next"
        label="Next"
        size="sm"
        tip={false}
        onClick={(e) => {
          e.stopPropagation();
          void next();
        }}
      />
    </div>
  );
}
