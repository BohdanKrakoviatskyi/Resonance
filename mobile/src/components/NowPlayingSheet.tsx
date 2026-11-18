import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Slider, usePresence, type Vars } from './ui';
import { Cover } from './Cover';
import { Controls, Seek, TimeNow, TimeTotal } from './Seek';
import { Lyrics } from './Lyrics';
import { EqPanel } from './EqSheet';
import { LikeButton, SourcePill } from './TrackList';
import { clamp, cx, fmtTime, useStore } from '../lib/util';
import { pick, t, useLang } from '../lib/i18n';
import { appearance } from '../state/appearance';
import { theme } from '../state/theme';
import { getTrack } from '../state/library';
import {
  jumpTo,
  next,
  player,
  prev,
  setCrossfadeDuration,
  skipToIndex,
  toggle,
  useCurrentTrack,
} from '../state/player';
import { openSearch, openTrackMenu, ui } from '../state/ui';

type NpMode = 'artwork' | 'lyrics' | 'queue' | 'eq';

function MobileCrossfadePill() {
  const cfEnabled = useStore(player, (s) => s.crossfadeEnabled);
  const cfDur = useStore(player, (s) => s.crossfadeDuration);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const effectiveVal = cfEnabled ? cfDur : 0;

  return (
    <div ref={ref} className="relative z-30">
      <button
        type="button"
        data-ripple
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'sl inline-flex h-9 items-center gap-1 rounded-full px-3 text-xs font-bold backdrop-blur-md transition',
          effectiveVal > 0
            ? 'bg-primary/24 text-primary ring-1 ring-primary/40'
            : 'bg-on-surface/10 text-on-surface-variant ring-1 ring-white/10',
        )}
      >
        <Icon name="tune" size={16} />
        <span className="tabular-nums">
          {effectiveVal > 0 ? `${effectiveVal}${t('secUnit')}` : t('off')}
        </span>
      </button>

      {open && (
        <div className="anim-in absolute right-0 top-11 w-60 rounded-[24px] bg-sc-high/94 p-3.5 shadow-2xl ring-1 ring-white/14 backdrop-blur-2xl">
          <div className="mb-2 flex items-center justify-between text-xs font-bold">
            <span>{t('crossfade')}</span>
            <span className="tabular-nums text-primary">
              {effectiveVal > 0 ? `${effectiveVal} ${t('secUnit')}` : t('off')}
            </span>
          </div>
          <Slider
            value={effectiveVal}
            min={0}
            max={12}
            step={0.5}
            onChange={(v) => setCrossfadeDuration(v)}
            label={t('crossfade')}
            size="sm"
          />
          <div className="mt-1 flex justify-between text-[10px] text-on-surface-variant">
            <span>0 {t('secUnit')}</span>
            <span>6 {t('secUnit')}</span>
            <span>12 {t('secUnit')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Touch-swipeable 3D Coverflow Stage with subtle play/pause breathing scale. */
function MobileCoverStage({
  activeIndex,
  queue,
  playing,
}: {
  activeIndex: number;
  queue: string[];
  playing: boolean;
}) {
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const n = queue.length;
  const centerIdx = clamp(activeIndex, 0, Math.max(0, n - 1));
  const offsets = [-1, 0, 1] as const;

  return (
    <div
      className="relative flex w-full items-center justify-center px-4 select-none"
      style={{ perspective: '1000px' }}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        swipeStart.current = { x: touch.clientX, y: touch.clientY };
      }}
      onTouchEnd={(e) => {
        if (!swipeStart.current) return;
        const touch = e.changedTouches[0];
        const dx = touch.clientX - swipeStart.current.x;
        const dy = touch.clientY - swipeStart.current.y;
        swipeStart.current = null;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.25) {
          if (dx < 0) void next();
          else void prev();
        }
      }}
    >
      <div className="relative aspect-square w-full max-w-[min(324px,40dvh)]">
        {offsets.map((offset) => {
          const itemIdx = centerIdx + offset;
          if (itemIdx < 0 || itemIdx >= n) return null;
          const tr = getTrack(queue[itemIdx]);
          if (!tr) return null;
          const isCenter = offset === 0;
          return (
            <div
              key={`${queue[itemIdx]}:${itemIdx}`}
              data-offset={offset}
              role="button"
              tabIndex={0}
              aria-label={`${tr.title} — ${tr.artist}`}
              onClick={() => {
                if (isCenter) toggle();
                else void jumpTo(itemIdx);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (isCenter) toggle();
                  else void jumpTo(itemIdx);
                }
              }}
              className={cx(
                'imm-carousel-card !rounded-[32px]',
                isCenter && !playing && '!scale-[0.94]',
              )}
            >
              <Cover src={tr.cover || tr.thumb} className="h-full w-full !rounded-[32px]" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Rich multi-layered animated backdrop inside NowPlayingSheet:
 * - Lets custom uploaded Photo/GIF (`bgMode === 'image'`) from `<Background />` shine right through;
 * - Otherwise paints dual slow-drifting blurred artwork layers from the playing track's cover
 *   so the fullscreen player glows dynamically like Desktop Immersive mode.
 */
function ImmersivePlayerBackdrop({ coverUrl }: { coverUrl?: string }) {
  const bgMode = useStore(appearance, (s) => s.bgMode);
  const bgDim = useStore(appearance, (s) => s.bgDim);
  const bgBlur = useStore(appearance, (s) => s.bgBlur);
  const metallic = useStore(appearance, (s) => s.metallic);
  const dark = useStore(theme, (s) => s.dark);

  const showCustomImageThrough = bgMode === 'image';
  const dimAlpha = clamp((showCustomImageThrough ? bgDim : Math.max(26, bgDim)) / 100, 0.18, 0.82);
  const extraBlur = clamp(bgBlur, 0, 60);

  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {!showCustomImageThrough && (
        <div
          className="absolute inset-0 transition-colors duration-500"
          style={{ background: 'var(--bg-base, var(--md-surface))' }}
        />
      )}

      {!showCustomImageThrough && coverUrl && (
        <div key={coverUrl} className="np-aura-enter absolute inset-[-18%] overflow-hidden">
          <img
            src={coverUrl}
            alt=""
            decoding="async"
            className="np-aura-drift-1 absolute inset-0 h-full w-full object-cover"
            style={{
              filter: metallic
                ? `blur(${54 + extraBlur}px) saturate(0.28) contrast(1.15)`
                : `blur(${52 + extraBlur}px) saturate(${dark ? 1.65 : 1.3}) brightness(${dark ? 0.82 : 1.08})`,
              opacity: dark ? 0.88 : 0.55,
            }}
          />
          <img
            src={coverUrl}
            alt=""
            decoding="async"
            className="np-aura-drift-2 absolute -bottom-[12%] -right-[10%] h-[78%] w-[78%] rounded-full object-cover mix-blend-screen"
            style={{
              filter: metallic
                ? `blur(${64 + extraBlur}px) saturate(0.2)`
                : `blur(${64 + extraBlur}px) saturate(1.85)`,
              opacity: dark ? 0.5 : 0.28,
            }}
          />
        </div>
      )}

      {/* Subtle radial depth vignette + legibility scrim */}
      <div
        className="absolute inset-0"
        style={{
          background: dark
            ? `radial-gradient(circle at 50% 34%, rgb(0 0 0 / ${(dimAlpha * 0.55).toFixed(2)}) 0%, rgb(0 0 0 / ${Math.min(0.86, dimAlpha + 0.28).toFixed(2)}) 100%)`
            : `radial-gradient(circle at 50% 34%, rgb(255 255 255 / ${(dimAlpha * 0.55).toFixed(2)}) 0%, rgb(255 255 255 / ${Math.min(0.9, dimAlpha + 0.36).toFixed(2)}) 100%)`,
        }}
      />
    </div>
  );
}

export function NowPlayingSheet() {
  const open = useStore(ui, (s) => s.nowPlayingOpen);
  const { mounted, visible } = usePresence(open, 420);
  const storedTab = useStore(ui, (s) => s.nowPlayingTab);
  const [eqMode, setEqMode] = useState(false);
  const track = useCurrentTrack();
  const playing = useStore(player, (s) => s.playing);
  const queue = useStore(player, (s) => s.queue);
  const curIndex = useStore(player, (s) => s.index);
  const eqEnabled = useStore(player, (s) => s.eqEnabled);
  useLang();

  useEffect(() => {
    if (!open) setEqMode(false);
  }, [open]);

  if (!mounted || !track) return null;

  const mode: NpMode = eqMode ? 'eq' : storedTab;
  const setMode = (nextMode: NpMode) => {
    if (nextMode === 'eq') {
      setEqMode(true);
    } else {
      setEqMode(false);
      ui.set({ nowPlayingTab: nextMode });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('nowPlaying')}
      data-open={visible}
      className="np-sheet fixed inset-0 z-40 flex flex-col overflow-hidden text-on-surface"
    >
      <ImmersivePlayerBackdrop coverUrl={track.cover || track.thumb} />

      {/* Top pull handle + Controls bar */}
      <header className="relative z-20 flex flex-col gap-2 px-4 pb-2 pt-[calc(env(safe-area-inset-top,0px)+8px)]">
        <div className="mx-auto h-1 w-9 rounded-full bg-on-surface/25" />
        <div className="flex items-center justify-between gap-2">
          <IconButton
            icon="expand_more"
            label={t('collapse')}
            variant="glass"
            tip={false}
            onClick={() => ui.set({ nowPlayingOpen: false })}
          />

          <div className="inline-flex items-center gap-0.5 rounded-full bg-on-surface/10 p-1 ring-1 ring-white/10 backdrop-blur-md" role="group">
            {(
              [
                { id: 'artwork', icon: 'music_note', label: pick('Трек', 'Track') },
                { id: 'lyrics', icon: 'lyrics', label: t('lyrics') },
                { id: 'queue', icon: 'queue_music', label: t('upNext') },
              ] as const
            ).map((item) => {
              const active = mode === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-ripple
                  aria-pressed={active}
                  onClick={() => setMode(item.id)}
                  className={cx(
                    'sl inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-bold transition-all duration-200',
                    active ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant',
                  )}
                >
                  <Icon name={item.icon} fill={active} size={16} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1">
            <IconButton
              icon="graphic_eq"
              label={t('equalizer')}
              variant={mode === 'eq' || eqEnabled ? 'filled' : 'glass'}
              selected={mode === 'eq' || eqEnabled}
              tip={false}
              onClick={() => setMode(mode === 'eq' ? 'artwork' : 'eq')}
            />
            <IconButton
              icon="more_vert"
              label={t('menu')}
              variant="glass"
              tip={false}
              onClick={() => openTrackMenu(track.id)}
            />
          </div>
        </div>
      </header>

      {/* Main Content Stage */}
      {mode === 'artwork' && (
        <div className="flex min-h-0 flex-1 flex-col justify-between px-6 pb-[calc(env(safe-area-inset-bottom,0px)+22px)] pt-1">
          <div className="my-auto flex flex-col items-center py-2">
            <MobileCoverStage activeIndex={curIndex} queue={queue} playing={playing} />
          </div>

          <div className="flex flex-col gap-3.5">
            <div key={track.id} className="meta-in flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="display truncate text-[clamp(22px,6.2vw,28px)] leading-tight">{track.title}</h1>
                <div className="mt-1 flex items-center gap-2">
                  <SourcePill track={track} />
                  <button
                    type="button"
                    onClick={() => {
                      ui.set({ nowPlayingOpen: false });
                      openSearch(track.artist);
                    }}
                    className="truncate text-[15px] font-semibold text-on-surface-variant active:text-primary"
                  >
                    {track.artist}
                  </button>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <MobileCrossfadePill />
                <LikeButton id={track.id} />
              </div>
            </div>

            <div>
              <Seek big />
              <div className="mt-0.5 flex justify-between">
                <TimeNow />
                <TimeTotal />
              </div>
            </div>

            <Controls size="lg" />
          </div>
        </div>
      )}

      {mode === 'lyrics' && (
        <div className="flex min-h-0 flex-1 flex-col pb-[calc(env(safe-area-inset-bottom,0px)+18px)]">
          {/* Compact track header in Lyrics view */}
          <div className="flex items-center gap-3 px-5 pb-2 pt-1">
            <Cover
              src={track.thumb || track.cover}
              className="h-11 w-11 shrink-0 rounded-2xl shadow-md"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-extrabold">{track.title}</div>
              <div className="truncate text-xs text-on-surface-variant">{track.artist}</div>
            </div>
            <LikeButton id={track.id} />
          </div>

          <Lyrics track={track} active={open && mode === 'lyrics'} />

          <div className="mt-1 px-6 pt-2">
            <Seek />
            <div className="mb-2 flex justify-between">
              <TimeNow />
              <TimeTotal />
            </div>
            <Controls />
          </div>
        </div>
      )}

      {mode === 'eq' && (
        <div className="flex min-h-0 flex-1 flex-col justify-between overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-2">
          <EqPanel />
          <div className="mt-3 px-2">
            <Seek />
            <div className="mb-2 flex justify-between">
              <TimeNow />
              <TimeTotal />
            </div>
            <Controls />
          </div>
        </div>
      )}

      {mode === 'queue' && (
        <div className="flex min-h-0 flex-1 flex-col pb-[calc(env(safe-area-inset-bottom,0px)+18px)]">
          <div className="mb-1.5 flex items-center justify-between px-6 pt-1">
            <span className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">
              {t('upNext')} · {queue.length}
            </span>
            <MobileCrossfadePill />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            <div className="flex flex-col gap-1 pb-4">
              {queue.map((id, idx) => {
                const item = getTrack(id);
                if (!item) return null;
                const isCur = idx === curIndex;
                return (
                  <button
                    key={`${id}-${idx}`}
                    type="button"
                    data-ripple
                    onClick={() => void skipToIndex(idx)}
                    style={{ '--i': Math.min(idx, 12) } as Vars}
                    className={cx(
                      'anim-in sl flex items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors',
                      isCur ? 'bg-primary/20 ring-1 ring-primary/35' : 'hover:bg-on-surface/8',
                    )}
                  >
                    <div className="relative h-11 w-11 shrink-0">
                      <Cover src={item.thumb || item.cover} className="h-11 w-11 rounded-xl" />
                      {isCur && (
                        <span className="absolute inset-0 grid place-items-center rounded-xl bg-black/45">
                          <span className={cx('eq', playing && 'on')}>
                            <i />
                            <i />
                            <i />
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={cx('truncate text-sm font-bold', isCur && 'text-primary')}>{item.title}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-on-surface-variant">
                        <SourcePill track={item} />
                        <span className="truncate">{item.artist}</span>
                      </div>
                    </div>
                    <span className="text-xs font-semibold tabular-nums text-on-surface-variant">
                      {fmtTime(item.duration)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="px-6 pt-2">
            <Controls />
          </div>
        </div>
      )}
    </div>
  );
}
