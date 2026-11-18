import { useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton } from './ui';
import { clamp, cx, useStore } from '../lib/util';
import { pick, t, useLang, type Key } from '../lib/i18n';
import { freqToUnit, sampleCurve, totalResponseDb, type EqBandSpec } from '../lib/eq-curve';
import {
  EQ_BANDS,
  player,
  setEqBandGain,
  setEqEnabled,
  setEqPreset,
  type EqPreset,
} from '../state/player';
import { ui } from '../state/ui';

const PRESET_OPTIONS: { value: EqPreset; labelKey: Key }[] = [
  { value: 'flat', labelKey: 'eqFlat' },
  { value: 'bassBoost', labelKey: 'eqBassBoost' },
  { value: 'vocal', labelKey: 'eqVocal' },
  { value: 'rock', labelKey: 'eqRock' },
  { value: 'electronic', labelKey: 'eqElectronic' },
  { value: 'custom', labelKey: 'eqCustom' },
];

const BAND_SPECS: readonly EqBandSpec[] = EQ_BANDS.map((band) => ({
  freq: band.freq,
  type: band.type as EqBandSpec['type'],
}));

const DB_RANGE = 14;
const GAIN_LIMIT = 12;
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

function BandHandle({
  index,
  gains,
  stageRef,
}: {
  index: number;
  gains: number[];
  stageRef: React.RefObject<HTMLDivElement | null>;
}) {
  const band = EQ_BANDS[index];
  const gain = gains[index] ?? 0;
  const [dragging, setDragging] = useState(false);
  const start = useRef({ y: 0, gain: 0 });

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
      className={cx('eqx-handle !h-8 !w-8 !-ml-4 !-mt-4', dragging && 'dragging', Math.abs(gain) > 0.05 && 'on')}
      style={{ left: `${x}%`, top: `${y}%` }}
      onPointerDown={(e) => {
        e.stopPropagation();
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
    >
      <span className="eqx-tip">{formatDb(gain)} dB</span>
    </div>
  );
}

/** Interactive 5-band frequency response curve + touch handles + presets (matches Desktop EqPanel). */
export function EqPanel({ compact = false }: { compact?: boolean }) {
  useLang();
  const eqEnabled = useStore(player, (s) => s.eqEnabled);
  const eqPreset = useStore(player, (s) => s.eqPreset);
  const eqGains = useStore(player, (s) => s.eqGains);
  const stageRef = useRef<HTMLDivElement>(null);

  const gains = Array.from({ length: EQ_BANDS.length }, (_, i) => eqGains[i] ?? 0);
  const effectiveGains = eqEnabled ? gains : [0, 0, 0, 0, 0];
  const curve = sampleCurve(BAND_SPECS, effectiveGains, 120);
  const zeroY = dbToPercent(0) * 10;
  const line = curve
    .map(([unit, db], i) => `${i ? 'L' : 'M'}${(unit * 1000).toFixed(1)} ${(dbToPercent(db) * 10).toFixed(1)}`)
    .join(' ');
  const area = `${line} L1000 ${zeroY} L0 ${zeroY} Z`;

  return (
    <div className={cx('eqx flex flex-col gap-3.5', !compact && 'imm-eq-card !p-4')}>
      <div className="eqx-head">
        <div className="flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary/20 text-primary">
            <Icon name="graphic_eq" fill size={22} />
          </span>
          <div>
            <h2 className="headline text-lg leading-tight">{t('equalizer')}</h2>
            <p className="text-xs text-on-surface-variant">
              {pick('60Гц – 14кГц · Нативный DSP', '60Hz – 14kHz · Native Hardware DSP')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {eqPreset !== 'flat' && (
            <button
              type="button"
              data-ripple
              className="sl rounded-full bg-on-surface/10 px-3 py-1.5 text-xs font-semibold text-on-surface-variant"
              onClick={() => setEqPreset('flat')}
            >
              {t('eqReset')}
            </button>
          )}
          <button
            type="button"
            data-ripple
            onClick={() => setEqEnabled(!eqEnabled)}
            className={cx(
              'sl rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors',
              eqEnabled ? 'bg-primary text-on-primary shadow-sm' : 'bg-on-surface/10 text-on-surface-variant',
            )}
          >
            {eqEnabled ? t('enabled') : t('disabled')}
          </button>
        </div>
      </div>

      <div className="eqx-chips flex gap-1.5 overflow-x-auto pb-1 no-scrollbar !flex-nowrap" role="group" aria-label={t('eqPresetLabel')}>
        {PRESET_OPTIONS.map((option) => {
          const selected = eqPreset === option.value;
          const isState = option.value === 'custom';
          return (
            <button
              key={option.value}
              type="button"
              data-ripple
              aria-pressed={selected}
              disabled={isState && !selected}
              className={cx('eqx-chip sl shrink-0', selected && 'is-on')}
              onClick={() => !isState && setEqPreset(option.value)}
            >
              {t(option.labelKey)}
            </button>
          );
        })}
      </div>

      <div
        className={cx('eqx-stage !min-h-[196px]', !eqEnabled && 'opacity-65')}
        ref={stageRef}
      >
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
        <svg className="eqx-curve" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="eqx-fill-mob" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.34" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#eqx-fill-mob)" />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="3.2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {EQ_BANDS.map((band, index) => (
          <BandHandle key={band.freq} index={index} gains={gains} stageRef={stageRef} />
        ))}
      </div>

      <div className="eqx-readouts">
        {EQ_BANDS.map((band, index) => (
          <button
            key={band.freq}
            type="button"
            className={cx('eqx-readout sl', Math.abs(gains[index]) > 0.05 && 'on')}
            onClick={() => setEqBandGain(index, 0)}
            title={t('eqReset')}
          >
            <span className="eqx-readout-db">{formatDb(gains[index])}</span>
            <span className="eqx-readout-hz">{band.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function EqSheet() {
  const open = useStore(ui, (s) => s.eqSheetOpen);
  useLang();

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm"
      onClick={() => ui.set({ eqSheetOpen: false })}
    >
      <div
        className="anim-in rounded-t-[32px] bg-sc-high px-4 pb-[calc(env(safe-area-inset-bottom,0px)+22px)] pt-3 text-on-surface shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="mx-auto h-1 w-10 rounded-full bg-on-surface/25" />
          <IconButton
            icon="close"
            label="Close"
            size="sm"
            tip={false}
            className="-ml-8"
            onClick={() => ui.set({ eqSheetOpen: false })}
          />
        </div>
        <EqPanel compact />
      </div>
    </div>
  );
}
