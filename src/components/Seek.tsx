import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Slider, type Vars } from './ui';
import { clamp, cx, fmtTime, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { adjustVolumePos, cycleRepeat, dur, next, onFrame, player, prev, seek, seekBy, setVolumePos, volumeToPos, toggle, toggleMute, toggleShuffle, usePlaybackControlLocked, useSecond } from '../state/player';

/** M3 Expressive wavy progress: the played part is a travelling sine wave that flattens when paused. */
export function Seek({ big }: { big?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const clip = useRef<SVGRectElement>(null);
  const rest = useRef<SVGLineElement>(null);
  const stop = useRef<SVGCircleElement>(null);
  const waveEl = useRef<SVGPathElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const wRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const playing = useStore(player, (s) => s.playing);
  const has = useStore(player, (s) => s.index >= 0);
  const locked = usePlaybackControlLocked();
  const canControl = has && !locked;
  const id = 'sk' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const H = big ? 40 : 28;
  const A = big ? 4 : 3;
  const L = big ? 36 : 28;
  const GAP = big ? 8 : 6;

  // Геометрия (ширина, волна, точки) живёт в ref'ах и пишется напрямую в DOM:
  // во время width-анимаций панелей ResizeObserver срабатывает каждый кадр —
  // React-ре-рендер на каждый кадр (прежний setW) и был причиной дёрганья.
  const syncGeometry = useCallback(() => {
    const w = wRef.current;
    svg.current?.setAttribute('width', String(w));
    if (waveEl.current) {
      const y = H / 2;
      let p = `M ${-L} ${y}`;
      for (let x = -L; x < w + L; x += L) p += ` q ${L / 4} ${-A * 2} ${L / 2} 0 t ${L / 2} 0`;
      waveEl.current.setAttribute('d', p);
    }
    rest.current?.setAttribute('x2', String(Math.max(GAP, w - 4)));
    stop.current?.setAttribute('cx', String(Math.max(0, w - 2)));
  }, [H, A, L, GAP]);

  useLayoutEffect(() => {
    const el = wrap.current!;
    wRef.current = el.clientWidth;
    syncGeometry();
    const ro = new ResizeObserver(() => {
      const nw = el.clientWidth;
      if (nw === wRef.current) return;
      wRef.current = nw;
      syncGeometry();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncGeometry]);

  const paint = useCallback(
    (f: number) => {
      const w = wRef.current;
      const x = clamp(f, 0, 1) * w;
      clip.current?.setAttribute('width', String(Math.max(0, x - GAP)));
      const x1 = Math.min(w - 4, x + GAP);
      rest.current?.setAttribute('x1', String(x1));
      rest.current?.setAttribute('opacity', x1 >= w - 5 ? '0' : '1');
      if (thumb.current) thumb.current.style.transform = `translateX(${x}px)`;
      if (bubble.current) bubble.current.style.transform = `translateX(${x}px) translateX(-50%)`;
    },
    [GAP],
  );

  const fx = (cx: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return clamp((cx - r.left) / r.width, 0, 1);
  };
  const show = (f: number) => {
    paint(f);
    if (bubble.current) bubble.current.textContent = fmtTime(f * dur());
  };

  useEffect(() => onFrame((ct, d) => drag.current == null && paint(d ? ct / d : 0)), [paint]);

  return (
    <div
      ref={wrap}
      className={cx('seek', big && 'seek-big', playing && 'is-playing', dragging && 'dragging', !canControl && 'disabled')}
      style={{ height: H, '--wl': L + 'px' } as Vars}
      role="slider"
      tabIndex={canControl ? 0 : -1}
      aria-label={t('seek')}
      aria-disabled={!canControl}
      onPointerDown={(e) => {
        if (!canControl) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = fx(e.clientX);
        setDragging(true);
        show(drag.current);
      }}
      onPointerMove={(e) => {
        if (drag.current == null) return;
        drag.current = fx(e.clientX);
        show(drag.current);
      }}
      onPointerUp={() => {
        if (drag.current == null) return;
        const targetFraction = drag.current;
        drag.current = null;
        setDragging(false);
        seek(targetFraction * dur());
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={(e) => {
        if (!canControl) return;
        if (e.key === 'ArrowRight') seekBy(5);
        else if (e.key === 'ArrowLeft') seekBy(-5);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <svg ref={svg} width={0} height={H} aria-hidden="true">
        <defs>
          <clipPath id={id}>
            <rect ref={clip} x={0} y={-10} height={H + 20} width={0} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id})`}>
          <g className="seek-wave" style={{ transformOrigin: `0 ${H / 2}px` }}>
            <path ref={waveEl} vectorEffect="non-scaling-stroke" />
          </g>
        </g>
        <line ref={rest} className="seek-rest" x1={GAP} x2={GAP} y1={H / 2} y2={H / 2} />
        <circle ref={stop} className="seek-stop" cx={0} cy={H / 2} r={big ? 3 : 2} />
      </svg>
      <div ref={thumb} className="seek-thumb" />
      <div ref={bubble} className="seek-bubble" />
    </div>
  );
}

export function TimeNow({ className }: { className?: string }) {
  const s = useSecond();
  return <span className={cx('time text-right', className)}>{fmtTime(s)}</span>;
}
export function TimeTotal({ className }: { className?: string }) {
  const d = useStore(player, (s) => s.duration);
  return <span className={cx('time', className)}>{fmtTime(d)}</span>;
}

export function PlayButton() {
  const playing = useStore(player, (s) => s.playing);
  const loading = useStore(player, (s) => s.loading);
  const has = useStore(player, (s) => s.index >= 0);
  const locked = usePlaybackControlLocked();
  const active = playing || loading;
  const label = active ? t('pause') : t('play');
  return (
    <button type="button" className="play-btn sl" data-ripple data-playing={active} data-loading={loading} aria-label={label} data-tip={label} onClick={toggle} disabled={!has || locked}>
      <Icon name="play_arrow" fill className="pi-play" />
      <Icon name="pause" fill className="pi-pause" />
      {loading && (
        <svg className="play-spin" viewBox="0 0 66 66" aria-hidden="true">
          <circle cx="33" cy="33" r="31" />
        </svg>
      )}
    </button>
  );
}

export function Controls({ size }: { size?: 'lg' }) {
  const shuffle = useStore(player, (s) => s.shuffle);
  const repeat = useStore(player, (s) => s.repeat);
  const has = useStore(player, (s) => s.index >= 0);
  const locked = usePlaybackControlLocked();
  return (
    <div className={cx('controls', size === 'lg' && 'controls-lg')}>
      <IconButton icon="shuffle" label={t('shuffle')} toggle selected={shuffle} onClick={toggleShuffle} className="ctl-toggle" disabled={locked} />
      <IconButton icon="skip_previous" fill label={t('previous')} onClick={prev} disabled={!has || locked} />
      <PlayButton />
      <IconButton icon="skip_next" fill label={t('next')} onClick={() => next()} disabled={!has || locked} />
      <IconButton
        icon={repeat === 'one' ? 'repeat_one' : 'repeat'}
        label={repeat === 'one' ? t('repeatOne') : t('repeat')}
        toggle
        selected={repeat !== 'off'}
        onClick={cycleRepeat}
        disabled={locked}
        className="ctl-toggle"
      />
    </div>
  );
}

export function Volume({ className }: { className?: string }) {
  const v = useStore(player, (s) => s.volume);
  const m = useStore(player, (s) => s.muted);
  // The slider works in perceptual position space (cube root of the gain,
  // see player.volumeToPos) so the quiet range gets most of the track.
  const p = volumeToPos(m ? 0 : v);
  const icon = m || v === 0 ? 'volume_off' : v < 0.25 ? 'volume_down' : 'volume_up';
  const pct = Math.round(v * 100);
  const db = v <= 0 ? '−∞' : `${(20 * Math.log10(v)).toFixed(1)} dB`;
  return (
    <div
      className={cx('flex min-w-0 items-center gap-1', className)}
      onWheel={(e) => {
        // Steps in position space, scaled by the actual delta so trackpad
        // flicks don't race; Shift makes it a fine adjustment.
        const lines = e.deltaMode === 1 ? 33 : 1;
        const step = clamp((-e.deltaY * lines) / 100, -1, 1) * (e.shiftKey ? 0.005 : 0.02);
        if (step) adjustVolumePos(step);
      }}
    >
      <IconButton icon={icon} label={t('mute')} onClick={toggleMute} size="sm" fill />
      <Slider
        value={p}
        step={0.01}
        onChange={setVolumePos}
        onDoubleClick={() => setVolumePos(volumeToPos(0.8))}
        valueText={m ? '0%' : `${pct}% (${db})`}
        label={t('volume')}
        size="sm"
        className="hide-md w-28"
      />
    </div>
  );
}
