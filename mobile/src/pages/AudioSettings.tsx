import { useEffect, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Icon, type IconName } from '../components/Icon';
import { Button, IconButton, Segmented, Slider, type Vars } from '../components/ui';
import { EqPanel } from '../components/EqSheet';
import { cx, useStore } from '../lib/util';
import { pick, t, useLang } from '../lib/i18n';
import {
  player,
  setCrossfadeCurve,
  setCrossfadeDuration,
  setCrossfadeEnabled,
  setNormalizationEnabled,
  setNormalizationTarget,
  type CrossfadeCurve,
  type LoudnessTarget,
} from '../state/player';
import { go, openDialog } from '../state/ui';

const CACHE_OPTIONS = [
  { label: 'Off', bytes: 0 },
  { label: '256 MB', bytes: 256 * 1024 * 1024 },
  { label: '512 MB', bytes: 512 * 1024 * 1024 },
  { label: '1 GB', bytes: 1024 * 1024 * 1024 },
  { label: '2 GB', bytes: 2 * 1024 * 1024 * 1024 },
];

function Card({ icon, title, sub, children, i }: { icon: IconName; title: string; sub?: string; children: ReactNode; i: number }) {
  return (
    <section className="card anim-in !p-4" style={{ '--i': i } as Vars}>
      <div className="mb-3.5 flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-secondary-container text-on-secondary-container">
          <Icon name={icon} fill size={22} />
        </span>
        <div className="min-w-0">
          <h2 className="headline text-[17px] leading-tight">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-on-surface-variant">{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="mt-3.5">
      <div className="mb-1 flex justify-between text-xs font-semibold">
        <span>{label}</span>
        {value && <span className="tabular-nums text-on-surface-variant">{value}</span>}
      </div>
      {children}
    </div>
  );
}

export default function AudioSettings() {
  useLang();
  const normOn = useStore(player, (s) => s.normalizationEnabled);
  const normTarget = useStore(player, (s) => s.normalizationTarget);
  const cfOn = useStore(player, (s) => s.crossfadeEnabled);
  const cfDur = useStore(player, (s) => s.crossfadeDuration);
  const cfCurve = useStore(player, (s) => s.crossfadeCurve);
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

  const curveDesc =
    cfCurve === 'linear'
      ? t('curveLinearDesc')
      : cfCurve === 'sCurve'
        ? t('curveSCurveDesc')
        : t('curveEqualPowerDesc');

  return (
    <div className="flex flex-col gap-3.5 px-4 pb-10 pt-3">
      <header className="anim-in mb-1">
        <div className="mb-2 flex items-center gap-2">
          <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" tip={false} onClick={() => go({ name: 'settings' })} />
          <span className="text-xs font-semibold text-on-surface-variant">{t('settings')}</span>
        </div>
        <h1 className="display text-[clamp(28px,7.5vw,40px)]">{t('audioSettings')}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">{t('audioSettingsSub')}</p>
      </header>

      <Card icon="graphic_eq" title={t('audioNormalization')} sub={t('audioNormalizationDesc')} i={1}>
        <Segmented
          value={normOn ? 'on' : 'off'}
          onChange={(v) => setNormalizationEnabled(v === 'on')}
          options={[
            { value: 'on', label: t('enabled'), icon: 'check' },
            { value: 'off', label: t('disabled') },
          ]}
        />
        <div className={cx('mt-3.5 transition-opacity duration-200', !normOn && 'pointer-events-none opacity-45')}>
          <div className="mb-2 text-xs font-semibold">{t('targetLoudness')}</div>
          <Segmented
            size="sm"
            value={normTarget}
            onChange={(v: LoudnessTarget) => setNormalizationTarget(v)}
            options={[
              { value: 'quiet', label: t('loudnessQuiet'), icon: 'volume_down' },
              { value: 'normal', label: t('loudnessNormal'), icon: 'volume_up' },
              { value: 'loud', label: t('loudnessLoud'), icon: 'bolt' },
            ]}
          />
        </div>
      </Card>

      <Card icon="tune" title={t('crossfade')} sub={t('crossfadeDesc')} i={2}>
        <Segmented
          value={cfOn ? 'on' : 'off'}
          onChange={(v) => setCrossfadeEnabled(v === 'on')}
          options={[
            { value: 'on', label: t('enabled'), icon: 'auto_awesome' },
            { value: 'off', label: t('disabled') },
          ]}
        />

        <div className={cx('transition-opacity duration-200', !cfOn && 'pointer-events-none opacity-45')}>
          <Row label={t('crossfadeDurationLabel')} value={`${cfDur} ${t('secUnit')}`}>
            <Slider
              value={cfDur}
              min={1}
              max={12}
              step={0.5}
              onChange={setCrossfadeDuration}
              label={t('crossfadeDurationLabel')}
              disabled={!cfOn}
            />
          </Row>

          <div className="mt-4">
            <div className="mb-2 text-xs font-semibold">{t('crossfadeCurveLabel')}</div>
            <Segmented
              size="sm"
              value={cfCurve}
              onChange={(v: CrossfadeCurve) => setCrossfadeCurve(v)}
              options={[
                { value: 'linear', label: t('curveLinear') },
                { value: 'equalPower', label: t('curveEqualPower') },
                { value: 'sCurve', label: t('curveSCurve') },
              ]}
            />
            <p className="mt-2.5 rounded-xl bg-sc-low/60 px-3 py-2 text-xs text-on-surface-variant">{curveDesc}</p>
          </div>
        </div>
      </Card>

      <div className="anim-in" style={{ '--i': 3 } as Vars}>
        <EqPanel />
      </div>

      <Card
        icon="cloud_done"
        title={pick('Офлайн-кэш аудиопотоков', 'Audio stream disk cache')}
        sub={pick(
          'Прослушанные треки сохраняются в кэш приложения и запускаются мгновенно без расхода трафика',
          'Played tracks are cached automatically for instant zero-network replay',
        )}
        i={4}
      >
        <div className="flex flex-wrap gap-2">
          {CACHE_OPTIONS.map((opt) => (
            <button
              key={opt.bytes}
              type="button"
              data-ripple
              onClick={() => void updateCacheLimit(opt.bytes)}
              className={cx(
                'sl rounded-full px-3.5 py-2 text-xs font-bold transition-colors',
                cacheLimit === opt.bytes ? 'bg-primary text-on-primary shadow-sm' : 'bg-sc text-on-surface-variant',
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
      </Card>
    </div>
  );
}
