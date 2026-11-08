import { Icon, type IconName } from '../components/Icon';
import { type Vars } from '../components/ui';
import { t } from '../lib/i18n';
import { go, openDialog, type Route } from '../state/ui';

type SettingItem = {
  route: Route;
  icon: IconName;
  title: string;
  subtitle: string;
  badge?: boolean;
};

export default function Settings() {
  const items: SettingItem[] = [
    {
      route: { name: 'appearance' },
      icon: 'palette',
      title: t('appearance'),
      subtitle: t('appearanceSub'),
    },
    {
      route: { name: 'providers' },
      icon: 'music_note',
      title: t('providers'),
      subtitle: t('providersSub'),
    },
  ];

  return (
    <div className="page max-w-[980px]">
      <header className="anim-in mb-6 mt-2">
        <h1 className="display text-[clamp(32px,5.5cqw,54px)]">{t('settings')}</h1>
        <p className="mt-2 text-lg text-on-surface-variant">{t('settingsSub')}</p>
      </header>

      <div className="flex flex-col gap-3">
        {items.map((item, i) => (
          <button
            key={item.route.name}
            type="button"
            data-ripple
            className="card sl anim-in flex w-full items-center gap-4 text-left"
            style={{ '--i': i + 1 } as Vars}
            onClick={() => go(item.route)}
          >
            <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-[16px] bg-secondary-container text-on-secondary-container">
              <Icon name={item.icon} fill size={24} />
              {item.badge && (
                <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-[#ff3b30] ring-2 ring-[var(--md-surface-container-high)]" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="headline text-lg leading-tight">{item.title}</span>
                {item.badge && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#ff3b30]" aria-hidden="true" />}
              </div>
              <div className="mt-0.5 text-sm text-on-surface-variant">{item.subtitle}</div>
            </div>
            <Icon name="chevron_right" className="text-on-surface-variant" />
          </button>
        ))}

        <div className="anim-in mt-1 flex justify-end" style={{ '--i': items.length + 1 } as Vars}>
          <button
            type="button"
            data-ripple
            className="sl inline-flex items-center gap-2.5 rounded-full bg-[color-mix(in_oklab,var(--md-error)_22%,var(--md-surface-container-high))] px-5 py-3 font-semibold text-error shadow-lg ring-1 ring-[color-mix(in_oklab,var(--md-error)_45%,transparent)] backdrop-blur-md"
            onClick={() => openDialog({ kind: 'uninstall' })}
          >
            <Icon name="delete" fill size={20} />
            <span>{t('uninstallApp')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
