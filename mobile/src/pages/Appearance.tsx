import { Button, IconButton, Segmented } from '../components/ui';
import { cx, useStore } from '../lib/util';
import { t, useLang } from '../lib/i18n';
import { appearance, DEFAULTS, type GlassMode } from '../state/appearance';
import { go } from '../state/ui';

const ACCENT_PRESETS = ['#8c7cff', '#ff765d', '#4fd8eb', '#7bd88f', '#ffb86c', '#ff6ac1'];

export default function Appearance() {
  useLang();
  const a = useStore(appearance, (s) => s);

  return (
    <div className="flex flex-col gap-4 px-4 pb-8 pt-3">
      <header className="flex items-center gap-2.5">
        <IconButton icon="arrow_back" label={t('back')} variant="tonal" size="sm" tip={false} onClick={() => go({ name: 'settings' })} />
        <h1 className="headline text-2xl font-extrabold">{t('appearance')}</h1>
      </header>

      <section className="rounded-3xl bg-sc-low p-4">
        <h2 className="headline mb-2.5 text-base">{t('theme')}</h2>
        <Segmented
          value={a.theme}
          onChange={(v) => appearance.set({ theme: v })}
          options={[
            { value: 'dark', label: t('dark'), icon: 'dark_mode' },
            { value: 'light', label: t('light'), icon: 'light_mode' },
            { value: 'system', label: t('system'), icon: 'brightness_auto' },
          ]}
        />
      </section>

      <section className="rounded-3xl bg-sc-low p-4">
        <h2 className="headline mb-2.5 text-base">{t('glass')}</h2>
        <Segmented
          value={a.glass}
          onChange={(v: GlassMode) => appearance.set({ glass: v })}
          options={[
            { value: 'frosted', label: t('frosted') },
            { value: 'liquid', label: t('liquid') },
            { value: 'off', label: t('off') },
          ]}
        />
      </section>

      <section className="rounded-3xl bg-sc-low p-4">
        <h2 className="headline mb-2.5 text-base">{t('accent')}</h2>
        <Segmented
          size="sm"
          value={a.accentMode}
          onChange={(v) => appearance.set({ accentMode: v })}
          options={[
            { value: 'dynamic', label: t('fromCover') },
            { value: 'custom', label: t('custom') },
          ]}
        />
        {a.accentMode === 'custom' && (
          <div className="mt-3 flex flex-wrap gap-2.5">
            {ACCENT_PRESETS.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={hex}
                onClick={() => appearance.set({ accentColor: hex })}
                style={{ backgroundColor: hex }}
                className={cx(
                  'h-9 w-9 rounded-full border-2 transition-transform',
                  a.accentColor.toLowerCase() === hex ? 'scale-110 border-white' : 'border-transparent',
                )}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-3xl bg-sc-low p-4">
        <h2 className="headline mb-2.5 text-base">{t('language')}</h2>
        <Segmented
          value={a.lang}
          onChange={(v) => appearance.set({ lang: v })}
          options={[
            { value: 'ru', label: 'Русский' },
            { value: 'en', label: 'English' },
          ]}
        />
      </section>

      <Button variant="outlined" onClick={() => appearance.set({ ...DEFAULTS })}>
        {t('reset')}
      </Button>
    </div>
  );
}
