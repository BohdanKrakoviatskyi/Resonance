import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, Slider, type Vars } from './ui';
import { clamp, cx, fmtTime, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import { adjustVolumePos, cycleRepeat, dur, next, onFrame, player, prev, seek, seekBy, setVolumePos, volumeToPos, toggle, toggleMute, toggleShuffle, useSecond } from '../state/player';

/** M3 Expressive wavy progress: the played part is a travelling sine wave that flattens when paused. */
export function Seek({ big }: { big?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const clip = useRef<SVGRectElement>(null);
  const rest = useRef<SVGLineElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [w, setW] = useState(0);
  const playing = useStore(player, (s) => s.playing);
  const has = useStore(player, (s) => s.index >= 0);
  const id = 'sk' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const H = big ? 40 : 28;
  const A = big ? 4 : 3;
  const L = big ? 36 : 28;
  const GAP = big ? 8 : 6;

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const paint = useCallback(
    (f: number) => {
      const x = clamp(f, 0, 1) * w;
      clip.current?.setAttribute('width', String(Math.max(0, x - GAP)));
      const x1 = Math.min(w - 4, x + GAP);
      rest.current?.setAttribute('x1', String(x1));
      rest.current?.setAttribute('opacity', x1 >= w - 5 ? '0' : '1');
      if (thumb.current) thumb.current.style.transform = `translateX(${x}px)`;
      if (bubble.current) bubble.current.style.transform = `translateX(${x}px) translateX(-50%)`;
    },
    [w, GAP],
  );

  useEffect(() => onFrame((ct, d) => drag.current == null && paint(d ? ct / d : 0)), [paint]);

  const wave = useMemo(() => {
    const y = H / 2;
    let p = `M ${-L} ${y}`;
    for (let x = -L; x < w + L; x += L) p += ` q ${L / 4} ${-A * 2} ${L / 2} 0 t ${L / 2} 0`;
    return p;
  }, [w, H, A, L]);

  const fx = (cx: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return clamp((cx - r.left) / r.width, 0, 1);
  };
  const show = (f: number) => {
    paint(f);
    if (bubble.current) bubble.current.textContent = fmtTime(f * dur());
  };

  return (
    <div
      ref={wrap}
      className={cx('seek', big && 'seek-big', playing && 'is-playing', dragging && 'dragging')}
      style={{ height: H, '--wl': L + 'px' } as Vars}
      role="slider"
      tabIndex={has ? 0 : -1}
      aria-label={t('seek')}
      aria-disabled={!has}
      onPointerDown={(e) => {
        if (!has) return;
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
        seek(drag.current * dur());
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') seekBy(5);
        else if (e.key === 'ArrowLeft') seekBy(-5);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <svg width={w} height={H} aria-hidden="true">
        <defs>
          <clipPath id={id}>
            <rect ref={clip} x={0} y={-10} height={H + 20} width={0} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id})`}>
          <g className="seek-wave" style={{ transformOrigin: `0 ${H / 2}px` }}>
            <path d={wave} vectorEffect="non-scaling-stroke" />
          </g>
        </g>
        <line ref={rest} className="seek-rest" x1={GAP} x2={Math.max(GAP, w - 4)} y1={H / 2} y2={H / 2} />
        <circle className="seek-stop" cx={Math.max(0, w - 2)} cy={H / 2} r={big ? 3 : 2} />
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
  const label = playing ? t('pause') : t('play');
  return (
    <button type="button" className="play-btn sl" data-ripple data-playing={playing} aria-label={label} data-tip={label} onClick={toggle} disabled={!has}>
      <Icon name="play_arrow" fill className="pi-play" />
      <Icon name="pause" fill className="pi-pause" />
      {loading && playing && (
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
  return (
    <div className={cx('controls', size === 'lg' && 'controls-lg')}>
      <IconButton icon="shuffle" label={t('shuffle')} toggle selected={shuffle} onClick={toggleShuffle} className="ctl-toggle" />
      <IconButton icon="skip_previous" fill label={t('previous')} onClick={prev} disabled={!has} />
      <PlayButton />
      <IconButton icon="skip_next" fill label={t('next')} onClick={() => next()} disabled={!has} />
      <IconButton
        icon={repeat === 'one' ? 'repeat_one' : 'repeat'}
        label={repeat === 'one' ? t('repeatOne') : t('repeat')}
        toggle
        selected={repeat !== 'off'}
        onClick={cycleRepeat}
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
