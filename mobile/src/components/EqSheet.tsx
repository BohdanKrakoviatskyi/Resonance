import { IconButton, Slider } from './ui';
import { cx, useStore } from '../lib/util';
import {
  EQ_BANDS,
  player,
  setEqBandGain,
  setEqEnabled,
  setEqPreset,
  type EqPreset,
} from '../state/player';
import { ui } from '../state/ui';
import { useLang } from '../lib/i18n';

const PRESET_LABELS: { id: EqPreset; ru: string; en: string }[] = [
  { id: 'flat', ru: 'Ровный', en: 'Flat' },
  { id: 'bassBoost', ru: 'Бас', en: 'Bass Boost' },
  { id: 'vocal', ru: 'Вокал', en: 'Vocal' },
  { id: 'rock', ru: 'Рок', en: 'Rock' },
  { id: 'electronic', ru: 'Электроника', en: 'Electronic' },
  { id: 'custom', ru: 'Свой', en: 'Custom' },
];

export function EqSheet() {
  const open = useStore(ui, (s) => s.eqSheetOpen);
  const enabled = useStore(player, (s) => s.eqEnabled);
  const preset = useStore(player, (s) => s.eqPreset);
  const gains = useStore(player, (s) => s.eqGains);
  const lang = useLang();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/55" onClick={() => ui.set({ eqSheetOpen: false })}>
      <div
        className="mobile-sheet rounded-t-[30px] bg-sc-high px-5 pb-[calc(env(safe-area-inset-bottom,0px)+24px)] pt-4 text-on-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-on-surface/25" />
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="headline text-lg">{lang === 'en' ? '5-Band Equalizer' : '5-полосный эквалайзер'}</h2>
            <p className="text-xs text-on-surface-variant">
              {lang === 'en' ? 'Hardware DSP active in background' : 'Нативный DSP работает даже в фоне'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEqEnabled(!enabled)}
              className={cx(
                'rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors',
                enabled ? 'bg-primary text-on-primary' : 'bg-sc-highest text-on-surface-variant',
              )}
            >
              {enabled ? (lang === 'en' ? 'ON' : 'ВКЛ') : (lang === 'en' ? 'OFF' : 'ВЫКЛ')}
            </button>
            <IconButton icon="close" label="Close" size="sm" tip={false} onClick={() => ui.set({ eqSheetOpen: false })} />
          </div>
        </div>

        <div className="mb-5 flex flex-wrap gap-2">
          {PRESET_LABELS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setEqPreset(p.id)}
              className={cx(
                'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors',
                preset === p.id ? 'bg-primary text-on-primary' : 'bg-sc text-on-surface-variant',
              )}
            >
              {lang === 'en' ? p.en : p.ru}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3.5">
          {EQ_BANDS.map((band, idx) => {
            const val = gains[idx] ?? 0;
            return (
              <div key={band.freq} className="flex items-center gap-3">
                <span className="w-14 text-xs font-bold text-on-surface-variant">{band.label}</span>
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
      </div>
    </div>
  );
}
