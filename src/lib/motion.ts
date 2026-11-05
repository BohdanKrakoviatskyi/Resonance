import { flushSync } from 'react-dom';
import { clamp } from './util';

export type MotionMode = 'expressive' | 'standard' | 'reduced';
type Spring = [stiffness: number, damping: number];

/** Converts a physical spring into a CSS linear() easing + settle duration. */
function spring([k, z]: Spring) {
  const w0 = Math.sqrt(k);
  const x =
    z < 1
      ? (t: number) => {
          const wd = w0 * Math.sqrt(1 - z * z);
          return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
        }
      : (t: number) => 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  let d = 0.05;
  const ok = (t: number) => Math.abs(1 - x(t)) < 0.0015;
  while (d < 2.5 && !(ok(d) && ok(d + 0.04) && ok(d + 0.08))) d += 0.01;
  const n = Math.max(24, Math.round(d * 90));
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) pts.push(i === n ? '1' : String(Math.round(x((i / n) * d) * 1000) / 1000));
  return { ease: `linear(${pts.join(',')})`, dur: Math.round(d * 1000) };
}

// M3 Expressive motion physics tokens (spatial springs)
const SETS: Record<'expressive' | 'standard', Record<string, Spring>> = {
  expressive: { fast: [800, 0.6], def: [380, 0.8], slow: [200, 0.8], bounce: [520, 0.48] },
  standard: { fast: [1400, 0.9], def: [700, 0.9], slow: [300, 0.9], bounce: [900, 0.9] },
};
const cache = new Map<string, { ease: string; dur: number }>();

export function applyMotion(mode: MotionMode) {
  const root = document.documentElement;
  const reduced = mode === 'reduced';
  root.dataset.motion = reduced ? 'reduced' : mode;
  const set = SETS[mode === 'expressive' ? 'expressive' : 'standard'];
  for (const [name, sp] of Object.entries(set)) {
    const key = sp.join();
    let s = cache.get(key);
    if (!s) cache.set(key, (s = spring(sp)));
    root.style.setProperty(`--sp-${name}`, s.ease);
    root.style.setProperty(`--sp-${name}-d`, (reduced ? 1 : s.dur) + 'ms');
  }
}

export const supportsVT = () =>
  typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === 'function' &&
  document.documentElement.dataset.motion !== 'reduced';

/** Runs a state update inside a View Transition (shared-element morphs), with graceful fallback. */
export function viewTransition(update: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (!supportsVT() || !d.startViewTransition) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = '';
  try {
    const tr = d.startViewTransition(() => flushSync(update));
    tr.finished.finally(() => delete root.dataset.vt);
  } catch {
    delete root.dataset.vt;
    update();
  }
}

let rzTimer = 0;
/** Temporarily disables expensive refraction filters while panels animate their size. */
export function markResizing() {
  const root = document.documentElement;
  root.dataset.resizing = '';
  clearTimeout(rzTimer);
  rzTimer = window.setTimeout(() => delete root.dataset.resizing, 700);
}

/** One delegated listener powers ripples for every [data-ripple] element + one shared tooltip. */
export function initFx() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const host = (e.target as Element).closest?.('[data-ripple]') as HTMLElement | null;
      if (!host || (host as HTMLButtonElement).disabled || document.documentElement.dataset.motion === 'reduced') return;
      const r = host.getBoundingClientRect();
      const size = Math.hypot(r.width, r.height) * 2;
      const s = document.createElement('span');
      s.className = 'ripple';
      s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
      host.appendChild(s);
      const start = performance.now();
      const end = () => {
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        setTimeout(() => {
          s.classList.add('out');
          setTimeout(() => s.remove(), 420);
        }, Math.max(0, 200 - (performance.now() - start)));
      };
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    },
    { passive: true },
  );

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let cur: HTMLElement | null = null;
  let tm = 0;
  const hide = () => {
    clearTimeout(tm);
    cur = null;
    tip.classList.remove('show');
  };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
    if (el === cur) return;
    hide();
    if (!el || !el.dataset.tip) return;
    cur = el;
    tm = window.setTimeout(() => {
      if (!cur || !cur.isConnected || !cur.dataset.tip) return;
      tip.textContent = cur.dataset.tip;
      const r = cur.getBoundingClientRect();
      const pos = cur.dataset.tipPos || 'top';
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2;
      let y = r.top - th - 8;
      if (pos === 'bottom' || y < 6) y = r.bottom + 8;
      if (pos === 'right') {
        x = r.right + 10;
        y = r.top + r.height / 2 - th / 2;
      }
      tip.style.left = clamp(x, 6, innerWidth - tw - 6) + 'px';
      tip.style.top = clamp(y, 6, innerHeight - th - 6) + 'px';
      tip.style.transformOrigin = pos === 'right' ? 'left center' : y > r.top ? 'center top' : 'center bottom';
      tip.classList.add('show');
    }, 520);
  });
  document.addEventListener('pointerout', (e) => {
    if (cur && !cur.contains(e.relatedTarget as Node)) hide();
  });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
