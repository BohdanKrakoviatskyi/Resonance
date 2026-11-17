import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { clamp, cx, useStore } from '../lib/util';
import { t, type Key } from '../lib/i18n';
import { binSpectrum, freqToUnit, sampleCurve, totalResponseDb, type EqBandSpec } from '../lib/eq-curve';
import { EQ_BANDS, SPECTRUM_BINS, acquireSpectrum, player, readSpectrum, setEqBandGain, setEqPreset, type EqPreset } from '../state/player';

const PRESET_OPTIONS: { value: EqPreset; labelKey: Key }[] = [
  { value: 'flat', labelKey: 'eqFlat' },
  { value: 'bassBoost', labelKey: 'eqBassBoost' },
  { value: 'vocal', labelKey: 'eqVocal' },
  { value: 'rock', labelKey: 'eqRock' },
  { value: 'electronic', labelKey: 'eqElectronic' },
  { value: 'custom', labelKey: 'eqCustom' },
];

const BAND_SPECS: readonly EqBandSpec[] = EQ_BANDS.map((band) => ({ freq: band.freq, type: band.type as EqBandSpec['type'] }));

/** Vertical range of the stage in dB. A little wider than the ±12 dB sliders: neighbouring bands overlap and add up. */
const DB_RANGE = 14;
const GAIN_LIMIT = 12;
const SPECTRUM_BARS = 72;
const GRID_DB = [12, 6, 0, -6, -12];
const FREQ_TICKS: { hz: number; label: string }[] = [
  { hz: 50, label: '50' },
  { hz: 100, label: '100' },
  { hz: 500, label: '500' },
  { hz: 1000, label: '1k' },
  { hz: 5000, label: '5k' },
  { hz: 10000, label: '10k' },
];

const dbToPercent = (db: number) => ((DB_RANGE - clamp(db, -DB_RANGE, DB_RANGE)) / (2 * DB_RANGE)) * 100;
const formatDb = (db: number) => `${db > 0 ? '+' : ''}${db.toFixed(1)}`;

/** Live spectrum behind the curve. Runs only while mounted and the window is visible. */
function useSpectrumCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const release = acquireSpectrum();
    const data = new Uint8Array(SPECTRUM_BINS);
    const target = new Float32Array(SPECTRUM_BARS);
    const shown = new Float32Array(SPECTRUM_BARS);
    let raf = 0;
    let tick = 0;
    let color = 'rgb(255 255 255)';

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      if (tick++ % 40 === 0) color = getComputedStyle(canvas).color;
      const sampleRate = readSpectrum(data);
      if (sampleRate > 0) binSpectrum(data, sampleRate, SPECTRUM_BARS, target);
      else target.fill(0);
      // Rise quickly, fall slowly: reads as a meter instead of flicker.
      for (let i = 0; i < SPECTRUM_BARS; i++) shown[i] = target[i] > shown[i] ? shown[i] + (target[i] - shown[i]) * 0.55 : shown[i] * 0.9;

      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      const slot = width / SPECTRUM_BARS;
      const barWidth = slot * 0.7;
      const radius = Math.min(barWidth / 2, 6);
      for (let i = 0; i < SPECTRUM_BARS; i++) {
        const level = Math.pow(shown[i], 1.3);
        const barHeight = level * height * 0.94;
        if (barHeight < 1) continue;
        ctx.globalAlpha = 0.16 + level * 0.42;
        ctx.beginPath();
        ctx.roundRect(i * slot + (slot - barWidth) / 2, height - barHeight, barWidth, barHeight + radius, [radius, radius, 0, 0]);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      release();
    };
  }, [canvasRef]);
}

/** Draggable point on the response curve; moving it up/down changes the gain of its band. */
function BandHandle({ index, gains, stageRef }: { index: number; gains: number[]; stageRef: React.RefObject<HTMLDivElement | null> }) {
  const band = EQ_BANDS[index];
  const gain = gains[index] ?? 0;
  const [dragging, setDragging] = useState(false);
  const start = useRef({ y: 0, gain: 0 });

  // The point sits on the real curve, so it slides a little as neighbouring bands change.
  const y = dbToPercent(totalResponseDb(BAND_SPECS, gains, band.freq));
  const x = freqToUnit(band.freq) * 100;

  return (
    <div
      role="slider"
      tabIndex={0}
      data-eq-band={index}
      aria-label={`${band.label} (${formatDb(gain)} dB)`}
      aria-orientation="vertical"
      aria-valuemin={-GAIN_LIMIT}
      aria-valuemax={GAIN_LIMIT}
      aria-valuenow={gain}
      aria-valuetext={`${formatDb(gain)} dB`}
      className={cx('eqx-handle', dragging && 'dragging', Math.abs(gain) > 0.05 && 'on')}
      style={{ left: `${x}%`, top: `${y}%` }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { y: e.clientY, gain };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const height = stageRef.current?.getBoundingClientRect().height || 1;
        setEqBandGain(index, start.current.gain - ((e.clientY - start.current.y) / height) * 2 * DB_RANGE);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => setEqBandGain(index, 0)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 2 : 0.5;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setEqBandGain(index, gain + step);
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setEqBandGain(index, gain - step);
        else if (e.key === 'PageUp') setEqBandGain(index, gain + 2);
        else if (e.key === 'PageDown') setEqBandGain(index, gain - 2);
        else if (e.key === 'Home') setEqBandGain(index, 0);
        else return;
        e.preventDefault();
      }}
    >
      <span className="eqx-tip">{formatDb(gain)} dB</span>
    </div>
  );
}

