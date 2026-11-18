import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Menu, Slider, usePresence } from './ui';
import { ArtCover, Cover } from './Cover';
import { EqPanel } from './EqPanel';
import { Lyrics } from './Lyrics';
import { Visualizer, cycleViz, vizStore } from './Visualizer';
import { Controls, Seek, TimeNow, TimeTotal } from './Seek';
import { DislikeButton, LikeButton, PlaylistPicker, SourcePill } from './TrackList';
import { clamp, cx, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { supportsVT, vtBlurSafe } from '../lib/motion';
import { getTrack, library } from '../state/library';
import {
  adjustVolumePos,
  jumpTo,
  player,
  setCrossfadeDuration,
  setVolumePos,
  toggle,
  toggleMute,
  useCurrentTrack,
  volumeToPos,
} from '../state/player';
import { openSearch, setImmersive, ui } from '../state/ui';

/** Interactive 3D Coverflow carousel with Play badge on previewed tracks and a "Back to playing" pill. */
function CoverCarousel({ activeIndex, queue, vt }: { activeIndex: number; queue: string[]; vt: boolean }) {
  const [browseIndex, setBrowseIndex] = useState(activeIndex);

  useEffect(() => {
    setBrowseIndex(activeIndex);
  }, [activeIndex, queue]);

  const n = queue.length;
  const centerIdx = clamp(browseIndex, 0, Math.max(0, n - 1));
  const canPrev = centerIdx > 0;
  const canNext = centerIdx < n - 1;
  const isBrowsingOther = centerIdx !== activeIndex && activeIndex >= 0 && activeIndex < n;

  const offsets = [-2, -1, 0, 1, 2] as const;

  const handleCardClick = (targetIdx: number) => {
    if (targetIdx < 0 || targetIdx >= n) return;
    if (targetIdx !== centerIdx) {
      // Clicking a side cover brings it to center; clicking the centered preview cover starts playing it immediately
      setBrowseIndex(targetIdx);
      void jumpTo(targetIdx);
      return;
    }
    if (targetIdx === activeIndex) {
      toggle();
      return;
    }
    void jumpTo(targetIdx);
  };

  const previewedTrack = isBrowsingOther ? getTrack(queue[centerIdx]) : null;

  return (
    <div
      className="imm-carousel"
      onWheel={(e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          if (e.deltaX > 15 && canNext) setBrowseIndex((i) => Math.min(n - 1, i + 1));
          else if (e.deltaX < -15 && canPrev) setBrowseIndex((i) => Math.max(0, i - 1));
        }
      }}
    >
      <div className="imm-carousel-stage">
        {n > 1 && (
          <IconButton
            icon="chevron_left"
            label={t('previous')}
            variant="glass"
            disabled={!canPrev}
            tip={false}
            className="imm-carousel-arrow imm-carousel-arrow-prev"
            onClick={(e) => {
              e.stopPropagation();
              if (canPrev) setBrowseIndex((i) => Math.max(0, i - 1));
            }}
          />
        )}

        {offsets.map((offset) => {
          const itemIdx = centerIdx + offset;
          if (itemIdx < 0 || itemIdx >= n) return null;
          const tr = getTrack(queue[itemIdx]);
          if (!tr) return null;
          const isCenter = offset === 0;
          const isDifferentFromPlaying = itemIdx !== activeIndex;

          return (
            <div
              key={`${queue[itemIdx]}:${itemIdx}`}
              data-offset={offset}
              data-browsing={isCenter && isDifferentFromPlaying ? 'true' : undefined}
              className="imm-carousel-card"
              role="button"
              tabIndex={Math.abs(offset) <= 1 ? 0 : -1}
              aria-label={`${tr.title} — ${tr.artist}`}
              onClick={() => handleCardClick(itemIdx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleCardClick(itemIdx);
                }
              }}
            >
              {isCenter && itemIdx === activeIndex ? (
                <ArtCover src={tr.cover ?? tr.thumb} vt={vt ? 'np-cover' : undefined} className="h-full w-full" />
              ) : (
                <Cover src={tr.cover ?? tr.thumb} className="h-full w-full" />
              )}
              {isDifferentFromPlaying && isCenter && (
                <span className="imm-carousel-play-badge">
                  <span className="grid h-16 w-16 place-items-center rounded-full bg-primary text-on-primary shadow-2xl transition-transform hover:scale-108">
                    <Icon name="play_arrow" fill size={36} />
                  </span>
                </span>
              )}
              {isDifferentFromPlaying && isCenter && previewedTrack && (
                <div className="pointer-events-none absolute inset-x-3 top-3 flex justify-center">
                  <span className="max-w-full truncate rounded-full bg-black/60 px-3.5 py-1 text-xs font-semibold text-white backdrop-blur-md">
                    {previewedTrack.title} · {previewedTrack.artist}
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {isBrowsingOther && (
          <button
            type="button"
            data-ripple
            className="imm-carousel-return sl"
            onClick={(e) => {
              e.stopPropagation();
              setBrowseIndex(activeIndex);
            }}
          >
            <Icon name={centerIdx > activeIndex ? 'chevron_left' : 'chevron_right'} size={17} />
            <span>{t('backToPlaying')}</span>
          </button>
        )}

        {n > 1 && (
          <IconButton
            icon="chevron_right"
            label={t('next')}
            variant="glass"
            disabled={!canNext}
            tip={false}
            className="imm-carousel-arrow imm-carousel-arrow-next"
            onClick={(e) => {
              e.stopPropagation();
              if (canNext) setBrowseIndex((i) => Math.min(n - 1, i + 1));
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Top-bar Crossfade pill button + popover slider (also supports mouse-wheel step adjustment). */
function TopBarCrossfadePill() {
  const crossfadeEnabled = useStore(player, (s) => s.crossfadeEnabled);
  const crossfadeDuration = useStore(player, (s) => s.crossfadeDuration);
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  const effectiveVal = crossfadeEnabled ? crossfadeDuration : 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  return (
    <div ref={popRef} className="relative z-20">
      <button
        type="button"
        data-ripple
        aria-expanded={open}
        title={t('crossfade')}
        className={cx(
          'sl inline-flex h-11 items-center gap-2 rounded-full px-4 text-xs font-semibold backdrop-blur-md transition',
          effectiveVal > 0
            ? 'bg-primary/20 text-primary ring-1 ring-primary/45'
            : 'bg-on-surface/9 text-on-surface-variant ring-1 ring-white/10 hover:text-on-surface',
        )}
        onClick={() => setOpen((v) => !v)}
        onWheel={(e) => {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.5 : -0.5;
          const nextVal = clamp(effectiveVal + delta, 0, 12);
          setCrossfadeDuration(nextVal);
        }}
      >
        <Icon name="tune" size={17} />
        <span>{t('crossfade')}</span>
        <span className="tabular-nums font-bold">
          {effectiveVal > 0 ? `${effectiveVal} ${t('secUnit')}` : t('off')}
        </span>
      </button>

      {open && (
        <div className="anim-in absolute right-0 top-13 w-64 rounded-3xl bg-sc-high/92 p-4 shadow-2xl ring-1 ring-white/12 backdrop-blur-xl">
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
          <div className="mt-1 flex justify-between text-[11px] text-on-surface-variant">
            <span>0 {t('secUnit')}</span>
            <span>6 {t('secUnit')}</span>
            <span>12 {t('secUnit')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact Volume Controller for the left column in Immersive mode. */
function ImmersiveVolumeControl() {
  const v = useStore(player, (s) => s.volume);
  const m = useStore(player, (s) => s.muted);
  const p = volumeToPos(m ? 0 : v);
  const icon = m || v === 0 ? 'volume_off' : v < 0.25 ? 'volume_down' : 'volume_up';
  const pct = Math.round((m ? 0 : v) * 100);

  return (
    <div
      className="flex min-w-[140px] max-w-[210px] flex-1 items-center gap-1.5 rounded-full bg-on-surface/8 py-1 pl-1 pr-3.5 ring-1 ring-white/8"
      onWheel={(e) => {
        e.preventDefault();
        const lines = e.deltaMode === 1 ? 33 : 1;
        const step = clamp((-e.deltaY * lines) / 100, -1, 1) * (e.shiftKey ? 0.005 : 0.025);
        if (step) adjustVolumePos(step);
      }}
    >
      <IconButton icon={icon} label={t('mute')} onClick={toggleMute} size="sm" fill />
      <Slider
        value={p}
        step={0.01}
        onChange={setVolumePos}
        onDoubleClick={() => setVolumePos(volumeToPos(0.8))}
        valueText={`${pct}%`}
        label={t('volume')}
        size="sm"
        className="flex-1"
      />
    </div>
  );
}

/** Fullscreen lyrics & equalizer: interactive cover carousel + controls on the left, lyrics/EQ on the right. */
export function Immersive() {
  const open = useStore(ui, (s) => s.immersive);
  // В WebKit VT-снапшоты теряют блюр (bug 302256) — immersive идёт живым presence-фейдом.
  const vt = supportsVT() && vtBlurSafe;
  const { mounted, visible } = usePresence(open, vt ? 0 : 480);
  const track = useCurrentTrack();
  const queue = useStore(player, (s) => s.queue);
  const activeIndex = useStore(player, (s) => s.index);
  const inPlaylist = useStore(library, (s) => !!track && s.playlists.some((p) => p.ids.includes(track.id)));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [fs, setFs] = useState(false);
  const [rightMode, setRightMode] = useState<'lyrics' | 'eq'>('lyrics');
  const vizMode = useStore(vizStore, (s) => s.mode);

  useEffect(() => {
    const f = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.fullscreenElement && !anchor && setImmersive(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, anchor]);
  useEffect(() => {
    if (open && !track) setImmersive(false);
  }, [open, track]);

  if (!(vt ? open : mounted)) return null;
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});

  return (
    <div className="immersive" data-live={vt ? undefined : true} data-visible={vt ? true : visible} role="dialog" aria-modal="true" aria-label={t('fullscreenLyrics')}>
      <div className="imm-scrim" />
      {vizMode !== 'off' && open && <Visualizer mode={vizMode} />}
      <div className="imm-top">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <TopBarCrossfadePill />
          <IconButton
            icon="animation"
            label={`${t('visualizer')}: ${t(vizMode === 'off' ? 'vizOff' : vizMode === 'bars' ? 'vizBars' : 'vizWave')}`}
            variant="glass"
            selected={vizMode !== 'off'}
            onClick={cycleViz}
            tip="bottom"
          />
          <div className="mr-1 inline-flex items-center gap-1 rounded-full bg-on-surface/9 p-1 ring-1 ring-white/10 backdrop-blur-md" role="group">
            <button
              type="button"
              data-ripple
              aria-pressed={rightMode === 'lyrics'}
              className={cx(
                'sl inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition',
                rightMode === 'lyrics' ? 'bg-primary text-on-primary shadow' : 'text-on-surface-variant hover:text-on-surface',
              )}
              onClick={() => setRightMode('lyrics')}
            >
              <Icon name="lyrics" fill={rightMode === 'lyrics'} size={18} />
              <span>{t('lyrics')}</span>
            </button>
            <button
              type="button"
              data-ripple
              aria-pressed={rightMode === 'eq'}
              className={cx(
                'sl inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition',
                rightMode === 'eq' ? 'bg-primary text-on-primary shadow' : 'text-on-surface-variant hover:text-on-surface',
              )}
              onClick={() => setRightMode('eq')}
            >
              <Icon name="graphic_eq" fill={rightMode === 'eq'} size={18} />
              <span>{t('equalizer')}</span>
            </button>
          </div>
          {'requestFullscreen' in document.documentElement && (
            <IconButton icon={fs ? 'fullscreen_exit' : 'fullscreen'} label={t('fullscreen')} variant="glass" onClick={toggleFs} tip="bottom" />
          )}
          <IconButton icon="close_fullscreen" label={t('exitFullscreen')} variant="glass" onClick={() => setImmersive(false)} tip="bottom" />
        </div>
      </div>
      {track && (
        <div className="imm-grid">
          <div className="imm-left">
            <CoverCarousel activeIndex={activeIndex} queue={queue} vt={vt} />
            <div key={track.id} className="imm-meta meta-in">
              <h1 className="imm-title display">{track.title}</h1>
              <div className="mt-2 flex items-center gap-2 max-[900px]:justify-center">
                <SourcePill track={track} />
                <button
                  type="button"
                  className="truncate text-lg font-semibold text-on-surface-variant hover:text-primary"
                  onClick={() => {
                    setImmersive(false);
                    openSearch(track.artist);
                  }}
                >
                  {track.artist}
                </button>
              </div>
            </div>
            <div className="imm-actions flex flex-wrap items-center gap-2">
              <LikeButton id={track.id} variant="tonal" />
              <DislikeButton id={track.id} variant="tonal" />
              <IconButton
                icon={inPlaylist ? 'playlist_add_check' : 'playlist_add'}
                label={t('addToPlaylist')}
                variant="tonal"
                selected={!!anchor}
                onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
              />
              <ImmersiveVolumeControl />
            </div>
            <div>
              <Seek big />
              <div className="mt-1 flex justify-between">
                <TimeNow className="!text-left" />
                <TimeTotal className="text-right" />
              </div>
            </div>
            <Controls size="lg" />
          </div>
          <div className="imm-right">
            {rightMode === 'lyrics' ? (
              <Lyrics track={track} variant="imm" active={open} />
            ) : (
              <EqPanel />
            )}
          </div>
          <Menu anchor={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
            <PlaylistPicker id={track.id} onClose={() => setAnchor(null)} />
          </Menu>
        </div>
      )}
    </div>
  );
}
