import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { blobPath, clamp, cx } from '../lib/util';

export type Vars = CSSProperties & Record<`--${string}`, string | number>;

type IBProps = {
  icon: IconName;
  label: string;
  variant?: 'standard' | 'tonal' | 'filled' | 'glass';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  selected?: boolean;
  toggle?: boolean;
  fill?: boolean;
  tip?: 'top' | 'bottom' | 'right' | false;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

export function IconButton({ icon, label, variant = 'standard', size = 'md', selected, toggle, fill, tip = 'top', className, ...rest }: IBProps) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tip={tip ? label : undefined}
      data-tip-pos={tip || undefined}
      data-ripple
      data-on={selected ? '' : undefined}
      aria-pressed={toggle ? !!selected : undefined}
      className={cx('ib sl', variant !== 'standard' && `ib-${variant}`, size !== 'md' && `ib-${size}`, toggle && 'ib-toggle', className)}
      {...rest}
    >
      <Icon name={icon} fill={fill || selected} />
    </button>
  );
}

type BProps = { icon?: IconName; variant?: 'filled' | 'tonal' | 'outlined' | 'text'; size?: 'md' | 'lg' } & ButtonHTMLAttributes<HTMLButtonElement>;
export function Button({ icon, variant = 'filled', size = 'md', className, children, ...rest }: BProps) {
  return (
    <button type="button" data-ripple className={cx('btn sl', `btn-${variant}`, size === 'lg' && 'btn-lg', className)} {...rest}>
      {icon && <Icon name={icon} fill={variant === 'filled' || variant === 'tonal'} />}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size, className }: {
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (v: T) => void;
  size?: 'sm';
  className?: string;
}) {
  return (
    <div className={cx('seg', size === 'sm' && 'seg-sm', className)} role="group">
      {options.map((o) => (
        <button key={o.value} type="button" data-ripple className="sl" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} fill={o.value === value} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min = 0, max = 1, step = 0, onChange, label, className, disabled, size, valueText, onDoubleClick }: {
  value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; label: string; className?: string; disabled?: boolean; size?: 'sm'; valueText?: string; onDoubleClick?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ x: number; v: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const f = clamp((value - min) / (max - min || 1), 0, 1);
  const emit = (v: number) => {
    if (step) v = Math.round(v / step) * step;
    onChange(clamp(v, min, max));
  };
  const from = (x: number, fine: boolean) => {
    const r = ref.current!.getBoundingClientRect();
    // Holding Shift slows the drag ~6× so a narrow track can be set
    // precisely (crucial in the quiet range of the volume curve).
    if (fine && anchor.current) {
      emit(anchor.current.v + ((x - anchor.current.x) / r.width) * (max - min) * 0.15);
      return;
    }
    emit(min + clamp((x - r.left) / r.width, 0, 1) * (max - min));
  };
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      aria-valuetext={valueText}
      className={cx('slider', size === 'sm' && 'slider-sm', drag && 'dragging', disabled && 'disabled', className)}
      style={{ '--f': f } as Vars}
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        anchor.current = { x: e.clientX, v: value };
        setDrag(true);
        from(e.clientX, e.shiftKey);
      }}
      onPointerMove={(e) => drag && from(e.clientX, e.shiftKey)}
      onPointerUp={() => {
        setDrag(false);
        anchor.current = null;
      }}
      onPointerCancel={() => {
        setDrag(false);
        anchor.current = null;
      }}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        const base = step || (max - min) / 100;
        const d = base * (e.shiftKey ? 5 : 1);
        let v: number;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = value + d;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = value - d;
        else if (e.key === 'PageUp') v = value + base * 10;
        else if (e.key === 'PageDown') v = value - base * 10;
        else if (e.key === 'Home') v = min;
        else if (e.key === 'End') v = max;
        else return;
        emit(v);
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="slider-a" />
      <div className="slider-i" />
      <div className="slider-h" />
    </div>
  );
}

export function Chip({ icon, label, selected, onClick, className, style }: { icon?: IconName; label: string; selected?: boolean; onClick?: () => void; className?: string; style?: CSSProperties }) {
  return (
    <button type="button" data-ripple className={cx('chip sl', className)} data-on={selected ? '' : undefined} onClick={onClick} style={style}>
      {icon && <Icon name={icon} fill={selected} />}
      {label}
    </button>
  );
}

/** Keeps an element mounted during its exit animation. */
export function usePresence(open: boolean, ms = 350) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      let r2 = 0;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(r1);
        cancelAnimationFrame(r2);
      };
    }
    setVisible(false);
    const tm = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(tm);
  }, [open, ms]);
  return { mounted: mounted || open, visible: visible && open };
}

