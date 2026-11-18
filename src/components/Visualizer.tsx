import { useEffect, useRef } from 'react';
import { binSpectrum } from '../lib/eq-curve';
import { createStore, persist } from '../lib/util';
import { SPECTRUM_BINS, acquireSpectrum, isWebKitPlayback, readSpectrum } from '../state/player';

export type VizMode = 'off' | 'bars' | 'wave';
export const VIZ_MODES: VizMode[] = ['off', 'bars', 'wave'];

// The visualizer needs the Web Audio graph, which routes all playback (and the volume control)
// through audio nodes. On WebKit that has misbehaved, so there it stays opt-in; elsewhere it's on.
// v2 key: v1 could hold a "bars" default that was never a choice.
export const vizStore = createStore({ mode: (isWebKitPlayback() ? 'off' : 'bars') as VizMode });
persist('resonance.viz.v2', vizStore, (s) => ({ mode: s.mode }));

export const cycleViz = () => {
  const i = VIZ_MODES.indexOf(vizStore.get().mode);
  vizStore.set({ mode: VIZ_MODES[(i + 1) % VIZ_MODES.length] });
};

const BARS = 64;

/** Full-width audio-reactive layer drawn in the theme's primary color. Pauses when hidden. */
export function Visualizer({ mode }: { mode: Exclude<VizMode, 'off'> }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const release = acquireSpectrum();
    const data = new Uint8Array(SPECTRUM_BINS);
    const target = new Float32Array(BARS);
    const shown = new Float32Array(BARS);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let tick = 0;
    let color = 'rgb(255 255 255)';

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const drawBars = (w: number, h: number) => {
      const slot = w / BARS;
      const bw = slot * 0.62;
      const r = Math.min(bw / 2, 8);
      for (let i = 0; i < BARS; i++) {
        const lv = Math.pow(shown[i], 1.25);
        const bh = lv * h * 0.92;
        if (bh < 1) continue;
        ctx.globalAlpha = 0.1 + lv * 0.4;
        ctx.beginPath();
        ctx.roundRect(i * slot + (slot - bw) / 2, h - bh, bw, bh + r, [r, r, 0, 0]);
        ctx.fill();
      }
    };

    const drawWave = (w: number, h: number) => {
      // Smooth closed shape through the bar tops, mirrored around the centre for symmetry.
      const pts: [number, number][] = [];
      const half = BARS / 2;
      for (let i = 0; i <= BARS; i++) {
        const src = i <= half ? half - i : i - half; // bass in the middle
        const lv = Math.pow(shown[Math.min(BARS - 1, src * 2)], 1.15);
        pts.push([(i / BARS) * w, h - lv * h * 0.85 - h * 0.04]);
      }
      const grad = ctx.createLinearGradient(0, h * 0.1, 0, h);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'transparent');
      for (const [alpha, lift] of [
        [0.18, 0],
        [0.32, 0.12],
      ] as const) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(pts[0][0], pts[0][1] + h * lift);
        for (let i = 1; i < pts.length; i++) {
          const [x0, y0] = pts[i - 1];
          const [x1, y1] = pts[i];
          ctx.quadraticCurveTo(x0, y0 + h * lift, (x0 + x1) / 2, (y0 + y1) / 2 + h * lift);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
      }
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      if (reduce && tick % 4 !== 0) {
        tick++;
        return;
      }
      if (tick++ % 40 === 0) color = getComputedStyle(canvas).color;
      const rate = readSpectrum(data);
      if (rate > 0) binSpectrum(data, rate, BARS, target);
      else target.fill(0);
      for (let i = 0; i < BARS; i++) shown[i] = target[i] > shown[i] ? shown[i] + (target[i] - shown[i]) * 0.5 : shown[i] * 0.92;
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = color;
      if (mode === 'bars') drawBars(w, h);
      else drawWave(w, h);
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      release();
    };
  }, [mode]);

  return <canvas ref={ref} className="imm-viz" aria-hidden="true" />;
}
