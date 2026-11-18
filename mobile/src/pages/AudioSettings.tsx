import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Button, IconButton, Slider } from '../components/ui';
import { cx, useStore } from '../lib/util';
import { pick, t, useLang } from '../lib/i18n';
import {
  EQ_BANDS,
  player,
  setEqBandGain,
  setEqEnabled,
  setEqPreset,
  type EqPreset,
} from '../state/player';
import { go, openDialog } from '../state/ui';

const CACHE_OPTIONS = [
  { label: 'Off', bytes: 0 },
  { label: '256 MB', bytes: 256 * 1024 * 1024 },
  { label: '512 MB', bytes: 512 * 1024 * 1024 },
  { label: '1 GB', bytes: 1024 * 1024 * 1024 },
  { label: '2 GB', bytes: 2 * 1024 * 1024 * 1024 },
];

const PRESETS: { id: EqPreset; label: string }[] = [
  { id: 'flat', label: 'Flat' },
  { id: 'bassBoost', label: 'Bass Boost' },
  { id: 'vocal', label: 'Vocal' },
  { id: 'rock', label: 'Rock' },
  { id: 'electronic', label: 'Electronic' },
  { id: 'custom', label: 'Custom' },
];

export default function AudioSettings() {
  useLang();
  const eqEnabled = useStore(player, (s) => s.eqEnabled);
  const eqPreset = useStore(player, (s) => s.eqPreset);
  const eqGains = useStore(player, (s) => s.eqGains);
  const [cacheLimit, setCacheLimit] = useState<number>(512 * 1024 * 1024);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<number>('mobile_cache_get_limit')
      .then((b) => setCacheLimit(b))
      .catch(() => {});
  }, []);

  const updateCacheLimit = async (bytes: number) => {
    setCacheLimit(bytes);
    if (isTauri()) {
      await invoke<number>('mobile_cache_set_limit', { bytes }).catch(() => {});
    }
  };

  return (
    <div className="flex flex-col gap-4 px-4 pb-8 pt-3">
      <header className="flex items-center gap-2.5">
        <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" tip={false} onClick={() => go({ name: 'settings' })} />
        <h1 className="headline text-2xl font-extrabold">{t('audioSettings')}</h1>
      </header>

      <section className="rounded-3xl bg-sc-low p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="headline text-base font-extrabold">{t('equalizer')}</h2>
            <p className="text-xs text-on-surface-variant">
              {pick('Аппаратный 5-полосный эквалайзер с защитным лимитером', 'Hardware 5-band equalizer with brickwall limiter')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEqEnabled(!eqEnabled)}
            className={cx(
              'rounded-full px-3.5 py-1.5 text-xs font-bold',
              eqEnabled ? 'bg-primary text-on-primary' : 'bg-sc-high text-on-surface-variant',
            )}
          >
            {eqEnabled ? t('enabled') : t('disabled')}
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setEqPreset(p.id)}
              className={cx(
                'rounded-full px-3 py-1.5 text-xs font-semibold',
                eqPreset === p.id ? 'bg-primary text-on-primary' : 'bg-sc text-on-surface-variant',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          {EQ_BANDS.map((band, idx) => {
            const val = eqGains[idx] ?? 0;
            return (
              <div key={band.freq} className="flex items-center gap-3">
                <span className="w-12 text-xs font-bold text-on-surface-variant">{band.label}</span>
                <Slider
                  value={val}
                  min={-12}
                  max={12}
                  step={0.5}
                  label={band.label}
                  onChange={(v) => setEqBandGain(idx, v)}
                  className="flex-1"
                />
                <span className="w-14 text-right text-xs font-bold tabular-nums text-primary">
                  {val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1)} dB
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-3xl bg-sc-low p-4">
        <h2 className="headline text-base font-extrabold">
          {pick('Офлайн-кэш аудиопотоков', 'Audio Stream Disk Cache')}
        </h2>
        <p className="mt-0.5 text-xs text-on-surface-variant">
          {pick(
            'Прослушанные треки сохраняются в кэш приложения и запускаются мгновенно без расхода трафика.',
            'Played tracks are cached automatically for instant zero-network replay.',
          )}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {CACHE_OPTIONS.map((opt) => (
            <button
              key={opt.bytes}
              type="button"
              onClick={() => void updateCacheLimit(opt.bytes)}
              className={cx(
                'rounded-full px-3.5 py-1.5 text-xs font-bold',
                cacheLimit === opt.bytes ? 'bg-primary text-on-primary' : 'bg-sc text-on-surface-variant',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          <Button variant="outlined" icon="delete" onClick={() => openDialog({ kind: 'clear-cache' })}>
            {t('clearCacheBtn')}
          </Button>
        </div>
      </section>
    </div>
  );
}