export function Menu({ anchor, open, onClose, children }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; children: ReactNode }) {
  const { mounted, visible } = usePresence(open, 260);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!mounted || !anchor || !ref.current || !open) return;
    const r = anchor.getBoundingClientRect();
    const mw = ref.current.offsetWidth;
    const mh = ref.current.offsetHeight;
    let left = r.right - mw;
    let ox = 'right';
    if (left < 8) {
      left = Math.min(r.left, innerWidth - mw - 8);
      ox = 'left';
    }
    let top = r.bottom + 6;
    let oy = 'top';
    if (top + mh > innerHeight - 8) {
      top = Math.max(8, r.top - mh - 6);
      oy = 'bottom';
    }
    setPos({ left, top, origin: `${ox} ${oy}` });
  }, [mounted, anchor, open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (!ref.current?.contains(tg) && !anchor?.contains(tg)) closeRef.current();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    const scroll = (e: Event) => !ref.current?.contains(e.target as Node) && closeRef.current();
    const resize = () => closeRef.current();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [open, anchor]);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      data-open={visible && !!pos}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, transformOrigin: pos?.origin }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({ icon, label, onClick, checked, leading, trailing, i = 0 }: {
  icon?: IconName; label: string; onClick?: () => void; checked?: boolean; leading?: ReactNode; trailing?: IconName; i?: number;
}) {
  return (
    <button type="button" role="menuitem" data-ripple className="menu-item sl" style={{ '--i': i } as Vars} onClick={onClick}>
      {leading ?? (icon && <Icon name={icon} />)}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked !== undefined && (
        <span className={cx('check', checked && 'on')}>
          <Icon name="check" />
        </span>
      )}
      {trailing && <Icon name={trailing} />}
    </button>
  );
}

const MORPH = [blobPath(9, 0.07, 64), blobPath(5, 0.17, 64), blobPath(4, 0.22, 64), blobPath(12, 0.05, 64), blobPath(6, 0.12, 64)];
let morphInjected = false;
function injectMorph() {
  if (morphInjected) return;
  morphInjected = true;
  const s = document.createElement('style');
  s.textContent = `@keyframes lyra-morph{${MORPH.map((p, i) => `${(i / MORPH.length) * 100}%{d:path("${p}")}`).join('')}100%{d:path("${MORPH[0]}")}}`;
  document.head.appendChild(s);
}

/** M3 Expressive-style loading indicator: a rotating, morphing shape. */
export function Loader({ size = 44, className }: { size?: number; className?: string }) {
  injectMorph();
  return (
    <span className={cx('loader', className)} style={{ width: size, height: size }} role="progressbar" aria-busy="true">
      <svg viewBox="0 0 1 1">
        <path d={MORPH[0]} />
      </svg>
    </span>
  );
}

export function Shape({ n = 9, amp = 0.07, className, style, children }: { n?: number; amp?: number; className?: string; style?: CSSProperties; children?: ReactNode }) {
  const d = useMemo(() => blobPath(n, amp), [n, amp]);
  return (
    <span className={cx('shape', className)} style={style}>
      <svg viewBox="0 0 1 1" aria-hidden="true">
        <path d={d} />
      </svg>
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: IconName; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="anim-in flex flex-col items-center gap-3 px-6 py-14 text-center">
      <Shape n={8} amp={0.09} className="spin-slow h-28 w-28 text-secondary-container">
        <Icon name={icon} size={46} fill className="text-on-secondary-container" />
      </Shape>
      <div className="headline mt-3 text-xl">{title}</div>
      {text && <div className="max-w-sm text-on-surface-variant">{text}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Section({ title, subtitle, action, children, i = 0 }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; i?: number }) {
  return (
    <section className="anim-in mt-10" style={{ '--i': i } as Vars}>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="headline text-[26px] leading-tight">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-on-surface-variant">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function HRow({ children, cw = 170, labels }: { children: ReactNode; cw?: number; labels: [string, string] }) {
  const ref = useRef<HTMLDivElement>(null);
  const by = (d: number) => ref.current?.scrollBy({ left: d * ref.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <div className="hrow-wrap relative" style={{ '--cw': cw + 'px' } as Vars}>
      <div ref={ref} className="hrow">
        {children}
      </div>
      <IconButton icon="chevron_left" label={labels[0]} tip={false} variant="tonal" className="hrow-btn -left-2" onClick={() => by(-1)} />
      <IconButton icon="chevron_right" label={labels[1]} tip={false} variant="tonal" className="hrow-btn -right-2" onClick={() => by(1)} />
    </div>
  );
}
