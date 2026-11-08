import { type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { IconButton, Segmented, Slider, type Vars } from '../components/ui';
import { cx, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import {
  player,
  setCrossfadeCurve,
  setCrossfadeDuration,
  setCrossfadeEnabled,
  setNormalizationEnabled,
  setNormalizationTarget,
  type CrossfadeCurve,
  type NormalizationTarget,
} from '../state/player';
import { go } from '../state/ui';

function Card({ icon, title, sub, children, i }: { icon: IconName; title: string; sub?: string; children: ReactNode; i: number }) {
  return (
    <section className="card anim-in" style={{ '--i': i } as Vars}>
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-secondary-container text-on-secondary-container">
          <Icon name={icon} fill size={22} />
        </span>
        <div className="min-w-0">
          <h2 className="headline text-lg leading-tight">{title}</h2>
          {sub && <p className="text-sm text-on-surface-variant">{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-1.5 flex justify-between text-sm font-semibold">
        <span>{label}</span>
        {value && <span className="tabular-nums text-on-surface-variant">{value}</span>}
      </div>
      {children}
    </div>
  );
}

export default function AudioSettings() {
  const normalizationEnabled = useStore(player, (s) => s.normalizationEnabled);
  const normalizationTarget = useStore(player, (s) => s.normalizationTarget);
  const crossfadeEnabled = useStore(player, (s) => s.crossfadeEnabled);
  const crossfadeDuration = useStore(player, (s) => s.crossfadeDuration);
  const crossfadeCurve = useStore(player, (s) => s.crossfadeCurve);

  const curveDesc =
    crossfadeCurve === 'linear'
      ? t('curveLinearDesc')
      : crossfadeCurve === 'equalPower'
        ? t('curveEqualPowerDesc')
        : t('curveSCurveDesc');

  return (
    <div className="page max-w-[980px]">
      <header className="anim-in mb-6 mt-2">
        <div className="mb-3 flex items-center gap-2">
          <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" onClick={() => go({ name: 'settings' })} />
          <span className="text-sm font-semibold text-on-surface-variant">{t('settings')}</span>
        </div>
        <h1 className="display text-[clamp(32px,5.5cqw,54px)]">{t('audioSettings')}</h1>
        <p className="mt-2 text-lg text-on-surface-variant">{t('audioSettingsSub')}</p>
      </header>

      <div className="grid gap-4">
        <Card icon="graphic_eq" title={t('audioNormalization')} sub={t('audioNormalizationDesc')} i={1}>
          <Segmented
            value={normalizationEnabled ? 'on' : 'off'}
            onChange={(v) => setNormalizationEnabled(v === 'on')}
            options={[
              { value: 'on', label: t('enabled'), icon: 'check' },
              { value: 'off', label: t('disabled') },
            ]}
          />
          <div className={cx('mt-5 transition-opacity duration-300', !normalizationEnabled && 'pointer-events-none opacity-40')}>
            <div className="mb-2 text-sm font-semibold">{t('targetLoudness')}</div>
            <Segmented<NormalizationTarget>
              value={normalizationTarget}
              onChange={(v) => setNormalizationTarget(v)}
              options={[
                { value: 'quiet', label: t('loudnessQuiet'), icon: 'volume_down' },
                { value: 'normal', label: t('loudnessNormal'), icon: 'graphic_eq' },
                { value: 'loud', label: t('loudnessLoud'), icon: 'volume_up' },
              ]}
            />
          </div>
        </Card>

        <Card icon="tune" title={t('crossfade')} sub={t('crossfadeDesc')} i={2}>
          <Segmented
            value={crossfadeEnabled ? 'on' : 'off'}
            onChange={(v) => setCrossfadeEnabled(v === 'on')}
            options={[
              { value: 'on', label: t('enabled'), icon: 'check' },
              { value: 'off', label: t('disabled') },
            ]}
          />

          <div className={cx('transition-opacity duration-300', !crossfadeEnabled && 'pointer-events-none opacity-40')}>
            <Row label={t('crossfadeDurationLabel')} value={`${crossfadeDuration} ${t('secUnit')}`}>
              <Slider
                value={crossfadeDuration}
                min={1}
                max={12}
                step={0.5}
                onChange={(v) => setCrossfadeDuration(v)}
                label={t('crossfadeDurationLabel')}
                disabled={!crossfadeEnabled}
              />
            </Row>

            <div className="mt-5">
              <div className="mb-2 text-sm font-semibold">{t('crossfadeCurveLabel')}</div>
              <Segmented<CrossfadeCurve>
                value={crossfadeCurve}
                onChange={(v) => setCrossfadeCurve(v)}
                options={[
                  { value: 'linear', label: t('curveLinear') },
                  { value: 'equalPower', label: t('curveEqualPower') },
                  { value: 'sCurve', label: t('curveSCurve') },
                ]}
              />
              <p className="mt-2.5 text-xs text-on-surface-variant">{curveDesc}</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