/** Fullscreen equalizer: live spectrum, the real 5-band response curve, draggable band points, preset chips. */
export function EqPanel() {
  const eqPreset = useStore(player, (s) => s.eqPreset);
  const eqGains = useStore(player, (s) => s.eqGains);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useSpectrumCanvas(canvasRef);

  // Mouse wheel over a point nudges it. React's wheel listener is passive, so this one is native.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-eq-band]');
      if (!handle) return;
      event.preventDefault();
      const index = Number(handle.dataset.eqBand);
      setEqBandGain(index, (player.get().eqGains[index] ?? 0) + (event.deltaY < 0 ? 0.5 : -0.5));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  const gains = Array.from({ length: EQ_BANDS.length }, (_, i) => eqGains[i] ?? 0);
  const curve = sampleCurve(BAND_SPECS, gains, 120);
  const zeroY = dbToPercent(0) * 10;
  const line = curve.map(([unit, db], i) => `${i ? 'L' : 'M'}${(unit * 1000).toFixed(1)} ${(dbToPercent(db) * 10).toFixed(1)}`).join(' ');
  const area = `${line} L1000 ${zeroY} L0 ${zeroY} Z`;

  return (
    <div className="imm-eq-card eqx">
      <div className="eqx-head">
        <div className="flex items-center gap-2.5">
          <span className="grid h-10 w-10 place-items-center rounded-2xl bg-primary/20 text-primary">
            <Icon name="graphic_eq" fill size={22} />
          </span>
          <div>
            <h2 className="headline text-xl leading-tight">{t('equalizer')}</h2>
            <p className="text-xs text-on-surface-variant">60Hz – 14kHz · Web Audio DSP</p>
          </div>
        </div>
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
      </div>

      <div className="eqx-chips" role="group" aria-label={t('eqPresetLabel')}>
        {PRESET_OPTIONS.map((option) => {
          const selected = eqPreset === option.value;
          // "Custom" is a state, not a recipe: it lights up when the sliders were moved by hand.
          const isState = option.value === 'custom';
          return (
            <button
              key={option.value}
              type="button"
              data-ripple
              aria-pressed={selected}
              disabled={isState && !selected}
              className={cx('eqx-chip sl', selected && 'is-on')}
              onClick={() => !isState && setEqPreset(option.value)}
            >
              {t(option.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="eqx-stage" ref={stageRef}>
        {GRID_DB.map((db) => (
          <div key={db} className={cx('eqx-grid', db === 0 && 'zero')} style={{ top: `${dbToPercent(db)}%` }}>
            <span>{db > 0 ? `+${db}` : db}</span>
          </div>
        ))}
        {FREQ_TICKS.map((tick) => (
          <div key={tick.hz} className="eqx-vline" style={{ left: `${freqToUnit(tick.hz) * 100}%` }}>
            <span>{tick.label}</span>
          </div>
        ))}
        <canvas ref={canvasRef} className="eqx-spectrum" aria-hidden="true" />
        <svg className="eqx-curve" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="eqx-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.34" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#eqx-fill)" />
          <path d={line} fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {EQ_BANDS.map((band, index) => (
          <BandHandle key={band.freq} index={index} gains={gains} stageRef={stageRef} />
        ))}
      </div>

      <div className="eqx-readouts">
        {EQ_BANDS.map((band, index) => (
          <button key={band.freq} type="button" className={cx('eqx-readout sl', Math.abs(gains[index]) > 0.05 && 'on')} onClick={() => setEqBandGain(index, 0)} title={t('eqReset')}>
            <span className="eqx-readout-db">{formatDb(gains[index])}</span>
            <span className="eqx-readout-hz">{band.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
