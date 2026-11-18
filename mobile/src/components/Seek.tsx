import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton, type Vars } from './ui';
import { clamp, cx, fmtTime, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import {
  cycleRepeat,
  dur,
  next,
  onFrame,
  player,
  prev,
  seek,
  seekBy,
  toggle,
  toggleShuffle,
  useSecond,
} from '../state/player';

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
  const playing = useStore(player, (s) => s.playing && !s.loading);
  const has = useStore(player, (s) => s.index >= 0);
  const id = 'sk' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const H = big ? 40 : 28;
  const A = big ? 4 : 3;
  const L = big ? 36 : 28;
  const GAP = big ? 8 : 6;

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
    const el = wrap.current;
    if (!el) return;
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

  const fx = (clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
  };

  const show = (f: number) => {
    paint(f);
    if (bubble.current) bubble.current.textContent = fmtTime(f * dur());
  };

  useEffect(() => onFrame((ct, d) => drag.current == null && paint(d ? ct / d : 0)), [paint]);

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
        e.stopPropagation();
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
        void seek(targetFraction * dur());
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
  return <span className={cx('time text-left', className)}>{fmtTime(s)}</span>;
}

export function TimeTotal({ className }: { className?: string }) {
  const d = useStore(player, (s) => s.duration);
  return <span className={cx('time text-right', className)}>{fmtTime(d)}</span>;
}

export function PlayButton() {
  const playing = useStore(player, (s) => s.playing);
  const loading = useStore(player, (s) => s.loading);
  const has = useStore(player, (s) => s.index >= 0);
  const active = playing || loading;
  const label = active ? t('pause') : t('play');
  return (
    <button
      type="button"
      className="play-btn sl shadow-lg"
      data-ripple
      data-playing={active}
      data-loading={loading}
      aria-label={label}
      onClick={toggle}
      disabled={!has}
    >
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
  return (
    <div className={cx('controls w-full justify-between px-1', size === 'lg' && 'controls-lg')}>
      <IconButton
        icon="shuffle"
        label={t('shuffle')}
        toggle
        selected={shuffle}
        tip={false}
        onClick={() => void toggleShuffle()}
      />
      <IconButton
        icon="skip_previous"
        fill
        label={t('previous')}
        tip={false}
        onClick={() => void prev()}
        disabled={!has}
      />
      <PlayButton />
      <IconButton
        icon="skip_next"
        fill
        label={t('next')}
        tip={false}
        onClick={() => void next()}
        disabled={!has}
      />
      <IconButton
        icon={repeat === 'one' ? 'repeat_one' : 'repeat'}
        label={repeat === 'one' ? t('repeatOne') : t('repeat')}
        toggle
        selected={repeat !== 'off'}
        tip={false}
        onClick={() => void cycleRepeat()}
      />
    </div>
  );
}
