import { useEffect, type ReactNode } from 'react';
import {
  cancelWhisperDownload,
  deleteWhisperModel,
  downloadWhisperModel,
  refreshWhisperModels,
  whisper,
  type WhisperLoad,
} from '../state/whisper';
import { threadsFor } from '../lib/transcript-lrc';
import { Icon, type IconName } from '../components/Icon';
import { IconButton, Segmented, Slider, type Vars } from '../components/ui';
import { cx, useStore } from '../lib/util';
import { t } from '../lib/i18n';
import {
  player,
  setCrossfadeCurve,
  setCrossfadeDuration,
  setCrossfadeEnabled,
  setFx,
  setFxPreset,
  setNormalizationEnabled,
  setNormalizationTarget,
  type CrossfadeCurve,
  type NormalizationTarget,
} from '../state/player';
import { go } from '../state/ui';
import { detectPreset, semitones, SPEED_MAX, SPEED_MIN, type FxPreset } from '../lib/audio-fx';

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

        <FxCard />
        <WhisperCard />
      </div>
    </div>
  );
}

function WhisperCard() {
  const s = useStore(whisper, (x) => x);
  const cores = navigator.hardwareConcurrency || 4;
  useEffect(() => void refreshWhisperModels(), []);
  const dl = s.downloading;
  const pct = dl && dl.total ? Math.round((dl.received / dl.total) * 100) : 0;

  return (
    <Card icon="auto_awesome" title={t('whisperTitle')} sub={t('whisperDesc')} i={4}>
      <div className="mb-2 text-sm font-semibold">{t('whisperModel')}</div>
      <div className="grid gap-2">
        {s.models.map((m) => {
          const selected = s.model === m.id;
          const busy = dl?.model === m.id;
          return (
            <div
              key={m.id}
              className={cx(
                'flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5 ring-1 transition',
                selected ? 'bg-primary/12 ring-primary/40' : 'bg-on-surface/5 ring-transparent',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-60"
                disabled={!m.installed}
                onClick={() => whisper.set({ model: m.id })}
                aria-pressed={selected}
              >
                <span className={cx('grid h-5 w-5 place-items-center rounded-full ring-2', selected && m.installed ? 'bg-primary ring-primary' : 'ring-on-surface-variant/50')}>
                  {selected && m.installed && <Icon name="check" size={14} className="text-on-primary" />}
                </span>
                <span className="font-semibold">{m.id}</span>
                <span className="text-xs text-on-surface-variant">
                  {m.sizeMb} MB{m.installed ? ` · ${t('whisperInstalled')}` : ''}
                </span>
              </button>
              {busy ? (
                <span className="flex items-center gap-3 text-xs tabular-nums text-on-surface-variant">
                  <span className="h-1.5 w-28 overflow-hidden rounded-full bg-on-surface/10">
                    <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                  </span>
                  {pct}%
                  <button type="button" className="font-semibold text-error hover:underline" onClick={() => void cancelWhisperDownload()}>
                    {t('whisperCancel')}
                  </button>
                </span>
              ) : m.installed ? (
                <button type="button" className="text-xs font-semibold text-error hover:underline" onClick={() => void deleteWhisperModel(m.id)}>
                  {t('whisperDelete')}
                </button>
              ) : (
                <button
                  type="button"
                  data-ripple
                  disabled={!!dl}
                  className="sl rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-on-primary disabled:opacity-40"
                  onClick={() => void downloadWhisperModel(m.id)}
                >
                  {t('whisperDownload')}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2.5 text-xs text-on-surface-variant">{t('whisperModelHint')}</p>

      <div className="mt-5">
        <div className="mb-2 text-sm font-semibold">{t('whisperLoad')}</div>
        <Segmented<WhisperLoad>
          value={s.load}
          onChange={(v) => whisper.set({ load: v })}
          options={[
            { value: 'low', label: t('whisperLoadLow') },
            { value: 'medium', label: t('whisperLoadMedium') },
            { value: 'high', label: t('whisperLoadHigh') },
          ]}
        />
        <p className="mt-2.5 text-xs text-on-surface-variant">{t('whisperLoadHint', { n: threadsFor(s.load, cores), total: cores })}</p>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-sm font-semibold">{t('whisperLang')}</div>
        <Segmented
          value={s.lang}
          onChange={(v) => whisper.set({ lang: v })}
          options={[
            { value: 'auto', label: t('whisperLangAuto') },
            { value: 'ru', label: 'RU' },
            { value: 'uk', label: 'UK' },
            { value: 'en', label: 'EN' },
          ]}
        />
      </div>

      <div className="mt-5">
        <div className="mb-2 text-sm font-semibold">{t('whisperAuto')}</div>
        <Segmented
          value={s.auto ? 'on' : 'off'}
          onChange={(v) => whisper.set({ auto: v === 'on' })}
          options={[
            { value: 'on', label: t('enabled'), icon: 'check' },
            { value: 'off', label: t('disabled') },
          ]}
        />
        <p className="mt-2.5 text-xs text-on-surface-variant">{t('whisperAutoHint')}</p>
      </div>
      {s.error && <p className="mt-3 text-xs text-error">{s.error}</p>}
    </Card>
  );
}

function FxCard() {
  const fx = useStore(player, (s) => s.fx);
  const preset = detectPreset(fx);
  const st = semitones(fx);
  const pitchLabel = fx.keepPitch || Math.abs(st) < 0.05 ? '' : ` · ${st > 0 ? '+' : ''}${st.toFixed(1)} ${t('semitonesUnit')}`;

  return (
    <Card icon="animation" title={t('fxTitle')} sub={t('fxDesc')} i={3}>
      <Segmented<FxPreset>
        value={preset}
        onChange={(v) => v !== 'custom' && setFxPreset(v)}
        options={[
          { value: 'off', label: t('fxOff') },
          { value: 'slowedReverb', label: t('fxSlowedReverb'), icon: 'water_drop' },
          { value: 'nightcore', label: t('fxNightcore'), icon: 'bolt' },
          ...(preset === 'custom' ? [{ value: 'custom' as const, label: t('fxCustom'), icon: 'tune' as const }] : []),
        ]}
      />

      <Row label={t('fxSpeed')} value={`${fx.speed.toFixed(2)}×${pitchLabel}`}>
        <Slider value={fx.speed} min={SPEED_MIN} max={SPEED_MAX} step={0.01} onChange={(v) => setFx({ speed: v })} label={t('fxSpeed')} />
      </Row>

      <div className="mt-5">
        <div className="mb-2 text-sm font-semibold">{t('fxPitchMode')}</div>
        <Segmented
          value={fx.keepPitch ? 'keep' : 'vinyl'}
          onChange={(v) => setFx({ keepPitch: v === 'keep' })}
          options={[
            { value: 'keep', label: t('fxKeepPitch') },
            { value: 'vinyl', label: t('fxVinyl') },
          ]}
        />
      </div>

      <Row label={t('fxReverb')} value={`${Math.round(fx.reverb * 100)}%`}>
        <Slider value={fx.reverb} min={0} max={1} step={0.01} onChange={(v) => setFx({ reverb: v })} label={t('fxReverb')} />
      </Row>
      <p className="mt-2.5 text-xs text-on-surface-variant">{t('fxNote')}</p>
    </Card>
  );
}
