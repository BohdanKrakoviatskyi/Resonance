import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Menu, MenuItem, Slider, usePresence } from './ui';
import { ArtCover, Cover } from './Cover';
import { Lyrics } from './Lyrics';
import { Controls, Seek, TimeNow, TimeTotal } from './Seek';
import { DislikeButton, LikeButton, PlaylistPicker, SourcePill } from './TrackList';
import { clamp, cx, useStore } from '../lib/util';
import { t, type Key } from '../lib/i18n';
import { supportsVT } from '../lib/motion';
import { getTrack, library } from '../state/library';
import {
  EQ_BANDS,
  adjustVolumePos,
  jumpTo,
  player,
  setCrossfadeDuration,
  setEqBandGain,
  setEqPreset,
  setVolumePos,
  toggle,
  toggleMute,
  useCurrentTrack,
  volumeToPos,
  type EqPreset,
} from '../state/player';
import { openSearch, setImmersive, ui } from '../state/ui';

const PRESET_OPTIONS: { value: EqPreset; labelKey: Key }[] = [
  { value: 'flat', labelKey: 'eqFlat' },
  { value: 'bassBoost', labelKey: 'eqBassBoost' },
  { value: 'vocal', labelKey: 'eqVocal' },
  { value: 'rock', labelKey: 'eqRock' },
  { value: 'electronic', labelKey: 'eqElectronic' },
  { value: 'custom', labelKey: 'eqCustom' },
];

/** Interactive 3D Coverflow carousel with Play badge on previewed tracks and a "Back to playing" pill. */
function CoverCarousel({ activeIndex, queue }: { activeIndex: number; queue: string[] }) {
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
                <ArtCover src={tr.cover ?? tr.thumb} vt="np-cover" className="h-full w-full" />
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

/** Vertical single-band slider for the 5-band Equalizer. */
function EqBandSlider({ index, freqLabel, gainDb }: { index: number; freqLabel: string; gainDb: number }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const updateFromClientY = (clientY: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const norm = 1 - clamp((clientY - rect.top) / (rect.height || 1), 0, 1); // 1 at top (+12dB), 0 at bottom (-12dB)
    const db = norm * 24 - 12;
    setEqBandGain(index, db);
  };

  const pctFromTop = clamp(((12 - gainDb) / 24) * 100, 0, 100);
  const fillTop = Math.min(50, pctFromTop);
  const fillHeight = Math.max(2, Math.abs(50 - pctFromTop));
  const formattedDb = `${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB`;

  return (
    <div className="imm-eq-band">
      <span className="text-xs font-bold tabular-nums text-primary">{formattedDb}</span>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={`${freqLabel} (${formattedDb})`}
        aria-valuemin={-12}
        aria-valuemax={12}
        aria-valuenow={gainDb}
        className={cx('imm-eq-track', dragging && 'dragging')}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          updateFromClientY(e.clientY);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          updateFromClientY(e.clientY);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => setEqBandGain(index, 0)}
        onWheel={(e) => {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.5 : -0.5;
          setEqBandGain(index, gainDb + delta);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setEqBandGain(index, gainDb + 0.5);
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setEqBandGain(index, gainDb - 0.5);
          else if (e.key === 'Home') setEqBandGain(index, 0);
          else return;
          e.preventDefault();
        }}
      >
        <div className="imm-eq-rail">
          <div className="absolute inset-x-0 top-1/2 h-[1px] bg-on-surface/25" aria-hidden="true" />
          <div className="imm-eq-fill" style={{ top: `${fillTop}%`, height: `${fillHeight}%` }} />
        </div>
        <div className="imm-eq-thumb" style={{ top: `${pctFromTop}%` }} />
      </div>
      <span className="text-xs font-semibold text-on-surface-variant">{freqLabel}</span>
    </div>
  );
}

/** 5-Band Web Audio API Equalizer panel for the right column of Immersive mode. */
function ImmersiveEqualizer() {
  const eqPreset = useStore(player, (s) => s.eqPreset);
  const eqGains = useStore(player, (s) => s.eqGains);
  const [presetAnchor, setPresetAnchor] = useState<HTMLElement | null>(null);

  const activePresetLabel = t(PRESET_OPTIONS.find((p) => p.value === eqPreset)?.labelKey ?? 'eqFlat');

  return (
    <div className="imm-eq-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-10 w-10 place-items-center rounded-2xl bg-primary/20 text-primary">
            <Icon name="graphic_eq" fill size={22} />
          </span>
          <div>
            <h2 className="headline text-xl leading-tight">{t('equalizer')}</h2>
            <p className="text-xs text-on-surface-variant">60Hz – 14kHz · Web Audio DSP</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {eqPreset !== 'flat' && (
            <button
              type="button"
              data-ripple
              className="sl rounded-full bg-on-surface/10 px-3.5 py-2 text-xs font-semibold text-on-surface-variant hover:text-on-surface"
              onClick={() => setEqPreset('flat')}
            >
              {t('eqReset')}
            </button>
          )}
          <button
            type="button"
            data-ripple
            className="sl inline-flex items-center gap-2 rounded-full bg-on-surface/12 px-4 py-2 text-sm font-semibold text-on-surface ring-1 ring-white/10"
            onClick={(e) => setPresetAnchor(presetAnchor ? null : e.currentTarget)}
          >
            <Icon name="tune" size={18} className="text-primary" />
            <span>{activePresetLabel}</span>
            <Icon name="chevron_right" size={18} className="rotate-90 text-on-surface-variant" />
          </button>
          <Menu anchor={presetAnchor} open={!!presetAnchor} onClose={() => setPresetAnchor(null)}>
            <div className="menu-head">{t('eqPresetLabel')}</div>
            {PRESET_OPTIONS.map((opt, idx) => (
              <MenuItem
                key={opt.value}
                i={idx}
                label={t(opt.labelKey)}
                checked={eqPreset === opt.value}
                onClick={() => {
                  setEqPreset(opt.value);
                  setPresetAnchor(null);
                }}
              />
            ))}
          </Menu>
        </div>
      </div>

      <div className="my-6 flex flex-1 items-stretch justify-between gap-2 sm:gap-4">
        {EQ_BANDS.map((band, idx) => (
          <EqBandSlider key={band.freq} index={idx} freqLabel={band.label} gainDb={eqGains[idx] ?? 0} />
        ))}
      </div>

      <div className="flex justify-between text-[11px] font-medium text-on-surface-variant/75">
        <span>−12 dB</span>
        <span>0 dB</span>
        <span>+12 dB</span>
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
  const vt = supportsVT();
  const { mounted, visible } = usePresence(open, vt ? 0 : 480);
  const track = useCurrentTrack();
  const queue = useStore(player, (s) => s.queue);
  const activeIndex = useStore(player, (s) => s.index);
  const inPlaylist = useStore(library, (s) => !!track && s.playlists.some((p) => p.ids.includes(track.id)));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [fs, setFs] = useState(false);
  const [rightMode, setRightMode] = useState<'lyrics' | 'eq'>('lyrics');

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
    <div className="immersive" data-visible={vt ? true : visible} role="dialog" aria-modal="true" aria-label={t('fullscreenLyrics')}>
      <div className="imm-scrim" />
      <div className="imm-top">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <TopBarCrossfadePill />
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
            <CoverCarousel activeIndex={activeIndex} queue={queue} />
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
              <Lyrics track={track} variant="imm" />
            ) : (
              <ImmersiveEqualizer />
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
